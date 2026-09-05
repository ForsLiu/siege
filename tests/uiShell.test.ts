// P0-09: the pure parts of the UI shell — letterbox layout, drag-and-drop placement rules and
// the hotkey mapping.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/data/node.ts';
import { canDrag, dropOutcome } from '../src/app/drag.ts';
import { hotkeyAction, HOTKEY_HELP, isViewAction } from '../src/app/hotkeys.ts';
import { boardClick, boardDrop } from '../src/app/pointer.ts';
import { letterbox, PLAY_ASPECT } from '../src/render/layout.ts';
import { applyCommand } from '../src/sim/commands.ts';
import { createRun, type RunState } from '../src/sim/run.ts';
import { devContent } from './helpers.ts';

const content = devContent();
const board = content.board;
const playerRow = board.rows - 1;

function runWithUnits(n: number): RunState {
  const s = createRun(1, content, { devCommands: true });
  expect(applyCommand(s, { type: 'dev:xp', amount: 1000 }, content).ok).toBe(true); // room on the board
  for (let i = 0; i < n; i++) {
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: i, row: playerRow } }, content).ok).toBe(true);
  }
  return s;
}

describe('letterbox layout', () => {
  it('a 16:9 viewport is filled edge to edge', () => {
    expect(letterbox(1920, 1080)).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
  });
  it('a wider viewport gets bars on the left and right', () => {
    const box = letterbox(2000, 1000);
    expect(box.height).toBe(1000);
    expect(box.width).toBeCloseTo(1000 * PLAY_ASPECT, 6);
    expect(box.x).toBeCloseTo((2000 - box.width) / 2, 6);
    expect(box.y).toBe(0);
  });
  it('a taller viewport gets bars on the top and bottom', () => {
    const box = letterbox(1000, 1000);
    expect(box.width).toBe(1000);
    expect(box.height).toBeCloseTo(1000 / PLAY_ASPECT, 6);
    expect(box.y).toBeCloseTo((1000 - box.height) / 2, 6);
    expect(box.x).toBe(0);
  });
  it('the box always fits, is centred and keeps its aspect at any size', () => {
    for (const [w, h] of [[320, 240], [1280, 720], [800, 1400], [3440, 1440], [17, 900]] as const) {
      const box = letterbox(w, h);
      expect(box.width).toBeLessThanOrEqual(w + 1e-9);
      expect(box.height).toBeLessThanOrEqual(h + 1e-9);
      expect(box.width / box.height).toBeCloseTo(PLAY_ASPECT, 6);
      expect(box.x * 2 + box.width).toBeCloseTo(w, 6);
      expect(box.y * 2 + box.height).toBeCloseTo(h, 6);
    }
  });
  it('degenerate sizes do not produce NaN', () => {
    expect(letterbox(0, 0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(letterbox(-5, 100)).toEqual({ x: 0, y: 0, width: 0, height: 100 });
    expect(letterbox(Number.NaN, 100)).toEqual({ x: 0, y: 0, width: 0, height: 100 });
    expect(letterbox(100, Number.NaN)).toEqual({ x: 0, y: 0, width: 100, height: 0 });
    expect(letterbox(Number.POSITIVE_INFINITY, 100)).toEqual({ x: 0, y: 0, width: 0, height: 100 });
  });
});

describe('drag-and-drop placement', () => {
  it('dropping a board unit on an empty player cell places it', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    const out = dropOutcome(s, uid, { col: 4, row: playerRow }, content);
    expect(out).toEqual({ command: { type: 'place', uid, col: 4, row: playerRow }, reason: null, valid: true });
    expect(applyCommand(s, out.command!, content).ok).toBe(true);
  });
  it('dropping on another unit swaps them', () => {
    const s = runWithUnits(2);
    const [a, b] = [s.board[0]!.uid, s.board[1]!.uid];
    const out = dropOutcome(s, a, { col: 1, row: playerRow }, content);
    expect(out.command).toEqual({ type: 'swap', uidA: a, uidB: b });
    expect(out.valid).toBe(true);
  });
  it('dropping a unit back on its own cell is a no-op, not an error', () => {
    const s = runWithUnits(1);
    const out = dropOutcome(s, s.board[0]!.uid, { col: 0, row: playerRow }, content);
    expect(out).toEqual({ command: null, reason: null, valid: true });
  });
  it('dropping off the grid or on the enemy half is refused with a reason', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    const off = dropOutcome(s, uid, null, content);
    expect(off.valid).toBe(false);
    expect(off.reason).toMatch(/your half of the board/);
    const enemy = dropOutcome(s, uid, { col: 0, row: 0 }, content);
    expect(enemy.valid).toBe(false);
    expect(enemy.reason).toBe('cell is outside the player half');
  });
  it('a bench unit dropped onto a full team reports the sim reason', () => {
    const s = createRun(1, content, { devCommands: true });
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 0, row: playerRow } }, content).ok).toBe(true);
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.archer', star: 1, cell: null }, content).ok).toBe(true);
    const benched = s.bench.find((u) => u !== null)!;
    const out = dropOutcome(s, benched.uid, { col: 1, row: playerRow }, content);
    expect(out.valid).toBe(false);
    expect(out.reason).toMatch(/team is full/);
    expect(out.command).toBeNull();
  });
  it('an unknown uid and a non-planning phase are refused, and canDrag agrees', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    expect(dropOutcome(s, 4242, { col: 2, row: playerRow }, content).reason).toMatch(/no unit with uid/);
    expect(canDrag(s, 4242)).toBe(false);
    expect(canDrag(s, uid)).toBe(true);
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(canDrag(s, uid)).toBe(false);
    expect(dropOutcome(s, uid, { col: 2, row: playerRow }, content).reason).toMatch(/requires the planning phase/);
  });
});

describe('hotkeys', () => {
  it('maps the documented keys, upper and lower case', () => {
    expect(hotkeyAction('r')).toEqual({ type: 'reroll' });
    expect(hotkeyAction('R')).toEqual({ type: 'reroll' });
    expect(hotkeyAction('x')).toEqual({ type: 'levelUp' });
    expect(hotkeyAction('S')).toEqual({ type: 'sellSelected' });
    expect(hotkeyAction(' ')).toEqual({ type: 'startOrNext' });
    expect(hotkeyAction('1')).toEqual({ type: 'speed', speed: 1 });
    expect(hotkeyAction('2')).toEqual({ type: 'speed', speed: 2 });
    expect(hotkeyAction('3')).toEqual({ type: 'speed', speed: 4 });
    expect(hotkeyAction('Escape')).toEqual({ type: 'pause' });
  });
  it('leaves unbound keys alone', () => {
    for (const key of ['q', 'F5', 'Enter', 'ArrowUp', '9', '']) expect(hotkeyAction(key)).toBeNull();
  });
  it('README documents exactly the bound keys', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const line = readme.split('\n').find((l) => l.startsWith('- Hotkeys:'));
    expect(line, 'README has no hotkey line').toBeTruthy();
    // README writes each key in backticks (`1` `2` `3`); compare key by key.
    for (const key of HOTKEY_HELP.flatMap((h) => h.keys.split(' '))) {
      expect(line, `${key} missing from README`).toContain(`\`${key}\``);
    }
  });
  it('every documented key is actually bound', () => {
    const keys = HOTKEY_HELP.flatMap((h) => h.keys.split(' ')).map((k) => (k === 'Space' ? ' ' : k === 'Esc' ? 'Escape' : k));
    for (const k of keys) expect(hotkeyAction(k), `${k} is documented but unbound`).not.toBeNull();
  });
  it('speed and pause are view actions (they work during playback); the rest become Commands', () => {
    expect(isViewAction({ type: 'speed', speed: 2 })).toBe(true);
    expect(isViewAction({ type: 'pause' })).toBe(true);
    for (const a of [{ type: 'reroll' }, { type: 'levelUp' }, { type: 'sellSelected' }, { type: 'startOrNext' }] as const) {
      expect(isViewAction(a), a.type).toBe(false);
    }
  });
});

describe('board pointer resolution', () => {
  it('the first click on a unit selects it; it takes a second click to bench it', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    const first = boardClick(s, null, { col: 0, row: playerRow }, content);
    expect(first).toEqual({ command: null, select: uid, reason: null });
    const second = boardClick(s, uid, { col: 0, row: playerRow }, content);
    expect(second).toEqual({ command: { type: 'bench', uid }, select: null, reason: null });
  });
  it('clicking another unit while one is selected swaps them', () => {
    const s = runWithUnits(2);
    const [a, b] = [s.board[0]!.uid, s.board[1]!.uid];
    expect(boardClick(s, a, { col: 1, row: playerRow }, content)).toEqual({ command: { type: 'swap', uidA: a, uidB: b }, select: null, reason: null });
  });
  it('clicking an empty cell places the selection, and does nothing without one', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    expect(boardClick(s, uid, { col: 4, row: playerRow }, content)).toEqual({ command: { type: 'place', uid, col: 4, row: playerRow }, select: null, reason: null });
    expect(boardClick(s, null, { col: 4, row: playerRow }, content)).toEqual({ command: null, select: 'keep', reason: null });
  });
  it('an illegal click keeps the selection and reports the reason', () => {
    const s = createRun(1, content, { devCommands: true });
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 0, row: playerRow } }, content).ok).toBe(true);
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.archer', star: 1, cell: null }, content).ok).toBe(true);
    const benched = s.bench.find((u) => u !== null)!;
    const out = boardClick(s, benched.uid, { col: 3, row: playerRow }, content);
    expect(out.command).toBeNull();
    expect(out.select).toBe('keep');
    expect(out.reason).toMatch(/team is full/);
  });
  it('clicks outside the planning phase do nothing at all', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(boardClick(s, uid, { col: 4, row: playerRow }, content)).toEqual({ command: null, select: 'keep', reason: null });
  });
  it('a drag dropped on its own cell clears the selection without a command', () => {
    const s = runWithUnits(1);
    const uid = s.board[0]!.uid;
    expect(boardDrop(s, uid, { col: 0, row: playerRow }, content)).toEqual({ command: null, select: null, reason: null });
  });
  it('a drag dropped off the board keeps the unit selected and reports why', () => {
    const s = runWithUnits(1);
    const out = boardDrop(s, s.board[0]!.uid, null, content);
    expect(out.command).toBeNull();
    expect(out.select).toBe('keep');
    expect(out.reason).toMatch(/your half of the board/);
  });
});
