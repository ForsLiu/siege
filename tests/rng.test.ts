import { describe, expect, it } from 'vitest';
import { createRngStates, deriveStreamState, Rng, STREAM_NAMES } from '../src/sim/rng.ts';

describe('rng', () => {
  it('is deterministic for (seed, stream)', () => {
    const a = Rng.fromSeed(42, 'shop');
    const b = Rng.fromSeed(42, 'shop');
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });
  it('streams differ from each other and across seeds', () => {
    const seen = new Set<string>();
    for (const seed of [0, 1, 2, 12345, 0xffffffff]) {
      for (const name of STREAM_NAMES) {
        const s = deriveStreamState(seed, name);
        seen.add(`${s.a},${s.b},${s.c},${s.d}`);
      }
    }
    expect(seen.size).toBe(5 * STREAM_NAMES.length);
  });
  it('state round-trips', () => {
    const a = Rng.fromSeed(7, 'combat');
    a.next();
    a.next();
    const b = new Rng(a.state());
    for (let i = 0; i < 10; i++) expect(a.next()).toBe(b.next());
  });
  it('next() is in [0,1) and int(n) is in range with a roughly uniform spread', () => {
    const r = Rng.fromSeed(3, 'misc');
    const buckets = new Array<number>(10).fill(0);
    for (let i = 0; i < 20000; i++) {
      const v = r.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      const k = r.int(10);
      expect(k).toBeGreaterThanOrEqual(0);
      expect(k).toBeLessThan(10);
      buckets[k] = (buckets[k] as number) + 1;
    }
    for (const b of buckets) expect(Math.abs(b - 2000)).toBeLessThan(200);
  });
  it('pick and shuffle are deterministic and shuffle is a permutation', () => {
    const r1 = Rng.fromSeed(9, 'loot');
    const r2 = Rng.fromSeed(9, 'loot');
    const arr1 = r1.shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    const arr2 = r2.shuffle([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(arr1).toEqual(arr2);
    expect([...arr1].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r1.pick(['a', 'b', 'c'])).toBe(r2.pick(['a', 'b', 'c']));
  });
  it('rejects bad int arguments', () => {
    const r = Rng.fromSeed(1, 'misc');
    expect(() => r.int(0)).toThrow();
    expect(() => r.int(1.5)).toThrow();
    expect(() => r.pick([])).toThrow();
  });
  it('createRngStates covers every stream', () => {
    const s = createRngStates(1);
    expect(Object.keys(s).sort()).toEqual([...STREAM_NAMES].sort());
  });
});
