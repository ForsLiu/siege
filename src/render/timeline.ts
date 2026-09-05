// Pure reconstruction of per-tick fight state from the event log. The renderer interpolates
// between snapshots; the sim is never touched. Building a timeline has no side effects on
// the events (rendering on/off cannot change a hash).
import type { FightEvent, FightResult, Team } from '../sim/fight.ts';
import type { Cell } from '../sim/hex.ts';

export interface UnitSnapshot {
  uid: number;
  defId: string;
  star: number;
  team: Team;
  col: number;
  row: number;
  /** Previous cell for interpolation (equals col/row when not moving). */
  fromCol: number;
  fromRow: number;
  /** Tick at which the current move started (for interpolation). */
  moveTick: number;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  alive: boolean;
  /** Remaining shield absorption (P0-01). */
  shield: number;
  stunnedUntil: number;
  /** Tick of the last hit taken (for hit flashes). */
  lastHitTick: number;
  lastCastTick: number;
  lastAttackTick: number;
}

export interface Timeline {
  ticks: number;
  /** frames[t] = snapshot of every unit after tick t was processed. */
  frames: UnitSnapshot[][];
  winner: FightResult['winner'];
}

export function buildTimeline(result: FightResult, moveTicks: number): Timeline {
  const units = new Map<number, UnitSnapshot>();
  const frames: UnitSnapshot[][] = [];
  const events = result.events;
  let i = 0;
  const snapshot = (): UnitSnapshot[] => [...units.values()].map((u) => ({ ...u }));
  // frames.length === ticks + 1: one frame per processed tick plus the final frame.
  for (let t = 0; t < result.ticks; t++) {
    while (i < events.length && (events[i] as FightEvent).tick <= t) {
      apply(units, events[i] as FightEvent, moveTicks);
      i++;
    }
    frames.push(snapshot());
  }
  while (i < events.length) {
    apply(units, events[i] as FightEvent, moveTicks);
    i++;
  }
  frames.push(snapshot());
  return { ticks: result.ticks, frames, winner: result.winner };
}

function apply(units: Map<number, UnitSnapshot>, e: FightEvent, _moveTicks: number): void {
  switch (e.type) {
    case 'spawn':
      units.set(e.uid, {
        uid: e.uid,
        defId: e.defId,
        star: e.star,
        team: e.team,
        col: e.col,
        row: e.row,
        fromCol: e.col,
        fromRow: e.row,
        moveTick: -1,
        hp: e.hp,
        maxHp: e.maxHp,
        mana: e.mana,
        maxMana: e.maxMana,
        alive: true,
        shield: 0,
        stunnedUntil: 0,
        lastHitTick: -1,
        lastCastTick: -1,
        lastAttackTick: -1,
      });
      return;
    case 'move': {
      const u = units.get(e.uid);
      if (!u) return;
      u.fromCol = e.from.col;
      u.fromRow = e.from.row;
      u.col = e.to.col;
      u.row = e.to.row;
      u.moveTick = e.tick;
      return;
    }
    case 'attack': {
      const u = units.get(e.uid);
      if (u) {
        u.mana = e.manaAfter;
        u.lastAttackTick = e.tick;
      }
      return;
    }
    case 'hit': {
      const t = units.get(e.target);
      if (t) {
        t.hp = e.hpAfter;
        t.mana = e.manaAfter;
        t.lastHitTick = e.tick;
        t.shield = Math.max(0, t.shield - e.absorbed);
      }
      return;
    }
    case 'shield': {
      const t = units.get(e.target);
      if (t) t.shield = e.shieldAfter;
      return;
    }
    case 'tag':
    case 'projectile':
    case 'projectileHit':
    case 'projectileFizzle':
      // No snapshot state yet: P0-02 gives projectiles their own render layer.
      return;
    case 'heal': {
      const t = units.get(e.target);
      if (t) t.hp = e.hpAfter;
      return;
    }
    case 'cast': {
      const u = units.get(e.uid);
      if (u) {
        u.mana = e.manaAfter;
        u.lastCastTick = e.tick;
      }
      return;
    }
    case 'stun': {
      const u = units.get(e.uid);
      if (u) u.stunnedUntil = e.untilTick;
      return;
    }
    case 'death': {
      const u = units.get(e.uid);
      if (u) {
        u.alive = false;
        u.hp = 0;
        u.shield = 0;
      }
      return;
    }
    case 'statMod':
    case 'statModEnd':
      // Stat changes reach the snapshot through the events that carry values (maxHp, hit, heal).
      return;
    case 'maxHp': {
      const u = units.get(e.uid);
      if (u) {
        u.maxHp = e.maxHp;
        u.hp = e.hp;
      }
      return;
    }
    case 'end':
      return;
    default: {
      const never: never = e;
      throw new Error(`timeline: unknown event ${JSON.stringify(never)}`);
    }
  }
}

/** Interpolated cell position for a unit at fractional tick `t` (t in [moveTick, moveTick + moveTicks]). */
export function interpolatedCell(u: UnitSnapshot, t: number, moveTicks: number): { col: number; row: number } {
  if (u.moveTick < 0) return { col: u.col, row: u.row };
  const f = Math.min(1, Math.max(0, (t - u.moveTick) / moveTicks));
  return { col: u.fromCol + (u.col - u.fromCol) * f, row: u.fromRow + (u.row - u.fromRow) * f };
}

export function cellOf(u: UnitSnapshot): Cell {
  return { col: u.col, row: u.row };
}
