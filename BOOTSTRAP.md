# BOOTSTRAP.md — one-time project scaffold (interactive session; never run again)

Goal: a tested, deterministic engine skeleton plus the tooling the unattended loop needs, so BACKLOG.md P0 items and later SPEC phases can run without human help. Engine and tooling only — design no game content. Every number you must choose goes into `data/dev/` marked provisional and gets a QUESTIONS.md "Open decisions" entry.

Do the sections in order. Commit at every green point. Stop when §9 is done.

## 1. Tooling
- Verify Node ≥ 22, npm, git. If Node is missing, install it (`winget install OpenJS.NodeJS.LTS`) and continue.
- `npm init -y`; devDependencies: typescript, vite, vitest, tsx, @types/node; dependency: zod. Exact versions in package.json.
- `tsconfig.json`: strict, ES2022 target, bundler resolution. Relative imports or path aliases — pick one, stay consistent.
- `vitest.config.ts`: tests in `tests/**/*.test.ts`; worker count from `process.env.SIEGE_TEST_WORKERS` via `tools/testWorkers.ts` (default 4; a non-integer or a count below 1 throws, above 64 clamps); `test:fast` excludes `tests/slow/**`.
- package.json scripts: `dev`, `build`, `preview`, `check` (tsc --noEmit + architecture test), `test` (full), `test:fast`, `fight`, `sim`, `sweep`, `bench`.
- `.gitignore` already exists — extend if needed. README.md: how to run, play, test, and use every tool.

## 2. Layout
```
src/sim/       pure deterministic simulation: board, units, stats, effects, fight, run state, commands, rng, hash
src/data/      zod schemas, loader, content hash
src/render/    canvas renderer (reads sim state, consumes sim events)
src/ui/        DOM overlays: shop, bench, HUD, screens
src/app/       game loop glue, screen state machine, save/load, input mapping
src/dev/       dev-only tools (overlay, Tuner, Codex, replay) — excluded from production builds
data/          JSON content; data/dev/ holds provisional sample content for engine tests
tools/         headless CLIs: fight.ts, sim.ts, sweep.ts, bench.ts, policies/
tests/         fast tests; tests/slow/ for anything over ~20 s
```

## 3. Sim skeleton (content-agnostic; all numbers from data/dev)
- `rng.ts`: seeded generator (sfc32 or xoshiro128**), named streams derived from (runSeed, streamName), each with `next()`, `int(n)`, `pick(arr)`, `shuffle(arr)`.
- `hex.ts`: offset ↔ axial conversion, hex distance, neighbors, rings, deterministic BFS pathing with blocked cells and stable tie-breaks. Board size from `data/board.json`.
- `stats.ts`: StatBlock, `STAT_KIND` (mul | flat), modifier sources with stacking (different sources multiply, ranks within a source add, flats add), computed stats cached per tick.
- `units.ts`: unit definition from data (id, cost/tier, base stats per star level, ability ref, tags); unit instance (uid, star, position, hp, mana, modifiers, item slots placeholder).
- `effects.ts`: minimal effect interpreter and hook bus — `damage`, `heal`, `statMod` (mul|flat, duration), `stun`; hooks `onCombatStart`, `onAttack`, `onHit`, `onCast`, `onKill`, `onDeath`. Keep it small; P0-01 extends it.
- `fight.ts`: `fight(left, right, seed, rules) → FightResult`. Per tick: targeting (nearest by hex distance, stable tie-break), movement along the BFS path, attack timers from attack speed, mana gain on attack and on being hit, ability cast at full mana through the interpreter, death and cleanup, timeout from `rules.maxSeconds` (draw on timeout for now; P0-03 finalizes). Emits an ordered event list (move, attack, hit, cast, death) for the renderer and for tests. Never reads global state.
- `run.ts` + `commands.ts` — TFT-standard mechanisms with provisional numbers in `data/dev/rules.json`: gold; shop of N slots drawn from a shared pool by level odds; xp/level with a cap; team-size cap = level; bench of B slots; place / bench / swap / sell; reroll cost; 3-copy merge into the next star (chained merges); rounds `planning → combat vs encounter board → reward → next`; player hp loss on defeat from a data table; run ends at hp 0 or after the last encounter. Encounters and the unit pool come from `data/dev/`. Every action is a Command with validation and a rejection reason; `legalCommands(state)` lists what a bot may do.
- `hash.ts`: canonical JSON (sorted keys) → FNV-1a 64. Hash at every round boundary and at run end; stored in the run report.
- `replay.ts`: (seed, commandLog) → identical hashes.

## 4. Data pipeline
- `src/data/schemas.ts`: zod schemas for board, rules, units, encounters. Traits, items and augments arrive with SPEC — leave clearly named extension points. Unknown keys and unknown effect names are rejected.
- The loader validates every file at startup and in tests; `contentHash` (sha-256 of the canonical concatenation) goes into RunConfig and the dev overlay.
- Dev-server data endpoint (Vite plugin, dev only): `POST /__data/<file>` validates with the schema and writes to `/data`. The production build must contain neither the endpoint nor the dev tools (verify with a grep test over `dist/`).

## 5. Headless tooling
- `tools/fight.ts`: two board JSON files + seed → result summary + hash; `--events` dumps the event log.
- `tools/sim.ts`: full run with a bot policy (`random` now; `tools/policies/` is the plug-in folder, P0-04 adds `greedy`) → run report JSON: rounds survived, hp curve, gold curve, board composition per round, per-round hashes, outcome.
- `tools/sweep.ts`: N seeds × policies in worker threads (cap from `SIEGE_SWEEP_WORKERS`, default 4, validated to 1..64 like `--workers`) → aggregate: win rate, mean rounds survived, mean and p95 fight length, exception count; writes `bench/sweep-<stamp>.json` (gitignored) and prints a table.
- `tools/bench.ts`: fights per second and ticks per second for a fixed dev matchup.

## 6. Renderer & app shell (minimal but real)
- Canvas hex board; units as discs with hp/mana bars, star pips, team colours; sim events drive simple hit flashes. Interpolation between ticks; game speed 1/2/4×.
- DOM: shop row (buy), bench row, gold / level / hp / round HUD, reroll / buy-xp / sell / start-combat controls, all issuing Commands.
- Screens: Title → Run → Results (win/loss) → Title, implemented as a pure screen state machine in `src/app` (unit-tested) with a thin DOM binding.
- Esc pause; F1 dev overlay (fps, tick, round hash, content hash, seed).
- A "Dev fight" entry on the Title screen: pick two dev boards, watch the fight play through the same sim as headless.

## 7. Dev tools seam
- `src/dev/` scaffolding only: the overlay and the data-endpoint client. Tuner and Codex are P0-07 / P0-08 backlog items.

## 8. Tests (fast tier unless noted)
- `tests/architecture.test.ts`: scans `src/sim/**` for forbidden tokens (`Math.random`, `Date.now`, `performance.now`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `document`, `window`, `Math.sin`, `Math.cos`, `Math.tan`, `Math.atan`, `Math.atan2`) and forbidden imports (render / ui / app / dev).
- Determinism: same seed + command log → identical round hashes across 10 runs; different seeds → different hashes; replay reproduces a random-policy run; rendering on/off changes nothing.
- Hex math: distance symmetry and triangle inequality, neighbour counts at edges, path optimality on small grids.
- Fight: mirrored boards → draw at timeout; a 1v1 with known stats ends on the predicted tick; targeting tie-break is stable; the same seed twice produces identical event logs.
- Stats: two different-source +10% and +20% → exactly ×1.32; same-source ranks add; flat stats add.
- Run/commands: every illegal command is rejected with a reason and leaves state unchanged; 3-copy merge including chained merges; shop draws respect level odds over 10k draws (statistical bounds); interest / sell / reroll arithmetic against `data/dev/rules.json`.
- Data: an invalid sample is rejected; the content hash is stable across key order and whitespace and changes when a value changes.
- Production build contains no dev endpoint (slow tier is fine).
- Record the measured `npm run test:fast` wall time in PROGRESS.md; it must be under 5 minutes.

## 9. Docs & finish
- README.md complete; PROGRESS.md: "Bootstrap complete" with the fast-tier time, the command list, and known issues; BACKLOG.md: tick anything P0 this bootstrap already covered and adjust item text to match reality; QUESTIONS.md: one "Open decisions" entry per provisional choice (stat vocabulary, hex layout, tick rate, timeout rule, economy numbers in data/dev).
- `npm run check`, `npm run test:fast`, then the full `npm test`; commit `bootstrap: engine skeleton + tooling`; push if a remote exists. Print a summary of what now exists and stop.
