// Stat vocabulary and stacking rules.
//
// Stacking (CLAUDE.md, fixed): modifiers from different sources multiply; ranks (values)
// within one source add; flat modifiers add. `STAT_KIND` classifies every stat:
//   mul  - accepts flat and mul modifiers: (base + sum flat) * prod over sources (1 + sum values)
//   flat - accepts flat modifiers only; a mul modifier on a flat stat is a data error.
// The vocabulary itself is provisional (QUESTIONS.md) until SPEC.md defines the real one.

export const STAT_NAMES = [
  'hp',
  'attack',
  'attackSpeed',
  'armor',
  'magicResist',
  'range',
  'maxMana',
  'startMana',
  'abilityPower',
] as const;

export type StatName = (typeof STAT_NAMES)[number];
export type StatKind = 'mul' | 'flat';
export type ModMode = 'mul' | 'flat';

export const STAT_KIND: Record<StatName, StatKind> = {
  hp: 'mul',
  attack: 'mul',
  attackSpeed: 'mul',
  abilityPower: 'mul',
  armor: 'flat',
  magicResist: 'flat',
  range: 'flat',
  maxMana: 'flat',
  startMana: 'flat',
};

/** Stats that must stay integers after modifiers (hex ranges, mana thresholds). */
export const INTEGER_STATS: ReadonlySet<StatName> = new Set<StatName>(['range', 'maxMana', 'startMana']);

export type StatBlock = Record<StatName, number>;

export function isStatName(s: string): s is StatName {
  return (STAT_NAMES as readonly string[]).includes(s);
}

export interface Modifier {
  /** Stacking source id (e.g. "ability:dev.guardian", "item:x"). Same source => values add. */
  source: string;
  stat: StatName;
  mode: ModMode;
  value: number;
  /** Tick at which the modifier stops applying (exclusive), or null for permanent. */
  expiresTick: number | null;
}

/**
 * Compute a stat from its base and the active modifiers. Deterministic: iterates
 * `mods` in array order, grouping mul modifiers by source in first-seen order.
 */
export function computeStat(base: number, stat: StatName, mods: readonly Modifier[]): number {
  let flat = 0;
  const sources: string[] = [];
  const sums: number[] = [];
  for (const m of mods) {
    if (m.stat !== stat) continue;
    if (m.mode === 'flat') {
      flat += m.value;
      continue;
    }
    if (STAT_KIND[stat] === 'flat') {
      throw new Error(`computeStat: mul modifier on flat stat ${stat} (source ${m.source})`);
    }
    const i = sources.indexOf(m.source);
    if (i === -1) {
      sources.push(m.source);
      sums.push(m.value);
    } else {
      sums[i] = (sums[i] as number) + m.value;
    }
  }
  let v = base + flat;
  for (const s of sums) v *= 1 + s;
  if (INTEGER_STATS.has(stat)) v = Math.round(v);
  if (v < 0) v = 0;
  if (!Number.isFinite(v)) throw new Error(`computeStat: ${stat} is not finite (base ${base}, ${mods.length} modifiers)`);
  return v;
}

export function cloneStatBlock(b: StatBlock): StatBlock {
  return { ...b };
}
