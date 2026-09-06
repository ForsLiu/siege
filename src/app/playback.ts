// Shared fight-playback state: turns a FightResult into a scrubbable timeline the renderer
// draws frame by frame. Used by both the run screen (runController.ts) and the sandbox screen
// (sandboxController.ts), which otherwise duplicate this exactly.
import { buildTimeline, type Timeline } from '../render/timeline.ts';
import type { FightResult } from '../sim/fight.ts';

export interface PlaybackState {
  timeline: Timeline;
  /** Fractional sim tick the renderer is showing. */
  tick: number;
  onDone: (() => void) | null;
}

export function startPlayback(result: FightResult, moveTicks: number, onDone: (() => void) | null = null): PlaybackState {
  return { timeline: buildTimeline(result, moveTicks), tick: 0, onDone };
}

/**
 * Advances `p` by `dt` seconds at `speed`; returns the updated state, the same reference when
 * the clock is unusable, or `null` once playback has run past the last tick. Never calls
 * `onDone` itself: the caller must invoke it (and only after clearing its own playback field),
 * so a callback that ends the run cannot observe a stale non-null playback state.
 */
export function advancePlayback(p: PlaybackState, dt: number, speed: number, tickRate: number): PlaybackState | null {
  // Defensive: a hostile or broken clock must never stall or rewind the playback.
  if (!Number.isFinite(dt) || !Number.isFinite(speed) || dt <= 0 || speed <= 0) return p;
  const tick = p.tick + dt * tickRate * speed;
  if (tick < p.timeline.ticks + tickRate * 0.5) return { ...p, tick };
  return null;
}
