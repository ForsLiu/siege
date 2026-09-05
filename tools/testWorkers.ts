// Worker count for vitest, shared between parallel lanes via SIEGE_TEST_WORKERS (CLAUDE.md).
//
// P0-B3: this used to be `Number.parseInt(env ?? '4', 10) || 4`, whose `|| 4` catches NaN and 0
// but not a negative. `SIEGE_TEST_WORKERS=-5` reached vitest's maxWorkers unchanged, vitest then
// collected no test file at all, and the process exited 0 — the per-item gate reporting green
// having run nothing. An unusable value is now a loud failure instead.
//
// It is a separate knob from SIEGE_SWEEP_WORKERS (the sweep's own thread cap) and is parsed the
// same way: trimmed, blank means unset. Only an unusable value throws (a non-integer, or a count
// below 1, which is the bug above). A count above the cap is clamped rather than rejected: a big
// host asking for more workers than we want should still be able to run the suite at all.
export const TEST_WORKERS_DEFAULT = 4;
export const TEST_WORKERS_MAX = 64;

export function resolveTestWorkers(env: Record<string, string | undefined>): number {
  const raw = env.SIEGE_TEST_WORKERS?.trim();
  if (raw === undefined || raw === '') return TEST_WORKERS_DEFAULT;
  if (!/^\d+$/.test(raw)) throw new Error(`SIEGE_TEST_WORKERS must be a positive integer, got ${JSON.stringify(env.SIEGE_TEST_WORKERS)}`);
  const n = Number.parseInt(raw, 10);
  if (n < 1) throw new Error(`SIEGE_TEST_WORKERS must be >= 1, got ${n}`);
  return Math.min(n, TEST_WORKERS_MAX);
}
