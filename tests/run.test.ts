import { describe, expect, it } from 'vitest';
import { applyCommand, checkInvariants, legalCommands, validateCommand, type Command } from '../src/sim/commands.ts';
import { Rng } from '../src/sim/rng.ts';
import { createRun, drawUnit, incomePreview, interestFor, poolCapacity, roundTrack, sellValue, shopHudModel, stateHash, xpNeeded, type RunState } from '../src/sim/run.ts';
import type { OwnedUnit } from '../src/sim/units.ts';
import { getPolicy } from '../tools/policies/index.ts';
import { devContent } from './helpers.ts';

const content = devContent();
const eco = content.rules.economy;

function fresh(seed = 1): RunState {
  return createRun(seed, content);
}

function give(state: RunState, defId: string, star: number, where: 'bench' | 'board', cell?: { col: number; row: number }): OwnedUnit {
  const unit: OwnedUnit = { uid: state.nextUid++, defId, star, items: [] };
  if (where === 'bench') {
    const slot = state.bench.findIndex((u) => u === null);
    state.bench[slot] = unit;
  } else {
    const c = cell ?? { col: state.board.length, row: content.board.rows - 1 };
    state.board.push({ ...unit, col: c.col, row: c.row });
    state.board.sort((a, b) => a.uid - b.uid);
  }
  return unit;
}

function expectRejected(state: RunState, cmd: Command, reasonPattern?: RegExp): void {
  const before = stateHash(state);
  const json = JSON.stringify(state);
  const res = applyCommand(state, cmd, content);
  expect(res.ok, `expected rejection of ${JSON.stringify(cmd)}`).toBe(false);
  if (!res.ok) {
    expect(res.reason.length).toBeGreaterThan(0);
    if (reasonPattern) expect(res.reason).toMatch(reasonPattern);
  }
  expect(stateHash(state)).toBe(before);
  expect(JSON.stringify(state)).toBe(json);
}

describe('run creation', () => {
  it('starts with the economy values from rules and a full shop', () => {
    const s = fresh();
    expect(s.gold).toBe(eco.startGold);
    expect(s.hp).toBe(eco.startHp);
    expect(s.level).toBe(eco.startLevel);
    expect(s.shop).toHaveLength(eco.shopSlots);
    expect(s.shop.every((x) => x !== null)).toBe(true);
    expect(s.bench).toHaveLength(eco.benchSlots);
    expect(s.hashes).toHaveLength(1);
    expect(s.config.contentHash).toBe(content.contentHash);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('pool sizes match the rules and shop draws are removed from the pool', () => {
    const s = fresh();
    let total = 0;
    for (const u of content.units) total += eco.poolSize[String(u.cost)] as number;
    const remaining = Object.values(s.pool).reduce((a, b) => a + b, 0);
    expect(remaining).toBe(total - eco.shopSlots);
  });
});

describe('illegal commands are rejected with a reason and leave state unchanged', () => {
  it('buy: empty slot, bad slot, no gold, full bench', () => {
    const s = fresh();
    expectRejected(s, { type: 'buy', slot: 99 }, /slot/);
    expectRejected(s, { type: 'buy', slot: -1 }, /slot/);
    expectRejected(s, { type: 'buy', slot: 1.5 }, /slot/);
    s.gold = 0;
    expectRejected(s, { type: 'buy', slot: 0 }, /gold/);
    s.gold = 100;
    for (let i = 0; i < eco.benchSlots; i++) give(s, 'dev.titan', 1, 'bench');
    expectRejected(s, { type: 'buy', slot: 0 }, /bench/);
    s.shop[0] = null;
    s.bench[0] = null;
    expectRejected(s, { type: 'buy', slot: 0 }, /empty/);
  });
  it('sell / bench / swap: unknown uid, wrong side, self-swap', () => {
    const s = fresh();
    expectRejected(s, { type: 'sell', uid: 42 }, /uid/);
    expectRejected(s, { type: 'bench', uid: 42 }, /uid/);
    const u = give(s, 'dev.brawler', 1, 'bench');
    expectRejected(s, { type: 'bench', uid: u.uid }, /not on the board/);
    expectRejected(s, { type: 'swap', uidA: u.uid, uidB: u.uid }, /itself/);
    expectRejected(s, { type: 'swap', uidA: u.uid, uidB: 999 }, /uid/);
  });
  it('place: outside the player half, occupied cell, beyond the team cap', () => {
    const s = fresh();
    const a = give(s, 'dev.brawler', 1, 'bench');
    const b = give(s, 'dev.archer', 1, 'bench');
    expectRejected(s, { type: 'place', uid: a.uid, col: 0, row: 0 }, /player half/);
    expectRejected(s, { type: 'place', uid: a.uid, col: 99, row: 7 }, /player half/);
    expectRejected(s, { type: 'place', uid: a.uid, col: 0.5, row: 7 }, /cell/);
    expect(applyCommand(s, { type: 'place', uid: a.uid, col: 0, row: 7 }, content).ok).toBe(true);
    expectRejected(s, { type: 'place', uid: b.uid, col: 0, row: 7 }, /occupied/);
    expect(s.level).toBe(1);
    expectRejected(s, { type: 'place', uid: b.uid, col: 1, row: 7 }, /team is full/);
    // moving a board unit to another cell is fine even at the cap
    expect(applyCommand(s, { type: 'place', uid: a.uid, col: 2, row: 6 }, content).ok).toBe(true);
    expect(s.board[0]?.col).toBe(2);
    // placing a unit onto its own cell is a rejected no-op (hash must not change)
    expectRejected(s, { type: 'place', uid: a.uid, col: 2, row: 6 }, /already at that cell/);
  });
  it('reroll / levelUp: not enough gold; levelUp at max level', () => {
    const s = fresh();
    s.gold = 0;
    expectRejected(s, { type: 'reroll' }, /gold/);
    expectRejected(s, { type: 'levelUp' }, /gold/);
    s.gold = 100;
    s.level = eco.maxLevel;
    expectRejected(s, { type: 'levelUp' }, /max level/);
  });
  it('phase gating: nextRound in planning, planning commands in reward, anything after the end', () => {
    const s = fresh();
    expectRejected(s, { type: 'nextRound' }, /reward/);
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(s.phase).toBe('reward');
    expectRejected(s, { type: 'startCombat' }, /planning/);
    expectRejected(s, { type: 'reroll' }, /planning/);
    expectRejected(s, { type: 'buy', slot: 0 }, /planning/);
    expect(applyCommand(s, { type: 'abandon' }, content).ok).toBe(true);
    expect(s.phase).toBe('ended');
    expect(s.outcome).toBe('loss');
    expect(s.endReason).toBe('abandon');
    expectRejected(s, { type: 'nextRound' }, /ended/);
    expectRejected(s, { type: 'abandon' }, /ended/);
  });
  it('malformed commands are rejected', () => {
    const s = fresh();
    expectRejected(s, { type: 'nope' } as unknown as Command, /unknown/);
    expectRejected(s, null as unknown as Command, /malformed/);
    expectRejected(s, { type: 'sell', uid: 'x' } as unknown as Command, /uid/);
  });
  it('every legal command passes validation and applies cleanly', () => {
    const s = fresh(3);
    s.gold = 50;
    give(s, 'dev.brawler', 1, 'bench');
    give(s, 'dev.archer', 1, 'board', { col: 3, row: 7 });
    for (const cmd of legalCommands(s, content)) {
      expect(validateCommand(s, cmd, content), JSON.stringify(cmd)).toBeNull();
      const copy = structuredClone(s);
      const res = applyCommand(copy, cmd, content);
      expect(res.ok).toBe(true);
      expect(checkInvariants(copy, content)).toEqual([]);
    }
  });
});

describe('merges', () => {
  it('three copies merge into one 2-star; the board copy is kept', () => {
    const s = fresh();
    s.level = 3;
    const kept = give(s, 'dev.brawler', 1, 'board', { col: 0, row: 7 });
    give(s, 'dev.brawler', 1, 'bench');
    s.shop[0] = 'dev.brawler';
    s.gold = 10;
    const res = applyCommand(s, { type: 'buy', slot: 0 }, content);
    expect(res.ok).toBe(true);
    expect(s.board).toHaveLength(1);
    expect(s.board[0]?.uid).toBe(kept.uid);
    expect(s.board[0]?.star).toBe(2);
    expect(s.bench.every((u) => u === null)).toBe(true);
    expect(s.gold).toBe(10 - (content.unitsById['dev.brawler']?.cost ?? 0));
  });
  it('chained merge: 2x 2-star + 3x 1-star => one 3-star', () => {
    const s = fresh();
    s.level = 5;
    give(s, 'dev.archer', 2, 'board', { col: 0, row: 7 });
    give(s, 'dev.archer', 2, 'bench');
    give(s, 'dev.archer', 1, 'bench');
    give(s, 'dev.archer', 1, 'bench');
    s.shop[2] = 'dev.archer';
    s.gold = 10;
    expect(applyCommand(s, { type: 'buy', slot: 2 }, content).ok).toBe(true);
    const all = [...s.board, ...s.bench.filter((u): u is OwnedUnit => u !== null)];
    expect(all).toHaveLength(1);
    expect(all[0]?.star).toBe(3);
    expect(all[0]?.defId).toBe('dev.archer');
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('buying with a full bench is allowed when it completes a merge', () => {
    const s = fresh();
    give(s, 'dev.mage', 1, 'bench');
    give(s, 'dev.mage', 1, 'bench');
    while (s.bench.some((u) => u === null)) give(s, 'dev.titan', 1, 'bench');
    s.shop[0] = 'dev.mage';
    s.gold = 10;
    expect(validateCommand(s, { type: 'buy', slot: 0 }, content)).toBeNull();
    expect(applyCommand(s, { type: 'buy', slot: 0 }, content).ok).toBe(true);
    expect(s.bench).toHaveLength(eco.benchSlots);
    const mages = s.bench.filter((u) => u && u.defId === 'dev.mage');
    expect(mages).toHaveLength(1);
    expect(mages[0]?.star).toBe(2);
    expect(s.bench.filter((u) => u === null)).toHaveLength(1);
  });
  it('max-star units never merge', () => {
    const s = fresh();
    for (let i = 0; i < eco.mergeCopies; i++) give(s, 'dev.brawler', eco.maxStar, 'bench');
    s.shop[0] = 'dev.brawler';
    s.gold = 10;
    // Buying a 1-star does not merge with 3-stars; the copy stays on the bench.
    expect(applyCommand(s, { type: 'buy', slot: 0 }, content).ok).toBe(true);
    expect(s.bench.filter((u) => u && u.star === eco.maxStar)).toHaveLength(eco.mergeCopies);
  });
});

describe('economy arithmetic against rules', () => {
  it('interest', () => {
    const per = eco.interest.per;
    expect(interestFor(0, content)).toBe(0);
    expect(interestFor(per - 1, content)).toBe(0);
    expect(interestFor(per, content)).toBe(1);
    expect(interestFor(per * 3 + 1, content)).toBe(Math.min(3, eco.interest.max));
    expect(interestFor(per * (eco.interest.max + 5), content)).toBe(eco.interest.max);
  });
  it('sell value = cost x copies x refund, and copies return to the pool', () => {
    const s = fresh();
    const def = content.unitsById['dev.knight']!;
    const u = give(s, 'dev.knight', 2, 'bench');
    const copies = Math.pow(eco.mergeCopies, 1);
    const expected = Math.floor(def.cost * copies * eco.sellRefund);
    expect(sellValue(u, content)).toBe(expected);
    // `give` conjures a unit outside the pool accounting; a bought 2-star would have taken its
    // copies out of the pool, and the pool is capped at its configured size (P0-15-04).
    s.pool['dev.knight'] = (s.pool['dev.knight'] as number) - copies;
    const poolBefore = s.pool['dev.knight'] as number;
    const goldBefore = s.gold;
    expect(applyCommand(s, { type: 'sell', uid: u.uid }, content).ok).toBe(true);
    expect(s.gold).toBe(goldBefore + expected);
    expect(s.pool['dev.knight']).toBe(poolBefore + eco.mergeCopies);
    expect(s.pool['dev.knight']).toBeLessThanOrEqual(poolCapacity('dev.knight', content));
  });
  it('reroll costs rerollCost, returns shop units to the pool and redraws', () => {
    const s = fresh();
    s.gold = 20;
    const poolBefore = Object.values(s.pool).reduce((a, b) => a + b, 0);
    expect(applyCommand(s, { type: 'reroll' }, content).ok).toBe(true);
    expect(s.gold).toBe(20 - eco.rerollCost);
    expect(Object.values(s.pool).reduce((a, b) => a + b, 0)).toBe(poolBefore);
    expect(s.shop.every((x) => x !== null)).toBe(true);
  });
  it('levelUp costs xpCost and grants xpPerBuy; levels follow xpToLevel', () => {
    const s = fresh();
    s.gold = 100;
    const startLevel = s.level;
    expect(applyCommand(s, { type: 'levelUp' }, content).ok).toBe(true);
    expect(s.gold).toBe(100 - eco.xpCost);
    const need = eco.xpToLevel[startLevel] as number;
    if (eco.xpPerBuy >= need) {
      expect(s.level).toBe(startLevel + 1);
      expect(s.xp).toBe(eco.xpPerBuy - need);
    } else {
      expect(s.level).toBe(startLevel);
      expect(s.xp).toBe(eco.xpPerBuy);
    }
  });
  it('round income = base + interest + winBonus + encounter gold, applied on nextRound', () => {
    const s = fresh();
    s.gold = 25;
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    const won = s.lastFight?.winner === 'left';
    const r = s.pendingReward!;
    expect(r.base).toBe(eco.baseIncome);
    expect(r.interest).toBe(interestFor(25, content));
    expect(r.winBonus).toBe(won ? eco.winBonus : 0);
    expect(r.encounterGold).toBe(content.encounters[0]!.reward.gold);
    expect(r.gold).toBe(r.base + r.interest + r.winBonus + r.encounterGold);
    expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
    expect(s.gold).toBe(25 + r.gold);
    expect(s.round).toBe(2);
    expect(s.phase).toBe('planning');
    expect(s.hashes).toHaveLength(2);
  });

  describe('incomePreview (P0-21)', () => {
    it('the breakdown parts always sum to the total, before and after combat resolves', () => {
      const s = fresh();
      s.gold = 37;
      const before = incomePreview(s, content);
      expect(before.total).toBe(before.base + before.interest + before.winBonus + before.streakBonus + before.encounterGold);
      expect(before.winBonus).toBe(0); // outcome unknown pre-combat
      expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
      const after = incomePreview(s, content);
      expect(after.total).toBe(after.base + after.interest + after.winBonus + after.streakBonus + after.encounterGold);
    });

    it('in the reward phase, incomePreview mirrors pendingReward exactly (the amount nextRound will grant)', () => {
      const s = fresh();
      s.gold = 25;
      expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
      const r = s.pendingReward!;
      const preview = incomePreview(s, content);
      expect(preview.base).toBe(r.base);
      expect(preview.interest).toBe(r.interest);
      expect(preview.winBonus).toBe(r.winBonus);
      expect(preview.encounterGold).toBe(r.encounterGold);
      expect(preview.total).toBe(r.gold);
      const goldBefore = s.gold;
      expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
      expect(s.gold).toBe(goldBefore + preview.total);
    });

    it('before combat, base/interest/encounterGold preview the current round; winBonus is 0 since the outcome is not known yet', () => {
      const s = fresh();
      s.gold = 43;
      const preview = incomePreview(s, content);
      expect(preview.base).toBe(eco.baseIncome);
      expect(preview.interest).toBe(interestFor(43, content));
      expect(preview.winBonus).toBe(0);
      expect(preview.encounterGold).toBe(content.encounters[0]!.reward.gold);
    });

    it('matches the gold actually granted at nextRound across 50 random-policy runs', () => {
      for (let seed = 0; seed < 50; seed++) {
        const s = createRun(seed, content);
        const policy = getPolicy('random');
        const rng = Rng.fromSeed(seed, `policy:${policy.name}`);
        let steps = 0;
        while (s.phase !== 'ended' && steps < 2000) {
          steps++;
          if (s.phase === 'reward') {
            const preview = incomePreview(s, content);
            const goldBefore = s.gold;
            expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
            expect(s.gold, `seed ${seed} round ${s.round - 1}`).toBe(goldBefore + preview.total);
            continue;
          }
          const legal = legalCommands(s, content);
          if (legal.length === 0) throw new Error(`seed ${seed}: no legal commands in phase ${s.phase}`);
          const cmd = policy.choose({ state: s, content, legal, rng });
          expect(applyCommand(s, cmd, content).ok).toBe(true);
        }
        // The step cap is only a runaway guard; every seed must actually finish so the checks
        // above ran for the whole run, not a silently-truncated prefix of it (code review).
        expect(s.phase, `seed ${seed} did not reach 'ended' within ${steps} steps`).toBe('ended');
      }
    });
  });

  describe('shopHudModel (P0-23)', () => {
    it.each([1, 4, 7])('the odds row and costs match economy rules exactly at level %i', (level) => {
      const s = fresh();
      s.level = level;
      s.xp = 3;
      const model = shopHudModel(s, content);
      expect(model.odds.map((r) => r.percent)).toEqual(eco.shopOdds[String(level)]);
      model.odds.forEach((row, i) => expect(row.tier).toBe(i + 1));
      expect(model.rerollCost).toBe(eco.rerollCost);
      expect(model.xpCost).toBe(eco.xpCost);
      expect(model.level).toBe(level);
      expect(model.xp).toBe(3);
    });

    it('xpNeeded and xpProgress reflect the level; both are null/1 at max level', () => {
      const s = fresh();
      s.level = 3;
      s.xp = 4;
      const model = shopHudModel(s, content);
      expect(model.xpNeeded).toBe(xpNeeded(3, content));
      expect(model.xpProgress).toBeCloseTo(4 / xpNeeded(3, content));

      s.level = eco.maxLevel;
      s.xp = 0;
      const maxed = shopHudModel(s, content);
      expect(maxed.xpNeeded).toBeNull();
      expect(maxed.xpProgress).toBe(1);
    });

    it('falls back to the maxLevel odds row for a level with no explicit entry, matching drawUnit', () => {
      const s = fresh();
      s.level = eco.maxLevel + 5; // past every explicit shopOdds key
      const model = shopHudModel(s, content);
      expect(model.odds.map((r) => r.percent)).toEqual(eco.shopOdds[String(eco.maxLevel)]);
    });
  });

  describe('roundTrack (P0-22)', () => {
    it('has one entry per content.encounters, in that order, with the reward preview read straight off the data', () => {
      const track = roundTrack(1, content);
      expect(track).toHaveLength(content.encounters.length);
      content.encounters.forEach((e, i) => {
        const entry = track[i]!;
        expect(entry.round).toBe(e.round);
        expect(entry.encounterId).toBe(e.id);
        expect(entry.type).toBe(e.type);
        expect(entry.rewardPreview.gold).toBe(e.reward.gold);
        expect(entry.rewardPreview.xp).toBe(eco.xpPerRound);
        expect(entry.rewardPreview.items).toEqual([]);
        expect(entry.rewardPreview.augmentOffer).toBe(e.type === 'augment');
      });
    });

    it('marks exactly the given round current and every earlier round past', () => {
      for (const round of [1, 5, content.encounters.length]) {
        const track = roundTrack(round, content);
        for (const entry of track) {
          expect(entry.isCurrent).toBe(entry.round === round);
          expect(entry.isPast).toBe(entry.round < round);
        }
      }
    });

    it('is identical across a replay of the same seed, at every round along the way', () => {
      const seed = 7;
      const live = fresh(seed);
      const policy = getPolicy('random');
      const rng = Rng.fromSeed(seed, `policy:${policy.name}`);
      const commands: Command[] = [];
      // Captured from the live run as it goes, independently of the replay below: the replay's
      // tracks are compared against these snapshots, not recomputed from the same round number
      // at comparison time (which would prove nothing about the replay itself).
      const liveTracks: ReturnType<typeof roundTrack>[] = [];
      let steps = 0;
      while (live.phase !== 'ended' && steps < 2000) {
        steps++;
        const legal = legalCommands(live, content);
        const cmd = policy.choose({ state: live, content, legal, rng });
        expect(applyCommand(live, cmd, content).ok).toBe(true);
        commands.push(cmd);
        liveTracks.push(roundTrack(live.round, content));
      }
      expect(live.phase).toBe('ended');

      const replayed = fresh(seed);
      commands.forEach((cmd, i) => {
        expect(applyCommand(replayed, cmd, content).ok).toBe(true);
        expect(roundTrack(replayed.round, content)).toEqual(liveTracks[i]);
      });
    });
  });
  it('hp loss on defeat follows the table and the run ends at 0 hp', () => {
    const s = fresh();
    s.hp = 1;
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    // Empty player board: the encounter wins with all survivors.
    expect(s.lastFight?.winner).toBe('right');
    const enc = content.encounters[0]!;
    const expectedLoss = (content.rules.hpLoss.byRound[0] as number) + content.rules.hpLoss.perSurvivingUnit * enc.board.length;
    expect(s.lastFight?.hpLoss).toBe(expectedLoss);
    expect(s.hp).toBe(0);
    expect(s.phase).toBe('ended');
    expect(s.outcome).toBe('loss');
    expect(s.endReason).toBe('defeat');
  });
});

describe('run end', () => {
  it('losing the final encounter with hp left is a defeat; the run is won only by beating it', () => {
    const s = fresh();
    s.round = content.encounters.length;
    s.hp = 1000;
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(s.lastFight?.winner).toBe('right');
    expect(s.phase).toBe('ended');
    expect(s.outcome).toBe('loss');
    expect(s.endReason).toBe('defeat');
    expect(s.hashes).toHaveLength(2);
  });
});

describe('shop odds', () => {
  it('draws respect level odds over 10k draws (statistical bounds)', () => {
    const s = fresh();
    s.level = eco.maxLevel;
    for (const u of content.units) s.pool[u.id] = 1_000_000;
    const odds = eco.shopOdds[String(eco.maxLevel)] as number[];
    const counts = new Array<number>(odds.length).fill(0);
    const rng = Rng.fromSeed(123, 'shop');
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const id = drawUnit(s, content, rng);
      expect(id).not.toBeNull();
      const cost = content.unitsById[id as string]!.cost;
      counts[cost - 1] = (counts[cost - 1] as number) + 1;
    }
    for (let t = 0; t < odds.length; t++) {
      const observed = ((counts[t] as number) / N) * 100;
      expect(Math.abs(observed - (odds[t] as number)), `tier ${t + 1}: observed ${observed}% vs ${odds[t]}%`).toBeLessThan(2);
    }
  });
  it('falls back to another tier when the rolled tier is exhausted and returns null on an empty pool', () => {
    const s = fresh();
    for (const u of content.units) s.pool[u.id] = 0;
    s.pool['dev.titan'] = 2;
    s.level = 1; // odds 100% tier 1, which is empty
    const rng = Rng.fromSeed(1, 'shop');
    expect(drawUnit(s, content, rng)).toBe('dev.titan');
    expect(drawUnit(s, content, rng)).toBe('dev.titan');
    expect(drawUnit(s, content, rng)).toBeNull();
  });
});
