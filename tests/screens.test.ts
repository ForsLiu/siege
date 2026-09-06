import { describe, expect, it } from 'vitest';
import { initialScreen, LEGAL_TRANSITIONS, reduceScreen, SCREEN_EVENT_TYPES, type Screen, type ScreenEvent, type ScreenState } from '../src/app/screens.ts';

const SCREENS: Screen[] = ['title', 'run', 'results', 'devFight', 'sandbox'];

function at(screen: Screen, paused = false): ScreenState {
  return { screen, paused, outcome: null };
}

function event(type: ScreenEvent['type']): ScreenEvent {
  return type === 'runEnded' ? { type, outcome: 'win' } : ({ type } as ScreenEvent);
}

describe('screen state machine', () => {
  it('starts on the title screen', () => {
    expect(initialScreen()).toEqual({ screen: 'title', paused: false, outcome: null });
  });

  it('money path: title -> run -> results -> title', () => {
    let s = initialScreen();
    s = reduceScreen(s, { type: 'startRun' });
    expect(s.screen).toBe('run');
    s = reduceScreen(s, { type: 'runEnded', outcome: 'loss' });
    expect(s).toEqual({ screen: 'results', paused: false, outcome: 'loss' });
    s = reduceScreen(s, { type: 'toTitle' });
    expect(s.screen).toBe('title');
  });

  it('pause toggles only on run and devFight; resume clears it', () => {
    let s = reduceScreen(initialScreen(), { type: 'startRun' });
    s = reduceScreen(s, { type: 'togglePause' });
    expect(s.paused).toBe(true);
    s = reduceScreen(s, { type: 'resume' });
    expect(s.paused).toBe(false);
    const title = initialScreen();
    expect(reduceScreen(title, { type: 'togglePause' })).toBe(title);
    let d = reduceScreen(title, { type: 'startDevFight' });
    d = reduceScreen(d, { type: 'togglePause' });
    expect(d.paused).toBe(true);
    expect(reduceScreen(d, { type: 'toTitle' }).screen).toBe('title');
  });

  it('every (screen, paused, event) triple either matches LEGAL_TRANSITIONS or leaves the state untouched', () => {
    for (const screen of SCREENS) {
      for (const paused of [false, true]) {
        for (const type of SCREEN_EVENT_TYPES) {
          const before = at(screen, paused);
          const after = reduceScreen(before, event(type));
          const legal = LEGAL_TRANSITIONS.find((t) => t.from === screen && t.event === type);
          const where = `${screen}${paused ? ' (paused)' : ''} + ${type}`;
          // `resume` is the one transition whose legality depends on `paused`.
          if (legal && !(type === 'resume' && !paused)) {
            expect(after.screen, where).toBe(legal.to);
            expect(after, `${where} must produce a new state`).not.toBe(before);
            if (type === 'resume' || type === 'togglePause') expect(after.paused, where).toBe(type === 'togglePause' ? !paused : false);
            else expect(after.paused, `${where} leaves the run unpaused`).toBe(false);
          } else {
            expect(after, `${where} must be a no-op`).toBe(before);
          }
        }
      }
    }
  });

  it('title -> sandbox -> title, with no pause on the sandbox screen', () => {
    let s = reduceScreen(initialScreen(), { type: 'enterSandbox' });
    expect(s.screen).toBe('sandbox');
    expect(reduceScreen(s, { type: 'togglePause' })).toBe(s);
    s = reduceScreen(s, { type: 'toTitle' });
    expect(s.screen).toBe('title');
  });

  it('results keeps the outcome until leaving', () => {
    let s = reduceScreen(reduceScreen(initialScreen(), { type: 'startRun' }), { type: 'runEnded', outcome: 'win' });
    expect(s.outcome).toBe('win');
    s = reduceScreen(s, { type: 'startRun' });
    expect(s.outcome).toBeNull();
  });
});
