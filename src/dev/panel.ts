// F2 dev panel (P0-16): one button per `dev:` Command, plus the seed and content hash a bug
// report should quote. DOM only — every button dispatches through the app's normal command
// dispatch, so a cheat is an ordinary entry in the command log. Loaded through the dev chunk,
// so production carries none of it.
import type { DevCommand } from '../sim/devCommands.ts';
import type { Cell } from '../sim/hex.ts';
import { defaultPanelModel, devPanelButtons, devPanelInfoLines, PANEL_ROWS, syncPanelModel, type DevPanelGroup, type DevPanelInfo, type DevPanelModel } from './panelModel.ts';

export interface DevPanelUnit {
  id: string;
  name: string;
  cost: number;
}

/** What the app's dispatch reports back; the panel never inspects sim state itself. */
export interface DevDispatchResult {
  ok: boolean;
  reason: string | null;
}

export interface DevPanelDeps {
  /** The app's normal dispatch: validates through the sim and reports the rejection reason. */
  dispatch(cmd: DevCommand): DevDispatchResult;
  units: readonly DevPanelUnit[];
  maxStar: number;
  tiers: number;
  /** Player-half cells a unit may be spawned onto. */
  cells: readonly Cell[];
  /** Combat FX toggle (P0-30): client-only, never a Command — toggling it cannot change a hash,
   *  so it lives outside the dispatch path every other control in this panel goes through. */
  fx: { get(): boolean; set(enabled: boolean): void };
}

export interface DevPanel {
  root: HTMLElement;
  toggle(): void;
  setVisible(v: boolean): void;
  isVisible(): boolean;
  update(info: DevPanelInfo): void;
}

const PANEL_CSS = `
#dev-panel { position: absolute; top: 8px; right: 8px; width: 260px; padding: 8px; z-index: 21;
  background: rgba(0, 0, 0, 0.82); color: #e5e7eb; border: 1px solid #334155; border-radius: 6px;
  font: 12px ui-monospace, Consolas, monospace; display: flex; flex-direction: column; gap: 6px; }
#dev-panel[hidden] { display: none; }
#dev-panel pre { margin: 0; color: #a7f3d0; white-space: pre; }
#dev-panel .dev-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
#dev-panel .dev-label { color: #94a3b8; min-width: 42px; }
#dev-panel button { font: inherit; padding: 2px 6px; cursor: pointer; background: #1e293b;
  color: #e5e7eb; border: 1px solid #475569; border-radius: 3px; }
#dev-panel button:hover { background: #334155; }
#dev-panel select, #dev-panel input { font: inherit; background: #0f172a; color: #e5e7eb;
  border: 1px solid #475569; border-radius: 3px; padding: 1px 3px; min-width: 0; }
#dev-panel input { width: 96px; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createDevPanel(parent: HTMLElement, deps: DevPanelDeps): DevPanel {
  const style = document.createElement('style');
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);

  const model: DevPanelModel = defaultPanelModel(deps.units[0]?.id ?? '');
  const root = el('div', undefined);
  root.id = 'dev-panel';
  root.hidden = true;

  const info = el('pre');
  const title = el('div', 'dev-label', 'DEV PANEL (F2)');

  // Inputs first: the buttons read the model these write.
  const selUnit = el('select');
  for (const u of deps.units) selUnit.append(new Option(`${u.name} (${u.cost})`, u.id));
  selUnit.value = model.unitId;
  selUnit.addEventListener('change', () => {
    model.unitId = selUnit.value;
    render();
  });
  const selStar = el('select');
  for (let s = 1; s <= deps.maxStar; s++) selStar.append(new Option(`${s}★`, String(s)));
  selStar.addEventListener('change', () => {
    model.star = Number.parseInt(selStar.value, 10);
    render();
  });
  const selCell = el('select');
  selCell.append(new Option('bench', 'bench'));
  for (const c of deps.cells) selCell.append(new Option(`${c.col},${c.row}`, `${c.col},${c.row}`));
  selCell.addEventListener('change', () => {
    const v = selCell.value;
    if (v === 'bench') model.cell = null;
    else {
      const [col, row] = v.split(',').map((n) => Number.parseInt(n, 10));
      model.cell = { col: col as number, row: row as number };
    }
    render();
  });
  const selTier = el('select');
  for (let t = 1; t <= deps.tiers; t++) selTier.append(new Option(`tier ${t}`, String(t)));
  selTier.addEventListener('change', () => {
    model.tier = Number.parseInt(selTier.value, 10);
    render();
  });
  const inpAugment = el('input');
  inpAugment.placeholder = 'augment id';
  inpAugment.value = model.augmentId;
  inpAugment.addEventListener('input', () => {
    model.augmentId = inpAugment.value;
  });
  const inpItem = el('input');
  inpItem.placeholder = 'item id';
  inpItem.value = model.itemId;
  inpItem.addEventListener('input', () => {
    model.itemId = inpItem.value;
  });
  const chkFx = el('input');
  chkFx.type = 'checkbox';
  chkFx.checked = deps.fx.get();
  chkFx.addEventListener('change', () => deps.fx.set(chkFx.checked));

  // One row per group, each keeping a fixed number of leading nodes (its caption) across
  // rebuilds. Typed by group, so adding a group without a row fails the build.
  const rows = {} as Record<DevPanelGroup, { el: HTMLElement; keep: number }>;
  for (const row of PANEL_ROWS) {
    const div = el('div', 'dev-row');
    if (row.label !== null) div.append(el('span', 'dev-label', row.label));
    rows[row.group] = { el: div, keep: row.label === null ? 0 : 1 };
  }

  /** Rebuilds the buttons from the model so their labels track the toggles and selections. */
  function render(): void {
    for (const row of Object.values(rows)) {
      while (row.el.childNodes.length > row.keep) row.el.removeChild(row.el.lastChild as ChildNode);
    }
    for (const btn of devPanelButtons(model)) {
      const b = el('button', undefined, btn.label);
      b.dataset.devButton = btn.id;
      // The sim decides: a click dispatches and the toggles are re-read from the run in
      // update(), so a rejected command never leaves a label claiming a cheat is on.
      b.addEventListener('click', () => {
        deps.dispatch(btn.command);
      });
      rows[btn.group].el.append(b);
    }
  }
  render();

  const spawnRow = el('div', 'dev-row');
  spawnRow.append(el('span', 'dev-label', 'spawn'), selUnit, selStar, selCell);
  const shopRow = el('div', 'dev-row');
  shopRow.append(el('span', 'dev-label', 'shop'), selTier);
  const idRow = el('div', 'dev-row');
  idRow.append(el('span', 'dev-label', 'ids'), inpAugment, inpItem);
  const fxRow = el('div', 'dev-row');
  fxRow.append(el('span', 'dev-label', 'fx'), chkFx);

  root.append(title, info, rows.gold.el, rows.xp.el, rows.toggles.el, shopRow, rows.round.el, spawnRow, idRow, fxRow, rows.content.el);
  parent.appendChild(root);

  let last = '';
  let lastInfo: DevPanelInfo | null = null;

  function paint(next: DevPanelInfo): void {
    lastInfo = next;
    if (syncPanelModel(model, next)) render();
    if (root.hidden) return;
    const text = devPanelInfoLines(next).join('\n');
    if (text !== last) {
      info.textContent = text;
      last = text;
    }
  }

  return {
    root,
    toggle() {
      root.hidden = !root.hidden;
      if (!root.hidden && lastInfo) paint(lastInfo);
    },
    setVisible(v) {
      root.hidden = !v;
      if (!root.hidden && lastInfo) paint(lastInfo);
    },
    isVisible() {
      return !root.hidden;
    },
    update(next) {
      paint(next);
    },
  };
}
