# PROGRESS.md — Siege

## State
Bootstrap complete (2026-09-05). Engine skeleton, data pipeline, headless tooling, renderer + app shell and the fast/slow test tiers exist; every P0 item in BACKLOG.md builds on them. No SPEC.md yet: all content in `data/dev/` is provisional (see QUESTIONS.md BOOT-01…15).

## Next action
Run the loop on BACKLOG.md P0, top-down: P0-01 (effect vocabulary v1).

## Pipeline checks
- `npm run check` — green (tsc + architecture test).
- `npm run test:fast` — green, 102 tests + 1 documented skip in 11 files; measured wall time **~1.8 s** (vitest reports ~0.9 s; limit 5 min).
- `npm test` (full, includes `tests/slow/build.test.ts`, two production builds) — green, 104 tests + 1 skip, **3.5 s** wall.
- Review: code-reviewer (REQUEST-CHANGES → all findings fixed except BOOT-16, logged) and qa-playtester (PASS on all acceptance criteria; 7 filed bugs fixed, bug 2's regression test deferred to P0-09).
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — prints winner, ticks, survivors, ledger, hash.
- `npm run sim -- --seed 1 --policy random` — full run report with per-round hashes.
- `npx tsx tools/sweep.ts --seeds 20 --policies random` — 20 runs × 4 workers, 0 exceptions, ~0.3 s.
- `npm run bench` — ~690 fights/s, ~540k ticks/s on the a-vs-b dev matchup (this host; P0-10 records the budget).
- `npm run build` — production bundle contains no dev endpoint / overlay / dev client (grep test).
- inbox OK 2026-09-05 00:09

## Commands
See README.md: `dev`, `build`, `preview`, `check`, `test`, `test:fast`, `fight`, `sim`, `sweep` (`npx tsx tools/sweep.ts`), `bench`.

## Known issues
- Fight resolution is sequential in uid order (left side acts first each tick), so a lethal board against its own mirror is not guaranteed to draw. Documented in QUESTIONS.md BOOT-16 with a `.skip` regression test (tests/fight.test.ts); P0-03 decides.
- `random` policy is weak by design (dies around round 8 with the provisional hp-loss table); `greedy` arrives with P0-04.
- The dev overlay loads `src/dev/index.ts` by URL (`@vite-ignore`) so production carries no dev chunk; if Vite's URL handling changes, the overlay silently logs "dev tools unavailable".
- Renderer has no drag-and-drop or letterboxing yet (P0-09).

## Log
- 2026-09-04 infrastructure committed
- 2026-09-05 bootstrap: engine skeleton + tooling (BOOTSTRAP.md §1–§9)
