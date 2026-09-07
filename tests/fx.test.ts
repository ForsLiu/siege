// P0-30: Combat FX cue derivation — pure, driven only by a fight's own event log. Building or
// drawing cues never touches the sim, so these tests only exercise `buildFxCues`/`fxCueWindow`/
// `activeFxCues` (src/render/fx.ts) against hand-crafted event arrays, not a live `fight()` run.
import { describe, expect, it } from 'vitest';
import { loadSandboxSetupFromDisk } from '../src/data/node.ts';
import { activeFxCues, buildFxCues, fxCueWindow, type FxCue } from '../src/render/fx.ts';
import { fight, type FightEvent } from '../src/sim/fight.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import { buildSandboxFight } from '../src/sim/sandbox.ts';
import { devBoard, devContent } from './helpers.ts';

const content = devContent();
// dev.brawler is melee, dev.archer is ranged (data/dev/units.json) — real dev content, no
// invented units, matching CLAUDE.md's "engine tests may use sample content under data/dev/".
const MELEE = 'dev.brawler';
const RANGED = 'dev.archer';

function spawn(uid: number, defId: string, team: 0 | 1 = 0, tick = 0): FightEvent {
  return { tick, type: 'spawn', uid, defId, star: 1, team, col: 0, row: 0, hp: 100, maxHp: 100, mana: 0, maxMana: 0 };
}

describe('buildFxCues (P0-30)', () => {
  it('a melee basic attack produces a swing and an impact flash at the same tick', () => {
    const events: FightEvent[] = [spawn(1, MELEE), spawn(2, MELEE, 1), { tick: 5, type: 'attack', uid: 1, target: 2, manaAfter: 0 }];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([
      { kind: 'meleeSwing', tick: 5, uid: 1, target: 2 },
      { kind: 'impactFlash', tick: 5, target: 2 },
    ]);
  });

  it('a ranged basic attack produces a synthetic trail ending in an impact flash', () => {
    const events: FightEvent[] = [spawn(1, RANGED), spawn(2, RANGED, 1), { tick: 5, type: 'attack', uid: 1, target: 2, manaAfter: 0 }];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues[0]).toMatchObject({ kind: 'projectileTrail', tick: 5, uid: 1, target: 2 });
    expect((cues[0] as { untilTick: number }).untilTick).toBeGreaterThan(5);
    expect(cues[1]).toEqual({ kind: 'impactFlash', tick: (cues[0] as { untilTick: number }).untilTick, target: 2 });
  });

  it('a real spawnProjectile ability trails from spawn to arrival, and a hit ends it in a flash', () => {
    const events: FightEvent[] = [
      spawn(1, RANGED),
      spawn(2, RANGED, 1),
      { tick: 5, type: 'projectile', uid: 1, target: 2, ref: 'dev.bolt', arrivalTick: 9 },
      { tick: 9, type: 'projectileHit', uid: 1, target: 2, ref: 'dev.bolt' },
    ];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([
      { kind: 'projectileTrail', tick: 5, untilTick: 9, uid: 1, target: 2 },
      { kind: 'impactFlash', tick: 9, target: 2 },
    ]);
  });

  it('a fizzled projectile produces no impact flash', () => {
    const events: FightEvent[] = [spawn(1, RANGED), spawn(2, RANGED, 1), { tick: 5, type: 'projectile', uid: 1, target: 2, ref: 'dev.bolt', arrivalTick: 9 }, { tick: 9, type: 'projectileFizzle', uid: 1, target: 2, ref: 'dev.bolt' }];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([{ kind: 'projectileTrail', tick: 5, untilTick: 9, uid: 1, target: 2 }]);
  });

  it('a cast produces both a flash on the caster and a named toast', () => {
    const events: FightEvent[] = [spawn(1, MELEE), { tick: 3, type: 'cast', uid: 1, target: 1, ability: 'Dev Slam', manaAfter: 0 }];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([
      { kind: 'castFlash', tick: 3, uid: 1 },
      { kind: 'castToast', tick: 3, uid: 1, text: 'Dev Slam' },
    ]);
  });

  it('a shield grant shimmers; a shield expiry (uid 0) does not', () => {
    const events: FightEvent[] = [
      spawn(1, MELEE),
      { tick: 2, type: 'shield', uid: 1, target: 1, amount: 50, shieldAfter: 50, expiresTick: 10, source: 'ability:dev.warden' },
      { tick: 10, type: 'shield', uid: 0, target: 1, amount: 0, shieldAfter: 0, expiresTick: null, source: 'expiry' },
    ];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([{ kind: 'shieldShimmer', tick: 2, target: 1 }]);
  });

  it('an ordinary heal produces only a heal pulse, not a lifesteal pulse', () => {
    const events: FightEvent[] = [spawn(1, MELEE), spawn(2, MELEE, 1), { tick: 4, type: 'heal', uid: 1, target: 2, amount: 20, hpAfter: 120, cause: 'ability:dev.healer' }];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([{ kind: 'healPulse', tick: 4, target: 2 }]);
  });

  it('a self-heal in the same tick as that unit\'s own hit is inferred as lifesteal', () => {
    const events: FightEvent[] = [
      spawn(1, MELEE),
      spawn(2, MELEE, 1),
      { tick: 6, type: 'hit', uid: 1, target: 2, kind: 'physical', amount: 10, raw: 10, mitigated: 0, absorbed: 0, hpAfter: 90, manaAfter: 0, cause: 'attack' },
      { tick: 6, type: 'heal', uid: 1, target: 1, amount: 5, hpAfter: 105, cause: 'hook:onHit:dev.knight' },
    ];
    const cues = buildFxCues(events, content.unitsById);
    expect(cues).toEqual([
      { kind: 'healPulse', tick: 6, target: 1 },
      { kind: 'lifestealPulse', tick: 6, uid: 1 },
    ]);
  });

  it('a self-heal healing another unit, or one tick off from its own hit, is not lifesteal', () => {
    const notSelf: FightEvent[] = [
      spawn(1, MELEE),
      spawn(2, MELEE, 1),
      { tick: 6, type: 'hit', uid: 1, target: 2, kind: 'physical', amount: 10, raw: 10, mitigated: 0, absorbed: 0, hpAfter: 90, manaAfter: 0, cause: 'attack' },
      { tick: 6, type: 'heal', uid: 1, target: 2, amount: 5, hpAfter: 95, cause: 'hook:onHit:x' },
    ];
    expect(buildFxCues(notSelf, content.unitsById)).toEqual([{ kind: 'healPulse', tick: 6, target: 2 }]);

    const offTick: FightEvent[] = [
      spawn(1, MELEE),
      spawn(2, MELEE, 1),
      { tick: 6, type: 'hit', uid: 1, target: 2, kind: 'physical', amount: 10, raw: 10, mitigated: 0, absorbed: 0, hpAfter: 90, manaAfter: 0, cause: 'attack' },
      { tick: 7, type: 'heal', uid: 1, target: 1, amount: 5, hpAfter: 105, cause: 'hook:onHit:x' },
    ];
    expect(buildFxCues(offTick, content.unitsById)).toEqual([{ kind: 'healPulse', tick: 7, target: 1 }]);
  });

  it('events with no FX meaning (move, death, stun, statMod, end, maxHp) produce no cues', () => {
    const events: FightEvent[] = [
      spawn(1, MELEE),
      { tick: 1, type: 'move', uid: 1, from: { col: 0, row: 0 }, to: { col: 0, row: 1 } },
      { tick: 2, type: 'stun', uid: 1, untilTick: 5, cause: 'ability:x' },
      { tick: 2, type: 'statMod', uid: 1, stat: 'armor', mode: 'flat', value: 5, expiresTick: null, source: 'x' },
      { tick: 3, type: 'statModEnd', uid: 1, stat: 'armor', source: 'x' },
      { tick: 4, type: 'maxHp', uid: 1, maxHp: 100, hp: 100 },
      { tick: 5, type: 'death', uid: 1, killer: 2 },
      { tick: 5, type: 'end', winner: 'right', reason: 'elimination' },
    ];
    expect(buildFxCues(events, content.unitsById)).toEqual([]);
  });

  it('does not mutate its input events', () => {
    const events: FightEvent[] = [spawn(1, MELEE), spawn(2, MELEE, 1), { tick: 5, type: 'attack', uid: 1, target: 2, manaAfter: 0 }];
    const before = structuredClone(events);
    buildFxCues(events, content.unitsById);
    expect(events).toEqual(before);
  });

  it('is deterministic: the same events produce deep-equal cues every time', () => {
    const events: FightEvent[] = [spawn(1, MELEE), spawn(2, MELEE, 1), { tick: 5, type: 'attack', uid: 1, target: 2, manaAfter: 0 }, { tick: 6, type: 'cast', uid: 1, target: 2, ability: 'Dev Slam', manaAfter: 0 }];
    expect(buildFxCues(events, content.unitsById)).toEqual(buildFxCues(events, content.unitsById));
  });
});

describe('fxCueWindow / activeFxCues (P0-30)', () => {
  it('a cue is active on [from, to) — visible at its start tick, gone at its end tick', () => {
    const cue = { kind: 'healPulse' as const, tick: 10, target: 1 };
    const w = fxCueWindow(cue);
    expect(w.from).toBe(10);
    expect(activeFxCues([cue], w.from)).toEqual([cue]);
    expect(activeFxCues([cue], w.to - 0.01)).toEqual([cue]);
    expect(activeFxCues([cue], w.to)).toEqual([]);
    expect(activeFxCues([cue], w.from - 0.01)).toEqual([]);
  });

  it('a projectileTrail\'s window is exactly [tick, untilTick)', () => {
    const cue = { kind: 'projectileTrail' as const, tick: 5, untilTick: 12, uid: 1, target: 2 };
    expect(fxCueWindow(cue)).toEqual({ from: 5, to: 12 });
  });
});

describe('the five P0-30 sandbox fixtures each actually reliably trigger their cue (manual checklist prerequisite)', () => {
  const cases: { file: string; kind: FxCue['kind'] }[] = [
    { file: 'data/dev/boards/sandbox-fx-melee.json', kind: 'meleeSwing' },
    { file: 'data/dev/boards/sandbox-fx-ranged.json', kind: 'projectileTrail' },
    { file: 'data/dev/boards/sandbox-fx-cast.json', kind: 'castToast' },
    { file: 'data/dev/boards/sandbox-fx-shield.json', kind: 'shieldShimmer' },
    { file: 'data/dev/boards/sandbox-fx-heal-lifesteal.json', kind: 'lifestealPulse' },
  ];
  for (const { file, kind } of cases) {
    // Every seed, not just one: each fixture's stat overrides give it enough margin (high
    // attackSpeed/hp, or a hook that fires unconditionally at combat start) that this should
    // never depend on which seed a manual playtest happens to use.
    for (const seed of [1, 2, 3, 4, 5]) {
      it(`${file} produces at least one ${kind} cue (seed ${seed})`, () => {
        const setup = loadSandboxSetupFromDisk(file, content);
        const { left, right, rules } = buildSandboxFight(content, setup);
        const result = fight(left, right, seed, rules);
        // The sandbox's own synthetic per-instance unit registry, not content.unitsById — see the
        // comment on buildFxCues/startPlayback (main.ts wires the same rules.units through).
        const cues = buildFxCues(result.events, rules.units);
        expect(cues.some((c) => c.kind === kind)).toBe(true);
      });
    }
  }
});

describe('FX is hash-neutral (P0-30 acceptance: identical hashes with FX enabled/disabled)', () => {
  it('building FX cues from a real fight leaves its result (and hash) untouched', () => {
    const left = devBoard('a');
    const right = devBoard('b');
    const rules = fightRulesFrom(content);
    // The "FX off" case is simply never calling buildFxCues/drawFx (src/app/main.ts's `fxOn`
    // toggle) — since it is a pure function of an already-computed FightResult's events, calling
    // it can only ever fail to change that result, never the other way around. This test proves
    // that directly: the same fight run twice, cues built after only one of the two runs.
    const withoutFx = fight(left, right, 7, rules);
    const withFx = fight(left, right, 7, rules);
    const cues = buildFxCues(withFx.events, content.unitsById);
    expect(withFx.hash).toBe(withoutFx.hash);
    expect(withFx).toEqual(withoutFx);
    expect(cues.length).toBeGreaterThan(0); // sanity: this fixture actually produces FX-worthy events
  });
});
