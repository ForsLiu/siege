// npm run sim -- --seed 1 --policy random [--json] [--out report.json] [--check]
import { writeFileSync } from 'node:fs';
import { loadContentFromDisk } from '../src/data/node.ts';
import { flagBool, flagSeed, flagString, parseArgs, runTool } from './args.ts';
import { getPolicy } from './policies/index.ts';
import { runWithPolicy } from './policies/runner.ts';

runTool(() => {
  const args = parseArgs(process.argv.slice(2));
  const seed = flagSeed(args, 'seed', 1);
  const policyName = flagString(args, 'policy', 'random');
  const content = loadContentFromDisk();
  const policy = getPolicy(policyName);

  const { report } = runWithPolicy(seed, policy, content, { now: () => performance.now(), checkInvariants: flagBool(args, 'check') });

  const out = args.flags['out'];
  if (typeof out === 'string') writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');

  if (flagBool(args, 'json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`run seed=${report.seed} policy=${report.policy} content=${report.contentHash.slice(0, 16)}`);
  console.log(`outcome=${report.outcome} (${report.endReason}) roundsSurvived=${report.roundsSurvived} hp=${report.finalHp} gold=${report.finalGold} level=${report.finalLevel} commands=${report.commandCount} time=${report.timings.totalMs.toFixed(1)}ms`);
  console.log('round  hp   gold lvl  fight     ticks  board');
  for (const r of report.rounds) {
    console.log(`${String(r.round).padStart(5)}  ${String(r.hpAfter).padStart(3)}  ${String(r.gold).padStart(4)} ${String(r.level).padStart(3)}  ${(r.fight ? r.fight.winner : 'skip').padEnd(5)} -${String(r.fight?.hpLoss ?? 0).padStart(2)}  ${String(r.fight?.ticks ?? 0).padStart(5)}  ${r.board.join(' ')}`);
  }
  console.log(`hashes: ${report.hashes.join(' ')}`);
});
