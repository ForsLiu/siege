// Replay: (seed, command log) -> the same run, hash for hash.
import { applyCommand, type Command } from './commands.ts';
import type { Content } from './rules.ts';
import { createRun, type RunState } from './run.ts';

export interface RunLog {
  version: 1;
  seed: number;
  contentHash: string;
  commands: Command[];
}

export interface ReplayResult {
  state: RunState;
  hashes: string[];
  /** First rejected command, if any (the replay stops there). */
  rejected: { index: number; reason: string } | null;
}

export function replayRun(seed: number, commands: readonly Command[], content: Content): ReplayResult {
  const state = createRun(seed, content);
  for (let i = 0; i < commands.length; i++) {
    const res = applyCommand(state, commands[i] as Command, content);
    if (!res.ok) return { state, hashes: state.hashes, rejected: { index: i, reason: res.reason } };
  }
  return { state, hashes: state.hashes, rejected: null };
}

export interface VerifyResult {
  ok: boolean;
  /** Index into the hash list where the first mismatch occurred, or -1. */
  mismatchIndex: number;
  expected: string | null;
  actual: string | null;
  rejected: { index: number; reason: string } | null;
}

export function verifyReplay(seed: number, commands: readonly Command[], expectedHashes: readonly string[], content: Content): VerifyResult {
  const r = replayRun(seed, commands, content);
  const n = Math.max(expectedHashes.length, r.hashes.length);
  for (let i = 0; i < n; i++) {
    const e = expectedHashes[i] ?? null;
    const a = r.hashes[i] ?? null;
    if (e !== a) return { ok: false, mismatchIndex: i, expected: e, actual: a, rejected: r.rejected };
  }
  return { ok: r.rejected === null, mismatchIndex: -1, expected: null, actual: null, rejected: r.rejected };
}
