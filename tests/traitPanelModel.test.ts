// P0-26: the trait panel view-model. Pure over board composition + content; no fight state.
import { describe, expect, it } from 'vitest';
import { traitPanelModel } from '../src/app/traitPanelModel.ts';
import { devContent } from './helpers.ts';

const content = devContent();

describe('traitPanelModel (P0-26)', () => {
  it('lists every trait present on the board, including one below its first breakpoint (no breakpoint reached, not omitted)', () => {
    // A single Dev Brawler (trait.brawn, breakpoints at 2 and 4): count 1 never reaches a tier.
    const entries = traitPanelModel([{ defId: 'dev.brawler' }], content);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ traitId: 'trait.brawn', count: 1, teamWide: false });
    expect(entries[0]!.breakpoints).toEqual([
      { count: 2, text: expect.any(String), reached: false },
      { count: 4, text: expect.any(String), reached: false },
    ]);
    expect(entries[0]!.holderNames).toEqual(['Dev Brawler']);
  });

  it('marks only the highest reached breakpoint, matching activeTraits (P0-25)', () => {
    // Four distinct trait.brawn holders (dev.brawler, dev.guardian, dev.knight, dev.titan) reach
    // the count:4 tier; the count:2 tier stays present but not highlighted.
    const board = ['dev.brawler', 'dev.guardian', 'dev.knight', 'dev.titan'].map((defId) => ({ defId }));
    const entries = traitPanelModel(board, content);
    const brawn = entries.find((e) => e.traitId === 'trait.brawn')!;
    expect(brawn.count).toBe(4);
    expect(brawn.breakpoints).toEqual([
      { count: 2, text: expect.any(String), reached: false },
      { count: 4, text: expect.any(String), reached: true },
    ]);
    expect(brawn.holderNames.sort()).toEqual(['Dev Brawler', 'Dev Guardian', 'Dev Knight', 'Dev Titan']);
  });

  it('a duplicate unit id contributes only one to the count (mirrors activeTraits unique-id counting)', () => {
    const entries = traitPanelModel([{ defId: 'dev.brawler' }, { defId: 'dev.brawler' }, { defId: 'dev.brawler' }], content);
    expect(entries[0]).toMatchObject({ traitId: 'trait.brawn', count: 1 });
  });

  it('sorts by active tier (the reached breakpoint\'s index, highest first) then by count, traits with no reached tier last', () => {
    // trait.brawn at count 4 reaches its *second* breakpoint (tier index 1); trait.arcane at
    // count 2 reaches its only (first, tier index 0) breakpoint — brawn outranks arcane despite
    // arcane having its own reached tier too, because brawn's tier index is higher.
    const board = [
      { defId: 'dev.brawler' }, { defId: 'dev.guardian' }, { defId: 'dev.knight' }, { defId: 'dev.titan' }, // trait.brawn x4, tier 1
      { defId: 'dev.mage' }, { defId: 'dev.healer' }, // trait.arcane x2, tier 0
    ];
    expect(traitPanelModel(board, content).map((e) => e.traitId)).toEqual(['trait.brawn', 'trait.arcane']);
  });

  it('sorts an unreached trait (progress only) after every trait with a reached tier, ties broken by count then traitId', () => {
    // trait.arcane at count 2 reaches its tier; trait.brawn at count 1 reaches nothing.
    const entries = traitPanelModel([{ defId: 'dev.mage' }, { defId: 'dev.healer' }, { defId: 'dev.brawler' }], content);
    expect(entries.map((e) => e.traitId)).toEqual(['trait.arcane', 'trait.brawn']);
  });

  it('an empty board has no trait entries', () => {
    expect(traitPanelModel([], content)).toEqual([]);
  });
});
