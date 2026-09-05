// Unit definitions (from data) and the unit shapes shared by run state and fights.
import type { AuraDef, Effect, Hooks } from './effects.ts';
import type { Modifier, StatBlock, StatName } from './stats.ts';
import { computeStat, STAT_NAMES } from './stats.ts';

export type AttackType = 'melee' | 'ranged';

export interface UnitAbility {
  name: string;
  effects: Effect[];
}

export interface UnitDef {
  id: string;
  name: string;
  /** Shop cost; also the pool tier. */
  cost: number;
  attackType: AttackType;
  tags: string[];
  /** Base stats per star level: index 0 = 1 star. Length = rules.economy.maxStar. */
  stats: StatBlock[];
  ability: UnitAbility | null;
  hooks: Hooks;
  /** Continuous passive applied to units within range each tick; null = none. */
  aura: AuraDef | null;
  // Extension points reserved for SPEC content (traits, items, augments) are added to
  // the schema and here together when SPEC.md defines them.
}

/** A unit placed on a board, as authored in data (owner-half coordinates). */
export interface BoardUnit {
  defId: string;
  star: number;
  col: number;
  row: number;
}

/** A unit owned by the player during a run. */
export interface OwnedUnit {
  uid: number;
  defId: string;
  star: number;
  /** Item ids (placeholder until SPEC defines items). */
  items: string[];
}

export interface PlacedUnit extends OwnedUnit {
  col: number;
  row: number;
}

export function baseStats(def: UnitDef, star: number): StatBlock {
  const block = def.stats[star - 1];
  if (!block) throw new Error(`unit ${def.id} has no stats for star ${star}`);
  return { ...block };
}

/** Anything with a base block and a modifier list (fight units). */
export interface StatCarrier {
  base: StatBlock;
  modifiers: Modifier[];
  /** Lazily filled cache; cleared whenever `modifiers` changes. */
  statCache: Partial<StatBlock> | null;
}

export function getStat(u: StatCarrier, stat: StatName): number {
  if (u.statCache === null) u.statCache = {};
  const cached = u.statCache[stat];
  if (cached !== undefined) return cached;
  const v = computeStat(u.base[stat], stat, u.modifiers);
  u.statCache[stat] = v;
  return v;
}

export function invalidateStats(u: StatCarrier): void {
  u.statCache = null;
}

export function allStats(u: StatCarrier): StatBlock {
  const out = {} as StatBlock;
  for (const s of STAT_NAMES) out[s] = getStat(u, s);
  return out;
}
