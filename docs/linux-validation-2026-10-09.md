# Linux validation — 2026-10-09

Environment: Linux x86_64, kernel 7.0.0-38-generic, Node 24.21.0,
npm 12.0.2, Electron 44.6.0. Browser checks run under Xvfb with a
1920×1080 screen; mobile checks use Chromium at 390×844, not a physical phone.

## Fixes

- CLI upgrades use a writable user npm prefix when the system prefix cannot
  be written. The host Codex update to 0.162.0 succeeded without root.
- OpenCode's npm 12 install/upgrade explicitly allows its own postinstall
  script. Without it, the executable remains a text placeholder. Failed
  npm-installed CLIs now offer a reinstall action.
- Linux desktop packages retain the node-pty native build directory.
- Copilot versions with a trailing period are detected.
- Hub admins can open system overview links again.
- Selected Skills metadata uses the selected foreground color for contrast.
- Browser scenarios follow the current machine management sheet, diff/log
  tabs, shared read-only chat, and Today inbox routing. Backup and artifact
  checks account for data created by preceding scenarios. The run contrast
  audit waits for the disabled-to-enabled color transition to finish;
  its mobile regression passed three consecutive fresh-hub runs.
- The hidden-window smoke avoids Electron's ESM readiness deadlock and
  distinguishes an unused Chromium spare process from a retained app page.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 1,882 passed, 4 skipped, 0 failed.
- Desktop build and smoke: passed; 81 screenshots.
- Hidden-window lifecycle: passed, including 60 seconds at cold hidden
  startup, hide/resume, close to tray/reopen, and bounded crash recovery.
  Bare Xvfb did not support minimize, so the probe used its hide fallback.
  Hidden startup had no WebContents or renderer IPC; one Chromium spare
  process used approximately 64 MiB.
- Packaged PTY: passed spawn, input, resize, environment isolation,
  opt-in/allowlist, process cleanup, TTL, and audit failure checks.
- AppImage `0.147.4-linux-test.3`: extracted AppRun opened Setup and saved
  a screenshot without an externally supplied sandbox override.
- Full desktop web E2E: 94/94 passed, no console errors.
- Full mobile web E2E: 152/153 passed, no console errors. The only failure
  measured the run button during its color transition; after the test fix,
  that scenario passed 3/3 fresh-hub reruns. All 153 mobile scenarios have
  therefore passed across the full run and focused reruns; the full mobile
  suite was not repeated after that test-only fix. Terminal entry and I/O
  passed in both full runs.

## CLI scope

Claude 2.1.295, Codex 0.162.0, and Copilot 1.0.80 each answered a live minimal
prompt with `LINUX_OK`. Vibe 2.26.0 starts but cannot call its provider on this
machine without `MISTRAL_API_KEY`.

Gemini 0.63.0, Kilo 7.8.3, and OpenCode 1.18.35 were installed in a disposable
prefix and passed version/startup checks. OpenCode was also installed through
the actual Setup implementation. Provider calls for these three were not
validated with accounts. Specify 1.0.13, RTK 0.51.0, and Codegraph 1.6.0 passed
version/help checks. Antigravity is not installed.

Browser integration scenarios use disposable hubs and synthetic runner/provider
fixtures. They do not establish that every external provider or production
deployment is configured correctly.

## Local evidence and test build

- `/tmp/hive-linux-audit/web-final/result.json`
- `/tmp/hive-linux-audit/mobile-final/result.json`
- `/tmp/hive-linux-audit/mobile-contrast-final/round-{1,2,3}/result.json`
- `/tmp/hive-linux-audit/desktop-fixed/`
- `/tmp/hive-linux-audit/hidden-final.json`
- `/tmp/hive-linux-audit-pty3.log`
- `/tmp/hive-linux-audit/appimage3/start.png`
- `apps/desktop/release/linux-test/xdev-hive-0.147.4-linux-test.3-linux-x86_64.AppImage`

AppImage SHA-256: `d2f28b831059e61f492a15cb076e886b2e60e4ed21d597afe600f43578a092ce`.

The desktop menu entry **xDev Hive Linux Test** uses isolated configuration
and UI data under `~/.local/share/xdev-hive-linux-test/`. Evidence in `/tmp`
is local and temporary; the AppImage is a local prerelease, not a published
production release.
