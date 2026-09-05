# OPS.md — Siege pipeline cheat sheet (owner)

**Siege runs in cloud mode** (Claude Code on the web) — see "Cloud mode" below. `run-until-done.ps1` and `report-hourly.ps1` stay in the repo as the **local fallback**; the Layout / Windows / Signals / Lanes sections below describe that local loop only.

## Cloud mode
- One cloud task = one fresh clone of `main` on its own branch. You merge task branches into `main` through pull requests (or let a routine push `main` directly when unrestricted branch pushes are enabled).
- The task installs deps itself (`npm ci`) when `node_modules` is missing or `package-lock.json` moved.
- Every task works in this order: (a) unprocessed files in `feedback/`; (b) BOOTSTRAP.md continuation until PROGRESS.md says "Bootstrap complete"; (c) SPEC intake for any SPEC version without an intake entry — the task stops after that commit; (d) backlog items, one at a time, end to end.
- A task stops after the number of items its prompt names (default 3), at a hard blocker (logged under Known issues in PROGRESS.md), or when nothing is actionable (it tells you why). It commits after every item and pushes its branch before stopping. No `IDLE.md`, no `STOP.md` in cloud mode; `DONE.md` is unchanged. To stop a task early, just stop the session.
- **Feedback:** commit the `.md` file into `feedback/` on `main`, or paste it as a message to the running session. A message starting with `type:` is treated exactly like a feedback file. Feedback for a lane starts with `lane: <name>`.
- **Spec updates:** commit `SPEC.md` (later `SPEC-V2.md`, …) to `main`; the next task does the intake and stops there.
- **Lanes:** separate cloud tasks on their own branches working from `BACKLOG-<LANE>.md` (its first section is a hard file scope). The main lane owns triage, phase completion and DONE.md. Merge the main branch first, lane branches after.
- **Merges:** when a task branch needs `main`, tell it "merge main into this branch" — `main` wins on `src/**` and `data/**`, the branch's additions are kept, conflict markers removed, `npm run test:fast` green, then push. The FULL `npm test` runs at phase completion and before DONE.md only.

## Layout
```
D:\Siege\game          repo, main lane (Window 1)
D:\Siege\inbox         drop .md feedback here (main lane); D:\Siege\inbox-<lane> for lanes
D:\Siege\lanes\<name>  lane worktrees (Window 2, 5, ...)
D:\Siege\reports       report.md (hourly), loop-<lane>.log (live loop output)
```

## Windows
| # | Purpose | Command |
|---|---|---|
| 1 | main loop | `cd D:\Siege\game` → `.\run-until-done.ps1 [-Model opus\|fable\|sonnet] [-MaxHours 48]` |
| 2 | lane loop | `cd D:\Siege\lanes\<name>` → `.\run-until-done.ps1 -Model opus` (lane auto-detected) |
| 3 | reporter | `cd D:\Siege\game` → `.\report-hourly.ps1` (`-Minutes 30` for half-hourly) |
| 4 | monitor | `Get-Content D:\Siege\reports\loop-main.log -Wait -Tail 30` |
| 5 | playtest | `cd D:\Siege\game` → `npm run dev` |

Max 2–3 loop windows at once (CPU). Never two loops in one folder. `-Once` runs a single iteration.

## Signals (create or delete the file from any window)
- `STOP.md` in the loop folder (`New-Item D:\Siege\game\STOP.md`) → the loop stops after the current item and deletes the file. `Ctrl+C` = kill now; the next run recovers uncommitted work.
- `IDLE.md` — written by the agent when nothing is actionable; the loop sleeps 15 min and retries.
- `DONE.md` — written by the agent when SPEC is fully built; the loop and the reporter stop.

## Feedback files (any name `.md`, into the inbox; ingested at the next iteration start)
```
type: bug | req | verdict | balance | pipeline
priority: now | next | later

free text. For decisions, write lines starting with "verdict:" — they are copied into QUESTIONS.md verbatim and are final.
```

## Spec updates
Drop `SPEC.md` (later `SPEC-V2.md`, ...) into `D:\Siege\game` while the loop runs. Intake is automatic at the next iteration; no stop needed.

## One-off instruction (loop stopped, Window 1)
`claude --dangerously-skip-permissions` → paste the instruction → wait → `/exit` → relaunch the loop.

## Lanes
- Create (Window 1, loop stopped): commit `BACKLOG-<NAME>.md` (first section = hard file scope), then `git worktree add D:\Siege\lanes\<name> -b lane/<name>`.
- Run: Window 2 as above. Feedback for the lane → `D:\Siege\inbox-<name>`.
- Merge (all loops stopped, Window 1): `git merge lane/<name>`; on conflicts → `claude --dangerously-skip-permissions` → paste `Finish merging lane/<name>: resolve conflicts (main wins on src and data, lane additions kept), remove leftover conflict markers, file the lane Log's out-of-scope needs as BACKLOG items, run npm run test:fast then the FULL npm test, commit.` → `/exit` → relaunch.

## Models
`opus` default. `fable` = smarter per iteration, burns the weekly limit faster (good for hard phases). `sonnet` = cheap; fine for lanes with small items.

## Differences from the Stonewake pipeline
STOP.md graceful stop · IDLE.md idle-wait instead of empty iterations · per-iteration logs in `reports/` · auto `git push` · lane auto-detect from folder · test-worker cap for parallel lanes · SPEC intake without stopping the loop · fast/slow test tiers from day one · Tuner, Codex, replay, telemetry and soak/fuzz in P0 instead of late.
