// Pure screen state machine: Title -> Run -> Results -> Title, plus the Dev fight and Sandbox
// screens. Illegal events return the input state unchanged (same reference).

export type Screen = 'title' | 'run' | 'results' | 'devFight' | 'sandbox';

export interface ScreenState {
  screen: Screen;
  paused: boolean;
  outcome: 'win' | 'loss' | null;
}

export type ScreenEvent =
  | { type: 'startRun' }
  | { type: 'startDevFight' }
  | { type: 'enterSandbox' }
  | { type: 'runEnded'; outcome: 'win' | 'loss' }
  | { type: 'togglePause' }
  | { type: 'resume' }
  | { type: 'toTitle' };

export const SCREEN_EVENT_TYPES: readonly ScreenEvent['type'][] = ['startRun', 'startDevFight', 'enterSandbox', 'runEnded', 'togglePause', 'resume', 'toTitle'];

export function initialScreen(): ScreenState {
  return { screen: 'title', paused: false, outcome: null };
}

export function reduceScreen(s: ScreenState, ev: ScreenEvent): ScreenState {
  switch (s.screen) {
    case 'title':
      if (ev.type === 'startRun') return { screen: 'run', paused: false, outcome: null };
      if (ev.type === 'startDevFight') return { screen: 'devFight', paused: false, outcome: null };
      if (ev.type === 'enterSandbox') return { screen: 'sandbox', paused: false, outcome: null };
      return s;
    case 'run':
      if (ev.type === 'runEnded') return { screen: 'results', paused: false, outcome: ev.outcome };
      if (ev.type === 'togglePause') return { ...s, paused: !s.paused };
      if (ev.type === 'resume') return s.paused ? { ...s, paused: false } : s;
      return s;
    case 'results':
      if (ev.type === 'toTitle') return initialScreen();
      if (ev.type === 'startRun') return { screen: 'run', paused: false, outcome: null };
      return s;
    case 'devFight':
      if (ev.type === 'toTitle') return initialScreen();
      if (ev.type === 'togglePause') return { ...s, paused: !s.paused };
      if (ev.type === 'resume') return s.paused ? { ...s, paused: false } : s;
      return s;
    case 'sandbox':
      if (ev.type === 'toTitle') return initialScreen();
      return s;
    default: {
      const never: never = s.screen;
      throw new Error(`unknown screen ${String(never)}`);
    }
  }
}

/** Every (screen, event) pair that changes state; used by tests to prove full coverage. */
export const LEGAL_TRANSITIONS: ReadonlyArray<{ from: Screen; event: ScreenEvent['type']; to: Screen }> = [
  { from: 'title', event: 'startRun', to: 'run' },
  { from: 'title', event: 'startDevFight', to: 'devFight' },
  { from: 'title', event: 'enterSandbox', to: 'sandbox' },
  { from: 'run', event: 'runEnded', to: 'results' },
  { from: 'run', event: 'togglePause', to: 'run' },
  { from: 'run', event: 'resume', to: 'run' },
  { from: 'results', event: 'toTitle', to: 'title' },
  { from: 'results', event: 'startRun', to: 'run' },
  { from: 'devFight', event: 'toTitle', to: 'title' },
  { from: 'devFight', event: 'togglePause', to: 'devFight' },
  { from: 'devFight', event: 'resume', to: 'devFight' },
  { from: 'sandbox', event: 'toTitle', to: 'title' },
];
