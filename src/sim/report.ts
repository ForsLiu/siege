// Run report: what tools/sim.ts prints and tools/sweep.ts aggregates.
import type { Command } from './commands.ts';
import type { RunState, RoundRecord } from './run.ts';

export interface RunReport {
  version: 1;
  seed: number;
  contentHash: string;
  policy: string;
  outcome: 'win' | 'loss' | null;
  endReason: string | null;
  roundsSurvived: number;
  finalHp: number;
  finalGold: number;
  finalLevel: number;
  hpCurve: number[];
  goldCurve: number[];
  rounds: RoundRecord[];
  hashes: string[];
  commandCount: number;
  commands: Command[];
  timings: { totalMs: number; fightTicks: number };
}

export function buildRunReport(state: RunState, commands: Command[], policy: string, totalMs: number): RunReport {
  const won = state.outcome === 'win';
  const roundsSurvived = won ? state.history.length : Math.max(0, state.history.filter((r) => r.hpAfter > 0).length);
  return {
    version: 1,
    seed: state.config.seed,
    contentHash: state.config.contentHash,
    policy,
    outcome: state.outcome,
    endReason: state.endReason,
    roundsSurvived,
    finalHp: state.hp,
    finalGold: state.gold,
    finalLevel: state.level,
    hpCurve: state.history.map((r) => r.hpAfter),
    goldCurve: state.history.map((r) => r.gold),
    rounds: state.history,
    hashes: [...state.hashes],
    commandCount: state.commandCount,
    commands,
    timings: { totalMs, fightTicks: state.history.reduce((s, r) => s + r.fight.ticks, 0) },
  };
}
