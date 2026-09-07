// P0-25: trait activation (unique-unit counting, breakpoint thresholds) and application
// (teamWide vs holders-only) through a real fight().
import { describe, expect, it } from 'vitest';
import { fight, type FightEvent } from '../src/sim/fight.ts';
import { activeTraits, type TraitDef } from '../src/sim/traits.ts';
import type { BoardUnit, UnitDef } from '../src/sim/units.ts';
import { rulesWithUnits, testUnit } from './helpers.ts';

function trait(overrides: Partial<TraitDef> = {}): TraitDef {
  return {
    id: 't.trait',
    name: 'Test Trait',
    description: 'desc',
    teamWide: false,
    breakpoints: [{ count: 2, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 10, duration: null, target: 'self' }] }],
    ...overrides,
  };
}

describe('activeTraits (P0-25)', () => {
  it('counts unique unit ids only: three copies of the same unit (a duplicate and, in spirit, a higher-star copy) add nothing beyond one', () => {
    const unitsById: Record<string, UnitDef> = { 'u.a': testUnit('u.a', {}, { traits: ['t.trait'] }) };
    const traitsById = { 't.trait': trait() };
    // Star has no bearing on `defId`-based counting: three physical units, one distinct id.
    const board = [{ defId: 'u.a' }, { defId: 'u.a' }, { defId: 'u.a' }];
    expect(activeTraits(board, unitsById, traitsById)).toEqual([]);
  });

  it('activates exactly at the breakpoint count and deactivates one below', () => {
    const unitsById: Record<string, UnitDef> = {
      'u.a': testUnit('u.a', {}, { traits: ['t.trait'] }),
      'u.b': testUnit('u.b', {}, { traits: ['t.trait'] }),
    };
    const traitsById = { 't.trait': trait() };
    expect(activeTraits([{ defId: 'u.a' }], unitsById, traitsById)).toEqual([]); // count 1: below breakpoint 2
    const active = activeTraits([{ defId: 'u.a' }, { defId: 'u.b' }], unitsById, traitsById);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ traitId: 't.trait', count: 2, teamWide: false, holderDefIds: ['u.a', 'u.b'] });
  });

  it('only the highest reached breakpoint applies, not every lower tier at once', () => {
    const t = trait({
      breakpoints: [
        { count: 2, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 5, duration: null, target: 'self' }] },
        { count: 4, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 20, duration: null, target: 'self' }] },
      ],
    });
    const unitsById: Record<string, UnitDef> = {};
    for (const id of ['a', 'b', 'c', 'd']) unitsById[id] = testUnit(id, {}, { traits: ['t.trait'] });
    const traitsById = { 't.trait': t };
    const board = ['a', 'b', 'c', 'd'].map((id) => ({ defId: id }));
    const active = activeTraits(board, unitsById, traitsById);
    expect(active).toHaveLength(1);
    expect(active[0]!.count).toBe(4);
    expect(active[0]!.breakpoint.count).toBe(4);
    expect(active[0]!.breakpoint.effects[0]).toMatchObject({ value: 20 });
  });

  it('at a count between two breakpoints, the lower tier stays active rather than deactivating', () => {
    const t = trait({
      breakpoints: [
        { count: 2, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 5, duration: null, target: 'self' }] },
        { count: 4, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 20, duration: null, target: 'self' }] },
      ],
    });
    const unitsById: Record<string, UnitDef> = {};
    for (const id of ['a', 'b', 'c']) unitsById[id] = testUnit(id, {}, { traits: ['t.trait'] });
    const traitsById = { 't.trait': t };
    const active = activeTraits(['a', 'b', 'c'].map((id) => ({ defId: id })), unitsById, traitsById);
    expect(active).toHaveLength(1);
    expect(active[0]!.count).toBe(3);
    expect(active[0]!.breakpoint.count).toBe(2); // the count:4 tier is not yet reached
    expect(active[0]!.breakpoint.effects[0]).toMatchObject({ value: 5 });
  });

  it('a unit with no traits, or an id absent from unitsById/traitsById, contributes nothing and never throws', () => {
    expect(activeTraits([{ defId: 'ghost' }], {}, {})).toEqual([]);
    const unitsById: Record<string, UnitDef> = { 'u.plain': testUnit('u.plain', {}, { traits: [] }) };
    expect(activeTraits([{ defId: 'u.plain' }], unitsById, { 't.trait': trait() })).toEqual([]);
  });

  it('results are sorted by traitId regardless of board order (deterministic iteration)', () => {
    const unitsById: Record<string, UnitDef> = {
      'u.a': testUnit('u.a', {}, { traits: ['t.zzz', 't.aaa'] }),
      'u.b': testUnit('u.b', {}, { traits: ['t.zzz', 't.aaa'] }),
    };
    const traitsById = { 't.zzz': trait({ id: 't.zzz' }), 't.aaa': trait({ id: 't.aaa' }) };
    const board = [{ defId: 'u.b' }, { defId: 'u.a' }];
    expect(activeTraits(board, unitsById, traitsById).map((t) => t.traitId)).toEqual(['t.aaa', 't.zzz']);
  });
});

describe('trait effects apply in combat: teamWide vs holders-only (P0-25)', () => {
  it('a holders-only trait buffs only its holders; a teamWide trait at the same time buffs the whole side, including a non-holder', () => {
    const holder1 = testUnit('t.holder1', { hp: 500, range: 1 }, { traits: ['t.holders', 't.team'] });
    const holder2 = testUnit('t.holder2', { hp: 500, range: 1 }, { traits: ['t.holders', 't.team'] });
    const bystander = testUnit('t.bystander', { hp: 500, range: 1 }, { traits: [] });
    const dummy = testUnit('t.dummy', { hp: 500, attack: 0, range: 1 }, { traits: [] });

    const holdersTrait: TraitDef = trait({ id: 't.holders', teamWide: false, breakpoints: [{ count: 2, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 7, duration: null, target: 'self' }] }] });
    const teamTrait: TraitDef = trait({ id: 't.team', teamWide: true, breakpoints: [{ count: 2, effects: [{ type: 'statMod', stat: 'magicResist', mode: 'flat', value: 9, duration: null, target: 'self' }] }] });

    const rules = rulesWithUnits([holder1, holder2, bystander, dummy], { maxSeconds: 1 }, undefined, { 't.holders': holdersTrait, 't.team': teamTrait });
    const left: BoardUnit[] = [
      { defId: 't.holder1', star: 1, col: 3, row: 4 },
      { defId: 't.holder2', star: 1, col: 2, row: 4 },
      { defId: 't.bystander', star: 1, col: 1, row: 4 },
    ];
    const right: BoardUnit[] = [{ defId: 't.dummy', star: 1, col: 3, row: 4 }];
    const res = fight(left, right, 1, rules);

    const uidOf = (defId: string): number => (res.events.find((e): e is Extract<FightEvent, { type: 'spawn' }> => e.type === 'spawn' && e.defId === defId) as { uid: number }).uid;
    const holder1Uid = uidOf('t.holder1');
    const holder2Uid = uidOf('t.holder2');
    const bystanderUid = uidOf('t.bystander');

    const statMods = res.events.filter((e): e is Extract<FightEvent, { type: 'statMod' }> => e.type === 'statMod');
    const holdersUids = new Set(statMods.filter((e) => e.source === 'trait:t.holders').map((e) => e.uid));
    const teamUids = new Set(statMods.filter((e) => e.source === 'trait:t.team').map((e) => e.uid));

    expect(holdersUids).toEqual(new Set([holder1Uid, holder2Uid]));
    expect(teamUids).toEqual(new Set([holder1Uid, holder2Uid, bystanderUid]));
  });
});
