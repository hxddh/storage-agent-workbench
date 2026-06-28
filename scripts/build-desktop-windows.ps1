# Build the Windows x64 desktop app for Storage Agent Workbench (Phase 11).
#
# Steps: frontend build -> one-dir sidecar build + stage resource ->
# cargo check -> cargo build -> attempt `cargo tauri build --bundles nsis`.
# Produces an UNSIGNED installer. No signing, no auto-update.
#
# Requires: Rust (MSVC target), tauri-cli, Node, Python 3.12+ with sidecar deps
#   (pip install -e "./sidecar[dev]" "./sidecar[packaging]").
$ErrorActionPreference = "Stop"
$Repo = Split-Path -Parent $PSScriptRoot
Set-Location $Repo

Write-Host "==> [1/5] Building frontend"
Push-Location frontend; npm install; npm run build; Pop-Location

Write-Host "==> [2/5] Building sidecar one-dir + staging resource"
python scripts/build-sidecar-for-tauri.py

Write-Host "==> [3/5] cargo check"
Push-Location src-tauri; cargo check; Pop-Location

Write-Host "==> [4/5] cargo build"
Push-Location src-tauri; cargo build; Pop-Location

Write-Host "==> [5/5] cargo tauri build (Windows NSIS installer; unsigned)"
$haveTauri = $false
try { cargo tauri --version | Out-Null; $haveTauri = $true } catch { $haveTauri = $false }
if ($haveTauri) {
  Push-Location src-tauri
  try { cargo tauri build --bundles nsis }
  catch { Write-Host "NOTE: bundling failed; the binary still builds via 'cargo build'. See docs/release.md." }
  Pop-Location
} else {
  Write-Host "Tauri CLI not installed (cargo install tauri-cli --locked). Skipping bundle."
}

Write-Host "==> Artifacts:"
Get-ChildItem -Path "src-tauri/target/release/bundle/nsis/*.exe" -ErrorAction SilentlyContinue |
  ForEach-Object { $_.FullName }
python scripts/verify-desktop-artifacts.py
Write-Host "==> Done (unsigned Windows build)."
