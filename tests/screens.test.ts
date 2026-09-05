import { describe, expect, it } from 'vitest';
import { initialScreen, LEGAL_TRANSITIONS, reduceScreen, SCREEN_EVENT_TYPES, type Screen, type ScreenEvent, type ScreenState } from '../src/app/screens.ts';

const SCREENS: Screen[] = ['title', 'run', 'results', 'devFight'];

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

  it('every (screen, event) pair either matches LEGAL_TRANSITIONS or leaves the state untouched', () => {
    for (const screen of SCREENS) {
      for (const type of SCREEN_EVENT_TYPES) {
        const before = at(screen, type === 'resume');
        const after = reduceScreen(before, event(type));
        const legal = LEGAL_TRANSITIONS.find((t) => t.from === screen && t.event === type);
        if (legal) {
          expect(after.screen, `${screen} + ${type}`).toBe(legal.to);
          expect(after, `${screen} + ${type} must produce a new state`).not.toBe(before);
        } else {
          expect(after, `${screen} + ${type} must be a no-op`).toBe(before);
        }
      }
    }
  });

  it('results keeps the outcome until leaving', () => {
    let s = reduceScreen(reduceScreen(initialScreen(), { type: 'startRun' }), { type: 'runEnded', outcome: 'win' });
    expect(s.outcome).toBe('win');
    s = reduceScreen(s, { type: 'startRun' });
    expect(s.outcome).toBeNull();
  });
});
