// Worker for tools/sweep.ts: runs (seed, policy) jobs and posts compact results.
import { parentPort, workerData } from 'node:worker_threads';
import { loadContentFromDisk } from '../src/data/node.ts';
import { getPolicy } from './policies/index.ts';
import { runWithPolicy } from './policies/runner.ts';

export interface SweepJob {
  seed: number;
  policy: string;
}

export interface SweepJobResult {
  seed: number;
  policy: string;
  ok: boolean;
  error: string | null;
  outcome: 'win' | 'loss' | null;
  roundsSurvived: number;
  finalHp: number;
  finalGold: number;
  finalLevel: number;
  commandCount: number;
  fightTicks: number[];
  finalHash: string | null;
  ms: number;
}

export function runJob(job: SweepJob): SweepJobResult {
  const t0 = performance.now();
  try {
    const content = loadContentFromDisk();
    const { report } = runWithPolicy(job.seed, getPolicy(job.policy), content);
    return {
      seed: job.seed,
      policy: job.policy,
      ok: true,
      error: null,
      outcome: report.outcome,
      roundsSurvived: report.roundsSurvived,
      finalHp: report.finalHp,
      finalGold: report.finalGold,
      finalLevel: report.finalLevel,
      commandCount: report.commandCount,
      fightTicks: report.rounds.map((r) => r.fight.ticks),
      finalHash: report.hashes[report.hashes.length - 1] ?? null,
      ms: performance.now() - t0,
    };
  } catch (e) {
    return {
      seed: job.seed,
      policy: job.policy,
      ok: false,
      error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e),
      outcome: null,
      roundsSurvived: 0,
      finalHp: 0,
      finalGold: 0,
      finalLevel: 0,
      commandCount: 0,
      fightTicks: [],
      finalHash: null,
      ms: performance.now() - t0,
    };
  }
}

if (parentPort && workerData && (workerData as { role?: string }).role === 'sweep') {
  const port = parentPort;
  port.on('message', (job: SweepJob | 'exit') => {
    if (job === 'exit') {
      port.close();
      return;
    }
    port.postMessage(runJob(job));
  });
}
