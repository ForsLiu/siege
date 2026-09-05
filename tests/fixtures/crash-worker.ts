// Fixture for the P0-B2 sweep-robustness tests: a sweep worker that answers odd seeds
// normally and dies with a non-zero exit code on the first even seed it is given, without
// answering it. The parent only feeds a worker again once it has answered, so the assignment
// is deterministic: this worker takes exactly one even-seed job to the grave.
//
// It runs under the `crash` role so that importing `sweep-worker.ts` for `runJob` does not also
// start that module's own job loop.
import { parentPort, workerData } from 'node:worker_threads';
import { runJob, type SweepJob } from '../../tools/sweep-worker.ts';

if (parentPort && workerData && (workerData as { role?: string }).role === 'crash') {
  const port = parentPort;
  port.on('message', (job: SweepJob | 'exit') => {
    if (job === 'exit') {
      port.close();
      return;
    }
    if (job.seed % 2 === 0) process.exit(7);
    port.postMessage(runJob(job));
  });
}
