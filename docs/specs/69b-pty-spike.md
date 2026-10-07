# 69b — PTY supervisor spike

Status: isolated local spike; **remote terminal remains disabled**. macOS arm64
packaging is exercised in this task. Linux native packaging/runtime still needs
verification on a Linux host before this task's platform matrix is complete.

## Dependency and packaging decision

Pin `node-pty` **1.1.0** with the repo's pinned Electron **44.6.0**.
The Unix addon uses Node-API (`node-addon-api`); nevertheless rebuild with the
actual Electron target and test the real packaged executable. Do not infer
compatibility from a successful host-Node import. Reference:
[Electron native modules](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules/),
[node-pty API/source](https://github.com/microsoft/node-pty/tree/1.1.0).

`electron-vite` emits `out/main/pty-supervisor.js` as an independent entry. It does
not register renderer IPC, MCP, heartbeat capabilities, inbound ports or hub RPC.
`node-pty` is a production dependency loaded lazily after local policy and audit
checks. `electron-builder` rebuilds native modules (`npmRebuild: true`), and the
whole node-pty package is unpacked from ASAR. Its native `spawn-helper` must be a
real executable on disk; the upstream loader rewrites `app.asar` to
`app.asar.unpacked`. Rebuild also avoids relying on prebuilt helper permissions.

## Local policy and scope

The future trusted desktop host constructs one `PtySupervisor` with an absolute
policy file path. No remote request may select that file or write its contents.
This spike intentionally provides no production configuration/UI switch yet.
The smoke harness creates and deletes its own temporary policy and project.

A missing, disabled, malformed, symlinked, foreign-owned or group/world-accessible
policy is refused. An example local file (mode `0600`, owned by the OS user):

```json
{
  "enabled": true,
  "osUser": "your-local-user",
  "projects": { "project-key": "/absolute/path/to/checkout" },
  "maxSessionMs": 3600000
}
```

The caller selects only a project key; the local policy supplies the cwd,
resolved with `realpath`. No caller-supplied command, cwd or environment is
accepted at spawn. Allowlist/cwd is **not filesystem isolation**: the shell has
all rights of this OS account. Shell is `/bin/bash --noprofile --norc -i`; its env
is an explicit minimum, with history disabled. User-installed CLI tools may
need future locally configured PATH support, and can still write their own logs.

One session per supervisor, 20–400 cols / 5–200 rows, input frames at most 16 KiB,
input-idle timeout 15 minutes, local absolute timeout at most 2 hours. Policy is
rechecked before input/resize and every 250 ms; opt-out or removal closes the
session without contacting the hub. TTL uses a monotonic clock. Audit exceptions
before spawn/input/resize fail closed. The audit callback is synchronous; the
future recorder must finish durable recording before returning.

All input audit events contain **only byte counts**, including echoed input.
The public node-pty API exposes no portable echo-state query; guessing from
output would race password prompts. The synthetic `stty -echo` test verifies
that its canary occurs in neither PTY output nor metadata. This is not an output
redactor or encrypted recording implementation: output goes only to the caller's
in-memory callback in this spike. Do not connect a real remote session yet.

Termination snapshots descendant PIDs and process groups (interactive jobs can
have their own groups), sends TERM, then KILL after five seconds. Escalation
rechecks process start identity to avoid blindly killing recycled PIDs. The slot
stays occupied during escalation. Cleanup is always reported as uncertain:
escaped/reparented daemons, children created after the snapshot, SSH-side work,
missing `ps`, and host/supervisor crashes cannot be proven clean. Normal shell
exit can already have reparented children. This is not an OS sandbox.

## Reproduce

From the repo root, on each target OS/architecture:

```sh
npm ci
npm run typecheck
npm test
npm run rebuild:pty -w @xdev-hive/desktop
npm run build -w @xdev-hive/desktop
npm run smoke:pty -w @xdev-hive/desktop
npm run dist:dir -w @xdev-hive/desktop
# macOS arm64: argument is relative to apps/desktop (npm workspace cwd)
npm run smoke:pty -w @xdev-hive/desktop -- 'release/mac-arm64/xDev Hive.app'
# Linux native build; pass whichever architecture's unpacked directory was built
npm run smoke:pty -w @xdev-hive/desktop -- release/linux-arm64-unpacked
```

`smoke:pty` runs Electron-as-Node, loads the built supervisor (inside the packaged
ASAR when supplied an app), and verifies native spawn, dimensions, env/history,
no-echo, input limits, audit failure, local opt-out, TTL, and TERM-resistant child
and grandchild termination. It prints only result metadata, never PTY contents.
No display server is required for this native-addon harness. This does not test
the GUI or relay. Run a native Linux build, not a macOS cross-build, to establish
Linux compatibility; repeat for x64 before advertising it.

## Remaining gates

- Linux native packaging/runtime evidence; macOS x64 and Linux x64/arm64 matrix.
- 69d: encrypted durable recorder, output redaction, quotas, retention and ACL.
- 69e: isolated long-lived helper lifecycle, lease/revoke protocol, sequence,
  backpressure, locks/update drain, parent death and restart/orphan reconciliation.
- No production rollout based solely on this spike. No remote capability is
  advertised, and the roadmap completion/version bump awaits the platform gate.
