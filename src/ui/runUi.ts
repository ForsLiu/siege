// DOM overlays for a run: HUD, shop, bench, controls. Everything the player does becomes a Command.
import type { Command } from '../sim/commands.ts';
import { validateCommand } from '../sim/commands.ts';
import type { Content } from '../sim/rules.ts';
import { incomePreview, roundTrack, sellValue, xpNeeded, type IncomePreview, type RoundTrackEntry, type RunState } from '../sim/run.ts';

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
  /** Mouse-down on a bench card: the app picks the unit up and resolves the drop on the board. */
  onDragStart(uid: number): void;
  onSpeed(speed: number): void;
  onPause(): void;
  /** A shop card is hovered (defId) or un-hovered (null): shop offers have no uid to select, so
   *  the inspector (P0-20) previews them on hover instead of stealing the card's click (buy). */
  onHoverShop(defId: string | null): void;
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

/**
 * The P0-21 gold breakdown as text: every number comes straight from `incomePreview` (the sim)
 * or is read verbatim off `content.rules.economy` for the interest/win-bonus rule labels ("1g per
 * 10, max 5") — this function only arranges strings, it never adds or derives a gold amount.
 * `resolved` is true in the reward phase (the win bonus and total are the actual grant); false
 * before combat (the win bonus isn't decided yet, so `preview.winBonus` is 0 and the rule value
 * is shown separately as a "+N more on a win" note, not folded into the total).
 */
function incomeLine(preview: IncomePreview, content: Content, resolved: boolean): string {
  const eco = content.rules.economy;
  const parts = [`+${preview.base} base`, `+${preview.interest} interest (1g per ${eco.interest.per}, max ${eco.interest.max})`];
  if (resolved) parts.push(`+${preview.winBonus} win`);
  if (preview.streakBonus !== 0) parts.push(`+${preview.streakBonus} streak`);
  parts.push(`+${preview.encounterGold} encounter`);
  const note = !resolved && eco.winBonus > 0 ? ` (+${eco.winBonus} more on a win)` : '';
  return `${parts.join(', ')} = +${preview.total}${note}`;
}

/** One-letter round-track icon per encounter type (P0-22); no art asset pipeline exists yet, so
 *  a coloured letter (styled per `.track-<type>` in style.css) stands in for a real icon. */
function trackIcon(type: RoundTrackEntry['type']): string {
  return type[0]!.toUpperCase();
}

/** Hover tooltip text for a round-track cell: read straight off `RoundTrackEntry.rewardPreview`. */
function trackTooltip(entry: RoundTrackEntry): string {
  const r = entry.rewardPreview;
  const parts = [`Round ${entry.round} (${entry.type})`, `+${r.gold} gold, +${r.xp} xp`];
  if (r.items.length > 0) parts.push(`items: ${r.items.join(', ')}`);
  if (r.augmentOffer) parts.push('augment offer');
  return parts.join(' — ');
}

/** Round-end summary lines (P0-21 §5): result, hp lost, rewards line by line, next round. */
function summaryLines(state: RunState, content: Content): string[] {
  const record = state.history[state.history.length - 1] ?? null;
  const lines: string[] = [];
  if (record) {
    const verdict = record.fight ? (record.fight.winner === 'left' ? 'Victory' : record.fight.winner === 'right' ? 'Defeat' : 'Draw') : 'Skipped (win)';
    lines.push(record.fight && record.fight.hpLoss > 0 ? `${verdict} — lost ${record.fight.hpLoss} hp` : verdict);
  }
  const preview = incomePreview(state, content);
  const eco = content.rules.economy;
  lines.push(`Base income: +${preview.base}`);
  lines.push(`Interest (1g per ${eco.interest.per}, max ${eco.interest.max}): +${preview.interest}`);
  lines.push(`Win bonus: +${preview.winBonus}`);
  if (preview.streakBonus !== 0) lines.push(`Streak bonus: +${preview.streakBonus}`);
  lines.push(`Encounter reward: +${preview.encounterGold} gold, +${eco.xpPerRound} xp`);
  lines.push(`Total: +${preview.total} gold`);
  const next = content.encounters[state.round] ?? null;
  lines.push(next ? `Next: round ${state.round + 1} — ${next.type}` : `Next: round ${state.round + 1} — the run ends here`);
  return lines;
}

export function createRunUi(parent: HTMLElement, cb: RunUiCallbacks): RunUi {
  const root = el('div', 'run-ui');
  parent.appendChild(root);

  const track = el('div', 'round-track');

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

  const goldBreakdown = el('div', 'gold-breakdown');
  const roundSummary = el('div', 'round-summary');
  roundSummary.hidden = true;

  const shop = el('div', 'shop');
  const bench = el('div', 'bench');
  root.append(track, hud, goldBreakdown, roundSummary, shop, bench, controls);

  // Hover is delegated to the stable `shop` container, not the per-card buttons: those are
  // rebuilt by `replaceChildren()` on every buy/reroll, and a card removed out from under the
  // pointer never fires its own `mouseleave`, which would otherwise leave the inspector's shop
  // preview stuck open (found live-testing this screen).
  shop.addEventListener('mousemove', (e) => {
    const card = (e.target as HTMLElement).closest('.shop-card') as HTMLElement | null;
    cb.onHoverShop(card && !card.classList.contains('empty') ? (card.dataset['defid'] ?? null) : null);
  });
  shop.addEventListener('mouseleave', () => cb.onHoverShop(null));

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

    track.replaceChildren(
      ...roundTrack(state.round, content).map((entry) => {
        const cell = el('div', `track-cell track-${entry.type}`, trackIcon(entry.type));
        cell.classList.toggle('current', entry.isCurrent);
        cell.classList.toggle('past', entry.isPast);
        cell.title = trackTooltip(entry);
        return cell;
      }),
    );

    if (mode === 'reward') {
      goldBreakdown.hidden = true;
      roundSummary.hidden = false;
      roundSummary.replaceChildren(...summaryLines(state, content).map((line) => el('div', 'round-summary-line', line)));
    } else {
      roundSummary.hidden = true;
      goldBreakdown.hidden = mode !== 'planning';
      if (mode === 'planning') goldBreakdown.textContent = `Next round: ${incomeLine(incomePreview(state, content), content, false)}`;
    }

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
        card.dataset['defid'] = defId;
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
        card.addEventListener('mousedown', () => cb.onDragStart(unit.uid));
      } else {
        card.classList.add('empty');
        card.disabled = true;
      }
      bench.appendChild(card);
    });
  }

  return { root, update };
}
