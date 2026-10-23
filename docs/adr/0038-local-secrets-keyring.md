# 0038. Keep local secrets in the operating system keyring, owned by the worker, and send the hub only a count

- Status: Proposed
- Date: 2026-10-23
- Deciders: Project owner

## Context

Spec [031](../../specs/031-local-secrets/spec.md) lets a developer store secrets (a dev database password, a test API
key, a registry token) on their own machine and have agents use them without asking in chat. Agents run in two places:
the worker runs a hub job in the background, and the desktop opens a terminal or agent session in a folder.

Constraints that shape the choice:

- Spec 031 FR-001 and FR-002: the value lives only in the operating system store. No plain file, no app database, no hub,
  and the catalog holds no value, hash or length.
- Spec 031 FR-011 to FR-015: a job must get its secrets while the desktop is closed, and the value must never reach a
  script, a command line or an intermediate file.
- Spec 031 FR-043: the hub learns how many secrets a run used, never their names or values.
- Windows Credential Manager limits one entry to 2560 bytes. The test on Windows 11 on 2026-10-23 showed that
  `go-keyring v0.2.8` stops at 2560 and the system rejects 2561
  ([research.md](../../specs/031-local-secrets/research.md), section "Kết quả kiểm"). A value can be 8 KiB (FR-005).
- Old hubs and old workers must keep working (constitution principle I).

## Decision

1. **The OS keyring holds the value.** The worker uses `go-keyring` (Windows Credential Manager, macOS Keychain, Linux
   Secret Service) under the service `dev.xdev.hive.secrets`. If the keyring is not available, the app says so and
   stores the value nowhere else (FR-062).
2. **The worker is the single owner.** The Go package `worker/internal/secretstore` owns the keyring entries, the
   catalog `secrets.json` (name, description, dates, local project ids; no value) and the grant log
   `secret-grants.jsonl`. The desktop calls the sidecar `hive-worker secrets …` and passes values through stdin only,
   the same way `ssh_keys.rs` does. The hub never has a copy.
3. **A long value is split into chunks.** One secret is one or more entries. The first entry is named `<NAME>` and holds
   `v1:<n>:<gen>:<base64 of chunk 0>`; later chunks are `<NAME>#1` to `<NAME>#<n-1>`. A chunk carries at most 1800 raw
   bytes, so the first entry stays under 2560 bytes after base64 and the prefix. Writes go from the last chunk to the
   first, so the first entry only points to chunks that are already written. Delete removes the chunks before the
   catalog line.
4. **One `Grant` function for every session.** `Grant` applies the policy, reads the keyring once, writes the grant log
   line and returns the environment and a masker. Runs, desktop terminals and `hive chat` all call it. If the keyring
   cannot be read, the run stops before the agent process starts (FR-060).
5. **Desktop terminals run through `hive-worker secrets exec`.** The temporary launch script holds no value. It runs
   `hive-worker secrets exec --project=<localId> --kind=terminal -- <argv>`, which calls `Grant` inside the child
   process and then replaces itself with the CLI (Unix) or starts it on the same console (Windows). Under the `approve`
   policy it asks in the terminal.
6. **Output is masked on the machine.** The Go package `worker/internal/secretmask` replaces the exact value, and its
   base64, base64url, URL-encoded, shell-quoted and JSON-escaped forms, with `[đã che]`. It works on a stream, so a value
   split across two chunks is still masked, and it handles each long line of a multi-line value. The runner wraps its
   `Sink` with it, so every event is masked before it is written to the pending file or sent to the hub. It replaces the
   private masker of `terminal/redact.go`.
7. **The hub gets a count and a policy, nothing else.**
   - The organization policy gets `secretInjection` with `allow` (default), `approve` or `deny`. It travels in
     `welcome.policy` and in the job policy, and a change is audited.
   - The worker reports `run_result.report.secretsInjected`, an integer from 0 to 64. The hub keeps that number and drops
     every other key of the worker report whose name contains "secret", so a faulty worker cannot put a name or value into
     the database, the run events or any read route.
   - The report is a free record, so old hubs accept the new field. No new run event type is added, because an old hub
     closes the connection on an unknown type.

## Consequences

- Good: no value is ever on disk in the clear or on the hub; the scan in spec 031 SC-004 can check for zero bytes.
- Good: one reader of the keyring means one chunk format. Background jobs work with the desktop closed.
- Good: the hub change needs no migration and is optional on both sides, so an old hub or worker keeps working.
- Bad: the agent can print a value before the worker masks it, and its CLI sends tool output to the model provider
  first (spec 031 A6). The feature cannot take that back. The mitigations are the instruction in the agent context, the
  "value appeared in output" mark in the grant log, and advice to rotate the secret.
- Bad: Linux without a Secret Service (no D-Bus session) is not supported; the screen says so.
- Bad: chunking is our own format. A reader outside `secretstore` cannot read a long value.
- Bad: the macOS limit of `go-keyring` (one line of 4096 bytes through `security -i`) is read from code, not yet run on a
  Mac. **[Unverified]** until task T001 is repeated on macOS.
- Bad: a remote-control session (`term_start`) gets no secrets, because a value must not leave the machine through the
  hub path.

## Alternatives considered

- Desktop (Rust `keyring`) owns the keyring and the worker reads it: two writers on one OS store, and the two libraries
  can disagree on the chunk format. A background job could not read the store when the desktop is closed.
- Encrypt the value with a key from the keyring and keep the cipher text in a file: breaks FR-001 ("no plain file").
- Store secrets on the hub with the existing envelope encryption of project secrets: breaks FR-001 and FR-043, and puts
  names such as `PROD_DB_PASSWORD` on a shared server.
- Write `export` lines into the temporary terminal script: puts the value on disk (FR-015).
- Pass the environment to `open -a Terminal`: **[Inference]** not reliable, because an already running terminal process
  may take the command.
- Send secret names to the hub for reports: names reveal infrastructure. Revisit only with an explicit spec change.
- A new run event kind for the count: an old hub closes the connection on an unknown kind.
- A separate background daemon for the store: against constitution principle VII.

## Links

- Spec [031](../../specs/031-local-secrets/spec.md), [plan](../../specs/031-local-secrets/plan.md),
  [research](../../specs/031-local-secrets/research.md) (D1, D2, D5, D7, D8b).
- SRS section 3.29 (LSEC) in [srs.md](../srs.md); architecture section 5.3 in [architecture.md](../architecture.md).
- Related: [ADR 0037](0037-shared-context-local-files.md) (the secret name list in agent context follows the same rule of
  not writing into tracked repository files).
