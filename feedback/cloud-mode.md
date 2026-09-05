type: pipeline
priority: now

Cloud mode. Agent execution has moved from the local PowerShell loop (run-until-done.ps1) to Claude Code on the web: one cloud task = one fresh clone of main on its own branch; the owner merges task branches into main through pull requests (or a routine pushes main directly when unrestricted branch pushes are enabled). Update CLAUDE.md so it stands alone without the loop script:

1. Add a section "## Cloud task contract" directly after "## BACKLOG protocol":
   - Task start: if node_modules is missing or package-lock.json changed since the cached setup, run `npm ci` first.
   - Order of work in every task: (a) feedback/ files not yet in feedback/processed/ (feedback protocol); (b) BOOTSTRAP.md continuation while PROGRESS.md lacks the phrase "Bootstrap complete"; (c) SPEC intake when a SPEC version has no intake entry - stop after the intake commit; (d) backlog items one at a time per the loop-mode contract.
   - Stop after the number of completed items the task prompt names (default 3), at a hard blocker (logged under Known issues in PROGRESS.md), or when nothing is actionable (explain why in the final message). Never write IDLE.md in cloud mode; STOP.md does not exist in cloud mode. DONE.md rules are unchanged.
   - Commit after every item and push the task branch before stopping. Never rewrite history, never force-push.
   - Merge instructions: when told "merge main into this branch", main wins on src/** and data/**, this branch's additions are kept, all <<<<<<< markers are removed, then npm run test:fast, then push. The FULL npm test runs at phase completion and before DONE.md only.
2. Replace the "## Lanes" section: lanes are separate cloud tasks on their own branches working from BACKLOG-<LANE>.md; the lane file's first section is a hard file-scope boundary; feedback files or messages addressed to a lane start with "lane: <name>"; the main lane owns triage, phase completion and DONE.md; the owner merges the main branch first, lane branches after.
3. In "## Feedback protocol", replace the sentence about the loop script and the inbox: the owner commits feedback files into feedback/ on main, or sends them as messages to the running session. A session message that starts with "type:" is treated exactly like a feedback file: record it as feedback/processed/<yyyy-mm-dd>-message-<n>.md before acting on it.
4. Keep run-until-done.ps1 and report-hourly.ps1 in the repo as the local fallback (say so at the top of OPS.md) and add a "Cloud mode" section to OPS.md that mirrors this contract in owner language.
5. Commit "fb: cloud mode".
