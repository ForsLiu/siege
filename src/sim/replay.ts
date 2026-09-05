// Replay: (seed, command log) -> the same run, hash for hash.
import { applyCommand, type Command } from './commands.ts';
import type { Content } from './rules.ts';
import { createRun, type RunOptions, type RunState } from './run.ts';

export interface RunLog {
  version: 1;
  seed: number;
  contentHash: string;
  /** The run accepted `dev:` commands; a replay must enable them to reproduce the hashes. */
  devCommands: boolean;
  commands: Command[];
}

export interface ReplayResult {
  state: RunState;
  hashes: string[];
  /** First rejected command, if any (the replay stops there). */
  rejected: { index: number; reason: string } | null;
}

export function replayRun(seed: number, commands: readonly Command[], content: Content, options: RunOptions = {}): ReplayResult {
  const state = createRun(seed, content, options);
  for (let i = 0; i < commands.length; i++) {
    const res = applyCommand(state, commands[i] as Command, content);
    if (!res.ok) return { state, hashes: state.hashes, rejected: { index: i, reason: res.reason } };
  }
  return { state, hashes: state.hashes, rejected: null };
}

/** Replay a recorded log, using the dev-command flag the log was recorded with. */
export function replayLog(log: RunLog, content: Content): ReplayResult {
  return replayRun(log.seed, log.commands, content, { devCommands: log.devCommands });
}

export interface VerifyResult {
  ok: boolean;
  /** Index into the hash list where the first mismatch occurred, or -1. */
  mismatchIndex: number;
  expected: string | null;
  actual: string | null;
  rejected: { index: number; reason: string } | null;
}

export function verifyReplay(seed: number, commands: readonly Command[], expectedHashes: readonly string[], content: Content, options: RunOptions = {}): VerifyResult {
  const r = replayRun(seed, commands, content, options);
  const n = Math.max(expectedHashes.length, r.hashes.length);
  for (let i = 0; i < n; i++) {
    const e = expectedHashes[i] ?? null;
    const a = r.hashes[i] ?? null;
    if (e !== a) return { ok: false, mismatchIndex: i, expected: e, actual: a, rejected: r.rejected };
  }
  return { ok: r.rejected === null, mismatchIndex: -1, expected: null, actual: null, rejected: r.rejected };
}
