import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { flagBool, flagInt, flagSeed, flagString, parseArgs, UsageError } from '../tools/args.ts';
import { getPolicy, policyNames } from '../tools/policies/index.ts';
import type { SweepJobResult } from '../tools/sweep-worker.ts';
import { aggregate, DEFAULT_JOB_TIMEOUT_MS, DEFAULT_SWEEP_WORKERS, MAX_JOB_TIMEOUT_MS, parsePolicies, resolveOutPath, resolveWorkers, runSweep } from '../tools/sweep.ts';

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

describe('tools/sweep robustness (P0-B2)', () => {
  /** A sweep whose workers hard-exit on the given seeds (an OOM or thread abort stand-in). */
  const misbehavingSweep = (seeds: number[], workers: number, misbehaviour: Record<string, number[]>): Promise<SweepJobResult[]> =>
    runSweep(seeds, ['random'], workers, {
      workerUrl: new URL('./fixtures/crash-worker.ts', import.meta.url),
      workerData: { role: 'sweep-double', ...misbehaviour },
    });
  const crashingSweep = (seeds: number[], workers: number, crashOnSeeds: number[]): Promise<SweepJobResult[]> =>
    misbehavingSweep(seeds, workers, { crashOnSeeds });

  it('validates SIEGE_SWEEP_WORKERS exactly like --workers', () => {
    const noFlag = parseArgs([]);
    expect(resolveWorkers(noFlag, {})).toBe(DEFAULT_SWEEP_WORKERS);
    expect(resolveWorkers(noFlag, { SIEGE_SWEEP_WORKERS: '8' })).toBe(8);
    for (const bad of ['0', '-5', 'abc', '99999', '2.5']) {
      expect(() => resolveWorkers(noFlag, { SIEGE_SWEEP_WORKERS: bad }), bad).toThrow(UsageError);
    }
    // An exported-but-empty variable means "unset", as it does for SIEGE_TEST_WORKERS.
    expect(resolveWorkers(noFlag, { SIEGE_SWEEP_WORKERS: '' })).toBe(DEFAULT_SWEEP_WORKERS);
    // The flag still wins over the environment, and is validated as before.
    expect(resolveWorkers(parseArgs(['--workers', '2']), { SIEGE_SWEEP_WORKERS: '8' })).toBe(2);
    expect(() => resolveWorkers(parseArgs(['--workers', '65']), {})).toThrow(/<= 64/);
  });

  it('de-duplicates --policies instead of double-counting them', () => {
    expect(parsePolicies('random,random')).toEqual(['random']);
    expect(parsePolicies(' random , random ')).toEqual(['random']);
    expect(() => parsePolicies('')).toThrow(UsageError);
    expect(() => parsePolicies('nope')).toThrow(/unknown policy nope/);
  });

  it('resolves --out before any job runs: creates missing parents, rejects what cannot be written', () => {
    const base = mkdtempSync(join(tmpdir(), 'siege-sweep-'));
    const nested = join(base, 'deep', 'inner', 'report.json');
    expect(resolveOutPath(parseArgs(['--out', nested]), 'stamp')).toBe(nested);
    expect(existsSync(dirname(nested))).toBe(true);
    // A directory, a parent that is a file, and a dangling symlink all fail here rather than
    // after the whole sweep has been computed (QA on P0-B2).
    expect(() => resolveOutPath(parseArgs(['--out', base]), 'stamp')).toThrow(UsageError);
    const file = join(base, 'plain.txt');
    writeFileSync(file, 'x', 'utf8');
    expect(() => resolveOutPath(parseArgs(['--out', join(file, 'report.json')]), 'stamp')).toThrow(UsageError);
    const dangling = join(base, 'dangling.json');
    symlinkSync(join(base, 'no', 'such', 'target.json'), dangling);
    expect(() => resolveOutPath(parseArgs(['--out', dangling]), 'stamp')).toThrow(UsageError);
    rmSync(base, { recursive: true, force: true });
  });

  it('a misbehaving worker cannot double-count, forge or crash the report', async () => {
    // A duplicate answer, an answer for a job that was never dispatched, and a malformed
    // message: each is dropped, and the job it belonged to is reported as unanswered.
    const results = await misbehavingSweep([1, 2, 3, 4], 2, { doubleAnswerSeeds: [1], wrongSeedSeeds: [2], garbageSeeds: [3] });
    expect(results.map((r) => r.seed)).toEqual([1, 2, 3, 4]);
    expect(results.filter((r) => r.ok).map((r) => r.seed)).toEqual([1, 4]);
    for (const seed of [2, 3]) expect(results.find((r) => r.seed === seed)!.error).toMatch(/no worker answered/);
    expect(aggregate(results, ['random'])[0]!.runs).toBe(4);
  }, 60_000);

  it('runSweep de-duplicates policies and seeds for every caller, not just the CLI', async () => {
    const results = await runSweep([1, 1, 2], ['random', 'random'], 2);
    expect(results.map((r) => r.seed)).toEqual([1, 2]);
  }, 60_000);

  it('a crashed worker loses only its own job: the rest of the sweep still reports', async () => {
    const results = await crashingSweep([1, 2, 3, 4], 2, [3]);
    expect(results).toHaveLength(4);
    const dead = results.find((r) => r.seed === 3)!;
    expect(dead.ok).toBe(false);
    expect(dead.error).toMatch(/worker/i);
    for (const r of results.filter((r) => r.seed !== 3)) expect(r.ok, `seed ${r.seed}`).toBe(true);
    // Aggregates still count the crash as an exception rather than losing the run.
    expect(aggregate(results, ['random'])[0]!.exceptions).toBe(1);
  }, 60_000);

  it('the queue survives every worker dying at once: replacements finish the remaining jobs', async () => {
    // Jobs are handed out in order, so with 2 workers seeds 1 and 2 go out first and kill both
    // workers immediately. Without replacement workers, seeds 3..6 would never run at all.
    const results = await crashingSweep([1, 2, 3, 4, 5, 6], 2, [1, 2]);
    expect(results.map((r) => r.seed)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(results.filter((r) => !r.ok).map((r) => r.seed)).toEqual([1, 2]);
    expect(results.filter((r) => r.ok)).toHaveLength(4);
    expect(aggregate(results, ['random'])[0]!.exceptions).toBe(2);
  }, 60_000);

  it('the CLI rejects a bad --out before running any job', () => {
    // 500 seeds would take many seconds; failing fast means the error arrives long before that.
    const cli = fileURLToPath(new URL('../tools/sweep.ts', import.meta.url));
    const t0 = Date.now();
    const r = spawnSync(process.execPath, ['--import', 'tsx', cli, '--seeds', '500', '--out', tmpdir()], { encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toMatch(/--out is a directory/);
    expect(Date.now() - t0).toBeLessThan(20_000);
  }, 60_000);
});

describe('tools/sweep worker liveness (P0-B3)', () => {
  // The waits are shortened, but with room for a loaded host: the fast tier is the per-item
  // gate and may run alongside a second lane, so a tight budget would make these flaky.
  const stub = (seeds: number[], workers: number, workerData: Record<string, unknown>, jobTimeoutMs = 4000): Promise<SweepJobResult[]> =>
    runSweep(seeds, ['random'], workers, {
      workerUrl: new URL('./fixtures/crash-worker.ts', import.meta.url),
      workerData: { role: 'sweep-double', ...workerData },
      jobTimeoutMs,
      exitGraceMs: 500,
    });

  it('a worker that never answers is timed out, not waited on forever', async () => {
    const results = await stub([1, 2, 3, 4], 2, { silentSeeds: [2] });
    expect(results.map((r) => r.seed)).toEqual([1, 2, 3, 4]);
    const stuck = results.find((r) => r.seed === 2)!;
    expect(stuck.ok).toBe(false);
    expect(stuck.error).toMatch(/timed out/i);
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  }, 60_000);

  it('a worker that never exits does not hold up a finished sweep', async () => {
    // Nothing here depends on the watchdog: the exit grace is what has to fire.
    const results = await stub([1, 2, 3, 4], 2, { linger: true }, DEFAULT_JOB_TIMEOUT_MS);
    expect(results.map((r) => r.seed)).toEqual([1, 2, 3, 4]);
    expect(results.every((r) => r.ok)).toBe(true);
  }, 60_000);

  it('a wedged job never abandons the healthy jobs queued behind it', async () => {
    // Two jobs wedge at the head of the queue; the six behind them must still run, and the
    // outcome must not depend on --workers (an earlier timeout cap broke both).
    // Five wedged jobs is more than any per-pool timeout budget would allow, which is what an
    // earlier cap tripped over: it stopped feeding the queue and booked the rest as failures.
    const wedged = [1, 2, 3, 4, 5, 6];
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    const [twoWorkers, fourWorkers] = await Promise.all([
      stub(seeds, 2, { silentSeeds: wedged }, 1500),
      stub(seeds, 4, { silentSeeds: wedged }, 1500),
    ]);
    for (const results of [twoWorkers, fourWorkers]) {
      expect(results.map((r) => r.seed)).toEqual(seeds);
      expect(results.filter((r) => r.ok).map((r) => r.seed)).toEqual([7, 8, 9, 10, 11, 12]);
    }
    // A harness timeout is reported apart from a run that actually threw.
    const agg = aggregate(twoWorkers, ['random'])[0]!;
    expect(agg.exceptions).toBe(6);
    expect(agg.timeouts).toBe(6);
  }, 60_000);

  it('--job-timeout is capped below the setTimeout overflow point', () => {
    expect(MAX_JOB_TIMEOUT_MS).toBe(2_147_483_647);
    expect(flagInt(parseArgs(['--job-timeout', String(MAX_JOB_TIMEOUT_MS)]), 'job-timeout', 1, { min: 1000, max: MAX_JOB_TIMEOUT_MS })).toBe(MAX_JOB_TIMEOUT_MS);
    expect(() => flagInt(parseArgs(['--job-timeout', '2147483648']), 'job-timeout', 1, { min: 1000, max: MAX_JOB_TIMEOUT_MS })).toThrow(UsageError);
  });

  it('flagString rejects a bare flag, like flagInt does', () => {
    expect(flagString(parseArgs(['--out', 'x.json']), 'out', 'd')).toBe('x.json');
    expect(flagString(parseArgs([]), 'out', 'd')).toBe('d');
    expect(() => flagString(parseArgs(['--out']), 'out', 'd')).toThrow(UsageError);
    expect(() => flagString(parseArgs(['--policies']), 'policies', 'random')).toThrow(/--policies/);
    // An explicitly empty value is just as unusable as a missing one.
    expect(() => flagString(parseArgs(['--out=']), 'out', 'd')).toThrow(UsageError);
  });
});
