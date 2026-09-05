// npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json [--events] [--json]
import { loadBoardFromDisk, loadContentFromDisk } from '../src/data/node.ts';
import { fight } from '../src/sim/fight.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import { flagBool, flagSeed, flagString, parseArgs, runTool } from './args.ts';

runTool(() => {
  const args = parseArgs(process.argv.slice(2));
  const seed = flagSeed(args, 'seed', 1);
  const leftPath = flagString(args, 'left', 'data/dev/boards/a.json');
  const rightPath = flagString(args, 'right', 'data/dev/boards/b.json');

  const content = loadContentFromDisk();
  const left = loadBoardFromDisk(leftPath, content);
  const right = loadBoardFromDisk(rightPath, content);
  const result = fight(left, right, seed, fightRulesFrom(content));

  if (flagBool(args, 'json')) {
    console.log(JSON.stringify({ ...result, events: flagBool(args, 'events') ? result.events : undefined }, null, 2));
    return;
  }
  console.log(`fight  seed=${seed}  left=${leftPath}  right=${rightPath}`);
  console.log(`content ${content.contentHash.slice(0, 16)}  result ${result.winner} (${result.reason}) in ${result.ticks} ticks (${(result.ticks / content.rules.tickRate).toFixed(2)} s)`);
  console.log(`survivors left=${result.survivors.left.length} right=${result.survivors.right.length}  events=${result.events.length}  hash=${result.hash}`);
  console.log('ledger:');
  for (const e of result.ledger) {
    const cols = [
      `dealt=${e.dealt.toFixed(0).padStart(6)}`,
      `taken=${e.taken.toFixed(0).padStart(6)}`,
      `healed=${e.healed.toFixed(0).padStart(6)}`,
      `shielded=${e.shielded.toFixed(0).padStart(6)}`,
      `absorbed=${e.absorbed.toFixed(0).padStart(6)}`,
      `mitigated=${e.mitigated.toFixed(0).padStart(6)}`,
      `k/d=${e.kills}/${e.deaths}`,
    ];
    console.log(`  #${e.uid} ${e.team === 0 ? 'L' : 'R'} ${e.defId.padEnd(14)} ${cols.join(' ')}`);
  }
  if (flagBool(args, 'events')) {
    console.log('events:');
    for (const ev of result.events) console.log(`  ${JSON.stringify(ev)}`);
  }
});
