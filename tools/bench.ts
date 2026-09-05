// npm run bench [-- --seconds 3]: fights per second and ticks per second for a fixed dev matchup,
// plus a host-independent budget: sim ticks per unit of a baseline micro-benchmark (P0-10 records it).
import { loadBoardFromDisk, loadContentFromDisk } from '../src/data/node.ts';
import { fight } from '../src/sim/fight.ts';
import { fnv1a32 } from '../src/sim/hash.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import { flagInt, parseArgs } from './args.ts';

const args = parseArgs(process.argv.slice(2));
const seconds = flagInt(args, 'seconds', 3, { min: 1, max: 600 });
const content = loadContentFromDisk();
const rules = fightRulesFrom(content);
const left = loadBoardFromDisk('data/dev/boards/a.json', content);
const right = loadBoardFromDisk('data/dev/boards/b.json', content);

// warm-up
for (let i = 0; i < 20; i++) fight(left, right, i, rules);

let fights = 0;
let ticks = 0;
let events = 0;
const t0 = performance.now();
while (performance.now() - t0 < seconds * 1000) {
  const r = fight(left, right, fights, rules);
  ticks += r.ticks;
  events += r.events.length;
  fights++;
}
const elapsed = (performance.now() - t0) / 1000;

// Baseline micro-benchmark: FNV-1a 32 over a fixed string, repeated. Units: hashes per second.
const probe = 'siege-baseline-probe-'.repeat(8);
const b0 = performance.now();
let n = 0;
let acc = 0;
while (performance.now() - b0 < 500) {
  acc ^= fnv1a32(probe + String(n & 0xff));
  n++;
}
const baselinePerSec = n / ((performance.now() - b0) / 1000);
const ticksPerSec = ticks / elapsed;

console.log(`bench  matchup a.json vs b.json  ${elapsed.toFixed(2)} s`);
console.log(`fights/s   ${(fights / elapsed).toFixed(1)}`);
console.log(`ticks/s    ${ticksPerSec.toFixed(0)}`);
console.log(`events/s   ${(events / elapsed).toFixed(0)}`);
console.log(`avg ticks  ${(ticks / fights).toFixed(1)} per fight`);
console.log(`baseline   ${baselinePerSec.toFixed(0)} fnv1a32/s (acc ${acc >>> 0})`);
console.log(`budget     ${(ticksPerSec / baselinePerSec).toFixed(4)} sim ticks per baseline hash`);
