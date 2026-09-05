// npx tsx tools/sweep.ts --seeds 50 --policies random [--workers 4] [--start 1] [--out bench/sweep-<stamp>.json]
// Runs seeds x policies in worker threads (cap SIEGE_SWEEP_WORKERS, default 4), prints a table,
// writes bench/sweep-<stamp>.json (gitignored).
import { accessSync, closeSync, constants, mkdirSync, openSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { REPO_ROOT, loadContentFromDisk } from '../src/data/node.ts';
import { flagInt, flagSeed, flagString, parseArgs, SEED_MAX, UsageError, type Args } from './args.ts';
import { policyNames } from './policies/index.ts';
import { runJob, type SweepJob, type SweepJobResult } from './sweep-worker.ts';

/** Worker threads when neither --workers nor SIEGE_SWEEP_WORKERS says otherwise. */
export const DEFAULT_SWEEP_WORKERS = 4;
const MAX_SWEEP_WORKERS = 64;

/**
 * Worker count from --workers, else SIEGE_SWEEP_WORKERS, else the default. The environment
 * value is validated exactly like the flag: a silent fallback used to turn `-5` into a serial
 * run (never exercising a worker at all) and `99999` into 99999 threads.
 */
export function resolveWorkers(args: Args, env: Record<string, string | undefined>): number {
  const raw = env['SIEGE_SWEEP_WORKERS'];
  let fallback = DEFAULT_SWEEP_WORKERS;
  // An exported-but-empty variable (`VAR= cmd`, docker `-e VAR`) means "unset", as it does for
  // SIEGE_TEST_WORKERS in vitest.config.ts; anything else must be a valid count.
  if (raw !== undefined && raw !== '') {
    if (!/^-?\d+$/.test(raw)) throw new UsageError(`SIEGE_SWEEP_WORKERS must be an integer, got ${JSON.stringify(raw)}`);
    fallback = Number.parseInt(raw, 10);
    if (fallback < 1 || fallback > MAX_SWEEP_WORKERS) throw new UsageError(`SIEGE_SWEEP_WORKERS must be between 1 and ${MAX_SWEEP_WORKERS}, got ${fallback}`);
  }
  return flagInt(args, 'workers', fallback, { min: 1, max: MAX_SWEEP_WORKERS });
}

/** Policy list from a comma-separated flag: trimmed, de-duplicated (order kept) and validated. */
export function parsePolicies(raw: string): string[] {
  const seen: string[] = [];
  for (const name of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (!policyNames().includes(name)) throw new UsageError(`unknown policy ${name} (available: ${policyNames().join(', ')})`);
    if (!seen.includes(name)) seen.push(name);
  }
  if (seen.length === 0) throw new UsageError('--policies must name at least one policy');
  return seen;
}

/**
 * Report path, resolved and made writable *before* the sweep runs: a missing parent directory
 * or an --out pointing at a directory used to throw after every job had already been computed.
 */
export function resolveOutPath(args: Args, stamp: string): string {
  const fallback = join(REPO_ROOT, 'bench', `sweep-${stamp}.json`);
  const out = resolve(flagString(args, 'out', fallback));
  let existing: ReturnType<typeof statSync> | null = null;
  try {
    existing = statSync(out);
  } catch {
    existing = null;
  }
  if (existing && existing.isDirectory()) throw new UsageError(`--out is a directory: ${out}`);
  try {
    mkdirSync(dirname(out), { recursive: true });
    accessSync(dirname(out), constants.W_OK);
  } catch (e) {
    throw new UsageError(`--out directory is not writable: ${dirname(out)} (${e instanceof Error ? e.message : String(e)})`);
  }
  // Probe the file itself too: a dangling symlink or an unwritable existing file passes every
  // directory-level check and would otherwise only fail once the whole sweep had been computed.
  try {
    closeSync(openSync(out, 'a'));
  } catch (e) {
    throw new UsageError(`--out is not writable: ${out} (${e instanceof Error ? e.message : String(e)})`);
  }
  return out;
}

export interface PolicyAggregate {
  policy: string;
  runs: number;
  exceptions: number;
  winRate: number;
  meanRoundsSurvived: number;
  meanFightTicks: number;
  p95FightTicks: number;
  meanFinalHp: number;
  meanFinalLevel: number;
  meanCommands: number;
  meanMs: number;
}

export interface SweepReport {
  stamp: string;
  contentHash: string;
  seeds: number[];
  policies: string[];
  workers: number;
  totalMs: number;
  aggregates: PolicyAggregate[];
  results: SweepJobResult[];
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

export function aggregate(results: SweepJobResult[], policies: string[]): PolicyAggregate[] {
  return policies.map((policy) => {
    const rs = results.filter((r) => r.policy === policy);
    const ok = rs.filter((r) => r.ok);
    const ticks = ok.flatMap((r) => r.fightTicks).sort((a, b) => a - b);
    const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
    return {
      policy,
      runs: rs.length,
      exceptions: rs.length - ok.length,
      winRate: ok.length ? ok.filter((r) => r.outcome === 'win').length / ok.length : 0,
      meanRoundsSurvived: mean(ok.map((r) => r.roundsSurvived)),
      meanFightTicks: mean(ticks),
      p95FightTicks: percentile(ticks, 95),
      meanFinalHp: mean(ok.map((r) => r.finalHp)),
      meanFinalLevel: mean(ok.map((r) => r.finalLevel)),
      meanCommands: mean(ok.map((r) => r.commandCount)),
      // Successful runs only: a crashed worker reports no elapsed time and would bias the mean.
      meanMs: mean(ok.map((r) => r.ms)),
    };
  });
}

export interface SweepOptions {
  /** Worker entry; overridden by tests to inject a worker that dies mid-job. */
  workerUrl?: URL;
  /** Extra workerData merged into `{ role: 'sweep' }`. */
  workerData?: Record<string, unknown>;
}

/** Identity of a job, for de-duplication. */
function jobKey(j: { seed: number; policy: string }): string {
  return `${j.policy}\u0000${j.seed}`;
}

/** A worker message that at least has the shape of a result. */
function isResultShape(r: unknown): r is SweepJobResult {
  if (typeof r !== 'object' || r === null) return false;
  const c = r as Partial<SweepJobResult>;
  return typeof c.seed === 'number' && typeof c.policy === 'string' && typeof c.ok === 'boolean' && Array.isArray(c.fightTicks);
}

/** The result recorded for a job whose worker died before it could answer. */
function crashedResult(job: SweepJob, reason: string): SweepJobResult {
  return {
    seed: job.seed,
    policy: job.policy,
    ok: false,
    error: reason,
    outcome: null,
    roundsSurvived: 0,
    finalHp: 0,
    finalGold: 0,
    finalLevel: 0,
    commandCount: 0,
    fightTicks: [],
    finalHash: null,
    ms: 0,
  };
}

export async function runSweep(seeds: number[], policies: string[], workers: number, opts: SweepOptions = {}): Promise<SweepJobResult[]> {
  const jobs: SweepJob[] = [];
  // De-duplicated here as well as in the CLI, so any caller gets one run per (policy, seed).
  const uniquePolicies = [...new Set(policies)];
  const uniqueSeeds = [...new Set(seeds)];
  for (const policy of uniquePolicies) for (const seed of uniqueSeeds) jobs.push({ seed, policy });
  // Results are sorted the same way on both paths, so a report never depends on --workers.
  if (workers <= 1 || jobs.length <= 1) return sortResults(jobs.map(runJob));

  const results: SweepJobResult[] = [];
  let next = 0;
  // A dying worker costs its in-flight job and nothing else: it is recorded as an exception and
  // a replacement takes over the queue. Each death consumes one job, so the loop still ends.
  let deaths = 0;
  const workerUrl = opts.workerUrl ?? new URL('./sweep-worker.ts', import.meta.url);
  const spawn = (): Promise<void> =>
    new Promise((resolveSpawn) => {
      // No execArgv: the worker's module graph is loaded by Node's own type stripping, so it
      // must stay erasable (enforced by tsconfig's erasableSyntaxOnly). A `--import tsx` preload
      // would resolve tsx relative to the process CWD and fail outside the repo root (P0-B1).
      const w = new Worker(workerUrl, { workerData: { role: 'sweep', ...opts.workerData } });
      let current: SweepJob | null = null;
      let settled = false;
      const feed = (): void => {
        if (next >= jobs.length) {
          current = null;
          w.postMessage('exit');
          return;
        }
        current = jobs[next++] as SweepJob;
        w.postMessage(current);
      };
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolveSpawn();
      };
      const died = (reason: string): void => {
        if (settled) return;
        settled = true;
        if (current !== null) {
          results.push(crashedResult(current, reason));
          current = null;
        }
        deaths++;
        // Replace the worker while jobs remain, so a death costs one job and not the queue.
        // Each spawn takes a job before it can die, so `deaths` cannot outrun `jobs.length`;
        // the bound is belt-and-braces. A replacement that cannot even start is swallowed --
        // the completeness pass below records whatever it leaves unanswered.
        resolveSpawn(next < jobs.length && deaths <= jobs.length ? spawn().catch(() => undefined) : undefined);
      };
      // Worker messages are checked, not trusted: an unchecked duplicate double-counts a run,
      // and an unchecked malformed message used to throw out of sorting and lose every
      // completed result. A repeat of something this worker already answered is ignored;
      // anything else that does not match the outstanding job leaves that job unanswered, and
      // the completeness pass below records it as a failure.
      const answeredHere = new Set<string>();
      w.on('message', (r: unknown) => {
        if (settled) return;
        if (isResultShape(r) && answeredHere.has(jobKey(r))) return;
        const expected = current;
        if (expected === null) return;
        current = null;
        if (isResultShape(r) && r.seed === expected.seed && r.policy === expected.policy) {
          answeredHere.add(jobKey(expected));
          results.push(r);
        }
        feed();
      });
      w.on('error', (e: Error) => {
        void w.terminate();
        died(`worker error: ${e.message}`);
      });
      w.on('exit', (code) => {
        if (code === 0 && current === null) finish();
        else died(`worker exited with ${code}`);
      });
      feed();
    });
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, spawn));
  // Completeness: a job no worker ever answered for is reported as a failure rather than
  // quietly missing from the report.
  const answered = new Set(results.map(jobKey));
  for (const j of jobs) {
    if (!answered.has(jobKey(j))) results.push(crashedResult(j, 'no worker answered for this job'));
  }
  return sortResults(results);
}

function sortResults(results: SweepJobResult[]): SweepJobResult[] {
  results.sort((a, b) => a.policy.localeCompare(b.policy) || a.seed - b.seed);
  return results;
}

export function formatTable(aggs: PolicyAggregate[]): string {
  const header = 'policy     runs  exc  win%   rounds  ticks(mean)  ticks(p95)  hp     lvl   cmds   ms/run';
  const rows = aggs.map(
    (a) =>
      `${a.policy.padEnd(10)} ${String(a.runs).padStart(4)}  ${String(a.exceptions).padStart(3)}  ${(a.winRate * 100).toFixed(0).padStart(4)}  ${a.meanRoundsSurvived.toFixed(2).padStart(7)}  ${a.meanFightTicks.toFixed(0).padStart(11)}  ${String(a.p95FightTicks).padStart(10)}  ${a.meanFinalHp.toFixed(1).padStart(5)}  ${a.meanFinalLevel.toFixed(1).padStart(4)}  ${a.meanCommands.toFixed(0).padStart(5)}  ${a.meanMs.toFixed(0).padStart(6)}`,
  );
  return [header, ...rows].join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const nSeeds = flagInt(args, 'seeds', 20, { min: 1, max: 1_000_000 });
  const start = flagSeed(args, 'start', 1);
  if (start + nSeeds - 1 > SEED_MAX) throw new UsageError(`--start + --seeds exceeds the seed range (max ${SEED_MAX})`);
  const policies = parsePolicies(flagString(args, 'policies', 'random'));
  const workers = resolveWorkers(args, process.env);
  const seeds = Array.from({ length: nSeeds }, (_, i) => start + i);
  const content = loadContentFromDisk();
  // Resolved before any job runs, so a bad --out costs nothing.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = resolveOutPath(args, stamp);

  const t0 = performance.now();
  const results = await runSweep(seeds, policies, workers);
  const totalMs = performance.now() - t0;
  const aggregates = aggregate(results, policies);
  const report: SweepReport = { stamp, contentHash: content.contentHash, seeds, policies, workers, totalMs, aggregates, results };
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`sweep  seeds=${seeds[0]}..${seeds[seeds.length - 1]}  policies=${policies.join(',')}  workers=${workers}  content=${content.contentHash.slice(0, 16)}  ${totalMs.toFixed(0)} ms`);
  console.log(formatTable(aggregates));
  const failures = results.filter((r) => !r.ok);
  for (const f of failures.slice(0, 5)) console.log(`EXCEPTION seed=${f.seed} policy=${f.policy}: ${f.error?.split('\n')[0]}`);
  console.log(`written ${outPath}`);
  if (failures.length > 0) process.exitCode = 1;
}

const invokedDirectly = process.argv[1] !== undefined && /sweep\.ts$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  main().catch((e: unknown) => {
    if (e instanceof Error && (e.name === 'UsageError' || e.name === 'ContentError')) console.error(`error: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
}
