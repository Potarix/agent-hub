# Agent Hub Release Guide

## Local DMG Build

Use this for a local, unsigned smoke-test build:

```bash
npm install
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

Artifacts are written to `dist/`. On macOS, `dist:mac` builds both the DMG and the updater ZIP/metadata for the current CPU architecture.

Useful variants:

```bash
npm run dist:mac:arm64
npm run dist:mac:x64
npm run dist:mac:universal
npm run dist:mac:dmg
```

`dist:mac:dmg` creates only a DMG. It is useful for manual installation tests, but it does not create every file needed for in-app updates.

## Signed Public Release

For public downloads that open normally under Gatekeeper, use a Developer ID signed and notarized release.

Prerequisites:

- Apple Developer Program membership.
- A Developer ID Application certificate available in Keychain, or provided to CI with `CSC_LINK` and `CSC_KEY_PASSWORD`.
- Xcode command line tools installed.
- GitHub release token in `GH_TOKEN`.
- App Store Connect notarization credentials. Prefer API key credentials:

```bash
export APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

App-specific password credentials also work:

```bash
export APPLE_ID=you@example.com
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=TEAMID1234
```

Release flow:

```bash
npm version patch
git push --follow-tags
```

Pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds the DMG/ZIP/blockmaps and `latest-mac.yml` on a macOS arm64 runner and publishes them to a matching GitHub release. The workflow can also be run manually from the Actions tab.

To build and publish from your laptop instead (skipping CI):

```bash
npm run publish:mac
```

The GitHub release must include the generated DMG, ZIP, blockmaps, and `latest-mac.yml`. The app's updater reads that metadata to find and install newer versions.

## In-App Updates

Agent Hub checks for updates after startup in packaged builds and exposes a manual check in Settings. Updates are disabled in development builds.

For updates to work reliably:

- Bump `package.json` `version` for every release.
- Publish the release artifacts to the configured GitHub repo.
- Keep the ZIP and `latest-mac.yml` next to the DMG. macOS updater metadata points at the ZIP.
- Sign macOS builds. Electron updater support on macOS requires a signed application.
- Do not use draft releases for public updates.
