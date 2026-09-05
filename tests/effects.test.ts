// Effect vocabulary v1 (P0-01): one numeric test per effect, per trigger and for the
// damage pipeline, plus the schema rejections that keep unknown vocabulary out of /data.
import { describe, expect, it } from 'vitest';
import { loadContent, type RawContentFiles } from '../src/data/loader.ts';
import { AuraEffectSchema, EffectSchema } from '../src/data/schemas.ts';
import { DAMAGE_STAGES, EFFECT_TYPES, HOOK_NAMES, type Effect, type ProjectileDef } from '../src/sim/effects.ts';
import { fight, type FightEvent, type FightResult } from '../src/sim/fight.ts';
import { hexDistance } from '../src/sim/hex.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import type { BoardUnit } from '../src/sim/units.ts';
import { devContent, rawDevContent, rulesWithUnits, testUnit } from './helpers.ts';

/** A mana pool so large that attack/hit mana can never refill it: the unit casts exactly once. */
const ONE_SHOT_MANA = 100000;

/** Left unit at (col,row); right unit authored at (col,row) and mirrored by the sim. */
function duel(leftId: string, rightId: string, left: [number, number] = [3, 4], right: [number, number] = [3, 4]): [BoardUnit[], BoardUnit[]] {
  return [
    [{ defId: leftId, star: 1, col: left[0], row: left[1] }],
    [{ defId: rightId, star: 1, col: right[0], row: right[1] }],
  ];
}

function hits(r: FightResult, uid: number): Extract<FightEvent, { type: 'hit' }>[] {
  return r.events.filter((e): e is Extract<FightEvent, { type: 'hit' }> => e.type === 'hit' && e.uid === uid);
}

function eventsOfType<T extends FightEvent['type']>(r: FightResult, type: T): Extract<FightEvent, { type: T }>[] {
  return r.events.filter((e): e is Extract<FightEvent, { type: T }> => e.type === type);
}

/** A punching bag: no damage, no mana, enough hp to survive the window under test. */
function dummy(id = 't.dummy', hp = 100000) {
  return testUnit(id, { hp, attack: 0, attackSpeed: 1, range: 1 });
}

describe('effect vocabulary v1', () => {
  it('the vocabulary and hook list are exactly what the schema accepts', () => {
    expect([...EFFECT_TYPES]).toEqual(['damage', 'heal', 'shield', 'statMod', 'stun', 'applyTag', 'spawnProjectile']);
    expect([...HOOK_NAMES]).toEqual(['onCombatStart', 'onRoundStart', 'onAttack', 'onHit', 'onCast', 'onKill', 'onDeath', 'onTakeDamage']);
    for (const t of EFFECT_TYPES) {
      // Every declared type parses in at least its minimal shape.
      const minimal: Record<string, Effect> = {
        damage: { type: 'damage', kind: 'true', amount: 1, target: 'target' },
        heal: { type: 'heal', amount: 1, target: 'self' },
        shield: { type: 'shield', amount: 1, duration: 1, target: 'self' },
        statMod: { type: 'statMod', stat: 'attack', mode: 'flat', value: 1, duration: null, target: 'self' },
        stun: { type: 'stun', duration: 1, target: 'target' },
        applyTag: { type: 'applyTag', tag: 'x', duration: 1, target: 'self' },
        spawnProjectile: { type: 'spawnProjectile', ref: 'p', target: 'target' },
      };
      expect(EffectSchema.safeParse(minimal[t]).success, t).toBe(true);
    }
  });

  it('damage: scaling adds factor x the caster stat, then mitigation and the ledger agree', () => {
    // 100 flat + 1.5 x attack(40) = 160 magic damage into 100 magic resist => 160 * 100/200 = 80.
    const caster = testUnit('t.caster', { hp: 1000, attack: 40, attackSpeed: 0.0001, range: 1, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      ability: { name: 'Bolt', effects: [{ type: 'damage', kind: 'magic', amount: 100, scaling: { stat: 'attack', factor: 1.5 }, target: 'target' }] },
    });
    const tank = testUnit('t.tank', { hp: 100000, attack: 0, magicResist: 100, range: 1 });
    const [l, r] = duel('t.caster', 't.tank');
    const res = fight(l, r, 1, rulesWithUnits([caster, tank], { maxSeconds: 1 }));
    const cast = hits(res, 1).filter((h) => h.cause === 'ability:t.caster');
    expect(cast).toHaveLength(1);
    const h = cast[0]!;
    expect(h.raw).toBeCloseTo(160, 9);
    expect(h.mitigated).toBeCloseTo(80, 9);
    expect(h.absorbed).toBe(0);
    expect(h.amount).toBeCloseTo(80, 9);
    expect(res.ledger.find((e) => e.uid === 2)?.mitigated).toBeCloseTo(80, 9);
  });

  it('heal: restores exactly the missing hp and never overheals', () => {
    // The healer chips itself for 300 with an onCombatStart hook, then heals 1000 on cast.
    const healer = testUnit('t.healer', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      hooks: { onCombatStart: [{ type: 'damage', kind: 'true', amount: 300, target: 'self' }] },
      ability: { name: 'Mend', effects: [{ type: 'heal', amount: 1000, target: 'self' }] },
    });
    const [l, r] = duel('t.healer', 't.dummy');
    const res = fight(l, r, 1, rulesWithUnits([healer, dummy()], { maxSeconds: 1 }));
    const heals = eventsOfType(res, 'heal');
    expect(heals).toHaveLength(1);
    expect(heals[0]!.amount).toBeCloseTo(300, 9);
    expect(heals[0]!.hpAfter).toBeCloseTo(1000, 9);
    expect(res.ledger.find((e) => e.uid === 1)?.healed).toBeCloseTo(300, 9);
  });

  it('shield: absorbs exactly its amount, spills the remainder onto hp, then expires', () => {
    // Warden shields itself for 250 (permanent) at combat start; the attacker deals 100/s true.
    // Hits at ticks 0, 30, 60: 100 + 100 + 50 absorbed, then 50 lands on hp.
    const warden = testUnit('t.warden', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'shield', amount: 250, duration: null, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1, armor: 0 });
    const [l, r] = duel('t.attacker', 't.warden');
    const res = fight(l, r, 1, rulesWithUnits([attacker, warden], { maxSeconds: 3, mitigationConstant: 100 }));
    const taken = hits(res, 1);
    expect(taken.map((h) => h.tick)).toEqual([0, 30, 60]);
    expect(taken.map((h) => h.absorbed)).toEqual([100, 100, 50]);
    expect(taken.map((h) => h.amount)).toEqual([0, 0, 50]);
    expect(taken[2]!.hpAfter).toBeCloseTo(950, 9);
    const wardenLedger = res.ledger.find((e) => e.uid === 2)!;
    expect(wardenLedger.absorbed).toBeCloseTo(250, 9);
    expect(wardenLedger.shielded).toBeCloseTo(250, 9);
    expect(wardenLedger.taken).toBeCloseTo(50, 9);
    // Granted once, reported with the wearer's running total.
    const grants = eventsOfType(res, 'shield').filter((e) => e.uid !== 0);
    expect(grants).toHaveLength(1);
    expect(grants[0]!.amount).toBeCloseTo(250, 9);
    expect(grants[0]!.shieldAfter).toBeCloseTo(250, 9);
  });

  it('shield: a timed shield expires on its tick and stops absorbing', () => {
    const warden = testUnit('t.warden', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'shield', amount: 250, duration: 1, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.attacker', 't.warden');
    const res = fight(l, r, 1, rulesWithUnits([attacker, warden], { maxSeconds: 3, mitigationConstant: 100 }));
    const expiry = eventsOfType(res, 'shield').filter((e) => e.uid === 0);
    expect(expiry).toHaveLength(1);
    expect(expiry[0]!.tick).toBe(30);
    expect(expiry[0]!.shieldAfter).toBe(0);
    const taken = hits(res, 1);
    expect(taken.map((h) => h.absorbed)).toEqual([100, 0, 0]);
  });

  it('shield: instances are per (source, granting unit, effect slot) - two casters stack, a re-cast refreshes', () => {
    // Two shielders each grant 100 to the same ally, and each grants two different amounts,
    // so the ally carries 4 independent absorbers: 100 + 60 from each caster = 320.
    const shielder = testUnit('t.shielder', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: {
        onCombatStart: [
          { type: 'shield', amount: 100, duration: null, target: 'allies' },
          { type: 'shield', amount: 60, duration: null, target: 'allies' },
        ],
      },
    });
    const ally = testUnit('t.ally', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 1000, attackSpeed: 1, range: 8 });
    const left: BoardUnit[] = [
      { defId: 't.shielder', star: 1, col: 0, row: 7 },
      { defId: 't.shielder', star: 1, col: 1, row: 7 },
      { defId: 't.ally', star: 1, col: 2, row: 7 },
    ];
    const right: BoardUnit[] = [{ defId: 't.attacker', star: 1, col: 3, row: 4 }];
    const res = fight(left, right, 1, rulesWithUnits([shielder, ally, attacker], { maxSeconds: 2, mitigationConstant: 100 }));
    // Each shielder shields all three allies; the ally's own total is 2 casters x (100 + 60).
    const onAlly = eventsOfType(res, 'shield').filter((e) => e.target === 3 && e.uid !== 0);
    expect(onAlly).toHaveLength(4);
    expect(new Set(onAlly.map((e) => e.source)).size).toBe(4);
    expect(Math.max(...onAlly.map((e) => e.shieldAfter))).toBeCloseTo(320, 9);
    // Whoever the attacker picks carries the same four absorbers: its first hit is fully soaked
    // up to 320, which is only possible if the two casters' shields coexist.
    const firstHit = hits(res, 4)[0]!;
    expect(firstHit.absorbed).toBeCloseTo(320, 9);
    expect(firstHit.amount).toBeCloseTo(firstHit.raw - 320, 9);
  });

  it('shield: a re-grant from the same instance refreshes instead of stacking, and only credits the delta', () => {
    // The same hook fires on every hit taken: 50, then 50 again (no growth), then the ledger
    // credit is the delta only.
    const wearer = testUnit('t.wearer', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onTakeDamage: [{ type: 'shield', amount: 50, duration: null, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.attacker', 't.wearer');
    const res = fight(l, r, 1, rulesWithUnits([attacker, wearer], { maxSeconds: 3, mitigationConstant: 100 }));
    const grants = eventsOfType(res, 'shield').filter((e) => e.uid !== 0);
    expect(new Set(grants.map((e) => e.source)).size).toBe(1);
    expect(Math.max(...grants.map((e) => e.shieldAfter))).toBeCloseTo(50, 9);
    // First grant credits 50; every refresh adds nothing on top of the surviving amount.
    expect(res.ledger.find((e) => e.uid === 2)!.shielded).toBeLessThanOrEqual(grants.length * 50);
    expect(grants[0]!.amount).toBeCloseTo(50, 9);
  });

  it('statMod: a flat modifier moves the stat by exactly its value for its duration', () => {
    // +100 armor for 1 s halves the incoming 100 physical damage (K = 100).
    const target = testUnit('t.soft', { hp: 100000, attack: 0, armor: 0, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 100, duration: 1, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.attacker', 't.soft');
    const res = fight(l, r, 1, rulesWithUnits([attacker, target], { maxSeconds: 3, mitigationConstant: 100 }));
    const taken = hits(res, 1);
    expect(taken[0]!.tick).toBe(0);
    expect(taken[0]!.amount).toBeCloseTo(50, 9); // armor 100 active
    expect(taken[1]!.tick).toBe(30);
    expect(taken[1]!.amount).toBeCloseTo(100, 9); // expired at tick 30
  });

  it('stun: the target loses exactly `duration` seconds of turns', () => {
    // The dummy is stunned for 1 s at combat start; it attacks once per second otherwise.
    const stunner = testUnit('t.stunner', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'stun', duration: 1, target: 'enemies' }] },
    });
    const striker = testUnit('t.striker', { hp: 100000, attack: 10, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.stunner', 't.striker');
    const res = fight(l, r, 1, rulesWithUnits([stunner, striker], { maxSeconds: 3 }));
    // Without the stun the striker would hit at ticks 0, 30, 60; stunned until tick 30 it hits at 30, 60.
    expect(hits(res, 2).map((h) => h.tick)).toEqual([30, 60]);
  });

  it('applyTag: the tag goes up on apply and comes down exactly when it expires', () => {
    const tagger = testUnit('t.tagger', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'applyTag', tag: 'marked', duration: 2, target: 'enemies' }] },
    });
    const [l, r] = duel('t.tagger', 't.dummy');
    const res = fight(l, r, 1, rulesWithUnits([tagger, dummy()], { maxSeconds: 4 }));
    const tags = eventsOfType(res, 'tag').filter((e) => e.tag === 'marked');
    expect(tags).toHaveLength(2);
    expect(tags[0]).toMatchObject({ tick: 0, uid: 2, active: true, expiresTick: 60 });
    expect(tags[1]).toMatchObject({ tick: 60, uid: 2, active: false });
  });

  it('spawnProjectile: the hit lands on the predicted tick and fizzles when the target dies first', () => {
    const bolt: ProjectileDef = {
      id: 't.bolt',
      speed: 8,
      effects: [{ type: 'damage', kind: 'true', amount: 40, target: 'target' }],
    };
    const shooter = testUnit('t.shooter', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      ability: { name: 'Bolt', effects: [{ type: 'spawnProjectile', ref: 't.bolt', target: 'target' }] },
    });
    const [l, r] = duel('t.shooter', 't.dummy', [3, 7], [3, 4]);
    const res = fight(l, r, 1, rulesWithUnits([shooter, dummy()], { maxSeconds: 4 }, [bolt]));
    const spawn = eventsOfType(res, 'projectile')[0]!;
    const distance = hexDistance({ col: 3, row: 7 }, { col: 3, row: 3 });
    const travel = Math.max(1, Math.round((distance / bolt.speed) * 30));
    expect(spawn.tick).toBe(0);
    expect(spawn.arrivalTick).toBe(travel);
    const hit = eventsOfType(res, 'projectileHit');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.tick).toBe(travel);
    const dmg = hits(res, 1).filter((h) => h.cause === 'projectile:t.bolt');
    expect(dmg).toHaveLength(1);
    expect(dmg[0]!.tick).toBe(travel);
    expect(dmg[0]!.amount).toBeCloseTo(40, 9);

    // A target that dies while the bolt is in flight makes it fizzle: no hit, no damage.
    // A second enemy keeps the fight running past the death so the bolt gets to arrive.
    const glass = testUnit('t.glass', { hp: 1, attack: 0, range: 1 });
    const sniper = testUnit('t.sniper', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      ability: {
        name: 'Bolt+',
        effects: [
          { type: 'spawnProjectile', ref: 't.bolt', target: 'target' },
          { type: 'damage', kind: 'true', amount: 10, target: 'target' },
        ],
      },
    });
    const [l2, r2] = duel('t.sniper', 't.glass', [3, 7], [3, 4]);
    r2.push({ defId: 't.dummy', star: 1, col: 5, row: 4 });
    const res2 = fight(l2, r2, 1, rulesWithUnits([sniper, glass, dummy()], { maxSeconds: 4 }, [bolt]));
    expect(eventsOfType(res2, 'projectileHit')).toHaveLength(0);
    expect(eventsOfType(res2, 'projectileFizzle')).toHaveLength(1);
  });
});

describe('triggers', () => {
  it('onRoundStart fires before onCombatStart, once per fight', () => {
    const u = testUnit('t.pre', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: {
        onRoundStart: [{ type: 'applyTag', tag: 'round', duration: null, target: 'self' }],
        onCombatStart: [{ type: 'applyTag', tag: 'combat', duration: null, target: 'self' }],
      },
    });
    const [l, r] = duel('t.pre', 't.dummy');
    const res = fight(l, r, 1, rulesWithUnits([u, dummy()], { maxSeconds: 1 }));
    const order = eventsOfType(res, 'tag').map((e) => e.tag);
    expect(order).toEqual(['round', 'combat']);
  });

  it('onTakeDamage fires on the damaged unit with the attacker as context, and cannot loop forever', () => {
    // Every hit taken stacks +1 armor on the victim; the hook itself deals damage back,
    // which would re-enter onTakeDamage without the depth guard.
    const victim = testUnit('t.victim', { hp: 100000, attack: 0, attackSpeed: 0.0001, armor: 0, range: 1 }, {
      hooks: {
        onTakeDamage: [
          { type: 'statMod', stat: 'armor', mode: 'flat', value: 1, duration: null, target: 'self' },
          { type: 'damage', kind: 'true', amount: 1, target: 'self' },
        ],
      },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.attacker', 't.victim');
    const res = fight(l, r, 1, rulesWithUnits([attacker, victim], { maxSeconds: 1 }));
    const selfHits = hits(res, 2).filter((h) => h.target === 2);
    // The chain is cut at the fixed hook depth (8) instead of recursing without bound: the
    // deepest firing still stacks armor and deals its point of damage, but re-entry stops there.
    expect(selfHits).toHaveLength(8);
    const mods = eventsOfType(res, 'statMod').filter((e) => e.uid === 2 && e.stat === 'armor');
    expect(mods).toHaveLength(8);
    expect(res.ticks).toBe(30);
  });

  it('aura: applies inside the radius, drops outside it, and never stacks per tick', () => {
    // Warden has a radius-1 armor aura. The ally starts 4 hexes away and walks into range.
    const warden = testUnit('t.warden', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      aura: { range: 1, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 100, duration: null, target: 'allies' }] },
    });
    const ally = testUnit('t.ally', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const [l, r] = duel('t.warden', 't.dummy', [3, 7], [3, 4]);
    l.push({ defId: 't.ally', star: 1, col: 3, row: 6 });
    const res = fight(l, r, 1, rulesWithUnits([warden, ally, dummy()], { maxSeconds: 2 }));
    const auraMods = eventsOfType(res, 'statMod').filter((e) => e.source.startsWith('aura:'));
    // Warden (uid 2, back row) and the adjacent ally (uid 1) are both inside a radius-1 aura,
    // and each is modified exactly once for the whole fight - no per-tick restacking.
    const perUid = new Map<number, number>();
    for (const m of auraMods) perUid.set(m.uid, (perUid.get(m.uid) ?? 0) + 1);
    expect(perUid.size).toBe(2); // the warden itself and the adjacent ally
    for (const [, count] of perUid) expect(count).toBe(1);
    expect(auraMods.length).toBe(2);
  });

  it('onAttack fires before the attack lands and onHit after it', () => {
    // An onAttack shield on the attacker's target absorbs that same attack; an onHit one does not.
    const preAttacker = testUnit('t.pre', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 }, {
      hooks: { onAttack: [{ type: 'shield', amount: 1000, duration: null, target: 'target' }] },
    });
    const postAttacker = testUnit('t.post', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 }, {
      hooks: { onHit: [{ type: 'shield', amount: 1000, duration: null, target: 'target' }] },
    });
    const rules = rulesWithUnits([preAttacker, postAttacker, dummy()], { maxSeconds: 1, mitigationConstant: 100 });
    const [lp, rp] = duel('t.pre', 't.dummy');
    const pre = hits(fight(lp, rp, 1, rules), 1)[0]!;
    expect(pre.absorbed).toBeCloseTo(100, 9);
    expect(pre.amount).toBe(0);
    const [lq, rq] = duel('t.post', 't.dummy');
    const post = hits(fight(lq, rq, 1, rules), 1)[0]!;
    expect(post.absorbed).toBe(0);
    expect(post.amount).toBeCloseTo(100, 9);
  });

  it('a timed hp modifier scales current hp proportionally instead of healing on every cycle', () => {
    // QA bug 2: "add the delta on grant, clamp on expiry" made a repeated +hp modifier a net heal.
    const victim = testUnit('t.victim', { hp: 1000, attack: 0, attackSpeed: 0.0001, armor: 0, range: 1 }, {
      hooks: { onTakeDamage: [{ type: 'statMod', stat: 'hp', mode: 'mul', value: 1, duration: 0.2, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 8 });
    const [l, r] = duel('t.attacker', 't.victim');
    const res = fight(l, r, 1, rulesWithUnits([attacker, victim], { maxSeconds: 20, mitigationConstant: 100 }));
    expect(res.winner).toBe('left');
    expect(res.reason).toBe('elimination');
    expect(hits(res, 1).length).toBeLessThanOrEqual(11);
  });

  it('a modifier that drives max hp to 0 kills the unit instead of leaving it alive at 0 hp', () => {
    // QA bug 3: a -100% hp modifier left a 0/0 hp unit standing and counted as a survivor.
    const zero = testUnit('t.zero', { hp: 1000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'statMod', stat: 'hp', mode: 'mul', value: -1, duration: null, target: 'self' }] },
    });
    const [l, r] = duel('t.zero', 't.dummy', [3, 7], [3, 4]);
    const res = fight(l, r, 1, rulesWithUnits([zero, dummy()], { maxSeconds: 1 }));
    expect(eventsOfType(res, 'death').some((e) => e.uid === 1)).toBe(true);
    expect(res.survivors.left).toEqual([]);
    expect(res.winner).toBe('right');
  });

  it('a projectile that outlives its owner still resolves, credited to the dead owner', () => {
    const bolt: ProjectileDef = { id: 't.slow', speed: 1, effects: [{ type: 'damage', kind: 'true', amount: 40, target: 'target' }] };
    const shooter = testUnit('t.shooter', { hp: 10, attack: 0, attackSpeed: 0.0001, range: 8, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      ability: { name: 'Slow bolt', effects: [{ type: 'spawnProjectile', ref: 't.slow', target: 'target' }] },
    });
    const bruiser = testUnit('t.bruiser', { hp: 100000, attack: 1000, attackSpeed: 1, range: 8 });
    // The shooter sits closest to the enemy (so it is the bruiser's target and gets uid 1); a
    // tanky ally behind it keeps the fight alive past its death so the bolt gets to land.
    const [l, r] = duel('t.shooter', 't.bruiser', [3, 5], [3, 4]);
    l.push({ defId: 't.dummy', star: 1, col: 2, row: 7 });
    const res = fight(l, r, 1, rulesWithUnits([shooter, bruiser, dummy()], { maxSeconds: 6 }, [bolt]));
    const death = eventsOfType(res, 'death').find((e) => e.uid === 1);
    expect(death).toBeDefined();
    const hit = eventsOfType(res, 'projectileHit');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.tick).toBeGreaterThan(death!.tick);
    expect(res.ledger.find((e) => e.uid === 1)?.dealt).toBeCloseTo(40, 9);
  });

  it('aura: an armor bonus is really gone once the ally leaves the radius', () => {
    // The runner walks out of a +1000 armor aura; the same attack that grazed it inside the
    // radius lands in full outside it, and the removal shows up as a statModEnd event.
    const auraWarden = testUnit('t.aurawarden', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8 }, {
      aura: { range: 1, effects: [{ type: 'statMod', stat: 'armor', mode: 'flat', value: 1000, duration: null, target: 'allies' }] },
    });
    const walker = testUnit('t.walker', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const shooter2 = testUnit('t.shooter2', { hp: 100000, attack: 110, attackSpeed: 1, range: 8 });
    const left: BoardUnit[] = [
      { defId: 't.aurawarden', star: 1, col: 0, row: 7 },
      { defId: 't.walker', star: 1, col: 1, row: 7 },
    ];
    const right: BoardUnit[] = [{ defId: 't.shooter2', star: 1, col: 3, row: 4 }];
    const res = fight(left, right, 1, rulesWithUnits([auraWarden, walker, shooter2], { maxSeconds: 8, mitigationConstant: 100 }));
    const ends = eventsOfType(res, 'statModEnd').filter((e) => e.uid === 2 && e.source.startsWith('aura:'));
    expect(ends).toHaveLength(1);
    const onWalker = res.events.filter((e): e is Extract<FightEvent, { type: 'hit' }> => e.type === 'hit' && e.target === 2);
    const inside = onWalker.filter((h) => h.tick < ends[0]!.tick);
    const outside = onWalker.filter((h) => h.tick >= ends[0]!.tick);
    expect(inside.length).toBeGreaterThan(0);
    expect(outside.length).toBeGreaterThan(0);
    expect(inside[0]!.amount).toBeCloseTo(10, 9); // 110 * 100 / (100 + 1000)
    expect(outside[0]!.amount).toBeCloseTo(110, 9);
  });

  it('aura: a unit that leaves the radius loses the tag', () => {
    // The ally is pulled away by its own target: it starts in range and walks out.
    // range 8 keeps the warden standing still (its target is always "in range"), so only the
    // runner moves and the aura radius is the only thing that changes.
    const warden = testUnit('t.warden', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8 }, {
      aura: { range: 1, effects: [{ type: 'applyTag', tag: 'aura.on', duration: null, target: 'allies' }] },
    });
    const runner = testUnit('t.runner', { hp: 100000, attack: 1, attackSpeed: 1, range: 1 });
    const left: BoardUnit[] = [
      { defId: 't.warden', star: 1, col: 0, row: 7 },
      { defId: 't.runner', star: 1, col: 1, row: 7 },
    ];
    const right: BoardUnit[] = [{ defId: 't.dummy', star: 1, col: 6, row: 4 }];
    const res = fight(left, right, 1, rulesWithUnits([warden, runner, dummy()], { maxSeconds: 6 }));
    const tags = eventsOfType(res, 'tag').filter((e) => e.tag === 'aura.on' && e.source.startsWith('aura:'));
    const runnerTags = tags.filter((e) => e.uid === 2);
    expect(runnerTags[0]).toMatchObject({ tick: 0, active: true });
    expect(runnerTags.some((e) => !e.active)).toBe(true);
  });
});

describe('damage pipeline', () => {
  it('walks preMitigation -> mitigation -> shield -> post and the ledger matches the hit events', () => {
    // 100 physical into 100 armor => 50 after mitigation; a 30 shield absorbs 30 of it.
    const target = testUnit('t.target', { hp: 100000, attack: 0, armor: 100, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'shield', amount: 30, duration: null, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 100, attackSpeed: 1, range: 1 });
    const [l, r] = duel('t.attacker', 't.target');
    const res = fight(l, r, 1, rulesWithUnits([attacker, target], { maxSeconds: 2, mitigationConstant: 100 }));
    const first = hits(res, 1)[0]!;
    expect(first.raw).toBeCloseTo(100, 9);
    expect(first.mitigated).toBeCloseTo(50, 9);
    expect(first.absorbed).toBeCloseTo(30, 9);
    expect(first.amount).toBeCloseTo(20, 9);
    expect(first.raw - first.mitigated - first.absorbed).toBeCloseTo(first.amount, 9);

    // Ledger totals equal the sum of the hit events (P0-03 relies on this).
    for (const entry of res.ledger) {
      const dealt = res.events
        .filter((e): e is Extract<FightEvent, { type: 'hit' }> => e.type === 'hit' && e.uid === entry.uid && e.target !== entry.uid)
        .reduce((s, e) => s + e.amount, 0);
      const taken = res.events
        .filter((e): e is Extract<FightEvent, { type: 'hit' }> => e.type === 'hit' && e.target === entry.uid)
        .reduce((s, e) => s + e.amount, 0);
      expect(entry.dealt).toBeCloseTo(dealt, 6);
      expect(entry.taken).toBeCloseTo(taken, 6);
    }
  });

  it('true damage skips mitigation and shields still absorb it', () => {
    const target = testUnit('t.target', { hp: 100000, attack: 0, armor: 1000, magicResist: 1000, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'shield', amount: 25, duration: null, target: 'self' }] },
    });
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1, maxMana: ONE_SHOT_MANA, startMana: ONE_SHOT_MANA }, {
      ability: { name: 'True', effects: [{ type: 'damage', kind: 'true', amount: 100, target: 'target' }] },
    });
    const [l, r] = duel('t.attacker', 't.target');
    const res = fight(l, r, 1, rulesWithUnits([attacker, target], { maxSeconds: 1 }));
    const h = hits(res, 1).find((e) => e.cause === 'ability:t.attacker')!;
    expect(h.mitigated).toBe(0);
    expect(h.absorbed).toBeCloseTo(25, 9);
    expect(h.amount).toBeCloseTo(75, 9);
  });

  it('kills and deaths are counted once per unit', () => {
    const attacker = testUnit('t.attacker', { hp: 100000, attack: 1000, attackSpeed: 1, range: 1 });
    const glass = testUnit('t.glass', { hp: 10, attack: 0, range: 1 });
    const [l, r] = duel('t.attacker', 't.glass');
    const res = fight(l, r, 1, rulesWithUnits([attacker, glass], { maxSeconds: 2 }));
    expect(res.ledger.find((e) => e.uid === 1)?.kills).toBe(1);
    expect(res.ledger.find((e) => e.uid === 2)?.deaths).toBe(1);
    expect(res.ledger.find((e) => e.uid === 1)?.deaths).toBe(0);
  });
});

describe('effect schema rejections', () => {
  it('rejects unknown effect names, unknown tags shapes and bad aura effects', () => {
    expect(EffectSchema.safeParse({ type: 'teleport', target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'shield', amount: -5, duration: 1, target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'applyTag', tag: 'BAD TAG', duration: 1, target: 'self' }).success).toBe(false);
    expect(EffectSchema.safeParse({ type: 'spawnProjectile', target: 'target' }).success).toBe(false);
    // Aura effects must be continuous state with duration null.
    expect(AuraEffectSchema.safeParse({ type: 'statMod', stat: 'armor', mode: 'flat', value: 1, duration: 2, target: 'allies' }).success).toBe(false);
    expect(AuraEffectSchema.safeParse({ type: 'statMod', stat: 'armor', mode: 'flat', value: 1, duration: null, target: 'allies' }).success).toBe(true);
    expect(AuraEffectSchema.safeParse({ type: 'damage', kind: 'true', amount: 1, target: 'enemies' }).success).toBe(false);
  });

  it('the damage pipeline stages are the documented order', () => {
    expect([...DAMAGE_STAGES]).toEqual(['preMitigation', 'mitigation', 'shield', 'post']);
  });

  it('rejects a spawnProjectile whose ref does not exist', () => {
    const raw = structuredClone(rawDevContent());
    const units = (raw.units as { units: Record<string, unknown>[] }).units;
    (units[0] as Record<string, unknown>)['ability'] = { name: 'Bad', effects: [{ type: 'spawnProjectile', ref: 'nope', target: 'target' }] };
    expect(() => loadContent(raw)).toThrow(/unknown projectile ref nope/);
  });

  it('rejects duplicate projectile ids and projectile spawn cycles', () => {
    const withProjectiles = (list: unknown[]): RawContentFiles => {
      const raw = structuredClone(rawDevContent());
      (raw.units as { projectiles: unknown[] }).projectiles = list;
      return raw;
    };
    const bolt = { id: 'dev.bolt', speed: 8, effects: [{ type: 'damage', kind: 'true', amount: 1, target: 'target' }] };
    expect(() => loadContent(withProjectiles([bolt, { ...bolt }]))).toThrow(/duplicate projectile id/);
    expect(() =>
      loadContent(withProjectiles([bolt, { id: 'p.self', speed: 1, effects: [{ type: 'spawnProjectile', ref: 'p.self', target: 'target' }] }])),
    ).toThrow(/spawn cycle/);
    // QA bug 1: a 2-cycle used to load and made the fight spawn projectiles without bound.
    expect(() =>
      loadContent(
        withProjectiles([
          bolt,
          { id: 'p.a', speed: 1, effects: [{ type: 'spawnProjectile', ref: 'p.b', target: 'target' }] },
          { id: 'p.b', speed: 1, effects: [{ type: 'spawnProjectile', ref: 'p.a', target: 'target' }] },
        ]),
      ),
    ).toThrow(/spawn cycle/);
  });

  it('the dev content really runs every effect type, every trigger and an aura', () => {
    // A string grep would pass on content that can never be instantiated: spawn every dev unit
    // on both sides and require the resulting events to name every hook, effect and the aura.
    const content = devContent();
    const board: BoardUnit[] = content.units.map((u, i) => ({ defId: u.id, star: 1, col: i % content.board.cols, row: 4 + Math.floor(i / content.board.cols) }));
    const res = fight(board, board, 1, fightRulesFrom(content));
    const sources = new Set<string>();
    const types = new Set<string>();
    for (const e of res.events) {
      types.add(e.type);
      if ('cause' in e) sources.add(e.cause);
      if ('source' in e) sources.add(e.source);
    }
    for (const h of HOOK_NAMES) {
      expect([...sources].some((c) => c.startsWith(`hook:${h}:`)), `hook ${h} never fired in a dev fight`).toBe(true);
    }
    expect([...sources].some((c) => c.startsWith('aura:')), 'no aura applied in a dev fight').toBe(true);
    expect([...sources].some((c) => c.startsWith('projectile:')), 'no projectile resolved in a dev fight').toBe(true);
    // Every effect type leaves its own event kind behind.
    const eventForEffect: Record<(typeof EFFECT_TYPES)[number], string> = {
      damage: 'hit',
      heal: 'heal',
      shield: 'shield',
      statMod: 'statMod',
      stun: 'stun',
      applyTag: 'tag',
      spawnProjectile: 'projectile',
    };
    for (const t of EFFECT_TYPES) expect(types.has(eventForEffect[t]), `effect ${t} never ran in a dev fight`).toBe(true);
  });
});
