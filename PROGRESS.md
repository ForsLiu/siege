# PROGRESS.md — Siege

## State
Bootstrap complete (2026-09-05). Cloud mode adopted (feedback/cloud-mode.md; see CLAUDE.md "Cloud task contract"). P0-01 (effect vocabulary v1), P0-B1 (sweep workers), P0-B2 (sweep robustness) and P0-B3 (test worker count) are done: shields, tags, auras, projectiles, the ordered damage pipeline and the extended per-unit ledger are in, with `data/dev/` content that exercises every effect and trigger. No SPEC.md yet: all content in `data/dev/` is provisional (see QUESTIONS.md BOOT-01…15 and P0-01-01…13). Owner playtest round 1 (7 feedback files) is processed: the hex-board verdict is recorded verbatim under Owner overrides, and the six requests became items P0-15…P0-31 at the top of P0 (dev cheat commands and panel, battle sandbox, unit inspector, run HUD, augments, traits, items, combat FX) — see QUESTIONS.md FB-01…FB-04 for the ordering and the gating decisions.

## Next action
Run the loop on BACKLOG.md P0, top-down: P0-B4 (CLIs ignore typo'd flags), P0-B5 (sweep watchdog + CLI failure-path test), P0-B6 (`--maxWorkers=-5` still empties the gate), then the owner playtest items from P0-15 (dev commands, dev panel, sandbox, inspector, run HUD).

## Pipeline checks
- `npm run check` — green (tsc + architecture test).
- `npm run test:fast` — green, 204 tests + 1 documented skip in 13 files; measured wall time **~4 s** (limit 5 min). It now spawns two nested vitest runs (tests/config.test.ts) to prove the gate cannot be silenced; they cost ~1.5 s.
- `npm test` (full, includes `tests/slow/build.test.ts`, two production builds) — last run at bootstrap; the next full run is due at P0 phase completion.
- Review: code-reviewer (REQUEST-CHANGES → all findings fixed except BOOT-16, logged) and qa-playtester (PASS on all acceptance criteria; 7 filed bugs fixed, bug 2's regression test deferred to P0-09).
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — prints winner, ticks, survivors, ledger, hash.
- `npm run sim -- --seed 1 --policy random` — full run report with per-round hashes.
- `npx tsx tools/sweep.ts --seeds 20 --policies random` — 20 runs × 4 workers, 0 exceptions, ~0.5 s (fixed in P0-B1; the worker graph must stay erasable TypeScript). Since P0-B2 a dead worker costs only its own job, `--out` and `SIEGE_SWEEP_WORKERS` are validated before the first job, and duplicate policies are de-duplicated.
- `npm run bench` — ~363 fights/s, ~285k ticks/s, budget ~0.43 sim ticks per baseline hash on the a-vs-b dev matchup (cloud host; the bootstrap figure of ~690 fights/s was a different machine). P0-01 costs ~15% throughput on content that uses none of the new features: richer `hit` events (raw/mitigated/absorbed) and the `maxHp` events. P0-10 records the budget.
- `npm run build` — production bundle contains no dev endpoint / overlay / dev client (grep test).
- inbox OK 2026-09-05 00:09

## Commands
See README.md: `dev`, `build`, `preview`, `check`, `test`, `test:fast`, `fight`, `sim`, `sweep` (`npx tsx tools/sweep.ts`), `bench`.

## Known issues
- `npm run test:fast -- --maxWorkers=-5` still collects nothing and exits 0: P0-B3 fixed the `SIEGE_TEST_WORKERS` route into that failure, but vitest does not validate the `--maxWorkers` flag itself. Filed as P0-B6; never pass a worker count as a flag, use the env var.
- `tools/*` CLIs ignore unknown flags and stray positionals, so a typo (`--seed` for `--seeds`) silently runs a different sweep. Filed as P0-B4.
- CLAUDE.md and the sweep/sim headers document a `greedy` policy that does not exist yet (`--policies random,greedy` is a usage error). P0-04 adds it.
- Fight resolution is sequential in uid order (left side acts first each tick), so a lethal board against its own mirror is not guaranteed to draw. Documented in QUESTIONS.md BOOT-16 with a `.skip` regression test (tests/fight.test.ts); P0-03 decides.
- `random` policy is weak by design (dies around round 8 with the provisional hp-loss table); `greedy` arrives with P0-04.
- The dev overlay loads `src/dev/index.ts` by URL (`@vite-ignore`) so production carries no dev chunk; if Vite's URL handling changes, the overlay silently logs "dev tools unavailable".
- Renderer has no drag-and-drop or letterboxing yet (P0-09).
- Hook chains are cut at `combat.maxHookDepth` (8): effects beyond that depth silently do not run.

## Log
- 2026-09-05 P0-B3 test worker count — an invalid `SIEGE_TEST_WORKERS` made vitest collect nothing and still exit 0; `tools/testWorkers.ts` now throws on an unusable value and clamps above the cap (QUESTIONS.md P0-B3-01/02). code-reviewer APPROVE with minors (clamp instead of reject, spawn timeout, pruned child env) and qa-playtester PASS on all four criteria with 4 findings — 3 fixed here (stale docs, no positive end-to-end case, spawn assertions passing for the wrong reason), the flag route filed as P0-B6
- 2026-09-05 fb: owner playtest round 1 — hex verdict recorded verbatim; 6 requests filed as P0-15…P0-31 (QUESTIONS.md FB-01…FB-04)
- 2026-09-05 P0-B2 sweep robustness — a dead worker no longer discards the sweep (one result per (policy, seed) always), `--out` and `SIEGE_SWEEP_WORKERS` are pre-flighted, duplicate policies de-duplicated; code-reviewer REQUEST-CHANGES (Major: a synchronous `new Worker` throw still sank the sweep) fixed with a regression test, qa-playtester PASS on all four acceptance criteria with 8 findings — 2 fixed here (meanMs diluted by jobs that never ran; the env/flag whitespace parity claim), the rest filed as P0-B3/B4/B5
- 2026-09-04 infrastructure committed
- 2026-09-05 bootstrap: engine skeleton + tooling (BOOTSTRAP.md §1–§9)
- 2026-09-05 fb: cloud mode — CLAUDE.md "Cloud task contract", lanes rewritten for cloud tasks, OPS.md "Cloud mode"
- 2026-09-05 P0-B1 QA filed sweep-robustness findings (crashed worker discards results, `--out` into a missing dir, `SIEGE_SWEEP_WORKERS` unvalidated, duplicate policies) -> BACKLOG P0-B2
- 2026-09-05 P0-B1 sweep workers — the worker graph is loaded by Node's type stripping, so parameter properties broke it; codebase restricted to erasable TypeScript (`erasableSyntaxOnly` + a fast-tier token scan)
- 2026-09-05 P0-01 effect vocabulary v1 — code-reviewer REQUEST-CHANGES (M1 shield source collision, M2 aura hp heal, M3 hard-coded hook depth) and qa-playtester PASS with 7 filed bugs; all fixed with regression tests in the same item (shield instance keys, proportional max-hp, `combat.maxHookDepth` in data, death at 0 max hp, `maxHp` events for the renderer, stat saturation instead of throwing, projectile cycle rejection, onAttack/onHit tests, runtime dev-content coverage test)
