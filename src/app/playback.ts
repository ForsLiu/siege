// Shared fight-playback state: turns a FightResult into a scrubbable timeline the renderer
// draws frame by frame. Used by both the run screen (runController.ts) and the sandbox screen
// (sandboxController.ts), which otherwise duplicate this exactly.
import { buildFxCues, type FxCue } from '../render/fx.ts';
import { buildTimeline, type Timeline } from '../render/timeline.ts';
import type { FightResult } from '../sim/fight.ts';
import type { UnitDef } from '../sim/units.ts';

export interface PlaybackState {
  timeline: Timeline;
  /** Combat FX cues for this fight (P0-30), computed once alongside the timeline. */
  fx: FxCue[];
  /** Fractional sim tick the renderer is showing. */
  tick: number;
  onDone: (() => void) | null;
}

/** `unitsById` is the *fight's own* unit registry (`FightRules.units`) — for a sandbox fight
 *  that includes its synthetic per-instance unit defs, not just `content.unitsById` (P0-30). */
export function startPlayback(result: FightResult, moveTicks: number, unitsById: Record<string, UnitDef>, onDone: (() => void) | null = null): PlaybackState {
  return { timeline: buildTimeline(result, moveTicks), fx: buildFxCues(result.events, unitsById), tick: 0, onDone };
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
