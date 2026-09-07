// P0-27: items core — recipe combining (order independence, same-component recipe, an unknown
// pair leaving two components), the 3-item cap, and item stat mods as one modifier source per
// item, stacking per the stat-stacking rule.
import { describe, expect, it } from 'vitest';
import { applyCommand, checkInvariants, legalCommands, validateCommand, type Command } from '../src/sim/commands.ts';
import { fight, type FightEvent } from '../src/sim/fight.ts';
import { findCombineTarget, recipeKey, type ItemDef } from '../src/sim/items.ts';
import { createRun, stateHash, type RunState } from '../src/sim/run.ts';
import type { BoardUnit } from '../src/sim/units.ts';
import { devContent, rulesWithUnits, testUnit } from './helpers.ts';

const content = devContent();
const eco = content.rules.economy;

function fresh(seed = 1): RunState {
  return createRun(seed, content, { devCommands: true });
}

function expectRejected(state: RunState, cmd: Command, reasonPattern?: RegExp): void {
  const before = stateHash(state);
  const res = applyCommand(state, cmd, content);
  expect(res.ok, `expected rejection of ${JSON.stringify(cmd)}`).toBe(false);
  if (!res.ok) {
    expect(res.reason.length).toBeGreaterThan(0);
    if (reasonPattern) expect(res.reason).toMatch(reasonPattern);
  }
  expect(stateHash(state)).toBe(before);
}

describe('recipeKey / findCombineTarget (P0-27)', () => {
  const itemsById: Record<string, ItemDef> = {
    'i.a': { id: 'i.a', name: 'A', kind: 'component', effects: [] },
    'i.b': { id: 'i.b', name: 'B', kind: 'component', effects: [] },
    'i.c': { id: 'i.c', name: 'C', kind: 'completed', effects: [] },
  };
  const recipesByKey = { [recipeKey('i.a', 'i.b')]: 'i.c', [recipeKey('i.a', 'i.a')]: 'i.twin' };

  it('recipeKey is order-independent', () => {
    expect(recipeKey('i.a', 'i.b')).toBe(recipeKey('i.b', 'i.a'));
    expect(recipeKey('i.a', 'i.a')).toBe(recipeKey('i.a', 'i.a'));
  });

  it('finds a match regardless of which side of the pair is already held (order independence)', () => {
    expect(findCombineTarget(['i.a'], 'i.b', itemsById, recipesByKey)).toEqual({ index: 0, resultId: 'i.c' });
    expect(findCombineTarget(['i.b'], 'i.a', itemsById, recipesByKey)).toEqual({ index: 0, resultId: 'i.c' });
  });

  it('two of the same component is a valid recipe', () => {
    expect(findCombineTarget(['i.a'], 'i.a', itemsById, recipesByKey)).toEqual({ index: 0, resultId: 'i.twin' });
  });

  it('an unknown pair (no matching recipe) finds no combine target, leaving two separate components', () => {
    const noRecipe: Record<string, string> = {};
    expect(findCombineTarget(['i.a'], 'i.b', itemsById, noRecipe)).toBeNull();
  });

  it('a held completed item never combines, even if a coincidental recipe key would match', () => {
    // i.c is 'completed'; even though no recipe references it as a component here, this proves
    // findCombineTarget filters by kind rather than trusting recipesByKey alone.
    const withBogusKey = { ...recipesByKey, [recipeKey('i.c', 'i.a')]: 'i.should-not-happen' };
    expect(findCombineTarget(['i.c'], 'i.a', itemsById, withBogusKey)).toBeNull();
  });

  it('an empty held list or an unknown itemId never throws', () => {
    expect(findCombineTarget([], 'i.a', itemsById, recipesByKey)).toBeNull();
    expect(findCombineTarget(['i.a'], 'ghost', itemsById, recipesByKey)).toBeNull();
    expect(findCombineTarget(['ghost'], 'i.a', itemsById, recipesByKey)).toBeNull();
  });
});

describe('equipItem command (P0-27)', () => {
  function give(state: RunState, itemId: string): number {
    state.itemBench.push(itemId);
    return state.itemBench.length - 1;
  }

  it('placing a component on a unit that already holds a component combines them immediately via the recipe table', () => {
    const s = fresh();
    const uid = s.board[0]?.uid ?? spawnOnBoard(s);
    const i1 = give(s, 'item.blade');
    expect(applyCommand(s, { type: 'equipItem', uid, benchIndex: i1 }, content).ok).toBe(true);
    const unit1 = s.board.find((u) => u.uid === uid)!;
    expect(unit1.items).toEqual(['item.blade']);

    const i2 = give(s, 'item.chain');
    expect(applyCommand(s, { type: 'equipItem', uid, benchIndex: i2 }, content).ok).toBe(true);
    const unit2 = s.board.find((u) => u.uid === uid)!;
    // Combined into the completed item, in place of the two components (order independence:
    // blade was held, chain was placed — the recipe is defined the same way either direction).
    expect(unit2.items).toEqual(['item.guardians_edge']);
    expect(s.itemBench).toEqual([]);
  });

  it('order independence: placing chain onto a unit already holding blade produces the same completed item as blade-then-chain', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    const iChain = give(s, 'item.chain');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: iChain }, content);
    const iBlade = give(s, 'item.blade');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: iBlade }, content);
    expect(s.board.find((u) => u.uid === uid)!.items).toEqual(['item.guardians_edge']);
  });

  it('two of the same component (blade + blade) is a valid recipe', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    const i1 = give(s, 'item.blade');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: i1 }, content);
    const i2 = give(s, 'item.blade');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: i2 }, content);
    expect(s.board.find((u) => u.uid === uid)!.items).toEqual(['item.twin_blade']);
  });

  it('an unknown pair (blade + tome: no recipe defined) leaves two separate components, not a combine', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    const i1 = give(s, 'item.blade');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: i1 }, content);
    const i2 = give(s, 'item.tome');
    applyCommand(s, { type: 'equipItem', uid, benchIndex: i2 }, content);
    expect(s.board.find((u) => u.uid === uid)!.items).toEqual(['item.blade', 'item.tome']);
  });

  it('the 3-item cap rejects a plain (non-combining) equip with a reason, once a unit holds itemSlots items', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    // Three completed items: none is a `component`, so none can combine with anything further.
    for (const id of ['item.twin_blade', 'item.guardians_edge', 'item.arcane_ward']) {
      expect(applyCommand(s, { type: 'equipItem', uid, benchIndex: give(s, id) }, content).ok).toBe(true);
    }
    expect(s.board.find((u) => u.uid === uid)!.items).toHaveLength(eco.itemSlots);
    const overflowIndex = give(s, 'item.chain');
    expectRejected(s, { type: 'equipItem', uid, benchIndex: overflowIndex }, new RegExp(`already holds ${eco.itemSlots} items`));
    // The rejected item stays on the bench (state genuinely unchanged, per expectRejected above).
    expect(s.itemBench[overflowIndex]).toBe('item.chain');
  });

  it('a combine at the cap is exempt: a matching component still combines even when the unit already holds itemSlots items', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    // One component (blade) plus two completed items: exactly one held item can combine.
    for (const id of ['item.blade', 'item.guardians_edge', 'item.arcane_ward']) {
      expect(applyCommand(s, { type: 'equipItem', uid, benchIndex: give(s, id) }, content).ok).toBe(true);
    }
    expect(s.board.find((u) => u.uid === uid)!.items).toHaveLength(eco.itemSlots);
    const secondBlade = give(s, 'item.blade');
    expect(applyCommand(s, { type: 'equipItem', uid, benchIndex: secondBlade }, content).ok).toBe(true);
    const items = s.board.find((u) => u.uid === uid)!.items;
    // Net unchanged: the held blade combines with the new one into item.twin_blade in place.
    expect(items).toEqual(['item.twin_blade', 'item.guardians_edge', 'item.arcane_ward']);
  });

  it('rejects an invalid uid, an invalid bench index, and a bench index past the end', () => {
    const s = fresh();
    const uid = spawnOnBoard(s);
    give(s, 'item.blade');
    expectRejected(s, { type: 'equipItem', uid: 999999, benchIndex: 0 }, /no unit with uid/);
    expectRejected(s, { type: 'equipItem', uid, benchIndex: -1 }, /invalid item bench index/);
    expectRejected(s, { type: 'equipItem', uid, benchIndex: 5 }, /invalid item bench index/);
  });

  it('legalCommands only offers equipItem when it validates, and every offered one is accepted', () => {
    const s = fresh();
    spawnOnBoard(s);
    give(s, 'item.blade');
    const legal = legalCommands(s, content).filter((c) => c.type === 'equipItem');
    expect(legal.length).toBeGreaterThan(0);
    for (const cmd of legal) {
      const copy = structuredClone(s);
      expect(validateCommand(copy, cmd, content)).toBeNull();
      expect(applyCommand(copy, cmd, content).ok).toBe(true);
      expect(checkInvariants(copy, content)).toEqual([]);
    }
  });

  function spawnOnBoard(state: RunState): number {
    const res = applyCommand(state, { type: 'dev:spawnUnit', defId: content.units[0]!.id, star: 1, cell: { col: 0, row: content.board.rows - 1 } }, content);
    if (!res.ok) throw new Error(res.reason);
    return state.board[0]!.uid;
  }
});

describe('item stat mods apply in combat: one modifier source per item, stacking per the stat-stacking rule (P0-27)', () => {
  it("resolveCombat threads a board unit's items into the fight, and each equipped item's effects apply once with source `item:<id>`", () => {
    const attacker = testUnit('t.item.attacker', { hp: 1000, attack: 100, attackSpeed: 1, range: 1 });
    const tank = testUnit('t.item.tank', { hp: 100000, attack: 0, range: 1 });
    const items: Record<string, ItemDef> = {
      'item.a': { id: 'item.a', name: 'A', kind: 'component', effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 10, duration: null, target: 'self' }] },
      'item.b': { id: 'item.b', name: 'B', kind: 'completed', effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 15, duration: null, target: 'self' }] },
    };
    const fr = rulesWithUnits([attacker, tank], { maxSeconds: 1 }, undefined, {}, items);
    const left: BoardUnit[] = [{ defId: 't.item.attacker', star: 1, col: 3, row: 4 }];

    const noItems: BoardUnit[] = [{ defId: 't.item.tank', star: 1, col: 3, row: 4 }];
    const withoutItems = fight(left, noItems, 1, fr);
    const hitWithout = withoutItems.events.find((e) => e.type === 'hit');
    expect(hitWithout && hitWithout.type === 'hit' ? hitWithout.amount : NaN).toBeCloseTo(100, 9);

    const equipped: BoardUnit[] = [{ defId: 't.item.tank', star: 1, col: 3, row: 4, items: ['item.a', 'item.b'] }];
    const withItems = fight(left, equipped, 1, fr);
    const statMods = withItems.events.filter((e): e is Extract<FightEvent, { type: 'statMod' }> => e.type === 'statMod');
    // One event per item, each tagged with its own item id as the source — not a single shared
    // 'item' source (mirrors the P0-25 trait convention, not P0-24's augment shortcut).
    expect(statMods.map((e) => e.source).sort()).toEqual(['item:item.a', 'item:item.b']);
    expect(statMods.find((e) => e.source === 'item:item.a')).toMatchObject({ stat: 'armor', mode: 'flat', value: 10 });
    expect(statMods.find((e) => e.source === 'item:item.b')).toMatchObject({ stat: 'armor', mode: 'flat', value: 15 });

    // Stacking per the stat-stacking rule: two different sources on a flat stat add (10 + 15 = 25).
    const hitWith = withItems.events.find((e) => e.type === 'hit');
    const k = fr.combat.mitigationConstant;
    expect(hitWith && hitWith.type === 'hit' ? hitWith.amount : NaN).toBeCloseTo(100 * (k / (k + 25)), 9);
  });

  it("a picked equip's items apply in the next combat, driven through the real Commands (equipItem -> startCombat), diverging the fight hash", () => {
    const withoutItem = fresh(9);
    const res1 = applyCommand(withoutItem, { type: 'dev:spawnUnit', defId: content.units[0]!.id, star: 1, cell: { col: 0, row: content.board.rows - 1 } }, content);
    if (!res1.ok) throw new Error(res1.reason);
    expect(applyCommand(withoutItem, { type: 'startCombat' }, content).ok).toBe(true);
    const baselineHash = withoutItem.lastFight!.hash;

    const withItem = fresh(9);
    const res2 = applyCommand(withItem, { type: 'dev:spawnUnit', defId: content.units[0]!.id, star: 1, cell: { col: 0, row: content.board.rows - 1 } }, content);
    if (!res2.ok) throw new Error(res2.reason);
    const uid = withItem.board[0]!.uid;
    withItem.itemBench.push('item.blade');
    expect(applyCommand(withItem, { type: 'equipItem', uid, benchIndex: 0 }, content).ok).toBe(true);
    expect(applyCommand(withItem, { type: 'startCombat' }, content).ok).toBe(true);
    // Same seed, same board, only the equipped item differs: the fight hash must diverge (the
    // item's attack bonus changes damage output), proving resolveCombat actually threads
    // OwnedUnit.items into the fight it runs, not just that fight() can apply item effects.
    expect(withItem.lastFight!.hash).not.toBe(baselineHash);
  });
});
