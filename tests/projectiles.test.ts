// Attack types, projectile travel and the geometric target shapes (P0-02).
import { describe, expect, it } from 'vitest';
import { loadContent } from '../src/data/loader.ts';
import { TargetShapeSchema } from '../src/data/schemas.ts';
import type { ProjectileDef } from '../src/sim/effects.ts';
import { fight, type FightEvent, type FightResult } from '../src/sim/fight.ts';
import { hashValue } from '../src/sim/hash.ts';
import { hexDistance, hexLine, mirrorCell } from '../src/sim/hex.ts';
import { fightRulesFrom } from '../src/sim/rules.ts';
import type { BoardUnit } from '../src/sim/units.ts';
import { buildTimeline, projectilePosition } from '../src/render/timeline.ts';
import { devBoard, devContent, rawDevContent, rulesWithUnits, testUnit } from './helpers.ts';

const board = devContent().board;

function eventsOfType<T extends FightEvent['type']>(r: FightResult, type: T): Extract<FightEvent, { type: T }>[] {
  return r.events.filter((e): e is Extract<FightEvent, { type: T }> => e.type === type);
}

function hits(r: FightResult): Extract<FightEvent, { type: 'hit' }>[] {
  return r.events.filter((e): e is Extract<FightEvent, { type: 'hit' }> => e.type === 'hit');
}

const arrow: ProjectileDef = {
  id: 't.arrow',
  speed: 6,
  effects: [{ type: 'damage', kind: 'physical', amount: 0, scaling: { stat: 'attack', factor: 1 }, target: 'target' }],
};

describe('attack types', () => {
  it('a melee attack lands on the tick it is thrown', () => {
    const melee = testUnit('t.melee', { hp: 100000, attack: 50, attackSpeed: 1, range: 1 });
    const dummy = testUnit('t.dummy', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const r = fight(
      [{ defId: 't.melee', star: 1, col: 3, row: 4 }],
      [{ defId: 't.dummy', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([melee, dummy], { maxSeconds: 1, mitigationConstant: 100 }, [arrow]),
    );
    expect(eventsOfType(r, 'projectile')).toHaveLength(0);
    const attackTick = eventsOfType(r, 'attack')[0]!.tick;
    expect(hits(r)[0]!.tick).toBe(attackTick);
  });

  it('a ranged attack flies: the hit lands distance/speed seconds later, on the predicted tick', () => {
    const shooter = testUnit('t.shooter', { hp: 100000, attack: 50, attackSpeed: 1, range: 8 }, { attackType: 'ranged', attackProjectile: 't.arrow' });
    const dummy = testUnit('t.dummy', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const from = { col: 3, row: 7 };
    const r = fight(
      [{ defId: 't.shooter', star: 1, col: from.col, row: from.row }],
      [{ defId: 't.dummy', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([shooter, dummy], { maxSeconds: 2, mitigationConstant: 100 }, [arrow]),
    );
    const spawn = eventsOfType(r, 'projectile')[0]!;
    const distance = hexDistance(from, { col: 3, row: 3 });
    const travel = Math.max(1, Math.round((distance / arrow.speed) * 30));
    expect(spawn.tick).toBe(0);
    expect(spawn.arrivalTick).toBe(travel);
    expect(spawn.from).toEqual(from);
    expect(spawn.to).toEqual({ col: 3, row: 3 });
    const hit = hits(r)[0]!;
    expect(hit.tick).toBe(travel);
    expect(hit.amount).toBeCloseTo(50, 9);
    expect(hit.cause).toBe('attack');
  });

  it("a ranged attack's onHit fires on impact, not when the shot is fired", () => {
    // The onHit hook tags the shooter; the tag event must sit on the impact tick.
    const shooter = testUnit('t.shooter', { hp: 100000, attack: 50, attackSpeed: 1, range: 8 }, {
      attackType: 'ranged',
      attackProjectile: 't.arrow',
      hooks: { onHit: [{ type: 'applyTag', tag: 'followed.through', duration: null, target: 'self' }] },
    });
    const dummy = testUnit('t.dummy', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });
    const r = fight(
      [{ defId: 't.shooter', star: 1, col: 3, row: 7 }],
      [{ defId: 't.dummy', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([shooter, dummy], { maxSeconds: 2 }, [arrow]),
    );
    const impact = eventsOfType(r, 'projectileHit')[0]!;
    const tagged = eventsOfType(r, 'tag').filter((e) => e.tag === 'followed.through' && e.active);
    expect(impact.tick).toBeGreaterThan(0);
    expect(tagged[0]!.tick).toBe(impact.tick);
  });

  it('a shot whose target dies in flight fizzles; one whose shooter dies still lands', () => {
    const slow: ProjectileDef = { id: 't.slow', speed: 1, effects: [{ type: 'damage', kind: 'true', amount: 40, target: 'target' }] };
    const shooter = testUnit('t.shooter', { hp: 20, attack: 40, attackSpeed: 1, range: 8 }, {
      attackType: 'ranged',
      attackProjectile: 't.slow',
      hooks: { onHit: [{ type: 'applyTag', tag: 'followed.through', duration: null, target: 'self' }] },
    });
    const glass = testUnit('t.glass', { hp: 1, attack: 0, attackSpeed: 0.0001, range: 1 });
    const bruiser = testUnit('t.bruiser', { hp: 100000, attack: 1000, attackSpeed: 1, range: 8 });
    const tank = testUnit('t.tank', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 });

    // The glass target dies to something else while the shot is in the air. The shooter takes
    // the lower cell so it holds the lower uid and therefore fires before the bruiser strikes.
    const dead = fight(
      [
        { defId: 't.shooter', star: 1, col: 2, row: 5 },
        { defId: 't.bruiser', star: 1, col: 3, row: 5 },
      ],
      [
        { defId: 't.glass', star: 1, col: 3, row: 4 },
        { defId: 't.tank', star: 1, col: 5, row: 4 },
      ],
      1,
      rulesWithUnits([shooter, glass, bruiser, tank], { maxSeconds: 4 }, [slow]),
    );
    expect(eventsOfType(dead, 'projectileFizzle').length).toBeGreaterThan(0);

    // The shooter dies while its own shot is in the air: the damage still lands, credited to it.
    // The shooter stands opposite the bruiser (so it is what the bruiser kills) with a tank
    // far behind it to keep the fight running past its death.
    const orphan = fight(
      [
        { defId: 't.shooter', star: 1, col: 3, row: 5 },
        { defId: 't.tank', star: 1, col: 0, row: 7 },
      ],
      [{ defId: 't.bruiser', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([shooter, tank, bruiser], { maxSeconds: 4 }, [slow]),
    );
    const shooterDied = eventsOfType(orphan, 'death').find((e) => e.uid === 1);
    const impact = eventsOfType(orphan, 'projectileHit')[0];
    expect(shooterDied).toBeDefined();
    expect(impact).toBeDefined();
    expect(impact!.tick).toBeGreaterThan(shooterDied!.tick);
    expect(orphan.ledger.find((l) => l.uid === 1)?.dealt).toBeGreaterThan(0);
    // The payload lands, but a corpse follows through on nothing: no onHit from a dead shooter.
    expect(eventsOfType(orphan, 'tag')).toHaveLength(0);
  });

  it('a shot still in the air when the fight ends fizzles, and leaves the last frame empty', () => {
    const crawling: ProjectileDef = { id: 't.crawl', speed: 0.01, effects: [{ type: 'damage', kind: 'true', amount: 40, target: 'target' }] };
    const shooter = testUnit('t.shooter', { hp: 100000, attack: 10, attackSpeed: 1, range: 8 }, { attackType: 'ranged', attackProjectile: 't.crawl' });
    const dummy = testUnit('t.dummy', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8 });
    const r = fight(
      [{ defId: 't.shooter', star: 1, col: 3, row: 7 }],
      [{ defId: 't.dummy', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([shooter, dummy], { maxSeconds: 1 }, [crawling]),
    );
    const spawned = eventsOfType(r, 'projectile');
    expect(spawned.length).toBeGreaterThan(0);
    expect(spawned[0]!.arrivalTick).toBeGreaterThan(r.ticks);
    expect(eventsOfType(r, 'projectileHit')).toHaveLength(0);
    // Every unfinished shot is accounted for, and none is left hanging in the last frame.
    expect(eventsOfType(r, 'projectileFizzle')).toHaveLength(spawned.length);
    const tl = buildTimeline(r, 15);
    expect(tl.shots[tl.shots.length - 1]).toEqual([]);
  });

  it('only ranged units may carry an attack projectile', () => {
    const raw = structuredClone(rawDevContent());
    const units = (raw.units as { units: Record<string, unknown>[] }).units;
    const melee = units.find((u) => u['attackType'] === 'melee')!;
    melee['attackProjectile'] = 'dev.arrow';
    expect(() => loadContent(raw)).toThrow(/only a ranged unit can have an attackProjectile/);
    melee['attackProjectile'] = 'nope';
    expect(() => loadContent(raw)).toThrow(/unknown attackProjectile nope/);
  });
});

describe('target shapes', () => {
  // A mana pool that attacking can never refill: exactly one cast, at tick 0, before anyone
  // has moved, so the geometry under test is the geometry the boards were authored with.
  const caster = (target: unknown) =>
    testUnit('t.caster', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8, maxMana: 100000, startMana: 100000 }, {
      ability: { name: 'Shape', effects: [{ type: 'damage', kind: 'true', amount: 10, target: target as never }] },
    });
  // range 8 keeps the dummies still: their target is always "in range", so the geometry at
  // cast time is the geometry the board was authored with, whichever side the caster is on.
  const dummy = testUnit('t.dummy', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 8 });

  /** uids of the enemies the caster's one cast damaged. */
  function struck(target: unknown, enemies: BoardUnit[]): number[] {
    const left: BoardUnit[] = [{ defId: 't.caster', star: 1, col: 3, row: 7 }];
    const r = fight(left, enemies, 1, rulesWithUnits([caster(target), dummy], { maxSeconds: 1 }));
    return [...new Set(hits(r).filter((h) => h.cause === 'ability:t.caster').map((h) => h.target))].sort((a, b) => a - b);
  }

  /** Distance from the caster's cell to an authored enemy cell, after mirroring. */
  const distanceTo = (b: BoardUnit): number => hexDistance({ col: 3, row: 7 }, mirrorCell({ col: b.col, row: b.row }, board));

  // Authored right-side cells mirror through the board centre: (c,r) -> (cols-1-c, rows-1-r).
  const enemyAt = (col: number, row: number): BoardUnit => ({ defId: 't.dummy', star: 1, col, row });

  it('radius hits everything within the radius of the anchor and nothing outside it', () => {
    // Mirrored: (3,4)->(3,3), (0,4)->(6,3), (3,7)->(3,0).
    const enemies = [enemyAt(3, 4), enemyAt(0, 4), enemyAt(3, 7)];
    // Distances from the caster after mirroring: 4, 5 and 7 hexes.
    expect(enemies.map(distanceTo)).toEqual([4, 5, 7]);
    for (const radius of [0, 3, 4, 5, 6, 8]) {
      const expected = enemies.filter((e) => distanceTo(e) <= radius).length;
      expect(struck({ shape: 'radius', radius, from: 'self', team: 'enemies' }, enemies), `radius ${radius}`).toHaveLength(expected);
    }
  });

  it('nearest picks exactly k, closest first, ties by uid', () => {
    const enemies = [enemyAt(3, 4), enemyAt(0, 4), enemyAt(3, 7)];
    expect(struck({ shape: 'nearest', k: 1, from: 'self', team: 'enemies' }, enemies)).toHaveLength(1);
    expect(struck({ shape: 'nearest', k: 2, from: 'self', team: 'enemies' }, enemies)).toHaveLength(2);
    // k beyond the number of enemies is not an error, it just takes everyone.
    expect(struck({ shape: 'nearest', k: 9, from: 'self', team: 'enemies' }, enemies)).toHaveLength(3);
  });

  it('line hits exactly the units standing on its hexes, including past the target', () => {
    // The caster at (3,7) targets its nearest enemy, and the line runs through that enemy: so
    // pick an adjacent cell, take the three-hex line through it, and stand a dummy on each.
    const casterCell = { col: 3, row: 7 };
    const adjacent = hexLine(casterCell, { col: 3, row: 3 }, 1, board)[0]!;
    const cells = hexLine(casterCell, adjacent, 3, board);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toEqual(adjacent);
    // Authored cells are mirrored into place, so author the mirror of each line cell.
    const onLine = cells.map((c) => {
      const m = mirrorCell(c, board);
      return enemyAt(m.col, m.row);
    });
    const hitAll = struck({ shape: 'line', length: 3, from: 'self', team: 'enemies' }, onLine);
    expect(hitAll).toHaveLength(3);
    // A shorter line reaches fewer of them, and a length of 1 only the first.
    expect(struck({ shape: 'line', length: 1, from: 'self', team: 'enemies' }, onLine)).toHaveLength(1);
    expect(struck({ shape: 'line', length: 2, from: 'self', team: 'enemies' }, onLine)).toHaveLength(2);
    // A unit standing off the line is never struck.
    const offLine = [...onLine, enemyAt(0, 4)];
    expect(struck({ shape: 'line', length: 3, from: 'self', team: 'enemies' }, offLine)).toHaveLength(3);
  });

  it('a line is mirror-symmetric: the same board mirrored strikes the mirrored units', () => {
    // The rounding tie-break is not symmetric under point reflection, so team 1 walks the line
    // on mirrored coordinates. This checks the property that matters: the selection.
    const casterCell = { col: 3, row: 7 };
    const adjacent = hexLine(casterCell, { col: 3, row: 3 }, 1, board)[0]!;
    const cells = hexLine(casterCell, adjacent, 3, board);
    const authored = cells.map((c) => {
      const m = mirrorCell(c, board);
      return enemyAt(m.col, m.row);
    });
    const shape = { shape: 'line', length: 3, from: 'self', team: 'enemies' } as const;
    const left: BoardUnit[] = [{ defId: 't.caster', star: 1, col: casterCell.col, row: casterCell.row }];
    const rules = rulesWithUnits([caster(shape), dummy], { maxSeconds: 1 });
    // Team 0 casting at team 1, then the same board with the sides swapped.
    const asLeft = fight(left, authored, 1, rules);
    const asRight = fight(authored, left, 1, rules);
    const struckLeft = hits(asLeft).filter((h) => h.cause === 'ability:t.caster').length;
    const struckRight = hits(asRight).filter((h) => h.cause === 'ability:t.caster').length;
    expect(struckLeft).toBe(3);
    expect(struckRight).toBe(3);
  });

  it("the dev knight's cleave really hits more than one unit", () => {
    // The dev set must demonstrate a multi-target line, not just carry one in JSON. The knight
    // is the shipped definition; the targets are stationary dummies standing on its line.
    const content = devContent();
    const knight = content.unitsById['dev.knight']!;
    expect(knight.ability!.effects.some((e) => typeof e.target === 'object'), 'dev.knight no longer casts a shape').toBe(true);
    const casterCell = { col: 3, row: 7 };
    const target = hexLine(casterCell, { col: 3, row: 3 }, 1, board)[0]!;
    const cells = hexLine(casterCell, target, 3, board);
    const enemies: BoardUnit[] = cells.map((c) => {
      const m = mirrorCell(c, board);
      return { defId: 't.dummy', star: 1, col: m.col, row: m.row };
    });
    const r = fight(
      [{ defId: 'dev.knight', star: 3, col: casterCell.col, row: casterCell.row }],
      enemies,
      1,
      rulesWithUnits([knight, dummy], { maxSeconds: 30 }),
    );
    const cleaved = hits(r).filter((h) => h.cause === 'ability:dev.knight');
    const perCast = new Map<number, number>();
    for (const h of cleaved) perCast.set(h.tick, (perCast.get(h.tick) ?? 0) + 1);
    expect(perCast.size, 'the knight never cast').toBeGreaterThan(0);
    expect(Math.max(...perCast.values()), 'no cleave hit more than one unit').toBe(3);
  });

  it('a shape anchored on a missing contextual target selects nobody', () => {
    // `from: 'target'` with an onCombatStart hook: there is no contextual unit yet.
    const u = testUnit('t.lonely', { hp: 100000, attack: 0, attackSpeed: 0.0001, range: 1 }, {
      hooks: { onCombatStart: [{ type: 'damage', kind: 'true', amount: 10, target: { shape: 'radius', radius: 8, from: 'target', team: 'enemies' } }] },
    });
    const r = fight(
      [{ defId: 't.lonely', star: 1, col: 3, row: 7 }],
      [{ defId: 't.dummy', star: 1, col: 3, row: 4 }],
      1,
      rulesWithUnits([u, dummy], { maxSeconds: 1 }),
    );
    expect(hits(r).filter((h) => h.cause.startsWith('hook:onCombatStart'))).toHaveLength(0);
  });

  it('the schema accepts the three shapes and rejects anything else', () => {
    expect(TargetShapeSchema.safeParse({ shape: 'radius', radius: 2, from: 'self', team: 'enemies' }).success).toBe(true);
    expect(TargetShapeSchema.safeParse({ shape: 'line', length: 3, from: 'target', team: 'all' }).success).toBe(true);
    expect(TargetShapeSchema.safeParse({ shape: 'nearest', k: 2, from: 'self', team: 'allies' }).success).toBe(true);
    expect(TargetShapeSchema.safeParse({ shape: 'cone', angle: 60, from: 'self', team: 'enemies' }).success).toBe(false);
    expect(TargetShapeSchema.safeParse({ shape: 'radius', radius: -1, from: 'self', team: 'enemies' }).success).toBe(false);
    expect(TargetShapeSchema.safeParse({ shape: 'line', length: 3, from: 'nowhere', team: 'enemies' }).success).toBe(false);
    expect(TargetShapeSchema.safeParse({ shape: 'nearest', k: 1, from: 'self', team: 'enemies', extra: 1 }).success).toBe(false);
  });
});

describe('hexLine', () => {
  it('walks one hex at a time, passes through the target and keeps going', () => {
    const from = { col: 0, row: 0 };
    const to = { col: 2, row: 0 };
    const line = hexLine(from, to, 5, board);
    expect(line).toEqual([
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
      { col: 4, row: 0 },
      { col: 5, row: 0 },
    ]);
    // Every step is one hex, no cell repeats, and the target is on the line.
    let prev = from;
    const seen = new Set<string>();
    for (const c of line) {
      expect(hexDistance(prev, c)).toBe(1);
      const key = `${c.col},${c.row}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
      prev = c;
    }
    expect(seen.has(`${to.col},${to.row}`)).toBe(true);
    // An adjacent target does not truncate the line: a melee sweep still covers `length` hexes.
    expect(hexLine({ col: 3, row: 7 }, { col: 3, row: 6 }, 3, board)).toHaveLength(3);
  });

  it('is straight: every pair of cells on it is exactly its index distance apart', () => {
    // A shortest path is not enough - the line must not drift sideways. This is the property
    // a greedy walk failed: it stayed a geodesic while wandering off the segment.
    for (let fromIdx = 0; fromIdx < board.cols * board.rows; fromIdx++) {
      for (const toIdx of [0, 13, 27, 41, board.cols * board.rows - 1]) {
        if (fromIdx === toIdx) continue;
        const a = { col: fromIdx % board.cols, row: Math.floor(fromIdx / board.cols) };
        const b = { col: toIdx % board.cols, row: Math.floor(toIdx / board.cols) };
        const cells = [a, ...hexLine(a, b, 8, board)];
        for (let i = 0; i < cells.length; i++) {
          for (let j = i + 1; j < cells.length; j++) {
            expect(hexDistance(cells[i]!, cells[j]!), `${a.col},${a.row} -> ${b.col},${b.row} [${i}..${j}]`).toBe(j - i);
          }
        }
      }
    }
  });

  it('passes through the target when the target is within its length', () => {
    for (let fromIdx = 0; fromIdx < board.cols * board.rows; fromIdx++) {
      for (const toIdx of [0, 13, 27, 41, board.cols * board.rows - 1]) {
        if (fromIdx === toIdx) continue;
        const a = { col: fromIdx % board.cols, row: Math.floor(fromIdx / board.cols) };
        const b = { col: toIdx % board.cols, row: Math.floor(toIdx / board.cols) };
        const cells = hexLine(a, b, 12, board);
        if (hexDistance(a, b) > 12) continue;
        expect(cells.some((c) => c.col === b.col && c.row === b.row), `${a.col},${a.row} -> ${b.col},${b.row}`).toBe(true);
      }
    }
  });

  it('is bounded by its length and by the board, and is empty for a zero-length line', () => {
    expect(hexLine({ col: 0, row: 0 }, { col: 5, row: 0 }, 2, board)).toHaveLength(2);
    expect(hexLine({ col: 0, row: 0 }, { col: 5, row: 0 }, 0, board)).toEqual([]);
    expect(hexLine({ col: 0, row: 0 }, { col: 0, row: 0 }, 5, board)).toEqual([]);
    for (const c of hexLine({ col: 0, row: 0 }, { col: 6, row: 7 }, 64, board)) {
      expect(c.col).toBeGreaterThanOrEqual(0);
      expect(c.col).toBeLessThan(board.cols);
      expect(c.row).toBeGreaterThanOrEqual(0);
      expect(c.row).toBeLessThan(board.rows);
    }
  });
});

describe('rendering a fight with projectiles changes nothing', () => {
  it('the timeline reproduces the shots and leaves the result and its hash intact', () => {
    const content = devContent();
    const rules = fightRulesFrom(content);
    const r1 = fight(devBoard('c'), devBoard('b'), 7, rules);
    const before = hashValue(r1);
    const moveTicks = Math.round(content.rules.combat.moveSecondsPerHex * content.rules.tickRate);
    const tl = buildTimeline(r1, moveTicks);
    expect(hashValue(r1)).toBe(before);
    expect(fight(devBoard('c'), devBoard('b'), 7, rules).hash).toBe(r1.hash);
    expect(tl.shots.length).toBe(tl.frames.length);

    const spawned = r1.events.filter((e) => e.type === 'projectile');
    expect(spawned.length).toBeGreaterThan(0);
    // A shot appears in every frame between its spawn and its arrival, and nowhere else.
    for (const e of spawned) {
      if (e.type !== 'projectile') continue;
      const inFlight = tl.shots.findIndex((s) => s.some((p) => p.spawnTick === e.tick && p.target === e.target && p.uid === e.uid));
      expect(inFlight, `no frame carries the shot spawned at ${e.tick}`).toBeGreaterThanOrEqual(0);
      for (let t = 0; t < tl.shots.length; t++) {
        const present = (tl.shots[t] ?? []).some((p) => p.spawnTick === e.tick && p.uid === e.uid && p.target === e.target);
        expect(present, `frame ${t} for the shot spawned at ${e.tick}`).toBe(t >= e.tick && t < e.arrivalTick);
      }
    }
    // Interpolation runs from the shooter's cell to the target's, and stays inside them.
    const shot = tl.shots.flat()[0]!;
    expect(projectilePosition(shot, shot.spawnTick)).toEqual({ col: shot.from.col, row: shot.from.row });
    expect(projectilePosition(shot, shot.arrivalTick)).toEqual({ col: shot.to.col, row: shot.to.row });
    const mid = projectilePosition(shot, (shot.spawnTick + shot.arrivalTick) / 2);
    expect(mid.row).toBeGreaterThanOrEqual(Math.min(shot.from.row, shot.to.row));
    expect(mid.row).toBeLessThanOrEqual(Math.max(shot.from.row, shot.to.row));
  });
});
