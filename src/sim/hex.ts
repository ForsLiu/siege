// Hex grid helpers: offset ("odd-r", pointy-top, odd rows shifted right) <-> axial,
// distance, neighbours, rings, deterministic BFS pathing. Integer math only.

export interface BoardConfig {
  cols: number;
  rows: number;
  /** Number of bottom rows owned by the player (rows - playerRows .. rows - 1). */
  playerRows: number;
  layout: 'odd-r';
}

export interface Cell {
  col: number;
  row: number;
}

export interface Axial {
  q: number;
  r: number;
}

export function offsetToAxial(c: Cell): Axial {
  return { q: c.col - (c.row - (c.row & 1)) / 2, r: c.row };
}

export function axialToOffset(a: Axial): Cell {
  return { col: a.q + (a.r - (a.r & 1)) / 2, row: a.r };
}

export function hexDistance(a: Cell, b: Cell): number {
  const A = offsetToAxial(a);
  const B = offsetToAxial(b);
  const dq = A.q - B.q;
  const dr = A.r - B.r;
  const ds = -dq - dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

// Direction order is part of the determinism contract: neighbours, rings and BFS
// all enumerate in this order. Index 0 = east, then counter-clockwise.
const EVEN_ROW_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, -1],
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];
const ODD_ROW_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [0, 1],
  [1, 1],
];

export function inBounds(c: Cell, board: BoardConfig): boolean {
  return c.col >= 0 && c.row >= 0 && c.col < board.cols && c.row < board.rows;
}

export function cellIndex(c: Cell, board: BoardConfig): number {
  return c.row * board.cols + c.col;
}

export function indexToCell(idx: number, board: BoardConfig): Cell {
  return { col: idx % board.cols, row: Math.floor(idx / board.cols) };
}

export function cellKey(c: Cell): string {
  return `${c.col},${c.row}`;
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

export function isPlayerCell(c: Cell, board: BoardConfig): boolean {
  return inBounds(c, board) && c.row >= board.rows - board.playerRows;
}

/**
 * All neighbours inside the board, in the fixed direction order rotated by `dirOffset`
 * (0..5). Both direction tables list the same six pixel directions (E, NE, NW, W, SW, SE),
 * so `dirOffset = 3` enumerates them point-reflected: the order a mirrored unit must use
 * for its pathing to be the mirror image of the original.
 */
export function neighbors(c: Cell, board: BoardConfig, dirOffset = 0): Cell[] {
  const dirs = c.row & 1 ? ODD_ROW_DIRS : EVEN_ROW_DIRS;
  const out: Cell[] = [];
  for (let k = 0; k < 6; k++) {
    const [dc, dr] = dirs[(k + dirOffset) % 6] as readonly [number, number];
    const n = { col: c.col + dc, row: c.row + dr };
    if (inBounds(n, board)) out.push(n);
  }
  return out;
}

/** Direction offset that makes a mirrored unit's enumeration the mirror of the original. */
export const MIRROR_DIR_OFFSET = 3;

/** Cells at exactly `radius` from center (in bounds), ordered by (row, col). */
export function ring(center: Cell, radius: number, board: BoardConfig): Cell[] {
  const out: Cell[] = [];
  if (radius === 0) return inBounds(center, board) ? [center] : out;
  for (let row = Math.max(0, center.row - radius); row <= Math.min(board.rows - 1, center.row + radius); row++) {
    for (let col = Math.max(0, center.col - radius - 1); col <= Math.min(board.cols - 1, center.col + radius + 1); col++) {
      const c = { col, row };
      if (hexDistance(center, c) === radius) out.push(c);
    }
  }
  return out;
}

/** Cells within `radius` (inclusive) of center, ordered by (row, col). */
export function cellsWithin(center: Cell, radius: number, board: BoardConfig): Cell[] {
  const out: Cell[] = [];
  for (let row = Math.max(0, center.row - radius); row <= Math.min(board.rows - 1, center.row + radius); row++) {
    for (let col = Math.max(0, center.col - radius - 1); col <= Math.min(board.cols - 1, center.col + radius + 1); col++) {
      const c = { col, row };
      if (hexDistance(center, c) <= radius) out.push(c);
    }
  }
  return out;
}

/**
 * Point reflection through the board centre. With an even number of rows this is an exact
 * hex symmetry for odd-r layouts (the schema enforces even rows). Used to place the right
 * side of a fight, whose board is authored in owner-half coordinates.
 */
export function mirrorCell(c: Cell, board: BoardConfig): Cell {
  return { col: board.cols - 1 - c.col, row: board.rows - 1 - c.row };
}

/**
 * Deterministic BFS from `start` to the first cell satisfying `isGoal`, never entering
 * cells where `blocked(index)` is true (the start cell is exempt). Returns the path
 * excluding `start` (empty when start already satisfies the goal), or null when unreachable.
 * Ties are broken by BFS discovery order, which follows the fixed neighbour order.
 */
export function bfsPath(
  board: BoardConfig,
  start: Cell,
  isGoal: (c: Cell) => boolean,
  blocked: (idx: number) => boolean,
  dirOffset = 0,
): Cell[] | null {
  if (isGoal(start)) return [];
  const n = board.cols * board.rows;
  const prev = new Int32Array(n).fill(-2); // -2 unvisited, -1 start
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const startIdx = cellIndex(start, board);
  prev[startIdx] = -1;
  queue[tail++] = startIdx;
  while (head < tail) {
    const idx = queue[head++] as number;
    const cell = indexToCell(idx, board);
    for (const nb of neighbors(cell, board, dirOffset)) {
      const ni = cellIndex(nb, board);
      if (prev[ni] !== -2) continue;
      if (blocked(ni)) continue;
      prev[ni] = idx;
      if (isGoal(nb)) {
        const path: Cell[] = [];
        let cur = ni;
        while (cur !== startIdx) {
          path.push(indexToCell(cur, board));
          cur = prev[cur] as number;
        }
        path.reverse();
        return path;
      }
      queue[tail++] = ni;
    }
  }
  return null;
}

/**
 * Single flood fill from `start` over non-blocked cells. Returns BFS step distances
 * (Int32Array indexed by cell; -1 = unreachable, 0 = start).
 */
export function floodDistances(board: BoardConfig, start: Cell, blocked: (idx: number) => boolean, dirOffset = 0): Int32Array {
  const n = board.cols * board.rows;
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const startIdx = cellIndex(start, board);
  dist[startIdx] = 0;
  queue[tail++] = startIdx;
  while (head < tail) {
    const idx = queue[head++] as number;
    const d = dist[idx] as number;
    for (const nb of neighbors(indexToCell(idx, board), board, dirOffset)) {
      const ni = cellIndex(nb, board);
      if (dist[ni] !== -1 || blocked(ni)) continue;
      dist[ni] = d + 1;
      queue[tail++] = ni;
    }
  }
  return dist;
}

/**
 * The `length` cells of the straight hex line leaving `from` through `to`, and on past it in
 * the same direction. Points are interpolated in cube coordinates as exact rationals over the
 * hex distance and rounded to the nearest cell (integer math only, no trig, no floats in the
 * decision), so consecutive cells are adjacent and `hexDistance(line[i], line[j]) === |i - j|`:
 * the line is straight, not merely a shortest path. The walk stops at the board edge.
 *
 * Where the segment passes exactly between two hexes the choice is a fixed tie-break, so the
 * result is not symmetric under point reflection by construction; callers that need the
 * mirrored line (team 1) mirror the endpoints and mirror the result back.
 */
export function hexLine(from: Cell, to: Cell, length: number, board: BoardConfig): Cell[] {
  const out: Cell[] = [];
  if (length <= 0 || sameCell(from, to)) return out;
  const a = cubeOf(from);
  const b = cubeOf(to);
  const n = hexDistance(from, to);
  const d: Cube = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  let prev = from;
  for (let i = 1; out.length < length; i++) {
    // Guard against a rounding wobble that never advances: the line can only need one extra
    // step per output cell, so twice the requested length plus the run-up is always enough.
    if (i > 2 * length + n + 2) break;
    // Where the segment runs exactly between two hexes the tie-break can land outside the
    // board while the other candidate is inside; a line along the edge must not die on that.
    let cell = offsetOfCube(roundCube(a, d, i, n, false));
    if (!inBounds(cell, board)) cell = offsetOfCube(roundCube(a, d, i, n, true));
    if (!inBounds(cell, board)) break;
    if (sameCell(cell, prev) || sameCell(cell, from)) continue;
    out.push(cell);
    prev = cell;
  }
  return out;
}

interface Cube {
  x: number;
  y: number;
  z: number;
}

function cubeOf(c: Cell): Cube {
  const a = offsetToAxial(c);
  return { x: a.q, y: -a.q - a.r, z: a.r };
}

function offsetOfCube(c: Cube): Cell {
  return axialToOffset({ q: c.x, r: c.z });
}

/** Round p/q to the nearest integer; `down` sends exact halves the other way. Exact; q > 0. */
function roundDiv(p: number, q: number, down: boolean): number {
  return Math.floor((2 * p + q - (down ? 1 : 0)) / (2 * q));
}

/**
 * `a + d * (i / n)` rounded to a cube cell: each coordinate is rounded, then the one that moved
 * furthest is recomputed from the other two so the coordinates still sum to zero.
 */
function roundCube(a: Cube, d: Cube, i: number, n: number, halvesDown: boolean): Cube {
  const xn = a.x * n + d.x * i;
  const yn = a.y * n + d.y * i;
  const zn = a.z * n + d.z * i;
  let x = roundDiv(xn, n, halvesDown);
  let y = roundDiv(yn, n, halvesDown);
  let z = roundDiv(zn, n, halvesDown);
  if (x + y + z === 0) return { x, y, z };
  // Compare the rounding errors as integers over the common denominator n.
  const dx = Math.abs(x * n - xn);
  const dy = Math.abs(y * n - yn);
  const dz = Math.abs(z * n - zn);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;
  return { x, y, z };
}
