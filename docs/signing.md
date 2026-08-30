# Signing and notarization

> **Storage Agent v0.93.0 distribution status.**
>
> Current macOS releases are **ad-hoc signed and not notarized**. Current Windows installers are **not Authenticode-signed**. Signing/notarization is a distribution concern; it does not change the Agent Task runtime, safety model, or local data model.

## Current shipped state

### macOS

The release build is ad-hoc signed so the bundle has a valid local code-signing seal, but it is not signed with a trusted Developer ID identity and is not submitted to Apple notarization.

Consequences:

- downloaded builds can trigger Gatekeeper warnings/quarantine behavior;
- users must verify the release/checksum themselves and may need Finder **Right-click → Open** or the documented quarantine-removal command;
- the release is not eligible for the normal zero-warning notarized distribution experience.

See [`install.md`](install.md).

### Windows

The current setup executable is not Authenticode-signed, so SmartScreen/reputation warnings can appear for downloaded builds.

### Linux

The `.deb` is not backed by a repository/package-signing distribution chain in the current release model. Integrity is provided through the GitHub Release source plus SHA256 manifests.

## Why macOS uses an ad-hoc seal today

The desktop bundle contains a PyInstaller one-dir Python Sidecar. The app bundle still needs a valid code-signing/resource seal to launch reliably after packaging.

The default repository build therefore performs an application-owned ad-hoc sealing step and verifies the final bundle.

This is distinct from trusted distribution:

```text
ad-hoc seal
  -> bundle integrity/local launch mechanics
  -> no Apple identity trust
  -> no notarization

Developer ID + notarization
  -> trusted signing identity
  -> hardened runtime requirements
  -> notarization + stapling
  -> normal Gatekeeper distribution path
```

## PyInstaller Sidecar and hardened runtime

A notarized macOS application must use the hardened runtime. The embedded Python runtime/DuckDB/native libraries require a carefully defined entitlement/signing configuration; simply turning hardened runtime on without the required entitlements can prevent the Sidecar from loading.

The repository includes `scripts/macos-entitlements.plist` for the intended Developer ID path. Its permissions are security-sensitive and should be reviewed before enabling trusted distribution. Do not broaden entitlements merely to make a failing build pass.

## Future Developer ID / notarized release path

A trusted macOS release requires, at minimum:

1. an active Apple Developer Program team;
2. a **Developer ID Application** signing identity/certificate;
3. notarization credentials supported by the CI/release workflow;
4. hardened runtime enabled for the app;
5. only the entitlements actually required by the embedded runtime;
6. signing of nested native code/resources as required by the final bundle;
7. submission to Apple's notarization service;
8. successful notarization result and ticket stapling;
9. validation of the final downloadable `.app`/`.dmg` rather than only the pre-package app.

Exact CI secret names and workflow wiring are implementation details of the release workflow and should be documented when that path is actually enabled. Do not describe trusted signing as active merely because placeholder environment variables or an entitlement file exists in the repository.

## Important: do not overwrite a real signature

The current ad-hoc sealing script belongs only to the unsigned/ad-hoc release path.

If a future build is signed with Developer ID and notarized, the release workflow must **skip any later ad-hoc re-sign step**. Re-signing the final bundle ad-hoc would replace the trusted signature and invalidate the notarized distribution result.

## Verification — current ad-hoc macOS build

For the current release path, verify the bundle seal, for example:

```bash
codesign --verify --deep --strict "Storage Agent.app"
codesign -dv --verbose=4 "Storage Agent.app"
```

The expected result is a valid ad-hoc-signed bundle, **not** a claim of Apple notarization.

Also run the repository's packaged runtime verification so the embedded Sidecar actually launches; a valid seal alone is not sufficient.

## Verification — future notarized macOS build

When the trusted path is enabled, acceptance should include checks equivalent to:

```bash
spctl -a -vvv "Storage Agent.app"
xcrun stapler validate "Storage Agent.app"
```

and validation of the final distributed DMG/app zip as appropriate.

Expected state should explicitly identify a notarized Developer ID result. Do not keep the current Gatekeeper-bypass install instructions as the normal happy path after notarization ships.

## Windows signing direction

If Windows distribution is hardened later, use a real Authenticode code-signing identity and verify the final installer signature in CI/release acceptance. Update `install.md`, `release.md`, and `release-smoke-test.md` in the same change so users are not told to bypass warnings that no longer apply.

## Secret handling for signing credentials

Signing/notarization credentials are CI/release secrets, not application/provider secrets.

Rules:

- never commit certificates, private keys, passwords, API keys, or signing credentials to the repository;
- never expose them to the Agent runtime or local application vault;
- scope CI permissions/secrets to release jobs that actually need them;
- do not print secret values in build logs;
- clean up ephemeral keychains/material according to the CI runner lifecycle.

## Documentation update rule

When trusted signing/notarization becomes active:

- update this file from “future path” to the exact current implementation;
- update `install.md` first-launch expectations;
- update `release.md` required gates/secrets without publishing secret values;
- update `release-smoke-test.md` to verify trusted signatures/notarization;
- update `roadmap.md` to remove the shipped distribution gap.

Until then, the only correct public statement is: **macOS is ad-hoc signed, not notarized; Windows is not Authenticode-signed.**
