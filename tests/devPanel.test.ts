// P0-16: the F2 dev panel's model. Every button must map to a legal `dev:` Command that the
// sim accepts through the normal dispatch path (the DOM layer in src/dev/panel.ts only wires
// clicks to these commands), and every P0-15 command must have a button.
import { describe, expect, it } from 'vitest';
import { defaultPanelModel, devPanelButtons, devPanelInfoLines, GOLD_STEPS, PANEL_ROWS, syncPanelModel, XP_STEPS, type DevPanelInfo, type DevPanelModel } from '../src/dev/panelModel.ts';
import { applyCommand, checkInvariants, validateCommand } from '../src/sim/commands.ts';
import { DEV_COMMAND_TYPES } from '../src/sim/devCommands.ts';
import { createRun, type RunState } from '../src/sim/run.ts';
import { devContent } from './helpers.ts';

const content = devContent();

function devRun(seed = 1): RunState {
  return createRun(seed, content, { devCommands: true });
}

function model(): DevPanelModel {
  return defaultPanelModel(content.units[0]!.id);
}

describe('dev panel model', () => {
  it('has a button for every dev command type', () => {
    const types = new Set(devPanelButtons(model()).map((b) => b.command.type));
    for (const type of DEV_COMMAND_TYPES) expect(types, `missing a button for ${type}`).toContain(type);
  });
  it('offers the gold and xp steps the owner asked for', () => {
    const buttons = devPanelButtons(model());
    expect(buttons.filter((b) => b.command.type === 'dev:gold').map((b) => (b.command as { amount: number }).amount)).toEqual([...GOLD_STEPS]);
    expect(buttons.filter((b) => b.command.type === 'dev:xp').map((b) => (b.command as { amount: number }).amount)).toEqual([...XP_STEPS]);
    expect(GOLD_STEPS).toEqual([10, 50, 1000]);
    expect(XP_STEPS).toEqual([10, 50, 1000]);
  });
  it('button ids are unique', () => {
    const ids = devPanelButtons(model()).map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('every button dispatches a command the sim accepts on a fresh dev run', () => {
    // Ids the panel cannot default (no augment/item content yet) are filled in here; every
    // other button must be legal exactly as the panel emits it.
    for (const btn of devPanelButtons({ ...model(), augmentId: 'aug.iron_skin', itemId: 'dev.item.x' })) {
      const s = devRun();
      expect(validateCommand(s, btn.command, content), `${btn.id}: ${btn.label}`).toBeNull();
      const res = applyCommand(s, btn.command, content);
      expect(res.ok, btn.id).toBe(true);
      expect(s.commandCount).toBe(1);
      expect(checkInvariants(s, content)).toEqual([]);
    }
  });
  it('every button is rejected with a reason in a production run', () => {
    for (const btn of devPanelButtons({ ...model(), augmentId: 'aug.iron_skin', itemId: 'dev.item.x' })) {
      const s = createRun(1, content);
      const before = JSON.stringify(s);
      const res = applyCommand(s, btn.command, content);
      expect(res.ok, btn.id).toBe(false);
      if (!res.ok) expect(res.reason).toMatch(/dev commands are disabled/);
      expect(JSON.stringify(s)).toBe(before);
    }
  });
  it('the toggles carry the value they would switch to and their label shows the current one', () => {
    const off = devPanelButtons(model());
    const piecesOff = off.find((b) => b.id === 'invinciblePieces')!;
    expect(piecesOff.label).toMatch(/off$/);
    expect(piecesOff.command).toEqual({ type: 'dev:invinciblePieces', on: true });
    const on = devPanelButtons({ ...model(), invinciblePieces: true, invinciblePlayer: true });
    const piecesOn = on.find((b) => b.id === 'invinciblePieces')!;
    expect(piecesOn.label).toMatch(/on$/);
    expect(piecesOn.command).toEqual({ type: 'dev:invinciblePieces', on: false });
    expect(on.find((b) => b.id === 'invinciblePlayer')!.command).toEqual({ type: 'dev:invinciblePlayer', on: false });
  });
  it('the spawn and shop buttons follow the panel selections', () => {
    const m: DevPanelModel = { ...model(), unitId: 'dev.titan', star: 2, cell: { col: 2, row: 6 }, tier: 3 };
    const buttons = devPanelButtons(m);
    expect(buttons.find((b) => b.id === 'spawnUnit')!.command).toEqual({ type: 'dev:spawnUnit', defId: 'dev.titan', star: 2, cell: { col: 2, row: 6 } });
    expect(buttons.find((b) => b.id === 'openShop')!.command).toEqual({ type: 'dev:openShop', tier: 3 });
    const s = devRun();
    expect(applyCommand(s, buttons.find((b) => b.id === 'spawnUnit')!.command, content).ok).toBe(true);
    expect(s.board[0]).toMatchObject({ defId: 'dev.titan', star: 2, col: 2, row: 6 });
  });
  it('the id inputs feed dev:addAugment and dev:giveItem', () => {
    const buttons = devPanelButtons({ ...model(), augmentId: 'dev.aug.z', itemId: 'dev.item.z' });
    expect(buttons.find((b) => b.id === 'addAugment')!.command).toEqual({ type: 'dev:addAugment', augmentId: 'dev.aug.z' });
    expect(buttons.find((b) => b.id === 'giveItem')!.command).toEqual({ type: 'dev:giveItem', itemId: 'dev.item.z' });
  });
  it('every button group has a row to render into', () => {
    const groups = new Set(PANEL_ROWS.map((r) => r.group));
    for (const btn of devPanelButtons(model())) expect(groups, `no row for group ${btn.group}`).toContain(btn.group);
  });
  it('the toggle labels follow the sim, not the click: a rejected command leaves them alone', () => {
    const m = model();
    const info = (pieces: boolean, player: boolean): DevPanelInfo => ({
      seed: 1,
      contentHash: content.contentHash,
      round: 1,
      phase: 'planning',
      gold: 10,
      invinciblePieces: pieces,
      invinciblePlayer: player,
    });
    // A click issues `on: true`; if the sim rejected it, the run still reports false.
    expect(devPanelButtons(m).find((b) => b.id === 'invinciblePieces')!.command).toEqual({ type: 'dev:invinciblePieces', on: true });
    expect(syncPanelModel(m, info(false, false))).toBe(false);
    expect(m.invinciblePieces).toBe(false);
    expect(devPanelButtons(m).find((b) => b.id === 'invinciblePieces')!.label).toMatch(/off$/);
    // Once the sim accepts it, the label follows.
    expect(syncPanelModel(m, info(true, false))).toBe(true);
    expect(devPanelButtons(m).find((b) => b.id === 'invinciblePieces')!.label).toMatch(/on$/);
    expect(syncPanelModel(m, info(true, false))).toBe(false);
  });
  it('a dispatch message is shown in the info block', () => {
    const base: DevPanelInfo = { seed: 1, contentHash: 'abc', round: 1, phase: 'planning', gold: 10, invinciblePieces: false, invinciblePlayer: false };
    expect(devPanelInfoLines(base).some((l) => l.startsWith('last'))).toBe(false);
    expect(devPanelInfoLines({ ...base, message: 'dev commands are disabled in this run' }).join('\n')).toContain('dev commands are disabled');
  });
  it('the id inputs start empty, so an unset id is rejected rather than inventing content', () => {
    const m = model();
    expect(m.augmentId).toBe('');
    expect(m.itemId).toBe('');
    const s = devRun();
    for (const [id, pattern] of [
      ['addAugment', /unknown augment id/],
      ['giveItem', /invalid item id/],
    ] as const) {
      const cmd = devPanelButtons(m).find((b) => b.id === id)!.command;
      expect(validateCommand(s, cmd, content)).toMatch(pattern);
    }
  });
  it('the info lines carry the seed and the content hash a bug report needs', () => {
    const s = devRun(4242);
    const lines = devPanelInfoLines({
      seed: s.config.seed,
      contentHash: content.contentHash,
      round: s.round,
      phase: s.phase,
      gold: s.gold,
      invinciblePieces: s.dev.invinciblePieces,
      invinciblePlayer: s.dev.invinciblePlayer,
    });
    expect(lines.join('\n')).toContain('4242');
    expect(lines.join('\n')).toContain(content.contentHash);
  });
});
