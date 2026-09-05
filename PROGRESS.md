# PROGRESS.md — Siege

## State
Bootstrap complete (2026-09-05). Cloud mode adopted (feedback/cloud-mode.md; see CLAUDE.md "Cloud task contract"). P0-01 (effect vocabulary v1), P0-02 (attack types & projectiles) and P0-B1..B3 (sweep tooling) are done: shields, tags, auras, projectiles, the ordered damage pipeline and the extended per-unit ledger are in, with `data/dev/` content that exercises every effect and trigger. No SPEC.md yet: all content in `data/dev/` is provisional (see QUESTIONS.md BOOT-01…15 and P0-01-01…13).

## Next action
Run the loop on BACKLOG.md P0, top-down: P0-03 (fight end rules).

## Pipeline checks
- `npm run check` — green (tsc + architecture test).
- `npm run test:fast` — green, 218 tests + 1 documented skip in 13 files; measured wall time **~15 s** (limit 5 min). The sweep-liveness tests wait on real watchdog timers (~9 s of it); P0-14 revisits the budget.
- `npm test` (full, includes `tests/slow/build.test.ts`, two production builds) — last run at bootstrap; the next full run is due at P0 phase completion.
- Review: code-reviewer (REQUEST-CHANGES → all findings fixed except BOOT-16, logged) and qa-playtester (PASS on all acceptance criteria; 7 filed bugs fixed, bug 2's regression test deferred to P0-09).
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — prints winner, ticks, survivors, ledger, hash.
- `npm run sim -- --seed 1 --policy random` — full run report with per-round hashes.
- `npx tsx tools/sweep.ts --seeds 20 --policies random` — 20 runs × 4 workers, 0 exceptions, ~0.5 s (fixed in P0-B1; the worker graph must stay erasable TypeScript). A dying worker now costs only its own job (P0-B2).
- `npm run bench` — ~309 fights/s, ~242k ticks/s, budget ~0.58 sim ticks per baseline hash on the a-vs-b dev matchup (cloud host; the bootstrap figure of ~690 fights/s was a different machine). P0-01 cost ~15% throughput (richer `hit` events plus `maxHp` events) and P0-02 a further ~6% (the dev ranged units now allocate a projectile and two extra events per attack). P0-10 records the budget.
- `npm run build` — production bundle contains no dev endpoint / overlay / dev client (grep test).
- inbox OK 2026-09-05 00:09

## Commands
See README.md: `dev`, `build`, `preview`, `check`, `test`, `test:fast`, `fight`, `sim`, `sweep` (`npx tsx tools/sweep.ts`), `bench`.

## Known issues
- Fight resolution is sequential in uid order (left side acts first each tick), so a lethal board against its own mirror is not guaranteed to draw. Documented in QUESTIONS.md BOOT-16 with a `.skip` regression test (tests/fight.test.ts); P0-03 decides.
- `random` policy is weak by design (dies around round 8 with the provisional hp-loss table); `greedy` arrives with P0-04.
- The dev overlay loads `src/dev/index.ts` by URL (`@vite-ignore`) so production carries no dev chunk; if Vite's URL handling changes, the overlay silently logs "dev tools unavailable".
- Renderer has no drag-and-drop or letterboxing yet (P0-09).
- Hook chains are cut at `combat.maxHookDepth` (8): effects beyond that depth silently do not run.

## Log
- 2026-09-04 infrastructure committed
- 2026-09-05 bootstrap: engine skeleton + tooling (BOOTSTRAP.md §1–§9)
- 2026-09-05 fb: cloud mode — CLAUDE.md "Cloud task contract", lanes rewritten for cloud tasks, OPS.md "Cloud mode"
- 2026-09-05 P0-02 attack types & projectiles — ranged attacks fly, target shapes (radius/line/nearest) on the hex grid, projectiles drawn by the renderer; the line shape was rewritten during review to run through its target instead of stopping at it
- 2026-09-05 P0-B3 sweep worker liveness — per-job watchdog, exit grace, strict string flags; a timeout cap was tried and removed (it abandoned healthy jobs and made the report depend on --workers)
- 2026-09-05 P0-B2 sweep robustness — crashed workers, --out validation, SIEGE_SWEEP_WORKERS, duplicate policies; QA's residual findings (worker liveness, bare flags) -> BACKLOG P0-B3
- 2026-09-05 P0-B1 QA filed sweep-robustness findings (crashed worker discards results, `--out` into a missing dir, `SIEGE_SWEEP_WORKERS` unvalidated, duplicate policies) -> BACKLOG P0-B2
- 2026-09-05 P0-B1 sweep workers — the worker graph is loaded by Node's type stripping, so parameter properties broke it; codebase restricted to erasable TypeScript (`erasableSyntaxOnly` + a fast-tier token scan)
- 2026-09-05 P0-01 effect vocabulary v1 — code-reviewer REQUEST-CHANGES (M1 shield source collision, M2 aura hp heal, M3 hard-coded hook depth) and qa-playtester PASS with 7 filed bugs; all fixed with regression tests in the same item (shield instance keys, proportional max-hp, `combat.maxHookDepth` in data, death at 0 max hp, `maxHp` events for the renderer, stat saturation instead of throwing, projectile cycle rejection, onAttack/onHit tests, runtime dev-content coverage test)
