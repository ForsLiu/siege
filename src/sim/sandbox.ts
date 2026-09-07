// Battle sandbox core (P0-17): aggregate repeated fights over a hand-authored setup. Pure
// function of its arguments, like `fight` itself; never touches the player's run state, save
// files or telemetry (CLAUDE.md P0-17). Each sandbox unit gets a synthetic per-instance UnitDef
// so two units sharing a `defId` can carry different stat overrides without colliding.
import { fight, type FightResult } from './fight.ts';
import type { Content, FightRules } from './rules.ts';
import type { StatBlock } from './stats.ts';
import type { BoardUnit, UnitDef } from './units.ts';

export type SandboxSide = 'left' | 'right';

export interface SandboxUnit {
  defId: string;
  star: number;
  col: number;
  row: number;
  /** Item ids, applied through `fight.ts`'s loadout phase like a real run's equipped items
   *  (P0-27); authored directly here, with no combine/cap logic — the sandbox is a raw fight-config
   *  testbed, not a shop simulation. */
  items: string[];
  /** Direct overrides of the unit's base stats at its star, keyed by any name in STAT_NAMES. */
  statOverrides: Partial<StatBlock>;
}

export interface SandboxRuleOverrides {
  maxSeconds?: number;
  /** Reserved for P0-03's overtime mechanic; no engine effect until then (QUESTIONS.md P0-17-01). */
  overtime?: boolean;
}

export interface SandboxSetup {
  left: SandboxUnit[];
  right: SandboxUnit[];
  rules: SandboxRuleOverrides;
}

export interface SandboxUnitAggregate {
  side: SandboxSide;
  /** Index into `setup[side]`, stable identity for units that share a defId. */
  index: number;
  defId: string;
  dealt: number;
  taken: number;
  healed: number;
  deaths: number;
}

export interface SandboxResult {
  fights: number;
  wins: { left: number; right: number; draw: number };
  winRate: { left: number; right: number; draw: number };
  meanTicks: number;
  p95Ticks: number;
  units: SandboxUnitAggregate[];
}

interface SandboxOwner {
  side: SandboxSide;
  index: number;
  defId: string;
}

export interface SandboxFight {
  left: BoardUnit[];
  right: BoardUnit[];
  rules: FightRules;
  owners: Map<string, SandboxOwner>;
}

function instanceId(side: SandboxSide, index: number): string {
  return `sandbox:${side}:${index}`;
}

function buildSide(content: Content, side: SandboxSide, units: readonly SandboxUnit[]): { boardUnits: BoardUnit[]; defs: Record<string, UnitDef>; owners: Map<string, SandboxOwner> } {
  const boardUnits: BoardUnit[] = [];
  const defs: Record<string, UnitDef> = {};
  const owners = new Map<string, SandboxOwner>();
  units.forEach((u, index) => {
    const base = content.unitsById[u.defId];
    if (!base) throw new Error(`sandbox: unknown unit ${u.defId}`);
    const starIdx = u.star - 1;
    if (!base.stats[starIdx]) throw new Error(`sandbox: ${u.defId} has no stats for star ${u.star}`);
    const id = instanceId(side, index);
    const stats = base.stats.map((block, i) => (i === starIdx ? { ...block, ...u.statOverrides } : block));
    defs[id] = { ...base, id, stats };
    boardUnits.push({ defId: id, star: u.star, col: u.col, row: u.row, items: u.items });
    owners.set(id, { side, index, defId: u.defId });
  });
  return { boardUnits, defs, owners };
}

/** Build the pure `fight()` inputs for a setup: two board unit lists, fight rules, and the
 *  instance-id -> (side, index, defId) map needed to attribute ledger entries back to it. */
export function buildSandboxFight(content: Content, setup: SandboxSetup): SandboxFight {
  const l = buildSide(content, 'left', setup.left);
  const r = buildSide(content, 'right', setup.right);
  const combat = setup.rules.maxSeconds === undefined ? content.rules.combat : { ...content.rules.combat, maxSeconds: setup.rules.maxSeconds };
  const rules: FightRules = {
    tickRate: content.rules.tickRate,
    combat,
    board: content.board,
    units: { ...l.defs, ...r.defs },
    projectiles: content.projectilesById,
    traits: content.traitsById,
    items: content.itemsById,
  };
  const owners = new Map([...l.owners, ...r.owners]);
  return { left: l.boardUnits, right: r.boardUnits, rules, owners };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}

/** Run `n` fights of `setup` from `seed`, `seed + 1`, ... `seed + n - 1`, and aggregate them. */
export function runSandbox(content: Content, setup: SandboxSetup, seed: number, n: number): SandboxResult {
  if (!Number.isInteger(n) || n < 1) throw new Error(`runSandbox: n must be a positive integer, got ${n}`);
  const { left, right, rules, owners } = buildSandboxFight(content, setup);
  const perUnit = new Map<string, SandboxUnitAggregate>();
  for (const [id, owner] of owners) perUnit.set(id, { side: owner.side, index: owner.index, defId: owner.defId, dealt: 0, taken: 0, healed: 0, deaths: 0 });
  let leftWins = 0;
  let rightWins = 0;
  let draws = 0;
  const ticks: number[] = [];
  for (let i = 0; i < n; i++) {
    const result: FightResult = fight(left, right, seed + i, rules);
    ticks.push(result.ticks);
    if (result.winner === 'left') leftWins++;
    else if (result.winner === 'right') rightWins++;
    else draws++;
    for (const entry of result.ledger) {
      const agg = perUnit.get(entry.defId);
      if (!agg) continue;
      agg.dealt += entry.dealt;
      agg.taken += entry.taken;
      agg.healed += entry.healed;
      agg.deaths += entry.deaths;
    }
  }
  const sortedTicks = [...ticks].sort((a, b) => a - b);
  const units = [...perUnit.values()].sort((a, b) => (a.side === b.side ? a.index - b.index : a.side === 'left' ? -1 : 1));
  return {
    fights: n,
    wins: { left: leftWins, right: rightWins, draw: draws },
    winRate: { left: leftWins / n, right: rightWins / n, draw: draws / n },
    meanTicks: mean(ticks),
    p95Ticks: percentile(sortedTicks, 95),
    units,
  };
}
