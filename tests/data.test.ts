import { describe, expect, it } from 'vitest';
import { computeContentHash, loadContent, validateFile, type RawContentFiles } from '../src/data/loader.ts';
import { kindForPath } from '../src/data/manifest.ts';
import { AugmentDefSchema, EffectSchema, EncounterSchema, ItemDefSchema, LootDropSchema, RecipeDefSchema, StatBlockSchema, TraitDefSchema, UnitDefSchema } from '../src/data/schemas.ts';
import { devContent, rawDevContent } from './helpers.ts';

function clone<T>(v: T): T {
  return structuredClone(v);
}

describe('data pipeline', () => {
  it('the dev content set loads and every file validates', () => {
    const c = devContent();
    expect(c.units.length).toBeGreaterThan(0);
    expect(c.encounters.length).toBeGreaterThan(0);
    expect(c.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const raw = rawDevContent();
    for (const kind of ['board', 'rules', 'units', 'encounters', 'augments', 'traits', 'items'] as const) expect(validateFile(kind, raw[kind]).ok, kind).toBe(true);
  });

  it('rejects unknown keys', () => {
    const raw = clone(rawDevContent());
    (raw.rules as Record<string, unknown>)['bogus'] = 1;
    expect(() => loadContent(raw)).toThrow(/bogus|unrecognized/i);
    const r = validateFile('board', { cols: 7, rows: 8, playerRows: 4, layout: 'odd-r', extra: true });
    expect(r.ok).toBe(false);
  });

  it('rejects unknown effect names and mul modifiers on flat stats', () => {
    expect(EffectSchema.safeParse({ type: 'explode', amount: 1, target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'damage', kind: 'chaos', amount: 1, target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'statMod', stat: 'range', mode: 'mul', value: 0.1, duration: null, target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'statMod', stat: 'range', mode: 'flat', value: 1, duration: null, target: 'self' }).success).toBe(true);
    expect(EffectSchema.safeParse({ type: 'damage', kind: 'magic', amount: 1, target: 'nobody' }).success).toBe(false);
  });

  it('rejects degenerate and absurd stat blocks', () => {
    const base = { hp: 100, attack: 10, attackSpeed: 1, armor: 0, magicResist: 0, range: 1, maxMana: 0, startMana: 0, abilityPower: 0 };
    expect(StatBlockSchema.safeParse(base).success).toBe(true);
    expect(StatBlockSchema.safeParse({ ...base, hp: 0 }).success).toBe(false);
    expect(StatBlockSchema.safeParse({ ...base, range: 0 }).success).toBe(false);
    expect(StatBlockSchema.safeParse({ ...base, hp: 1e308 }).success).toBe(false);
    expect(StatBlockSchema.safeParse({ ...base, armor: -1e12 }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'damage', kind: 'true', amount: 1e300, target: 'enemies' }).success).toBe(false);
  });

  it('rejects an invalid unit sample', () => {
    const raw = clone(rawDevContent());
    const units = (raw.units as { units: Record<string, unknown>[] }).units;
    (units[0] as Record<string, unknown>)['stats'] = [];
    expect(() => loadContent(raw)).toThrow();
    expect(UnitDefSchema.safeParse({ id: 'x', name: 'x', cost: 0, attackType: 'melee', tags: [], stats: [], ability: null, hooks: {} }).success).toBe(false);
    expect(UnitDefSchema.safeParse({ id: 'x', name: 'x', cost: 1, attackType: 'melee', tags: [], stats: [], ability: null, hooks: { onNothing: [] } }).success).toBe(false);
  });

  it('cross-file checks: stat block count, unknown units in encounters, out-of-half cells, round gaps', () => {
    const base = rawDevContent();
    const withStats = clone(base);
    (withStats.units as { units: { stats: unknown[] }[] }).units[0]!.stats.pop();
    expect(() => loadContent(withStats)).toThrow(/stat blocks/);

    const badEnc = clone(base);
    (badEnc.encounters as { encounters: { board: { defId: string }[] }[] }).encounters[0]!.board[0]!.defId = 'ghost';
    expect(() => loadContent(badEnc)).toThrow(/unknown unit/);

    const offHalf = clone(base);
    (offHalf.encounters as { encounters: { board: { row: number }[] }[] }).encounters[0]!.board[0]!.row = 0;
    expect(() => loadContent(offHalf)).toThrow(/owner half/);

    const gap = clone(base);
    (gap.encounters as { encounters: { round: number }[] }).encounters[1]!.round = 5;
    expect(() => loadContent(gap)).toThrow(/gaps/);

    const badType = clone(base);
    (badType.encounters as { encounters: { type: string }[] }).encounters[0]!.type = 'raid';
    expect(() => loadContent(badType)).toThrow();
    expect(EncounterSchema.safeParse({ id: 'x', round: 1, type: 'raid', reward: { gold: 0 }, board: [] }).success).toBe(false);

    const missingType = clone(base);
    delete (missingType.encounters as { encounters: Record<string, unknown>[] }).encounters[0]!['type'];
    expect(() => loadContent(missingType)).toThrow();

    const oddRows = clone(base);
    (oddRows.board as { rows: number }).rows = 7;
    expect(() => loadContent(oddRows)).toThrow(/even/);

    const gappyPool = clone(base);
    const pool = (gappyPool.rules as { economy: { poolSize: Record<string, number> } }).economy.poolSize;
    delete pool['3'];
    pool['7'] = 5;
    expect(() => loadContent(gappyPool)).toThrow(/contiguous/);

    const freeLevels = clone(base);
    (freeLevels.rules as { economy: { xpToLevel: number[] } }).economy.xpToLevel[2] = 0;
    expect(() => loadContent(freeLevels)).toThrow(/xpToLevel/);
  });

  it('augments (P0-24): duplicate id and unknown projectile ref are cross-file errors; the schema rejects a malformed row', () => {
    const base = rawDevContent();

    const dup = clone(base);
    const augs = (dup.augments as { augments: { id: string }[] }).augments;
    augs.push({ ...augs[0]! });
    expect(() => loadContent(dup)).toThrow(/duplicate augment id/);

    const badRef = clone(base);
    (badRef.augments as { augments: { effects: unknown[] }[] }).augments[0]!.effects = [{ type: 'spawnProjectile', ref: 'ghost.does.not.exist', target: 'allies' }];
    expect(() => loadContent(badRef)).toThrow(/unknown projectile ref/);

    expect(AugmentDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', effects: [] }).success).toBe(false);
    expect(AugmentDefSchema.safeParse({ id: 'Not An Id', name: 'x', description: 'x', effects: [{ type: 'heal', amount: 1, target: 'allies' }] }).success).toBe(false);
    expect(AugmentDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', effects: [{ type: 'explode', amount: 1, target: 'allies' }] }).success).toBe(false);
  });

  it('traits (P0-25): a unit referencing an unknown trait is rejected; duplicate id, unknown projectile ref and malformed breakpoints are all rejected', () => {
    const base = rawDevContent();

    const badUnit = clone(base);
    (badUnit.units as { units: { traits: string[] }[] }).units[0]!.traits = ['trait.does_not_exist'];
    expect(() => loadContent(badUnit)).toThrow(/unknown trait/);

    const dupOnUnit = clone(base);
    const firstTraitId = (base.traits as { traits: { id: string }[] }).traits[0]!.id;
    (dupOnUnit.units as { units: { traits: string[] }[] }).units[0]!.traits = [firstTraitId, firstTraitId];
    expect(() => loadContent(dupOnUnit)).toThrow(/more than once/);

    const dup = clone(base);
    const traits = (dup.traits as { traits: { id: string }[] }).traits;
    traits.push({ ...traits[0]! });
    expect(() => loadContent(dup)).toThrow(/duplicate trait id/);

    const badRef = clone(base);
    (badRef.traits as { traits: { breakpoints: { effects: unknown[] }[] }[] }).traits[0]!.breakpoints[0]!.effects = [{ type: 'spawnProjectile', ref: 'ghost.does.not.exist', target: 'self' }];
    expect(() => loadContent(badRef)).toThrow(/unknown projectile ref/);

    const validBreakpoint = { count: 2, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 1, duration: null, target: 'self' }] };
    expect(TraitDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', teamWide: false, breakpoints: [] }).success).toBe(false);
    expect(TraitDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', teamWide: false, breakpoints: [validBreakpoint, validBreakpoint] }).success).toBe(false); // equal counts, not strictly increasing
    expect(TraitDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', teamWide: false, breakpoints: [{ ...validBreakpoint, count: 4 }, validBreakpoint] }).success).toBe(false); // decreasing
    expect(TraitDefSchema.safeParse({ id: 'x', name: 'x', description: 'x', teamWide: false, breakpoints: [validBreakpoint] }).success).toBe(true);
  });

  it('items and recipes (P0-27): duplicate item id, unknown projectile ref, and every recipe referential-integrity check are rejected', () => {
    const base = rawDevContent();

    const dup = clone(base);
    const items = (dup.items as { items: { id: string }[] }).items;
    items.push({ ...items[0]! });
    expect(() => loadContent(dup)).toThrow(/duplicate item id/);

    const badRef = clone(base);
    (badRef.items as { items: { effects: unknown[] }[] }).items[0]!.effects = [{ type: 'spawnProjectile', ref: 'ghost.does.not.exist', target: 'self' }];
    expect(() => loadContent(badRef)).toThrow(/unknown projectile ref/);

    const unknownComponent = clone(base);
    (unknownComponent.items as { recipes: { components: string[]; result: string }[] }).recipes.push({ components: ['item.does_not_exist', 'item.blade'], result: 'item.twin_blade' });
    expect(() => loadContent(unknownComponent)).toThrow(/unknown component/);

    const unknownResult = clone(base);
    (unknownResult.items as { recipes: { components: string[]; result: string }[] }).recipes.push({ components: ['item.blade', 'item.tome'], result: 'item.does_not_exist' });
    expect(() => loadContent(unknownResult)).toThrow(/unknown result/);

    const completedAsComponent = clone(base);
    (completedAsComponent.items as { recipes: { components: string[]; result: string }[] }).recipes.push({ components: ['item.twin_blade', 'item.chain'], result: 'item.arcane_ward' });
    expect(() => loadContent(completedAsComponent)).toThrow(/not 'component'/);

    const componentAsResult = clone(base);
    (componentAsResult.items as { recipes: { components: string[]; result: string }[] }).recipes.push({ components: ['item.blade', 'item.tome'], result: 'item.chain' });
    expect(() => loadContent(componentAsResult)).toThrow(/not 'completed'/);

    const dupRecipe = clone(base);
    // Reversed order of an existing recipe's pair: still the same sorted-pair key, so this must
    // collide, proving the duplicate check is genuinely order-independent, not just exact-match.
    const existing = (base.items as { recipes: { components: [string, string]; result: string }[] }).recipes[0]!;
    (dupRecipe.items as { recipes: { components: string[]; result: string }[] }).recipes.push({ components: [existing.components[1], existing.components[0]], result: existing.result });
    expect(() => loadContent(dupRecipe)).toThrow(/duplicate recipe/);

    expect(ItemDefSchema.safeParse({ id: 'x', name: 'x', kind: 'component', effects: [] }).success).toBe(true);
    expect(ItemDefSchema.safeParse({ id: 'x', name: 'x', kind: 'gizmo', effects: [] }).success).toBe(false);
    expect(RecipeDefSchema.safeParse({ components: ['a', 'b'], result: 'c' }).success).toBe(true);
    expect(RecipeDefSchema.safeParse({ components: ['a'], result: 'c' }).success).toBe(false);
  });

  it('encounter loot tables (P0-28): unknown item, kind mismatch on a guaranteed row, and schema shape are all rejected', () => {
    const base = rawDevContent();
    const lootEncIndex = (base.encounters as { encounters: { loot?: unknown[] }[] }).encounters.findIndex((e) => (e.loot?.length ?? 0) > 0);
    expect(lootEncIndex, 'expected at least one dev encounter with a loot table').toBeGreaterThanOrEqual(0);

    const unknownItem = clone(base);
    (unknownItem.encounters as { encounters: { loot: { kind: string; itemIds: string[] }[] }[] }).encounters[lootEncIndex]!.loot.push({ kind: 'component', itemIds: ['item.does_not_exist'] });
    expect(() => loadContent(unknownItem)).toThrow(/loot references unknown item/);

    const wrongKind = clone(base);
    // item.twin_blade is 'completed', not 'component'.
    (wrongKind.encounters as { encounters: { loot: { kind: string; itemIds: string[] }[] }[] }).encounters[lootEncIndex]!.loot.push({ kind: 'component', itemIds: ['item.twin_blade'] });
    expect(() => loadContent(wrongKind)).toThrow(/not 'component'/);

    // A 'choice' row may freely mix kinds — no kind check applies to it.
    const mixedChoice = clone(base);
    (mixedChoice.encounters as { encounters: { loot: { kind: string; itemIds: string[] }[] }[] }).encounters[lootEncIndex]!.loot.push({ kind: 'choice', itemIds: ['item.blade', 'item.twin_blade'] });
    expect(() => loadContent(mixedChoice)).not.toThrow();

    // The existence check applies to every row kind, 'choice' included, not just guaranteed rows.
    const unknownInChoice = clone(base);
    (unknownInChoice.encounters as { encounters: { loot: { kind: string; itemIds: string[] }[] }[] }).encounters[lootEncIndex]!.loot.push({ kind: 'choice', itemIds: ['item.blade', 'item.does_not_exist'] });
    expect(() => loadContent(unknownInChoice)).toThrow(/loot references unknown item/);

    expect(LootDropSchema.safeParse({ kind: 'component', itemIds: ['x'] }).success).toBe(true);
    expect(LootDropSchema.safeParse({ kind: 'component', itemIds: [] }).success).toBe(false); // needs at least one candidate
    expect(LootDropSchema.safeParse({ kind: 'choice', itemIds: ['x'] }).success).toBe(false); // a choice needs >= 2 to choose from
    expect(LootDropSchema.safeParse({ kind: 'choice', itemIds: ['x', 'y'] }).success).toBe(true);
    expect(LootDropSchema.safeParse({ kind: 'gizmo', itemIds: ['x'] }).success).toBe(false);
  });

  it('content hash is stable across key order and whitespace and changes when a value changes', () => {
    const raw = rawDevContent();
    const h1 = computeContentHash(raw as unknown as Record<string, unknown>);
    const shuffled: Record<string, unknown> = {};
    for (const k of Object.keys(raw).reverse()) shuffled[k] = deepReverseKeys((raw as unknown as Record<string, unknown>)[k]);
    expect(computeContentHash(shuffled)).toBe(h1);
    const reindented = JSON.parse(JSON.stringify(shuffled, null, 8)) as Record<string, unknown>;
    expect(computeContentHash(reindented)).toBe(h1);
    const changed = clone(raw) as unknown as Record<string, Record<string, unknown>>;
    (changed['rules'] as { tickRate: number }).tickRate = 60;
    expect(computeContentHash(changed)).not.toBe(h1);
    expect(loadContent(changed as unknown as RawContentFiles).contentHash).not.toBe(devContent().contentHash);
  });

  it('manifest maps paths to schema kinds and rejects unknown paths', () => {
    expect(kindForPath('board.json')).toBe('board');
    expect(kindForPath('dev/rules.json')).toBe('rules');
    expect(kindForPath('dev/boards/a.json')).toBe('boardFile');
    expect(kindForPath('../package.json')).toBeNull();
    expect(kindForPath('dev/boards/../../x.json')).toBeNull();
  });
});

function deepReverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(deepReverseKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).reverse()) out[k] = deepReverseKeys((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}
