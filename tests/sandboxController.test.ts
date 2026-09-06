// P0-18: the sandbox controller (editable setup, single-fight playback, headless runN,
// save/load) driven without a DOM. Covers every transition the item's acceptance text names:
// enter, run once, replay, run N, save, load, exit (a "toTitle" ScreenEvent from `enter`, and
// `clear` for leaving the screen).
import { describe, expect, it } from 'vitest';
import { SandboxController, type SandboxLoadResult, type SandboxPersistence, type SandboxPersistenceResult } from '../src/app/sandboxController.ts';
import type { SandboxSetup } from '../src/sim/sandbox.ts';
import type { ScreenEvent } from '../src/app/screens.ts';
import { devContent } from './helpers.ts';

const content = devContent();

function make(): { c: SandboxController; events: ScreenEvent[]; changes: () => number } {
  const events: ScreenEvent[] = [];
  let changes = 0;
  const c = new SandboxController({ content, onScreenEvent: (ev) => events.push(ev), onChange: () => changes++ });
  return { c, events, changes: () => changes };
}

/** Runs the playback loop to completion in fixed steps, like the render loop does. */
function playOut(c: SandboxController, speed = 1): number {
  let steps = 0;
  while (c.playback && steps < 100_000) {
    c.advance(1 / 60, speed);
    steps++;
  }
  return steps;
}

function fakePersistence(store: Map<string, SandboxSetup>): SandboxPersistence {
  return {
    async save(name, setup): Promise<SandboxPersistenceResult> {
      store.set(name, structuredClone(setup));
      return { ok: true, error: null };
    },
    async load(name): Promise<SandboxLoadResult> {
      const setup = store.get(name);
      if (!setup) return { ok: false, setup: null, error: `no such setup ${name}` };
      return { ok: true, setup: structuredClone(setup), error: null };
    },
  };
}

describe('sandbox controller', () => {
  it('enter resets the setup and emits enterSandbox', () => {
    const { c, events } = make();
    c.addUnit('left', 'dev.brawler');
    c.enter();
    expect(c.setup).toEqual({ left: [], right: [], rules: {} });
    expect(events).toEqual([{ type: 'enterSandbox' }]);
  });

  it('addUnit places a unit on the next free player-half cell and removeUnit drops it', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('left', 'dev.archer');
    expect(c.setup.left).toHaveLength(2);
    const cells = c.setup.left.map((u) => `${u.col},${u.row}`);
    expect(new Set(cells).size).toBe(2); // never the same cell twice
    for (const u of c.setup.left) expect(u.row).toBeGreaterThanOrEqual(content.board.rows - content.board.playerRows);
    c.removeUnit('left', 0);
    expect(c.setup.left).toHaveLength(1);
    expect(c.setup.left[0]!.defId).toBe('dev.archer');
  });

  it('addUnit ignores an unknown defId and reports a full side', () => {
    const { c } = make();
    c.addUnit('left', 'nope');
    expect(c.setup.left).toHaveLength(0);
    const board = content.board;
    const capacity = board.cols * board.playerRows;
    for (let i = 0; i < capacity; i++) c.addUnit('left', 'dev.brawler');
    expect(c.setup.left).toHaveLength(capacity);
    c.addUnit('left', 'dev.brawler');
    expect(c.setup.left).toHaveLength(capacity);
    expect(c.message).toMatch(/left side is full/);
  });

  it('setStar, setItems and setStatOverride edit exactly the addressed unit', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('left', 'dev.archer');
    c.setStar('left', 1, 2);
    c.setItems('left', 1, ['dev.a', 'dev.b']);
    c.setStatOverride('left', 1, 'attack', 999);
    expect(c.setup.left[0]).toMatchObject({ defId: 'dev.brawler', star: 1, items: [], statOverrides: {} });
    expect(c.setup.left[1]).toMatchObject({ defId: 'dev.archer', star: 2, items: ['dev.a', 'dev.b'], statOverrides: { attack: 999 } });
    c.setStatOverride('left', 1, 'attack', null);
    expect(c.setup.left[1]!.statOverrides).toEqual({});
  });

  it('setRules merges fight-rule overrides', () => {
    const { c } = make();
    c.setRules({ maxSeconds: 5 });
    c.setRules({ overtime: true });
    expect(c.setup.rules).toEqual({ maxSeconds: 5, overtime: true });
  });

  it('runOnce refuses an empty setup and does not start a fight', () => {
    const { c } = make();
    c.runOnce();
    expect(c.playback).toBeNull();
    expect(c.message).toMatch(/add at least one unit/);
  });

  it('run once starts playback, plays out and matches a direct fight(), then replay reuses it', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('right', 'dev.archer');
    c.setSeed(7);
    c.runOnce();
    expect(c.playback).not.toBeNull();
    const ticks = c.playback!.timeline.ticks;
    expect(ticks).toBeGreaterThan(0);
    playOut(c);
    expect(c.playback).toBeNull();
    const first = c.lastResult;
    expect(first).not.toBeNull();

    c.replay();
    expect(c.playback).not.toBeNull();
    expect(c.playback!.timeline.ticks).toBe(ticks);
    playOut(c);
    // Replay is the same computed result, not a fresh fight() call: identical hash.
    expect(c.lastResult!.hash).toBe(first!.hash);
  });

  it('replay without a prior run once is a no-op', () => {
    const { c } = make();
    c.replay();
    expect(c.playback).toBeNull();
  });

  it('runN refuses an empty setup, otherwise aggregates and clears any single-fight result', () => {
    const { c } = make();
    c.runN();
    expect(c.lastAggregate).toBeNull();
    expect(c.message).toMatch(/add at least one unit/);

    c.addUnit('left', 'dev.brawler');
    c.addUnit('right', 'dev.archer');
    c.setSeed(3);
    c.setN(5);
    c.runOnce();
    playOut(c);
    expect(c.lastResult).not.toBeNull();
    c.runN();
    expect(c.lastAggregate).not.toBeNull();
    expect(c.lastAggregate!.fights).toBe(5);
    expect(c.lastResult).toBeNull(); // runN supersedes the single-fight result
    expect(c.playback).toBeNull();
  });

  it('save and load round-trip through an injected persistence, validated against content', () => {
    const store = new Map<string, SandboxSetup>();
    const { c } = make();
    c.setPersistence(fakePersistence(store));
    c.addUnit('left', 'dev.guardian');
    c.setStatOverride('left', 0, 'armor', 77);
    const saved = structuredClone(c.setup);

    return c.save('my-setup').then(() => {
      expect(c.message).toMatch(/saved sandbox-my-setup\.json/);
      expect(store.has('my-setup')).toBe(true);

      const { c: c2 } = make();
      c2.setPersistence(fakePersistence(store));
      return c2.load('my-setup').then(() => {
        expect(c2.setup).toEqual(saved);
        expect(c2.message).toMatch(/loaded sandbox-my-setup\.json/);
      });
    });
  });

  it('save/load reject a name outside [a-z0-9_-] and report when persistence is unavailable', async () => {
    const { c } = make();
    await c.save('Not Valid!');
    expect(c.message).toMatch(/name must be/);
    await c.load('../etc/passwd');
    expect(c.message).toMatch(/name must be/);

    const { c: c2 } = make();
    await c2.save('fine');
    expect(c2.message).toMatch(/unavailable outside a dev build/);
    await c2.load('fine');
    expect(c2.message).toMatch(/unavailable outside a dev build/);
  });

  it('load reports the persistence error and leaves the current setup untouched on failure', async () => {
    const store = new Map<string, SandboxSetup>();
    const { c } = make();
    c.setPersistence(fakePersistence(store));
    c.addUnit('left', 'dev.brawler');
    const before = structuredClone(c.setup);
    await c.load('missing');
    expect(c.message).toMatch(/no such setup missing/);
    expect(c.setup).toEqual(before);
  });

  it('clear drops playback (exiting the screen) without touching the setup', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('right', 'dev.archer');
    c.runOnce();
    expect(c.playback).not.toBeNull();
    c.clear();
    expect(c.playback).toBeNull();
    expect(c.setup.left).toHaveLength(1);
  });

  it('advance ignores a non-finite, negative or zero dt and speed instead of stalling', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('right', 'dev.archer');
    c.runOnce();
    for (const [dt, speed] of [[-1, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [1, 0], [1, -4], [1, Number.NaN]] as const) {
      c.advance(dt, speed);
      expect(c.playback, `dt ${dt} speed ${speed}`).not.toBeNull();
      expect(Number.isFinite(c.playback!.tick)).toBe(true);
    }
    expect(playOut(c)).toBeGreaterThan(0);
  });

  it('starting a new run once while one is playing completes the pending one first', () => {
    const { c } = make();
    c.addUnit('left', 'dev.brawler');
    c.addUnit('right', 'dev.archer');
    c.runOnce();
    const first = c.playback;
    expect(first).not.toBeNull();
    c.runOnce();
    expect(c.playback).not.toBe(first);
  });
});
