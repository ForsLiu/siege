// P0-B3: the per-item gate must never report green having run nothing.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/data/node.ts';
import { resolveTestWorkers } from '../tools/testWorkers.ts';

describe('vitest worker count (P0-B3)', () => {
  it('accepts a positive integer, trims it, and defaults to 4', () => {
    expect(resolveTestWorkers({})).toBe(4);
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '1' })).toBe(1);
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: ' 8 ' })).toBe(8);
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '64' })).toBe(64);
    // Above the cap is clamped, not refused: a host configured for 96 workers must still be
    // able to run the suite (QUESTIONS.md P0-B3-01).
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '96' })).toBe(64);
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '4\n' })).toBe(4);
    // Blank counts as unset, exactly like SIEGE_SWEEP_WORKERS.
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '' })).toBe(4);
    expect(resolveTestWorkers({ SIEGE_TEST_WORKERS: '   ' })).toBe(4);
  });

  it('refuses a value vitest would turn into an empty run', () => {
    // -5 used to reach maxWorkers unchanged: vitest then collected no file at all and the
    // process still exited 0, so `npm run test:fast` looked green having run nothing.
    for (const bad of ['-5', '-1', '0', '1.5', 'abc', '1e2', '+4', '0x10']) {
      expect(() => resolveTestWorkers({ SIEGE_TEST_WORKERS: bad }), bad).toThrow(/SIEGE_TEST_WORKERS/);
    }
  });

  const runVitest = (workers: string): { status: number | null; output: string; error: Error | undefined } => {
    const vitest = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
    const r = spawnSync(process.execPath, [vitest, 'run', 'tests/hex.test.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      // Below the 120 s test timeout, so a hung child is reported as a spawn timeout with its
      // output rather than as a bare harness timeout.
      timeout: 60_000,
      // Vitest's own pool variables are dropped: the child must not look like a worker of this run.
      env: { ...process.env, VITEST_POOL_ID: undefined, VITEST_WORKER_ID: undefined, SIEGE_TEST_WORKERS: workers },
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}`, error: r.error };
  };

  it('a real vitest run with an invalid worker count fails loudly instead of collecting nothing', () => {
    const r = runVitest('-5');
    // A spawn that never started or timed out leaves status null, which would satisfy
    // `not.toBe(0)` for the wrong reason (QA on P0-B3).
    expect(r.error, `spawn failed: ${String(r.error)}`).toBeUndefined();
    expect(r.status, r.output).not.toBeNull();
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toMatch(/SIEGE_TEST_WORKERS/);
  }, 120_000);

  it('a real vitest run with a count above the cap clamps and still collects test files', () => {
    // The other half of the gate: the invalid case must fail, and the valid case must actually
    // run something. Without this, a parser that threw on every value would look fixed.
    const r = runVitest('96');
    expect(r.error, `spawn failed: ${String(r.error)}`).toBeUndefined();
    expect(r.status, r.output).toBe(0);
    expect(r.output).toMatch(/Test Files\s+1 passed/);
  }, 120_000);
});
