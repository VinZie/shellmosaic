# Build a signed Shellmosaic release and publish it on GitHub: the NSIS installer, its
# signature, and the latest.json the built-in updater reads.
#
#   pwsh scripts/release.ps1            # publish
#   pwsh scripts/release.ps1 -Draft     # create a draft release to review first
#
# Needs: gh (logged in), the signing key (see CONTRIBUTING.md#releases).
param(
  [switch]$Draft,
  [string]$Key = "$env:USERPROFILE\.tauri\shellmosaic-updater.key",
  [string]$Repo = "VinZie/shellmosaic"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json).version
$tag = "v$version"
if (-not (Test-Path $Key)) { throw "Signing key not found: $Key" }

# release notes: this version's section of CHANGELOG.md
$changelog = Get-Content "$root\CHANGELOG.md" -Raw
$m = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version))\b[^\n]*\n(.*?)(?=^## |\z)")
$notes = if ($m.Success) { $m.Groups[1].Value.Trim() } else { "Shellmosaic $version" }

# A separate target folder: an installed or running Shellmosaic keeps target\release\shellmosaic.exe locked.
$env:CARGO_TARGET_DIR = "$root\src-tauri\target-dist"
$env:TAURI_SIGNING_PRIVATE_KEY = $Key
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
Push-Location $root
try {
  pnpm tauri build --bundles nsis
  if ($LASTEXITCODE) { throw "build failed" }
} finally {
  Pop-Location
  Remove-Item Env:CARGO_TARGET_DIR, Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
}

# the license notices of everything shipped inside, attached to the release
pwsh -NoProfile -File "$root\scripts\third-party-licenses.ps1"
if ($LASTEXITCODE) { throw "collecting third-party licenses failed" }

$setup = Get-Item "$root\src-tauri\target-dist\release\bundle\nsis\Shellmosaic_${version}_x64-setup.exe"
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
if ($Draft) { $ghArgs += "--draft" }
gh @ghArgs
if ($LASTEXITCODE) { throw "publishing the release failed" }
Write-Host "Published $tag with $($setup.Name)"
