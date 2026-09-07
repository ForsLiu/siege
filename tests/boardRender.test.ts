// P0-20: board-readability shading. cellHalf is the renderer's single source of truth for
// which half a cell is shaded as; this proves it covers exactly the rows data/board.json (via
// isPlayerCell) assigns to each half, for the real board.
import { describe, expect, it } from 'vitest';
import { cellHalf } from '../src/render/board.ts';
import { isPlayerCell } from '../src/sim/hex.ts';
import { devContent } from './helpers.ts';

describe('cellHalf (P0-20 board readability)', () => {
  it('agrees with isPlayerCell for every cell on the real board', () => {
    const board = devContent().board;
    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        const cell = { col, row };
        expect(cellHalf(cell, board)).toBe(isPlayerCell(cell, board) ? 'player' : 'enemy');
      }
    }
  });

  it('shades exactly the bottom playerRows rows as player, and the rest as enemy', () => {
    const board = devContent().board;
    const playerStart = board.rows - board.playerRows;
    for (let row = 0; row < board.rows; row++) {
      const expected = row >= playerStart ? 'player' : 'enemy';
      expect(cellHalf({ col: 0, row }, board)).toBe(expected);
      expect(cellHalf({ col: board.cols - 1, row }, board)).toBe(expected);
    }
  });
});
