// Test double for tools/sweep-worker.ts: answers the sweep protocol, but misbehaves on the
// seeds it is told to — hard-exiting (an OOM or thread abort), answering twice, answering for
// the wrong job, or posting garbage. Used by tests/tools.test.ts (P0-B2).
// It answers the protocol itself, so it takes the role `sweep-double`: the real worker only
// installs its own listener for role `sweep`, and would otherwise answer every message twice.
// Must stay erasable TypeScript: Node loads it with type stripping, like the real worker.
import { parentPort, workerData } from 'node:worker_threads';
import { runJob, type SweepJob } from '../../tools/sweep-worker.ts';

interface DoubleData {
  role?: string;
  /** Hard-exit instead of answering. */
  crashOnSeeds?: number[];
  /** Answer twice. */
  doubleAnswerSeeds?: number[];
  /** Answer with a seed that was never dispatched. */
  wrongSeedSeeds?: number[];
  /** Post something that is not a result at all. */
  garbageSeeds?: number[];
  /** Never answer and never exit: the parent's watchdog is the only way out. */
  silentSeeds?: number[];
  /** Answer every job, but never exit after the parent asks it to. */
  linger?: boolean;
}

const data = workerData as DoubleData;

if (parentPort && data && data.role === 'sweep-double') {
  const port = parentPort;
  const has = (list: number[] | undefined, seed: number): boolean => (list ?? []).includes(seed);
  port.on('message', (job: SweepJob | 'exit') => {
    if (job === 'exit') {
      port.close();
      // A worker that refuses to go away after the queue is drained.
      if (data.linger === true) setInterval(() => {}, 1000);
      return;
    }
    if (has(data.crashOnSeeds, job.seed)) process.exit(3);
    if (has(data.silentSeeds, job.seed)) return;
    if (has(data.garbageSeeds, job.seed)) {
      port.postMessage('not-a-result');
      return;
    }
    const result = runJob(job);
    if (has(data.wrongSeedSeeds, job.seed)) {
      port.postMessage({ ...result, seed: 999 });
      return;
    }
    port.postMessage(result);
    if (has(data.doubleAnswerSeeds, job.seed)) port.postMessage(result);
  });
}
