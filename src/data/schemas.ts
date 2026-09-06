// zod schemas for every /data file. Unknown keys and unknown effect names are rejected.
// Traits, items and augments arrive with SPEC.md: add their schemas here (see EXTENSION POINTS).
import { z } from 'zod';
import { DAMAGE_KINDS, HOOK_NAMES, TARGET_SELS } from '../sim/effects.ts';
import type { AuraDef, AuraEffect, Effect, Hooks, ProjectileDef } from '../sim/effects.ts';
import type { BoardConfig } from '../sim/hex.ts';
import type { Encounter, Rules } from '../sim/rules.ts';
import type { SandboxRuleOverrides, SandboxUnit } from '../sim/sandbox.ts';
import { STAT_KIND, STAT_MAX, STAT_NAMES } from '../sim/stats.ts';
import type { StatBlock } from '../sim/stats.ts';
import type { BoardUnit, UnitDef } from '../sim/units.ts';

const provisional = z.string().optional();
const nonNeg = z.number().finite().nonnegative();
const posInt = z.number().int().positive();
const nonNegInt = z.number().int().nonnegative();
/** Magnitude cap for authored stat values; computed stats saturate at the same bound. */
const statNonNeg = nonNeg.max(STAT_MAX);
const statSigned = z.number().finite().min(-STAT_MAX).max(STAT_MAX);

export const StatNameSchema = z.enum(STAT_NAMES);

export const StatBlockSchema = z.strictObject({
  hp: z.number().finite().positive().max(STAT_MAX),
  attack: statNonNeg,
  attackSpeed: statNonNeg,
  armor: statSigned,
  magicResist: statSigned,
  range: z.number().int().min(1).max(STAT_MAX),
  maxMana: nonNegInt.max(STAT_MAX),
  startMana: nonNegInt.max(STAT_MAX),
  abilityPower: statNonNeg,
}) satisfies z.ZodType<StatBlock>;

const ScalingSchema = z.strictObject({ stat: StatNameSchema, factor: statSigned });
const TargetSchema = z.enum(TARGET_SELS);

const duration = z.number().finite().positive();
/** Tag names share the unit-id shape so data stays greppable. */
const tagName = z.string().regex(/^[a-z0-9_.-]+$/);

const StatModSchema = z
  .strictObject({
    type: z.literal('statMod'),
    stat: StatNameSchema,
    mode: z.enum(['mul', 'flat']),
    value: statSigned,
    duration: duration.nullable(),
    target: TargetSchema,
  })
  .refine((e) => !(e.mode === 'mul' && STAT_KIND[e.stat] === 'flat'), {
    message: 'mul modifier on a flat-kind stat',
    path: ['mode'],
  });

const ApplyTagSchema = z.strictObject({ type: z.literal('applyTag'), tag: tagName, duration: duration.nullable(), target: TargetSchema });

export const EffectSchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('damage'), kind: z.enum(DAMAGE_KINDS), amount: statSigned, scaling: ScalingSchema.optional(), target: TargetSchema }),
    z.strictObject({ type: z.literal('heal'), amount: statSigned, scaling: ScalingSchema.optional(), target: TargetSchema }),
    z.strictObject({ type: z.literal('shield'), amount: statNonNeg, scaling: ScalingSchema.optional(), duration: duration.nullable(), target: TargetSchema }),
    StatModSchema,
    z.strictObject({ type: z.literal('stun'), duration, target: TargetSchema }),
    ApplyTagSchema,
    z.strictObject({ type: z.literal('spawnProjectile'), ref: z.string().regex(/^[a-z0-9_.-]+$/), target: TargetSchema }),
  ])
  .describe('Effect') satisfies z.ZodType<Effect>;

/**
 * Aura effects are continuous state only (statMod / applyTag) and must be permanent
 * (`duration: null`): the aura itself is what starts and ends them, per-tick.
 */
export const AuraEffectSchema = z
  .discriminatedUnion('type', [StatModSchema, ApplyTagSchema])
  .refine((e) => e.duration === null, { message: 'aura effects must have duration null (the aura controls them)', path: ['duration'] }) satisfies z.ZodType<AuraEffect>;

export const AuraSchema = z.strictObject({
  range: z.number().int().min(0).max(64),
  effects: z.array(AuraEffectSchema).min(1),
}) satisfies z.ZodType<AuraDef>;

export const ProjectileDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_.-]+$/),
  /** Hexes per second. */
  speed: z.number().finite().positive().max(1000),
  effects: z.array(EffectSchema).min(1),
}) satisfies z.ZodType<ProjectileDef>;

const hookShape = Object.fromEntries(HOOK_NAMES.map((h) => [h, z.array(EffectSchema).optional()])) as Record<(typeof HOOK_NAMES)[number], z.ZodOptional<z.ZodArray<typeof EffectSchema>>>;
export const HooksSchema = z.strictObject(hookShape) satisfies z.ZodType<Hooks>;

export const UnitDefSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_.-]+$/),
  name: z.string().min(1),
  cost: posInt,
  attackType: z.enum(['melee', 'ranged']),
  tags: z.array(z.string()),
  stats: z.array(StatBlockSchema).min(1),
  ability: z.strictObject({ name: z.string().min(1), effects: z.array(EffectSchema) }).nullable(),
  hooks: HooksSchema,
  aura: AuraSchema.nullable().default(null),
  // EXTENSION POINTS (SPEC): traits: z.array(TraitId), itemSlots, ...
}) satisfies z.ZodType<UnitDef>;

export const UnitsFileSchema = z.strictObject({
  _provisional: provisional,
  units: z.array(UnitDefSchema),
  /** Projectile registry referenced by `spawnProjectile` effects. */
  projectiles: z.array(ProjectileDefSchema).default([]),
});

export const BoardConfigSchema = z
  .strictObject({
    cols: posInt,
    rows: posInt.refine((r) => r % 2 === 0, { message: 'rows must be even (mirror symmetry)' }),
    playerRows: posInt,
    layout: z.literal('odd-r'),
  })
  .refine((b) => b.playerRows * 2 <= b.rows, { message: 'playerRows must be at most half the rows', path: ['playerRows'] }) satisfies z.ZodType<BoardConfig>;

export const BoardUnitSchema = z.strictObject({
  defId: z.string(),
  star: posInt,
  col: nonNegInt,
  row: nonNegInt,
}) satisfies z.ZodType<BoardUnit>;

export const BoardFileSchema = z.strictObject({
  _provisional: provisional,
  units: z.array(BoardUnitSchema),
});

export const EncounterSchema = z.strictObject({
  id: z.string().min(1),
  round: posInt,
  reward: z.strictObject({ gold: nonNegInt }),
  board: z.array(BoardUnitSchema),
  // EXTENSION POINTS (SPEC): loot tables, augment offers, encounter modifiers.
}) satisfies z.ZodType<Encounter>;

export const EncountersFileSchema = z.strictObject({
  _provisional: provisional,
  encounters: z.array(EncounterSchema).min(1),
});

/** Direct per-stat overrides for a sandbox unit; each field keeps StatBlockSchema's own bound. */
export const StatOverridesSchema = StatBlockSchema.partial() satisfies z.ZodType<Partial<StatBlock>>;

export const SandboxUnitSchema = z.strictObject({
  defId: z.string(),
  star: posInt,
  col: nonNegInt,
  row: nonNegInt,
  items: z.array(z.string()).default([]),
  statOverrides: StatOverridesSchema.default({}),
}) satisfies z.ZodType<SandboxUnit>;

export const SandboxRuleOverridesSchema = z.strictObject({
  maxSeconds: z.number().finite().positive().optional(),
  overtime: z.boolean().optional(),
}) satisfies z.ZodType<SandboxRuleOverrides>;

export const SandboxSetupFileSchema = z.strictObject({
  _provisional: provisional,
  left: z.array(SandboxUnitSchema),
  right: z.array(SandboxUnitSchema),
  rules: SandboxRuleOverridesSchema.default({}),
});

const oddsRow = z.array(nonNeg).min(1).refine((a) => Math.abs(a.reduce((s, v) => s + v, 0) - 100) < 1e-9, { message: 'shop odds must sum to 100' });

export const RulesSchema = z
  .strictObject({
    _provisional: provisional,
    version: posInt,
    tickRate: posInt,
    combat: z.strictObject({
      maxSeconds: z.number().finite().positive(),
      moveSecondsPerHex: z.number().finite().positive(),
      manaOnAttack: nonNeg,
      manaOnHitTaken: nonNeg,
      mitigationConstant: z.number().finite().positive(),
      minAttackSpeed: z.number().finite().positive(),
      maxAttackSpeed: z.number().finite().positive(),
      drawCountsAsLoss: z.boolean(),
      maxHookDepth: posInt.max(64),
    }),
    economy: z.strictObject({
      startGold: nonNegInt,
      startHp: posInt,
      startLevel: posInt,
      startXp: nonNegInt,
      shopSlots: posInt,
      benchSlots: posInt,
      rerollCost: nonNegInt,
      xpCost: nonNegInt,
      xpPerBuy: posInt,
      xpPerRound: nonNegInt,
      maxLevel: posInt,
      xpToLevel: z.array(nonNegInt).min(1),
      baseIncome: nonNegInt,
      winBonus: nonNegInt,
      interest: z.strictObject({ per: posInt, max: nonNegInt }),
      sellRefund: nonNeg,
      maxStar: posInt,
      mergeCopies: z.number().int().min(2),
      poolSize: z.record(z.string().regex(/^[1-9][0-9]*$/), nonNegInt),
      shopOdds: z.record(z.string().regex(/^[1-9][0-9]*$/), oddsRow),
    }),
    hpLoss: z.strictObject({
      byRound: z.array(nonNegInt).min(1),
      perSurvivingUnit: nonNegInt,
    }),
  })
  .superRefine((r, ctx) => {
    const e = r.economy;
    if (e.startLevel > e.maxLevel) ctx.addIssue({ code: 'custom', message: 'startLevel > maxLevel', path: ['economy', 'startLevel'] });
    if (e.xpToLevel.length < e.maxLevel) ctx.addIssue({ code: 'custom', message: 'xpToLevel must have an entry per level up to maxLevel', path: ['economy', 'xpToLevel'] });
    for (let lvl = 1; lvl <= e.maxLevel; lvl++) {
      if (!e.shopOdds[String(lvl)]) ctx.addIssue({ code: 'custom', message: `shopOdds missing level ${lvl}`, path: ['economy', 'shopOdds'] });
    }
    if (r.combat.minAttackSpeed > r.combat.maxAttackSpeed) ctx.addIssue({ code: 'custom', message: 'minAttackSpeed > maxAttackSpeed', path: ['combat'] });
  }) satisfies z.ZodType<Rules>;

export type UnitsFile = z.infer<typeof UnitsFileSchema>;
export type EncountersFile = z.infer<typeof EncountersFileSchema>;
export type BoardFile = z.infer<typeof BoardFileSchema>;
export type RulesFile = z.infer<typeof RulesSchema>;

/** Logical data files and the schema that validates each. */
export const FILE_SCHEMAS = {
  board: BoardConfigSchema,
  rules: RulesSchema,
  units: UnitsFileSchema,
  encounters: EncountersFileSchema,
  boardFile: BoardFileSchema,
  sandboxSetupFile: SandboxSetupFileSchema,
} as const;

export type DataFileKind = keyof typeof FILE_SCHEMAS;
