# Replace every em-dash (U+2014, "\u2014") with a regular hyphen "-".
# Common usage is " — " (space + em-dash + space); we map that to " - "
# so the spacing stays natural. Bare em-dashes become bare hyphens.
#
# Scope: source files only. Excludes node_modules, dist, generated route
# tree, and .git internals so we never touch external code.

$root = "D:\paymemo\all-files-import"

$includePatterns = @("*.ts", "*.tsx", "*.js", "*.css", "*.html", "*.md", "*.json")
$excludeMatch =
  '\\node_modules\\|\\dist\\|\\.vercel\\|\\.git\\|\\.tanstack\\|\\.wrangler\\|\\.lovable\\|routeTree\.gen\.ts$|package-lock\.json$|bun\.lock$'

$emDash = [char]0x2014
$endash = [char]0x2013

$files = Get-ChildItem -Path $root -Recurse -Include $includePatterns -File |
  Where-Object { $_.FullName -notmatch $excludeMatch }

$changedFiles = 0
$replaced = 0
foreach ($file in $files) {
  $original = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
  if ($original -notmatch "[$emDash$endash]") { continue }
  $matchCount = ([regex]"[$emDash$endash]").Matches($original).Count
  $current = $original.Replace(" $emDash ", " - ").Replace(" $endash ", " - ").Replace("$emDash", "-").Replace("$endash", "-")
  if ($current -ne $original) {
    Set-Content -LiteralPath $file.FullName -Value $current -NoNewline -Encoding UTF8
    $changedFiles++
    $replaced += $matchCount
    Write-Output "fixed: $($file.FullName.Substring($root.Length + 1))  ($matchCount)"
  }
}
Write-Output ""
Write-Output "TOTAL files fixed: $changedFiles"
Write-Output "TOTAL em/en-dashes replaced: $replaced"
