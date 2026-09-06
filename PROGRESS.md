# PROGRESS.md — Siege

## State
Bootstrap complete (2026-09-05). Cloud mode adopted (feedback/cloud-mode.md; see CLAUDE.md "Cloud task contract"). P0-01 (effect vocabulary v1), P0-B1 (sweep workers), P0-B2 (sweep robustness), P0-B3 (test worker count) and P0-15 (the `dev:` command namespace) are done: shields, tags, auras, projectiles, the ordered damage pipeline and the extended per-unit ledger are in, with `data/dev/` content that exercises every effect and trigger. No SPEC.md yet: all content in `data/dev/` is provisional (see QUESTIONS.md BOOT-01…15 and P0-01-01…13). The owner triage verdict of 2026-09-05 fixes the build order (owner-request items above QA-filed bugs; P0-B4/B5/B6/B7 deferred to the end of P0) — BACKLOG.md is rewritten in that order and CLAUDE.md carries the triage rule. Owner playtest round 1 (7 feedback files) is processed: the hex-board verdict is recorded verbatim under Owner overrides, and the six requests became items P0-15…P0-31 at the top of P0 (dev cheat commands and panel, battle sandbox, unit inspector, run HUD, augments, traits, items, combat FX) — see QUESTIONS.md FB-01…FB-04 for the ordering and the gating decisions.

## Next action
Continue BACKLOG.md P0 in the owner's verdict order: **P0-18 (sandbox screen)** next, then P0-19/P0-20 (unit inspector), P0-21…P0-24 (run HUD, round track, shop HUD, augments). P0-B4, P0-B5, P0-B6, P0-B7 and P0-B8 stay deferred to the end of P0.

## Pipeline checks
- `npm run check` — green (tsc + architecture test).
- `npm run test:fast` — green, 237 tests + 1 documented skip in 14 files; measured wall time **~4 s** (limit 5 min). It now spawns two nested vitest runs (tests/config.test.ts) to prove the gate cannot be silenced; they cost ~1.5 s.
- `npm test` (full, includes `tests/slow/build.test.ts`, two production builds) — last run at bootstrap; the next full run is due at P0 phase completion.
- Review: code-reviewer (REQUEST-CHANGES → all findings fixed except BOOT-16, logged) and qa-playtester (PASS on all acceptance criteria; 7 filed bugs fixed, bug 2's regression test deferred to P0-09).
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — prints winner, ticks, survivors, ledger, hash.
- `npm run sim -- --seed 1 --policy random` — full run report with per-round hashes.
- `npx tsx tools/sweep.ts --seeds 20 --policies random` — 20 runs × 4 workers, 0 exceptions, ~0.5 s (fixed in P0-B1; the worker graph must stay erasable TypeScript). Since P0-B2 a dead worker costs only its own job, `--out` and `SIEGE_SWEEP_WORKERS` are validated before the first job, and duplicate policies are de-duplicated.
- `npm run bench` — ~363 fights/s, ~285k ticks/s, budget ~0.43 sim ticks per baseline hash on the a-vs-b dev matchup (cloud host; the bootstrap figure of ~690 fights/s was a different machine). P0-01 costs ~15% throughput on content that uses none of the new features: richer `hit` events (raw/mitigated/absorbed) and the `maxHp` events. P0-10 records the budget.
- `npm run build` — production bundle contains no dev endpoint / overlay / dev client (grep test).
- inbox OK 2026-09-05 00:09

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

## Log
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
