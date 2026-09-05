// Pure model behind the F2 dev panel (P0-16): which buttons exist and which sim Command each
// one dispatches. No DOM here, so the fast tier can prove every button maps to a legal
// `dev:` Command; src/dev/panel.ts is the thin DOM layer over this.
import type { DevCommand } from '../sim/devCommands.ts';
import type { Cell } from '../sim/hex.ts';

/** Panel-local selections. Not sim state: nothing here is hashed or replayed. */
export interface DevPanelModel {
  invinciblePieces: boolean;
  invinciblePlayer: boolean;
  /** Unit id for `dev:spawnUnit`; empty when the roster is empty. */
  unitId: string;
  star: number;
  /** Spawn destination: a player-half cell, or null for the bench. */
  cell: Cell | null;
  /** Cost tier for `dev:openShop`. */
  tier: number;
  augmentId: string;
  itemId: string;
}

export type DevPanelGroup = 'gold' | 'xp' | 'toggles' | 'round' | 'content';

/** One row of buttons in display order; `label` is the fixed leading caption, if any. */
export interface DevPanelRow {
  group: DevPanelGroup;
  label: string | null;
}

export const PANEL_ROWS: readonly DevPanelRow[] = [
  { group: 'gold', label: 'gold' },
  { group: 'xp', label: 'xp' },
  { group: 'toggles', label: null },
  { group: 'round', label: null },
  { group: 'content', label: null },
];

export interface DevPanelButton {
  id: string;
  label: string;
  group: DevPanelGroup;
  command: DevCommand;
}

/** Amounts the owner asked for (feedback/processed/2026-09-05-01-dev-modes.md §A). */
export const GOLD_STEPS: readonly number[] = [10, 50, 1000];
export const XP_STEPS: readonly number[] = [10, 50, 1000];

export function defaultPanelModel(unitId: string): DevPanelModel {
  return {
    invinciblePieces: false,
    invinciblePlayer: false,
    unitId,
    star: 1,
    cell: null,
    tier: 1,
    // TODO(P0-24 / P0-27): default these to real ids once augment and item content exists;
    // until then an empty box is honest — the sim answers with `invalid augment id`.
    augmentId: '',
    itemId: '',
  };
}

/**
 * Every panel button, in display order. A toggle's command carries the value it would switch
 * to, so the panel never needs to know how the sim stores it.
 */
export function devPanelButtons(model: DevPanelModel): DevPanelButton[] {
  const out: DevPanelButton[] = [];
  for (const amount of GOLD_STEPS) out.push({ id: `gold+${amount}`, label: `+${amount}`, group: 'gold', command: { type: 'dev:gold', amount } });
  for (const amount of XP_STEPS) out.push({ id: `xp+${amount}`, label: `+${amount}`, group: 'xp', command: { type: 'dev:xp', amount } });
  out.push({
    id: 'invinciblePieces',
    label: `Invincible pieces: ${model.invinciblePieces ? 'on' : 'off'}`,
    group: 'toggles',
    command: { type: 'dev:invinciblePieces', on: !model.invinciblePieces },
  });
  out.push({
    id: 'invinciblePlayer',
    label: `Invincible player: ${model.invinciblePlayer ? 'on' : 'off'}`,
    group: 'toggles',
    command: { type: 'dev:invinciblePlayer', on: !model.invinciblePlayer },
  });
  out.push({ id: 'skipRound', label: 'Skip round (win)', group: 'round', command: { type: 'dev:skipRound' } });
  out.push({ id: 'openShop', label: `Open shop (tier ${model.tier})`, group: 'round', command: { type: 'dev:openShop', tier: model.tier } });
  out.push({
    id: 'spawnUnit',
    label: `Spawn ${model.unitId || '-'} ${model.star}★ -> ${model.cell ? `${model.cell.col},${model.cell.row}` : 'bench'}`,
    group: 'content',
    command: { type: 'dev:spawnUnit', defId: model.unitId, star: model.star, cell: model.cell },
  });
  out.push({ id: 'addAugment', label: 'Add augment', group: 'content', command: { type: 'dev:addAugment', augmentId: model.augmentId } });
  out.push({ id: 'giveItem', label: 'Give item', group: 'content', command: { type: 'dev:giveItem', itemId: model.itemId } });
  return out;
}

export interface DevPanelInfo {
  seed: number | null;
  contentHash: string;
  round: number | null;
  phase: string | null;
  gold: number | null;
  invinciblePieces: boolean;
  invinciblePlayer: boolean;
  /** Last dispatch result, shown so a rejected panel click is never silent. */
  message?: string;
}

/**
 * The sim owns the cheat flags: the panel mirrors them from the run rather than from its own
 * clicks, so a rejected or dropped command can never leave a toggle label claiming a cheat is
 * on. Returns true when the model changed and the buttons need rebuilding.
 */
export function syncPanelModel(model: DevPanelModel, info: DevPanelInfo): boolean {
  if (model.invinciblePieces === info.invinciblePieces && model.invinciblePlayer === info.invinciblePlayer) return false;
  model.invinciblePieces = info.invinciblePieces;
  model.invinciblePlayer = info.invinciblePlayer;
  return true;
}

/** The lines a bug report should be able to quote verbatim. */
export function devPanelInfoLines(info: DevPanelInfo): string[] {
  const lines = [
    `seed    ${info.seed ?? '-'}`,
    `content ${info.contentHash}`,
    `round   ${info.round ?? '-'}  phase ${info.phase ?? '-'}  gold ${info.gold ?? '-'}`,
    `cheats  pieces ${info.invinciblePieces ? 'on' : 'off'}  player ${info.invinciblePlayer ? 'on' : 'off'}`,
  ];
  if (info.message) lines.push(`last    ${info.message}`);
  return lines;
}
