// Pointer resolution for the board, as pure functions: what a click does and what a completed
// drag does. src/app/main.ts only feeds in the cell under the cursor (P0-09).
import type { Command } from '../sim/commands.ts';
import type { Cell } from '../sim/hex.ts';
import type { Content } from '../sim/rules.ts';
import { boardUnitAt, type RunState } from '../sim/run.ts';
import { dropOutcome } from './drag.ts';

export interface PointerOutcome {
  /** The command to dispatch, or null. */
  command: Command | null;
  /** The selection after the action: a uid, null to clear, or 'keep' to leave it alone. */
  select: number | null | 'keep';
  /** Feedback to show when nothing could be done, or null. */
  reason: string | null;
}

/**
 * Click-to-play on the board (unchanged from the pre-drag behaviour): the first click on a unit
 * selects it, clicking it again benches it, clicking another unit swaps, clicking an empty cell
 * places the selection.
 */
export function boardClick(state: RunState, selectedUid: number | null, cell: Cell | null, content: Content): PointerOutcome {
  if (state.phase !== 'planning') return { command: null, select: 'keep', reason: null };
  if (!cell) return { command: null, select: 'keep', reason: null };
  const occupant = boardUnitAt(state, cell.col, cell.row);
  if (occupant) {
    if (selectedUid === occupant.uid) return { command: { type: 'bench', uid: occupant.uid }, select: null, reason: null };
    if (selectedUid !== null) return { command: { type: 'swap', uidA: selectedUid, uidB: occupant.uid }, select: null, reason: null };
    return { command: null, select: occupant.uid, reason: null };
  }
  if (selectedUid === null) return { command: null, select: 'keep', reason: null };
  const drop = dropOutcome(state, selectedUid, cell, content);
  if (drop.command) return { command: drop.command, select: null, reason: null };
  return { command: null, select: 'keep', reason: drop.reason };
}

/** A drag released over `cell`. A drop back onto the unit's own cell is a no-op. */
export function boardDrop(state: RunState, uid: number, cell: Cell | null, content: Content): PointerOutcome {
  const drop = dropOutcome(state, uid, cell, content);
  if (drop.command) return { command: drop.command, select: null, reason: null };
  return { command: null, select: drop.valid ? null : 'keep', reason: drop.reason };
}
