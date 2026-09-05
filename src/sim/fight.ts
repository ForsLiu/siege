// fight(left, right, seed, rules) -> FightResult. Pure: reads only its arguments.
// Fixed tick rate from rules; units act in uid order each tick; all tie-breaks are stable.
import type { DamageKind, HookName, TargetSel } from './effects.ts';
import { runEffects, type EffectHost } from './effects.ts';
import { hashValue } from './hash.ts';
import { bfsPath, cellIndex, floodDistances, hexDistance, indexToCell, mirrorCell, inBounds, MIRROR_DIR_OFFSET, type BoardConfig, type Cell } from './hex.ts';
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
}

export type FightEvent = { tick: number } & (
  | { type: 'spawn'; uid: number; defId: string; star: number; team: Team; col: number; row: number; hp: number; maxHp: number; mana: number; maxMana: number }
  | { type: 'move'; uid: number; from: Cell; to: Cell }
  | { type: 'attack'; uid: number; target: number; manaAfter: number }
  | { type: 'hit'; uid: number; target: number; kind: DamageKind; amount: number; hpAfter: number; manaAfter: number; cause: string }
  | { type: 'heal'; uid: number; target: number; amount: number; hpAfter: number; cause: string }
  | { type: 'statMod'; uid: number; stat: StatName; mode: 'mul' | 'flat'; value: number; expiresTick: number | null; source: string }
  | { type: 'stun'; uid: number; untilTick: number; cause: string }
  | { type: 'cast'; uid: number; target: number; ability: string; manaAfter: number }
  | { type: 'death'; uid: number; killer: number }
  | { type: 'end'; winner: FightWinner; reason: FightEndReason }
);

export interface LedgerEntry {
  uid: number;
  team: Team;
  defId: string;
  dealt: number;
  taken: number;
  healed: number;
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
      };
      u.maxHp = getStat(u, 'hp');
      u.hp = u.maxHp;
      u.mana = Math.min(getStat(u, 'maxMana'), getStat(u, 'startMana'));
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

  damage(src: FightUnit, tgt: FightUnit, kind: DamageKind, amount: number, cause: string): void {
    if (!tgt.alive) return;
    const K = this.rules.combat.mitigationConstant;
    let dmg = amount;
    if (kind === 'physical') dmg = amount * (K / (K + getStat(tgt, 'armor')));
    else if (kind === 'magic') dmg = amount * (K / (K + getStat(tgt, 'magicResist')));
    if (dmg < 0) dmg = 0;
    tgt.hp -= dmg;
    this.gainMana(tgt, this.rules.combat.manaOnHitTaken);
    this.ledgerOf(src).dealt += dmg;
    this.ledgerOf(tgt).taken += dmg;
    this.events.push({ tick: this.tick, type: 'hit', uid: src.uid, target: tgt.uid, kind, amount: dmg, hpAfter: Math.max(0, tgt.hp), manaAfter: tgt.mana, cause });
    if (tgt.hp <= 0) this.kill(src, tgt);
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

  // ---- internals ----
  private ledger: LedgerEntry[] = [];

  ledgerOf(u: FightUnit): LedgerEntry {
    let e = this.ledger[u.uid];
    if (!e) {
      e = { uid: u.uid, team: u.team, defId: u.defId, dealt: 0, taken: 0, healed: 0 };
      this.ledger[u.uid] = e;
    }
    return e;
  }

  ledgerEntries(): LedgerEntry[] {
    return this.units.map((u) => this.ledgerOf(u));
  }

  private refreshMaxHp(u: FightUnit): void {
    const newMax = getStat(u, 'hp');
    if (newMax === u.maxHp) return;
    if (newMax > u.maxHp) u.hp += newMax - u.maxHp;
    else if (u.hp > newMax) u.hp = newMax;
    u.maxHp = newMax;
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
    this.events.push({ tick: this.tick, type: 'death', uid: tgt.uid, killer: src.uid });
    if (src !== tgt && src.alive) this.fireHook(src, 'onKill', tgt);
    this.fireHook(tgt, 'onDeath', src);
  }

  fireHook(u: FightUnit, hook: HookName, other: FightUnit | null): void {
    const effects = u.def.hooks[hook];
    if (!effects || effects.length === 0) return;
    runEffects(this, effects, u, other, `hook:${hook}:${u.defId}`);
  }

  private expireModifiers(): void {
    for (const u of this.units) {
      if (!u.alive || u.modifiers.length === 0) continue;
      let changed = false;
      for (let i = u.modifiers.length - 1; i >= 0; i--) {
        const m = u.modifiers[i] as Modifier;
        if (m.expiresTick !== null && m.expiresTick <= this.tick) {
          u.modifiers.splice(i, 1);
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
    for (const u of this.units) this.fireHook(u, 'onCombatStart', null);
    for (let t = 0; t < maxTicks; t++) {
      this.tick = t;
      this.expireModifiers();
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

/** Pure fight between two boards authored in owner-half coordinates (right is mirrored). */
export function fight(left: FightSide | readonly BoardUnit[], right: FightSide | readonly BoardUnit[], seed: number, rules: FightRules): FightResult {
  const sim = new FightSim(rules, seed);
  sim.spawn(Array.isArray(left) ? left : (left as FightSide).units, 0);
  sim.spawn(Array.isArray(right) ? right : (right as FightSide).units, 1);
  return sim.run();
}
