// Item definitions and the recipe table (P0-27). Pure: no fight state, no RNG, no I/O.
import type { Effect } from './effects.ts';

export type ItemKind = 'component' | 'completed';

/** An item row (data): a `component` combines with another via the recipe table into a
 *  `completed` item; a `completed` item occupies one slot and combines with nothing further. */
export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** Authored `target: 'self'`, applied once to the holding unit — see `fight.ts`'s loadout phase. */
  effects: Effect[];
}

/** A recipe row (data): `components` (order-independent; the same component twice is a valid
 *  recipe) combine into `result`, a `completed` item. */
export interface RecipeDef {
  components: [string, string];
  result: string;
}

/** Order-independent recipe-table key: sorting the pair means `[a,b]`/`[b,a]` collide on
 *  purpose, and a same-component pair ("two of the same component is a valid recipe") maps to
 *  itself. Item ids are restricted to `[a-z0-9_.-]+` (schema), so `|` can never appear in one. */
export function recipeKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`;
}

export type LootDropKind = 'component' | 'completed' | 'choice';

/**
 * One row of an encounter's loot table (P0-28). A `component`/`completed` row grants one item,
 * drawn uniformly at random from `itemIds` on the `loot` RNG stream (every `itemIds` entry must
 * be that same kind — a loader check). A `choice` row instead offers every id in `itemIds`
 * verbatim, no RNG involved, for the player to pick exactly one via the `pickLoot` Command.
 */
export interface LootDropDef {
  kind: LootDropKind;
  itemIds: string[];
}

/**
 * The held item (its index in `heldItems`, and the resulting completed item id) that `itemId`
 * would combine with, or null if no held item is a component with a matching recipe. Returns the
 * first match in array order — a unit is expected to hold at most one uncombined component at a
 * time (combining happens immediately on the second), so ties are not expected in normal play,
 * but a deterministic first-match keeps this well-defined regardless (QUESTIONS.md P0-27-02).
 */
export function findCombineTarget(heldItems: readonly string[], itemId: string, itemsById: Record<string, ItemDef>, recipesByKey: Record<string, string>): { index: number; resultId: string } | null {
  for (let i = 0; i < heldItems.length; i++) {
    const held = heldItems[i] as string;
    const heldDef = itemsById[held];
    if (!heldDef || heldDef.kind !== 'component') continue;
    const resultId = recipesByKey[recipeKey(held, itemId)];
    if (resultId) return { index: i, resultId };
  }
  return null;
}
