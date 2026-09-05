import { describe, expect, it } from 'vitest';
import { computeStat, STAT_KIND, STAT_NAMES, type Modifier } from '../src/sim/stats.ts';
import { getStat, invalidateStats, type StatCarrier } from '../src/sim/units.ts';
import { ZERO_STATS } from './helpers.ts';

const mod = (source: string, stat: Modifier['stat'], mode: Modifier['mode'], value: number): Modifier => ({ source, stat, mode, value, expiresTick: null });

describe('stat stacking', () => {
  it('different sources multiply: +10% and +20% => x1.32', () => {
    const v = computeStat(100, 'attack', [mod('a', 'attack', 'mul', 0.1), mod('b', 'attack', 'mul', 0.2)]);
    // "Exactly x1.32" in float terms: 1.1 * 1.2 is 1.3200000000000003, so equal within 1e-10, not toBe.
    expect(v).toBeCloseTo(132, 10);
  });
  it('ranks within one source add: +10% and +20% from the same source => x1.30', () => {
    const v = computeStat(100, 'attack', [mod('a', 'attack', 'mul', 0.1), mod('a', 'attack', 'mul', 0.2)]);
    expect(v).toBeCloseTo(130, 10);
  });
  it('flat stats add and apply before multipliers', () => {
    expect(computeStat(50, 'armor', [mod('a', 'armor', 'flat', 10), mod('b', 'armor', 'flat', 15)])).toBe(75);
    expect(computeStat(100, 'hp', [mod('a', 'hp', 'flat', 50), mod('b', 'hp', 'mul', 0.5)])).toBe(225);
  });
  it('ignores modifiers for other stats and clamps at zero', () => {
    expect(computeStat(100, 'attack', [mod('a', 'hp', 'mul', 5)])).toBe(100);
    expect(computeStat(10, 'armor', [mod('a', 'armor', 'flat', -50)])).toBe(0);
  });
  it('rejects mul modifiers on flat-kind stats', () => {
    expect(() => computeStat(1, 'range', [mod('a', 'range', 'mul', 0.5)])).toThrow();
  });
  it('rounds integer stats', () => {
    expect(computeStat(3, 'range', [mod('a', 'range', 'flat', 0.4)])).toBe(3);
    expect(computeStat(60, 'maxMana', [mod('a', 'maxMana', 'flat', 0.6)])).toBe(61);
  });
  it('every stat has a kind', () => {
    for (const s of STAT_NAMES) expect(['mul', 'flat']).toContain(STAT_KIND[s]);
  });
  it('carrier cache is invalidated when modifiers change', () => {
    const c: StatCarrier = { base: { ...ZERO_STATS, attack: 10 }, modifiers: [], statCache: null };
    expect(getStat(c, 'attack')).toBe(10);
    c.modifiers.push(mod('x', 'attack', 'mul', 1));
    expect(getStat(c, 'attack')).toBe(10); // stale until invalidated (by design: callers invalidate)
    invalidateStats(c);
    expect(getStat(c, 'attack')).toBe(20);
  });
});
