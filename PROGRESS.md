# PROGRESS.md — Siege

## State
Bootstrap complete (2026-09-05). Cloud mode adopted (feedback/cloud-mode.md; see CLAUDE.md "Cloud task contract"). P0-01 (effect vocabulary v1), P0-B1 (sweep workers), P0-B2 (sweep robustness), P0-B3 (test worker count) and P0-15 (the `dev:` command namespace) are done: shields, tags, auras, projectiles, the ordered damage pipeline and the extended per-unit ledger are in, with `data/dev/` content that exercises every effect and trigger. No SPEC.md yet: all content in `data/dev/` is provisional (see QUESTIONS.md BOOT-01…15 and P0-01-01…13). The owner triage verdict of 2026-09-05 fixes the build order (owner-request items above QA-filed bugs; P0-B4/B5/B6/B7 deferred to the end of P0) — BACKLOG.md is rewritten in that order and CLAUDE.md carries the triage rule. Owner playtest round 1 (7 feedback files) is processed: the hex-board verdict is recorded verbatim under Owner overrides, and the six requests became items P0-15…P0-31 at the top of P0 (dev cheat commands and panel, battle sandbox, unit inspector, run HUD, augments, traits, items, combat FX) — see QUESTIONS.md FB-01…FB-04 for the ordering and the gating decisions.

## Next action
Continue BACKLOG.md P0 in the owner's verdict order: **P0-24 (augments)** next. P0-B4…P0-B15 stay deferred/queued per the triage rule (P0-B11/P0-B12 are money-path bugs QA filed on P0-20, ranked above the rest of section 3 but still below the remaining owner-request items; P0-B13/14/15 are P0-21 polish deferrals).

## Pipeline checks
- `npm run check` — green (tsc + architecture test, 99 tests).
- `npm run test:fast` — green, 361 tests + 1 documented skip in 22 files; measured wall time **~4.1 s** (limit 5 min).
- `npm test` (full, includes `tests/slow/build.test.ts`, two production builds) — last run at bootstrap; the next full run is due at P0 phase completion.
- Review: code-reviewer (REQUEST-CHANGES → all findings fixed except BOOT-16, logged) and qa-playtester (PASS on all acceptance criteria; 7 filed bugs fixed, bug 2's regression test deferred to P0-09).
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — prints winner, ticks, survivors, ledger, hash.
- `npm run sim -- --seed 1 --policy random` — full run report with per-round hashes.
- `npx tsx tools/sweep.ts --seeds 20 --policies random` — 20 runs × 4 workers, 0 exceptions, ~0.5 s (fixed in P0-B1; the worker graph must stay erasable TypeScript). Since P0-B2 a dead worker costs only its own job, `--out` and `SIEGE_SWEEP_WORKERS` are validated before the first job, and duplicate policies are de-duplicated.
- `npm run bench` — ~363 fights/s, ~285k ticks/s, budget ~0.43 sim ticks per baseline hash on the a-vs-b dev matchup (cloud host; the bootstrap figure of ~690 fights/s was a different machine). P0-01 costs ~15% throughput on content that uses none of the new features: richer `hit` events (raw/mitigated/absorbed) and the `maxHp` events. P0-10 records the budget.
- `npm run build` — production bundle contains no dev endpoint / overlay / dev client (grep test).
- inbox OK 2026-09-05 00:09

## Manual checklist — Shop HUD (P0-23)

`npm run dev` → New run. Automatically verified: `shopHudModel`'s odds row and costs match
`economy.shopOdds`/`rerollCost`/`xpCost` at three levels (1, 4, 7), and the maxLevel / past-maxLevel
fallback matches `drawUnit`'s own fallback expression exactly (tests/run.test.ts). Live-Playwright-verified
this item (odds chips render next to the level indicator with the right per-tier numbers and colours,
shop cards carry a `cost-tier-N` class matching each card's cost, reroll/buy-xp button labels match the
rules, the xp bar renders at the correct width at level 1) — a walk to a higher level to see several
non-zero-odds tiers rendered together at once was not exercised (starting gold only affords two buy-xp
clicks), left below for the owner. The checklist below is for the owner to tick by hand.

- [ ] Each shop card's left-edge colour matches its cost tier (grey/green/blue/purple/gold for 1g-5g)
- [ ] The odds row next to the level indicator shows one chip per cost tier, coloured the same as that tier's cards, with percentages matching `data/dev/rules.json`'s `economy.shopOdds[level]`
- [ ] The xp progress bar fills proportionally to xp/xpNeeded and reads "(max)" at the max level
- [ ] Reroll and Buy XP button labels show the correct gold costs from the rules

## Manual checklist — Round track (P0-22)

`npm run dev` → New run. Automatically verified: `EncounterSchema` rejects an unknown or missing
`type`; `roundTrack` matches the encounter list order and content, marks exactly the given round
current/every earlier round past, and is identical across a replay of the same seed at every round
along a full random-policy run (tests/run.test.ts, tests/data.test.ts). Live-Playwright-verified this
item (10 cells in round order with the right per-type colours and letters, the current-round ring
tracking through both fought and `dev:skipRound`-skipped rounds, past rounds dimmed, hover-title text
matching each round's actual gold/xp, an abandon-and-restart producing a fresh non-stale track,
sandbox unaffected). The checklist below is for the owner to tick by hand.

- [ ] The round track (top bar) shows one cell per round, in order, with a distinct colour/letter per encounter type
- [ ] The current round has a gold ring; every round before it is dimmed
- [ ] Hovering a cell shows a tooltip with that round's gold/xp reward (and "augment offer" on an augment round)
- [ ] The current-round marker advances correctly through a full run, including via `dev:skipRound`
- [ ] The round-end summary's "Next" line names the next round's type (not its raw id)

## Manual checklist — Income preview, gold panel & round-end summary (P0-21)

`npm run dev` → New run. Automatically verified: `incomePreview` matches `state.pendingReward` exactly
in the reward phase and previews base/interest/encounter (win bonus 0) pre-combat, the breakdown parts
sum to the total, and the total matches the gold actually granted at `nextRound` across 50 random-policy
runs to completion (tests/run.test.ts). Live-Playwright-verified this item (planning-phase gold-panel
line, the round-end summary after a fought win/loss and after `dev:skipRound`, hp-lost only showing when
non-zero, the interest amount tracking rising gold correctly through a full run, the "next round" line
on the second-to-last round, sandbox unaffected). The checklist below is for the owner to tick by hand.

- [ ] During planning, the gold panel shows a one-line breakdown ("Next round: +5 base, +1 interest (1g per 10, max 5), +0 encounter = +6 (+1 more on a win)")
- [ ] After combat resolves, the round-end summary replaces the gold panel: result line, hp lost (only when > 0), rewards itemized, next round's encounter id
- [ ] Clicking "Next round" hides the summary and shows the gold panel again for the new round
- [ ] The interest line's amount rises with gold and caps at the rule's max (`data/dev/rules.json`'s `economy.interest`)
- [ ] `dev:skipRound` (F2 panel) shows "Skipped (win)" in the summary with the same reward numbers a fought win would show

## Manual checklist — Inspector panel & board readability (P0-20)

`npm run dev` → New run (or Battle sandbox). Automatically verified: `rangeRings` against `hexesWithin`
on three sample dev units including one with an aura (tests/inspectorModel.test.ts), board shading
against `isPlayerCell` over the whole real board (tests/boardRender.test.ts). Live-Playwright-verified
this item (shop hover, bench/board/sandbox click-to-inspect, Escape closing without pausing, the range
ring rendering on both a placed board unit and a sandbox unit, a `range`-stat modifier moving the ring,
a stale-hover race across a buy click fixed via event delegation on the stable `.shop` container instead
of the rebuilt per-card buttons). The checklist below is for the owner to tick by hand.

- [ ] Hovering a shop card previews it in the panel; moving off hides it; clicking still buys (unchanged)
- [ ] Clicking a bench card opens the panel for that unit; clicking it again closes it (existing toggle)
- [ ] Clicking a unit placed on the board opens the panel and draws a gold hex-disc out to its attack range
- [ ] A unit with an aura (e.g. Dev Warden) also draws a dashed blue ring at its aura range
- [ ] In the sandbox, clicking a row's name opens the panel and rings its placed cell (mirrored on the right side); clicking it again closes it
- [ ] Esc closes the panel; a second Esc (nothing inspected) pauses, as before
- [ ] The board's player half and enemy half stay visibly shaded differently at all times, and the hex under the cursor highlights, in both the run and sandbox screens

Two money-path bugs surfaced only by driving a real browser through this checklist, not caused by
P0-20's own code — filed as P0-B11/P0-B12 (top-of-queue per the triage rule; see BACKLOG.md section 3):
canvas hit-testing uses stale geometry until a real window resize fires (breaks click accuracy briefly on
entering the run/sandbox screens), and a bench-to-board drag leaves `suppressClick` stuck, eating the
next board click once.

## Manual checklist — Battle sandbox screen (P0-18)

`npm run dev` → Title → "Battle sandbox". Automatically verified: every SandboxController
transition (tests/sandboxController.test.ts) and the title/sandbox screen transitions
(tests/screens.test.ts). Live-browser-driven with Playwright this item (enter, add units to both
sides, edit a stat override, run once, watch it play out, replay, run N, save, remove a unit,
load it back, exit — all confirmed working, including the two bugs that live testing caught and
fixed: a `NotFoundError` on editing a stat field, and Save reloading the whole page). The
checklist below is for the owner to tick by hand.

- [ ] "Battle sandbox" on the Title screen opens the screen; "Back to title" returns
- [ ] Clicking "+L <unit>" / "+R <unit>" in the roster adds that unit to the left/right list
- [ ] Editing star, an item list, or any stat-override field updates that unit only, live
- [ ] Removing a unit (×) drops it without disturbing the others
- [ ] "Run once" plays the fight through the board at 1×/2×/4× (speed buttons match the run screen's)
- [ ] "Replay" re-plays the same fight (same seed) without recomputing it
- [ ] "Run N" (default 50) shows the win-rate / mean+p95 ticks / per-unit table headlessly, no playback
- [ ] "Save" with a name writes `data/dev/boards/sandbox-<name>.json` and does not reload the page
- [ ] "Load" with that name restores the exact setup (units, stars, overrides, items, rules)
- [ ] An invalid name (uppercase, spaces, `..`) is rejected with a message, no request sent


## Manual checklist — F2 dev panel (P0-16)

`npm run dev` → New run → F2. Automatically verified: every button's Command is legal on a
fresh dev run and rejected in a production run (tests/devPanel.test.ts), and `dist/` carries no
panel (tests/slow/build.test.ts). The browser walkthrough below is for the owner; tick as checked.

- [ ] F2 opens the panel, F2 again closes it (also on the Title screen)
- [ ] Header shows the run seed and the content hash, and the round / phase / gold line follows the run
- [ ] gold `+10` / `+50` / `+1000` each raise gold by that amount
- [ ] xp `+10` / `+50` / `+1000` raise xp and level up at the table thresholds
- [ ] "Invincible pieces" flips on/off and its label matches the run (a rejected click leaves it as it was)
- [ ] "Invincible player" flips on/off; a lost round after it costs no hp
- [ ] "Skip round (win)" resolves the round as a win and moves to the reward phase
- [ ] "Open shop (tier n)" refills the shop from the selected tier for free
- [ ] "Spawn …" places the selected unit at the selected star onto the bench or the selected hex
- [ ] "Add augment" / "Give item" with an id typed into the boxes (empty is rejected with a reason)
- [ ] A rejected click shows its reason in the panel's `last` line
- [ ] Typing in the id boxes and pressing Space/R/X/S does not fire the run hotkeys


## Manual checklist — UI shell (P0-09)

`npm run dev` → New run. Automatically verified: letterbox maths, drop rules, click/drag
resolution, hotkey mapping, controller lifecycle (tests/uiShell.test.ts, tests/runController.test.ts,
tests/screens.test.ts). The browser walkthrough below is for the owner; tick as checked.

- [ ] Resizing the window keeps the board centred and 16:9, with bars on the short side
- [ ] Click a unit on the board: it is selected (gold ring); click it again: it goes to the bench
- [ ] Click a selected unit, then an empty hex: it is placed there; then another unit: they swap
- [ ] Drag a unit from the bench onto a hex: the hex rings green and the unit lands there
- [ ] Drag onto the enemy half or off the board: the ring is red and the HUD shows the reason
- [ ] Drag a unit back onto its own hex: nothing happens and nothing is selected
- [ ] `R` `X` `S` `Space` do what the pause screen's key list says; a mistimed key shows the sim's reason
- [ ] `1` `2` `3` change playback speed during a fight and while paused
- [ ] `Esc` pauses; typing in the seed box or a dev-panel id box does not pause
- [ ] Pause → Abandon run during a fight goes to the results screen, also when that fight ended the run
- [ ] The results screen lists every round, the seed and the final hash, and "Play again" starts a new run


## Commands
See README.md: `dev`, `build`, `preview`, `check`, `test`, `test:fast`, `fight`, `sim`, `sweep` (`npx tsx tools/sweep.ts`), `bench`.

## Known issues
- `npm run test:fast -- --maxWorkers=-5` still collects nothing and exits 0: P0-B3 fixed the `SIEGE_TEST_WORKERS` route into that failure, but vitest does not validate the `--maxWorkers` flag itself. Filed as P0-B6; never pass a worker count as a flag, use the env var.
- `tools/*` CLIs ignore unknown flags and stray positionals, so a typo (`--seed` for `--seeds`) silently runs a different sweep. Filed as P0-B4.
- CLAUDE.md and the sweep/sim headers document a `greedy` policy that does not exist yet (`--policies random,greedy` is a usage error). P0-04 adds it.
- Fight resolution is sequential in uid order (left side acts first each tick), so a lethal board against its own mirror is not guaranteed to draw. Documented in QUESTIONS.md BOOT-16 with a `.skip` regression test (tests/fight.test.ts); P0-03 decides.
- `random` policy is weak by design (dies around round 8 with the provisional hp-loss table); `greedy` arrives with P0-04.
- The dev overlay loads `src/dev/index.ts` by URL (`@vite-ignore`) so production carries no dev chunk; if Vite's URL handling changes, the overlay silently logs "dev tools unavailable".
- Hook chains are cut at `combat.maxHookDepth` (8): effects beyond that depth silently do not run.
- `dev:spawnUnit` refuses a full bench even when a merge is guaranteed, where `buy` allows it (P0-B7, deferred).
- Nothing writes a `RunLog` yet, so the F2 panel's seed + content hash cannot on their own reproduce a cheated run; the command log needs an export path (P0-05 save/load, P0-13 telemetry).
- `dev:addAugment` / `dev:giveItem` accept any well-formed id and grow `state.augments` / `state.itemBench` without limit; P0-24 and P0-27 add the real content lookups (QUESTIONS.md P0-15-03).
- `BoardRenderer.resize()` runs before the screen's real DOM content lays out the `#app` CSS grid, so `cellAt` hit-testing briefly uses stale, oversized geometry on entering the run/sandbox screens until any window resize fires. Filed as P0-B11 (QA on P0-20, top-of-queue: breaks a money path).
- A bench-to-board drag's trailing native `click` never fires on the canvas (the `mousedown` and `mouseup` targets differ), so `suppressClick` stays `true` and silently eats the next real board click. Filed as P0-B12 (QA on P0-20, top-of-queue: breaks a money path).

## Log
- 2026-09-07 P0-23 shop HUD — `src/sim/run.ts` gets `ShopHudModel`/`shopHudModel(state, content)`: level, xp, `xpNeeded` (null at max level), `xpProgress` (0..1, clamped, 1 at/above max level), and a `ShopOddsRow[]` read straight off `economy.shopOdds[level]` with the exact same maxLevel fallback `drawUnit` already uses, plus `rerollCost`/`xpCost` verbatim — so the HUD's odds can never drift from what the shop actually draws. `src/ui/runUi.ts`'s level indicator becomes a small block (level/xp text, an xp progress bar, a row of per-tier odds chips) built only from `shopHudModel`, and the reroll/buy-xp button costs and each shop card's `cost-tier-<cost>` class read the same model instead of poking `content.rules.economy` directly (closing the last two direct `eco.*` reads in `src/ui`). `src/app/style.css` gets `.cost-tier-1`..`.cost-tier-5` (named to avoid colliding with the trait "tier" concept P0-26 will introduce), `.hud-level`/`.xp-bar`/`.shop-odds`/`.odds-chip`, and a `.shop-card` border-left accent. code-reviewer APPROVE (no Critical/Major; two Minor notes — the 5-class tier palette is coupled to today's 5 cost tiers with no explicit handling if content ever adds a 6th, and one test level choice added little coverage beyond the maxLevel/fallback cases — the second fixed by swapping the test's level set; the first left as-is, matching CLAUDE.md's rule against unrequested abstractions). qa-playtester PASS on both acceptance criteria (independently re-derived the odds/cost numbers from `data/dev/rules.json` in a throwaway script for three levels plus maxLevel and past-maxLevel, grepped `src/ui` for stray tuning literals, fuzzed level 0/negative/at-threshold/negative-xp inputs — no throw in any case, one informational-only quirk noted at the unreachable level-0 case) and the manual checklist via live Playwright (odds chips, tier-coloured cards, button costs, xp bar all confirmed at level 1; a higher-level multi-tier visual pass deferred to the owner checklist since starting gold doesn't reach one)
- 2026-09-07 P0-22 round track — `Encounter` gets a `type` field (`normal|elite|boss|treasure|augment`, `ENCOUNTER_TYPES` in `src/sim/rules.ts`, validated by `EncounterSchema`); all 10 `data/dev/encounters.json` rounds assigned a type mix purely to exercise every icon (QUESTIONS.md P0-22-01: this is a display label today, not a difficulty/mechanic change). `src/sim/run.ts` gets `roundTrack(round, content)`: one `RoundTrackEntry` per encounter with `isCurrent`/`isPast` and a `rewardPreview` (gold, xp, `items: []` and `augmentOffer` as placeholders until P0-24/P0-28 give them content, P0-22-02). `src/ui/runUi.ts` renders it as a `.round-track` bar of coloured letter cells above the HUD, current ringed, past dimmed, a native `title` tooltip per cell (P0-22-03) — and, since `type` now exists, the P0-21 round-end summary's "Next" line was switched from the encounter id to its type, closing the gap QUESTIONS.md P0-21-03 flagged. code-reviewer APPROVE (one Minor: the replay-determinism test compared `roundTrack` against itself at the same inputs rather than against independently-captured live snapshots — fixed to capture `roundTrack` from the live run as it progresses and compare the replay against those snapshots, so the check is no longer tautological). qa-playtester PASS on both acceptance criteria (independently fuzzed the schema with missing/invalid/wrong-type `type` values against both `EncounterSchema.safeParse` and a mutated `data/dev/encounters.json` through the real loader) and the manual checklist; one finding (the stale id-vs-type "Next" line, exactly the gap P0-21-03 predicted P0-22 would close) fixed in the same pass rather than deferred, since it was this item's own follow-through
- 2026-09-07 P0-21 income preview, gold panel & round-end summary — `src/sim/run.ts` gets `IncomePreview`/`incomePreview(state, content)`: base income, interest (with the rule it applied), a `streakBonus` field (always 0 — no streak mechanic exists, only a flat `winBonus`; QUESTIONS.md P0-21-01) and encounter reward gold, matching `state.pendingReward` exactly in the `reward` phase and previewing the same amounts pre-combat with `winBonus: 0` (the outcome isn't known yet, P0-21-02). `src/ui/runUi.ts` renders it two ways from the same sim numbers: a compact `incomeLine` in the planning-phase gold panel, and itemized `summaryLines` in a new round-end summary shown only in the `reward` phase (result, hp lost when non-zero, rewards line by line, the next round's encounter — its `id` stands in for "type" since the schema has no `type` field until P0-22, P0-21-03); neither formatter performs any gold arithmetic, only reads `IncomePreview` fields and rule constants (`eco.interest.per/max`, `eco.winBonus`, `eco.xpPerRound`) verbatim for labels. code-reviewer APPROVE (one Minor: the 50-seed sweep test didn't assert every run actually reached `'ended'`, a latent vacuous-pass risk — fixed with an explicit assertion). qa-playtester PASS on all three acceptance criteria (independently re-derived `incomePreview` against `computeReward` at gold amounts spanning the interest cap, a zero-encounter-reward round, and the final-round-ends-without-a-reward-phase case) and the manual checklist; three non-blocking findings filed as `[polish] (deferred)` at the end of P0 — P0-B13 (an unreachable "run ends here" branch in `summaryLines`), P0-B14 (two unrelated DOM elements share the `run-ui`/`hud` CSS classes, a testability footgun), P0-B15 (an intermittent, unrelated 404 console error)
- 2026-09-07 P0-20 inspector panel & board readability — `src/sim/hex.ts`'s `cellsWithin` renamed `hexesWithin` (matches the acceptance text); `src/app/inspectorModel.ts` gets `shopPreviewModel`/`sandboxPreviewModel` (tier-1/stat-override previews with no `uid`, sharing a new `buildModel` extracted from `inspectorModel`) and `rangeRings(model, content, origin)` (attack disc from the model's current `range` stat, aura ring from `def.aura.range`); `src/render/board.ts` gets `cellHalf` (single source of truth for the player/enemy shading, replacing an inlined row check) and a `rangeRing` view field drawn as hex outlines. New `src/ui/inspectorUi.ts` DOM panel; shop cards preview on hover (delegated to the stable `.shop` container, not the per-card buttons that `replaceChildren()` rebuilds on every buy/reroll — a real stale-hover bug found and fixed via live Playwright testing); board/bench reuse `RunController.selectedUid`, sandbox rows get their own `selected` field on `SandboxController`; Esc closes the inspector before falling through to the pause hotkey. Nine QUESTIONS.md entries (P0-20-01…08) record the deliberate calls: `hexesWithin` naming, "ring" = the inclusive disc per the acceptance text (not the exact-radius `ring()`), ability range = aura range only (no other range-bearing ability shape exists), shop hover instead of click (click already buys), board/bench selection reused instead of a new field, combat-time live inspection deferred, `uid` widened to nullable, and the Escape-then-pause ordering. code-reviewer APPROVE (two Minor + one Nit: stale `hoveredShopDefId` surviving a screen change, Escape-interception ordered ahead of the input-focus guard, the Escape-then-pause tradeoff undocumented — all three fixed/logged in the same pass). qa-playtester PASS on both objective acceptance criteria (independently re-derived `rangeRings` against `hexesWithin` on its own three units including an aura-bearing one, and the board-shading split against `data/board.json`) and the manual checklist, but found two pre-existing (P0-09) money-path bugs live-testing the workflow — filed top-of-queue as P0-B11 (canvas hit-testing uses stale geometry until a window resize fires) and P0-B12 (a bench-to-board drag leaves `suppressClick` stuck, eating the next board click) per the triage rule, ranked above the rest of BACKLOG.md section 3 but still below the remaining owner-request items
- 2026-09-06 P0-19 unit inspector model — `src/app/inspectorModel.ts`: pure `inspectorModel(state, uid, content, combat?)` (content is a required third argument, matching every other view-model function in this codebase — see QUESTIONS.md P0-19-02) resolves a bench/board unit's name/cost/star/items/mana, every stat as base + current + the exact list of contributing `Modifier`s (from an optional caller-supplied `CombatOverlay`, since `RunState` itself never carries live per-unit values), and an ability's effects rendered to text with any `scaling` resolved against current stats. `traits` stays `[]` until P0-25. code-reviewer REQUEST-CHANGES (Major: `items` aliased `RunState`'s live array instead of being copied; Major: the test suite only exercised cross-source stat stacking, never CLAUDE.md's same-source-ranks-add case) — both fixed, the second with a same-source `attackSpeed` case that pins the grouping behaviour instead of just re-deriving the implementation's output. qa-playtester PASS on both acceptance criteria (independently re-derived the stacking math against `computeStat`, adversarially probed uid edge cases and a mul-modifier-on-a-flat-stat throw); one finding filed as P0-B10 (deferred: `sources` still aliases the caller's `Modifier` objects one level down, currently unreachable since nothing calls `inspectorModel` yet)
- 2026-09-06 P0-18 battle sandbox screen — Title → Sandbox: `src/app/sandboxController.ts` (editable `SandboxSetup`, `runOnce`/`replay`/`runN` on P0-17's `sandbox.ts`, save/load via an injected `SandboxPersistence` kept out of the static import graph so the production bundle stays clean) and `src/ui/sandboxUi.ts` (roster, per-unit editors, fight-rule inputs, 1/2/4× playback, an aggregate results table). `src/app/playback.ts` extracts the fight-playback tick/advance logic out of `runController.ts` so both controllers share it. A new `sandbox` screen (`src/app/screens.ts`) with no pause support. code-reviewer APPROVE (checked the playback-extraction semantics, the persistence-injection boundary against the production-build grep test, and a render-coalescing fix — no Critical/Major findings). qa-playtester found one top-of-queue bug via live Playwright testing: saving a setup with a long enough name threw `ENAMETOOLONG` uncaught inside the dev data endpoint's POST handler (`tools/vite-dev-data-plugin.ts`), crashing the whole `npm run dev` process — fixed with a try/catch reply plus a matching length cap in `kindForPath` and the client-side name check, regression-tested in `tests/devDataPlugin.test.ts`; two smaller findings (a missing `.gitignore` entry for runtime-saved sandbox files, a raw absolute path in a failed-load error message) fixed in the same pass; one Tab-navigation polish bug in the stat-override row rebuild filed as P0-B9 (deferred, dev-tool-only). Also found and fixed during my own pre-review manual browser testing (not QA): a `NotFoundError` when editing a stat field (a `change`-event handler synchronously rebuilding the very DOM row it fired from — fixed with a coalescing `queueMicrotask` in `sandboxUi.ts`) and Save reloading the whole page and wiping the in-progress session (Vite's default full-reload on a new file matching `src/data/browser.ts`'s eager `import.meta.glob` — fixed by excluding `dev/boards/sandbox-*.json` from `vite.config.ts`'s `server.watch`). Both are recorded in QUESTIONS.md under "P0-18"
- 2026-09-06 P0-17 battle sandbox core — `src/sim/sandbox.ts` (`SandboxSetup`/`runSandbox`) aggregates `n` repeated `fight()` calls (seeds `seed..seed+n-1`) over a hand-authored two-side setup with per-unit star/items/stat overrides and fight-rule overrides (`maxSeconds`, an inert `overtime` placeholder for P0-03); each sandbox unit gets a synthetic per-instance `UnitDef` (`sandbox:<side>:<index>`) so units sharing a `defId` can carry independent overrides without colliding in `FightRules.units`, with an owners map attributing ledger totals back to the authored unit. New `SandboxSetupFileSchema`/`loadSandboxSetupFile`/`loadSandboxSetupFromDisk` round-trip a setup through `data/dev/boards/sandbox-<name>.json` (a new `sandboxSetupFile` kind in `kindForPath`, distinct from plain `boardFile`s in the same directory). code-reviewer REQUEST-CHANGES (Major: two QUESTIONS.md citations in code comments pointed at an entry that did not exist) — fixed by adding the QUESTIONS.md P0-17 section (P0-17-01/02); Minor (`_provisional` leaking into the returned `SandboxSetup`) also fixed. qa-playtester PASS on all three acceptance criteria (aggregation matches a direct `fight()` loop including on a hostile 3-unit/duplicate-defId setup; save/load round-trips and strips `_provisional`; `sandbox.ts` imports nothing from `run.ts`); one finding filed as P0-B8 (deferred, a degenerate empty-name `sandbox-.json` mis-routes to `boardFile` in `kindForPath`), the rest (huge `n` performance, mirror-setup fairness, pre-existing lack of a `greedy` policy) are informational/out of scope for this item
- 2026-09-05 P0-09 UI shell hardening — `src/app/main.ts` is now glue over four testable modules: `runController.ts` (run state, dispatch, playback, abandon), `pointer.ts` + `drag.ts` (click and drop rules), `hotkeys.ts` (key mapping) and `render/layout.ts` (16:9 letterbox, drawn with bars and a green/red drop ring). code-reviewer REQUEST-CHANGES (Critical: mousedown selected the unit, so a single click on a board unit benched it; Major: abandoning during the playback of a run-ending fight soft-locked the run screen; Major: the bench card was rebuilt mid-gesture) and qa-playtester FAIL on the same three plus dead speed hotkeys during playback — all fixed and covered by tests (`boardClick`/`boardDrop`, the abandon-after-end case, `advance` clamps, `startPlayback` completing a pending playback, letterbox NaN guards, the screen sweep now varies `paused`). QA's 310k-case drop sweep produced no command the sim would reject; controller-dispatched logs still replay hash for hash on seeds 1-10
- 2026-09-05 P0-16 dev panel (F2) — `src/dev/panelModel.ts` (pure: one button per `dev:` command, the row plan, the info lines) + `src/dev/panel.ts` (DOM), created inside the existing DEV-guarded dynamic import so production carries none of it; every button dispatches through `main.ts`'s `dispatch`, which now returns `{ ok, reason }` so a rejected or dropped click reports a reason instead of vanishing. code-reviewer REQUEST-CHANGES (Major: the panel mirrored the invincibility toggles optimistically, so a rejected click could label a cheat "on" while the sim had it off) — fixed by deriving the toggles from the run through `syncPanelModel`, plus a typed row plan with keep-counts, panel-focus-aware hotkeys, `isPlayerCell` for the spawn cells, empty-by-default ids, and string-literal tokens in the production-build grep test (identifiers are minified away). qa-playtester PASS on all three acceptance criteria (~2679 panel-issued commands per seed over seeds 1-10: invariants clean, every log replays hash for hash, no leak into `dist/`)
- 2026-09-05 P0-15 `dev:` command namespace — nine cheats as sim Commands (`src/sim/devCommands.ts`) gated by `RunConfig.devCommands`, recorded in the log and replayable (`replayRun`/`replayLog` take the flag); `dev:invinciblePieces` is a `FightRules.invincible` damage clamp, `dev:skipRound` records a round with `fight: null` + `skipped: true`. code-reviewer REQUEST-CHANGES (Major: `dev:gold` could reach `Infinity` and make every later state hash throw) — fixed with a `2 ** 40` cap, plus own-property lookups so a `__proto__`/`constructor` id cannot poison the pool, a pool-capacity cap on `returnToPool` with a matching invariant, `onTakeDamage` still firing under the clamp, `replayLog`, and `devCommands:!0` added to the production-build grep test. qa-playtester PASS on all three acceptance criteria (fuzzed dev-command logs over seeds 1–10 all replay hash for hash); of its 4 findings, 3 are fixed here and the `buy`/`dev:spawnUnit` full-bench divergence is filed as P0-B7 (deferred, per the owner triage rule)
- 2026-09-05 fb: triage verdict — owner-request items outrank QA-filed bugs; BACKLOG.md P0 rewritten in the verdict's order, P0-B4/B5/B6 deferred to the end of P0, triage rule added to CLAUDE.md "Subagent protocol", verdict recorded verbatim in QUESTIONS.md
- 2026-09-05 P0-B3 test worker count — an invalid `SIEGE_TEST_WORKERS` made vitest collect nothing and still exit 0; `tools/testWorkers.ts` now throws on an unusable value and clamps above the cap (QUESTIONS.md P0-B3-01/02). code-reviewer APPROVE with minors (clamp instead of reject, spawn timeout, pruned child env) and qa-playtester PASS on all four criteria with 4 findings — 3 fixed here (stale docs, no positive end-to-end case, spawn assertions passing for the wrong reason), the flag route filed as P0-B6
- 2026-09-05 fb: owner playtest round 1 — hex verdict recorded verbatim; 6 requests filed as P0-15…P0-31 (QUESTIONS.md FB-01…FB-04)
- 2026-09-05 P0-B2 sweep robustness — a dead worker no longer discards the sweep (one result per (policy, seed) always), `--out` and `SIEGE_SWEEP_WORKERS` are pre-flighted, duplicate policies de-duplicated; code-reviewer REQUEST-CHANGES (Major: a synchronous `new Worker` throw still sank the sweep) fixed with a regression test, qa-playtester PASS on all four acceptance criteria with 8 findings — 2 fixed here (meanMs diluted by jobs that never ran; the env/flag whitespace parity claim), the rest filed as P0-B3/B4/B5
- 2026-09-04 infrastructure committed
- 2026-09-05 bootstrap: engine skeleton + tooling (BOOTSTRAP.md §1–§9)
- 2026-09-05 fb: cloud mode — CLAUDE.md "Cloud task contract", lanes rewritten for cloud tasks, OPS.md "Cloud mode"
- 2026-09-05 P0-B1 QA filed sweep-robustness findings (crashed worker discards results, `--out` into a missing dir, `SIEGE_SWEEP_WORKERS` unvalidated, duplicate policies) -> BACKLOG P0-B2
- 2026-09-05 P0-B1 sweep workers — the worker graph is loaded by Node's type stripping, so parameter properties broke it; codebase restricted to erasable TypeScript (`erasableSyntaxOnly` + a fast-tier token scan)
- 2026-09-05 P0-01 effect vocabulary v1 — code-reviewer REQUEST-CHANGES (M1 shield source collision, M2 aura hp heal, M3 hard-coded hook depth) and qa-playtester PASS with 7 filed bugs; all fixed with regression tests in the same item (shield instance keys, proportional max-hp, `combat.maxHookDepth` in data, death at 0 max hp, `maxHp` events for the renderer, stat saturation instead of throwing, projectile cycle rejection, onAttack/onHit tests, runtime dev-content coverage test)
