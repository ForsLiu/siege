# run-until-done.ps1 (Siege v3) - unattended build loop.
# One backlog item per iteration, until DONE.md, STOP.md, or the time cap.
# Run from the repo root (main lane) or from a lane worktree (lane auto-detected):
#   .\run-until-done.ps1                          main lane, opus, 48 h cap
#   .\run-until-done.ps1 -Model fable -MaxHours 72
#   .\run-until-done.ps1 -Once                    exactly one iteration (pipeline check)
# Signals in the loop folder:
#   STOP.md  (owner) -> stop after the current iteration; the file is removed on exit
#   IDLE.md  (agent) -> nothing actionable; the loop sleeps IdleMinutes, then retries
#   DONE.md  (agent) -> game complete per SPEC; the loop ends
# Log: <Root>\reports\loop-<lane>.log

param(
  [string]$Model = "opus",
  [double]$MaxHours = 48,
  [string]$Root = "D:\Siege",
  [string]$Lane = "",
  [string]$Backlog = "",
  [string]$Inbox = "",
  [int]$TestWorkers = 4,
  [int]$IdleMinutes = 15,
  [int]$CooldownMinutes = 10,
  [switch]$Once
)

$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$repo = $PSScriptRoot

if ($Lane -eq "") {
  $parentName = Split-Path (Split-Path $repo -Parent) -Leaf
  if ($parentName -eq "lanes") { $Lane = Split-Path $repo -Leaf } else { $Lane = "main" }
}
if ($Backlog -eq "") {
  if ($Lane -eq "main") { $Backlog = "BACKLOG.md" } else { $Backlog = "BACKLOG-" + $Lane.ToUpper() + ".md" }
}
if ($Inbox -eq "") {
  if ($Lane -eq "main") { $Inbox = Join-Path $Root "inbox" } else { $Inbox = Join-Path $Root ("inbox-" + $Lane) }
}
$reports = Join-Path $Root "reports"
$log = Join-Path $reports ("loop-" + $Lane + ".log")

$env:CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = "0"
$env:SIEGE_TEST_WORKERS = "$TestWorkers"
$env:SIEGE_LANE = $Lane

New-Item -ItemType Directory -Force -Path $Inbox, $reports, "feedback", "feedback\processed" | Out-Null
if (-not (Test-Path $Backlog)) {
  Write-Host "Backlog $Backlog not found in $repo - create it (or pass -Backlog) first." -ForegroundColor Red
  exit 1
}

function Write-Log([string]$Text) {
  $line = "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $Text
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line -ForegroundColor Cyan
}

$cap = (Get-Date).AddHours($MaxHours)
$prompt = @"
You are the $Lane lane of the Siege project. Read CLAUDE.md, PROGRESS.md and $Backlog, then follow CLAUDE.md exactly.

STEP 0 - recovery: if the working tree has uncommitted changes from an interrupted iteration, bring them to a green, committed state (or revert them) and log it in PROGRESS.md before anything else.

STEP 1 - owner feedback: for every file in feedback/ that is not yet in feedback/processed/, apply the feedback protocol in CLAUDE.md (verdict lines copied into QUESTIONS.md exactly as written; bugs become top-of-queue [bug] items with a failing regression test first; requests, balance notes and pipeline notes become items at the stated priority; one-line pipeline instructions are done immediately). Move each file to feedback/processed/ and commit 'fb: <name>'.

STEP 2 - spec intake (main lane only): if SPEC.md (or a newer SPEC-V<n>.md) exists and PROGRESS.md has no matching 'SPEC intake' entry, perform the intake described in CLAUDE.md and commit it. The intake is this iteration's whole work: stop after that commit.

STEP 3 - completion check (main lane only, and only when $Backlog has no open items): if SPEC.md exists, every SPEC section is implemented, QUALITY.md's current stage is green and the FULL npm test suite is green, write DONE.md summarizing the final state, commit it and stop. Never write DONE.md while SPEC.md does not exist.

STEP 4 - if no open item in $Backlog is actionable for this lane, write IDLE.md containing one line with the reason and stop. Do not invent work.

STEP 5 - otherwise execute exactly ONE backlog item end to end (lanes other than main may take two when both are small [bug]/[polish]/data-only items): implement; verify with targeted tests plus npm run test:fast - never run the full npm test inside an ordinary item; code-reviewer review; qa-playtester pass; commit '<id>: <summary>'; git push if a remote exists; update PROGRESS.md and $Backlog. If that item was the last open item of its phase, run the FULL npm test, fix regressions, and log 'P<n> complete' in PROGRESS.md. If fewer than 3 actionable items remain, apply the generation rule in CLAUDE.md first. One item, then stop.
"@

Write-Log ("loop start: lane={0} model={1} backlog={2} inbox={3} cap={4:yyyy-MM-dd HH:mm} once={5}" -f $Lane, $Model, $Backlog, $Inbox, $cap, $Once.IsPresent)

$i = 0
$fails = 0
while ((Get-Date) -lt $cap) {
  if (Test-Path "DONE.md") { break }
  if (Test-Path "STOP.md") { break }
  $i++

  $msgs = Get-ChildItem $Inbox -Filter *.md -File -ErrorAction SilentlyContinue
  foreach ($m in $msgs) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    Move-Item $m.FullName (Join-Path "feedback" ("{0}-{1}" -f $stamp, $m.Name))
    Write-Log (">>> ingested feedback: " + $m.Name)
  }

  $start = Get-Date
  Write-Log ("=== iteration {0} start (lane {1}, model {2}, cap {3:MM-dd HH:mm}) ===" -f $i, $Lane, $Model, $cap)
  claude -p $prompt --model $Model --dangerously-skip-permissions | ForEach-Object { Write-Host $_; Add-Content -Path $log -Value $_ -Encoding UTF8 }
  $code = $LASTEXITCODE
  $mins = [math]::Round(((Get-Date) - $start).TotalMinutes, 1)

  if ($code -ne 0) {
    $fails++
    Write-Log ("iteration {0} exited with code {1} after {2} min - cooling down {3} min (usage limits resume automatically; consecutive failures: {4})" -f $i, $code, $mins, $CooldownMinutes, $fails)
    if (-not $Once) { Start-Sleep -Seconds ($CooldownMinutes * 60) }
  } else {
    $fails = 0
    $last = git log --oneline -1 2>$null
    Write-Log ("iteration {0} done in {1} min - last commit: {2}" -f $i, $mins, $last)
    $remote = git remote get-url origin 2>$null
    if ($remote) { git push -q origin HEAD 2>$null | Out-Null }
  }

  if (Test-Path "IDLE.md") {
    $raw = Get-Content "IDLE.md" -Raw
    if ($raw) { $reason = $raw.Trim() } else { $reason = "(no reason given)" }
    Remove-Item "IDLE.md" -Force
    Write-Log ("agent idle: " + $reason + " - sleeping " + $IdleMinutes + " min")
    if (-not $Once) { Start-Sleep -Seconds ($IdleMinutes * 60) }
  }

  if ($Once) { break }
}

if (Test-Path "DONE.md") { Write-Log "DONE.md present - game complete per SPEC after $i iterations. Read DONE.md." }
elseif (Test-Path "STOP.md") { Remove-Item "STOP.md" -Force; Write-Log "Stopped by STOP.md after $i iterations. Relaunch to continue." }
elseif ($Once) { Write-Log "Single iteration finished." }
else { Write-Log "Safety cap of $MaxHours h reached after $i iterations. Relaunch to continue." }
