// DOM overlays for a run: HUD, shop, bench, controls. Everything the player does becomes a Command.
import type { Command } from '../sim/commands.ts';
import { validateCommand } from '../sim/commands.ts';
import type { Content } from '../sim/rules.ts';
import { incomePreview, roundTrack, sellValue, shopHudModel, type IncomePreview, type RoundTrackEntry, type RunState } from '../sim/run.ts';
import { traitPanelModel, type TraitPanelEntry } from '../app/traitPanelModel.ts';

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
  /** Mouse-down on an item-bench card (P0-29): the app picks the item up and resolves the drop
   *  (equip, or combine into a completed item) on the unit it lands on. */
  onItemDragStart(benchIndex: number): void;
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

/** "3 / 2 4 6" — current holder count, then every breakpoint's threshold, space-separated. */
function traitCountText(entry: TraitPanelEntry): string {
  return `${entry.count} / ${entry.breakpoints.map((bp) => bp.count).join(' ')}`;
}

/** Hover tooltip: the effect text per breakpoint (reached one marked) and the contributing units. */
function traitTooltip(entry: TraitPanelEntry): string {
  const lines = [entry.description, ...entry.breakpoints.map((bp) => `${bp.reached ? '> ' : ''}${bp.count}: ${bp.text}`)];
  if (entry.holderNames.length > 0) lines.push(`Units: ${entry.holderNames.join(', ')}`);
  return lines.join('\n');
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
  if (preview.items.length > 0) lines.push(`Loot: ${preview.items.map((id) => content.itemsById[id]?.name ?? id).join(', ')}`);
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
  const hudLevel = el('div', 'hud-item hud-level');
  const hudLevelText = el('span', 'level-text');
  const xpBar = el('div', 'xp-bar');
  const xpBarFill = el('div', 'xp-bar-fill');
  xpBar.appendChild(xpBarFill);
  const shopOdds = el('div', 'shop-odds');
  hudLevel.append(hudLevelText, xpBar, shopOdds);
  const hudTeam = el('span', 'hud-item');
  const augmentBadges = el('div', 'augment-badges');
  const hudMsg = el('span', 'hud-msg');
  hud.append(hudRound, hudHp, hudGold, hudLevel, hudTeam, augmentBadges, hudMsg);

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
  const augmentOffer = el('div', 'augment-offer');
  augmentOffer.hidden = true;
  const lootOffer = el('div', 'loot-offer');
  lootOffer.hidden = true;

  const traitPanel = el('div', 'trait-panel');

  const shop = el('div', 'shop');
  const bench = el('div', 'bench');
  const itemBench = el('div', 'item-bench');
  root.append(track, hud, traitPanel, goldBreakdown, roundSummary, augmentOffer, lootOffer, shop, bench, itemBench, controls);

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
    hudRound.textContent = `Round ${state.round}/${content.encounters.length}`;
    hudHp.textContent = `HP ${state.hp}`;
    hudGold.textContent = `Gold ${state.gold}`;
    const shopModel = shopHudModel(state, content);
    hudLevelText.textContent = shopModel.xpNeeded === null ? `Level ${shopModel.level} (max)` : `Level ${shopModel.level}  XP ${shopModel.xp}/${shopModel.xpNeeded}`;
    xpBarFill.style.width = `${Math.round(shopModel.xpProgress * 100)}%`;
    shopOdds.replaceChildren(
      ...shopModel.odds.map((row) => el('span', `odds-chip cost-tier-${row.tier}`, `${row.percent}%`)),
    );
    hudTeam.textContent = `Team ${state.board.length}/${state.level}`;
    augmentBadges.replaceChildren(
      ...state.augments.map((id) => {
        const def = content.augmentsById[id];
        const badge = el('span', 'augment-badge', def ? def.name[0]!.toUpperCase() : '?');
        badge.title = def ? `${def.name}: ${def.description}` : id;
        return badge;
      }),
    );
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

    traitPanel.replaceChildren(
      ...traitPanelModel(state.board, content).map((entry) => {
        const row = el('div', 'trait-row');
        row.classList.toggle('active', entry.breakpoints.some((bp) => bp.reached));
        row.title = traitTooltip(entry);
        row.append(el('span', 'trait-icon', entry.icon), el('span', 'trait-name', entry.name), el('span', 'trait-count', traitCountText(entry)));
        return row;
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

    const offer = mode === 'planning' ? state.augmentOffer : null;
    augmentOffer.hidden = offer === null;
    if (offer) {
      augmentOffer.replaceChildren(
        ...offer.map((id) => {
          const def = content.augmentsById[id];
          const card = el('button', 'card augment-card');
          card.title = def?.description ?? '';
          card.append(el('div', 'card-name', def?.name ?? id), el('div', 'card-desc', def?.description ?? ''));
          card.addEventListener('click', () => cb.onCommand({ type: 'pickAugment', augmentId: id }));
          return card;
        }),
      );
    }

    const loot = mode === 'reward' ? state.lootOffer : null;
    lootOffer.hidden = loot === null;
    if (loot) {
      lootOffer.replaceChildren(
        ...loot.map((id) => {
          const def = content.itemsById[id];
          const card = el('button', 'card loot-card');
          card.append(el('div', 'card-name', def?.name ?? id));
          card.addEventListener('click', () => cb.onCommand({ type: 'pickLoot', itemId: id }));
          return card;
        }),
      );
    }

    const planning = mode === 'planning';
    btnReroll.disabled = !planning || validateCommand(state, { type: 'reroll' }, content) !== null;
    btnReroll.textContent = `Reroll (${shopModel.rerollCost}g)`;
    btnXp.disabled = !planning || validateCommand(state, { type: 'levelUp' }, content) !== null;
    btnXp.textContent = `Buy XP (${shopModel.xpCost}g)`;
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
        if (def) card.classList.add(`cost-tier-${def.cost}`);
        card.append(el('div', 'card-name', def?.name ?? defId), el('div', 'card-cost', `${def?.cost ?? '?'}g`));
        if (def && def.traits.length > 0) {
          const tags = el('div', 'card-traits');
          tags.append(
            ...def.traits.map((id) => {
              const trait = content.traitsById[id];
              const tag = el('span', 'trait-tag', trait ? trait.name[0]!.toUpperCase() : '?');
              tag.title = trait ? `${trait.name}: ${trait.description}` : id;
              return tag;
            }),
          );
          card.appendChild(tags);
        }
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
        card.dataset['uid'] = String(unit.uid);
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

    itemBench.replaceChildren();
    state.itemBench.forEach((itemId, index) => {
      const def = content.itemsById[itemId];
      const card = el('button', `card item-card item-${def?.kind ?? 'component'}`);
      card.append(el('div', 'card-name', def?.name ?? itemId));
      card.disabled = !planning;
      card.addEventListener('mousedown', () => cb.onItemDragStart(index));
      itemBench.appendChild(card);
    });
  }

  return { root, update };
}
