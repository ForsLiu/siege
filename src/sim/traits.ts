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

/** Every trait present on a board, active or not (P0-26: the trait panel shows partial progress
 *  too, not just active traits). A strict superset of `ActiveTrait`: `reached` is null below the
 *  lowest breakpoint instead of the trait being omitted. */
export interface TraitCount {
  traitId: string;
  /** Number of unique unit ids carrying the trait on this side. */
  count: number;
  teamWide: boolean;
  /** Distinct unit ids carrying the trait on this side, sorted. */
  holderDefIds: string[];
  /** Ascending, strictly increasing `count` (schema-enforced) — the trait's full breakpoint list. */
  breakpoints: TraitBreakpoint[];
  /** The highest breakpoint reached, or null if `count` is below the lowest one. */
  reached: TraitBreakpoint | null;
}

function holdersByTrait(board: readonly { defId: string }[], unitsById: Record<string, UnitDef>): Map<string, Set<string>> {
  const holders = new Map<string, Set<string>>();
  for (const defId of new Set(board.map((u) => u.defId))) {
    const def = unitsById[defId];
    if (!def) continue;
    for (const traitId of def.traits) {
      let set = holders.get(traitId);
      if (!set) holders.set(traitId, (set = new Set()));
      set.add(defId);
    }
  }
  return holders;
}

/**
 * Every trait with at least one unique holder on the board, with its count and (if reached) its
 * highest breakpoint — used by both `activeTraits` (fight-time application, active traits only)
 * and the P0-26 trait panel (which also shows traits below their first breakpoint, as progress).
 * The active count for a trait is the number of *unique unit ids* on the board carrying it: a
 * duplicate copy or a higher-star copy of the same unit adds nothing (BACKLOG P0-25).
 * "Highest reached" trusts `breakpoints` to already be ascending by `count`, which
 * `TraitDefSchema`'s strictly-increasing refine guarantees for any loader-sourced `TraitDef`.
 */
export function traitCounts(board: readonly { defId: string }[], unitsById: Record<string, UnitDef>, traitsById: Record<string, TraitDef>): TraitCount[] {
  const out: TraitCount[] = [];
  for (const [traitId, holders] of holdersByTrait(board, unitsById)) {
    const trait = traitsById[traitId];
    if (!trait) continue;
    const count = holders.size;
    let reached: TraitBreakpoint | null = null;
    for (const bp of trait.breakpoints) if (count >= bp.count) reached = bp;
    out.push({ traitId, count, teamWide: trait.teamWide, holderDefIds: [...holders].sort(), breakpoints: trait.breakpoints, reached });
  }
  return out.sort((a, b) => (a.traitId < b.traitId ? -1 : a.traitId > b.traitId ? 1 : 0));
}

/** Which traits are active for one side's board, and at which tier. A trait with no breakpoint
 *  reached (count below the lowest one) is absent from the result, not present-and-inactive. */
export function activeTraits(board: readonly { defId: string }[], unitsById: Record<string, UnitDef>, traitsById: Record<string, TraitDef>): ActiveTrait[] {
  const out: ActiveTrait[] = [];
  for (const t of traitCounts(board, unitsById, traitsById)) {
    if (t.reached) out.push({ traitId: t.traitId, breakpoint: t.reached, count: t.count, teamWide: t.teamWide, holderDefIds: t.holderDefIds });
  }
  return out;
}
