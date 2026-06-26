# Windows x64 runtime verification (Phase 12).
#
# Verifies the built release app + bundled sidecar .exe: structure, direct
# sidecar /health, and the app launch -> sidecar spawn -> /health -> quit ->
# cleanup lifecycle. No GUI screen inspection; no cloud/keyring secrets.
#
# Uses the raw release output (target/release): Tauri copies the externalBin
# sidecar next to the main binary, so this exercises the same spawn path the
# packaged app uses, without needing a silent NSIS install in CI.
param([switch]$RequireLaunch, [switch]$SkipLaunch)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$Rel = "src-tauri/target/release"
$MainExe = "$Rel/storage-agent-workbench.exe"
$Sidecar = "$Rel/storage-agent-sidecar.exe"
# Fallback to the externalBin source if Tauri did not stage a copy next to the binary.
if (-not (Test-Path $Sidecar)) {
  $Sidecar = "src-tauri/binaries/storage-agent-sidecar-x86_64-pc-windows-msvc.exe"
}

if (-not (Test-Path $MainExe)) {
  Write-Error "ERROR: $MainExe not found. Run scripts/build-desktop-windows.ps1 first."
  exit 1
}

$pyArgs = @("--main-exe", $MainExe, "--sidecar", $Sidecar, "--install-root", $Rel)
if ($RequireLaunch) { $pyArgs += "--require-launch" }
if ($SkipLaunch) { $pyArgs += "--skip-launch" }
python scripts/verify-runtime-common.py @pyArgs
exit $LASTEXITCODE
