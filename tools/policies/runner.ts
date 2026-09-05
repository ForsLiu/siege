// Drive a full run with a policy. Shared by tools/sim.ts, tools/sweep.ts and tests.
import { applyCommand, checkInvariants, legalCommands, type Command } from '../../src/sim/commands.ts';
import { buildRunReport, type RunReport } from '../../src/sim/report.ts';
import { Rng } from '../../src/sim/rng.ts';
import type { Content } from '../../src/sim/rules.ts';
import { createRun, type RunState } from '../../src/sim/run.ts';
import type { Policy } from './index.ts';

export interface RunOptions {
  /** Safety cap; the run is abandoned when exceeded. */
  maxCommands?: number;
  /** Check invariants after every command (slower). */
  checkInvariants?: boolean;
  /** Wall-clock timer for the report; defaults to none (0 ms). */
  now?: () => number;
}

export interface PolicyRunResult {
  state: RunState;
  commands: Command[];
  report: RunReport;
}

export function runWithPolicy(seed: number, policy: Policy, content: Content, opts: RunOptions = {}): PolicyRunResult {
  const maxCommands = opts.maxCommands ?? 5000;
  const now = opts.now ?? (() => 0);
  const t0 = now();
  const state = createRun(seed, content);
  const rng = Rng.fromSeed(seed, `policy:${policy.name}`);
  const commands: Command[] = [];
  while (state.phase !== 'ended') {
    if (commands.length >= maxCommands) {
      const res = applyCommand(state, { type: 'abandon' }, content);
      if (!res.ok) throw new Error(`abandon rejected: ${res.reason}`);
      commands.push({ type: 'abandon' });
      break;
    }
    const legal = legalCommands(state, content);
    if (legal.length === 0) throw new Error(`no legal commands in phase ${state.phase} (round ${state.round})`);
    const cmd = policy.choose({ state, content, legal, rng });
    const res = applyCommand(state, cmd, content);
    if (!res.ok) throw new Error(`policy ${policy.name} issued an illegal command ${JSON.stringify(cmd)}: ${res.reason}`);
    commands.push(cmd);
    if (opts.checkInvariants) {
      const problems = checkInvariants(state, content);
      if (problems.length > 0) throw new Error(`invariants violated after ${JSON.stringify(cmd)}: ${problems.join('; ')}`);
    }
  }
  const report = buildRunReport(state, commands, policy.name, now() - t0);
  return { state, commands, report };
}
