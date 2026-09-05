// Keyboard mapping for the run screen, as data. Pure: the fast tier tests the mapping and
// src/app/main.ts turns an action into a Command or a view change.
export type HotkeyAction =
  | { type: 'reroll' }
  | { type: 'levelUp' }
  | { type: 'sellSelected' }
  | { type: 'startOrNext' }
  | { type: 'speed'; speed: number }
  | { type: 'pause' };

/** Key -> action. Case-insensitive for letters; `null` when the key is not bound. */
export function hotkeyAction(key: string): HotkeyAction | null {
  switch (key.length === 1 ? key.toLowerCase() : key) {
    case 'r':
      return { type: 'reroll' };
    case 'x':
      return { type: 'levelUp' };
    case 's':
      return { type: 'sellSelected' };
    case ' ':
      return { type: 'startOrNext' };
    case '1':
      return { type: 'speed', speed: 1 };
    case '2':
      return { type: 'speed', speed: 2 };
    case '3':
      return { type: 'speed', speed: 4 };
    case 'Escape':
      return { type: 'pause' };
    default:
      return null;
  }
}

/** Rendered by the pause screen and mirrored in README.md (a test keeps the two in step). */
export const HOTKEY_HELP: readonly { keys: string; what: string }[] = [
  { keys: 'R', what: 'reroll the shop' },
  { keys: 'X', what: 'buy xp' },
  { keys: 'S', what: 'sell the selected unit' },
  { keys: 'Space', what: 'start combat / next round' },
  { keys: '1 2 3', what: 'playback speed 1x / 2x / 4x' },
  { keys: 'Esc', what: 'pause' },
];

/**
 * True for actions that change only the view (playback speed, pause). Those work in every
 * phase, including during combat playback; the rest become Commands and the sim decides, so a
 * mistimed key still reports the sim's reason instead of doing nothing.
 */
export function isViewAction(action: HotkeyAction): boolean {
  return action.type === 'speed' || action.type === 'pause';
}
