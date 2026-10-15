# 0019. Host interactive agent sessions in the worker and control them from a paired phone

- Status: Accepted
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers
- Accepted: 2026-10-13, with the three open questions settled by the product owner (see Decision 10 to 12)

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
10. **TOTP fallback when the hub runs over HTTP** (product owner, 2026-10-13). Passkeys stay the primary method whenever
    HTTPS is available. A hub served over plain HTTP, such as the internal `http://10.86.224.34:3000`, cannot use
    WebAuthn, so the worker accepts a TOTP code instead:
    - The worker creates the 160-bit key on the machine, shows it as an `otpauth://` QR code for an Authenticator app,
      and stores it only after the owner enters one correct code. The hub never sees or stores the key.
    - The worker checks the code itself for every session start and every control request. The hub only relays it.
    - Each action needs a newer code than the last accepted one (the last time step is kept on disk). Five wrong
      codes in a row lock the machine for 5 minutes, doubling up to 1 hour. Every step is audited on the hub and on
      the machine.
    - The `auth` field of `term_start` and `term_control` becomes `passkey | totp`. `welcome.policy.totpFallback` lets
      an organization disable the fallback.
    - The desktop app and the web warn when remote control is used on an HTTP hub.

    This is a weaker guarantee and the ADR records it: the code is not bound to the request, and on HTTP it crosses the
    network in clear. A compromised hub, or anyone who can read the traffic, sees the code and the session content, and
    can use the code once before the user does. TOTP still stops a stolen web session or personal token on its own.
    Use it only inside an internal network.
11. **Sessions are private by default** (product owner). Only the owner sees a session live and its recording. The owner
    turns on "Cho đội xem" for each session; a session linked to a task does not open itself to the team.
12. **Remote sessions never run with all permissions** unless the owner enables that on the machine and the
    organization policy allows it.

## Consequences

- Good: the hub, its operators and stolen web sessions cannot start a session, type into one or enable remote control.
  The worst case is reading output, ending sessions or showing false output.
- Good: one PTY path serves the local terminal, the phone, recordings and future clients. Sessions outlive terminal
  windows and network drops.
- Good: the code reuses the account picker, the worker's disk buffer with acks, personal tokens, the desktop sidecar
  pattern and the signed releases.
- Bad: passkeys and the PWA need an HTTPS hub, because WebAuthn and service workers require a secure context. A hub
  served over plain HTTP, like the internal machine 34, falls back to TOTP (Decision 10) with a weaker guarantee, no PWA
  and no push notifications.
- Bad: on an HTTP hub, session content and keystrokes travel unencrypted, and a hub compromise or a network sniffer is
  enough to use a code in flight. The warning in the app and web, the organization policy switch and the advice to stay
  on an internal network are the only mitigations; moving the hub to HTTPS removes the risk.
- Bad: the wrong-code lock is per machine, so someone with a stolen web session can lock the owner out of remote control
  on purpose. The owner unlocks at the machine.
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
- **Require HTTPS and passkeys with no fallback.** Proposed first, then rejected by the product owner: the team's
  internal hub runs over HTTP and still needs remote control. TOTP kept by the worker is the accepted compromise.
- **Hub-side OTP or password as the second factor.** Rejected: a compromised hub would check its own factor. The
  worker holds the TOTP key and checks the code, so the hub has no authority to approve.
- **Trust the hub to authorize remote access** (web session plus a hub-side second factor). Rejected: a compromised hub
  would mean a shell on every enabled laptop.
- **Full end-to-end encryption of output.** Deferred: the hub could no longer record sessions or serve several viewers.
  It can come later as a per-session option ("không ghi lại").
- **A native mobile app.** Rejected by the product owner. A PWA covers the terminal, home-screen install and push
  notifications on iOS 16.4+ and Android.
- **Reuse `runs` with a new kind.** Rejected for the reasons in decision 7.

## Links

- [specs/010-hive-cli-remote](../../specs/010-hive-cli-remote/spec.md), SRS RMT-01 … RMT-13, IF-07, NFR-17
- [0006](0006-outbound-worker-protocol.md), [0011](0011-signed-worker-releases-and-own-updater.md),
  [0016](0016-desktop-local-ui.md), [0017](0017-admin-web-client-app-and-machine-ownership.md)
