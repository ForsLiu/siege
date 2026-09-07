// Rule/content shapes the sim consumes. Values come from /data (validated by src/data).
import type { Effect, ProjectileDef } from './effects.ts';
import type { BoardConfig } from './hex.ts';
import type { BoardUnit, UnitDef } from './units.ts';

export interface CombatRules {
  maxSeconds: number;
  moveSecondsPerHex: number;
  manaOnAttack: number;
  manaOnHitTaken: number;
  /** Physical/magic mitigation: dmg * K / (K + resist). */
  mitigationConstant: number;
  minAttackSpeed: number;
  maxAttackSpeed: number;
  /** A timeout draw costs the player hp as if it were a loss. */
  drawCountsAsLoss: boolean;
  /** Cut-off for nested hook firings (onTakeDamage -> damage -> onTakeDamage). */
  maxHookDepth: number;
}

export interface EconomyRules {
  startGold: number;
  startHp: number;
  startLevel: number;
  startXp: number;
  shopSlots: number;
  benchSlots: number;
  rerollCost: number;
  xpCost: number;
  xpPerBuy: number;
  xpPerRound: number;
  maxLevel: number;
  /** xpToLevel[level] = xp needed to advance from `level` to `level + 1`. */
  xpToLevel: number[];
  baseIncome: number;
  winBonus: number;
  interest: { per: number; max: number };
  /** Fraction of (cost x copies) refunded on sell. */
  sellRefund: number;
  maxStar: number;
  mergeCopies: number;
  /** Copies of each unit in the shared pool, by cost tier (string keys, JSON). */
  poolSize: Record<string, number>;
  /** shopOdds[level] = percentages per cost tier (index 0 = cost 1); sums to 100. */
  shopOdds: Record<string, number[]>;
}

export interface HpLossRules {
  /** Indexed by round - 1; the last value repeats. */
  byRound: number[];
  perSurvivingUnit: number;
}

export interface AugmentRules {
  /** How many distinct options are offered on an `augment`-type round (or fewer if the
   *  augment pool is smaller). */
  offerCount: number;
}

export interface Rules {
  version: number;
  tickRate: number;
  combat: CombatRules;
  economy: EconomyRules;
  hpLoss: HpLossRules;
  augment: AugmentRules;
}

/** An augment row (P0-24): a one-time pick offered on an `augment`-type round, whose
 *  `effects` (authored `target: 'self'`, applied to every unit on the picking side) run once
 *  at the start of every combat for the rest of the run — see `FightRules.startEffects`. */
export interface AugmentDef {
  id: string;
  name: string;
  description: string;
  effects: Effect[];
}

/** The round-track icon category (P0-22); a display label today, not yet a distinct mechanic. */
export const ENCOUNTER_TYPES = ['normal', 'elite', 'boss', 'treasure', 'augment'] as const;
export type EncounterType = (typeof ENCOUNTER_TYPES)[number];

export interface Encounter {
  id: string;
  round: number;
  type: EncounterType;
  reward: { gold: number };
  board: BoardUnit[];
}

/** Everything a fight needs besides the two boards and the seed. */
export interface FightRules {
  tickRate: number;
  combat: CombatRules;
  board: BoardConfig;
  units: Record<string, UnitDef>;
  projectiles: Record<string, ProjectileDef>;
  /**
   * Dev cheat (`dev:invinciblePieces`): damage cannot take a side's units below 1 hp.
   * Absent in production runs; it is an argument like any other, so fights stay pure and
   * a run that used it still replays hash for hash.
   */
  invincible?: { left: boolean; right: boolean };
  /**
   * Picked augments' effects (P0-24): run once per unit, before `onRoundStart`, authored with
   * `target: 'self'` so each unit buffs only itself (and any `scaling` resolves against that
   * unit's own stats). Absent/empty is the common case (no augment picked yet) and changes
   * nothing about the fight.
   */
  startEffects?: { left: Effect[]; right: Effect[] };
}

/** Everything a run needs. Built by src/data from the JSON files. */
export interface Content {
  board: BoardConfig;
  rules: Rules;
  units: UnitDef[];
  unitsById: Record<string, UnitDef>;
  projectiles: ProjectileDef[];
  projectilesById: Record<string, ProjectileDef>;
  encounters: Encounter[];
  augments: AugmentDef[];
  augmentsById: Record<string, AugmentDef>;
  /** sha-256 of the canonical concatenation of every content file. */
  contentHash: string;
}

export function fightRulesFrom(content: Content): FightRules {
  return {
    tickRate: content.rules.tickRate,
    combat: content.rules.combat,
    board: content.board,
    units: content.unitsById,
    projectiles: content.projectilesById,
  };
}
