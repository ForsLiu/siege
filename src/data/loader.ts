// Validates raw JSON with the zod schemas, cross-checks files against each other,
// and builds the Content object with its content hash.
import type { Effect, ProjectileDef } from '../sim/effects.ts';
import { canonicalJson } from '../sim/hash.ts';
import { inBounds, isPlayerCell, type BoardConfig } from '../sim/hex.ts';
import type { Content, Encounter, Rules } from '../sim/rules.ts';
import type { BoardUnit, UnitDef } from '../sim/units.ts';
import { sha256Hex } from './sha256.ts';
import { BoardConfigSchema, BoardFileSchema, EncountersFileSchema, FILE_SCHEMAS, RulesSchema, UnitsFileSchema, type DataFileKind } from './schemas.ts';

export interface RawContentFiles {
  board: unknown;
  rules: unknown;
  units: unknown;
  encounters: unknown;
}

export class ContentError extends Error {
  /** Plain field, not a constructor parameter property: the sweep worker loads this module
   *  under Node's strip-only type stripping, which rejects non-erasable syntax (P0-B1). */
  readonly file: string;

  constructor(file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = 'ContentError';
    this.file = file;
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function validateFile<K extends DataFileKind>(kind: K, raw: unknown): ValidationResult<ReturnType<(typeof FILE_SCHEMAS)[K]['parse']>> {
  const schema = FILE_SCHEMAS[kind];
  const res = schema.safeParse(raw);
  if (res.success) return { ok: true, value: res.data as ReturnType<(typeof FILE_SCHEMAS)[K]['parse']> };
  return { ok: false, error: formatIssues(res.error.issues) };
}

function formatIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((i) => `${i.path.map(String).join('.') || '<root>'}: ${i.message}`).join('; ');
}

function parseOrThrow<T>(file: string, schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } } }, raw: unknown): T {
  const res = schema.safeParse(raw);
  if (!res.success) throw new ContentError(file, formatIssues(res.error?.issues ?? []));
  return res.data as T;
}

/** sha-256 over the canonical concatenation of every content file (sorted by name). */
export function computeContentHash(files: Record<string, unknown>): string {
  const names = Object.keys(files).sort();
  let acc = '';
  for (const n of names) acc += `${n}\n${canonicalJson(files[n])}\n`;
  return sha256Hex(acc);
}

export function checkBoardUnits(file: string, units: readonly BoardUnit[], board: BoardConfig, unitsById: Record<string, UnitDef>, maxStar: number): void {
  const seen = new Set<string>();
  for (const u of units) {
    const def = unitsById[u.defId];
    if (!def) throw new ContentError(file, `unknown unit ${u.defId}`);
    if (u.star > maxStar || u.star > def.stats.length) throw new ContentError(file, `${u.defId} star ${u.star} exceeds available stat blocks`);
    if (!inBounds(u, board) || !isPlayerCell(u, board)) throw new ContentError(file, `${u.defId} at ${u.col},${u.row} is outside the owner half`);
    const key = `${u.col},${u.row}`;
    if (seen.has(key)) throw new ContentError(file, `cell ${key} used twice`);
    seen.add(key);
  }
}

export function loadContent(raw: RawContentFiles): Content {
  const board = parseOrThrow<BoardConfig>('board', BoardConfigSchema, raw.board);
  const rules = parseOrThrow<Rules>('rules', RulesSchema, raw.rules);
  const unitsFile = parseOrThrow<{ units: UnitDef[]; projectiles: ProjectileDef[] }>('units', UnitsFileSchema, raw.units);
  const encFile = parseOrThrow<{ encounters: Encounter[] }>('encounters', EncountersFileSchema, raw.encounters);

  const tierKeys = Object.keys(rules.economy.poolSize)
    .map((k) => Number.parseInt(k, 10))
    .sort((a, b) => a - b);
  tierKeys.forEach((k, i) => {
    if (k !== i + 1) throw new ContentError('rules', `poolSize keys must be the contiguous cost tiers 1..n (found ${tierKeys.join(',')})`);
  });
  const tiers = tierKeys.length;
  for (const [lvl, row] of Object.entries(rules.economy.shopOdds)) {
    if (row.length !== tiers) throw new ContentError('rules', `shopOdds[${lvl}] has ${row.length} tiers, poolSize defines ${tiers}`);
  }
  for (let lvl = 1; lvl < rules.economy.maxLevel; lvl++) {
    if (!((rules.economy.xpToLevel[lvl] ?? 0) > 0)) throw new ContentError('rules', `xpToLevel[${lvl}] must be positive (free level-ups otherwise)`);
  }

  const units = [...unitsFile.units].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const unitsById: Record<string, UnitDef> = {};
  for (const u of units) {
    if (unitsById[u.id]) throw new ContentError('units', `duplicate unit id ${u.id}`);
    if (u.stats.length !== rules.economy.maxStar) throw new ContentError('units', `${u.id}: expected ${rules.economy.maxStar} stat blocks, got ${u.stats.length}`);
    if (rules.economy.poolSize[String(u.cost)] === undefined) throw new ContentError('units', `${u.id}: cost ${u.cost} has no poolSize entry`);
    unitsById[u.id] = u;
  }

  const projectiles = [...unitsFile.projectiles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const projectilesById: Record<string, ProjectileDef> = {};
  for (const p of projectiles) {
    if (projectilesById[p.id]) throw new ContentError('units', `duplicate projectile id ${p.id}`);
    projectilesById[p.id] = p;
  }
  // Every spawnProjectile ref must resolve, and a projectile may not spawn itself (no loops).
  for (const u of units) {
    for (const ref of projectileRefs(unitEffects(u))) {
      if (!projectilesById[ref]) throw new ContentError('units', `${u.id}: unknown projectile ref ${ref}`);
    }
  }
  for (const p of projectiles) {
    for (const ref of projectileRefs(p.effects)) {
      if (!projectilesById[ref]) throw new ContentError('units', `projectile ${p.id}: unknown projectile ref ${ref}`);
    }
  }
  // A projectile chain must terminate: reject any cycle, not just direct self-reference.
  for (const p of projectiles) {
    const seen = new Set<string>([p.id]);
    const stack = projectileRefs(p.effects);
    while (stack.length > 0) {
      const ref = stack.pop() as string;
      if (ref === p.id) throw new ContentError('units', `projectile ${p.id} is part of a spawn cycle`);
      if (seen.has(ref)) continue;
      seen.add(ref);
      stack.push(...projectileRefs((projectilesById[ref] as ProjectileDef).effects));
    }
  }

  const encounters = [...encFile.encounters].sort((a, b) => a.round - b.round);
  encounters.forEach((e, i) => {
    if (e.round !== i + 1) throw new ContentError('encounters', `rounds must be 1..n without gaps (found ${e.round} at index ${i})`);
    checkBoardUnits(`encounters[${e.id}]`, e.board, board, unitsById, rules.economy.maxStar);
  });

  const contentHash = computeContentHash({ board: raw.board, rules: raw.rules, units: raw.units, encounters: raw.encounters });
  return { board, rules, units, unitsById, projectiles, projectilesById, encounters, contentHash };
}

/** Every effect a unit can run: its ability, all its hooks and its aura. */
function unitEffects(u: UnitDef): Effect[] {
  const out: Effect[] = [...(u.ability?.effects ?? [])];
  for (const key of Object.keys(u.hooks).sort()) {
    const list = (u.hooks as Record<string, Effect[] | undefined>)[key];
    if (list) out.push(...list);
  }
  if (u.aura) out.push(...u.aura.effects);
  return out;
}

function projectileRefs(effects: readonly Effect[]): string[] {
  return effects.filter((e): e is Extract<Effect, { type: 'spawnProjectile' }> => e.type === 'spawnProjectile').map((e) => e.ref);
}

export function loadBoardFile(file: string, raw: unknown, content: Content): BoardUnit[] {
  const parsed = parseOrThrow<{ units: BoardUnit[] }>(file, BoardFileSchema, raw);
  checkBoardUnits(file, parsed.units, content.board, content.unitsById, content.rules.economy.maxStar);
  return parsed.units;
}
