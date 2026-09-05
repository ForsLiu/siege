// The run controller: run state, command dispatch, fight playback and abandon, with no DOM.
// src/app/main.ts is glue over this; the fast tier drives it directly (P0-09).
import { buildTimeline, type Timeline } from '../render/timeline.ts';
import { applyCommand, type Command } from '../sim/commands.ts';
import type { FightResult } from '../sim/fight.ts';
import type { Content } from '../sim/rules.ts';
import { createRun, findUnit, type RunState } from '../sim/run.ts';
import type { RunUiMode } from '../ui/runUi.ts';
import type { ScreenEvent } from './screens.ts';

export interface DispatchResult {
  ok: boolean;
  reason: string | null;
}

export interface PlaybackState {
  timeline: Timeline;
  /** Fractional sim tick the renderer is showing. */
  tick: number;
  onDone: (() => void) | null;
}

export interface RunControllerDeps {
  content: Content;
  /** Dev builds accept the `dev:` command namespace (P0-15). */
  devCommands: boolean;
  /** Screen-machine events (startRun, runEnded, ...) the host should apply. */
  onScreenEvent(ev: ScreenEvent): void;
  /** Called whenever the view should be refreshed. */
  onChange(): void;
}

export class RunController {
  private state: RunState | null = null;
  private play: PlaybackState | null = null;
  private readonly deps: RunControllerDeps;
  private readonly tickRate: number;
  private readonly moveTicks: number;

  /** Last rejection reason or fight result line, shown in the HUD. */
  message = '';
  selectedUid: number | null = null;
  seed = 0;

  constructor(deps: RunControllerDeps) {
    this.deps = deps;
    this.tickRate = deps.content.rules.tickRate;
    this.moveTicks = Math.max(1, Math.round(deps.content.rules.combat.moveSecondsPerHex * this.tickRate));
  }

  get run(): RunState | null {
    return this.state;
  }

  get playback(): PlaybackState | null {
    return this.play;
  }

  mode(): RunUiMode {
    if (this.play) return 'combat';
    return this.state?.phase === 'reward' ? 'reward' : 'planning';
  }

  startRun(seed: number): RunState {
    this.state = createRun(seed, this.deps.content, { devCommands: this.deps.devCommands });
    this.seed = seed;
    this.selectedUid = null;
    this.play = null;
    this.message = '';
    this.deps.onScreenEvent({ type: 'startRun' });
    this.deps.onChange();
    return this.state;
  }

  /** The single command path: UI clicks, hotkeys, drags and the dev panel all go through here. */
  dispatch(cmd: Command): DispatchResult {
    const run = this.state;
    if (!run) return this.fail('no run in progress');
    if (this.play) return this.fail('combat is playing');
    const res = applyCommand(run, cmd, this.deps.content);
    if (!res.ok) return this.fail(res.reason);
    this.message = '';
    if (this.selectedUid !== null && !findUnit(run, this.selectedUid)) this.selectedUid = null;
    if (res.fight) {
      this.startPlayback(res.fight, () => {
        this.message = this.fightSummaryLine();
        if (this.state?.phase === 'ended') this.finish();
        else this.deps.onChange();
      });
    } else if (run.phase === 'ended') {
      this.finish();
    }
    this.deps.onChange();
    return { ok: true, reason: null };
  }

  /**
   * Plays a fight through the renderer. Also used by the dev-fight screen. A playback still in
   * flight is completed first, so its callback (which may end the run) is never swallowed.
   */
  startPlayback(result: FightResult, onDone: (() => void) | null = null): void {
    const pending = this.play;
    this.play = null;
    pending?.onDone?.();
    this.play = { timeline: buildTimeline(result, this.moveTicks), tick: 0, onDone };
  }

  /** Advances playback by `dt` seconds at `speed`; finishes it past the last tick. */
  advance(dt: number, speed: number): void {
    const p = this.play;
    if (!p) return;
    // Defensive: a hostile or broken clock must never stall or rewind the playback.
    if (!Number.isFinite(dt) || !Number.isFinite(speed) || dt <= 0 || speed <= 0) return;
    p.tick += dt * this.tickRate * speed;
    if (p.tick < p.timeline.ticks + this.tickRate * 0.5) return;
    this.play = null;
    p.onDone?.();
    this.deps.onChange();
  }

  /**
   * Abandon the run, including mid-playback: the fight is already resolved in the sim, so the
   * playback is only a visual and is dropped before the command lands (QA bootstrap bug 2).
   */
  abandon(): DispatchResult {
    const run = this.state;
    if (!run) return this.fail('no run in progress');
    const hadPlayback = this.play !== null;
    this.play = null;
    if (hadPlayback && run.phase === 'ended') {
      // The fight that was playing already ended the run; dropping the playback dropped the
      // callback that would have shown the results, so finish here instead of being rejected.
      this.message = this.fightSummaryLine();
      this.finish();
      this.deps.onChange();
      return { ok: true, reason: null };
    }
    return this.dispatch({ type: 'abandon' });
  }

  /** Drops any playback and forgets the run (leaving the run screen). */
  clear(): void {
    this.state = null;
    this.play = null;
    this.selectedUid = null;
    this.message = '';
  }

  private finish(): void {
    const run = this.state;
    if (!run) return;
    this.deps.onScreenEvent({ type: 'runEnded', outcome: run.outcome ?? 'loss' });
  }

  private fightSummaryLine(): string {
    const f = this.state?.lastFight;
    if (!f) return '';
    const verdict = f.winner === 'left' ? 'Victory' : f.winner === 'right' ? 'Defeat' : 'Draw';
    return `${verdict} in ${(f.ticks / this.tickRate).toFixed(1)}s (-${f.hpLoss} hp)`;
  }

  private fail(reason: string): DispatchResult {
    this.message = reason;
    this.deps.onChange();
    return { ok: false, reason };
  }
}
