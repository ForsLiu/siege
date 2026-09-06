// Unit inspector model (P0-19): a pure read-only view over a unit's data + current stats.
// Selection lives in the app layer (e.g. RunController.selectedUid), never in sim state, and
// this function never mutates its `state` argument — it only reads RunState and content.
import type { Effect, Scaling, TargetSel } from '../sim/effects.ts';
import { findUnit, type RunState } from '../sim/run.ts';
import type { Content } from '../sim/rules.ts';
import { computeStat, STAT_NAMES, type Modifier, type StatName } from '../sim/stats.ts';
import { baseStats } from '../sim/units.ts';

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
  uid: number;
  defId: string;
  name: string;
  /** Shop cost; also the pool tier (units.ts: `UnitDef.cost`). */
  cost: number;
  star: number;
  /** Always empty until P0-25 (trait system) lands; see QUESTIONS.md P0-19-01. */
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

export function inspectorModel(state: RunState, uid: number, content: Content, combat: CombatOverlay | null = null): InspectorModel | null {
  const found = findUnit(state, uid);
  if (!found) return null;
  const unit = found.unit;
  const def = content.unitsById[unit.defId];
  if (!def) return null;

  const base = baseStats(def, unit.star);
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
    uid: unit.uid,
    defId: def.id,
    name: def.name,
    cost: def.cost,
    star: unit.star,
    traits: [],
    ability: def.ability ? { name: def.ability.name, text: def.ability.effects.map((e) => describeEffect(e, statOf)).join('; ') } : null,
    stats,
    // Copied, not aliased: RunState.items is a live mutable array, and this model is a read-only
    // view (code review on P0-19: a naive `.push`/`.sort` by a future consumer would otherwise
    // corrupt sim state outside the Command path with no test able to catch it).
    items: [...unit.items],
    mana: combat ? { current: combat.mana, max: combat.maxMana } : { current: Math.min(maxMana, startMana), max: maxMana },
    combat: combat ? { hp: combat.hp, maxHp: combat.maxHp, shields: combat.shields } : null,
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

/** Renders one effect as text with its numbers resolved against `statOf` (the unit's current stats). */
function describeEffect(e: Effect, statOf: (s: StatName) => number): string {
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
