// Combat FX (P0-30): per-event visuals derived only from a fight's own event log, replayed
// exactly like `timeline.ts`'s unit snapshots. Purely additive to the renderer — building or
// drawing cues never touches the sim, so a replay's hash is identical whether FX is drawn or not
// (the toggle in `src/app/main.ts` only decides whether `BoardRenderer.drawFx` is called at all).
import type { FightEvent } from '../sim/fight.ts';
import type { UnitDef } from '../sim/units.ts';
import { interpolatedCell, type UnitSnapshot } from './timeline.ts';

export type FxCue =
  | { kind: 'meleeSwing'; tick: number; uid: number; target: number }
  | { kind: 'projectileTrail'; tick: number; untilTick: number; uid: number; target: number }
  | { kind: 'impactFlash'; tick: number; target: number }
  | { kind: 'castFlash'; tick: number; uid: number }
  | { kind: 'castToast'; tick: number; uid: number; text: string }
  | { kind: 'shieldShimmer'; tick: number; target: number }
  | { kind: 'healPulse'; tick: number; target: number }
  | { kind: 'lifestealPulse'; tick: number; uid: number };

/** Fixed cue durations in ticks — presentation-only constants (never read by `/src/sim`), so
 *  CLAUDE.md's "no tuning number in /src" rule (about sim/gameplay balance) does not apply here;
 *  they only pace an animation. A basic ranged auto-attack applies damage the same tick it's
 *  thrown (`fight.ts` has no travel time outside an explicit `spawnProjectile` effect), so its
 *  trail duration is a synthetic, purely cosmetic flight time. */
const MELEE_SWING_TICKS = 4;
const IMPACT_FLASH_TICKS = 5;
const CAST_FLASH_TICKS = 6;
const CAST_TOAST_TICKS = 20;
const SHIELD_SHIMMER_TICKS = 8;
const HEAL_PULSE_TICKS = 8;
const LIFESTEAL_PULSE_TICKS = 8;
const RANGED_AUTO_ATTACK_TRAIL_TICKS = 4;

/**
 * Every FX cue a fight's events produce, in event order. Pure and side-effect-free (does not
 * mutate `events`); `unitsById` only resolves a unit's `attackType` (melee swing vs. a projectile
 * trail + impact flash) since the basic `attack` event itself carries no such flag. This is the
 * *fight's own* unit registry (`FightRules.units`, e.g. `content.unitsById` for a real run, or the
 * sandbox's synthetic per-instance defs for a sandbox fight — src/app/sandboxController.ts,
 * P0-17) rather than always `content.unitsById`, since a sandbox unit's defId does not exist
 * there.
 *
 * Lifesteal has no dedicated event — it is authored as a `heal` effect on an `onHit`/`onAttack`
 * hook (there is no `lifesteal` entry in the effect vocabulary). A `lifestealPulse` cue is
 * therefore inferred: a unit healing itself in the same tick it also dealt a `hit` (QUESTIONS.md
 * P0-30-01 — the first-match, same-tick heuristic is deliberately loose since no SPEC-defined
 * lifesteal mechanic exists yet to pin down exactly).
 */
export function buildFxCues(events: readonly FightEvent[], unitsById: Record<string, UnitDef>): FxCue[] {
  const hitTickUids = new Set<string>();
  for (const e of events) if (e.type === 'hit') hitTickUids.add(`${e.tick}:${e.uid}`);

  const cues: FxCue[] = [];
  const defIdByUid = new Map<number, string>();
  for (const e of events) {
    switch (e.type) {
      case 'spawn':
        defIdByUid.set(e.uid, e.defId);
        break;
      case 'attack': {
        const attackType = unitsById[defIdByUid.get(e.uid) ?? '']?.attackType;
        if (attackType === 'ranged') {
          cues.push({ kind: 'projectileTrail', tick: e.tick, untilTick: e.tick + RANGED_AUTO_ATTACK_TRAIL_TICKS, uid: e.uid, target: e.target });
          cues.push({ kind: 'impactFlash', tick: e.tick + RANGED_AUTO_ATTACK_TRAIL_TICKS, target: e.target });
        } else {
          cues.push({ kind: 'meleeSwing', tick: e.tick, uid: e.uid, target: e.target });
          cues.push({ kind: 'impactFlash', tick: e.tick, target: e.target });
        }
        break;
      }
      case 'projectile':
        cues.push({ kind: 'projectileTrail', tick: e.tick, untilTick: e.arrivalTick, uid: e.uid, target: e.target });
        break;
      case 'projectileHit':
        cues.push({ kind: 'impactFlash', tick: e.tick, target: e.target });
        break;
      case 'cast':
        cues.push({ kind: 'castFlash', tick: e.tick, uid: e.uid });
        cues.push({ kind: 'castToast', tick: e.tick, uid: e.uid, text: e.ability });
        break;
      case 'shield':
        // uid 0 marks a shield's expiry (fight.ts), not a gain — no shimmer for that.
        if (e.uid !== 0) cues.push({ kind: 'shieldShimmer', tick: e.tick, target: e.target });
        break;
      case 'heal':
        cues.push({ kind: 'healPulse', tick: e.tick, target: e.target });
        if (e.target === e.uid && hitTickUids.has(`${e.tick}:${e.uid}`)) cues.push({ kind: 'lifestealPulse', tick: e.tick, uid: e.uid });
        break;
      default:
        break;
    }
  }
  return cues;
}

/** The tick window `cue` is visible for. */
export function fxCueWindow(cue: FxCue): { from: number; to: number } {
  switch (cue.kind) {
    case 'meleeSwing':
      return { from: cue.tick, to: cue.tick + MELEE_SWING_TICKS };
    case 'projectileTrail':
      return { from: cue.tick, to: cue.untilTick };
    case 'impactFlash':
      return { from: cue.tick, to: cue.tick + IMPACT_FLASH_TICKS };
    case 'castFlash':
      return { from: cue.tick, to: cue.tick + CAST_FLASH_TICKS };
    case 'castToast':
      return { from: cue.tick, to: cue.tick + CAST_TOAST_TICKS };
    case 'shieldShimmer':
      return { from: cue.tick, to: cue.tick + SHIELD_SHIMMER_TICKS };
    case 'healPulse':
      return { from: cue.tick, to: cue.tick + HEAL_PULSE_TICKS };
    case 'lifestealPulse':
      return { from: cue.tick, to: cue.tick + LIFESTEAL_PULSE_TICKS };
  }
}

/** Cues visible at fractional tick `tick` (their window is a half-open `[from, to)`). */
export function activeFxCues(cues: readonly FxCue[], tick: number): FxCue[] {
  return cues.filter((c) => {
    const w = fxCueWindow(c);
    return tick >= w.from && tick < w.to;
  });
}

const FX_COLORS = {
  swing: '#f8fafc',
  trail: '#fde68a',
  flash: '#f8fafc',
  cast: '#c084fc',
  shield: '#7dd3fc',
  heal: '#4ade80',
};

/**
 * Draws every cue active at `tick` onto `ctx`, in board pixel space via `cellCenter`. Pure
 * presentation: reads `frame`'s positions (already computed by `timeline.ts`, itself a replay of
 * the same events) and never touches sim state. A cue whose unit/target has left the frame (dead,
 * or a stale reference) is silently skipped rather than throwing.
 */
export function drawFxCues(ctx: CanvasRenderingContext2D, cellCenter: (col: number, row: number) => { x: number; y: number }, cues: readonly FxCue[], tick: number, frame: readonly UnitSnapshot[], moveTicks: number): void {
  const byUid = new Map(frame.map((u) => [u.uid, u]));
  const posOf = (uid: number): { x: number; y: number } | null => {
    const u = byUid.get(uid);
    if (!u) return null;
    const p = interpolatedCell(u, tick, moveTicks);
    return cellCenter(p.col, p.row);
  };
  for (const cue of activeFxCues(cues, tick)) {
    const w = fxCueWindow(cue);
    const progress = w.to > w.from ? Math.min(1, Math.max(0, (tick - w.from) / (w.to - w.from))) : 1;
    ctx.save();
    switch (cue.kind) {
      case 'meleeSwing': {
        const a = posOf(cue.uid);
        const b = posOf(cue.target);
        if (a && b) {
          ctx.globalAlpha = 1 - progress;
          ctx.strokeStyle = FX_COLORS.swing;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(a.x + (b.x - a.x) * 0.6, a.y + (b.y - a.y) * 0.6);
          ctx.stroke();
        }
        break;
      }
      case 'projectileTrail': {
        const a = posOf(cue.uid);
        const b = posOf(cue.target);
        if (a && b) {
          const x = a.x + (b.x - a.x) * progress;
          const y = a.y + (b.y - a.y) * progress;
          ctx.fillStyle = FX_COLORS.trail;
          ctx.beginPath();
          ctx.arc(x, y, 4, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'impactFlash': {
        const p = posOf(cue.target);
        if (p) {
          ctx.globalAlpha = 1 - progress;
          ctx.strokeStyle = FX_COLORS.flash;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 10 + progress * 8, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'castFlash': {
        const p = posOf(cue.uid);
        if (p) {
          ctx.globalAlpha = 1 - progress;
          ctx.strokeStyle = FX_COLORS.cast;
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 14, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'castToast': {
        const p = posOf(cue.uid);
        if (p) {
          ctx.globalAlpha = 1 - progress;
          ctx.fillStyle = '#e5e7eb';
          ctx.font = '11px system-ui, sans-serif';
          ctx.textAlign = 'center';
          ctx.fillText(cue.text, p.x, p.y - 30 - progress * 12);
        }
        break;
      }
      case 'shieldShimmer': {
        const p = posOf(cue.target);
        if (p) {
          ctx.globalAlpha = 0.6 * (1 - progress);
          ctx.strokeStyle = FX_COLORS.shield;
          ctx.lineWidth = 2;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
      case 'healPulse': {
        const p = posOf(cue.target);
        if (p) {
          ctx.globalAlpha = 0.7 * (1 - progress);
          ctx.fillStyle = FX_COLORS.heal;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 12 + progress * 6, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case 'lifestealPulse': {
        const p = posOf(cue.uid);
        if (p) {
          ctx.globalAlpha = 0.7 * (1 - progress);
          ctx.strokeStyle = FX_COLORS.heal;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 18, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }
}
