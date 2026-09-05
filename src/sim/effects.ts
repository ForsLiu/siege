// Effect vocabulary v1 + interpreter and hook bus (P0-01).
// The interpreter is generic over the unit type: the fight supplies an EffectHost that
// knows how to find targets, apply damage/heals/shields/tags, add modifiers, stun and
// spawn projectiles. Nothing here reads global state; every duration is data in seconds.
import type { ModMode, Modifier, StatName } from './stats.ts';

export type DamageKind = 'physical' | 'magic' | 'true';
export type TargetSel = 'self' | 'target' | 'allies' | 'enemies';

export const DAMAGE_KINDS = ['physical', 'magic', 'true'] as const;
export const TARGET_SELS = ['self', 'target', 'allies', 'enemies'] as const;
export const EFFECT_TYPES = ['damage', 'heal', 'shield', 'statMod', 'stun', 'applyTag', 'spawnProjectile'] as const;
export const HOOK_NAMES = [
  'onCombatStart',
  'onRoundStart',
  'onAttack',
  'onHit',
  'onCast',
  'onKill',
  'onDeath',
  'onTakeDamage',
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/** Ordered stages of the damage pipeline. Every point of damage walks them in this order. */
export const DAMAGE_STAGES = ['preMitigation', 'mitigation', 'shield', 'post'] as const;
export type DamageStage = (typeof DAMAGE_STAGES)[number];

export interface Scaling {
  stat: StatName;
  /** amount += factor * self's stat */
  factor: number;
}

export interface DamageEffect {
  type: 'damage';
  kind: DamageKind;
  amount: number;
  scaling?: Scaling;
  target: TargetSel;
}

export interface HealEffect {
  type: 'heal';
  amount: number;
  scaling?: Scaling;
  target: TargetSel;
}

export interface ShieldEffect {
  type: 'shield';
  amount: number;
  scaling?: Scaling;
  /** Seconds; null = for the rest of the fight. */
  duration: number | null;
  target: TargetSel;
}

export interface StatModEffect {
  type: 'statMod';
  stat: StatName;
  mode: ModMode;
  value: number;
  /** Seconds; null = for the rest of the fight. */
  duration: number | null;
  target: TargetSel;
}

export interface StunEffect {
  type: 'stun';
  /** Seconds. */
  duration: number;
  target: TargetSel;
}

export interface ApplyTagEffect {
  type: 'applyTag';
  tag: string;
  /** Seconds; null = for the rest of the fight. */
  duration: number | null;
  target: TargetSel;
}

export interface SpawnProjectileEffect {
  type: 'spawnProjectile';
  /** Id of a projectile definition in the content's projectile registry. */
  ref: string;
  target: TargetSel;
}

export type Effect = DamageEffect | HealEffect | ShieldEffect | StatModEffect | StunEffect | ApplyTagEffect | SpawnProjectileEffect;

/** Effects an aura may apply. Both are idempotent state, refreshed while a unit is in range. */
export type AuraEffect = StatModEffect | ApplyTagEffect;

/** A passive that applies continuous effects to every unit within `range` hexes. */
export interface AuraDef {
  /** Hex radius, inclusive. */
  range: number;
  effects: AuraEffect[];
}

/** A projectile definition (data): travels at `speed` hexes/second, then applies `effects`. */
export interface ProjectileDef {
  id: string;
  /** Hexes per second. Travel ticks = max(1, round(distance / speed * tickRate)). */
  speed: number;
  effects: Effect[];
}

export type Hooks = Partial<Record<HookName, Effect[]>>;

/** What the interpreter needs from the simulation that runs it. */
export interface EffectHost<U> {
  readonly tick: number;
  readonly tickRate: number;
  getStat(u: U, stat: StatName): number;
  isAlive(u: U): boolean;
  resolveTargets(sel: TargetSel, self: U, other: U | null): U[];
  damage(src: U, tgt: U, kind: DamageKind, amount: number, cause: string): void;
  heal(src: U, tgt: U, amount: number, cause: string): void;
  /** `slot` is the effect's index in its list: with `src` it makes the instance key unique. */
  shield(src: U, tgt: U, amount: number, expiresTick: number | null, source: string, slot: number): void;
  addModifier(tgt: U, mod: Modifier, cause: string): void;
  stun(tgt: U, untilTick: number, cause: string): void;
  applyTag(src: U, tgt: U, tag: string, expiresTick: number | null, source: string, slot: number): void;
  spawnProjectile(src: U, tgt: U, ref: string, source: string): void;
}

export function secondsToTicks(seconds: number, tickRate: number): number {
  return Math.max(1, Math.round(seconds * tickRate));
}

/** Absolute expiry tick for a data duration in seconds; null stays null (rest of the fight). */
export function expiryTick(duration: number | null, tick: number, tickRate: number): number | null {
  return duration === null ? null : tick + secondsToTicks(duration, tickRate);
}

function scaledAmount<U>(host: EffectHost<U>, self: U, amount: number, scaling: Scaling | undefined): number {
  if (!scaling) return amount;
  return amount + scaling.factor * host.getStat(self, scaling.stat);
}

/**
 * Apply `effects` in order. `self` is the unit owning the effect; `other` is the
 * contextual unit (attack target, killer, victim...) that `target: 'target'` resolves to.
 * `source` is the stacking source id for statMods, shields and tags produced here.
 */
export function runEffects<U>(
  host: EffectHost<U>,
  effects: readonly Effect[],
  self: U,
  other: U | null,
  source: string,
): void {
  for (let slot = 0; slot < effects.length; slot++) {
    const e = effects[slot] as Effect;
    const targets = host.resolveTargets(e.target, self, other);
    switch (e.type) {
      case 'damage': {
        const amount = scaledAmount(host, self, e.amount, e.scaling);
        for (const t of targets) if (host.isAlive(t)) host.damage(self, t, e.kind, amount, source);
        break;
      }
      case 'heal': {
        const amount = scaledAmount(host, self, e.amount, e.scaling);
        for (const t of targets) if (host.isAlive(t)) host.heal(self, t, amount, source);
        break;
      }
      case 'shield': {
        const amount = scaledAmount(host, self, e.amount, e.scaling);
        const expires = expiryTick(e.duration, host.tick, host.tickRate);
        for (const t of targets) if (host.isAlive(t)) host.shield(self, t, amount, expires, source, slot);
        break;
      }
      case 'statMod': {
        const expiresTick = expiryTick(e.duration, host.tick, host.tickRate);
        for (const t of targets) {
          if (!host.isAlive(t)) continue;
          host.addModifier(t, { source, stat: e.stat, mode: e.mode, value: e.value, expiresTick }, source);
        }
        break;
      }
      case 'stun': {
        const until = host.tick + secondsToTicks(e.duration, host.tickRate);
        for (const t of targets) if (host.isAlive(t)) host.stun(t, until, source);
        break;
      }
      case 'applyTag': {
        const expires = expiryTick(e.duration, host.tick, host.tickRate);
        for (const t of targets) if (host.isAlive(t)) host.applyTag(self, t, e.tag, expires, source, slot);
        break;
      }
      case 'spawnProjectile': {
        for (const t of targets) if (host.isAlive(t)) host.spawnProjectile(self, t, e.ref, source);
        break;
      }
      default: {
        const never: never = e;
        throw new Error(`runEffects: unknown effect ${JSON.stringify(never)}`);
      }
    }
  }
}
