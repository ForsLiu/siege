// fight(left, right, seed, rules) -> FightResult. Pure: reads only its arguments.
// Fixed tick rate from rules; units act in uid order each tick; all tie-breaks are stable.
import type { AuraEffect, DamageKind, HookName, ProjectileDef, TargetSel, TargetShape, TargetTeam } from './effects.ts';
import { isTargetShape, runEffects, type EffectHost } from './effects.ts';
import { hashValue } from './hash.ts';
import { bfsPath, cellIndex, floodDistances, hexDistance, hexLine, indexToCell, mirrorCell, inBounds, MIRROR_DIR_OFFSET, type BoardConfig, type Cell } from './hex.ts';
import { Rng } from './rng.ts';
import type { FightRules } from './rules.ts';
import type { Modifier, StatName } from './stats.ts';
import { baseStats, getStat, invalidateStats, type BoardUnit, type StatCarrier, type UnitDef } from './units.ts';

export type Team = 0 | 1;
export type Side = 'left' | 'right';
export type FightWinner = Side | 'draw';
export type FightEndReason = 'elimination' | 'timeout';

export interface FightUnit extends StatCarrier {
  uid: number;
  defId: string;
  def: UnitDef;
  star: number;
  team: Team;
  col: number;
  row: number;
  hp: number;
  maxHp: number;
  mana: number;
  alive: boolean;
  /** uid of the current target, 0 when none. */
  target: number;
  nextAttackTick: number;
  nextMoveTick: number;
  stunnedUntil: number;
  /** Damage absorbers; consumed in `shieldOrder` (soonest expiry first, then oldest). */
  shields: ShieldInstance[];
  /** Active tags, one entry per (tag, source). */
  tags: TagInstance[];
}

export interface ShieldInstance {
  source: string;
  amount: number;
  /** Tick at which the shield stops absorbing (exclusive), or null for the rest of the fight. */
  expiresTick: number | null;
  /** Insertion counter; the stable tie-break for absorption order. */
  seq: number;
}

export interface TagInstance {
  tag: string;
  source: string;
  /** Tick at which the tag drops (exclusive), or null for the rest of the fight. */
  expiresTick: number | null;
}

/** A projectile in flight; resolved at the start of `arrivalTick` in spawn order. */
export interface Projectile {
  seq: number;
  ref: string;
  ownerUid: number;
  targetUid: number;
  arrivalTick: number;
  /** 'attack' projectiles carry a basic attack, and fire the owner's onHit hook on impact. */
  cause: 'attack' | 'effect';
}

export type FightEvent = { tick: number } & (
  | { type: 'spawn'; uid: number; defId: string; star: number; team: Team; col: number; row: number; hp: number; maxHp: number; mana: number; maxMana: number }
  | { type: 'move'; uid: number; from: Cell; to: Cell }
  | { type: 'attack'; uid: number; target: number; manaAfter: number }
  | { type: 'hit'; uid: number; target: number; kind: DamageKind; amount: number; raw: number; mitigated: number; absorbed: number; hpAfter: number; manaAfter: number; cause: string }
  | { type: 'heal'; uid: number; target: number; amount: number; hpAfter: number; cause: string }
  | { type: 'statMod'; uid: number; stat: StatName; mode: 'mul' | 'flat'; value: number; expiresTick: number | null; source: string }
  | { type: 'statModEnd'; uid: number; stat: StatName; source: string }
  | { type: 'maxHp'; uid: number; maxHp: number; hp: number }
  /** `uid` 0 means the entry expired rather than being granted. `shieldAfter` is the target's total. */
  | { type: 'shield'; uid: number; target: number; amount: number; shieldAfter: number; expiresTick: number | null; source: string }
  | { type: 'tag'; uid: number; tag: string; expiresTick: number | null; source: string; active: boolean }
  | { type: 'stun'; uid: number; untilTick: number; cause: string }
  | { type: 'projectile'; uid: number; target: number; ref: string; arrivalTick: number; from: Cell; to: Cell }
  | { type: 'projectileHit'; uid: number; target: number; ref: string }
  | { type: 'projectileFizzle'; uid: number; target: number; ref: string }
  | { type: 'cast'; uid: number; target: number; ability: string; manaAfter: number }
  | { type: 'death'; uid: number; killer: number }
  | { type: 'end'; winner: FightWinner; reason: FightEndReason }
);

export interface LedgerEntry {
  uid: number;
  team: Team;
  defId: string;
  /** Hp removed from enemies (post-mitigation, post-shield). */
  dealt: number;
  /** Hp lost. */
  taken: number;
  /** Hp restored to allies (overheal excluded). */
  healed: number;
  /** Shield granted to allies. */
  shielded: number;
  /** Damage this unit's own shields absorbed. */
  absorbed: number;
  /** Damage this unit's resists removed. */
  mitigated: number;
  kills: number;
  deaths: number;
}

export interface FightResult {
  winner: FightWinner;
  reason: FightEndReason;
  ticks: number;
  events: FightEvent[];
  survivors: { left: number[]; right: number[] };
  ledger: LedgerEntry[];
  /** FNV-1a 64 over (winner, reason, ticks, events). */
  hash: string;
}

export interface FightSide {
  units: readonly BoardUnit[];
}

class FightSim implements EffectHost<FightUnit> {
  tick = 0;
  readonly tickRate: number;
  readonly board: BoardConfig;
  readonly units: FightUnit[] = [];
  readonly events: FightEvent[] = [];
  readonly occupancy: Int32Array;
  readonly rng: Rng;
  readonly rules: FightRules;
  readonly moveTicks: number;
  private readonly byUid: FightUnit[] = [];
  private aliveCount: [number, number] = [0, 0];
  private readonly projectiles: Projectile[] = [];
  /** True when at least one spawned unit has an aura; skips the whole upkeep pass otherwise. */
  private hasAuras = false;
  private seq = 0;
  /** Depth guard for hook chains (onTakeDamage -> damage -> onTakeDamage -> ...). */
  private hookDepth = 0;

  constructor(rules: FightRules, seed: number) {
    this.rules = rules;
    this.tickRate = rules.tickRate;
    this.board = rules.board;
    this.occupancy = new Int32Array(rules.board.cols * rules.board.rows);
    // Combat-only stream derived from the fight seed. Unused for now: every v0 decision is a
    // stable tie-break. It is the seam for seeded effects (crits, spreads) in P0-01/P0-02.
    this.rng = Rng.fromSeed(seed, 'combat');
    this.moveTicks = Math.max(1, Math.round(rules.combat.moveSecondsPerHex * rules.tickRate));
  }

  unit(uid: number): FightUnit {
    const u = this.byUid[uid];
    if (!u) throw new Error(`fight: unknown uid ${uid}`);
    return u;
  }

  spawn(side: readonly BoardUnit[], team: Team): void {
    const sorted = [...side].sort((a, b) => a.row - b.row || a.col - b.col || (a.defId < b.defId ? -1 : a.defId > b.defId ? 1 : 0) || a.star - b.star);
    for (const bu of sorted) {
      const def = this.rules.units[bu.defId];
      if (!def) throw new Error(`fight: unknown unit ${bu.defId}`);
      const authored: Cell = { col: bu.col, row: bu.row };
      if (!inBounds(authored, this.board)) throw new Error(`fight: ${bu.defId} out of bounds at ${bu.col},${bu.row}`);
      const pos = team === 0 ? authored : mirrorCell(authored, this.board);
      const idx = cellIndex(pos, this.board);
      if (this.occupancy[idx] !== 0) throw new Error(`fight: cell ${pos.col},${pos.row} occupied twice`);
      const uid = this.units.length + 1;
      const u: FightUnit = {
        uid,
        defId: def.id,
        def,
        star: bu.star,
        team,
        col: pos.col,
        row: pos.row,
        base: baseStats(def, bu.star),
        modifiers: [],
        statCache: null,
        hp: 0,
        maxHp: 0,
        mana: 0,
        alive: true,
        target: 0,
        nextAttackTick: 0,
        nextMoveTick: 0,
        stunnedUntil: 0,
        shields: [],
        tags: [],
      };
      u.maxHp = getStat(u, 'hp');
      u.hp = u.maxHp;
      u.mana = Math.min(getStat(u, 'maxMana'), getStat(u, 'startMana'));
      if (def.aura) this.hasAuras = true;
      this.units.push(u);
      this.byUid[uid] = u;
      this.occupancy[idx] = uid;
      this.aliveCount[team]++;
      this.events.push({
        tick: 0,
        type: 'spawn',
        uid,
        defId: def.id,
        star: bu.star,
        team,
        col: pos.col,
        row: pos.row,
        hp: u.hp,
        maxHp: u.maxHp,
        mana: u.mana,
        maxMana: getStat(u, 'maxMana'),
      });
    }
  }

  // ---- EffectHost ----
  getStat(u: FightUnit, stat: StatName): number {
    return getStat(u, stat);
  }

  isAlive(u: FightUnit): boolean {
    return u.alive;
  }

  resolveTargets(sel: TargetSel, self: FightUnit, other: FightUnit | null): FightUnit[] {
    if (isTargetShape(sel)) return this.resolveShape(sel, self, other);
    switch (sel) {
      case 'self':
        return [self];
      case 'target':
        return other && other.alive ? [other] : [];
      case 'allies':
        return this.units.filter((u) => u.alive && u.team === self.team);
      case 'enemies':
        return this.units.filter((u) => u.alive && u.team !== self.team);
      default: {
        const never: never = sel;
        throw new Error(`fight: unknown target selector ${String(never)}`);
      }
    }
  }

  /** Units of `team` relative to `self`, alive, in uid order. */
  private teamUnits(team: TargetTeam, self: FightUnit): FightUnit[] {
    return this.units.filter((u) => u.alive && (team === 'all' || (team === 'allies') === (u.team === self.team)));
  }

  /**
   * Geometric selectors. The anchor is the unit itself or its contextual target, which must be
   * alive — the plain `target` selector requires that too, and a hook like onKill hands over a
   * corpse. Results are returned in uid order (`nearest` picks by distance, then uid, then
   * returns them in uid order), so no shape can make the outcome depend on iteration order.
   * `allies` and `all` include the unit itself, exactly as the plain selectors do.
   */
  private resolveShape(sel: TargetShape, self: FightUnit, other: FightUnit | null): FightUnit[] {
    const anchor = sel.from === 'self' ? self : other;
    if (anchor === null || !anchor.alive) return [];
    const candidates = this.teamUnits(sel.team, self);
    switch (sel.shape) {
      case 'radius':
        return candidates.filter((u) => hexDistance(anchor, u) <= sel.radius);
      case 'nearest': {
        const byDistance = candidates
          .map((u) => ({ u, d: hexDistance(anchor, u) }))
          .sort((a, b) => a.d - b.d || a.u.uid - b.u.uid)
          .slice(0, Math.max(0, sel.k));
        return byDistance.map((e) => e.u).sort((a, b) => a.uid - b.uid);
      }
      case 'line': {
        // The line runs from the anchor through the contextual target and on past it; with no
        // such unit there is no direction and nothing is hit. `hexLine`'s tie-break is not
        // symmetric under point reflection, so team 1 walks the line on mirrored coordinates
        // and mirrors the result back: its geometry is then exactly the mirror of team 0's.
        const toward = sel.from === 'self' ? other : self;
        if (toward === null || !toward.alive) return [];
        const mirror = (c: Cell): Cell => mirrorCell(c, this.board);
        const cells =
          self.team === 0
            ? hexLine(anchor, toward, sel.length, this.board)
            : hexLine(mirror(anchor), mirror(toward), sel.length, this.board).map(mirror);
        const hit = new Set(cells.map((c) => cellIndex(c, this.board)));
        return candidates.filter((u) => hit.has(cellIndex(u, this.board)));
      }
      default: {
        const never: never = sel;
        throw new Error(`fight: unknown target shape ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * The damage pipeline. Every point of damage walks the stages in DAMAGE_STAGES order:
   *   preMitigation - raw amount clamped to >= 0 (the seam for amp/reduction effects)
   *   mitigation    - armor / magic resist by kind; `true` damage skips it
   *   shield        - the target's absorbers, consumed soonest-expiry-first
   *   post          - hp, mana, ledger, the hit event, onTakeDamage, then the death check
   */
  damage(src: FightUnit, tgt: FightUnit, kind: DamageKind, amount: number, cause: string): void {
    if (!tgt.alive) return;
    // stage: preMitigation
    const raw = amount > 0 ? amount : 0;
    // stage: mitigation
    const K = this.rules.combat.mitigationConstant;
    let afterMitigation = raw;
    if (kind === 'physical') afterMitigation = raw * (K / (K + getStat(tgt, 'armor')));
    else if (kind === 'magic') afterMitigation = raw * (K / (K + getStat(tgt, 'magicResist')));
    if (afterMitigation < 0) afterMitigation = 0;
    const mitigated = raw - afterMitigation;
    // stage: shield
    const absorbed = this.absorb(tgt, afterMitigation);
    const applied = afterMitigation - absorbed;
    // stage: post
    tgt.hp -= applied;
    this.gainMana(tgt, this.rules.combat.manaOnHitTaken);
    const tgtLedger = this.ledgerOf(tgt);
    if (src !== tgt) this.ledgerOf(src).dealt += applied;
    tgtLedger.taken += applied;
    tgtLedger.absorbed += absorbed;
    tgtLedger.mitigated += mitigated;
    this.events.push({
      tick: this.tick,
      type: 'hit',
      uid: src.uid,
      target: tgt.uid,
      kind,
      amount: applied,
      raw,
      mitigated,
      absorbed,
      hpAfter: Math.max(0, tgt.hp),
      manaAfter: tgt.mana,
      cause,
    });
    if (tgt.hp <= 0) {
      this.kill(src, tgt);
      return;
    }
    if (applied > 0 || absorbed > 0) this.fireHook(tgt, 'onTakeDamage', src);
  }

  /** Consume shields for `amount`; returns the absorbed part. Soonest expiry first, then oldest. */
  private absorb(tgt: FightUnit, amount: number): number {
    if (tgt.shields.length === 0 || !(amount > 0)) return 0;
    const order = [...tgt.shields].sort(shieldOrder);
    let left = amount;
    let absorbed = 0;
    for (const sh of order) {
      if (left <= 0) break;
      const take = Math.min(sh.amount, left);
      sh.amount -= take;
      left -= take;
      absorbed += take;
    }
    for (let i = tgt.shields.length - 1; i >= 0; i--) if ((tgt.shields[i] as ShieldInstance).amount <= 0) tgt.shields.splice(i, 1);
    return absorbed;
  }

  heal(src: FightUnit, tgt: FightUnit, amount: number, cause: string): void {
    if (!tgt.alive) return;
    const effective = Math.max(0, Math.min(amount, tgt.maxHp - tgt.hp));
    tgt.hp += effective;
    this.ledgerOf(src).healed += effective;
    this.events.push({ tick: this.tick, type: 'heal', uid: src.uid, target: tgt.uid, amount: effective, hpAfter: tgt.hp, cause });
  }

  addModifier(tgt: FightUnit, mod: Modifier, _cause: string): void {
    if (!tgt.alive) return;
    tgt.modifiers.push(mod);
    invalidateStats(tgt);
    this.refreshMaxHp(tgt);
    this.events.push({ tick: this.tick, type: 'statMod', uid: tgt.uid, stat: mod.stat, mode: mod.mode, value: mod.value, expiresTick: mod.expiresTick, source: mod.source });
  }

  stun(tgt: FightUnit, untilTick: number, cause: string): void {
    if (!tgt.alive) return;
    if (untilTick > tgt.stunnedUntil) tgt.stunnedUntil = untilTick;
    this.events.push({ tick: this.tick, type: 'stun', uid: tgt.uid, untilTick: tgt.stunnedUntil, cause });
  }

  /**
   * Grant a damage absorber. Shields from the same source refresh in place (amount and
   * expiry take the larger value) so a repeated cast cannot stack absorbers without bound.
   */
  shield(src: FightUnit, tgt: FightUnit, amount: number, expires: number | null, source: string, slot: number): void {
    if (!tgt.alive || !(amount > 0)) return;
    const key = instanceKey(source, src.uid, slot);
    const existing = tgt.shields.find((sh) => sh.source === key);
    let granted = amount;
    let expiresTick = expires;
    if (existing) {
      // A refresh from the same instance takes the larger amount and the later expiry, so
      // re-casting cannot pile up absorbers; the ledger only credits what was actually added.
      granted = Math.max(0, amount - existing.amount);
      existing.amount = Math.max(existing.amount, amount);
      existing.expiresTick = laterExpiry(existing.expiresTick, expires);
      expiresTick = existing.expiresTick;
    } else {
      tgt.shields.push({ source: key, amount, expiresTick: expires, seq: this.seq++ });
    }
    this.ledgerOf(src).shielded += granted;
    this.events.push({ tick: this.tick, type: 'shield', uid: src.uid, target: tgt.uid, amount: granted, shieldAfter: shieldTotal(tgt), expiresTick, source: key });
  }

  /** Apply (or refresh) a tag. One entry per (tag, source); the longer expiry wins. */
  applyTag(src: FightUnit, tgt: FightUnit, tag: string, expires: number | null, source: string, slot: number): void {
    if (!tgt.alive) return;
    const key = instanceKey(source, src.uid, slot);
    const existing = tgt.tags.find((t) => t.tag === tag && t.source === key);
    let expiresTick = expires;
    if (existing) {
      existing.expiresTick = laterExpiry(existing.expiresTick, expires);
      expiresTick = existing.expiresTick;
    } else {
      tgt.tags.push({ tag, source: key, expiresTick: expires });
    }
    this.events.push({ tick: this.tick, type: 'tag', uid: tgt.uid, tag, expiresTick, source: key, active: true });
  }

  private removeTag(tgt: FightUnit, tag: string, source: string): void {
    const i = tgt.tags.findIndex((t) => t.tag === tag && t.source === source);
    if (i === -1) return;
    tgt.tags.splice(i, 1);
    this.events.push({ tick: this.tick, type: 'tag', uid: tgt.uid, tag, expiresTick: null, source, active: false });
  }

  /**
   * Launch a projectile at `tgt`. Travel time is fixed at spawn from the distance then,
   * so a moving target does not change the arrival tick (P0-02 refines travel and shapes).
   */
  spawnProjectile(src: FightUnit, tgt: FightUnit, ref: string, _source: string): void {
    this.launch(src, tgt, ref, 'effect');
  }

  private launch(src: FightUnit, tgt: FightUnit, ref: string, cause: 'attack' | 'effect'): void {
    const def = this.projectileDef(ref);
    const dist = hexDistance(src, tgt);
    const travel = dist === 0 ? 1 : Math.max(1, Math.round((dist / def.speed) * this.tickRate));
    const arrivalTick = this.tick + travel;
    this.projectiles.push({ seq: this.seq++, ref, ownerUid: src.uid, targetUid: tgt.uid, arrivalTick, cause });
    this.events.push({
      tick: this.tick,
      type: 'projectile',
      uid: src.uid,
      target: tgt.uid,
      ref,
      arrivalTick,
      from: { col: src.col, row: src.row },
      to: { col: tgt.col, row: tgt.row },
    });
  }

  private projectileDef(ref: string): ProjectileDef {
    const def = this.rules.projectiles[ref];
    if (!def) throw new Error(`fight: unknown projectile ${ref}`);
    return def;
  }

  /** Resolve every projectile due at or before `this.tick`, in spawn order. */
  private resolveProjectiles(): void {
    if (this.projectiles.length === 0) return;
    for (let i = 0; i < this.projectiles.length; i++) {
      const p = this.projectiles[i] as Projectile;
      if (p.arrivalTick > this.tick) continue;
      this.projectiles.splice(i, 1);
      i--;
      const owner = this.byUid[p.ownerUid] as FightUnit;
      const target = this.byUid[p.targetUid] as FightUnit;
      if (!target.alive) {
        this.events.push({ tick: this.tick, type: 'projectileFizzle', uid: p.ownerUid, target: p.targetUid, ref: p.ref });
        continue;
      }
      this.events.push({ tick: this.tick, type: 'projectileHit', uid: p.ownerUid, target: p.targetUid, ref: p.ref });
      runEffects(this, this.projectileDef(p.ref).effects, owner, target, p.cause === 'attack' ? 'attack' : `projectile:${p.ref}`);
      // A basic attack's onHit belongs to the impact, not to the moment the shot was fired.
      if (p.cause === 'attack' && owner.alive) this.fireHook(owner, 'onHit', target);
    }
  }

  // ---- internals ----
  private ledger: LedgerEntry[] = [];

  ledgerOf(u: FightUnit): LedgerEntry {
    let e = this.ledger[u.uid];
    if (!e) {
      e = { uid: u.uid, team: u.team, defId: u.defId, dealt: 0, taken: 0, healed: 0, shielded: 0, absorbed: 0, mitigated: 0, kills: 0, deaths: 0 };
      this.ledger[u.uid] = e;
    }
    return e;
  }

  ledgerEntries(): LedgerEntry[] {
    return this.units.map((u) => this.ledgerOf(u));
  }

  /**
   * Max-hp changes scale current hp proportionally, so adding and removing the same modifier
   * is idempotent: an aura toggling on the radius boundary can neither heal nor chip a unit
   * (QUESTIONS.md P0-01-10, replacing the "add the delta" rule of BOOT-07).
   */
  private refreshMaxHp(u: FightUnit): void {
    const newMax = getStat(u, 'hp');
    if (newMax === u.maxHp) return;
    u.hp = u.maxHp > 0 ? (u.hp * newMax) / u.maxHp : newMax;
    u.maxHp = newMax;
    if (u.hp > newMax) u.hp = newMax;
    this.events.push({ tick: this.tick, type: 'maxHp', uid: u.uid, maxHp: u.maxHp, hp: Math.max(0, u.hp) });
    // A modifier that drives max hp to 0 kills the unit instead of leaving it alive at 0 hp.
    if (u.alive && u.hp <= 0) this.kill(u, u);
  }

  private gainMana(u: FightUnit, amount: number): void {
    if (!u.alive || amount <= 0) return;
    const max = getStat(u, 'maxMana');
    u.mana = Math.min(max, u.mana + amount);
  }

  private kill(src: FightUnit, tgt: FightUnit): void {
    if (!tgt.alive) return;
    tgt.alive = false;
    tgt.hp = 0;
    this.occupancy[cellIndex(tgt, this.board)] = 0;
    this.aliveCount[tgt.team]--;
    tgt.shields.length = 0;
    this.ledgerOf(tgt).deaths += 1;
    if (src !== tgt) this.ledgerOf(src).kills += 1;
    this.events.push({ tick: this.tick, type: 'death', uid: tgt.uid, killer: src.uid });
    if (src !== tgt && src.alive) this.fireHook(src, 'onKill', tgt);
    this.fireHook(tgt, 'onDeath', src);
  }

  fireHook(u: FightUnit, hook: HookName, other: FightUnit | null): void {
    const effects = u.def.hooks[hook];
    if (!effects || effects.length === 0) return;
    // Hook chains (onTakeDamage -> damage -> onTakeDamage) are cut off at combat.maxHookDepth
    // so a data loop can never hang the sim. The cut-off is deterministic (QUESTIONS.md P0-01-04).
    if (this.hookDepth >= this.rules.combat.maxHookDepth) return;
    this.hookDepth++;
    try {
      runEffects(this, effects, u, other, `hook:${hook}:${u.defId}`);
    } finally {
      this.hookDepth--;
    }
  }

  private expireModifiers(): void {
    for (const u of this.units) {
      if (!u.alive || (u.shields.length === 0 && u.tags.length === 0 && u.modifiers.length === 0)) continue;
      let shieldsExpired = false;
      for (let i = u.shields.length - 1; i >= 0; i--) {
        const sh = u.shields[i] as ShieldInstance;
        if (sh.expiresTick !== null && sh.expiresTick <= this.tick) {
          u.shields.splice(i, 1);
          shieldsExpired = true;
        }
      }
      if (shieldsExpired) {
        this.events.push({ tick: this.tick, type: 'shield', uid: 0, target: u.uid, amount: 0, shieldAfter: shieldTotal(u), expiresTick: null, source: 'expiry' });
      }
      for (let i = u.tags.length - 1; i >= 0; i--) {
        const t = u.tags[i] as TagInstance;
        if (t.expiresTick !== null && t.expiresTick <= this.tick) {
          u.tags.splice(i, 1);
          this.events.push({ tick: this.tick, type: 'tag', uid: u.uid, tag: t.tag, expiresTick: null, source: t.source, active: false });
        }
      }
      if (u.modifiers.length === 0) continue;
      let changed = false;
      for (let i = u.modifiers.length - 1; i >= 0; i--) {
        const m = u.modifiers[i] as Modifier;
        if (m.expiresTick !== null && m.expiresTick <= this.tick) {
          u.modifiers.splice(i, 1);
          this.events.push({ tick: this.tick, type: 'statModEnd', uid: u.uid, stat: m.stat, source: m.source });
          changed = true;
        }
      }
      if (changed) {
        invalidateStats(u);
        this.refreshMaxHp(u);
      }
    }
  }

  private acquireTarget(u: FightUnit): FightUnit | null {
    if (u.target !== 0) {
      const t = this.byUid[u.target];
      if (t && t.alive) return t;
      u.target = 0;
    }
    let best: FightUnit | null = null;
    let bestDist = Infinity;
    for (const e of this.units) {
      if (!e.alive || e.team === u.team) continue;
      const d = hexDistance(u, e);
      if (d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (best) u.target = best.uid;
    return best;
  }

  private attackTicks(u: FightUnit): number {
    const c = this.rules.combat;
    let as = getStat(u, 'attackSpeed');
    if (as < c.minAttackSpeed) as = c.minAttackSpeed;
    if (as > c.maxAttackSpeed) as = c.maxAttackSpeed;
    return Math.max(1, Math.round(this.tickRate / as));
  }

  private tryCast(u: FightUnit, target: FightUnit | null): boolean {
    const ability = u.def.ability;
    if (!ability) return false;
    const maxMana = getStat(u, 'maxMana');
    if (maxMana <= 0 || u.mana < maxMana) return false;
    u.mana = 0;
    this.events.push({ tick: this.tick, type: 'cast', uid: u.uid, target: target ? target.uid : 0, ability: ability.name, manaAfter: 0 });
    runEffects(this, ability.effects, u, target, `ability:${u.defId}`);
    if (u.alive) this.fireHook(u, 'onCast', target);
    return true;
  }

  private attack(u: FightUnit, target: FightUnit): void {
    u.nextAttackTick = this.tick + this.attackTicks(u);
    this.gainMana(u, this.rules.combat.manaOnAttack);
    this.events.push({ tick: this.tick, type: 'attack', uid: u.uid, target: target.uid, manaAfter: u.mana });
    this.fireHook(u, 'onAttack', target);
    if (!u.alive || !target.alive) return;
    // A ranged unit with a projectile shoots: the damage and its onHit land on impact, which
    // is `distance / speed` seconds later. Melee units (and ranged units without one) hit now.
    const shot = u.def.attackProjectile;
    if (shot !== null) {
      this.launch(u, target, shot, 'attack');
      return;
    }
    this.damage(u, target, 'physical', getStat(u, 'attack'), 'attack');
    if (u.alive) this.fireHook(u, 'onHit', target);
  }

  private moveToward(u: FightUnit, target: FightUnit): void {
    if (this.tick < u.nextMoveTick) return;
    // A unit that cannot move waits a full move interval before trying again (no per-tick rescans).
    u.nextMoveTick = this.tick + this.moveTicks;
    const range = getStat(u, 'range');
    const blocked = (idx: number): boolean => this.occupancy[idx] !== 0;
    // Team 1 enumerates directions point-reflected so its pathing mirrors team 0's.
    const dirOffset = u.team === 0 ? 0 : MIRROR_DIR_OFFSET;
    let path = bfsPath(this.board, u, (c) => hexDistance(c, target) <= range, blocked, dirOffset);
    if (path === null) {
      // No route into range: step toward the reachable cell closest to the target.
      const goal = this.closestReachable(u, target, blocked, dirOffset);
      if (goal === null) return;
      path = bfsPath(this.board, u, (c) => c.col === goal.col && c.row === goal.row, blocked, dirOffset);
      if (path === null) return;
    }
    const step = path[0];
    if (!step) return;
    const from: Cell = { col: u.col, row: u.row };
    this.occupancy[cellIndex(from, this.board)] = 0;
    u.col = step.col;
    u.row = step.row;
    this.occupancy[cellIndex(step, this.board)] = u.uid;
    this.events.push({ tick: this.tick, type: 'move', uid: u.uid, from, to: { col: step.col, row: step.row } });
  }

  /**
   * Reachable cell strictly closer to the target than the unit's current cell, minimising
   * (hex distance to target, BFS steps, cell index). One flood fill; null when none exists.
   */
  private closestReachable(u: FightUnit, target: FightUnit, blocked: (idx: number) => boolean, dirOffset: number): Cell | null {
    const dist = floodDistances(this.board, u, blocked, dirOffset);
    let best: Cell | null = null;
    let bestDist = hexDistance(u, target);
    let bestSteps = Infinity;
    const n = this.board.cols * this.board.rows;
    for (let idx = 0; idx < n; idx++) {
      const steps = dist[idx] as number;
      if (steps <= 0) continue;
      const c = indexToCell(idx, this.board);
      const d = hexDistance(c, target);
      if (d < bestDist || (d === bestDist && steps < bestSteps)) {
        bestDist = d;
        bestSteps = steps;
        best = c;
      }
    }
    return best;
  }

  /**
   * Aura upkeep, once per tick before any unit acts. An aura holds only continuous effects
   * (statMod / applyTag): each is kept applied to exactly the in-range targets under a source
   * id unique to (aura owner, effect index), and removed again the moment a target leaves the
   * radius or the owner dies. Nothing is re-applied while it is already up, so per-tick upkeep
   * can never stack.
   */
  private updateAuras(): void {
    if (!this.hasAuras) return;
    for (const owner of this.units) {
      const aura = owner.def.aura;
      if (!aura) continue;
      const active = owner.alive;
      aura.effects.forEach((e: AuraEffect, i: number) => {
        const source = `aura:${owner.defId}:${owner.uid}:${i}`;
        const wanted = new Set<number>();
        if (active) {
          for (const t of this.resolveTargets(e.target, owner, null)) {
            if (hexDistance(owner, t) <= aura.range) wanted.add(t.uid);
          }
        }
        for (const t of this.units) {
          if (!t.alive) continue;
          const should = wanted.has(t.uid);
          if (e.type === 'statMod') {
            const has = t.modifiers.some((m) => m.source === source);
            if (should && !has) this.addModifier(t, { source, stat: e.stat, mode: e.mode, value: e.value, expiresTick: null }, source);
            else if (!should && has) this.dropModifiers(t, source);
          } else {
            const key = instanceKey(source, owner.uid, i);
            const has = t.tags.some((tag) => tag.source === key && tag.tag === e.tag);
            if (should && !has) this.applyTag(owner, t, e.tag, null, source, i);
            else if (!should && has) this.removeTag(t, e.tag, key);
          }
        }
      });
    }
  }

  private dropModifiers(u: FightUnit, source: string): void {
    let changed = false;
    for (let i = u.modifiers.length - 1; i >= 0; i--) {
      const m = u.modifiers[i] as Modifier;
      if (m.source === source) {
        u.modifiers.splice(i, 1);
        this.events.push({ tick: this.tick, type: 'statModEnd', uid: u.uid, stat: m.stat, source: m.source });
        changed = true;
      }
    }
    if (changed) {
      invalidateStats(u);
      this.refreshMaxHp(u);
    }
  }

  private unitTurn(u: FightUnit): void {
    if (!u.alive) return;
    if (this.tick < u.stunnedUntil) return;
    const target = this.acquireTarget(u);
    if (this.tryCast(u, target)) return;
    if (!u.alive || target === null) return;
    const t = this.acquireTarget(u);
    if (t === null) return;
    const range = getStat(u, 'range');
    if (hexDistance(u, t) <= range) {
      if (this.tick >= u.nextAttackTick) this.attack(u, t);
    } else {
      this.moveToward(u, t);
    }
  }

  run(): FightResult {
    const maxTicks = Math.max(1, Math.round(this.rules.combat.maxSeconds * this.tickRate));
    let winner: FightWinner = 'draw';
    let reason: FightEndReason = 'timeout';
    let ticks = maxTicks;
    this.tick = 0;
    // onRoundStart is the pre-combat setup trigger: it fires once, before any onCombatStart
    // hook, so data can separate "when the round begins" from "when combat begins".
    for (const u of this.units) this.fireHook(u, 'onRoundStart', null);
    for (const u of this.units) this.fireHook(u, 'onCombatStart', null);
    for (let t = 0; t < maxTicks; t++) {
      this.tick = t;
      this.expireModifiers();
      this.resolveProjectiles();
      this.updateAuras();
      if (this.aliveCount[0] === 0 || this.aliveCount[1] === 0) {
        ticks = t;
        reason = 'elimination';
        winner = this.decide();
        break;
      }
      for (const u of this.units) this.unitTurn(u);
      if (this.aliveCount[0] === 0 || this.aliveCount[1] === 0) {
        ticks = t + 1;
        reason = 'elimination';
        winner = this.decide();
        break;
      }
    }
    this.tick = ticks;
    // Shots still in the air when the fight ends fizzle: resolving damage after the outcome is
    // decided would change it, and dropping them silently leaves the renderer holding a shot
    // that never lands (QUESTIONS.md P0-02-05).
    for (const p of this.projectiles) {
      this.events.push({ tick: ticks, type: 'projectileFizzle', uid: p.ownerUid, target: p.targetUid, ref: p.ref });
    }
    this.projectiles.length = 0;
    this.events.push({ tick: ticks, type: 'end', winner, reason });
    const survivors = {
      left: this.units.filter((u) => u.alive && u.team === 0).map((u) => u.uid),
      right: this.units.filter((u) => u.alive && u.team === 1).map((u) => u.uid),
    };
    const events = this.events;
    return {
      winner,
      reason,
      ticks,
      events,
      survivors,
      ledger: this.ledgerEntries(),
      hash: hashValue({ winner, reason, ticks, events }),
    };
  }

  private decide(): FightWinner {
    const l = this.aliveCount[0];
    const r = this.aliveCount[1];
    if (l > 0 && r === 0) return 'left';
    if (r > 0 && l === 0) return 'right';
    return 'draw';
  }
}

/** Total remaining absorption on a unit. */
export function shieldTotal(u: FightUnit): number {
  let total = 0;
  for (const sh of u.shields) total += sh.amount;
  return total;
}

/** Instance key for a shield or tag: unique per (source, granting unit, effect slot). */
function instanceKey(source: string, uid: number, slot: number): string {
  return `${source}#${uid}.${slot}`;
}

/** null (permanent) is the largest expiry; otherwise the later tick wins. */
function laterExpiry(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a > b ? a : b;
}

/** Shield consumption order: soonest expiry first (permanent last), then oldest granted. */
function shieldOrder(a: ShieldInstance, b: ShieldInstance): number {
  if (a.expiresTick !== b.expiresTick) {
    if (a.expiresTick === null) return 1;
    if (b.expiresTick === null) return -1;
    return a.expiresTick - b.expiresTick;
  }
  return a.seq - b.seq;
}

/** Pure fight between two boards authored in owner-half coordinates (right is mirrored). */
export function fight(left: FightSide | readonly BoardUnit[], right: FightSide | readonly BoardUnit[], seed: number, rules: FightRules): FightResult {
  const sim = new FightSim(rules, seed);
  sim.spawn(Array.isArray(left) ? left : (left as FightSide).units, 0);
  sim.spawn(Array.isArray(right) ? right : (right as FightSide).units, 1);
  return sim.run();
}
