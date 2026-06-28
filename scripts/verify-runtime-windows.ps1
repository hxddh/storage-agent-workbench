# Windows x64 runtime verification (Phase 12).
#
# Verifies the built release app + bundled sidecar .exe: structure, direct
# sidecar /health, and the app launch -> sidecar spawn -> /health -> quit ->
# cleanup lifecycle. No GUI screen inspection; no cloud/keyring secrets.
#
# Uses the raw release output (target/release) for the main binary, plus the
# staged one-dir sidecar bundle for the direct sidecar smoke — no need for a
# silent NSIS install in CI.
param([switch]$RequireLaunch, [switch]$SkipLaunch)
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

$Rel = "src-tauri/target/release"
$MainExe = "$Rel/storage-agent-workbench.exe"
# The sidecar is a PyInstaller one-dir bundle staged for Tauri's resources; its
# launcher sits next to its _internal/ libs, so it runs standalone for the smoke.
$Sidecar = "src-tauri/sidecar-dist/storage-agent-sidecar/storage-agent-sidecar.exe"

if (-not (Test-Path $MainExe)) {
  Write-Error "ERROR: $MainExe not found. Run scripts/build-desktop-windows.ps1 first."
  exit 1
}

$pyArgs = @("--main-exe", $MainExe, "--sidecar", $Sidecar, "--install-root", $Rel)
if ($RequireLaunch) { $pyArgs += "--require-launch" }
if ($SkipLaunch) { $pyArgs += "--skip-launch" }
python scripts/verify-runtime-common.py @pyArgs
exit $LASTEXITCODE
