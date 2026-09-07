import { describe, expect, it } from 'vitest';
import { axialToOffset, bfsPath, cellIndex, floodDistances, hexDistance, hexesWithin, indexToCell, MIRROR_DIR_OFFSET, mirrorCell, neighbors, offsetToAxial, ring, type BoardConfig, type Cell } from '../src/sim/hex.ts';

const board: BoardConfig = { cols: 7, rows: 8, playerRows: 4, layout: 'odd-r' };

function allCells(b: BoardConfig): Cell[] {
  const out: Cell[] = [];
  for (let row = 0; row < b.rows; row++) for (let col = 0; col < b.cols; col++) out.push({ col, row });
  return out;
}

describe('hex math', () => {
  it('offset <-> axial round-trips', () => {
    for (const c of allCells(board)) expect(axialToOffset(offsetToAxial(c))).toEqual(c);
  });
  it('distance is symmetric, zero on the diagonal, and obeys the triangle inequality', () => {
    const cells = allCells(board);
    for (const a of cells) {
      expect(hexDistance(a, a)).toBe(0);
      for (const b of cells) {
        expect(hexDistance(a, b)).toBe(hexDistance(b, a));
        for (const c of cells.filter((_, i) => i % 7 === 0)) {
          expect(hexDistance(a, c)).toBeLessThanOrEqual(hexDistance(a, b) + hexDistance(b, c));
        }
      }
    }
  });
  it('neighbours are at distance 1 and counts shrink at the edges', () => {
    expect(neighbors({ col: 3, row: 3 }, board)).toHaveLength(6);
    expect(neighbors({ col: 0, row: 0 }, board)).toHaveLength(2);
    expect(neighbors({ col: 6, row: 0 }, board)).toHaveLength(3);
    expect(neighbors({ col: 0, row: 7 }, board)).toHaveLength(3);
    expect(neighbors({ col: 6, row: 7 }, board)).toHaveLength(2);
    expect(neighbors({ col: 0, row: 3 }, board)).toHaveLength(5);
    for (const c of allCells(board)) for (const n of neighbors(c, board)) expect(hexDistance(c, n)).toBe(1);
  });
  it('ring and hexesWithin agree with hexDistance', () => {
    const center = { col: 3, row: 4 };
    expect(ring(center, 1, board)).toHaveLength(6);
    expect(ring(center, 2, board)).toHaveLength(12);
    expect(hexesWithin(center, 2, board)).toHaveLength(19);
    for (const c of ring(center, 3, board)) expect(hexDistance(center, c)).toBe(3);
  });
  it('mirrorCell is an involution that preserves distances', () => {
    const cells = allCells(board);
    for (const a of cells) {
      expect(mirrorCell(mirrorCell(a, board), board)).toEqual(a);
      for (const b of cells) expect(hexDistance(mirrorCell(a, board), mirrorCell(b, board))).toBe(hexDistance(a, b));
    }
  });
  it('bfs finds optimal paths on an open grid', () => {
    const cells = allCells(board);
    for (const a of cells.filter((_, i) => i % 3 === 0)) {
      for (const b of cells.filter((_, i) => i % 5 === 0)) {
        const path = bfsPath(board, a, (c) => c.col === b.col && c.row === b.row, () => false);
        expect(path).not.toBeNull();
        expect(path!.length).toBe(hexDistance(a, b));
        let prev = a;
        for (const step of path!) {
          expect(hexDistance(prev, step)).toBe(1);
          prev = step;
        }
      }
    }
  });
  it('bfs routes around blocked cells and reports unreachable goals', () => {
    const start = { col: 3, row: 7 };
    const goal = { col: 3, row: 0 };
    // Wall across row 4 except col 6.
    const wall = new Set<number>();
    for (let col = 0; col < 6; col++) wall.add(cellIndex({ col, row: 4 }, board));
    const path = bfsPath(board, start, (c) => c.col === goal.col && c.row === goal.row, (i) => wall.has(i));
    expect(path).not.toBeNull();
    expect(path!.some((c) => c.row === 4 && c.col === 6)).toBe(true);
    for (const c of path!) expect(wall.has(cellIndex(c, board))).toBe(false);
    wall.add(cellIndex({ col: 6, row: 4 }, board));
    expect(bfsPath(board, start, (c) => c.row === 0, (i) => wall.has(i))).toBeNull();
  });
  it('bfs with the mirror direction offset produces the mirror image of the original path', () => {
    const cells = allCells(board);
    const blockedSet = new Set<number>([cellIndex({ col: 3, row: 3 }, board), cellIndex({ col: 2, row: 4 }, board), cellIndex({ col: 4, row: 5 }, board)]);
    const mirroredBlocked = new Set<number>([...blockedSet].map((i) => cellIndex(mirrorCell(indexToCell(i, board), board), board)));
    for (const start of cells.filter((_, i) => i % 4 === 0)) {
      for (const goal of cells.filter((_, i) => i % 6 === 1)) {
        const p = bfsPath(board, start, (c) => c.col === goal.col && c.row === goal.row, (i) => blockedSet.has(i), 0);
        const ms = mirrorCell(start, board);
        const mg = mirrorCell(goal, board);
        const mp = bfsPath(board, ms, (c) => c.col === mg.col && c.row === mg.row, (i) => mirroredBlocked.has(i), MIRROR_DIR_OFFSET);
        if (p === null) {
          expect(mp).toBeNull();
          continue;
        }
        expect(mp).toEqual(p.map((c) => mirrorCell(c, board)));
      }
    }
  });
  it('floodDistances agrees with bfs path lengths', () => {
    const start = { col: 0, row: 7 };
    const wall = new Set<number>([cellIndex({ col: 1, row: 6 }, board), cellIndex({ col: 1, row: 7 }, board)]);
    const dist = floodDistances(board, start, (i) => wall.has(i));
    for (const c of allCells(board)) {
      const p = bfsPath(board, start, (x) => x.col === c.col && x.row === c.row, (i) => wall.has(i));
      expect(dist[cellIndex(c, board)]).toBe(p === null ? -1 : p.length);
    }
  });
  it('bfs tie-breaks are stable (same input, same path)', () => {
    const a = bfsPath(board, { col: 0, row: 7 }, (c) => c.row === 0, () => false);
    const b = bfsPath(board, { col: 0, row: 7 }, (c) => c.row === 0, () => false);
    expect(a).toEqual(b);
  });
});
