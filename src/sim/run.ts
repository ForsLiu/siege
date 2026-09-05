// Run state and the mechanics behind the Commands: shop, pool, merges, economy, rounds.
// All numbers come from content.rules (data/dev/rules.json until SPEC.md).
import { fight, type FightEndReason, type FightWinner } from './fight.ts';
import { hashValue } from './hash.ts';
import { createRngStates, Rng, type RngStates, type StreamName } from './rng.ts';
import { fightRulesFrom, type Content, type Encounter } from './rules.ts';
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
  fight: FightSummary;
}

export interface RunConfig {
  seed: number;
  contentHash: string;
  rulesVersion: number;
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

export function createRun(seed: number, content: Content): RunState {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error(`createRun: seed must be an integer in [0, 2^32), got ${seed}`);
  const eco = content.rules.economy;
  const pool: Record<string, number> = {};
  for (const u of content.units) pool[u.id] = eco.poolSize[String(u.cost)] ?? 0;
  const state: RunState = {
    version: 1,
    config: { seed, contentHash: content.contentHash, rulesVersion: content.rules.version },
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
    hashes: [],
    commandCount: 0,
  };
  refreshShop(state, content);
  state.hashes.push(stateHash(state));
  return state;
}

export function currentEncounter(state: RunState, content: Content): Encounter | null {
  return content.encounters[state.round - 1] ?? null;
}

export function unitCost(defId: string, content: Content): number {
  const def = content.unitsById[defId];
  if (!def) throw new Error(`unknown unit ${defId}`);
  return def.cost;
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

/** Draw one unit id from the pool for the given level, or null when the pool is empty. */
export function drawUnit(state: RunState, content: Content, rng: Rng): string | null {
  const eco = content.rules.economy;
  const odds = eco.shopOdds[String(state.level)] ?? eco.shopOdds[String(eco.maxLevel)] ?? [];
  const roll = rng.next() * 100;
  let acc = 0;
  let tier = odds.length - 1;
  for (let i = 0; i < odds.length; i++) {
    acc += odds[i] as number;
    if (roll < acc) {
      tier = i;
      break;
    }
  }
  for (const t of tierOrder(tier, odds.length)) {
    const cost = t + 1;
    let total = 0;
    for (const u of content.units) if (u.cost === cost) total += state.pool[u.id] ?? 0;
    if (total <= 0) continue;
    let pick = rng.int(total);
    for (const u of content.units) {
      if (u.cost !== cost) continue;
      const n = state.pool[u.id] ?? 0;
      if (pick < n) {
        state.pool[u.id] = n - 1;
        return u.id;
      }
      pick -= n;
    }
  }
  return null;
}

export function returnToPool(state: RunState, defId: string, copies: number): void {
  state.pool[defId] = (state.pool[defId] ?? 0) + copies;
}

/** Return unsold shop units to the pool and draw a fresh shop. */
export function refreshShop(state: RunState, content: Content): void {
  for (let i = 0; i < state.shop.length; i++) {
    const id = state.shop[i];
    if (id) returnToPool(state, id, 1);
    state.shop[i] = null;
  }
  withRng(state, 'shop', (rng) => {
    for (let i = 0; i < state.shop.length; i++) state.shop[i] = drawUnit(state, content, rng);
  });
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
 * Merge `mergeCopies` copies of (defId, star) into one unit of star + 1, chaining upward.
 * The kept unit is the lowest-uid copy on the board, else the lowest-uid copy on the bench.
 * Bench copies are consumed before board copies. Returns the number of merges performed.
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
    for (let i = 0; i < eco.mergeCopies - 1; i++) removeUnit(state, (candidates[i] as OwnedUnit).uid);
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

export function computeReward(state: RunState, won: boolean, encounter: Encounter, content: Content): Reward {
  const eco = content.rules.economy;
  const base = eco.baseIncome;
  const interest = interestFor(state.gold, content);
  const winBonus = won ? eco.winBonus : 0;
  const encounterGold = encounter.reward.gold;
  return { gold: base + interest + winBonus + encounterGold, base, interest, winBonus, encounterGold, xp: eco.xpPerRound };
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
  const left: BoardUnit[] = state.board.map((u) => ({ defId: u.defId, star: u.star, col: u.col, row: u.row }));
  const result = fight(left, encounter.board, seed, fightRulesFrom(content));
  const won = result.winner === 'left';
  const lostForHp = result.winner === 'right' || (result.winner === 'draw' && content.rules.combat.drawCountsAsLoss);
  const hpLoss = lostForHp ? hpLossFor(state.round, result.survivors.right.length, content) : 0;
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
  });
  if (state.hp <= 0) {
    endRun(state, 'loss', 'defeat');
  } else if (state.round >= content.encounters.length) {
    // The run is won only by beating the final encounter (BOOT-06); a lost or drawn last
    // fight with hp left is still a defeat.
    endRun(state, won ? 'win' : 'loss', won ? 'victory' : 'defeat');
  } else {
    state.pendingReward = computeReward(state, won, encounter, content);
    state.phase = 'reward';
  }
  return { result, summary };
}

export function endRun(state: RunState, outcome: Outcome, reason: EndReason): void {
  state.phase = 'ended';
  state.outcome = outcome;
  state.endReason = reason;
  state.pendingReward = null;
  state.hashes.push(stateHash(state));
}

export function advanceRound(state: RunState, content: Content): void {
  const reward = state.pendingReward;
  if (reward) {
    state.gold += reward.gold;
    addXp(state, reward.xp, content);
  }
  state.pendingReward = null;
  state.round++;
  state.phase = 'planning';
  refreshShop(state, content);
  state.hashes.push(stateHash(state));
}
