// Unit inspector model (P0-19): a pure read-only view over a unit's data + current stats.
// Selection lives in the app layer (e.g. RunController.selectedUid), never in sim state, and
// this function never mutates its `state` argument — it only reads RunState and content.
import type { Effect, Scaling, TargetSel } from '../sim/effects.ts';
import type { Cell } from '../sim/hex.ts';
import { hexesWithin } from '../sim/hex.ts';
import { findUnit, type RunState } from '../sim/run.ts';
import type { Content } from '../sim/rules.ts';
import { computeStat, STAT_NAMES, type Modifier, type StatBlock, type StatName } from '../sim/stats.ts';
import type { TraitDef } from '../sim/traits.ts';
import { baseStats, type UnitDef } from '../sim/units.ts';

export interface InspectorStat {
  stat: StatName;
  base: number;
  current: number;
  /** Every modifier contributing to this stat; `current` is `computeStat(base, stat, sources)`. */
  sources: Modifier[];
}

export interface InspectorAbility {
  name: string;
  /** Generated from the ability's effects with the unit's current stats filled in. */
  text: string;
}

export interface InspectorTrait {
  id: string;
  text: string;
}

export interface InspectorCombat {
  hp: number;
  maxHp: number;
  shields: number;
}

export interface InspectorModel {
  /** Null for a preview of a unit that is not (yet) an owned unit: a shop offer or a sandbox row. */
  uid: number | null;
  defId: string;
  name: string;
  /** Shop cost; also the pool tier (units.ts: `UnitDef.cost`). */
  cost: number;
  star: number;
  /** The def's own trait ids, name+description text (P0-26); not which breakpoint is active —
   *  see the P0-26 trait panel for board-composition-dependent activation. */
  traits: InspectorTrait[];
  ability: InspectorAbility | null;
  stats: InspectorStat[];
  items: string[];
  mana: { current: number; max: number };
  /** Live combat values, or null outside a fight. */
  combat: InspectorCombat | null;
}

/** Live values a caller reads off a `FightUnit` (or its render `UnitSnapshot`) mid-combat. */
export interface CombatOverlay {
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  shields: number;
  modifiers: readonly Modifier[];
}

function buildModel(uid: number | null, def: UnitDef, star: number, items: readonly string[], combat: CombatOverlay | null, traitsById: Record<string, TraitDef>): InspectorModel {
  const base = baseStats(def, star);
  const modifiers = combat?.modifiers ?? [];
  const statOf = (stat: StatName): number => computeStat(base[stat], stat, modifiers);
  const stats: InspectorStat[] = STAT_NAMES.map((stat) => ({
    stat,
    base: base[stat],
    current: statOf(stat),
    sources: modifiers.filter((m) => m.stat === stat),
  }));

  const maxMana = statOf('maxMana');
  const startMana = statOf('startMana');

  return {
    uid,
    defId: def.id,
    name: def.name,
    cost: def.cost,
    star,
    // The def's own trait membership (static); which breakpoint (if any) is currently active is
    // board-composition-dependent and belongs to the P0-26 trait panel, not one unit's card.
    traits: def.traits.map((id): InspectorTrait => {
      const trait = traitsById[id];
      return { id, text: trait ? `${trait.name}: ${trait.description}` : id };
    }),
    ability: def.ability ? { name: def.ability.name, text: def.ability.effects.map((e) => describeEffect(e, statOf)).join('; ') } : null,
    stats,
    // Copied, not aliased: RunState.items is a live mutable array, and this model is a read-only
    // view (code review on P0-19: a naive `.push`/`.sort` by a future consumer would otherwise
    // corrupt sim state outside the Command path with no test able to catch it).
    items: [...items],
    mana: combat ? { current: combat.mana, max: combat.maxMana } : { current: Math.min(maxMana, startMana), max: maxMana },
    combat: combat ? { hp: combat.hp, maxHp: combat.maxHp, shields: combat.shields } : null,
  };
}

export function inspectorModel(state: RunState, uid: number, content: Content, combat: CombatOverlay | null = null): InspectorModel | null {
  const found = findUnit(state, uid);
  if (!found) return null;
  const unit = found.unit;
  const def = content.unitsById[unit.defId];
  if (!def) return null;
  return buildModel(unit.uid, def, unit.star, unit.items, combat, content.traitsById);
}

/** A tier-1, no-items, planning-phase preview of a shop offer (P0-20): the offer has no `uid`. */
export function shopPreviewModel(defId: string, content: Content): InspectorModel | null {
  const def = content.unitsById[defId];
  if (!def) return null;
  return buildModel(null, def, 1, [], null, content.traitsById);
}

/** A preview of a sandbox row (P0-20): stat overrides are baked into the star's block, the same
 *  way `src/sim/sandbox.ts` builds its synthetic per-instance `UnitDef` for `fight()`. */
export function sandboxPreviewModel(unit: { defId: string; star: number; items: readonly string[]; statOverrides: Partial<StatBlock> }, content: Content): InspectorModel | null {
  const def = content.unitsById[unit.defId];
  if (!def) return null;
  const starIdx = unit.star - 1;
  const block = def.stats[starIdx];
  if (!block) return null;
  const overridden: UnitDef = { ...def, stats: def.stats.map((b, i) => (i === starIdx ? { ...b, ...unit.statOverrides } : b)) };
  return buildModel(null, overridden, unit.star, unit.items, null, content.traitsById);
}

export interface RangeRings {
  /** Attack-range hexes (`hexesWithin(origin, range)`, the unit's current `range` stat). */
  attack: Cell[];
  /** The aura's range, when the unit's def has one; the effect vocabulary has no other
   *  range-bearing ability shape yet (QUESTIONS.md P0-20). */
  ability: Cell[] | null;
}

/** Board highlight for a selected unit at `origin`, from its current stats and def — a pure
 *  function of content and the model, read by the renderer only (never sim state). */
export function rangeRings(model: InspectorModel, content: Content, origin: Cell): RangeRings {
  const def = content.unitsById[model.defId];
  const attackRange = model.stats.find((s) => s.stat === 'range')?.current ?? 0;
  return {
    attack: hexesWithin(origin, attackRange, content.board),
    ability: def?.aura ? hexesWithin(origin, def.aura.range, content.board) : null,
  };
}

function targetText(t: TargetSel): string {
  switch (t) {
    case 'self':
      return 'itself';
    case 'target':
      return 'the target';
    case 'allies':
      return 'all allies';
    case 'enemies':
      return 'all enemies';
    default: {
      const never: never = t;
      throw new Error(`inspectorModel: unknown target ${String(never)}`);
    }
  }
}

function durationText(seconds: number | null): string {
  return seconds === null ? ' for the rest of the fight' : ` for ${seconds}s`;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function resolvedAmount(amount: number, scaling: Scaling | undefined, statOf: (s: StatName) => number): number {
  return scaling ? amount + scaling.factor * statOf(scaling.stat) : amount;
}

/** Renders one effect as text with its numbers resolved against `statOf` (the unit's current
 *  stats). Exported for the P0-26 trait panel, which has no single holder unit to resolve a
 *  breakpoint's `scaling` against — none of today's trait content uses `scaling`, so callers
 *  without a real unit pass a stub (e.g. `() => 0`); see QUESTIONS.md P0-26. */
export function describeEffect(e: Effect, statOf: (s: StatName) => number): string {
  switch (e.type) {
    case 'damage':
      return `Deal ${round1(resolvedAmount(e.amount, e.scaling, statOf))} ${e.kind} damage to ${targetText(e.target)}`;
    case 'heal':
      return `Heal ${targetText(e.target)} for ${round1(resolvedAmount(e.amount, e.scaling, statOf))}`;
    case 'shield':
      return `Shield ${targetText(e.target)} for ${round1(resolvedAmount(e.amount, e.scaling, statOf))}${durationText(e.duration)}`;
    case 'statMod': {
      const sign = e.value >= 0 ? '+' : '';
      const magnitude = e.mode === 'mul' ? `${sign}${Math.round(e.value * 100)}%` : `${sign}${e.value}`;
      return `${magnitude} ${e.stat} to ${targetText(e.target)}${durationText(e.duration)}`;
    }
    case 'stun':
      return `Stun ${targetText(e.target)} for ${e.duration}s`;
    case 'applyTag':
      return `Apply "${e.tag}" to ${targetText(e.target)}${durationText(e.duration)}`;
    case 'spawnProjectile':
      return `Fire ${e.ref} at ${targetText(e.target)}`;
    default: {
      const never: never = e;
      throw new Error(`inspectorModel: unknown effect ${JSON.stringify(never)}`);
    }
  }
}
