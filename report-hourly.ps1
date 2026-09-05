# report-hourly.ps1 (Siege) - appends a progress snapshot every N minutes to <Root>\reports\report.md.
# Run in its own window from the repo folder:  .\report-hourly.ps1    or    .\report-hourly.ps1 -Minutes 30
# Lanes are discovered automatically from git worktrees. Stops itself when DONE.md appears in the main repo.

param(
  [string]$Root = "D:\Siege",
  [int]$Minutes = 60
)

$repo = Join-Path $Root "game"
$out  = Join-Path $Root "reports\report.md"
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
if (-not (Test-Path $out)) { "# Siege progress report" | Out-File $out -Encoding utf8 }

function Count-Marks([string]$File, [string]$Pattern) {
  if (Test-Path $File) { return (Select-String -Path $File -Pattern $Pattern | Measure-Object).Count }
  return 0
}

while ($true) {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
  $block = @("", "## $stamp")

  $paths = @()
  $porcelain = git -C $repo worktree list --porcelain 2>$null
  foreach ($line in $porcelain) {
    if ($line -like "worktree *") { $paths += ($line.Substring(9) -replace "/", "\") }
  }
  if ($paths.Count -eq 0) { $paths = @($repo) }

  foreach ($p in $paths) {
    $name = Split-Path $p -Leaf
    if ($p -ieq $repo) { $lane = "main"; $backlog = Join-Path $p "BACKLOG.md" }
    else { $lane = $name; $backlog = Join-Path $p ("BACKLOG-" + $name.ToUpper() + ".md") }
    $open = Count-Marks $backlog "- \[ \]"
    $done = Count-Marks $backlog "- \[x\]"
    $commits = git -C $p log --oneline --since="$Minutes minutes ago" 2>$null
    $flags = @()
    foreach ($f in @("DONE.md", "STOP.md", "IDLE.md")) { if (Test-Path (Join-Path $p $f)) { $flags += $f } }
    if ($flags.Count -gt 0) { $flagText = " [" + ($flags -join ", ") + "]" } else { $flagText = "" }
    $block += ("### {0}  backlog {1} open / {2} done{3}" -f $lane, $open, $done, $flagText)
    if ($commits) { $block += ($commits | ForEach-Object { "  " + $_ }) } else { $block += "  (no commits in the last $Minutes min)" }
    $loopLog = Join-Path $Root ("reports\loop-" + $lane + ".log")
    if (Test-Path $loopLog) {
      $tail = Get-Content $loopLog -Tail 1
      if ($tail) { $block += ("  loop: " + $tail) }
    }
  }

  ($block -join "`r`n") | Add-Content $out -Encoding utf8
  Write-Host "[$stamp] report appended -> $out"
  if (Test-Path (Join-Path $repo "DONE.md")) { Write-Host "DONE.md present. Reporter stopping."; break }
  Start-Sleep -Seconds ($Minutes * 60)
}
