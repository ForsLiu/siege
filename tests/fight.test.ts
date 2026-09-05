import { describe, expect, it } from 'vitest';
import { fight, type FightEvent } from '../src/sim/fight.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import type { BoardUnit } from '../src/sim/units.ts';
import { devBoard, devContent, rulesWithUnits, testUnit } from './helpers.ts';

describe('fight', () => {
  const content = devContent();
  const rules = fightRulesFrom(content);

  it('mirrored non-lethal boards run to the timeout and draw', () => {
    // mirror.json (guardian + healer) out-heals its own damage, so this exercises the timeout path.
    const m = devBoard('mirror');
    const r = fight(m, m, 1, rules);
    expect(r.winner).toBe('draw');
    expect(r.reason).toBe('timeout');
    expect(r.ticks).toBe(Math.round(content.rules.combat.maxSeconds * content.rules.tickRate));
    expect(r.events[r.events.length - 1]).toEqual({ tick: r.ticks, type: 'end', winner: 'draw', reason: 'timeout' });
  });

  // TODO(P0-03): units resolve sequentially in uid order (left side first), so a lethal board
  // against its own mirror is not guaranteed to draw. QUESTIONS.md BOOT-16 records the decision;
  // P0-03 either adopts two-phase simultaneous resolution or rules the first-strike asymmetry in.
  it.skip('mirrored lethal boards draw (requires simultaneous resolution, P0-03)', () => {
    const e10 = content.encounters[content.encounters.length - 1]!.board;
    for (const seed of [1, 2, 3]) expect(fight(e10, e10, seed, rules).winner).toBe('draw');
  });

  it('a 1v1 with known stats ends on the predicted tick', () => {
    // attacker: 10 dmg per hit vs 0 armor, 1 attack/s => one hit every 30 ticks starting at tick 0.
    // target: 100 hp, deals 0 damage. Ten hits => last hit at tick 270, fight ends at tick 271.
    const attacker = testUnit('t.attacker', { hp: 1000, attack: 10, attackSpeed: 1, range: 1 });
    const dummy = testUnit('t.dummy', { hp: 100, attack: 0, attackSpeed: 1, range: 1 });
    const fr = rulesWithUnits([attacker, dummy]);
    const left: BoardUnit[] = [{ defId: 't.attacker', star: 1, col: 3, row: 4 }];
    // Authored (3,4) on the right side mirrors to (3,3), adjacent to (3,4).
    const right: BoardUnit[] = [{ defId: 't.dummy', star: 1, col: 3, row: 4 }];
    const r = fight(left, right, 1, fr);
    expect(r.winner).toBe('left');
    expect(r.reason).toBe('elimination');
    expect(r.ticks).toBe(271);
    const hits = r.events.filter((e) => e.type === 'hit' && e.uid === 1);
    expect(hits).toHaveLength(10);
    expect(hits.map((e) => e.tick)).toEqual([0, 30, 60, 90, 120, 150, 180, 210, 240, 270]);
    const death = r.events.find((e) => e.type === 'death');
    expect(death?.tick).toBe(270);
    expect(r.ledger.find((l) => l.uid === 1)?.dealt).toBeCloseTo(100, 6);
    expect(r.ledger.find((l) => l.uid === 2)?.taken).toBeCloseTo(100, 6);
  });

  it('armor mitigates physical damage by K / (K + armor)', () => {
    const attacker = testUnit('t.attacker', { hp: 1000, attack: 100, attackSpeed: 1, range: 1 });
    const tank = testUnit('t.tank', { hp: 10000, attack: 0, armor: 100, range: 1 });
    const fr = rulesWithUnits([attacker, tank], { maxSeconds: 1 });
    const r = fight([{ defId: 't.attacker', star: 1, col: 3, row: 4 }], [{ defId: 't.tank', star: 1, col: 3, row: 4 }], 1, fr);
    const hit = r.events.find((e) => e.type === 'hit' && e.uid === 1);
    expect(hit && hit.type === 'hit' ? hit.amount : NaN).toBeCloseTo(50, 9);
  });

  it('targeting tie-break is stable: equidistant enemies resolve to the lower uid', () => {
    const shooter = testUnit('t.shooter', { hp: 1000, attack: 10, attackSpeed: 1, range: 4 });
    const dummy = testUnit('t.dummy', { hp: 100, attack: 0 });
    const fr = rulesWithUnits([shooter, dummy], { maxSeconds: 2 });
    const left: BoardUnit[] = [{ defId: 't.shooter', star: 1, col: 3, row: 4 }];
    // Neighbours of (3,4) (even row): (4,4),(3,3),(2,3),(2,4),(2,5),(3,5).
    // Authored (3,4) mirrors to (3,3) and authored (4,4) mirrors to (2,3): both at distance 1 -> tie.
    const right: BoardUnit[] = [
      { defId: 't.dummy', star: 1, col: 3, row: 4 },
      { defId: 't.dummy', star: 1, col: 4, row: 4 },
    ];
    const r1 = fight(left, right, 1, fr);
    const r2 = fight(left, [...right].reverse(), 99, fr);
    const first1 = r1.events.find((e) => e.type === 'attack');
    const first2 = r2.events.find((e) => e.type === 'attack');
    expect(first1 && first1.type === 'attack' ? first1.target : -1).toBe(2);
    expect(first2 && first2.type === 'attack' ? first2.target : -1).toBe(2);
    expect(r1.hash).toBe(r2.hash);
  });

  it('the same seed twice produces identical event logs; result is independent of input order', () => {
    const a = devBoard('a');
    const b = devBoard('b');
    const r1 = fight(a, b, 5, rules);
    const r2 = fight(a, b, 5, rules);
    expect(r1.events).toEqual(r2.events);
    expect(r1.hash).toBe(r2.hash);
    const r3 = fight([...a].reverse(), [...b].reverse(), 5, rules);
    expect(r3.hash).toBe(r1.hash);
  });

  it('melee units move toward their target and emit move events; ranged units attack from range', () => {
    const melee = testUnit('t.melee', { hp: 1000, attack: 10, attackSpeed: 1, range: 1 });
    const archer = testUnit('t.archer', { hp: 100, attack: 5, attackSpeed: 1, range: 7 });
    const fr = rulesWithUnits([melee, archer], { maxSeconds: 5 });
    // Melee at (3,7); archer authored (3,7) mirrors to (3,0): distance 7 = archer range, so it never moves.
    const r = fight([{ defId: 't.melee', star: 1, col: 3, row: 7 }], [{ defId: 't.archer', star: 1, col: 3, row: 7 }], 1, fr);
    const moves = r.events.filter((e) => e.type === 'move');
    expect(moves.length).toBe(6);
    for (const m of moves) expect(m.uid).toBe(1);
    const moveTicks = Math.round(content.rules.combat.moveSecondsPerHex * content.rules.tickRate);
    expect((moves[0] as FightEvent).tick).toBe(0);
    expect((moves[1] as FightEvent).tick - (moves[0] as FightEvent).tick).toBe(moveTicks);
    const firstArcherAttack = r.events.find((e) => e.type === 'attack' && e.uid === 2);
    expect(firstArcherAttack?.tick).toBe(0);
    const firstMeleeAttack = r.events.find((e) => e.type === 'attack' && e.uid === 1);
    // Sixth move happens at tick 5 * moveTicks; the attack follows on the next tick.
    expect(firstMeleeAttack?.tick).toBe(moveTicks * 5 + 1);
  });

  it('abilities cast at full mana through the interpreter, hooks fire, stun skips turns', () => {
    const caster = testUnit(
      't.caster',
      { hp: 1000, attack: 10, attackSpeed: 1, range: 1, maxMana: 20, startMana: 20 },
      {
        ability: {
          name: 'Zap',
          effects: [
            { type: 'damage', kind: 'magic', amount: 40, scaling: { stat: 'abilityPower', factor: 0.5 }, target: 'target' },
            { type: 'stun', duration: 1, target: 'target' },
            { type: 'statMod', stat: 'attack', mode: 'mul', value: 1, duration: 1, target: 'self' },
          ],
        },
        hooks: { onCast: [{ type: 'heal', amount: 5, target: 'self' }] },
      },
    );
    const dummy = testUnit('t.dummy', { hp: 200, attack: 1, attackSpeed: 1, range: 1 });
    const fr = rulesWithUnits([caster, dummy], { maxSeconds: 5, manaOnAttack: 0, manaOnHitTaken: 0 });
    const r = fight([{ defId: 't.caster', star: 1, col: 3, row: 4 }], [{ defId: 't.dummy', star: 1, col: 3, row: 4 }], 1, fr);
    const cast = r.events.find((e) => e.type === 'cast');
    expect(cast?.tick).toBe(0);
    const hit = r.events.find((e) => e.type === 'hit' && e.cause === 'ability:t.caster');
    expect(hit && hit.type === 'hit' ? hit.amount : NaN).toBeCloseTo(40, 9); // abilityPower 0 in test stats
    expect(r.events.some((e) => e.type === 'stun' && e.uid === 2)).toBe(true);
    expect(r.events.some((e) => e.type === 'statMod' && e.uid === 1 && e.stat === 'attack')).toBe(true);
    const castHeal = r.events.find((e) => e.type === 'heal' && e.cause === 'hook:onCast:t.caster');
    expect(castHeal && castHeal.type === 'heal' ? castHeal.amount : NaN).toBe(0); // full hp: heal is 0 but still emitted
    // Dummy is stunned for 30 ticks from tick 0: its first attack lands at tick 30.
    const dummyAttack = r.events.find((e) => e.type === 'attack' && e.uid === 2);
    expect(dummyAttack?.tick).toBe(30);
    // The caster's attack was doubled by the statMod for 30 ticks: tick-0 hit deals 20, tick-30 hit (mod expired) deals 10.
    const casterHits = r.events.filter((e) => e.type === 'hit' && e.uid === 1 && e.cause === 'attack');
    expect(casterHits[0] && casterHits[0].type === 'hit' ? casterHits[0].amount : NaN).toBeCloseTo(20, 9);
    expect(casterHits[1] && casterHits[1].type === 'hit' ? casterHits[1].amount : NaN).toBeCloseTo(10, 9);
  });

  it('onDeath / onKill hooks fire and the ledger matches hit events', () => {
    const bomber = testUnit('t.bomber', { hp: 50, attack: 0 }, { hooks: { onDeath: [{ type: 'damage', kind: 'true', amount: 30, target: 'enemies' }] } });
    const killer = testUnit('t.killer', { hp: 100, attack: 50, attackSpeed: 1 }, { hooks: { onKill: [{ type: 'heal', amount: 100, target: 'self' }] } });
    const fr = rulesWithUnits([bomber, killer], { maxSeconds: 2 });
    const r = fight([{ defId: 't.killer', star: 1, col: 3, row: 4 }], [{ defId: 't.bomber', star: 1, col: 3, row: 4 }], 1, fr);
    expect(r.winner).toBe('left');
    const deathDamage = r.events.find((e) => e.type === 'hit' && e.cause === 'hook:onDeath:t.bomber');
    expect(deathDamage && deathDamage.type === 'hit' ? deathDamage.amount : NaN).toBe(30);
    const heal = r.events.find((e) => e.type === 'heal' && e.cause === 'hook:onKill:t.killer');
    expect(heal).toBeDefined();
    for (const l of r.ledger) {
      const dealt = r.events.filter((e) => e.type === 'hit' && e.uid === l.uid).reduce((s, e) => s + (e.type === 'hit' ? e.amount : 0), 0);
      const taken = r.events.filter((e) => e.type === 'hit' && e.target === l.uid).reduce((s, e) => s + (e.type === 'hit' ? e.amount : 0), 0);
      expect(l.dealt).toBeCloseTo(dealt, 9);
      expect(l.taken).toBeCloseTo(taken, 9);
    }
  });

  it('empty sides resolve immediately', () => {
    const r = fight([], devBoard('a'), 1, rules);
    expect(r.winner).toBe('right');
    expect(r.ticks).toBe(0);
    const d = fight([], [], 1, rules);
    expect(d.winner).toBe('draw');
  });

  it('rejects unknown units and doubled cells', () => {
    expect(() => fight([{ defId: 'nope', star: 1, col: 0, row: 4 }], [], 1, rules)).toThrow(/unknown unit/);
    expect(() => fight([{ defId: 'dev.brawler', star: 1, col: 0, row: 4 }, { defId: 'dev.archer', star: 1, col: 0, row: 4 }], [], 1, rules)).toThrow(/occupied/);
  });
});
