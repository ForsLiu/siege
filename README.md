# Siege

A 2D single-player PvE roguelike autobattler: a simplified TFT in the shape of Tocker's Trials.
This repository holds the deterministic engine, the data pipeline, the headless tooling and a
minimal playable shell. Game content and tuning come from `SPEC.md` (not yet written); until then
`data/dev/` holds **provisional sample content for engine tests only**.

Stack: TypeScript (strict) · Vite · HTML canvas 2D · Vitest · zod · Node 22+. No frameworks.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | project-local dependencies (Node ≥ 22) |
| `npm run dev` | playable dev build at http://localhost:5173 with dev tools (F1 overlay, `/__data/` endpoint) |
| `npm run build` | production build into `dist/` (no dev tools, no endpoint; verified by `tests/slow/build.test.ts`) |
| `npm run preview` | serve the production build |
| `npm run check` | `tsc --noEmit` + the architecture test |
| `npm run test:fast` | fast tier (everything under `tests/` except `tests/slow/`); the per-item gate, must stay under 5 min |
| `npm test` | full suite including `tests/slow/` (phase completion, lane merges, DONE check) |
| `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json [--events] [--json]` | one headless fight: winner, ticks, survivors, per-unit ledger, hash; `--events` dumps the event log |
| `npm run sim -- --seed 1 --policy random [--check] [--json] [--out report.json]` | one headless run with a bot policy; prints the run report (rounds, hp/gold curves, board per round, per-round hashes, outcome) |
| `npx tsx tools/sweep.ts --seeds 50 --policies random [--start 1] [--workers 4]` | seeds × policies in worker threads; aggregate table (win rate, mean rounds survived, fight length mean/p95, exceptions); writes `bench/sweep-<stamp>.json` (gitignored) |
| `npm run bench [-- --seconds 3]` | fights/sec and ticks/sec on a fixed dev matchup plus a host-independent budget (sim ticks per baseline hash) |

Environment: `SIEGE_TEST_WORKERS` (vitest workers, default 4), `SIEGE_SWEEP_WORKERS` (sweep worker threads, default 4; must be 1..64 — anything else is a usage error, an empty value means unset). With two or more workers, a sweep worker that dies, wedges (no answer within `--job-timeout`, default 120 s) or refuses to exit takes only its own job down: that run is reported as an exception (counted in the `t/o` column when it was a timeout) and a replacement finishes the queue. `--workers 1` runs jobs in-process, where no watchdog applies. Every string flag needs a value: a bare `--out` or `--policy` is a usage error, not a silent default.

## Playing (`npm run dev`)

- **Title**: enter a seed (blank = random) → **New run**. **Dev fight** plays two dev boards through the same `fight()` the headless tools use.
- **Run**: shop row (click to buy), bench row (click to select), board (click a player-half cell to place the selected unit; click a board unit to select it; click the selected board unit again to bench it; click another unit while one is selected to swap). Buttons: Reroll, Buy XP, Sell, Start combat / Next round, speed 1×/2×/4×, Pause.
- Hotkeys: `R` reroll · `X` buy xp · `S` sell selected · `Space` start combat / next round · `1` `2` `3` speed 1×/2×/4× · `Esc` pause · `F1` dev overlay (fps, tick, round hash, content hash, seed).
- **Results** after victory (survive the last encounter) or defeat (hp 0 / abandon) → back to Title.

## Layout

```
src/sim/     pure deterministic simulation (no DOM, no Math.random, no wall clock, no trig)
             rng.ts hash.ts hex.ts stats.ts effects.ts units.ts fight.ts run.ts commands.ts replay.ts report.ts rules.ts
src/data/    zod schemas, loader + cross-file checks, sha-256 content hash, manifest, node/browser loaders
src/render/  canvas renderer (board.ts) and the pure event->frames timeline (timeline.ts)
src/ui/      DOM overlays: shop, bench, HUD, controls, title/results/pause screens
src/app/     main.ts glue + pure screen state machine (screens.ts)
src/dev/     dev-only overlay and data-endpoint client (never in production builds)
data/        board.json + data/dev/{rules,units,encounters}.json + data/dev/boards/*.json (provisional)
tools/       fight.ts sim.ts sweep.ts sweep-worker.ts bench.ts args.ts vite-dev-data-plugin.ts policies/
tests/       fast tests; tests/slow/ for anything over ~20 s
```

## Engine contracts

- **Commands**: every player action is a `Command` (`buy`, `sell`, `place`, `bench`, `swap`, `reroll`, `levelUp`, `startCombat`, `nextRound`, `abandon`). `validateCommand` returns a reason or `null`; `applyCommand` mutates only when legal; `legalCommands(state, content)` enumerates what a bot may do (excludes `abandon`).
- **Determinism**: a run is `seed + command log`. `RunState.hashes` holds the FNV-1a 64 state hash at creation, at every `nextRound`, and at run end. `replayRun` / `verifyReplay` reproduce and check them. RNG streams (`shop`, `encounter`, `combat`, `loot`, `augment`, `misc`) are derived from `(seed, name)` and serialised in the state.
- **fight(left, right, seed, rules)** is pure. Boards are authored in owner-half coordinates (rows 4–7); the right side is mirrored. It returns winner, reason (`elimination` | `timeout`), ticks, the ordered event list (spawn/move/attack/hit/heal/statMod/stun/cast/death/end), survivors, a per-unit damage ledger and a hash.
- **Stats**: `STAT_KIND` classifies each stat as `mul` or `flat`. Modifiers from different sources multiply, values within one source add, flat modifiers add.
- **Effects v0**: `damage`, `heal`, `statMod`, `stun` with targets `self | target | allies | enemies`; hooks `onCombatStart`, `onAttack`, `onHit`, `onCast`, `onKill`, `onDeath`. Unknown effect names fail schema validation.
- **Content**: every `/data` file is validated by zod at load (unknown keys rejected). `contentHash` = sha-256 of the canonical concatenation, recorded in `RunState.config` and shown in the dev overlay.

## Bot policies (`tools/policies/`)

A policy is a module exporting `createPolicy(): Policy` with `{ name, choose(ctx) }`, where `ctx` has
`state`, `content`, `legal` (non-empty `Command[]`) and `rng` (an `Rng` derived from `(seed, "policy:<name>")`,
separate from the sim streams). Register it in `POLICY_FACTORIES` in `tools/policies/index.ts`; `sim` and `sweep`
then accept it by name. `random` picks a command type uniformly, then a command of that type.

## Dev data endpoint (dev server only)

`GET /__data/<path>` reads and `POST /__data/<path>` validates (zod) and writes `data/<path>`, for the
manifest files (`board.json`, `dev/rules.json`, `dev/units.json`, `dev/encounters.json`) and `dev/boards/*.json`.
Invalid documents get HTTP 422 with the schema error. The plugin uses `apply: 'serve'`, so `vite build` never includes it.

## Process

See `CLAUDE.md` (standing orders), `BACKLOG.md` (work queue), `PROGRESS.md` (state), `QUESTIONS.md` (decisions), `OPS.md` (loop operation).
