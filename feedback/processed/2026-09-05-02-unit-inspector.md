type: req
priority: now

Click any piece (board, bench, shop card, sandbox) to inspect it; click empty space or Esc to close.

Inspector panel shows: name, tier/cost, star level, traits (with a one-line effect each), ability name + text with the current numbers filled in, stats as current value with base value and every modifier source listed on hover (trait, item, augment, ability, star), items equipped, mana current/max, and in combat the live values (hp, mana, shields, active stat mods) refreshed every tick.

While a piece is selected, its attack range is drawn as a hex ring on the board (attack range from its stats; ability range too if the ability has one). The hex under the cursor is highlighted; player half and enemy half are shaded differently at all times.

[designer note] Implement the panel as a pure `inspectorModel(state, uid)` function in src/app (unit-tested) with a thin DOM binding; the renderer only draws the ring and highlight from a selection field that lives outside sim state.

## Acceptance
- Test: inspectorModel lists every modifier source that contributes to a stat, and current == base × / + the listed modifiers.
- Test: selection never changes sim state or hashes.
- Manual checklist: shop, bench, board and sandbox pieces all open the panel; range ring matches attack range on three sample units.
