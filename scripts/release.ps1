# Build a signed Shellmosaic release and publish it on GitHub: the NSIS installer, its
# signature, and the latest.json the built-in updater reads.
#
#   pwsh scripts/release.ps1            # publish
#   pwsh scripts/release.ps1 -Draft     # create a draft release to review first
#   pwsh scripts/release.ps1 -TargetDir src-tauri\target   # build elsewhere while target-dist's exe runs
#   pwsh scripts/release.ps1 -Channel test  # a test build: <version>-test.N on the rolling "test-build"
#                                           # pre-release, which the app's Test update channel reads
#
# Needs: gh (logged in), the signing key (see CONTRIBUTING.md#releases).
param(
  [switch]$Draft,
  [ValidateSet("stable", "test")][string]$Channel = "stable",
  [string]$Key = "$env:USERPROFILE\.tauri\shellmosaic-updater.key",
  [string]$Repo = "VinZie/shellmosaic",
  [string]$TargetDir
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
# A separate target folder by default: an installed or running Shellmosaic keeps target\release\shellmosaic.exe locked.
$target = if ($TargetDir) { [IO.Path]::GetFullPath($TargetDir, $root) } else { "$root\src-tauri\target-dist" }
$base = (Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
if (-not (Test-Path $Key)) { throw "Signing key not found: $Key" }

if ($Channel -eq "test") {
  # 0.3.0-test.N sorts below 0.3.0, so testers are offered the stable release once it's out
  $tag = "test-build"
  $previous = gh release view $tag -R $Repo --json name -q .name 2>$null
  $n = if ($previous -match "-test\.(\d+)$" -and $previous -like "*$base-test.*") { [int]$Matches[1] + 1 } else { 1 }
  $version = "$base-test.$n"
  $notes = "Test build $version from the test branch ($(git -C $root rev-parse --short HEAD)). It may be unstable."
} else {
  $version = $base
  $tag = "v$version"
  # release notes: this version's section of CHANGELOG.md
  $changelog = Get-Content "$root\CHANGELOG.md" -Raw
  $m = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version))\b[^\n]*\n(.*?)(?=^## |\z)")
  $notes = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "Shellmosaic $version" }
}

$env:CARGO_TARGET_DIR = $target
$env:TAURI_SIGNING_PRIVATE_KEY = $Key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Push-Location $root
try {
  if ($Channel -eq "test") { pnpm tauri build --bundles nsis --config "{`"version`":`"$version`"}" }
  else { pnpm tauri build --bundles nsis }
  if ($LASTEXITCODE) { throw "build failed" }
} finally {
  Pop-Location
  Remove-Item Env:CARGO_TARGET_DIR, Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# the license notices of everything shipped inside, attached to the release
pwsh -NoProfile -File "$root\scripts\third-party-licenses.ps1"
if ($LASTEXITCODE) { throw "collecting third-party licenses failed" }

$setup = Get-Item "$target\release\bundle\nsis\Shellmosaic_${version}_x64-setup.exe"
$signature = (Get-Content "$($setup.FullName).sig" -Raw).Trim()
$out = "$root\release\$tag"
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item $setup.FullName, "$($setup.FullName).sig", "$root\THIRD-PARTY-LICENSES.txt" $out -Force

$url = "https://github.com/$Repo/releases/download/$tag/$($setup.Name)"
$latest = [ordered]@{
  version   = $version
  notes     = $notes
  pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = [ordered]@{
    "windows-x86_64"      = [ordered]@{ signature = $signature; url = $url }
    "windows-x86_64-nsis" = [ordered]@{ signature = $signature; url = $url }
  }
}
[IO.File]::WriteAllText("$out\latest.json", ($latest | ConvertTo-Json -Depth 5))

$ghArgs = @("release", "create", $tag, "$out\$($setup.Name)", "$out\$($setup.Name).sig", "$out\latest.json", "$out\THIRD-PARTY-LICENSES.txt",
  "-R", $Repo, "--title", "Shellmosaic $version", "--notes", $notes)
if ($Channel -eq "test") {
  # one rolling pre-release: replace the previous test build (and move its tag to this commit)
  gh release delete $tag -R $Repo --cleanup-tag --yes 2>$null
  $ghArgs += @("--prerelease", "--target", (git -C $root rev-parse HEAD))
}
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs
if ($LASTEXITCODE) { throw "publishing the release failed" }
Write-Host "Published $tag with $($setup.Name)"
