// DOM overlays for a run: HUD, shop, bench, controls. Everything the player does becomes a Command.
import type { Command } from '../sim/commands.ts';
import { validateCommand } from '../sim/commands.ts';
import type { Content } from '../sim/rules.ts';
import { sellValue, xpNeeded, type RunState } from '../sim/run.ts';

export type RunUiMode = 'planning' | 'combat' | 'reward';

export interface RunUiView {
  state: RunState;
  content: Content;
  mode: RunUiMode;
  selectedUid: number | null;
  speed: number;
  message: string;
}

export interface RunUiCallbacks {
  onCommand(cmd: Command): void;
  onSelect(uid: number | null): void;
  onSpeed(speed: number): void;
  onPause(): void;
}

export interface RunUi {
  root: HTMLElement;
  update(view: RunUiView): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createRunUi(parent: HTMLElement, cb: RunUiCallbacks): RunUi {
  const root = el('div', 'run-ui');
  parent.appendChild(root);

  const hud = el('div', 'hud');
  const hudRound = el('span', 'hud-item');
  const hudHp = el('span', 'hud-item');
  const hudGold = el('span', 'hud-item');
  const hudLevel = el('span', 'hud-item');
  const hudTeam = el('span', 'hud-item');
  const hudMsg = el('span', 'hud-msg');
  hud.append(hudRound, hudHp, hudGold, hudLevel, hudTeam, hudMsg);

  const controls = el('div', 'controls');
  const btnReroll = el('button', 'btn', 'Reroll');
  const btnXp = el('button', 'btn', 'Buy XP');
  const btnSell = el('button', 'btn', 'Sell');
  const btnStart = el('button', 'btn btn-primary', 'Start combat');
  const speedGroup = el('span', 'speed');
  const speedButtons = [1, 2, 4].map((s) => {
    const b = el('button', 'btn btn-speed', `${s}x`);
    b.dataset['speed'] = String(s);
    b.addEventListener('click', () => cb.onSpeed(s));
    return b;
  });
  speedGroup.append(...speedButtons);
  const btnPause = el('button', 'btn', 'Pause (Esc)');
  controls.append(btnReroll, btnXp, btnSell, btnStart, speedGroup, btnPause);

  const shop = el('div', 'shop');
  const bench = el('div', 'bench');
  root.append(hud, shop, bench, controls);

  let current: RunUiView | null = null;
  btnReroll.addEventListener('click', () => cb.onCommand({ type: 'reroll' }));
  btnXp.addEventListener('click', () => cb.onCommand({ type: 'levelUp' }));
  btnSell.addEventListener('click', () => {
    if (current?.selectedUid !== null && current?.selectedUid !== undefined) cb.onCommand({ type: 'sell', uid: current.selectedUid });
  });
  btnStart.addEventListener('click', () => {
    if (!current) return;
    if (current.mode === 'reward') cb.onCommand({ type: 'nextRound' });
    else if (current.mode === 'planning') cb.onCommand({ type: 'startCombat' });
  });
  btnPause.addEventListener('click', () => cb.onPause());

  function update(view: RunUiView): void {
    current = view;
    const { state, content, mode } = view;
    const eco = content.rules.economy;
    hudRound.textContent = `Round ${state.round}/${content.encounters.length}`;
    hudHp.textContent = `HP ${state.hp}`;
    hudGold.textContent = `Gold ${state.gold}`;
    const need = xpNeeded(state.level, content);
    hudLevel.textContent = state.level >= eco.maxLevel ? `Level ${state.level} (max)` : `Level ${state.level}  XP ${state.xp}/${need}`;
    hudTeam.textContent = `Team ${state.board.length}/${state.level}`;
    hudMsg.textContent = view.message;

    const planning = mode === 'planning';
    btnReroll.disabled = !planning || validateCommand(state, { type: 'reroll' }, content) !== null;
    btnReroll.textContent = `Reroll (${eco.rerollCost}g)`;
    btnXp.disabled = !planning || validateCommand(state, { type: 'levelUp' }, content) !== null;
    btnXp.textContent = `Buy XP (${eco.xpCost}g)`;
    const sel = view.selectedUid;
    const selUnit = sel === null ? null : [...state.board, ...state.bench].find((u) => u && u.uid === sel) ?? null;
    btnSell.disabled = !planning || !selUnit;
    btnSell.textContent = selUnit ? `Sell (${sellValue(selUnit, content)}g)` : 'Sell';
    btnStart.disabled = mode === 'combat';
    btnStart.textContent = mode === 'reward' ? 'Next round' : mode === 'combat' ? 'Fighting...' : 'Start combat';
    for (const b of speedButtons) b.classList.toggle('active', Number(b.dataset['speed']) === view.speed);

    shop.replaceChildren();
    state.shop.forEach((defId, slot) => {
      const card = el('button', 'card shop-card');
      if (defId) {
        const def = content.unitsById[defId];
        card.append(el('div', 'card-name', def?.name ?? defId), el('div', 'card-cost', `${def?.cost ?? '?'}g`));
        card.disabled = !planning || validateCommand(state, { type: 'buy', slot }, content) !== null;
        card.addEventListener('click', () => cb.onCommand({ type: 'buy', slot }));
      } else {
        card.classList.add('empty');
        card.disabled = true;
        card.textContent = '—';
      }
      shop.appendChild(card);
    });

    bench.replaceChildren();
    state.bench.forEach((unit) => {
      const card = el('button', 'card bench-card');
      if (unit) {
        const def = content.unitsById[unit.defId];
        card.append(el('div', 'card-name', def?.name ?? unit.defId), el('div', 'card-star', '★'.repeat(unit.star)));
        card.classList.toggle('selected', view.selectedUid === unit.uid);
        card.disabled = !planning;
        card.addEventListener('click', () => cb.onSelect(view.selectedUid === unit.uid ? null : unit.uid));
      } else {
        card.classList.add('empty');
        card.disabled = true;
      }
      bench.appendChild(card);
    });
  }

  return { root, update };
}
