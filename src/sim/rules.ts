// Rule/content shapes the sim consumes. Values come from /data (validated by src/data).
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

export interface Rules {
  version: number;
  tickRate: number;
  combat: CombatRules;
  economy: EconomyRules;
  hpLoss: HpLossRules;
}

export interface Encounter {
  id: string;
  round: number;
  reward: { gold: number };
  board: BoardUnit[];
}

/** Everything a fight needs besides the two boards and the seed. */
export interface FightRules {
  tickRate: number;
  combat: CombatRules;
  board: BoardConfig;
  units: Record<string, UnitDef>;
}

/** Everything a run needs. Built by src/data from the JSON files. */
export interface Content {
  board: BoardConfig;
  rules: Rules;
  units: UnitDef[];
  unitsById: Record<string, UnitDef>;
  encounters: Encounter[];
  /** sha-256 of the canonical concatenation of every content file. */
  contentHash: string;
}

export function fightRulesFrom(content: Content): FightRules {
  return {
    tickRate: content.rules.tickRate,
    combat: content.rules.combat,
    board: content.board,
    units: content.unitsById,
  };
}
