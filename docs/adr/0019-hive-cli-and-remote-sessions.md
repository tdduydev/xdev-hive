# 0019. Host interactive agent sessions in the worker and control them from a paired phone

- Status: Proposed
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

The product owner asked for a Hive command line tool, and later for driving it remotely from a phone: "có thể tự viết
cli hem, sau này có thể làm remote cli trên app luôn, trên dt ấy". Two points are settled:

1. The `hive` CLI wraps the agent CLIs already on the machine (Claude Code, Codex, Gemini CLI, Antigravity). Hive does
   not write its own agent.
2. Remote control goes through the hub web app on the phone, installed as a PWA. There is no separate mobile app.

What exists today:

- The worker runs agents headless over pipes (`claude -p --input-format stream-json`). It has no PTY and no local
  socket. The desktop app drives it only through sidecar stdio and `hive-worker accounts … --json`.
- The worker protocol is a zod discriminated union. The hub closes the socket with 4400 on a packet type it does not
  know, while the worker logs and skips unknown packets. `welcome` carries no hub capabilities.
- Personal tokens (`hive_pat_…`, 90 days, bound to one organization) already authenticate `/rpc`, `/api` and SSE.
- Personal machines run only their owner's work ([0017](0017-admin-web-client-app-and-machine-ownership.md)).

An interactive agent session can run shell commands on the developer's machine. Remote control therefore turns the hub
into a path to a shell on every enabled laptop. The threat that matters most is a compromised hub, a malicious hub
operator, or a stolen web session. Each of these must be unable to start a session or type into one.

## Decision

1. **Separate `hive` binary in the worker module.** `worker/cmd/hive` builds next to `worker/cmd/hive-worker` from the
   same Go module and shares `internal/accounts`, `internal/config` and the protocol types. It ships in the same signed
   release archive and the same `checksums.txt`. `hive-worker update` replaces both binaries together. The desktop app
   bundles both as sidecars.
2. **The worker hosts sessions; the CLI is a client.** The worker owns each PTY: it spawns the agent CLI with the
   account picked from `accounts.json`, records output, and multiplexes clients. `hive run` talks to the worker over a
   per-user local socket: a Unix socket with mode 0600 plus a peer UID check, or a named pipe whose DACL allows only
   the current user. The CLI then attaches the terminal in raw mode. Sessions survive closing the terminal, like tmux.
   The phone reaches the same PTY through the worker's existing WSS connection.
3. **Remote control is off by default and can be switched on only at the machine.** The switch and its settings
   (allowed root folders, paired devices, timeouts) live in `remote.json` next to `worker.json`, mode 0600. Only the
   local socket can change them, which means only the desktop app or `hive remote` on the machine. The hub may switch
   remote control off, revoke a device and end sessions. It can never switch remote control on or add a device. Remote
   control is refused on shared machines and runner hosts.
4. **Device-bound authorization that the worker verifies.** The phone is paired once at the machine:
   - The worker shows a QR code carrying a one-time pairing secret in the URL fragment, so it never reaches the hub.
   - The phone creates a WebAuthn passkey for the hub origin and sends its public key plus an HMAC over that key,
     keyed by the pairing secret.
   - The owner confirms on the machine.

   Every remote session start and every request for control then carries a fresh WebAuthn assertion with user
   verification. Its challenge is the hash of the canonical request: machine, action, parameters, the phone's ephemeral
   ECDH key, a timestamp and a nonce. The worker checks the assertion against its local device list, the hub origin
   from `worker.json`, the time window and a replay cache. The hub only relays.
5. **Input integrity end to end; output readable by the hub.** On a control grant the phone and the worker derive a key
   with ECDH P-256 and HKDF. Every input packet carries an HMAC and a strictly increasing sequence number, so the hub
   cannot inject or reorder keystrokes. Output is plaintext to the hub, which records it for replay and fans it out to
   viewers.
6. **Protocol extension without a version bump.**
   - New `term_*` packet types are added to `worker-protocol.ts`.
   - The worker announces the `terminal` capability in `hello`.
   - The hub announces `features: ["terminal"]` in a new optional `welcome` field.
   - Each side sends `term_*` packets only after seeing the other side's flag.

   Old hubs never receive unknown packets, and old workers never receive them either. `PROTOCOL_VERSION` stays 1.
7. **A new hub module `terminal`.** It owns `terminal_sessions`, `terminal_chunks` (recorded output),
   `terminal_events`, `remote_devices` (a mirror of the worker list, used for display) and `push_subscriptions`.
   Sessions are not runs:
   - `runs.project_id` is required, but a session may have no project.
   - A session has no lease, attempt, outcome policy or verification.
   - A session must not count against `runs_task_active`.

   A session may link to a project and task, and the task page lists it.
8. **Browser transport is a WebSocket.** `/ws/terminal` carries binary output frames and JSON control frames. A browser
   joins with a single-use ticket that expires in 60 seconds, issued by `terminal.ticket`, and the endpoint checks
   `Origin`. SSE plus one POST per keystroke was rejected because it gives no ordering and costs too much per key.
9. **One controller.** Each session has one controller: the local terminal or one paired remote device. Any number of
   read-only viewers may watch. The local terminal can always take control back. Nobody but the machine owner can ever
   control a session.

## Consequences

- Good: the hub, its operators and stolen web sessions cannot start a session, type into one or enable remote control.
  The worst case is reading output, ending sessions or showing false output.
- Good: one PTY path serves the local terminal, the phone, recordings and future clients. Sessions outlive terminal
  windows and network drops.
- Good: the code reuses the account picker, the worker's disk buffer with acks, personal tokens, the desktop sidecar
  pattern and the signed releases.
- Bad: remote control needs an HTTPS hub, because WebAuthn and service workers require a secure context. A hub served
  over plain HTTP, like the internal machine 34, cannot use it.
- Bad: the hub can read terminal output, which may contain secrets the agent prints. Recordings follow the agent policy
  retention and are private to the owner by default.
- Bad: it adds the first Go dependencies for PTY handling (`aymanbagabas/go-pty`, with ConPTY on Windows) and for the
  OS keychain. WebAuthn checking uses only the standard library: SPKI from `getPublicKey()`, ES256, and no CBOR.
- Bad: synced passkeys (iCloud Keychain, Google Password Manager) bind trust to the platform account rather than to one
  physical phone.

## Alternatives considered

- **Subcommands of `hive-worker`** (`hive-worker chat`). Rejected: `hive-worker run` already starts the daemon, the
  long name is awkward for daily use, and help would mix daemon flags with user commands.
- **One multi-call binary** that dispatches on `argv[0]`. Rejected: symlinks need privileges on Windows, Tauri sidecar
  naming expects distinct files, and the size saved (about 15 MB) does not justify the confusion.
- **The CLI owns the PTY and opens its own hub connection.** Rejected: a second machine connection would need its own
  credentials and lease logic, the session would die with the terminal window, and the phone path would differ from the
  local one.
- **Trust the hub to authorize remote access** (web session plus a hub-side second factor). Rejected: a compromised hub
  would mean a shell on every enabled laptop.
- **Full end-to-end encryption of output.** Deferred: the hub could no longer record sessions or serve several viewers.
  It can come later as a per-session option ("không ghi lại").
- **A native mobile app.** Rejected by the product owner. A PWA covers the terminal, home-screen install and push
  notifications on iOS 16.4+ and Android.
- **Reuse `runs` with a new kind.** Rejected for the reasons in decision 7.

## Links

- [specs/010-hive-cli-remote](../../specs/010-hive-cli-remote/spec.md), SRS RMT-01 … RMT-12, IF-07, NFR-17
- [0006](0006-outbound-worker-protocol.md), [0011](0011-signed-worker-releases-and-own-updater.md),
  [0016](0016-desktop-local-ui.md), [0017](0017-admin-web-client-app-and-machine-ownership.md)
