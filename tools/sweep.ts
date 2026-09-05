// npx tsx tools/sweep.ts --seeds 50 --policies random [--workers 4] [--start 1] [--out bench/sweep-<stamp>.json]
// Runs seeds x policies in worker threads (cap SIEGE_SWEEP_WORKERS, default 4), prints a table,
// writes bench/sweep-<stamp>.json (gitignored).
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { REPO_ROOT, loadContentFromDisk } from '../src/data/node.ts';
import { flagInt, flagSeed, flagString, parseArgs, SEED_MAX, UsageError, type Args } from './args.ts';
import { policyNames } from './policies/index.ts';
import { runJob, type SweepJob, type SweepJobResult } from './sweep-worker.ts';

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
      meanMs: mean(rs.map((r) => r.ms)),
    };
  });
}

export interface SweepOptions {
  /** Worker entry point; tests point this at a fixture that dies mid-sweep. */
  workerUrl?: URL;
  /** Worker data; the `role` selects which module serves the job loop (see sweep-worker.ts). */
  workerData?: unknown;
}

function jobKey(job: { seed: number; policy: string }): string {
  return `${job.policy}#${job.seed}`;
}

/** A job no worker lived long enough to answer. Keeps one result per job, so nothing is silently lost. */
function failedResult(job: SweepJob, error: string): SweepJobResult {
  return {
    seed: job.seed,
    policy: job.policy,
    ok: false,
    error,
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

/** (policy, seed) pairs, de-duplicated: a repeated `--policies random,random` must not double-count. */
export function buildJobs(seeds: readonly number[], policies: readonly string[]): SweepJob[] {
  const jobs: SweepJob[] = [];
  const seen = new Set<string>();
  for (const policy of policies) {
    for (const seed of seeds) {
      const job = { seed, policy };
      const key = jobKey(job);
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push(job);
    }
  }
  return jobs;
}

export async function runSweep(
  seeds: number[],
  policies: string[],
  workers: number,
  opts: SweepOptions = {},
): Promise<SweepJobResult[]> {
  const jobs = buildJobs(seeds, policies);
  // Results are sorted the same way on both paths, so a report never depends on --workers.
  if (workers <= 1 || jobs.length <= 1) return sortResults(jobs.map(runJob));

  const done = new Map<string, SweepJobResult>();
  let next = 0;
  const workerUrl = opts.workerUrl ?? new URL('./sweep-worker.ts', import.meta.url);
  // A worker that dies takes only the job in its hands with it: the promise always resolves,
  // the surviving workers keep draining the queue, and anything left over is reported as a
  // failed job below. Before P0-B2 one dead worker rejected the whole sweep and every
  // completed result was discarded.
  const spawn = (): Promise<void> =>
    new Promise((resolveWorker) => {
      // No execArgv: the worker's module graph is loaded by Node's own type stripping, so it
      // must stay erasable (enforced by tsconfig's erasableSyntaxOnly). A `--import tsx` preload
      // would resolve tsx relative to the process CWD and fail outside the repo root (P0-B1).
      const w = new Worker(workerUrl, { workerData: opts.workerData ?? { role: 'sweep' } });
      const inFlight = new Map<string, SweepJob>();
      let failure: string | null = null;
      const feed = (): void => {
        if (next >= jobs.length) {
          w.postMessage('exit');
          return;
        }
        const job = jobs[next++] as SweepJob;
        inFlight.set(jobKey(job), job);
        w.postMessage(job);
      };
      w.on('message', (r: SweepJobResult) => {
        inFlight.delete(jobKey(r));
        done.set(jobKey(r), r);
        feed();
      });
      w.on('error', (e: Error) => {
        failure = `worker error: ${e.message}`;
      });
      w.on('exit', (code) => {
        if (failure === null && code !== 0) failure = `worker exited with ${code}`;
        const reason = failure ?? 'worker stopped before the job finished';
        for (const [key, job] of inFlight) done.set(key, failedResult(job, reason));
        inFlight.clear();
        resolveWorker();
      });
      feed();
    });
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, spawn));
  for (const job of jobs) {
    const key = jobKey(job);
    if (!done.has(key)) done.set(key, failedResult(job, 'no worker survived to run this job'));
  }
  return sortResults([...done.values()]);
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

const WORKER_RANGE = { min: 1, max: 64 };

/** `--policies a,b,a` -> ["a","b"]: de-duplicated, order preserved, every name checked. */
export function parsePolicies(raw: string): string[] {
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  for (const name of names) {
    if (!policyNames().includes(name)) throw new UsageError(`unknown policy ${name} (available: ${policyNames().join(', ')})`);
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) throw new UsageError('--policies must name at least one policy');
  return out;
}

/**
 * Worker count: `--workers` wins, else SIEGE_SWEEP_WORKERS, else 4. The environment variable
 * is validated through the very same flag parser (P0-B2: it used to bypass the 1..64 range, so
 * `-5` silently ran serial and `99999` tried to spawn 99999 threads).
 */
export function resolveWorkers(args: Args, env: Record<string, string | undefined>): number {
  const raw = env.SIEGE_SWEEP_WORKERS;
  let fallback = 4;
  if (raw !== undefined && raw.trim() !== '') {
    try {
      fallback = flagInt(parseArgs(['--workers', raw.trim()]), 'workers', fallback, WORKER_RANGE);
    } catch (e) {
      throw new UsageError(e instanceof Error ? e.message.replace('--workers', 'SIEGE_SWEEP_WORKERS') : String(e));
    }
  }
  return flagInt(args, 'workers', fallback, WORKER_RANGE);
}

/**
 * Resolve `--out` before a single job runs (P0-B2: an unwritable path used to throw ENOENT or
 * EISDIR after the whole sweep had already been computed). Missing parent directories are
 * created; a path that is itself a directory, or that sits under a file, is a usage error.
 */
export function prepareOutPath(outPath: string): string {
  const full = resolve(outPath);
  let stat: { isDirectory: () => boolean } | null = null;
  try {
    stat = statSync(full);
  } catch {
    stat = null;
  }
  if (stat?.isDirectory()) throw new UsageError(`--out is a directory, expected a file path: ${outPath}`);
  try {
    mkdirSync(dirname(full), { recursive: true });
  } catch (e) {
    throw new UsageError(`--out directory cannot be created: ${dirname(outPath)} (${e instanceof Error ? e.message : String(e)})`);
  }
  return outPath;
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
  // Everything that can reject the run is settled before the first job: unknown policy, bad
  // worker count, unwritable --out.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = prepareOutPath(flagString(args, 'out', join(REPO_ROOT, 'bench', `sweep-${stamp}.json`)));

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
