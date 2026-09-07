// Trait panel model (P0-26): a pure view over one side's board composition. Shows every trait
// present on the board, active or not (partial progress toward the first breakpoint included),
// sorted by active tier then count so the strongest synergies surface first.
import type { Content } from '../sim/rules.ts';
import { traitCounts, type TraitCount } from '../sim/traits.ts';
import { describeEffect } from './inspectorModel.ts';

export interface TraitPanelBreakpoint {
  count: number;
  /** Effect text for this breakpoint's effects, rendered with no live stats to resolve scaling
   *  against (no trait content uses `scaling` today — see `describeEffect`'s doc comment). */
  text: string;
  reached: boolean;
}

export interface TraitPanelEntry {
  traitId: string;
  name: string;
  description: string;
  /** No art asset pipeline exists yet (same call as P0-22's round-track letters): the trait
   *  name's first letter stands in for a real icon. */
  icon: string;
  count: number;
  teamWide: boolean;
  breakpoints: TraitPanelBreakpoint[];
  /** Names of the distinct units carrying this trait, for the panel's hover text. */
  holderNames: string[];
}

/** Index of the reached breakpoint within `breakpoints`, or -1 if none is reached — used only to
 *  sort traits with an active tier ahead of traits with none, and higher tiers ahead of lower. */
function tierOf(t: TraitCount): number {
  return t.reached ? t.breakpoints.findIndex((bp) => bp.count === t.reached!.count) : -1;
}

export function traitPanelModel(board: readonly { defId: string }[], content: Content): TraitPanelEntry[] {
  return [...traitCounts(board, content.unitsById, content.traitsById)]
    .sort((a, b) => {
      const ta = tierOf(a);
      const tb = tierOf(b);
      if (ta !== tb) return tb - ta;
      if (a.count !== b.count) return b.count - a.count;
      return a.traitId < b.traitId ? -1 : a.traitId > b.traitId ? 1 : 0;
    })
    .map((t): TraitPanelEntry => {
      const trait = content.traitsById[t.traitId]!;
      return {
        traitId: t.traitId,
        name: trait.name,
        description: trait.description,
        icon: trait.name[0]!.toUpperCase(),
        count: t.count,
        teamWide: t.teamWide,
        breakpoints: t.breakpoints.map((bp) => ({
          count: bp.count,
          text: bp.effects.map((e) => describeEffect(e, () => 0)).join('; '),
          reached: t.reached !== null && bp.count === t.reached.count,
        })),
        holderNames: t.holderDefIds.map((id) => content.unitsById[id]?.name ?? id),
      };
    });
}
