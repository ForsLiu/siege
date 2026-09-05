// Title, Results and Pause overlays (DOM). Thin bindings over src/app/screens.ts events.
import { HOTKEY_HELP } from '../app/hotkeys.ts';

export interface TitleCallbacks {
  onStartRun(seed: number): void;
  onDevFight(left: string, right: string, seed: number): void;
}

export interface TitleScreen {
  root: HTMLElement;
  show(): void;
  hide(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function seedFrom(input: HTMLInputElement): number {
  const n = Number.parseInt(input.value, 10);
  if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) return n;
  const random = Math.floor(Math.random() * 0xffffffff); // UI only: seeds are chosen outside the sim
  input.value = String(random);
  return random;
}

export function createTitleScreen(parent: HTMLElement, devBoards: readonly string[], contentHash: string, cb: TitleCallbacks): TitleScreen {
  const root = el('div', 'screen title-screen');
  root.append(el('h1', 'title', 'SIEGE'), el('p', 'subtitle', 'engine skeleton — dev content'));
  const seedRow = el('div', 'row');
  const seedInput = el('input', 'input');
  seedInput.type = 'number';
  seedInput.placeholder = 'seed (blank = random)';
  seedInput.min = '0';
  seedRow.append(el('label', 'label', 'Seed'), seedInput);
  const btnRun = el('button', 'btn btn-primary btn-large', 'New run');
  btnRun.addEventListener('click', () => cb.onStartRun(seedFrom(seedInput)));

  const devRow = el('div', 'row');
  const selLeft = el('select', 'input');
  const selRight = el('select', 'input');
  for (const name of devBoards) {
    selLeft.append(new Option(name, name));
    selRight.append(new Option(name, name));
  }
  if (devBoards.length > 1) selRight.selectedIndex = 1;
  const btnDev = el('button', 'btn btn-large', 'Dev fight');
  btnDev.addEventListener('click', () => cb.onDevFight(selLeft.value, selRight.value, seedFrom(seedInput)));
  devRow.append(el('label', 'label', 'Dev fight'), selLeft, el('span', 'label', 'vs'), selRight, btnDev);

  root.append(seedRow, btnRun, devRow, el('p', 'footnote', `content ${contentHash.slice(0, 16)} · Esc pause · F1 dev overlay · F2 dev panel`));
  parent.appendChild(root);
  return {
    root,
    show() {
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}

export interface ResultsView {
  outcome: 'win' | 'loss';
  endReason: string;
  round: number;
  totalRounds: number;
  hp: number;
  seed: number;
  finalHash: string;
  lines: string[];
}

export interface ResultsScreen {
  root: HTMLElement;
  show(view: ResultsView): void;
  hide(): void;
}

export function createResultsScreen(parent: HTMLElement, cb: { onTitle(): void; onAgain(): void }): ResultsScreen {
  const root = el('div', 'screen results-screen');
  root.hidden = true;
  const title = el('h1', 'title');
  const summary = el('pre', 'summary');
  const btnTitle = el('button', 'btn btn-large', 'Back to title');
  const btnAgain = el('button', 'btn btn-primary btn-large', 'New run');
  btnTitle.addEventListener('click', () => cb.onTitle());
  btnAgain.addEventListener('click', () => cb.onAgain());
  root.append(title, summary, el('div', 'row'));
  root.lastElementChild!.append(btnAgain, btnTitle);
  parent.appendChild(root);
  return {
    root,
    show(view) {
      title.textContent = view.outcome === 'win' ? 'VICTORY' : 'DEFEAT';
      summary.textContent = [
        `${view.endReason} · round ${view.round}/${view.totalRounds} · hp ${view.hp}`,
        `seed ${view.seed} · final hash ${view.finalHash}`,
        '',
        ...view.lines,
      ].join('\n');
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}

export interface PauseScreen {
  root: HTMLElement;
  show(canAbandon: boolean): void;
  hide(): void;
}

export function createPauseScreen(parent: HTMLElement, cb: { onResume(): void; onAbandon(): void }): PauseScreen {
  const root = el('div', 'screen pause-screen');
  root.hidden = true;
  const btnResume = el('button', 'btn btn-primary btn-large', 'Resume');
  const btnAbandon = el('button', 'btn btn-large', 'Abandon run');
  btnResume.addEventListener('click', () => cb.onResume());
  btnAbandon.addEventListener('click', () => cb.onAbandon());
  // The key list comes from the same table the app binds, so the two cannot drift.
  const keys = el('p', 'footnote', HOTKEY_HELP.map((h) => `${h.keys} ${h.what}`).join(' · '));
  root.append(el('h1', 'title', 'PAUSED'), btnResume, btnAbandon, keys);
  parent.appendChild(root);
  return {
    root,
    show(canAbandon) {
      btnAbandon.hidden = !canAbandon;
      root.hidden = false;
    },
    hide() {
      root.hidden = true;
    },
  };
}
