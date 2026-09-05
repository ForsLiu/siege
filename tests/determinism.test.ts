import { describe, expect, it } from 'vitest';
import { buildTimeline } from '../src/render/timeline.ts';
import { fight } from '../src/sim/fight.ts';
import { hashValue } from '../src/sim/hash.ts';
import { replayRun, verifyReplay } from '../src/sim/replay.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import { stateHash } from '../src/sim/run.ts';
import { getPolicy } from '../tools/policies/index.ts';
import { runWithPolicy } from '../tools/policies/runner.ts';
import { devBoard, devContent } from './helpers.ts';

const content = devContent();

describe('determinism', () => {
  it('same seed + command log => identical round hashes across 10 runs', () => {
    const base = runWithPolicy(11, getPolicy('random'), content);
    expect(base.state.hashes.length).toBeGreaterThan(1);
    for (let i = 0; i < 10; i++) {
      const r = replayRun(11, base.commands, content);
      expect(r.rejected).toBeNull();
      expect(r.hashes).toEqual(base.state.hashes);
      expect(stateHash(r.state)).toBe(stateHash(base.state));
    }
  });

  it('different seeds => different hashes', () => {
    const seen = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5]) {
      const r = runWithPolicy(seed, getPolicy('random'), content);
      for (const h of r.state.hashes) {
        expect(seen.has(h), `hash collision for seed ${seed}`).toBe(false);
        seen.add(h);
      }
    }
  });

  it('replay reproduces a random-policy run and flags a tampered log', () => {
    const run = runWithPolicy(21, getPolicy('random'), content);
    const ok = verifyReplay(21, run.commands, run.state.hashes, content);
    expect(ok.ok).toBe(true);
    expect(ok.mismatchIndex).toBe(-1);
    const tampered = run.commands.filter((c) => c.type !== 'levelUp' && c.type !== 'reroll' && c.type !== 'buy');
    if (tampered.length !== run.commands.length) {
      const bad = verifyReplay(21, tampered, run.state.hashes, content);
      expect(bad.ok).toBe(false);
    }
    const wrongSeed = verifyReplay(22, run.commands, run.state.hashes, content);
    expect(wrongSeed.ok).toBe(false);
    expect(wrongSeed.mismatchIndex).toBe(0);
  });

  it('rendering on/off changes nothing: building a timeline leaves the fight result and hash intact', () => {
    const rules = fightRulesFrom(content);
    const r1 = fight(devBoard('a'), devBoard('b'), 7, rules);
    const before = hashValue(r1);
    const moveTicks = Math.round(content.rules.combat.moveSecondsPerHex * content.rules.tickRate);
    const tl = buildTimeline(r1, moveTicks);
    expect(tl.frames.length).toBe(r1.ticks + 1);
    expect(hashValue(r1)).toBe(before);
    const r2 = fight(devBoard('a'), devBoard('b'), 7, rules);
    expect(r2.hash).toBe(r1.hash);
    expect(hashValue(r2)).toBe(before);
    // Max-hp modifiers reach the snapshot through `maxHp` events: no frame may show a unit
    // above its own maximum (dev.guardian's onCombatStart +10% hp used to overflow the bar).
    for (const frame of tl.frames) {
      for (const u of frame) expect(u.hp, `${u.defId} hp ${u.hp} > maxHp ${u.maxHp}`).toBeLessThanOrEqual(u.maxHp + 1e-9);
    }
    // The final frame reflects the outcome.
    const last = tl.frames[tl.frames.length - 1]!;
    const leftAlive = last.filter((u) => u.team === 0 && u.alive).length;
    const rightAlive = last.filter((u) => u.team === 1 && u.alive).length;
    expect(leftAlive).toBe(r1.survivors.left.length);
    expect(rightAlive).toBe(r1.survivors.right.length);
    // 0-tick fights (an empty side) still honour frames.length === ticks + 1.
    const empty = fight([], devBoard('a'), 1, rules);
    expect(empty.ticks).toBe(0);
    const etl = buildTimeline(empty, moveTicks);
    expect(etl.frames.length).toBe(1);
    expect(etl.frames[0]!.filter((u) => u.alive)).toHaveLength(devBoard('a').length);
  });

  it('a run report contains a hash per round boundary plus the final one, and never NaN', () => {
    const run = runWithPolicy(5, getPolicy('random'), content, { checkInvariants: true });
    const rounds = run.state.history.length;
    expect(run.state.phase).toBe('ended');
    expect(run.report.hashes.length).toBe(rounds + 1);
    const json = JSON.stringify(run.report);
    expect(json).not.toMatch(/NaN|Infinity/);
  });
});
