// Every player action is a Command. validateCommand returns a rejection reason or null;
// applyCommand validates first and mutates the state only when the command is legal.
import type { FightResult } from './fight.ts';
import { isPlayerCell, type Cell } from './hex.ts';
import type { Content } from './rules.ts';
import {
  advanceRound,
  boardUnitAt,
  countCopies,
  endRun,
  equipItem,
  findUnit,
  freeBenchSlot,
  insertBoardUnit,
  removeUnit,
  resolveCombat,
  returnToPool,
  sellValue,
  tryMerge,
  unitCost,
  xpNeeded,
  type RunState,
} from './run.ts';
import { refreshShop, copiesForStar, addXp, poolCapacity } from './run.ts';
import { applyDevCommand, isDevCommand, validateDevCommand, type DevCommand, type DevCommandType } from './devCommands.ts';
import { canAddItem } from './items.ts';
import type { OwnedUnit, PlacedUnit } from './units.ts';

export type { DevCommand, DevCommandType };

export type PlayerCommand =
  | { type: 'buy'; slot: number }
  | { type: 'sell'; uid: number }
  | { type: 'place'; uid: number; col: number; row: number }
  | { type: 'bench'; uid: number }
  | { type: 'swap'; uidA: number; uidB: number }
  | { type: 'reroll' }
  | { type: 'levelUp' }
  | { type: 'pickAugment'; augmentId: string }
  | { type: 'equipItem'; uid: number; benchIndex: number }
  | { type: 'pickLoot'; itemId: string }
  | { type: 'startCombat' }
  | { type: 'nextRound' }
  | { type: 'abandon' };

/** Player commands plus the dev cheats; `dev:` commands need RunConfig.devCommands. */
export type Command = PlayerCommand | DevCommand;

export type PlayerCommandType = PlayerCommand['type'];
export type CommandType = Command['type'];
export const COMMAND_TYPES: readonly PlayerCommandType[] = ['buy', 'sell', 'place', 'bench', 'swap', 'reroll', 'levelUp', 'pickAugment', 'equipItem', 'pickLoot', 'startCombat', 'nextRound', 'abandon'];

export type CommandResult = { ok: true; state: RunState; fight: FightResult | null } | { ok: false; reason: string };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Returns a human-readable rejection reason, or null when the command is legal. */
export function validateCommand(state: RunState, cmd: Command, content: Content): string | null {
  if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return 'malformed command';
  if (isDevCommand(cmd)) {
    // The dev gate comes before the phase checks so the reason is the same in every phase.
    if (!state.config.devCommands) return `dev commands are disabled in this run (${cmd.type})`;
    if (state.phase === 'ended') return 'run has ended';
    if (state.phase !== 'planning') return `${cmd.type} requires the planning phase (phase is ${state.phase})`;
    return validateDevCommand(state, cmd, content);
  }
  if (!(COMMAND_TYPES as readonly string[]).includes(cmd.type)) return `unknown command type ${String(cmd.type)}`;
  const eco = content.rules.economy;
  if (state.phase === 'ended') return 'run has ended';
  if (cmd.type === 'abandon') return null;
  if (cmd.type === 'nextRound') return state.phase === 'reward' ? null : `nextRound requires the reward phase (phase is ${state.phase})`;
  if (cmd.type === 'pickLoot') {
    if (state.phase !== 'reward') return `pickLoot requires the reward phase (phase is ${state.phase})`;
    if (!Object.hasOwn(content.itemsById, cmd.itemId)) return `unknown item id ${String(cmd.itemId)}`;
    if (state.lootOffer === null) return 'no loot offer is pending';
    if (!state.lootOffer.includes(cmd.itemId)) return `${cmd.itemId} is not in the current offer`;
    return null;
  }
  if (state.phase !== 'planning') return `${cmd.type} requires the planning phase (phase is ${state.phase})`;

  switch (cmd.type) {
    case 'buy': {
      if (!isInt(cmd.slot) || cmd.slot < 0 || cmd.slot >= state.shop.length) return 'invalid shop slot';
      const defId = state.shop[cmd.slot];
      if (!defId) return 'shop slot is empty';
      const cost = unitCost(defId, content);
      if (state.gold < cost) return `not enough gold (need ${cost}, have ${state.gold})`;
      if (freeBenchSlot(state) === -1) {
        const wouldMerge = eco.maxStar > 1 && countCopies(state, defId, 1) >= eco.mergeCopies - 1;
        if (!wouldMerge) return 'bench is full';
      }
      return null;
    }
    case 'sell': {
      if (!isInt(cmd.uid)) return 'invalid uid';
      if (!findUnit(state, cmd.uid)) return `no unit with uid ${cmd.uid}`;
      return null;
    }
    case 'place': {
      if (!isInt(cmd.uid)) return 'invalid uid';
      if (!isInt(cmd.col) || !isInt(cmd.row)) return 'invalid cell';
      const found = findUnit(state, cmd.uid);
      if (!found) return `no unit with uid ${cmd.uid}`;
      const cell: Cell = { col: cmd.col, row: cmd.row };
      if (!isPlayerCell(cell, content.board)) return 'cell is outside the player half';
      const occupant = boardUnitAt(state, cmd.col, cmd.row);
      if (occupant && occupant.uid === cmd.uid) return 'unit is already at that cell';
      if (occupant) return 'cell is occupied (use swap)';
      if (found.where === 'bench' && state.board.length >= state.level) return `team is full (level ${state.level})`;
      return null;
    }
    case 'bench': {
      if (!isInt(cmd.uid)) return 'invalid uid';
      const found = findUnit(state, cmd.uid);
      if (!found) return `no unit with uid ${cmd.uid}`;
      if (found.where !== 'board') return 'unit is not on the board';
      if (freeBenchSlot(state) === -1) return 'bench is full';
      return null;
    }
    case 'swap': {
      if (!isInt(cmd.uidA) || !isInt(cmd.uidB)) return 'invalid uid';
      if (cmd.uidA === cmd.uidB) return 'cannot swap a unit with itself';
      if (!findUnit(state, cmd.uidA)) return `no unit with uid ${cmd.uidA}`;
      if (!findUnit(state, cmd.uidB)) return `no unit with uid ${cmd.uidB}`;
      return null;
    }
    case 'reroll':
      if (state.gold < eco.rerollCost) return `not enough gold (need ${eco.rerollCost}, have ${state.gold})`;
      return null;
    case 'levelUp':
      if (state.level >= eco.maxLevel) return 'already at max level';
      if (state.gold < eco.xpCost) return `not enough gold (need ${eco.xpCost}, have ${state.gold})`;
      return null;
    case 'pickAugment': {
      if (!Object.hasOwn(content.augmentsById, cmd.augmentId)) return `unknown augment id ${String(cmd.augmentId)}`;
      if (state.augmentOffer === null) return 'no augment offer is pending';
      if (!state.augmentOffer.includes(cmd.augmentId)) return `${cmd.augmentId} is not in the current offer`;
      return null;
    }
    case 'equipItem': {
      if (!isInt(cmd.uid)) return 'invalid uid';
      if (!isInt(cmd.benchIndex) || cmd.benchIndex < 0 || cmd.benchIndex >= state.itemBench.length) return 'invalid item bench index';
      const found = findUnit(state, cmd.uid);
      if (!found) return `no unit with uid ${cmd.uid}`;
      const itemId = state.itemBench[cmd.benchIndex] as string;
      return canAddItem(found.unit.items, itemId, content.itemsById, content.recipesByKey, eco.itemSlots);
    }
    case 'startCombat':
      return null;
    default: {
      const never: never = cmd;
      return `unknown command ${JSON.stringify(never)}`;
    }
  }
}

/** Validate, then apply in place. On rejection the state is untouched. */
export function applyCommand(state: RunState, cmd: Command, content: Content): CommandResult {
  const reason = validateCommand(state, cmd, content);
  if (reason !== null) return { ok: false, reason };
  state.commandCount++;
  const eco = content.rules.economy;
  if (isDevCommand(cmd)) {
    applyDevCommand(state, cmd, content);
    return { ok: true, state, fight: null };
  }
  switch (cmd.type) {
    case 'buy': {
      const defId = state.shop[cmd.slot] as string;
      state.gold -= unitCost(defId, content);
      state.shop[cmd.slot] = null;
      const unit: OwnedUnit = { uid: state.nextUid++, defId, star: 1, items: [] };
      const slot = freeBenchSlot(state);
      if (slot !== -1) {
        state.bench[slot] = unit;
        tryMerge(state, defId, 1, content);
      } else {
        // Bench full but a merge is guaranteed: park the copy in an overflow slot, merge, trim.
        state.bench.push(unit);
        tryMerge(state, defId, 1, content);
        const overflow = state.bench.pop();
        if (overflow !== null) throw new Error('buy: merge did not free the overflow slot');
      }
      return { ok: true, state, fight: null };
    }
    case 'sell': {
      const unit = removeUnit(state, cmd.uid) as OwnedUnit;
      state.gold += sellValue(unit, content);
      returnToPool(state, unit.defId, copiesForStar(unit.star, content), content);
      state.itemBench.push(...unit.items);
      return { ok: true, state, fight: null };
    }
    case 'place': {
      const found = findUnit(state, cmd.uid);
      if (!found) throw new Error('place: unit vanished');
      if (found.where === 'board') {
        (found.unit as PlacedUnit).col = cmd.col;
        (found.unit as PlacedUnit).row = cmd.row;
      } else {
        state.bench[found.index] = null;
        insertBoardUnit(state, { ...found.unit, col: cmd.col, row: cmd.row });
      }
      return { ok: true, state, fight: null };
    }
    case 'bench': {
      const found = findUnit(state, cmd.uid);
      if (!found || found.where !== 'board') throw new Error('bench: unit vanished');
      const placed = found.unit as PlacedUnit;
      state.board.splice(found.index, 1);
      const { col: _c, row: _r, ...owned } = placed;
      state.bench[freeBenchSlot(state)] = owned;
      return { ok: true, state, fight: null };
    }
    case 'swap': {
      const a = findUnit(state, cmd.uidA);
      const b = findUnit(state, cmd.uidB);
      if (!a || !b) throw new Error('swap: unit vanished');
      if (a.where === 'board' && b.where === 'board') {
        const pa = a.unit as PlacedUnit;
        const pb = b.unit as PlacedUnit;
        const c = pa.col;
        const r = pa.row;
        pa.col = pb.col;
        pa.row = pb.row;
        pb.col = c;
        pb.row = r;
      } else if (a.where === 'bench' && b.where === 'bench') {
        state.bench[a.index] = b.unit;
        state.bench[b.index] = a.unit;
      } else {
        const boardSide = a.where === 'board' ? a : b;
        const benchSide = a.where === 'bench' ? a : b;
        const placed = boardSide.unit as PlacedUnit;
        const { col, row, ...owned } = placed;
        state.board.splice(boardSide.index, 1);
        state.bench[benchSide.index] = owned;
        insertBoardUnit(state, { ...benchSide.unit, col, row });
      }
      return { ok: true, state, fight: null };
    }
    case 'reroll': {
      state.gold -= eco.rerollCost;
      refreshShop(state, content);
      return { ok: true, state, fight: null };
    }
    case 'levelUp': {
      state.gold -= eco.xpCost;
      addXp(state, eco.xpPerBuy, content);
      return { ok: true, state, fight: null };
    }
    case 'pickAugment': {
      state.augments.push(cmd.augmentId);
      state.augmentOffer = null;
      return { ok: true, state, fight: null };
    }
    case 'equipItem': {
      const found = findUnit(state, cmd.uid);
      if (!found) throw new Error('equipItem: unit vanished');
      const itemId = state.itemBench.splice(cmd.benchIndex, 1)[0] as string;
      equipItem(found.unit, itemId, content);
      return { ok: true, state, fight: null };
    }
    case 'pickLoot': {
      state.itemBench.push(cmd.itemId);
      state.lootOffer = null;
      return { ok: true, state, fight: null };
    }
    case 'startCombat': {
      state.phase = 'combat';
      const { result } = resolveCombat(state, content);
      return { ok: true, state, fight: result };
    }
    case 'nextRound': {
      advanceRound(state, content);
      return { ok: true, state, fight: null };
    }
    case 'abandon': {
      endRun(state, 'loss', 'abandon');
      return { ok: true, state, fight: null };
    }
    default: {
      const never: never = cmd;
      throw new Error(`applyCommand: unknown command ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Concrete commands a bot may issue now (excludes `abandon`). Every listed command passes
 * validateCommand. Order is deterministic.
 */
export function legalCommands(state: RunState, content: Content): PlayerCommand[] {
  // Bots never cheat: `dev:` commands are deliberately absent from this list.
  const out: PlayerCommand[] = [];
  if (state.phase === 'ended') return out;
  if (state.phase === 'reward') {
    if (state.lootOffer) for (const itemId of state.lootOffer) out.push({ type: 'pickLoot', itemId });
    out.push({ type: 'nextRound' });
    return out;
  }
  if (state.phase !== 'planning') return out;
  const eco = content.rules.economy;
  const board = content.board;

  for (let slot = 0; slot < state.shop.length; slot++) {
    const cmd: PlayerCommand = { type: 'buy', slot };
    if (validateCommand(state, cmd, content) === null) out.push(cmd);
  }
  const units: OwnedUnit[] = [...state.board];
  for (const u of state.bench) if (u) units.push(u);
  for (const u of units) out.push({ type: 'sell', uid: u.uid });

  const freeCells: Cell[] = [];
  for (let row = board.rows - board.playerRows; row < board.rows; row++) {
    for (let col = 0; col < board.cols; col++) {
      if (!boardUnitAt(state, col, row)) freeCells.push({ col, row });
    }
  }
  for (const u of state.board) for (const c of freeCells) out.push({ type: 'place', uid: u.uid, col: c.col, row: c.row });
  if (state.board.length < state.level) {
    for (const u of state.bench) {
      if (!u) continue;
      for (const c of freeCells) out.push({ type: 'place', uid: u.uid, col: c.col, row: c.row });
    }
  }
  if (freeBenchSlot(state) !== -1) for (const u of state.board) out.push({ type: 'bench', uid: u.uid });
  for (const b of state.bench) {
    if (!b) continue;
    for (const u of state.board) out.push({ type: 'swap', uidA: b.uid, uidB: u.uid });
  }
  if (state.gold >= eco.rerollCost) out.push({ type: 'reroll' });
  if (state.level < eco.maxLevel && state.gold >= eco.xpCost) out.push({ type: 'levelUp' });
  if (state.augmentOffer) for (const augmentId of state.augmentOffer) out.push({ type: 'pickAugment', augmentId });
  for (let benchIndex = 0; benchIndex < state.itemBench.length; benchIndex++) {
    for (const u of units) {
      const cmd: PlayerCommand = { type: 'equipItem', uid: u.uid, benchIndex };
      if (validateCommand(state, cmd, content) === null) out.push(cmd);
    }
  }
  out.push({ type: 'startCombat' });
  return out;
}

/** Sanity checks used by fuzz/soak tests and the dev overlay. Returns a list of violations. */
export function checkInvariants(state: RunState, content: Content): string[] {
  const problems: string[] = [];
  const eco = content.rules.economy;
  if (!(state.gold >= 0) || !Number.isFinite(state.gold)) problems.push(`gold ${state.gold}`);
  if (!(state.hp >= 0) || !Number.isFinite(state.hp)) problems.push(`hp ${state.hp}`);
  if (state.level < 1 || state.level > eco.maxLevel) problems.push(`level ${state.level}`);
  if (state.board.length > state.level) problems.push(`board ${state.board.length} > level ${state.level}`);
  if (state.bench.length !== eco.benchSlots) problems.push(`bench length ${state.bench.length}`);
  if (state.shop.length !== eco.shopSlots) problems.push(`shop length ${state.shop.length}`);
  const uids = new Set<number>();
  const cells = new Set<string>();
  for (const u of state.board) {
    if (uids.has(u.uid)) problems.push(`duplicate uid ${u.uid}`);
    uids.add(u.uid);
    if (!isPlayerCell(u, content.board)) problems.push(`unit ${u.uid} off the player half at ${u.col},${u.row}`);
    const k = `${u.col},${u.row}`;
    if (cells.has(k)) problems.push(`two units at ${k}`);
    cells.add(k);
    if (u.star < 1 || u.star > eco.maxStar) problems.push(`unit ${u.uid} star ${u.star}`);
    if (u.items.length > eco.itemSlots) problems.push(`unit ${u.uid} holds ${u.items.length} items > cap ${eco.itemSlots}`);
  }
  for (const u of state.bench) {
    if (!u) continue;
    if (uids.has(u.uid)) problems.push(`duplicate uid ${u.uid}`);
    uids.add(u.uid);
    if (u.star < 1 || u.star > eco.maxStar) problems.push(`unit ${u.uid} star ${u.star}`);
    if (u.items.length > eco.itemSlots) problems.push(`unit ${u.uid} holds ${u.items.length} items > cap ${eco.itemSlots}`);
  }
  for (let i = 1; i < state.board.length; i++) {
    if ((state.board[i] as PlacedUnit).uid < (state.board[i - 1] as PlacedUnit).uid) problems.push('board not sorted by uid');
  }
  for (const [id, n] of Object.entries(state.pool)) {
    if (n < 0 || !Number.isFinite(n)) problems.push(`pool ${id} = ${n}`);
    else if (n > poolCapacity(id, content)) problems.push(`pool ${id} = ${n} > capacity ${poolCapacity(id, content)}`);
  }
  if (!Number.isSafeInteger(state.gold)) problems.push(`gold ${state.gold} is not a safe integer`);
  if (state.phase === 'ended' && state.outcome === null) problems.push('ended without outcome');
  return problems;
}

export { xpNeeded };
