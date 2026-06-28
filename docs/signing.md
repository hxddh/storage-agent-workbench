# macOS code signing & notarization

## TL;DR

The only way to make the app open with **no Gatekeeper prompt** on other people's
Macs is **Apple notarization**, which requires a **paid Apple Developer Program
membership ($99/yr)** and a **Developer ID Application** certificate. There is no
free workaround — ad-hoc/unsigned downloads are always quarantined by macOS.

This repo ships **ad-hoc signed, not notarized** builds by default (free, no Apple
account). They are fully functional; the user just has to get past Gatekeeper once
(right-click → Open, or clear the quarantine attribute — see
[install.md](install.md)). The notarization pipeline below is wired to turn on the
moment the Apple credentials are added as CI secrets.

## How a comparable app does it (reference)

[`hanxiao/omni-macos`](https://github.com/hanxiao/omni-macos) takes the proper
path and its README is explicit that it "needs the paid Apple Developer Program
($99/yr)." Its release workflow:

1. Imports a base64-encoded **Developer ID Application** `.p12` into an ephemeral
   keychain (secrets `DEVELOPER_ID_P12`, `DEVELOPER_ID_P12_PASSWORD`).
2. Builds with `CODE_SIGN_IDENTITY="Developer ID Application"`,
   `CODE_SIGN_STYLE=Manual`, `--timestamp`, team `APPLE_TEAM_ID`.
3. **Notarizes** the `.app` and `.dmg` with `notarytool` using App Store Connect
   credentials (`AC_APPLE_ID`, `AC_PASSWORD`, team id) and **staples** the ticket.

The result opens with zero prompts. Note: omni-macos has **no Python sidecar**, so
it doesn't hit the hardened-runtime problem we do (below).

## Our extra wrinkle: the Python sidecar + hardened runtime

Notarization requires the **hardened runtime**. Under it, our bundled PyInstaller
Python sidecar can't load its embedded libraries/framework and never starts (this
is exactly why the default build is ad-hoc **without** the hardened runtime). So a
notarized build must also ship entitlements that re-allow what the sidecar needs:
[`scripts/macos-entitlements.plist`](../scripts/macos-entitlements.plist)
(`disable-library-validation`, `allow-dyld-environment-variables`,
`allow-unsigned-executable-memory`, `allow-jit`).

## Enabling notarized releases (when you have a paid account)

1. **Enroll** in the Apple Developer Program ($99/yr) and create a **Developer ID
   Application** certificate. Export it as a `.p12`.
2. Create an **app-specific password** for your Apple ID (for notarytool).
3. Add these **GitHub Actions secrets** (Tauri reads these env vars and will sign
   **and** notarize during `cargo tauri build`):
   - `APPLE_CERTIFICATE` — base64 of the `.p12`
   - `APPLE_CERTIFICATE_PASSWORD` — the `.p12` password
   - `APPLE_SIGNING_IDENTITY` — e.g. `Developer ID Application: Your Name (TEAMID)`
   - `APPLE_ID` — your Apple ID email
   - `APPLE_PASSWORD` — the app-specific password
   - `APPLE_TEAM_ID` — your 10-char team id
4. In `src-tauri/tauri.conf.json` set the macOS signing config to use the
   Developer ID identity, the hardened runtime, and the entitlements file, e.g.:
   ```json
   "bundle": {
     "macOS": {
       "signingIdentity": "Developer ID Application: Your Name (TEAMID)",
       "hardenedRuntime": true,
       "entitlements": "../scripts/macos-entitlements.plist"
     }
   }
   ```
5. In `.github/workflows/release.yml`, pass the secrets as env on the build step
   and **skip the ad-hoc re-sign** (`scripts/sign-macos-app-bundle.sh`) — Tauri
   will sign + notarize + staple itself. The ad-hoc seal is only for the
   unsigned path and would clobber a real Developer ID signature.
6. Verify: `spctl -a -vvv "Storage Agent Workbench.app"` should report
   `accepted` / `source=Notarized Developer ID`, and `xcrun stapler validate`
   should pass.

Until those secrets exist, the workflow keeps producing the ad-hoc build and the
[install.md](install.md) one-time Gatekeeper steps apply.
