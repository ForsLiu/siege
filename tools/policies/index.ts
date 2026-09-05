// Bot policy plug-in folder. A policy picks one of legalCommands(state) each step.
// Add a policy: create tools/policies/<name>.ts exporting `createPolicy(): Policy`
// and register it in POLICY_FACTORIES below. P0-04 adds `greedy`.
import type { Command } from '../../src/sim/commands.ts';
import type { Rng } from '../../src/sim/rng.ts';
import type { Content } from '../../src/sim/rules.ts';
import type { RunState } from '../../src/sim/run.ts';
import { UsageError } from '../args.ts';
import { createRandomPolicy } from './random.ts';

export interface PolicyContext {
  state: RunState;
  content: Content;
  /** Non-empty list of legal commands (never includes `abandon`). */
  legal: Command[];
  /** Policy-private RNG derived from (seed, "policy:<name>"); not a sim stream. */
  rng: Rng;
}

export interface Policy {
  readonly name: string;
  choose(ctx: PolicyContext): Command;
}

export const POLICY_FACTORIES: Record<string, () => Policy> = {
  random: createRandomPolicy,
};

export function policyNames(): string[] {
  return Object.keys(POLICY_FACTORIES).sort();
}

export function getPolicy(name: string): Policy {
  const f = POLICY_FACTORIES[name];
  if (!f) throw new UsageError(`unknown policy "${name}" (available: ${policyNames().join(', ')})`);
  return f();
}
