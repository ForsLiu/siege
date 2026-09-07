// Run state and the mechanics behind the Commands: shop, pool, merges, economy, rounds.
// All numbers come from content.rules (data/dev/rules.json until SPEC.md).
import { fight, type FightEndReason, type FightWinner } from './fight.ts';
import { hashValue } from './hash.ts';
import { findCombineTarget } from './items.ts';
import { createRngStates, Rng, type RngStates, type StreamName } from './rng.ts';
import { fightRulesFrom, type Content, type Encounter, type EncounterType, type FightRules } from './rules.ts';
import type { BoardUnit, OwnedUnit, PlacedUnit } from './units.ts';

export type Phase = 'planning' | 'combat' | 'reward' | 'ended';
export type Outcome = 'win' | 'loss';
export type EndReason = 'victory' | 'defeat' | 'abandon';

export interface FightSummary {
  seed: number;
  winner: FightWinner;
  reason: FightEndReason;
  ticks: number;
  eventCount: number;
  hash: string;
  hpLoss: number;
  survivorsLeft: number;
  survivorsRight: number;
}

export interface Reward {
  gold: number;
  base: number;
  interest: number;
  winBonus: number;
  encounterGold: number;
  xp: number;
  /** Guaranteed loot rolled this round (P0-28): 'component'/'completed' drops. Never includes a
   *  'choice' row's pick — that goes through `lootOffer`/`pickLoot` instead. */
  items: string[];
}

export interface RoundRecord {
  round: number;
  encounterId: string;
  /** Player state at the moment combat started. */
  gold: number;
  level: number;
  xp: number;
  hpBefore: number;
  hpAfter: number;
  /** "defId@star" sorted, for composition curves. */
  board: string[];
  /** null when `dev:skipRound` resolved the round instead of a fight. */
  fight: FightSummary | null;
  /** True when the round was skipped by a dev command. */
  skipped: boolean;
}

export interface RunConfig {
  seed: number;
  contentHash: string;
  rulesVersion: number;
  /** Dev builds set this; only then does the sim accept `dev:` commands. */
  devCommands: boolean;
}

export interface RunOptions {
  /** Accept `dev:` commands in this run. Production builds never set it. */
  devCommands?: boolean;
}

/** Dev cheats that outlive a single command (set by the `dev:invincible*` commands). */
export interface DevFlags {
  /** Player units cannot drop below 1 hp during combat. */
  invinciblePieces: boolean;
  /** The player loses no hp from a lost or drawn round. */
  invinciblePlayer: boolean;
}

export interface RunState {
  version: 1;
  config: RunConfig;
  round: number;
  phase: Phase;
  gold: number;
  level: number;
  xp: number;
  hp: number;
  shop: (string | null)[];
  bench: (OwnedUnit | null)[];
  /** Always sorted by uid. */
  board: PlacedUnit[];
  /** Remaining copies per unit id. */
  pool: Record<string, number>;
  nextUid: number;
  rng: RngStates;
  lastFight: FightSummary | null;
  pendingReward: Reward | null;
  outcome: Outcome | null;
  endReason: EndReason | null;
  history: RoundRecord[];
  /** Augment ids granted so far, applied at the start of every combat from here on. */
  augments: string[];
  /** Ids offered on the current `augment`-type round; null when none is pending. */
  augmentOffer: string[] | null;
  /** Item ids on the item bench (P0-27): `equipItem` removes one to equip it; `dev:giveItem`
   *  and encounter loot (P0-28) add to it. */
  itemBench: string[];
  /** Ids offered by a pending 'choice' loot row (P0-28); null when none is pending. Set only in
   *  the `reward` phase, after a won round's loot table rolls; an unresolved offer lapses
   *  (cleared, not carried forward) when `advanceRound` moves past it — no acceptance criterion
   *  requires blocking `nextRound` on it, and it already mirrors how an unpicked augment offer
   *  lapses the moment `refreshAugmentOffer` overwrites it (QUESTIONS.md P0-28-03). */
  lootOffer: string[] | null;
  dev: DevFlags;
  /** Round-boundary hashes: [0] after creation, then one per nextRound, plus one at run end. */
  hashes: string[];
  commandCount: number;
}

/** State hash: everything except the hash list itself. */
export function stateHash(state: RunState): string {
  const { hashes: _omit, ...rest } = state;
  return hashValue(rest);
}

export function withRng<T>(state: RunState, stream: StreamName, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng[stream]);
  const out = fn(rng);
  state.rng[stream] = rng.state();
  return out;
}

export function createRun(seed: number, content: Content, options: RunOptions = {}): RunState {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`createRun: seed must be an integer in [0, 2^32), got ${seed}`);
  const eco = content.rules.economy;
  const pool: Record<string, number> = {};
  for (const u of content.units) pool[u.id] = eco.poolSize[String(u.cost)] ?? 0;
  const state: RunState = {
    version: 1,
    config: { seed, contentHash: content.contentHash, rulesVersion: content.rules.version, devCommands: options.devCommands === true },
    round: 1,
    phase: 'planning',
    gold: eco.startGold,
    level: eco.startLevel,
    xp: eco.startXp,
    hp: eco.startHp,
    shop: new Array<string | null>(eco.shopSlots).fill(null),
    bench: new Array<OwnedUnit | null>(eco.benchSlots).fill(null),
    board: [],
    pool,
    nextUid: 1,
    rng: createRngStates(seed),
    lastFight: null,
    pendingReward: null,
    outcome: null,
    endReason: null,
    history: [],
    augments: [],
    augmentOffer: null,
    itemBench: [],
    lootOffer: null,
    dev: { invinciblePieces: false, invinciblePlayer: false },
    hashes: [],
    commandCount: 0,
  };
  refreshShop(state, content);
  refreshAugmentOffer(state, content);
  state.hashes.push(stateHash(state));
  return state;
}

export function currentEncounter(state: RunState, content: Content): Encounter | null {
  return content.encounters[state.round - 1] ?? null;
}

export interface RoundTrackRewardPreview {
  gold: number;
  xp: number;
  /** Every distinct item id this encounter's loot table could produce (P0-28): a preview of
   *  what's possible, not an actual roll — this is a pure function of content, and a real roll
   *  needs the `loot` RNG stream, only available once the round is actually won. Empty when the
   *  encounter has no loot table. */
  items: string[];
  /** True on an `augment`-type round; the actual offer is drawn by P0-24, not previewed here. */
  augmentOffer: boolean;
}

export interface RoundTrackEntry {
  round: number;
  encounterId: string;
  type: EncounterType;
  isCurrent: boolean;
  isPast: boolean;
  rewardPreview: RoundTrackRewardPreview;
}

/**
 * The run's round track (P0-22): one entry per `content.encounters`, in that order, with
 * `isCurrent`/`isPast` derived from `round` (normally `state.round`). A pure function of content
 * plus a round number — nothing here reads RNG or command history, so it is identical for two
 * runs of the same seed at the same round regardless of how they got there (a replay included).
 */
export function roundTrack(round: number, content: Content): RoundTrackEntry[] {
  const eco = content.rules.economy;
  return content.encounters.map((e) => ({
    round: e.round,
    encounterId: e.id,
    type: e.type,
    isCurrent: e.round === round,
    isPast: e.round < round,
    rewardPreview: { gold: e.reward.gold, xp: eco.xpPerRound, items: [...new Set(e.loot.flatMap((row) => row.itemIds))], augmentOffer: e.type === 'augment' },
  }));
}

export function unitCost(defId: string, content: Content): number {
  // Own-property lookup: an inherited key such as `constructor` must not pass as a unit.
  if (!Object.hasOwn(content.unitsById, defId)) throw new Error(`unknown unit ${defId}`);
  return (content.unitsById[defId] as { cost: number }).cost;
}

export function copiesForStar(star: number, content: Content): number {
  return Math.pow(content.rules.economy.mergeCopies, star - 1);
}

export function sellValue(unit: OwnedUnit, content: Content): number {
  return Math.floor(unitCost(unit.defId, content) * copiesForStar(unit.star, content) * content.rules.economy.sellRefund);
}

export function interestFor(gold: number, content: Content): number {
  const i = content.rules.economy.interest;
  return Math.min(i.max, Math.floor(gold / i.per));
}

export interface IncomePreview {
  base: number;
  interest: number;
  /** 0 before the round's combat has resolved: the outcome isn't known yet (P0-21). */
  winBonus: number;
  /** Always 0 today: `EconomyRules` defines no win/loss-streak rule yet (P0-21, QUESTIONS.md). */
  streakBonus: number;
  encounterGold: number;
  total: number;
  /** Guaranteed loot actually granted this round (P0-28); always [] before combat resolves,
   *  since a real roll needs the outcome (and the `loot` stream is only consumed on a win). */
  items: string[];
}

/**
 * The gold breakdown for the coming round, read by the HUD gold panel and the round-end summary
 * (P0-21) instead of either computing it themselves. In the `reward` phase this mirrors
 * `state.pendingReward` exactly (the outcome is already known and `state.gold` cannot change
 * before `nextRound` applies it); before combat it previews the same base/interest/encounter
 * amounts with the win bonus at 0, since winning isn't decided yet.
 */
export function incomePreview(state: RunState, content: Content): IncomePreview {
  const eco = content.rules.economy;
  const base = eco.baseIncome;
  const interest = interestFor(state.gold, content);
  const streakBonus = 0;
  if (state.phase === 'reward' && state.pendingReward) {
    const r = state.pendingReward;
    return { base: r.base, interest: r.interest, winBonus: r.winBonus, streakBonus, encounterGold: r.encounterGold, total: r.gold, items: r.items };
  }
  const encounterGold = currentEncounter(state, content)?.reward.gold ?? 0;
  const winBonus = 0;
  return { base, interest, winBonus, streakBonus, encounterGold, total: base + interest + winBonus + streakBonus + encounterGold, items: [] };
}

export function hpLossFor(round: number, enemySurvivors: number, content: Content): number {
  const t = content.rules.hpLoss;
  const base = t.byRound[Math.min(round - 1, t.byRound.length - 1)] ?? 0;
  return base + t.perSurvivingUnit * enemySurvivors;
}

export function xpNeeded(level: number, content: Content): number {
  return content.rules.economy.xpToLevel[level] ?? Infinity;
}

export function addXp(state: RunState, amount: number, content: Content): void {
  const eco = content.rules.economy;
  state.xp += amount;
  while (state.level < eco.maxLevel && state.xp >= xpNeeded(state.level, content)) {
    state.xp -= xpNeeded(state.level, content);
    state.level++;
  }
  if (state.level >= eco.maxLevel) state.xp = 0; // xp has no use at max level
}

// ---- shop & pool ----

function tierOrder(preferred: number, tiers: number): number[] {
  const out = [preferred];
  for (let t = preferred + 1; t < tiers; t++) out.push(t);
  for (let t = preferred - 1; t >= 0; t--) out.push(t);
  return out;
}

/**
 * Draw one unit id from the pool for the given level, or null when the pool is empty.
 * `forcedTier` (0-based cost tier, used by `dev:openShop`) skips the odds roll — and with it
 * the rng draw it would consume — and starts the tier fallback at that tier.
 */
export function drawUnit(state: RunState, content: Content, rng: Rng, forcedTier?: number): string | null {
  const eco = content.rules.economy;
  const odds = eco.shopOdds[String(state.level)] ?? eco.shopOdds[String(eco.maxLevel)] ?? [];
  let tier: number;
  if (forcedTier === undefined) {
    const roll = rng.next() * 100;
    let acc = 0;
    tier = odds.length - 1;
    for (let i = 0; i < odds.length; i++) {
      acc += odds[i] as number;
      if (roll < acc) {
        tier = i;
        break;
      }
    }
  } else {
    tier = forcedTier;
  }
  for (const t of tierOrder(tier, odds.length)) {
    const cost = t + 1;
    let total = 0;
    for (const u of content.units) if (u.cost === cost) total += poolCount(state, u.id);
    if (total <= 0) continue;
    let pick = rng.int(total);
    for (const u of content.units) {
      if (u.cost !== cost) continue;
      const n = poolCount(state, u.id);
      if (pick < n) {
        state.pool[u.id] = n - 1;
        return u.id;
      }
      pick -= n;
    }
  }
  return null;
}

/** Own-property read of a pool count; inherited keys (`constructor`, `toString`) count as 0. */
export function poolCount(state: RunState, defId: string): number {
  return Object.hasOwn(state.pool, defId) ? (state.pool[defId] as number) : 0;
}

/** The configured maximum number of copies of a unit in the shared pool. */
export function poolCapacity(defId: string, content: Content): number {
  const def = content.unitsById[defId];
  if (!def || !Object.hasOwn(content.unitsById, defId)) return 0;
  return content.rules.economy.poolSize[String(def.cost)] ?? 0;
}

/**
 * Return copies to the shared pool, never above the configured pool size for the unit.
 * The cap matters once `dev:spawnUnit` hands out copies the pool could not cover: without it,
 * selling them would inflate the pool past its data-defined size and skew shop odds.
 */
export function returnToPool(state: RunState, defId: string, copies: number, content: Content): void {
  const capacity = poolCapacity(defId, content);
  const next = poolCount(state, defId) + copies;
  state.pool[defId] = next > capacity ? capacity : next;
}

/**
 * Remove up to `copies` of a unit from the shared pool and return how many were actually taken.
 * Used by `dev:spawnUnit`: a cheat may conjure a unit the pool has run out of, but it must never
 * drive a pool count negative (checkInvariants).
 */
export function takeFromPool(state: RunState, defId: string, copies: number): number {
  const have = poolCount(state, defId);
  const taken = Math.min(have, Math.max(0, copies));
  state.pool[defId] = have - taken;
  return taken;
}

/** Number of cost tiers the shop odds define (tier 1 = cost 1). */
export function shopTierCount(content: Content): number {
  let n = 0;
  for (const odds of Object.values(content.rules.economy.shopOdds)) if (odds.length > n) n = odds.length;
  if (n === 0) for (const u of content.units) if (u.cost > n) n = u.cost;
  return n;
}

export interface ShopOddsRow {
  /** Cost tier, 1-based (index 0 of `economy.shopOdds[level]` is tier 1). */
  tier: number;
  percent: number;
}

export interface ShopHudModel {
  level: number;
  xp: number;
  /** Null at max level: `EconomyRules.xpToLevel` has no entry past it. */
  xpNeeded: number | null;
  /** `xp / xpNeeded`, clamped to [0, 1]; 1 at max level. */
  xpProgress: number;
  /** The current level's odds row, tier order, straight off `economy.shopOdds` (same fallback
   *  to `maxLevel`'s row that `drawUnit` uses when a level is missing one). */
  odds: ShopOddsRow[];
  rerollCost: number;
  xpCost: number;
}

/** Shop HUD numbers (P0-23): the UI reads this instead of touching `economy.shopOdds` or any
 *  other rule constant itself, so no tuning number appears in `src/ui`. */
export function shopHudModel(state: RunState, content: Content): ShopHudModel {
  const eco = content.rules.economy;
  const row = eco.shopOdds[String(state.level)] ?? eco.shopOdds[String(eco.maxLevel)] ?? [];
  const atMax = state.level >= eco.maxLevel;
  const needed = atMax ? null : xpNeeded(state.level, content);
  return {
    level: state.level,
    xp: state.xp,
    xpNeeded: needed,
    xpProgress: atMax || !needed ? 1 : Math.min(1, Math.max(0, state.xp / needed)),
    odds: row.map((percent, i) => ({ tier: i + 1, percent })),
    rerollCost: eco.rerollCost,
    xpCost: eco.xpCost,
  };
}

/**
 * Return unsold shop units to the pool and draw a fresh shop. `tier` (1-based cost, used by
 * `dev:openShop`) forces every slot into that tier, falling back to the neighbouring tiers
 * exactly like a normal draw when its pool is empty.
 */
export function refreshShop(state: RunState, content: Content, tier?: number): void {
  for (let i = 0; i < state.shop.length; i++) {
    const id = state.shop[i];
    if (id) returnToPool(state, id, 1, content);
    state.shop[i] = null;
  }
  const forcedTier = tier === undefined ? undefined : tier - 1;
  withRng(state, 'shop', (rng) => {
    for (let i = 0; i < state.shop.length; i++) state.shop[i] = drawUnit(state, content, rng, forcedTier);
  });
}

// ---- augments ----

/** Deterministically draw `rules.augment.offerCount` distinct augment ids from `content.augments`
 *  via the `augment` RNG stream (fewer if the pool is smaller): a full shuffle then take-n, so it
 *  shares `Rng`'s one Fisher-Yates implementation instead of a second hand-rolled partial one. */
export function drawAugmentOffer(state: RunState, content: Content): string[] {
  const n = content.rules.augment.offerCount;
  return withRng(state, 'augment', (rng) => rng.shuffle([...content.augments]).slice(0, n).map((a) => a.id));
}

/** Sets or clears `state.augmentOffer` for the round the state is currently on: an offer is
 *  drawn exactly on an `augment`-type round, replacing whatever was pending before. */
export function refreshAugmentOffer(state: RunState, content: Content): void {
  const encounter = currentEncounter(state, content);
  state.augmentOffer = encounter?.type === 'augment' ? drawAugmentOffer(state, content) : null;
}

/** The picked augments' effects, per side, ready for `FightRules.startEffects` — empty on the
 *  side with nothing picked, so a run with no augments behaves exactly as before P0-24. */
export function augmentStartEffects(state: RunState, content: Content): FightRules['startEffects'] {
  const left = state.augments.flatMap((id) => content.augmentsById[id]?.effects ?? []);
  return { left, right: [] };
}

// ---- units on bench / board ----

export function findUnit(state: RunState, uid: number): { unit: OwnedUnit; where: 'board'; index: number } | { unit: OwnedUnit; where: 'bench'; index: number } | null {
  const bi = state.board.findIndex((u) => u.uid === uid);
  if (bi !== -1) return { unit: state.board[bi] as PlacedUnit, where: 'board', index: bi };
  const si = state.bench.findIndex((u) => u !== null && u.uid === uid);
  if (si !== -1) return { unit: state.bench[si] as OwnedUnit, where: 'bench', index: si };
  return null;
}

export function freeBenchSlot(state: RunState): number {
  return state.bench.findIndex((u) => u === null);
}

export function boardUnitAt(state: RunState, col: number, row: number): PlacedUnit | null {
  return state.board.find((u) => u.col === col && u.row === row) ?? null;
}

export function countCopies(state: RunState, defId: string, star: number): number {
  let n = 0;
  for (const u of state.board) if (u.defId === defId && u.star === star) n++;
  for (const u of state.bench) if (u && u.defId === defId && u.star === star) n++;
  return n;
}

export function removeUnit(state: RunState, uid: number): OwnedUnit | null {
  const found = findUnit(state, uid);
  if (!found) return null;
  if (found.where === 'board') state.board.splice(found.index, 1);
  else state.bench[found.index] = null;
  return found.unit;
}

export function insertBoardUnit(state: RunState, unit: PlacedUnit): void {
  state.board.push(unit);
  state.board.sort((a, b) => a.uid - b.uid);
}

/**
 * Equip `itemId` onto `unit`: combines with a held component through the recipe table when one
 * matches (net item count unchanged — the held component is replaced by the completed item), or
 * else appends as a new item (P0-27). The caller (`equipItem` command validation) is responsible
 * for the item-slot cap; this never checks it, since a combine is always cap-neutral.
 */
export function equipItem(unit: OwnedUnit, itemId: string, content: Content): void {
  const combine = findCombineTarget(unit.items, itemId, content.itemsById, content.recipesByKey);
  if (combine) unit.items[combine.index] = combine.resultId;
  else unit.items.push(itemId);
}

/**
 * Merge `mergeCopies` copies of (defId, star) into one unit of star + 1, chaining upward.
 * The kept unit is the lowest-uid copy on the board, else the lowest-uid copy on the bench.
 * Bench copies are consumed before board copies. The removed copies' items move onto the kept
 * unit up to `itemSlots`, in removal order; anything past the cap returns to the item bench
 * (P0-28) — each chained merge (star -> star+1 -> star+2, ...) applies this independently, so a
 * unit that fills up on one merge still only overflows the excess on the next. Returns the number
 * of merges performed.
 */
export function tryMerge(state: RunState, defId: string, star: number, content: Content): number {
  const eco = content.rules.economy;
  let merges = 0;
  let s = star;
  while (s < eco.maxStar && countCopies(state, defId, s) >= eco.mergeCopies) {
    const boardCopies = state.board.filter((u) => u.defId === defId && u.star === s);
    const benchCopies: OwnedUnit[] = [];
    for (const u of state.bench) if (u && u.defId === defId && u.star === s) benchCopies.push(u);
    benchCopies.sort((a, b) => a.uid - b.uid);
    const keep = boardCopies[0] ?? (benchCopies[0] as OwnedUnit);
    const candidates = [...benchCopies, ...boardCopies].filter((u) => u.uid !== keep.uid);
    for (let i = 0; i < eco.mergeCopies - 1; i++) {
      const removed = removeUnit(state, (candidates[i] as OwnedUnit).uid) as OwnedUnit;
      for (const itemId of removed.items) {
        if (keep.items.length < eco.itemSlots) keep.items.push(itemId);
        else state.itemBench.push(itemId);
      }
    }
    keep.star = s + 1;
    merges++;
    s++;
  }
  return merges;
}

// ---- rounds ----

export function boardComposition(state: RunState): string[] {
  return state.board.map((u) => `${u.defId}@${u.star}`).sort();
}

/**
 * Rolls `encounter.loot` on the `loot` RNG stream (P0-28): a 'component'/'completed' row grants
 * one item drawn uniformly from its `itemIds`; a 'choice' row sets `state.lootOffer` instead of
 * granting anything (the player picks via `pickLoot`). Only on a win, and only when the encounter
 * has a loot table — the stream is left untouched otherwise, exactly like `refreshAugmentOffer`
 * only consuming the `augment` stream on an augment-type round. `state.lootOffer` is always reset
 * here (never carried over from a previous round's unresolved offer — QUESTIONS.md P0-28-03).
 */
export function rollLoot(state: RunState, encounter: Encounter, won: boolean): string[] {
  state.lootOffer = null;
  if (!won || encounter.loot.length === 0) return [];
  const granted: string[] = [];
  withRng(state, 'loot', (rng) => {
    for (const row of encounter.loot) {
      if (row.kind === 'choice') state.lootOffer = [...row.itemIds];
      else granted.push(rng.pick(row.itemIds));
    }
  });
  return granted;
}

export function computeReward(state: RunState, won: boolean, encounter: Encounter, content: Content, items: string[]): Reward {
  const eco = content.rules.economy;
  const base = eco.baseIncome;
  const interest = interestFor(state.gold, content);
  const winBonus = won ? eco.winBonus : 0;
  const encounterGold = encounter.reward.gold;
  return { gold: base + interest + winBonus + encounterGold, base, interest, winBonus, encounterGold, xp: eco.xpPerRound, items };
}

export interface CombatOutcome {
  result: ReturnType<typeof fight>;
  summary: FightSummary;
}

/** Runs the round's fight and advances the run: reward phase, defeat, or victory. */
export function resolveCombat(state: RunState, content: Content): CombatOutcome {
  const encounter = currentEncounter(state, content);
  if (!encounter) throw new Error(`resolveCombat: no encounter for round ${state.round}`);
  const seed = withRng(state, 'combat', (rng) => rng.nextU32());
  const left: BoardUnit[] = state.board.map((u) => ({ defId: u.defId, star: u.star, col: u.col, row: u.row, items: u.items }));
  const rules = fightRulesFrom(content);
  // dev:invinciblePieces keeps the player's units above 0 hp for this fight (dev builds only).
  if (state.dev.invinciblePieces) rules.invincible = { left: true, right: false };
  if (state.augments.length > 0) rules.startEffects = augmentStartEffects(state, content);
  const result = fight(left, encounter.board, seed, rules);
  const won = result.winner === 'left';
  const lostForHp = result.winner === 'right' || (result.winner === 'draw' && content.rules.combat.drawCountsAsLoss);
  const hpLoss = lostForHp && !state.dev.invinciblePlayer ? hpLossFor(state.round, result.survivors.right.length, content) : 0;
  const hpBefore = state.hp;
  state.hp = Math.max(0, state.hp - hpLoss);
  const summary: FightSummary = {
    seed,
    winner: result.winner,
    reason: result.reason,
    ticks: result.ticks,
    eventCount: result.events.length,
    hash: result.hash,
    hpLoss,
    survivorsLeft: result.survivors.left.length,
    survivorsRight: result.survivors.right.length,
  };
  state.lastFight = summary;
  state.history.push({
    round: state.round,
    encounterId: encounter.id,
    gold: state.gold,
    level: state.level,
    xp: state.xp,
    hpBefore,
    hpAfter: state.hp,
    board: boardComposition(state),
    fight: summary,
    skipped: false,
  });
  if (state.hp <= 0) {
    endRun(state, 'loss', 'defeat');
  } else if (state.round >= content.encounters.length) {
    // The run is won only by beating the final encounter (BOOT-06); a lost or drawn last
    // fight with hp left is still a defeat.
    endRun(state, won ? 'win' : 'loss', won ? 'victory' : 'defeat');
  } else {
    const items = rollLoot(state, encounter, won);
    state.pendingReward = computeReward(state, won, encounter, content, items);
    state.phase = 'reward';
  }
  return { result, summary };
}

/**
 * `dev:skipRound`: resolve the current round as a win with the normal rewards, without a fight.
 * No fight runs, so the `combat` stream is untouched and the round record carries `fight: null`;
 * the `loot` stream is still rolled exactly as a real win would (P0-28), since loot is a
 * reward-phase concern independent of how the round was won.
 */
export function skipRoundAsWin(state: RunState, content: Content): void {
  const encounter = currentEncounter(state, content);
  if (!encounter) throw new Error(`skipRoundAsWin: no encounter for round ${state.round}`);
  state.lastFight = null;
  state.history.push({
    round: state.round,
    encounterId: encounter.id,
    gold: state.gold,
    level: state.level,
    xp: state.xp,
    hpBefore: state.hp,
    hpAfter: state.hp,
    board: boardComposition(state),
    fight: null,
    skipped: true,
  });
  if (state.round >= content.encounters.length) {
    endRun(state, 'win', 'victory');
    return;
  }
  const items = rollLoot(state, encounter, true);
  state.pendingReward = computeReward(state, true, encounter, content, items);
  state.phase = 'reward';
}

export function endRun(state: RunState, outcome: Outcome, reason: EndReason): void {
  state.phase = 'ended';
  state.outcome = outcome;
  state.endReason = reason;
  state.pendingReward = null;
  state.lootOffer = null;
  state.hashes.push(stateHash(state));
}

export function advanceRound(state: RunState, content: Content): void {
  const reward = state.pendingReward;
  if (reward) {
    state.gold += reward.gold;
    addXp(state, reward.xp, content);
    state.itemBench.push(...reward.items);
  }
  state.pendingReward = null;
  state.lootOffer = null;
  state.round++;
  state.phase = 'planning';
  refreshShop(state, content);
  refreshAugmentOffer(state, content);
  state.hashes.push(stateHash(state));
}
