// Trait activation (P0-25): pure over board composition. No fight state, no RNG, no I/O.
import type { Effect } from './effects.ts';
import type { UnitDef } from './units.ts';

export interface TraitBreakpoint {
  /** Distinct unit ids required to reach this tier. */
  count: number;
  effects: Effect[];
}

/** A trait row (data): unit rows reference it by id in `UnitDef.traits`. */
export interface TraitDef {
  id: string;
  name: string;
  description: string;
  /** true: the reached breakpoint's effects apply to every unit on the side. false: holders only. */
  teamWide: boolean;
  /** Ascending, strictly increasing `count` (schema-enforced). */
  breakpoints: TraitBreakpoint[];
}

export interface ActiveTrait {
  traitId: string;
  /** The highest breakpoint reached; lower tiers do not also apply (QUESTIONS.md P0-25-01). */
  breakpoint: TraitBreakpoint;
  /** Number of unique unit ids carrying the trait on this side. */
  count: number;
  teamWide: boolean;
  /** Distinct unit ids carrying the trait on this side, sorted. */
  holderDefIds: string[];
}

/**
 * Which traits are active for one side's board, and at which tier. The active count for a
 * trait is the number of *unique unit ids* on the board carrying it: a duplicate copy or a
 * higher-star copy of the same unit adds nothing (BACKLOG P0-25). A trait with no breakpoint
 * reached (count below the lowest one) is absent from the result, not present-and-inactive.
 * "Highest reached" (below) trusts `breakpoints` to already be ascending by `count`, which
 * `TraitDefSchema`'s strictly-increasing refine guarantees for any loader-sourced `TraitDef`.
 */
export function activeTraits(board: readonly { defId: string }[], unitsById: Record<string, UnitDef>, traitsById: Record<string, TraitDef>): ActiveTrait[] {
  const holdersByTrait = new Map<string, Set<string>>();
  for (const defId of new Set(board.map((u) => u.defId))) {
    const def = unitsById[defId];
    if (!def) continue;
    for (const traitId of def.traits) {
      let set = holdersByTrait.get(traitId);
      if (!set) holdersByTrait.set(traitId, (set = new Set()));
      set.add(defId);
    }
  }
  const out: ActiveTrait[] = [];
  for (const [traitId, holders] of holdersByTrait) {
    const trait = traitsById[traitId];
    if (!trait) continue;
    const count = holders.size;
    let reached: TraitBreakpoint | null = null;
    for (const bp of trait.breakpoints) if (count >= bp.count) reached = bp;
    if (reached) out.push({ traitId, breakpoint: reached, count, teamWide: trait.teamWide, holderDefIds: [...holders].sort() });
  }
  return out.sort((a, b) => (a.traitId < b.traitId ? -1 : a.traitId > b.traitId ? 1 : 0));
}
