// P0-09: the run controller extracted from src/app/main.ts — dispatch, playback and abandon,
// driven without a DOM. The abandon-during-playback case is the regression test for the QA
// bootstrap bug that was fixed in main.ts without one.
import { describe, expect, it } from 'vitest';
import { RunController } from '../src/app/runController.ts';
import type { FightResult } from '../src/sim/fight.ts';
import type { ScreenEvent } from '../src/app/screens.ts';
import { devContent } from './helpers.ts';

const content = devContent();
const tickRate = content.rules.tickRate;

/** A minimal FightResult: enough for buildTimeline, no fight needed. */
function fakeResult(): FightResult {
  return { winner: 'draw', reason: 'timeout', ticks: 1, events: [], survivors: { left: [], right: [] }, ledger: [], hash: 'test' };
}

function make(devCommands = true): { c: RunController; events: ScreenEvent[]; changes: () => number } {
  const events: ScreenEvent[] = [];
  let changes = 0;
  const c = new RunController({
    content,
    devCommands,
    onScreenEvent: (ev) => events.push(ev),
    onChange: () => {
      changes++;
    },
  });
  return { c, events, changes: () => changes };
}

/** Runs the playback loop to completion in fixed steps, like the render loop does. */
function playOut(c: RunController, speed = 1): number {
  let steps = 0;
  while (c.playback && steps < 100_000) {
    c.advance(1 / 60, speed);
    steps++;
  }
  return steps;
}

describe('run controller', () => {
  it('startRun creates a run, emits startRun and honours the dev-command flag', () => {
    const dev = make(true);
    const run = dev.c.startRun(3);
    expect(run.config.seed).toBe(3);
    expect(run.config.devCommands).toBe(true);
    expect(dev.events).toEqual([{ type: 'startRun' }]);
    expect(dev.c.mode()).toBe('planning');
    const prod = make(false);
    expect(prod.c.startRun(3).config.devCommands).toBe(false);
    expect(prod.c.dispatch({ type: 'dev:gold', amount: 10 })).toEqual({ ok: false, reason: expect.stringMatching(/dev commands are disabled/) as unknown as string });
  });
  it('dispatch reports the sim rejection reason and leaves the state alone', () => {
    const { c } = make();
    const run = c.startRun(1);
    const before = JSON.stringify(run);
    const res = c.dispatch({ type: 'sell', uid: 999 });
    expect(res).toEqual({ ok: false, reason: 'no unit with uid 999' });
    expect(c.message).toBe('no unit with uid 999');
    expect(JSON.stringify(run)).toBe(before);
  });
  it('dispatch without a run fails instead of throwing', () => {
    const { c } = make();
    expect(c.dispatch({ type: 'reroll' })).toEqual({ ok: false, reason: 'no run in progress' });
    expect(c.abandon()).toEqual({ ok: false, reason: 'no run in progress' });
  });
  it('startCombat begins playback, which blocks further commands until it finishes', () => {
    const { c } = make();
    const run = c.startRun(1);
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(c.playback).not.toBeNull();
    expect(c.mode()).toBe('combat');
    const commands = run.commandCount;
    expect(c.dispatch({ type: 'reroll' })).toEqual({ ok: false, reason: 'combat is playing' });
    expect(run.commandCount).toBe(commands);
    playOut(c);
    expect(c.playback).toBeNull();
    expect(c.mode()).not.toBe('combat');
    expect(c.message).toMatch(/Victory|Defeat|Draw/);
  });
  it('playback runs for the fight length and 4x gets there in about a quarter of the steps', () => {
    // A real fight needs a unit on the board: an empty board loses instantly (0 ticks).
    const withFight = (): RunController => {
      const { c } = make();
      c.startRun(1);
      expect(c.dispatch({ type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 3, row: 7 } }).ok).toBe(true);
      expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
      return c;
    };
    const a = withFight();
    const ticks = a.playback!.timeline.ticks;
    expect(ticks).toBeGreaterThan(0);
    const slow = playOut(a, 1);
    const fast = playOut(withFight(), 4);
    expect(slow).toBeGreaterThan(fast);
    expect(fast).toBeGreaterThanOrEqual(Math.floor(slow / 4) - 1);
  });
  it('abandon during fight playback ends the run (QA bootstrap bug 2)', () => {
    const { c, events } = make();
    const run = c.startRun(1);
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(c.playback).not.toBeNull();
    const res = c.abandon();
    expect(res.ok).toBe(true);
    expect(c.playback).toBeNull();
    expect(run.phase).toBe('ended');
    expect(run.endReason).toBe('abandon');
    expect(events).toContainEqual({ type: 'runEnded', outcome: 'loss' });
    // A further command is rejected by the sim, not silently dropped.
    expect(c.dispatch({ type: 'reroll' })).toEqual({ ok: false, reason: 'run has ended' });
  });
  it('a run that ends inside a fight emits runEnded when the playback finishes, not before', () => {
    const { c, events } = make();
    const run = c.startRun(1);
    run.hp = 1;
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(run.phase).toBe('ended');
    expect(events.filter((e) => e.type === 'runEnded')).toHaveLength(0);
    playOut(c);
    expect(events.filter((e) => e.type === 'runEnded')).toEqual([{ type: 'runEnded', outcome: 'loss' }]);
  });
  it('abandon while the fight already ended the run still reaches the results screen', () => {
    // QA on P0-09: dropping the playback also dropped the callback that showed the results,
    // and the abandon command was then rejected with "run has ended" -> stuck on the run screen.
    const { c, events } = make();
    const run = c.startRun(1);
    run.hp = 1;
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(run.phase).toBe('ended');
    expect(c.playback).not.toBeNull();
    expect(c.abandon()).toEqual({ ok: true, reason: null });
    expect(c.playback).toBeNull();
    expect(events.filter((e) => e.type === 'runEnded')).toEqual([{ type: 'runEnded', outcome: 'loss' }]);
  });
  it('abandoning twice does not emit a second runEnded, and reports the sim reason', () => {
    const { c, events } = make();
    c.startRun(1);
    expect(c.abandon().ok).toBe(true);
    expect(c.abandon()).toEqual({ ok: false, reason: 'run has ended' });
    expect(events.filter((e) => e.type === 'runEnded')).toHaveLength(1);
  });
  it('advance ignores a non-finite, negative or zero dt and speed instead of stalling', () => {
    const { c } = make();
    c.startRun(1);
    expect(c.dispatch({ type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 3, row: 7 } }).ok).toBe(true);
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    for (const [dt, speed] of [[-1, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [1, 0], [1, -4], [1, Number.NaN]] as const) {
      c.advance(dt, speed);
      expect(c.playback, `dt ${dt} speed ${speed}`).not.toBeNull();
      expect(c.playback!.tick).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(c.playback!.tick)).toBe(true);
    }
    expect(playOut(c)).toBeGreaterThan(0);
  });
  it('starting a playback while one is running completes the pending one first', () => {
    const { c, events } = make();
    const run = c.startRun(1);
    run.hp = 1;
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(c.playback).not.toBeNull();
    const first = c.playback!;
    c.startPlayback(fakeResult());
    expect(c.playback).not.toBe(first);
    expect(events.filter((e) => e.type === 'runEnded')).toHaveLength(1);
  });
  it('the selection is dropped when the selected unit disappears', () => {
    const { c } = make();
    const run = c.startRun(1);
    expect(c.dispatch({ type: 'dev:gold', amount: 100 }).ok).toBe(true);
    expect(c.dispatch({ type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: null }).ok).toBe(true);
    const uid = run.bench.find((u) => u !== null)!.uid;
    c.selectedUid = uid;
    expect(c.dispatch({ type: 'sell', uid }).ok).toBe(true);
    expect(c.selectedUid).toBeNull();
  });
  it('advance is a no-op without playback, and clear forgets the run', () => {
    const { c } = make();
    c.startRun(1);
    c.advance(1, 1);
    expect(c.playback).toBeNull();
    c.clear();
    expect(c.run).toBeNull();
    expect(c.message).toBe('');
  });
  it('the playback tick advances at the sim tick rate', () => {
    const { c } = make();
    c.startRun(1);
    expect(c.dispatch({ type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 3, row: 7 } }).ok).toBe(true);
    expect(c.dispatch({ type: 'startCombat' }).ok).toBe(true);
    expect(c.playback!.tick).toBe(0);
    c.advance(1, 1);
    expect(c.playback!.tick).toBeCloseTo(tickRate, 5);
  });
});
