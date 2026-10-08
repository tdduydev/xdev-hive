# 69e — Terminal relay v1

Status: built behind the same gates as the rest of spec 69, **off in production**. The hub takes no machine socket
until it has a pinned machine identity (`HubAppOptions.terminalIdentity`, from SEC-machine-identity, which is not
merged yet), the hub flag `HIVE_REMOTE_TERMINAL=1` stays off until 69g, and a machine connects only after the person
there wrote its local policy file. Parent spec: [69-remote-terminal.md](69-remote-terminal.md) §5–§7, §11.

## Pieces

| Where | File | Role |
|---|---|---|
| core (browser-safe) | `packages/core/src/terminal-relay.ts` | hub↔machine frames, `OutputRing`, `InputGate`, `TerminalLease`, `TokenBucket`, `OutputWindow` |
| core (node) | `packages/core/src/ws-codec.ts` | RFC 6455 text/ping/pong/close for both ends (`WsReader`, `WsPeer`) |
| hub | `apps/web/src/terminal-relay.ts` | `TerminalRelayHub`: browser and machine sockets, the sweep |
| hub | `apps/web/src/terminal.ts` | upgrade of `/api/terminal/machine-socket` (bearer + pinned identity + `hive-terminal-machine.v1`) |
| machine | `apps/desktop/src/main/pty/relay-agent.ts` | `MachineTerminalAgent`: frames ↔ `PtySupervisor`, recorder, lease, ring |
| machine | `apps/desktop/src/main/pty/machine-socket.ts` | outbound WSS with backoff; the token only in `Authorization` |
| machine | `apps/desktop/src/main/pty/remote-terminal.ts` | local policy → capability in the heartbeat, starts and stops the relay |
| machine | `apps/desktop/src/main/resource-locks.ts` | checkout locks shared with runs, merge queue and release |

## Protocol decisions

- **Lease is relative** (`leaseMs`, ≤30 s), counted on the machine's monotonic clock. An absolute `leaseExpiresAt` would
  trust two wall clocks to agree. The hub renews every `leaseRenewMs` (10 s), and only while every right still holds.
- **Resume pointer is the first browser `ack`.** The ticket carries no `lastOutputSeq`, so a new browser socket sends
  `ack {outputSeq}` first. The hub turns it into `replay {afterSeq}`. No output flows to a socket before that ack.
- **The machine sends output only between `replay` and `detach`** (or a lost socket). Otherwise it reads into the RAM
  ring (4 MiB / 5 min). A reattach past the ring gets `gap`, never a partial transcript passed off as complete.
- **Input is never buffered or resent by the hub.** With no machine socket, the keystroke is dropped, counted
  (`terminal.inputRejected · machineOffline`) and never acked. A machine back later does not get it.
- **Dedup:** exactly the next `inputSeq` of the current epoch is written. A duplicate is acked again and not written. The
  epoch moves only through the hub's `open`/`lease`, never because an input frame claims a newer one. A new epoch
  restarts at seq 1, so `inputAck` carries its epoch: an old-epoch ack never reaches the new tab.
- **Ack after audit:** the supervisor's synchronous audit sink is the recorder. `sensitive-input` (bytes only) is
  written before `pty.write`, and only then is the input acked. If the recorder throws, nothing is acked or written,
  and the session ends `failed/auditFailed`. Output that cannot be recorded also ends the session.
- **Backpressure:** both ends keep an `OutputWindow`. The machine pauses PTY reads past 1 MiB unacked and resumes on
  ack. The hub lets go of a browser past the 4 MiB cap or paused for more than 10 s (close 4429, session `detached`, shell
  keeps running). Output over the hub's 1 MiB/s (burst 4 MiB) budget becomes a `gap`. Input over 64 KiB/s is refused.
- **Reconcile on hello:** the machine's first frame lists what it still runs. A live hub session the machine does not
  list becomes `failed/supervisorRestart` (`cleanupUncertain`), never respawned. A listed session the hub already
  ended is killed. Reports the hub missed are queued on the machine and sent right after the next hello.

## The hub's sweep (default 500 ms)

Checked in this order:

1. The hub flag (→ `revoked/hubDisabled`).
2. The browser session still signed in (→ `logout`).
3. The machine row and its opt-in (→ `accessRevoked`, `localOptOut`).
4. The attached person, rechecked from the cookie through `terminalDecision` with the pinned owner (→ `logout`,
   `accessRevoked`).
5. The clocks: absolute TTL, machine gone for a whole lease (→ `leaseLost`), unattached, idle input, detached grace.

A session that ends gets `kill` on the machine socket at once, so an online revoke reaches the machine in ≤2 s. A
partitioned machine kills at its own lease end (≤30 s). Machine sockets whose bearer no longer authenticates (token or
parent revoked) are closed at the next sweep, and their leases then run out.

## Locks and update drain (§11)

`ResourceLocks` keys on project + checkout (`repo`, `worktree:<task>`). Runs, the merge queue and releases answer
through a probe (`Runner.checkoutBusy`); the merge queue and release worker count as holding `repo` of every project
while they run. While a terminal holds a checkout:

- a run in that worktree waits (`runNote.waitingTerminal`);
- merge-queue polling and auto-release skip that project.

A terminal open on a held checkout fails `spawnFailed`. The idle update waits for open terminals (deadline up to their
absolute TTL), and no new shell opens while the app drains for an update.

## Not done here

- `worktree:<task>` checkouts are refused (`spawnFailed`): the supervisor only knows project roots from the local
  policy. The cwd must come from that policy, not from the hub.
- `auditSeq` in reports is 0. Recording upload to the hub (`TerminalRecordingStore.put`) is not wired: it needs the
  same pinned identity, and the R-69d review gotchas (#1112, #1115) are still open.
- No UI (69f). There is no warning frame 60 s before a timeout: the page can read `expiresAt` from `terminal.get`.
- One hub process. A hub restart forgets idle/detached clocks (they restart from the hub's start) and gives each
  machine one lease to say hello.
