# PowerShell twin of repo-paths.mjs. Dot-source it from a script in scripts\:
#   . (Join-Path $PSScriptRoot 'lib\RepoPaths.ps1')
#
#   $RepoRoot              this repo's root, resolved from this file's location
#   Get-SiblingDir NAME    a folder path read from the named environment setting
#                          (VICTORA_WEB_DIR); throws if missing or not a folder.
# No defaults and no "..\something" guess.

$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path

function Get-SiblingDir([string] $Setting) {
  $value = [Environment]::GetEnvironmentVariable($Setting)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "$Setting is not set. Set it to the full path of that repo's folder (a Windows user environment variable; see CLAUDE.md 'Local paths'), then open a new terminal."
  }
  if (-not (Test-Path -LiteralPath $value -PathType Container)) {
    throw "$Setting is set to '$value', but that folder does not exist."
  }
  (Resolve-Path -LiteralPath $value).Path
}
