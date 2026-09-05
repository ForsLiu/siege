// Shared test helpers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadContent, type RawContentFiles } from '../src/data/loader.ts';
import { DATA_DIR, loadContentFromDisk, readRawContent } from '../src/data/node.ts';
import type { ProjectileDef } from '../src/sim/effects.ts';
import type { Content, FightRules } from '../src/sim/rules.ts';
import type { StatBlock } from '../src/sim/stats.ts';
import type { BoardUnit, UnitDef } from '../src/sim/units.ts';

export function devContent(): Content {
  return loadContentFromDisk();
}

export function rawDevContent(): RawContentFiles {
  return readRawContent();
}

/** Load the dev content with a mutation applied to the raw rules/units before validation. */
export function contentWith(mutate: (raw: RawContentFiles) => void): Content {
  const raw = structuredClone(readRawContent()) as RawContentFiles;
  mutate(raw);
  return loadContent(raw);
}

export function devBoard(name: string): BoardUnit[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'dev', 'boards', `${name}.json`), 'utf8')) as { units: BoardUnit[] };
  return raw.units;
}

export const ZERO_STATS: StatBlock = {
  hp: 100,
  attack: 0,
  attackSpeed: 1,
  armor: 0,
  magicResist: 0,
  range: 1,
  maxMana: 0,
  startMana: 0,
  abilityPower: 0,
};

export function testUnit(id: string, stats: Partial<StatBlock>, extra: Partial<UnitDef> = {}): UnitDef {
  const block: StatBlock = { ...ZERO_STATS, ...stats };
  return {
    id,
    name: id,
    cost: 1,
    attackType: 'melee',
    tags: ['test'],
    stats: [block, block, block],
    ability: null,
    hooks: {},
    aura: null,
    attackProjectile: null,
    ...extra,
  };
}

function projectilesById(list: readonly ProjectileDef[]): Record<string, ProjectileDef> {
  const by: Record<string, ProjectileDef> = {};
  for (const p of list) by[p.id] = p;
  return by;
}

/** Fight rules built from dev content, with a custom unit registry (and optional projectiles). */
export function rulesWithUnits(units: UnitDef[], overrides: Partial<FightRules['combat']> = {}, projectiles?: readonly ProjectileDef[]): FightRules {
  const c = devContent();
  const byId: Record<string, UnitDef> = {};
  for (const u of units) byId[u.id] = u;
  return { tickRate: c.rules.tickRate, combat: { ...c.rules.combat, ...overrides }, board: c.board, units: byId, projectiles: projectilesById(projectiles ?? c.projectiles) };
}
