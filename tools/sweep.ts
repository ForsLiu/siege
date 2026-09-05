// npx tsx tools/sweep.ts --seeds 50 --policies random [--workers 4] [--start 1] [--out bench/sweep-<stamp>.json]
// Runs seeds x policies in worker threads (cap SIEGE_SWEEP_WORKERS, default 4), prints a table,
// writes bench/sweep-<stamp>.json (gitignored).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { REPO_ROOT, loadContentFromDisk } from '../src/data/node.ts';
import { flagInt, flagSeed, flagString, parseArgs, SEED_MAX, UsageError } from './args.ts';
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

export async function runSweep(seeds: number[], policies: string[], workers: number): Promise<SweepJobResult[]> {
  const jobs: SweepJob[] = [];
  for (const policy of policies) for (const seed of seeds) jobs.push({ seed, policy });
  // Results are sorted the same way on both paths, so a report never depends on --workers.
  if (workers <= 1 || jobs.length <= 1) return sortResults(jobs.map(runJob));

  const results: SweepJobResult[] = [];
  let next = 0;
  const workerUrl = new URL('./sweep-worker.ts', import.meta.url);
  const spawn = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // No execArgv: the worker's module graph is loaded by Node's own type stripping, so it
      // must stay erasable (enforced by tsconfig's erasableSyntaxOnly). A `--import tsx` preload
      // would resolve tsx relative to the process CWD and fail outside the repo root (P0-B1).
      const w = new Worker(workerUrl, { workerData: { role: 'sweep' } });
      const feed = (): void => {
        if (next >= jobs.length) {
          w.postMessage('exit');
          return;
        }
        w.postMessage(jobs[next++]);
      };
      w.on('message', (r: SweepJobResult) => {
        results.push(r);
        feed();
      });
      w.on('error', reject);
      w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
      feed();
    });
  await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, spawn));
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
  const policies = flagString(args, 'policies', 'random').split(',').map((s) => s.trim()).filter(Boolean);
  if (policies.length === 0) throw new UsageError('--policies must name at least one policy');
  for (const p of policies) if (!policyNames().includes(p)) throw new UsageError(`unknown policy ${p} (available: ${policyNames().join(', ')})`);
  const workers = flagInt(args, 'workers', Number.parseInt(process.env.SIEGE_SWEEP_WORKERS ?? '4', 10) || 4, { min: 1, max: 64 });
  const seeds = Array.from({ length: nSeeds }, (_, i) => start + i);
  const content = loadContentFromDisk();

  const t0 = performance.now();
  const results = await runSweep(seeds, policies, workers);
  const totalMs = performance.now() - t0;
  const aggregates = aggregate(results, policies);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const report: SweepReport = { stamp, contentHash: content.contentHash, seeds, policies, workers, totalMs, aggregates, results };

  const outDir = join(REPO_ROOT, 'bench');
  mkdirSync(outDir, { recursive: true });
  const outPath = flagString(args, 'out', join(outDir, `sweep-${stamp}.json`));
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
