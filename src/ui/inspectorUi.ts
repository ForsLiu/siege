// DOM panel for the unit inspector (P0-20): a thin binding over the P0-19 InspectorModel. Reads
// only; every value it shows comes from the model it is given.
import type { InspectorModel } from '../app/inspectorModel.ts';

export interface InspectorUi {
  root: HTMLElement;
  update(model: InspectorModel | null): void;
}

export interface InspectorUiCallbacks {
  onClose(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export function createInspectorUi(parent: HTMLElement, cb: InspectorUiCallbacks): InspectorUi {
  const root = el('div', 'inspector-panel');
  root.hidden = true;

  const header = el('div', 'inspector-header');
  const title = el('span', 'inspector-title');
  const closeBtn = el('button', 'btn inspector-close', '×');
  closeBtn.addEventListener('click', () => cb.onClose());
  header.append(title, closeBtn);

  const meta = el('div', 'inspector-meta');
  const abilityBox = el('div', 'inspector-ability');
  const statsList = el('div', 'inspector-stats');
  const itemsLine = el('div', 'inspector-items');
  const manaLine = el('div', 'inspector-mana');
  const combatLine = el('div', 'inspector-combat');

  root.append(header, meta, abilityBox, statsList, manaLine, combatLine, itemsLine);
  parent.appendChild(root);

  function update(model: InspectorModel | null): void {
    root.hidden = model === null;
    if (!model) return;

    title.textContent = model.star > 1 ? `${model.name} ${'★'.repeat(model.star)}` : model.name;
    meta.textContent = model.uid === null ? `Cost ${model.cost}g` : `Cost ${model.cost}g · uid ${model.uid}`;

    abilityBox.textContent = model.ability ? `${model.ability.name}: ${model.ability.text}` : '';
    abilityBox.hidden = !model.ability;

    statsList.replaceChildren();
    for (const s of model.stats) {
      const row = el('div', 'inspector-stat');
      const sources = s.sources.length ? ` (${s.sources.map((m) => m.source).join(', ')})` : '';
      const value = s.current === s.base ? `${round1(s.current)}` : `${round1(s.current)} (base ${round1(s.base)})`;
      row.textContent = `${s.stat}: ${value}${sources}`;
      statsList.appendChild(row);
    }

    itemsLine.textContent = model.items.length ? `Items: ${model.items.join(', ')}` : 'Items: none';
    manaLine.textContent = `Mana ${model.mana.current}/${model.mana.max}`;

    if (model.combat) {
      combatLine.hidden = false;
      combatLine.textContent = `HP ${round1(model.combat.hp)}/${round1(model.combat.maxHp)}${model.combat.shields > 0 ? ` · Shield ${round1(model.combat.shields)}` : ''}`;
    } else {
      combatLine.hidden = true;
    }
  }

  return { root, update };
}
