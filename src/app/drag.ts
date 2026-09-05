// Drag-and-drop placement, decided as pure functions over run state: which Command a drop
// produces and why an illegal drop is illegal. The DOM side (src/app/main.ts) only supplies
// the dragged uid and the cell under the cursor.
import { validateCommand, type Command } from '../sim/commands.ts';
import { isPlayerCell, type Cell } from '../sim/hex.ts';
import type { Content } from '../sim/rules.ts';
import { boardUnitAt, findUnit, type RunState } from '../sim/run.ts';

export interface DropOutcome {
  /** The command the drop would issue, or null when it is a no-op or illegal. */
  command: Command | null;
  /** Why the drop is illegal (shown as invalid-drop feedback), or null. */
  reason: string | null;
  /** True when the drop would be accepted by the sim; drives the drop highlight. */
  valid: boolean;
}

/**
 * What dropping unit `uid` on `cell` does: place onto an empty cell, swap with an occupant,
 * nothing when dropped back onto itself. `cell` is null when the cursor is off the grid.
 */
export function dropOutcome(state: RunState, uid: number, cell: Cell | null, content: Content): DropOutcome {
  const found = findUnit(state, uid);
  if (!found) return { command: null, reason: `no unit with uid ${uid}`, valid: false };
  if (state.phase !== 'planning') return { command: null, reason: `dragging requires the planning phase (phase is ${state.phase})`, valid: false };
  if (!cell) return { command: null, reason: 'drop a unit on your half of the board', valid: false };
  if (!isPlayerCell(cell, content.board)) return { command: null, reason: 'cell is outside the player half', valid: false };
  const occupant = boardUnitAt(state, cell.col, cell.row);
  if (occupant && occupant.uid === uid) return { command: null, reason: null, valid: true };
  const command: Command = occupant ? { type: 'swap', uidA: uid, uidB: occupant.uid } : { type: 'place', uid, col: cell.col, row: cell.row };
  const reason = validateCommand(state, command, content);
  return reason === null ? { command, reason: null, valid: true } : { command: null, reason, valid: false };
}

/** True when a unit can be picked up at all (there is such a unit and the phase allows it). */
export function canDrag(state: RunState, uid: number): boolean {
  return state.phase === 'planning' && findUnit(state, uid) !== null;
}
