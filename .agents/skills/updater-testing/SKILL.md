---
name: updater-testing
description: Use when testing, reproducing, or verifying a desktop update install - the Electron updater, the AppImage or NSIS handoff, a stuck or silently skipped update, or any change to the quit/install sequence.
---

# Updater Testing

A desktop update cannot be judged from code review. The failures live in the handoff between the app and the platform installer, and they are intermittent, platform-shaped, and silent when they go wrong. This skill runs a real update against a loopback feed, so the installer path executes for real while the feed does not.

Companion: `desktop-shell` owns the Electron privilege boundary and the native lifecycle. This skill owns the procedure for exercising an update end to end.

## What a Run Proves And Does Not Prove

A passing run proves the update installed on **the platform you ran it on**. It says nothing about the others: macOS goes through Squirrel.Mac and a different `quitAndInstall()`, Windows through NSIS, Linux through AppImage replacement. Name the platform in every result.

macOS cannot reproduce the class of defect where closing a window ends the app, because the quit-on-last-window-closed paths are guarded to non-darwin. Use Linux to exercise that arbitration; it shares the path with Windows.

## Prepare Two Builds

1. Work in a separate source copy, a separate application profile, and a writable run directory. The working installation and its data stay untouched. The feed fixture alone is not profile isolation: check the launcher and runtime configuration.
2. Bump the version across the root and the three workspaces together, once per build. A partial bump produces builds that disagree about their own version:

   ```bash
   npm pkg set version=<version> \
     --workspace @openchamber/electron \
     --workspace @openchamber/web \
     --workspace @openchamber/ui \
     --include-workspace-root
   ```

3. Package version N and a higher N+1 on a native host of the target architecture, each into its own output directory, with the fixture's compile-time gate set while bundling main. `packages/electron/scripts/updater-e2e-fixture.md` is the command source of truth; read it rather than copying commands from here.

Preparation is done when both artifacts exist, each reports the version you intended, and the run directory holds its own copy of N for the updater to replace.

## Three Gates, All Required

The loopback feed activates only with all three present. Missing one silently falls back to the production GitHub feed, and the run then tests nothing:

- `OPENCHAMBER_UPDATER_E2E_BUILD=1` embedded while bundling main;
- `OPENCHAMBER_E2E=1` at run time;
- `OPENCHAMBER_UPDATER_E2E_URL` pointing at the loopback feed.

Published release artifacts can never be used as N: they carry no build-time marker. The renderer, IPC bridge, command line, and stored configuration have no access to the feed URL by design.

## Drive It Without A GUI

The update does not need a human clicking Update. The running app's own server exposes the same operation, which is what makes this testable over SSH on a headless host:

- `POST /api/openchamber/update-install` requests the install and reports `updateOwner: electron-updater`.
- `POST /api/config/reload` exercises Restart OpenCode afterwards.

Check the current route contract and authentication before relying on either; they are product routes, not a test harness.

## Verify More Than The Version Number

A version bump is the weakest possible evidence. Record each of these:

- the restarted app reports N+1;
- the AppImage at the run path was replaced, and its checksum matches the prepared N+1 artifact;
- the new app process runs from the new mount;
- **the live OpenCode process executable, read through `/proc`, runs from the new mount**, including after Restart OpenCode;
- the OpenCode API reports `source: bundled` and `upgrade.reason: bundled`, and offers no separate OpenCode update.

That fourth check exists because of a real regression: the app exported an auto-resolved bundled path through `OPENCODE_BINARY`, the replacement process inherited it, and treated the old path as a deliberate user override. Everything looked correct except the running binary.

## Exercise The Failure, Not Only The Happy Path

Run the update a second time and close the application window immediately after requesting the install, while the backend is still shutting down. Quit arbitration during that window is where installs get cancelled with the download sitting unused, and the happy path never touches it.

## Cleanup

Stop the test application, the fixture server, and any test service, then confirm their ports are no longer listening. Report tested versions, architecture, artifact checksums, process paths, and every check you could not complete.
