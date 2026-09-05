// Minimal effect vocabulary + interpreter and hook bus (v0; P0-01 extends it).
// The interpreter is generic over the unit type: the fight supplies an EffectHost that
// knows how to find targets, apply damage/heals, add modifiers and stun.
import type { ModMode, Modifier, StatName } from './stats.ts';

export type DamageKind = 'physical' | 'magic' | 'true';
export type TargetSel = 'self' | 'target' | 'allies' | 'enemies';

export const DAMAGE_KINDS = ['physical', 'magic', 'true'] as const;
export const TARGET_SELS = ['self', 'target', 'allies', 'enemies'] as const;
export const EFFECT_TYPES = ['damage', 'heal', 'statMod', 'stun'] as const;
export const HOOK_NAMES = ['onCombatStart', 'onAttack', 'onHit', 'onCast', 'onKill', 'onDeath'] as const;
export type HookName = (typeof HOOK_NAMES)[number];

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

export type Effect = DamageEffect | HealEffect | StatModEffect | StunEffect;

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
  addModifier(tgt: U, mod: Modifier, cause: string): void;
  stun(tgt: U, untilTick: number, cause: string): void;
}

export function secondsToTicks(seconds: number, tickRate: number): number {
  return Math.max(1, Math.round(seconds * tickRate));
}

function scaledAmount<U>(host: EffectHost<U>, self: U, amount: number, scaling: Scaling | undefined): number {
  if (!scaling) return amount;
  return amount + scaling.factor * host.getStat(self, scaling.stat);
}

/**
 * Apply `effects` in order. `self` is the unit owning the effect; `other` is the
 * contextual unit (attack target, killer, victim...) that `target: 'target'` resolves to.
 * `source` is the stacking source id for statMods produced here.
 */
export function runEffects<U>(
  host: EffectHost<U>,
  effects: readonly Effect[],
  self: U,
  other: U | null,
  source: string,
): void {
  for (const e of effects) {
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
      case 'statMod': {
        const expiresTick = e.duration === null ? null : host.tick + secondsToTicks(e.duration, host.tickRate);
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
      default: {
        const never: never = e;
        throw new Error(`runEffects: unknown effect ${JSON.stringify(never)}`);
      }
    }
  }
}
