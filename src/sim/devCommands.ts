// Dev cheats as sim Commands (owner feedback 2026-09-05-01-dev-modes.md §A).
// They live in the `dev:` namespace, are recorded in the command log like any other command,
// and are accepted only when RunConfig.devCommands is true (dev builds set it; production
// builds leave it false, so every dev: command is rejected with a reason). Keeping them in
// the log is what makes a cheated run replay hash for hash.
import type { Content } from './rules.ts';
import {
  addXp,
  boardUnitAt,
  copiesForStar,
  currentEncounter,
  freeBenchSlot,
  insertBoardUnit,
  refreshShop,
  shopTierCount,
  skipRoundAsWin,
  takeFromPool,
  tryMerge,
  type RunState,
} from './run.ts';
import { isPlayerCell, type Cell } from './hex.ts';
import type { OwnedUnit } from './units.ts';

/** Where `dev:spawnUnit` puts the unit: a player-half cell, or null for the bench. */
export type SpawnTarget = Cell | null;

export type DevCommand =
  | { type: 'dev:gold'; amount: number }
  | { type: 'dev:xp'; amount: number }
  | { type: 'dev:invinciblePieces'; on: boolean }
  | { type: 'dev:invinciblePlayer'; on: boolean }
  | { type: 'dev:skipRound' }
  | { type: 'dev:addAugment'; augmentId: string }
  | { type: 'dev:openShop'; tier: number }
  | { type: 'dev:spawnUnit'; defId: string; star: number; cell: SpawnTarget }
  | { type: 'dev:giveItem'; itemId: string };

export type DevCommandType = DevCommand['type'];

export const DEV_COMMAND_TYPES: readonly DevCommandType[] = [
  'dev:gold',
  'dev:xp',
  'dev:invinciblePieces',
  'dev:invinciblePlayer',
  'dev:skipRound',
  'dev:addAugment',
  'dev:openShop',
  'dev:spawnUnit',
  'dev:giveItem',
];

export function isDevCommandType(type: string): type is DevCommandType {
  return (DEV_COMMAND_TYPES as readonly string[]).includes(type);
}

/** Narrows a command union to the `dev:` namespace. */
export function isDevCommand<T extends { type: string }>(cmd: T): cmd is T & DevCommand {
  return isDevCommandType(cmd.type);
}

/**
 * `dev:spawnUnit`'s `defId` pre-filter before its real `unitsById` lookup. An input bound, not a
 * tuning number.
 */
const MAX_ID_LENGTH = 64;

/**
 * Upper bound for cheated gold. An input bound, not a tuning number: it leaves several orders
 * of magnitude of headroom below `Number.MAX_SAFE_INTEGER`, so no amount of ordinary round
 * income can push gold out of the range the state hash can serialise.
 */
const MAX_DEV_GOLD = 2 ** 40;

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
}

/** Rejection reason, or null when the dev command is legal. Assumes the dev flag is already checked. */
export function validateDevCommand(state: RunState, cmd: DevCommand, content: Content): string | null {
  const eco = content.rules.economy;
  switch (cmd.type) {
    case 'dev:gold': {
      // Safe-integer bounds both ways: a cheat must never push gold out of the range the
      // state hash can serialise (an Infinity there makes every later hash throw).
      if (!isInt(cmd.amount) || !Number.isSafeInteger(cmd.amount)) return 'invalid gold amount';
      const next = state.gold + cmd.amount;
      if (next < 0) return `gold cannot go below 0 (have ${state.gold})`;
      if (next > MAX_DEV_GOLD) return `gold would exceed the dev cap of ${MAX_DEV_GOLD} (have ${state.gold})`;
      return null;
    }
    case 'dev:xp':
      if (!isInt(cmd.amount) || !Number.isSafeInteger(cmd.amount) || cmd.amount <= 0) return 'xp amount must be a positive integer';
      if (!Number.isSafeInteger(state.xp + cmd.amount)) return `xp would leave the safe integer range (have ${state.xp})`;
      return null;
    case 'dev:invinciblePieces':
    case 'dev:invinciblePlayer':
      if (typeof cmd.on !== 'boolean') return 'invincibility toggle needs a boolean';
      return null;
    case 'dev:skipRound':
      if (!currentEncounter(state, content)) return `no encounter for round ${state.round}`;
      return null;
    case 'dev:addAugment':
      if (!Object.hasOwn(content.augmentsById, cmd.augmentId)) return `unknown augment id ${String(cmd.augmentId)}`;
      return null;
    case 'dev:openShop': {
      const tiers = shopTierCount(content);
      if (!isInt(cmd.tier) || cmd.tier < 1 || cmd.tier > tiers) return `tier must be an integer in 1..${tiers}`;
      return null;
    }
    case 'dev:spawnUnit': {
      // Own-property check: `unitsById['constructor']` inherits a truthy value from the prototype,
      // which would let a hostile id through and put NaN into the pool.
      if (!isId(cmd.defId) || !Object.hasOwn(content.unitsById, cmd.defId)) return `unknown unit ${String(cmd.defId)}`;
      if (!isInt(cmd.star) || cmd.star < 1 || cmd.star > eco.maxStar) return `star must be an integer in 1..${eco.maxStar}`;
      if (cmd.cell === null) {
        if (freeBenchSlot(state) === -1) return 'bench is full';
        return null;
      }
      if (typeof cmd.cell !== 'object' || !isInt(cmd.cell.col) || !isInt(cmd.cell.row)) return 'invalid cell';
      if (!isPlayerCell(cmd.cell, content.board)) return 'cell is outside the player half';
      if (boardUnitAt(state, cmd.cell.col, cmd.cell.row)) return 'cell is occupied';
      if (state.board.length >= state.level) return `team is full (level ${state.level})`;
      return null;
    }
    case 'dev:giveItem':
      if (!Object.hasOwn(content.itemsById, cmd.itemId)) return `unknown item id ${String(cmd.itemId)}`;
      return null;
    default: {
      const never: never = cmd;
      return `unknown dev command ${JSON.stringify(never)}`;
    }
  }
}

/** Apply a dev command that `validateDevCommand` has already accepted. */
export function applyDevCommand(state: RunState, cmd: DevCommand, content: Content): void {
  switch (cmd.type) {
    case 'dev:gold':
      state.gold += cmd.amount;
      return;
    case 'dev:xp':
      addXp(state, cmd.amount, content);
      return;
    case 'dev:invinciblePieces':
      state.dev.invinciblePieces = cmd.on;
      return;
    case 'dev:invinciblePlayer':
      state.dev.invinciblePlayer = cmd.on;
      return;
    case 'dev:skipRound':
      skipRoundAsWin(state, content);
      return;
    case 'dev:addAugment':
      state.augments.push(cmd.augmentId);
      return;
    case 'dev:openShop':
      refreshShop(state, content, cmd.tier);
      return;
    case 'dev:spawnUnit': {
      // Spawned copies leave the pool when copies remain, so the pool cannot go negative and
      // a cheat never hands the same physical copy out twice (QUESTIONS.md P0-15-04).
      takeFromPool(state, cmd.defId, copiesForStar(cmd.star, content));
      const unit: OwnedUnit = { uid: state.nextUid++, defId: cmd.defId, star: cmd.star, items: [] };
      if (cmd.cell === null) state.bench[freeBenchSlot(state)] = unit;
      else insertBoardUnit(state, { ...unit, col: cmd.cell.col, row: cmd.cell.row });
      tryMerge(state, cmd.defId, cmd.star, content);
      return;
    }
    case 'dev:giveItem':
      state.itemBench.push(cmd.itemId);
      return;
    default: {
      const never: never = cmd;
      throw new Error(`applyDevCommand: unknown dev command ${JSON.stringify(never)}`);
    }
  }
}
