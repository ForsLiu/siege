import { describe, expect, it } from 'vitest';
import { applyCommand, checkInvariants, legalCommands, validateCommand, type Command } from '../src/sim/commands.ts';
import { fight } from '../src/sim/fight.ts';
import { Rng } from '../src/sim/rng.ts';
import {
  advanceRound,
  augmentStartEffects,
  createRun,
  drawAugmentOffer,
  drawUnit,
  incomePreview,
  interestFor,
  poolCapacity,
  rollLoot,
  roundTrack,
  sellValue,
  shopHudModel,
  skipRoundAsWin,
  stateHash,
  tryMerge,
  xpNeeded,
  type RunState,
} from '../src/sim/run.ts';
import type { BoardUnit, OwnedUnit } from '../src/sim/units.ts';
import { getPolicy } from '../tools/policies/index.ts';
import { devContent, rulesWithUnits, testUnit } from './helpers.ts';

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

  it('a merge of units carrying itemSlots items each moves items onto the kept unit up to the cap, overflow to the item bench (P0-28)', () => {
    const s = fresh();
    const kept = give(s, 'dev.archer', 1, 'bench'); // lowest uid: kept, starts empty
    const b = give(s, 'dev.archer', 1, 'bench');
    b.items.push('item.blade', 'item.chain', 'item.tome');
    const c = give(s, 'dev.archer', 1, 'bench');
    c.items.push('item.twin_blade', 'item.guardians_edge', 'item.arcane_ward');
    expect(kept.items).toHaveLength(0);
    expect(tryMerge(s, 'dev.archer', 1, content)).toBe(1);
    const merged = [...s.board, ...s.bench].find((u): u is OwnedUnit => u !== null && u.uid === kept.uid)!;
    expect(merged.star).toBe(2);
    // b's 3 items fill the cap first (removed before c, per tryMerge's bench-then-board, uid order);
    // c's 3 items all overflow to the bench, unchanged and in order.
    expect(merged.items).toEqual(['item.blade', 'item.chain', 'item.tome']);
    expect(s.itemBench).toEqual(['item.twin_blade', 'item.guardians_edge', 'item.arcane_ward']);
    expect(checkInvariants(s, content)).toEqual([]);
  });

  it('a merge with room to spare transfers every item with no overflow', () => {
    const s = fresh();
    const kept = give(s, 'dev.archer', 1, 'bench');
    const b = give(s, 'dev.archer', 1, 'bench');
    b.items.push('item.blade');
    const c = give(s, 'dev.archer', 1, 'bench');
    c.items.push('item.chain');
    expect(tryMerge(s, 'dev.archer', 1, content)).toBe(1);
    const merged = [...s.board, ...s.bench].find((u): u is OwnedUnit => u !== null && u.uid === kept.uid)!;
    expect(merged.items).toEqual(['item.blade', 'item.chain']);
    expect(s.itemBench).toEqual([]);
  });
});

describe('sell returns items to the bench (P0-28)', () => {
  it('selling a unit pushes its items onto state.itemBench', () => {
    const s = fresh();
    const unit = give(s, 'dev.knight', 1, 'board');
    unit.items.push('item.blade', 'item.twin_blade');
    s.itemBench.push('item.chain'); // a pre-existing bench item must survive untouched
    expect(applyCommand(s, { type: 'sell', uid: unit.uid }, content).ok).toBe(true);
    expect(s.itemBench).toEqual(['item.chain', 'item.blade', 'item.twin_blade']);
    expect(checkInvariants(s, content)).toEqual([]);
  });

  it('selling a unit with no items leaves the item bench unchanged', () => {
    const s = fresh();
    const unit = give(s, 'dev.knight', 1, 'bench');
    expect(applyCommand(s, { type: 'sell', uid: unit.uid }, content).ok).toBe(true);
    expect(s.itemBench).toEqual([]);
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

  describe('augments (P0-24)', () => {
    // Derived, not hardcoded: whichever round content.encounters marks 'augment' (today round 8),
    // so this suite keeps testing something real if the dev encounter mix ever changes.
    const augmentRound = content.encounters.find((e) => e.type === 'augment')!.round;

    function toAugmentRound(state: RunState): void {
      while (state.round < augmentRound) {
        skipRoundAsWin(state, content);
        advanceRound(state, content);
      }
    }

    it('drawAugmentOffer is deterministic per seed, draws distinct ids up to offerCount, and genuinely excludes when the pool is bigger than the offer', () => {
      // The dev pool (4 augments) is bigger than offerCount (3), so a real exclusion is exercised
      // here, not just a full-pool reshuffle (offerCount === pool.length would trivially pass).
      expect(content.augments.length).toBeGreaterThan(content.rules.augment.offerCount);
      const a = fresh(11);
      const b = fresh(11);
      const offerA = drawAugmentOffer(a, content);
      const offerB = drawAugmentOffer(b, content);
      expect(offerA).toEqual(offerB);
      expect(offerA.length).toBe(content.rules.augment.offerCount);
      expect(new Set(offerA).size).toBe(offerA.length);
      for (const id of offerA) expect(content.augmentsById[id]).toBeDefined();
      expect(offerA.length).toBeLessThan(content.augments.length);
      const c = fresh(12);
      expect(drawAugmentOffer(c, content).length).toBe(offerA.length);
    });

    it('createRun and advanceRound set augmentOffer only on the augment-type round', () => {
      const s = fresh(3);
      expect(s.augmentOffer).toBeNull(); // round 1 is 'normal' in dev/encounters.json
      toAugmentRound(s);
      expect(s.round).toBe(augmentRound);
      expect(s.augmentOffer).not.toBeNull();
      expect(s.augmentOffer).toHaveLength(Math.min(content.rules.augment.offerCount, content.augments.length));
      skipRoundAsWin(s, content);
      advanceRound(s, content);
      expect(s.round).toBe(augmentRound + 1);
      expect(s.augmentOffer).toBeNull(); // the following round is 'normal' in dev/encounters.json
    });

    it('pickAugment is rejected outside an augment round, even for a real augment id', () => {
      const s = fresh(1); // round 1 has no pending offer
      expect(s.augmentOffer).toBeNull();
      expectRejected(s, { type: 'pickAugment', augmentId: content.augments[0]!.id }, /no augment offer is pending/);
    });

    it('pickAugment rejects an unknown augment id even during an augment round', () => {
      const s = fresh(1);
      toAugmentRound(s);
      expectRejected(s, { type: 'pickAugment', augmentId: 'aug.does_not_exist' }, /unknown augment id/);
    });

    it('pickAugment rejects a real augment id that is not in the current offer', () => {
      const s = fresh(1);
      toAugmentRound(s);
      // Guaranteed to exist: the dev pool (4 augments) is bigger than offerCount (3).
      const notOffered = content.augments.map((a) => a.id).find((id) => !s.augmentOffer!.includes(id));
      expect(notOffered, 'expected at least one augment excluded from the offer').toBeDefined();
      expectRejected(s, { type: 'pickAugment', augmentId: notOffered! }, /not in the current offer/);
    });

    it('picking records the id, clears the offer, and legalCommands stops offering pickAugment', () => {
      const s = fresh(1);
      toAugmentRound(s);
      const offered = s.augmentOffer![0]!;
      expect(legalCommands(s, content).some((c) => c.type === 'pickAugment' && c.augmentId === offered)).toBe(true);
      expect(applyCommand(s, { type: 'pickAugment', augmentId: offered }, content).ok).toBe(true);
      expect(s.augments).toEqual([offered]);
      expect(s.augmentOffer).toBeNull();
      expect(legalCommands(s, content).some((c) => c.type === 'pickAugment')).toBe(false);
    });

    it("a picked augment's effects apply in the next combat: armor from aug.iron_skin reduces damage taken, called through fight() directly", () => {
      const attacker = testUnit('t.aug.attacker', { hp: 1000, attack: 100, attackSpeed: 1, range: 1 });
      const tank = testUnit('t.aug.tank', { hp: 100000, attack: 0, range: 1 });
      const fr = rulesWithUnits([attacker, tank], { maxSeconds: 1 });
      const left: BoardUnit[] = [{ defId: 't.aug.attacker', star: 1, col: 3, row: 4 }];
      const right: BoardUnit[] = [{ defId: 't.aug.tank', star: 1, col: 3, row: 4 }];
      const withoutAugment = fight(left, right, 1, fr);
      const hitWithout = withoutAugment.events.find((e) => e.type === 'hit');
      expect(hitWithout && hitWithout.type === 'hit' ? hitWithout.amount : NaN).toBeCloseTo(100, 9);

      const ironSkin = content.augmentsById['aug.iron_skin']!;
      const buffed = { ...fr, startEffects: { left: [], right: ironSkin.effects } };
      const withAugment = fight(left, right, 1, buffed);
      const hitWith = withAugment.events.find((e) => e.type === 'hit');
      // K / (K + armor) with K = mitigationConstant (100) and armor = 10 (aug.iron_skin's flat bonus).
      const k = content.rules.combat.mitigationConstant;
      expect(hitWith && hitWith.type === 'hit' ? hitWith.amount : NaN).toBeCloseTo(100 * (k / (k + 10)), 9);
    });

    it("a picked augment's effects apply in the next combat, driven through the real Commands (pickAugment -> startCombat)", () => {
      const withoutBuff = fresh(9);
      give(withoutBuff, content.units[0]!.id, 1, 'board');
      expect(applyCommand(withoutBuff, { type: 'startCombat' }, content).ok).toBe(true);
      const baselineHash = withoutBuff.lastFight!.hash;

      const withBuff = fresh(9);
      give(withBuff, content.units[0]!.id, 1, 'board');
      withBuff.augments.push('aug.iron_skin');
      expect(applyCommand(withBuff, { type: 'startCombat' }, content).ok).toBe(true);
      // Same seed, same board, only the picked augment differs: the fight hash must diverge
      // (the buffed unit's armor is higher, changing mitigation) proving `resolveCombat` actually
      // threads `state.augments` into the fight it runs, not just that `fight()` can apply effects.
      expect(withBuff.lastFight!.hash).not.toBe(baselineHash);
    });

    it('augmentStartEffects reads only the picked augments and always fills both sides', () => {
      const s = fresh(1);
      expect(augmentStartEffects(s, content)).toEqual({ left: [], right: [] });
      s.augments.push('aug.iron_skin', 'aug.quickness');
      const effects = augmentStartEffects(s, content);
      expect(effects!.right).toEqual([]);
      expect(effects!.left).toEqual([...content.augmentsById['aug.iron_skin']!.effects, ...content.augmentsById['aug.quickness']!.effects]);
    });
  });

  describe('loot (P0-28)', () => {
    // Derived, not hardcoded: whichever round's encounter carries a loot table with a 'choice'
    // row (today dev.e05, round 5), so this suite keeps testing something real if the dev
    // encounter mix ever changes.
    const lootEncounter = content.encounters.find((e) => e.loot.some((r) => r.kind === 'choice'))!;
    const lootRound = lootEncounter.round;
    const componentRow = lootEncounter.loot.find((r) => r.kind === 'component')!;
    const choiceRow = lootEncounter.loot.find((r) => r.kind === 'choice')!;

    function toLootRound(state: RunState): void {
      while (state.round < lootRound) {
        skipRoundAsWin(state, content);
        advanceRound(state, content);
      }
    }

    it('rollLoot is deterministic per seed, changes with the seed, and leaves the loot stream untouched on a loss or when the encounter has no loot table', () => {
      expect(lootEncounter.loot.length).toBeGreaterThan(0);
      const a = fresh(3);
      const b = fresh(3);
      const grantedA = rollLoot(a, lootEncounter, true);
      const grantedB = rollLoot(b, lootEncounter, true);
      expect(grantedA).toEqual(grantedB);
      expect(a.lootOffer).toEqual(b.lootOffer);
      expect(a.rng.loot).toEqual(b.rng.loot);
      expect(componentRow.itemIds).toContain(grantedA[0]);
      expect(a.lootOffer).toEqual(choiceRow.itemIds);

      const results = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => JSON.stringify(rollLoot(fresh(seed), lootEncounter, true)));
      expect(new Set(results).size).toBeGreaterThan(1);

      const lost = fresh(3);
      const beforeLoss = lost.rng.loot;
      expect(rollLoot(lost, lootEncounter, false)).toEqual([]);
      expect(lost.rng.loot).toEqual(beforeLoss);
      expect(lost.lootOffer).toBeNull();

      const noLootEncounter = content.encounters.find((e) => e.loot.length === 0)!;
      const noLoot = fresh(3);
      const beforeNoLoot = noLoot.rng.loot;
      expect(rollLoot(noLoot, noLootEncounter, true)).toEqual([]);
      expect(noLoot.rng.loot).toEqual(beforeNoLoot);
    });

    it('a won round rolls a guaranteed drop into pendingReward.items and a choice row into lootOffer', () => {
      const s = fresh(1);
      toLootRound(s);
      skipRoundAsWin(s, content);
      expect(s.pendingReward!.items).toHaveLength(1);
      expect(componentRow.itemIds).toContain(s.pendingReward!.items[0]);
      expect(s.lootOffer).toEqual(choiceRow.itemIds);
    });

    it('pickLoot rejects outside the reward phase, an unknown item id, and an id not in the offer', () => {
      const s = fresh(1);
      toLootRound(s);
      expectRejected(s, { type: 'pickLoot', itemId: choiceRow.itemIds[0]! }, /requires the reward phase/);
      skipRoundAsWin(s, content);
      expectRejected(s, { type: 'pickLoot', itemId: 'item.does_not_exist' }, /unknown item id/);
      const notOffered = content.items.map((i) => i.id).find((id) => !choiceRow.itemIds.includes(id))!;
      expect(notOffered, 'expected at least one real item excluded from the offer').toBeDefined();
      expectRejected(s, { type: 'pickLoot', itemId: notOffered }, /not in the current offer/);
    });

    it('picking a loot offer adds it to the item bench, clears the offer, and legalCommands stops offering pickLoot', () => {
      const s = fresh(1);
      toLootRound(s);
      skipRoundAsWin(s, content);
      const offered = s.lootOffer![0]!;
      expect(legalCommands(s, content).some((c) => c.type === 'pickLoot' && c.itemId === offered)).toBe(true);
      expect(applyCommand(s, { type: 'pickLoot', itemId: offered }, content).ok).toBe(true);
      expect(s.lootOffer).toBeNull();
      expect(s.itemBench).toContain(offered);
      expect(legalCommands(s, content).some((c) => c.type === 'pickLoot')).toBe(false);
    });

    it("advanceRound applies the guaranteed drop to the item bench and lapses an unpicked lootOffer, driven through the real Commands (skipRound -> nextRound)", () => {
      const s = fresh(1);
      toLootRound(s);
      skipRoundAsWin(s, content);
      const granted = s.pendingReward!.items;
      expect(s.lootOffer).not.toBeNull();
      applyCommand(s, { type: 'nextRound' }, content);
      for (const id of granted) expect(s.itemBench).toContain(id);
      expect(s.lootOffer).toBeNull(); // the choice row's offer lapsed, unresolved
    });

    it("the round-track reward preview lists every distinct item id the loot table could produce, without rolling (no RNG state change, no combat outcome needed)", () => {
      const s = fresh(1);
      const before = s.rng.loot;
      const entry = roundTrack(lootRound, content).find((e) => e.round === lootRound)!;
      expect(new Set(entry.rewardPreview.items)).toEqual(new Set(lootEncounter.loot.flatMap((r) => r.itemIds)));
      expect(s.rng.loot).toEqual(before);
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
        expect(entry.rewardPreview.items).toEqual([...new Set(e.loot.flatMap((row) => row.itemIds))]);
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
