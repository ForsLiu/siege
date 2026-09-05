# CLAUDE.md — Siege standing orders (v1)

Siege is a 2D single-player PvE roguelike autobattler: a simplified TFT in the shape of Tocker's Trials. The owner designs; you build. Stack, rules and loop protocol below are fixed. Content and numbers come from SPEC.md and live in `/data`.

## Sources of truth, in order
1. **SPEC.md** — game design. Until it exists, only `[infra]` items in BACKLOG.md are actionable. Never invent units, traits, items, augments, encounters or tuning numbers that SPEC.md does not define. Engine tests may use sample content under `data/dev/` only, marked provisional.
2. **QUALITY.md** — definition of done per stage. Read-only for you; propose changes in QUESTIONS.md.
3. **BACKLOG.md** — the ordered work queue you execute (lanes: `BACKLOG-<LANE>.md`).
4. **PROGRESS.md** (state) and **QUESTIONS.md** (decisions; owner overrides are final).

Do not redesign what these define. Fill genuine gaps with the most spec-consistent default and log it under "Open decisions" in QUESTIONS.md with the item id.

## Stack & commands (fixed)
TypeScript (strict) · Vite · HTML canvas 2D · Vitest · zod · Node 22+. No UI framework, no game framework. Any runtime dependency beyond zod needs a QUESTIONS.md entry.
- `npm run dev` — playable build with dev tools · `npm run build` — production build (dev tools and endpoints stripped) · `npm run check` — tsc + architecture test
- `npm run test:fast` — fast tier, must stay under 5 min (the per-item gate) · `npm test` — full suite (phase completion, lane merges, DONE check only)
- `npm run fight -- --seed 1 --left data/dev/boards/a.json --right data/dev/boards/b.json` — one headless fight
- `npm run sim -- --seed 1 --policy greedy` — one headless run with a bot policy; prints a run report
- `npx tsx tools/sweep.ts --seeds 50 --policies random,greedy` — multi-seed sweep with aggregate metrics
- `npm run bench` — sim throughput benchmark

## Fixed engineering decisions (so nothing blocks on design)
- Board: hex grid, offset coordinates with axial helpers; size and player rows in `data/board.json` (provisional default 7 columns × 8 rows, bottom 4 rows = player side).
- Simulation tick: fixed 30 Hz. The renderer interpolates; the sim never reads wall-clock time.
- RNG: one seeded generator per named stream (`shop`, `encounter`, `combat`, `loot`, `augment`, `misc`), each derived from (runSeed, streamName). No stream is ever consumed by rendering or UI.
- A run = seed + ordered command log. State hash (FNV-1a 64 over canonical JSON with sorted keys) at every round boundary and at run end; replays must reproduce every hash.
- `fight(left, right, seed, rules)` is a pure function of its arguments. Nothing inside a fight reads global or module-level mutable state.
- Stat stacking: modifiers from different sources multiply; ranks within one source add; flat stats add. A `STAT_KIND` map classifies every stat as `mul` or `flat`.
- Vocabulary: unit, trait, item, augment, encounter, round, stage; phases planning / combat / reward. Use these names in code and data.
- No trigonometry anywhere in `/src/sim` (hex distance and integer/rational math instead). `Math.sqrt`, `Math.floor` and friends are fine.

## Architecture rules (hard; enforced by tests/architecture.test.ts)
1. `/src/sim` is pure: no DOM, no `Math.random`, no `Date.now` / `performance.now`, no timers, no trig, no imports from `/src/render`, `/src/ui`, `/src/app`, `/src/dev`.
2. Every player action is a sim `Command` (buy, sell, place, bench, swap, reroll, levelUp, pickAugment, equipItem, startCombat, ...) validated by the sim with a reason on rejection. Bots, replays and the UI all go through Commands.
3. Renderer and UI read sim state; they never mutate it.
4. All content and tuning live in `/data/*.json`, validated by zod at load, with the content hash recorded in RunConfig. Engine code stays generic: new units, traits, items, augments and encounters are data rows using the effect vocabulary. Extend the vocabulary in code when a spec mechanic needs it, then express the content in data. Never hard-code a tuning number in `/src`.
5. Deterministic iteration: object-key or Set/Map insertion order must never influence sim outcomes unless that order is itself fully determined by the command log; sort or use arrays. Tie-breaks are explicit and stable.
6. Anything slower than ~20 s belongs in `tests/slow/`. The fast tier is the per-item gate and must stay under 5 minutes; if it drifts over, moving tests is a top-priority `[infra]` item.

## Test policy
- Per item: targeted tests + `npm run test:fast`. Never run the full `npm test` inside an ordinary item.
- Full `npm test` only at: phase completion (the last open item of a phase is done), lane merges, and the DONE.md check. On phase completion log `P<n> complete` in PROGRESS.md.
- Confirmed bugs get a failing regression test before the fix.
- Never delete or weaken a test to go green. Stuck after ~5 distinct attempts on one failure: `.skip` + TODO + an entry under Known issues in PROGRESS.md, then move on.
- Test worker count comes from `SIEGE_TEST_WORKERS` (default 4) so parallel lanes cannot starve each other.

## Working rules
1. Work top-down in the backlog within the current phase. Skip only with a logged reason.
2. Commit at every green point as `<item id>: <summary>` (feedback: `fb: <file>`; spec intake: `spec: intake v<n>`). `git push` after each commit when a remote exists; a failed push never fails the item.
3. Never stop to ask a design question. Choose, log in QUESTIONS.md, continue.
4. Update PROGRESS.md at every item completion and before any stop: state, next action, known issues.
5. Keep `npm run dev` playable at all times up to the furthest built screen.
6. Touch nothing outside this repository. `STOP.md` and `IDLE.md` are loop signals: never commit them; write `IDLE.md` only as described below.
7. Project-local devDependencies only; no global installs.
8. If the working tree has uncommitted changes at iteration start (an interrupted iteration), first bring them to a green committed state or revert them, and log which.

## Subagent protocol (`.claude/agents/`)
- **code-reviewer** after any non-trivial change, before commit; fix Critical/Major findings first.
- **qa-playtester** before marking an item done; it confirms the acceptance criteria and tries to break the build. Every QA-filed bug becomes a `[bug]` item with a regression test.
- **balance-analyst** for `[balance]` items and gate regressions: edits `/data` only and reports gate deltas.

## Feedback protocol (owner inbox)
The loop script moves the owner's `.md` files from the inbox into `feedback/`. At the start of every iteration, for each file in `feedback/` not yet in `feedback/processed/`:
- `type: verdict` (or any line starting with `verdict:`) → copy into QUESTIONS.md under "Owner overrides" exactly as written. Owner decisions are final and override SPEC defaults and your own earlier choices.
- `type: bug` → `[bug]` item at the top of the queue; failing regression test first.
- `type: req` → `[feat]` item(s) referencing the SPEC section (or "owner-req" when SPEC does not cover it), placed per `priority:` (`now` = top of queue, `next` = top of the current phase, `later` = end of the current phase; default `next`).
- `type: balance` → `[balance]` item for balance-analyst.
- `type: pipeline` → `[infra]` item at the top of the queue, or done immediately when it is a one-line instruction.
- Untagged files: infer the type; when in doubt treat as `req` with priority `next`.
Then move the file to `feedback/processed/` and commit `fb: <file>`.

## SPEC intake (main lane, once per spec version)
When `SPEC.md` (or a newer `SPEC-V<n>.md`) exists and PROGRESS.md has no `SPEC intake v<n>` entry: read it fully; audit the codebase against it; rewrite BACKLOG.md phases P1..Pn from the spec's build order with one objective acceptance check per item mapped to the spec's gates; keep unfinished `[infra]` items above them; retire superseded provisional data and tests with logged reasons; update this file's sources-of-truth list if the spec renames anything; log conflicts and gaps to QUESTIONS.md; commit `spec: intake v<n>`; write the `SPEC intake v<n>` entry to PROGRESS.md. That is the whole iteration.

## BACKLOG protocol
Item format: `- [ ] (P0-01) [infra|feat|bug|balance|polish] title — acceptance: <objective check> — refs: <SPEC § | infra>`
Loop-mode contract: one item end to end (implement → targeted tests + test:fast green → code-reviewer → qa-playtester → commit → push → PROGRESS/BACKLOG updated), then stop. Lanes other than main may take two items per iteration when both are small.
Generation rule: when fewer than 3 actionable items remain, derive new items only from SPEC gaps, red gates in QUALITY.md, QA-filed bugs, or sweep findings; append 5 with objective acceptance criteria, ordered by value; never invent game systems (propose those in QUESTIONS.md). With no SPEC and no `[infra]` items left, write `IDLE.md` instead.

## Phases
P0 = engine and tooling (content-agnostic; listed in BACKLOG.md). P1+ are written by SPEC intake. A phase is complete only when all its items are done and the full suite is green.

## DONE.md
Write it only when: SPEC.md exists and is fully implemented (walk every section against the code), BACKLOG.md has no open items, QUALITY.md's current stage is green, and the full `npm test` is green. Lanes never write DONE.md.

## Lanes
Main lane: this folder, branch `main`, `BACKLOG.md`, inbox `D:\Siege\inbox`. Other lanes: git worktrees at `D:\Siege\lanes\<name>` on branch `lane/<name>`, backlog `BACKLOG-<NAME>.md` whose first section is a hard file-scope boundary, inbox `D:\Siege\inbox-<name>`. Lanes never edit files outside their scope; out-of-scope needs go into the lane file's Log section and become main-lane items at merge. The main lane owns triage, merges and phase completion.
