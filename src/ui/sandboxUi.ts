// DOM for the Battle sandbox screen (P0-18): roster, per-unit editors, fight-rule overrides,
// run/replay/run-N controls and save/load. Every edit goes through the sandbox controller;
// this module only reads state and renders it.
import type { Content } from '../sim/rules.ts';
import type { SandboxResult, SandboxRuleOverrides, SandboxSetup, SandboxSide, SandboxUnit } from '../sim/sandbox.ts';
import { STAT_NAMES, type StatName } from '../sim/stats.ts';

export interface SandboxUiView {
  content: Content;
  setup: SandboxSetup;
  seed: number;
  n: number;
  speed: number;
  message: string;
  lastAggregate: SandboxResult | null;
  canReplay: boolean;
  isPlaying: boolean;
  selected: { side: SandboxSide; index: number } | null;
}

export interface SandboxUiCallbacks {
  onAddUnit(side: SandboxSide, defId: string): void;
  onRemoveUnit(side: SandboxSide, index: number): void;
  /** Click on a row's name (P0-20 inspector); toggles off when the same row is clicked again. */
  onSelectUnit(side: SandboxSide, index: number): void;
  onSetStar(side: SandboxSide, index: number, star: number): void;
  onSetItems(side: SandboxSide, index: number, items: string[]): void;
  onSetStatOverride(side: SandboxSide, index: number, stat: StatName, value: number | null): void;
  onSetRules(patch: SandboxRuleOverrides): void;
  onSetSeed(seed: number): void;
  onSetN(n: number): void;
  onRunOnce(): void;
  onReplay(): void;
  onRunN(): void;
  onSave(name: string): void;
  onLoad(name: string): void;
  onSpeed(speed: number): void;
  onBack(): void;
}

export interface SandboxUi {
  root: HTMLElement;
  update(view: SandboxUiView): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function numberOrNull(input: HTMLInputElement): number | null {
  if (input.value.trim() === '') return null;
  const n = Number(input.value);
  return Number.isFinite(n) ? n : null;
}

function sideList(setup: SandboxSetup, side: SandboxSide): readonly SandboxUnit[] {
  return side === 'left' ? setup.left : setup.right;
}

export function createSandboxUi(parent: HTMLElement, cb: SandboxUiCallbacks): SandboxUi {
  const root = el('div', 'run-ui sandbox-ui');
  root.hidden = true;

  const hud = el('div', 'hud');
  const hudMsg = el('span', 'hud-msg');
  hud.append(el('span', 'hud-item', 'Battle sandbox'), hudMsg);

  const roster = el('div', 'row sandbox-roster');
  roster.append(el('span', 'label', 'Add:'));

  const sides = { left: el('div', 'sandbox-side'), right: el('div', 'sandbox-side') };

  const rulesRow = el('div', 'row');
  const maxSecondsInput = el('input', 'input');
  maxSecondsInput.type = 'number';
  maxSecondsInput.placeholder = 'max seconds (default)';
  maxSecondsInput.min = '0';
  const overtimeLabel = el('label', 'label');
  const overtimeCheckbox = el('input');
  overtimeCheckbox.type = 'checkbox';
  overtimeLabel.append(overtimeCheckbox, document.createTextNode(' overtime'));
  rulesRow.append(el('span', 'label', 'Rules:'), maxSecondsInput, overtimeLabel);
  maxSecondsInput.addEventListener('change', () => {
    const v = numberOrNull(maxSecondsInput);
    cb.onSetRules(v === null ? { maxSeconds: undefined } : { maxSeconds: v });
  });
  overtimeCheckbox.addEventListener('change', () => cb.onSetRules({ overtime: overtimeCheckbox.checked }));

  const runRow = el('div', 'row');
  const seedInput = el('input', 'input');
  seedInput.type = 'number';
  seedInput.min = '0';
  const nInput = el('input', 'input');
  nInput.type = 'number';
  nInput.min = '1';
  const btnRunOnce = el('button', 'btn btn-primary', 'Run once');
  const btnReplay = el('button', 'btn', 'Replay');
  const btnRunN = el('button', 'btn', 'Run N');
  const speedGroup = el('span', 'speed');
  const speedButtons = [1, 2, 4].map((s) => {
    const b = el('button', 'btn btn-speed', `${s}x`);
    b.dataset['speed'] = String(s);
    b.addEventListener('click', () => cb.onSpeed(s));
    return b;
  });
  speedGroup.append(...speedButtons);
  seedInput.addEventListener('change', () => cb.onSetSeed(Math.max(0, Math.round(Number(seedInput.value) || 0))));
  nInput.addEventListener('change', () => cb.onSetN(Math.max(1, Math.round(Number(nInput.value) || 1))));
  btnRunOnce.addEventListener('click', () => cb.onRunOnce());
  btnReplay.addEventListener('click', () => cb.onReplay());
  btnRunN.addEventListener('click', () => cb.onRunN());
  runRow.append(el('span', 'label', 'Seed'), seedInput, el('span', 'label', 'N'), nInput, btnRunOnce, btnReplay, btnRunN, speedGroup);

  const saveRow = el('div', 'row');
  const saveNameInput = el('input', 'input');
  saveNameInput.placeholder = 'name (a-z 0-9 - _)';
  const btnSave = el('button', 'btn', 'Save');
  const btnLoad = el('button', 'btn', 'Load');
  const btnBack = el('button', 'btn', 'Back to title');
  btnSave.addEventListener('click', () => cb.onSave(saveNameInput.value.trim()));
  btnLoad.addEventListener('click', () => cb.onLoad(saveNameInput.value.trim()));
  btnBack.addEventListener('click', () => cb.onBack());
  saveRow.append(el('span', 'label', 'Setup name'), saveNameInput, btnSave, btnLoad, btnBack);

  const results = el('pre', 'summary sandbox-results');
  results.hidden = true;

  root.append(hud, roster, sides.left, sides.right, rulesRow, runRow, saveRow, results);
  parent.appendChild(root);

  function renderRoster(content: Content): void {
    roster.querySelectorAll('.sandbox-roster-unit').forEach((n) => n.remove());
    for (const def of content.units) {
      const group = el('span', 'sandbox-roster-unit');
      const addLeft = el('button', 'btn', `+L ${def.name}`);
      const addRight = el('button', 'btn', `+R ${def.name}`);
      addLeft.addEventListener('click', () => cb.onAddUnit('left', def.id));
      addRight.addEventListener('click', () => cb.onAddUnit('right', def.id));
      group.append(addLeft, addRight);
      roster.appendChild(group);
    }
  }

  function renderSide(side: SandboxSide, content: Content, units: readonly SandboxUnit[], playing: boolean, selected: { side: SandboxSide; index: number } | null): void {
    const container = sides[side];
    container.replaceChildren(el('span', 'label', side === 'left' ? 'Left:' : 'Right:'));
    const maxStar = content.rules.economy.maxStar;
    units.forEach((u, index) => {
      const def = content.unitsById[u.defId];
      const row = el('div', 'row sandbox-unit');
      row.classList.toggle('selected', selected !== null && selected.side === side && selected.index === index);
      const name = el('span', 'card-name', def?.name ?? u.defId);
      name.addEventListener('click', () => cb.onSelectUnit(side, index));
      row.append(name);

      const starInput = el('input', 'input');
      starInput.type = 'number';
      starInput.min = '1';
      starInput.max = String(maxStar);
      starInput.value = String(u.star);
      starInput.disabled = playing;
      starInput.addEventListener('change', () => cb.onSetStar(side, index, Math.max(1, Math.min(maxStar, Math.round(Number(starInput.value) || 1)))));
      row.append(el('span', 'label', 'star'), starInput);

      for (const stat of STAT_NAMES) {
        const statInput = el('input', 'input sandbox-stat');
        statInput.type = 'number';
        statInput.placeholder = stat;
        statInput.title = stat;
        statInput.disabled = playing;
        if (u.statOverrides[stat] !== undefined) statInput.value = String(u.statOverrides[stat]);
        statInput.addEventListener('change', () => cb.onSetStatOverride(side, index, stat, numberOrNull(statInput)));
        row.append(statInput);
      }

      const itemsInput = el('input', 'input');
      itemsInput.placeholder = 'items (comma-separated)';
      itemsInput.value = u.items.join(',');
      itemsInput.disabled = playing;
      itemsInput.addEventListener('change', () => {
        const items = itemsInput.value
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        cb.onSetItems(side, index, items);
      });
      row.append(itemsInput);

      const btnRemove = el('button', 'btn', '×');
      btnRemove.disabled = playing;
      btnRemove.addEventListener('click', () => cb.onRemoveUnit(side, index));
      row.append(btnRemove);

      container.appendChild(row);
    });
  }

  function formatAggregate(a: SandboxResult): string {
    const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
    const lines = [
      `${a.fights} fights   win rate  left ${pct(a.winRate.left)}  right ${pct(a.winRate.right)}  draw ${pct(a.winRate.draw)}`,
      `mean ticks ${a.meanTicks.toFixed(1)}   p95 ticks ${a.p95Ticks}`,
      '',
      'unit                 dealt    taken   healed  deaths',
    ];
    for (const u of a.units) {
      const name = `${u.side}#${u.index} ${u.defId}`.padEnd(20);
      lines.push(`${name} ${u.dealt.toFixed(0).padStart(8)} ${u.taken.toFixed(0).padStart(8)} ${u.healed.toFixed(0).padStart(8)} ${String(u.deaths).padStart(7)}`);
    }
    return lines.join('\n');
  }

  let lastContent: Content | null = null;
  let pendingView: SandboxUiView | null = null;

  /**
   * Rendering a side rebuilds its rows with `replaceChildren` (P0-09's bench-card pattern), but
   * unlike the bench a stat/star/items edit fires from a `change` (blur) listener on an input
   * inside that very row, so rebuilding synchronously removes a node still mid-dispatch and
   * throws ("node ... no longer a child ... moved in a blur event handler", caught live-testing
   * this screen). Deferring to a microtask lets the browser finish the blur/change dispatch
   * first; multiple onChange calls in one task collapse into the one queued render.
   */
  function update(view: SandboxUiView): void {
    const first = pendingView === null;
    pendingView = view;
    if (first) queueMicrotask(applyUpdate);
  }

  function applyUpdate(): void {
    const view = pendingView as SandboxUiView;
    pendingView = null;
    if (lastContent !== view.content) {
      lastContent = view.content;
      renderRoster(view.content);
    }
    hudMsg.textContent = view.message;
    renderSide('left', view.content, sideList(view.setup, 'left'), view.isPlaying, view.selected);
    renderSide('right', view.content, sideList(view.setup, 'right'), view.isPlaying, view.selected);

    if (document.activeElement !== maxSecondsInput) maxSecondsInput.value = view.setup.rules.maxSeconds === undefined ? '' : String(view.setup.rules.maxSeconds);
    overtimeCheckbox.checked = view.setup.rules.overtime === true;

    if (document.activeElement !== seedInput) seedInput.value = String(view.seed);
    if (document.activeElement !== nInput) nInput.value = String(view.n);
    for (const b of speedButtons) b.classList.toggle('active', Number(b.dataset['speed']) === view.speed);

    const empty = view.setup.left.length === 0 && view.setup.right.length === 0;
    btnRunOnce.disabled = view.isPlaying || empty;
    btnRunN.disabled = view.isPlaying || empty;
    btnReplay.disabled = view.isPlaying || !view.canReplay;

    if (view.lastAggregate) {
      results.hidden = false;
      results.textContent = formatAggregate(view.lastAggregate);
    } else {
      results.hidden = true;
    }
  }

  return { root, update };
}
