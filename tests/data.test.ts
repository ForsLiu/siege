import { describe, expect, it } from 'vitest';
import { computeContentHash, loadContent, validateFile, type RawContentFiles } from '../src/data/loader.ts';
import { kindForPath } from '../src/data/manifest.ts';
import { EffectSchema, EncounterSchema, StatBlockSchema, UnitDefSchema } from '../src/data/schemas.ts';
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
    for (const kind of ['board', 'rules', 'units', 'encounters'] as const) expect(validateFile(kind, raw[kind]).ok, kind).toBe(true);
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
