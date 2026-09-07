// P0-15: the `dev:` command namespace. Every cheat is a Command, gated by RunConfig.devCommands,
// recorded in the log, and replayable hash for hash.
import { describe, expect, it } from 'vitest';
import { applyCommand, checkInvariants, legalCommands, validateCommand, type Command } from '../src/sim/commands.ts';
import { DEV_COMMAND_TYPES, type DevCommand } from '../src/sim/devCommands.ts';
import { replayLog, replayRun, type RunLog } from '../src/sim/replay.ts';
import { createRun, poolCapacity, shopTierCount, stateHash, xpNeeded, type RunState } from '../src/sim/run.ts';
import { devContent } from './helpers.ts';

const content = devContent();
const eco = content.rules.economy;

function devRun(seed = 1): RunState {
  return createRun(seed, content, { devCommands: true });
}

function prodRun(seed = 1): RunState {
  return createRun(seed, content);
}

/** One legal-shaped command per dev type, for the gate tests. */
const SAMPLE: Record<string, DevCommand> = {
  'dev:gold': { type: 'dev:gold', amount: 50 },
  'dev:xp': { type: 'dev:xp', amount: 10 },
  'dev:invinciblePieces': { type: 'dev:invinciblePieces', on: true },
  'dev:invinciblePlayer': { type: 'dev:invinciblePlayer', on: true },
  'dev:skipRound': { type: 'dev:skipRound' },
  'dev:addAugment': { type: 'dev:addAugment', augmentId: 'aug.iron_skin' },
  'dev:openShop': { type: 'dev:openShop', tier: 1 },
  'dev:spawnUnit': { type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: null },
  'dev:giveItem': { type: 'dev:giveItem', itemId: 'item.blade' },
};

function expectRejected(state: RunState, cmd: Command, reasonPattern?: RegExp): void {
  const before = JSON.stringify(state);
  const res = applyCommand(state, cmd, content);
  expect(res.ok, `expected rejection of ${JSON.stringify(cmd)}`).toBe(false);
  if (!res.ok) {
    expect(res.reason.length).toBeGreaterThan(0);
    if (reasonPattern) expect(res.reason).toMatch(reasonPattern);
  }
  expect(JSON.stringify(state)).toBe(before);
}

describe('dev command gate', () => {
  it('every dev command is rejected with a reason when the run config flag is off', () => {
    for (const type of DEV_COMMAND_TYPES) {
      const s = prodRun();
      expect(s.config.devCommands).toBe(false);
      expectRejected(s, SAMPLE[type] as Command, /dev commands are disabled/);
    }
  });
  it('every dev command is accepted when the flag is on', () => {
    for (const type of DEV_COMMAND_TYPES) {
      const s = devRun();
      // spawnUnit needs a free bench slot, skipRound an encounter: a fresh run has both.
      expect(validateCommand(s, SAMPLE[type] as Command, content), `${type} should be legal`).toBeNull();
    }
  });
  it('the gate is checked before the phase, so the reason does not depend on the phase', () => {
    const s = prodRun();
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(validateCommand(s, { type: 'dev:gold', amount: 1 }, content)).toMatch(/dev commands are disabled/);
  });
  it('dev commands need the planning phase in a dev run', () => {
    const s = devRun();
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(s.phase).toBe('reward');
    expectRejected(s, { type: 'dev:gold', amount: 1 }, /requires the planning phase/);
  });
  it('bots never see dev commands in legalCommands', () => {
    const s = devRun();
    for (const cmd of legalCommands(s, content)) expect(cmd.type.startsWith('dev:')).toBe(false);
  });
});

describe('dev:gold / dev:xp', () => {
  it('gold adds and subtracts, but never below 0', () => {
    const s = devRun();
    const before = s.gold;
    expect(applyCommand(s, { type: 'dev:gold', amount: 1000 }, content).ok).toBe(true);
    expect(s.gold).toBe(before + 1000);
    expect(applyCommand(s, { type: 'dev:gold', amount: -1000 }, content).ok).toBe(true);
    expect(s.gold).toBe(before);
    expectRejected(s, { type: 'dev:gold', amount: -(before + 1) }, /gold cannot go below 0/);
    expectRejected(s, { type: 'dev:gold', amount: 1.5 }, /invalid gold amount/);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('gold stays hashable: huge amounts are rejected and a round boundary still hashes', () => {
    const s = devRun();
    expectRejected(s, { type: 'dev:gold', amount: 1e308 }, /invalid gold amount/);
    expectRejected(s, { type: 'dev:gold', amount: Number.MAX_SAFE_INTEGER }, /dev cap/);
    // Twice the largest legal top-up must still be refused, not silently accumulated.
    const cap = 2 ** 40;
    expect(applyCommand(s, { type: 'dev:gold', amount: cap - s.gold }, content).ok).toBe(true);
    expect(s.gold).toBe(cap);
    expectRejected(s, { type: 'dev:gold', amount: 1 }, /dev cap/);
    expect(checkInvariants(s, content)).toEqual([]);
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
    expect(Number.isSafeInteger(s.gold)).toBe(true);
    expect(s.hashes).toHaveLength(2);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('xp levels the player up through the normal xp table', () => {
    const s = devRun();
    const need = xpNeeded(s.level, content);
    expect(applyCommand(s, { type: 'dev:xp', amount: need }, content).ok).toBe(true);
    expect(s.level).toBe(2);
    expect(s.xp).toBe(0);
    expectRejected(s, { type: 'dev:xp', amount: 0 }, /positive integer/);
    expectRejected(s, { type: 'dev:xp', amount: -5 }, /positive integer/);
    expectRejected(s, { type: 'dev:xp', amount: 1e308 }, /positive integer/);
  });
});

describe('dev:invinciblePieces / dev:invinciblePlayer', () => {
  it('toggles are recorded in state and take a boolean', () => {
    const s = devRun();
    expect(s.dev.invinciblePieces).toBe(false);
    expect(applyCommand(s, { type: 'dev:invinciblePieces', on: true }, content).ok).toBe(true);
    expect(s.dev.invinciblePieces).toBe(true);
    expect(applyCommand(s, { type: 'dev:invinciblePieces', on: false }, content).ok).toBe(true);
    expect(s.dev.invinciblePieces).toBe(false);
    expectRejected(s, { type: 'dev:invinciblePlayer', on: 'yes' } as unknown as Command, /boolean/);
  });
  // Round 3's encounter kills a lone brawler; the cheat is what keeps it alive.
  function loneBrawlerFight(invincible: boolean): { survivors: number[]; deadUids: number[] } {
    const s = devRun();
    // Reach round 3 through the command log rather than by poking state.
    for (let r = 1; r < 3; r++) {
      expect(applyCommand(s, { type: 'dev:skipRound' }, content).ok).toBe(true);
      expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
    }
    expect(s.round).toBe(3);
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.brawler', star: 1, cell: { col: 3, row: 7 } }, content).ok).toBe(true);
    if (invincible) expect(applyCommand(s, { type: 'dev:invinciblePieces', on: true }, content).ok).toBe(true);
    const res = applyCommand(s, { type: 'startCombat' }, content);
    if (!res.ok || !res.fight) throw new Error('fight did not run');
    expect(res.fight.survivors.left.length + res.fight.survivors.right.length).toBeGreaterThan(0);
    return { survivors: res.fight.survivors.left, deadUids: res.fight.events.filter((e) => e.type === 'death').map((e) => (e as { uid: number }).uid) };
  }

  it('invincible pieces keeps the player unit alive; the enemy still dies', () => {
    const cheated = loneBrawlerFight(true);
    expect(cheated.survivors).toHaveLength(1);
    for (const uid of cheated.survivors) expect(cheated.deadUids).not.toContain(uid);
    expect(cheated.deadUids.length).toBeGreaterThan(0);
  });
  it('the same board without the cheat loses the unit', () => {
    const plain = loneBrawlerFight(false);
    expect(plain.survivors).toHaveLength(0);
  });
  it('invincible player takes no hp loss from a lost round', () => {
    const s = devRun();
    expect(applyCommand(s, { type: 'dev:invinciblePlayer', on: true }, content).ok).toBe(true);
    const hp = s.hp;
    expect(applyCommand(s, { type: 'startCombat' }, content).ok).toBe(true);
    expect(s.lastFight?.winner).toBe('right');
    expect(s.lastFight?.hpLoss).toBe(0);
    expect(s.hp).toBe(hp);
  });
});

describe('dev:skipRound', () => {
  it('resolves the round as a win with the normal rewards and no fight', () => {
    const s = devRun();
    const encounter = content.encounters[0]!;
    const goldBefore = s.gold;
    const hpBefore = s.hp;
    expect(applyCommand(s, { type: 'dev:skipRound' }, content).ok).toBe(true);
    expect(s.phase).toBe('reward');
    expect(s.lastFight).toBeNull();
    expect(s.hp).toBe(hpBefore);
    const record = s.history[0]!;
    expect(record.skipped).toBe(true);
    expect(record.fight).toBeNull();
    expect(record.encounterId).toBe(encounter.id);
    const reward = s.pendingReward!;
    expect(reward.winBonus).toBe(eco.winBonus);
    expect(reward.gold).toBe(reward.base + reward.interest + reward.winBonus + reward.encounterGold);
    expect(applyCommand(s, { type: 'nextRound' }, content).ok).toBe(true);
    expect(s.gold).toBe(goldBefore + reward.gold);
    expect(s.round).toBe(2);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('skipping the final encounter wins the run', () => {
    const s = devRun();
    s.round = content.encounters.length;
    expect(applyCommand(s, { type: 'dev:skipRound' }, content).ok).toBe(true);
    expect(s.phase).toBe('ended');
    expect(s.outcome).toBe('win');
    expect(s.endReason).toBe('victory');
  });
  it('leaves the combat rng stream untouched (no fight ran)', () => {
    const s = devRun();
    const before = s.rng.combat;
    expect(applyCommand(s, { type: 'dev:skipRound' }, content).ok).toBe(true);
    expect(s.rng.combat).toEqual(before);
  });
});

describe('dev:addAugment / dev:giveItem', () => {
  it('records the granted ids in state', () => {
    const s = devRun();
    expect(applyCommand(s, { type: 'dev:addAugment', augmentId: 'aug.iron_skin' }, content).ok).toBe(true);
    expect(applyCommand(s, { type: 'dev:addAugment', augmentId: 'aug.quickness' }, content).ok).toBe(true);
    expect(s.augments).toEqual(['aug.iron_skin', 'aug.quickness']);
    expect(applyCommand(s, { type: 'dev:giveItem', itemId: 'item.blade' }, content).ok).toBe(true);
    expect(s.itemBench).toEqual(['item.blade']);
  });
  it('rejects an unknown augment id and an unknown item id', () => {
    const s = devRun();
    expectRejected(s, { type: 'dev:addAugment', augmentId: '' }, /unknown augment id/);
    expectRejected(s, { type: 'dev:addAugment', augmentId: 'aug.does_not_exist' }, /unknown augment id/);
    expectRejected(s, { type: 'dev:giveItem', itemId: 'item.does_not_exist' }, /unknown item id/);
  });
});

describe('dev:openShop', () => {
  it('fills every shop slot from the chosen tier for free', () => {
    const s = devRun();
    const gold = s.gold;
    const tier = 5;
    expect(applyCommand(s, { type: 'dev:openShop', tier }, content), 'tier 5 reroll').toMatchObject({ ok: true });
    expect(s.gold).toBe(gold);
    expect(s.shop).toHaveLength(eco.shopSlots);
    for (const id of s.shop) {
      expect(id).not.toBeNull();
      expect(content.unitsById[id as string]!.cost).toBe(tier);
    }
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('returns the old shop to the pool, so the pool total is unchanged', () => {
    const s = devRun();
    const total = (st: RunState): number => Object.values(st.pool).reduce((a, b) => a + b, 0);
    const before = total(s);
    expect(applyCommand(s, { type: 'dev:openShop', tier: 2 }, content).ok).toBe(true);
    expect(total(s)).toBe(before);
  });
  it('rejects a tier outside the data-defined range', () => {
    const s = devRun();
    const tiers = shopTierCount(content);
    expectRejected(s, { type: 'dev:openShop', tier: 0 }, new RegExp(`1\\.\\.${tiers}`));
    expectRejected(s, { type: 'dev:openShop', tier: tiers + 1 }, new RegExp(`1\\.\\.${tiers}`));
  });
});

describe('dev:spawnUnit', () => {
  it('spawns onto the bench and onto a player-half cell', () => {
    const s = devRun();
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: 2, cell: null }, content).ok).toBe(true);
    const benched = s.bench.find((u) => u !== null && u.defId === 'dev.mage');
    expect(benched?.star).toBe(2);
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.titan', star: 1, cell: { col: 2, row: 6 } }, content).ok).toBe(true);
    expect(s.board).toHaveLength(1);
    expect(s.board[0]).toMatchObject({ defId: 'dev.titan', star: 1, col: 2, row: 6 });
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('rejects an unknown unit, a bad star, an occupied or enemy-half cell and a full team', () => {
    const s = devRun();
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'nope', star: 1, cell: null }, /unknown unit/);
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: eco.maxStar + 1, cell: null }, /star must be/);
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: 1, cell: { col: 0, row: 0 } }, /outside the player half/);
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: 1, cell: { col: 1, row: 7 } }, content).ok).toBe(true);
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: 1, cell: { col: 1, row: 7 } }, /occupied/);
    // Level 1 team cap: one unit on the board is already full.
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'dev.mage', star: 1, cell: { col: 2, row: 7 } }, /team is full/);
  });
  it('rejects ids inherited from Object.prototype', () => {
    const s = devRun();
    for (const defId of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      expectRejected(s, { type: 'dev:spawnUnit', defId, star: 1, cell: null }, /unknown unit/);
    }
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('spawning past the pool and selling back never inflates the pool above its capacity', () => {
    const s = devRun();
    const cap = poolCapacity('dev.knight', content);
    expect(cap).toBeGreaterThan(0);
    const uids: number[] = [];
    for (let i = 0; i < 4; i++) {
      expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.knight', star: 3, cell: null }, content).ok).toBe(true);
      const spawned = s.bench.find((u) => u !== null && u.defId === 'dev.knight' && !uids.includes(u.uid));
      uids.push(spawned!.uid);
    }
    for (const uid of uids) expect(applyCommand(s, { type: 'sell', uid }, content).ok).toBe(true);
    expect(s.pool['dev.knight']).toBeLessThanOrEqual(cap);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('takes copies out of the pool but never drives it negative', () => {
    const s = devRun();
    const before = s.pool['dev.knight'] as number;
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.knight', star: 2, cell: null }, content).ok).toBe(true);
    expect(s.pool['dev.knight']).toBe(before - eco.mergeCopies);
    s.pool['dev.knight'] = 1;
    expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.knight', star: 3, cell: null }, content).ok).toBe(true);
    expect(s.pool['dev.knight']).toBe(0);
    expect(checkInvariants(s, content)).toEqual([]);
  });
  it('spawned copies merge like bought ones', () => {
    const s = devRun();
    for (let i = 0; i < eco.mergeCopies; i++) {
      expect(applyCommand(s, { type: 'dev:spawnUnit', defId: 'dev.archer', star: 1, cell: null }, content).ok).toBe(true);
    }
    const archers = s.bench.filter((u) => u !== null && u.defId === 'dev.archer');
    expect(archers).toHaveLength(1);
    expect(archers[0]!.star).toBe(2);
  });
  it('rejects a bench spawn when the bench is full', () => {
    const s = devRun();
    for (let i = 0; i < eco.benchSlots; i++) s.bench[i] = { uid: 1000 + i, defId: 'dev.mage', star: 1, items: [] };
    expectRejected(s, { type: 'dev:spawnUnit', defId: 'dev.titan', star: 1, cell: null }, /bench is full/);
  });
});

describe('replay with dev commands', () => {
  it('a log containing dev commands replays with every round hash matching', () => {
    const seed = 7;
    const s = devRun(seed);
    const log: Command[] = [
      { type: 'dev:gold', amount: 1000 },
      { type: 'dev:xp', amount: 100 },
      { type: 'dev:openShop', tier: 1 },
      { type: 'dev:spawnUnit', defId: 'dev.guardian', star: 2, cell: { col: 3, row: 7 } },
      { type: 'dev:addAugment', augmentId: 'aug.iron_skin' },
      { type: 'dev:giveItem', itemId: 'item.blade' },
      { type: 'dev:invinciblePieces', on: true },
      { type: 'startCombat' },
      { type: 'nextRound' },
      { type: 'dev:skipRound' },
      { type: 'nextRound' },
    ];
    for (const cmd of log) {
      const res = applyCommand(s, cmd, content);
      expect(res.ok, `${JSON.stringify(cmd)} -> ${res.ok ? '' : res.reason}`).toBe(true);
    }
    expect(s.hashes.length).toBeGreaterThanOrEqual(3);
    const replay = replayRun(seed, log, content, { devCommands: true });
    expect(replay.rejected).toBeNull();
    expect(replay.hashes).toEqual(s.hashes);
    expect(stateHash(replay.state)).toBe(stateHash(s));
  });
  it('replayLog uses the flag recorded in the log', () => {
    const seed = 11;
    const s = devRun(seed);
    const commands: Command[] = [{ type: 'dev:gold', amount: 25 }, { type: 'dev:skipRound' }, { type: 'nextRound' }];
    for (const cmd of commands) expect(applyCommand(s, cmd, content).ok).toBe(true);
    const log: RunLog = { version: 1, seed, contentHash: content.contentHash, devCommands: true, commands };
    const replay = replayLog(log, content);
    expect(replay.rejected).toBeNull();
    expect(replay.hashes).toEqual(s.hashes);
    expect(replayLog({ ...log, devCommands: false }, content).rejected?.index).toBe(0);
  });
  it('the same log replayed without the dev flag is rejected at the first dev command', () => {
    const log: Command[] = [{ type: 'reroll' }, { type: 'dev:gold', amount: 10 }];
    const replay = replayRun(7, log, content);
    expect(replay.rejected).toEqual({ index: 1, reason: expect.stringMatching(/dev commands are disabled/) as unknown as string });
  });
});
