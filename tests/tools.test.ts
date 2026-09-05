import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flagBool, flagInt, flagSeed, flagString, parseArgs, UsageError } from '../tools/args.ts';
import { getPolicy, policyNames } from '../tools/policies/index.ts';
import { runSweep } from '../tools/sweep.ts';

describe('tools/args', () => {
  it('parses --key value, --key=value, bare flags and positionals', () => {
    // A bare flag followed by a bare token takes it as its value, so positionals go before flags.
    const a = parseArgs(['file.json', '--seed', '7', '--policy=random', '--events', '--x']);
    expect(a.flags).toEqual({ seed: '7', policy: 'random', events: true, x: true });
    expect(a.positional).toEqual(['file.json']);
    expect(flagString(a, 'policy', 'z')).toBe('random');
    expect(flagString(a, 'missing', 'z')).toBe('z');
    expect(flagBool(a, 'events')).toBe(true);
    expect(flagBool(a, 'nope')).toBe(false);
  });
  it('flagInt is strict about integers and ranges', () => {
    expect(flagInt(parseArgs(['--n', '12']), 'n', 0)).toBe(12);
    expect(flagInt(parseArgs(['--n', '-3']), 'n', 0)).toBe(-3);
    expect(flagInt(parseArgs([]), 'n', 5)).toBe(5);
    expect(() => flagInt(parseArgs(['--n', '1.5']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n', 'abc']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n']), 'n', 0)).toThrow(UsageError);
    expect(() => flagInt(parseArgs(['--n', '0']), 'n', 1, { min: 1 })).toThrow(/>= 1/);
    expect(() => flagInt(parseArgs(['--n', '99']), 'n', 1, { max: 10 })).toThrow(/<= 10/);
  });
  it('flagSeed enforces the 32-bit seed range', () => {
    expect(flagSeed(parseArgs(['--seed', '0']), 'seed', 1)).toBe(0);
    expect(flagSeed(parseArgs(['--seed', '4294967295']), 'seed', 1)).toBe(4294967295);
    expect(() => flagSeed(parseArgs(['--seed', '-1']), 'seed', 1)).toThrow(UsageError);
    expect(() => flagSeed(parseArgs(['--seed', '4294967296']), 'seed', 1)).toThrow(UsageError);
    expect(() => flagSeed(parseArgs(['--seed', '1.5']), 'seed', 1)).toThrow(UsageError);
  });
  it('unknown policies are a usage error', () => {
    expect(policyNames()).toContain('random');
    expect(() => getPolicy('nope')).toThrow(UsageError);
  });
});

describe('tools/sweep worker (P0-B1)', () => {
  // The sweep spawns `sweep-worker.ts` as a worker thread. Node >= 22.18 strips types itself,
  // and strip-only mode rejects non-erasable syntax (parameter properties, enums, namespaces),
  // so every module the worker reaches must stay erasable. This test loads that whole graph
  // with plain `node`, exactly as the worker does.
  it('the worker module graph loads under Node type stripping', () => {
    const entry = fileURLToPath(new URL('../tools/sweep-worker.ts', import.meta.url));
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(entry)});`], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.stderr).not.toContain('ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX');
    expect(r.status, r.stderr).toBe(0);
  });

  it('a multi-worker sweep completes and matches the single-threaded results', async () => {
    const results = await runSweep([1, 2, 3, 4], ['random'], 2);
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.error, `seed ${r.seed}`).toBeNull();
    // Worker scheduling must not touch outcomes: everything but the wall time is identical.
    const withoutTiming = (rs: typeof results): unknown[] => rs.map(({ ms: _ms, ...rest }) => rest);
    expect(withoutTiming(results)).toEqual(withoutTiming(await runSweep([1, 2, 3, 4], ['random'], 1)));
  }, 60_000);
});
