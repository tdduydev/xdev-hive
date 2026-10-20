# 0030. Hub runs deploy steps over SSH

- Status: Proposed
- Date: 2026-10-20
- Deciders: Project owner

## Context

Spec [020](../../specs/020-cicd-console/spec.md) adds a deploy console: a server, an environment, a "Deploy" button
with backup before and health check after, and rollback. The project owner settled Q1–Q16 on 17 October 2026. Two
answers shape this record: the hub itself connects to the target server over SSH (Q1), and the hub keeps the private
key, encrypted (Q2). Requirements are [DEPLOY-01–DEPLOY-14](../srs.md#326-deploy-deploy).

Today the hub is deployed from a developer machine with `deploy/remote.sh`: `git archive` over SSH, `docker compose up
-d --build`, then a health wait. The 17 October 2026 manual run (backup, deploy, check `/api/v1/health`) took about
5.5 minutes and is the reference for SC-002.

Constraints:

- The hub may deploy itself. Its process restarts in the middle of the deploy, so a step cannot live inside one SSH
  session held by the hub (SC-007).
- The hub must reach the target's SSH port. The T006 measurement (19 October 2026) showed that the hub could not reach
  port 22 or the Kubernetes API of the internal machines. Deploys to the eHospital infrastructure therefore go
  through `jenkins-job` or `argocd` ([ADR 0031](0031-external-ci-and-deploy-sources.md)), not through this record's
  method.
- A hub that holds keys to every server is a high-value target (risk R1), and a backup that carried `.env` would carry
  `HIVE_MASTER_KEY` (risk R11, settled on 19 October 2026: backups no longer contain `.env`).
- PostgreSQL is the only stateful dependency ([ADR 0003](0003-postgresql-only-state.md)); a new npm dependency needs
  a record ([ADR 0000](0000-record-architecture-decisions.md)).

## Decision

1. **The hub connects to servers itself, with `ssh2`.** Add `ssh2` and `@types/ssh2` to `apps/hub` instead of shipping
   the `ssh` binary. The key stays in memory and is never written to a temporary file; the host key is checked by a
   callback on every connection.
   - Version from the T001 spike (19 October 2026): `ssh2` 1.17.0 (MIT), `@types/ssh2` 1.15.6 (MIT). Runtime
     dependencies `asn1` (MIT), `bcrypt-pbkdf` (BSD-3-Clause), `tweetnacl` (Unlicense), `safer-buffer` (MIT); about 1.35
     MB installed.
   - `pnpm audit` and `npm audit` reported no known vulnerabilities for that set. Re-run the audit when the version is
     pinned in `pnpm-lock.yaml`.
   - It runs without the optional native addon (`bindingAvailable === false`) on Node 24 and Node 22; pnpm blocks the
     install scripts, so `pnpm-workspace.yaml` lists `ssh2: false` under `allowBuilds`.
   - Not yet checked: inside the hub's container image, and on Ubuntu 22.04 and 24.04 (spike ran on 26.04).
2. **One key pair per server, encrypted per record.** The hub generates an ed25519 pair with
   `ssh2.utils.generateKeyPairSync('ed25519')` (the Node `crypto` PKCS#8 output is rejected by `ssh2`). The private key
   is encrypted with `platform/secrets.ts` under the context `deploy_servers:<id>:key`, decrypted only inside
   `clients/ssh.ts` at connection time, never logged, never returned by an API and never exportable. The administrator
   installs the public key by hand. Rotation writes the new pair to `pending_*` columns and swaps it only after a
   successful test, so the old key keeps working until then. Every use of a key is audited, grouped per deploy.
3. **Pinned host key, with its algorithm.** The administrator confirms the SHA-256 fingerprint on the first test. The
   hub stores the algorithm with the fingerprint and forces `algorithms.serverHostKey` to it, so a server that offers
   several host keys is not reported as changed. A mismatch stops the connection before any command runs
   (`hostkey_changed` raises `server.hostkey_changed`); an unconfirmed key stops the same way (`hostkey_unconfirmed`).
   The hub records the reason in the verifier closure, because `ssh2` raises one `Host denied` error for both.
4. **Steps run detached from the SSH session.** The hub uploads `~/.hive-deploy/<deployId>/` (`run.sh`, step files, a
   variables file with mode 600) over SFTP and starts it with `cd <dir>; nohup setsid sh run.sh >/dev/null 2>&1 &
   echo $!`. The `;` matters: with `&&` the backgrounded list keeps the channel open. Both streams must be redirected.
   `run.sh` writes `log` and `status.json` and traps `TERM`. Cancel sends `kill -TERM -- -<pgid>`; signalling only the
   process delayed the trap by about 19 s in the spike. The first failing step stops the chain.
5. **Reconnect by polling.** The `delivery-deploy-watch` pg-boss job (`stately`, `singletonKey` per deploy, re-queued
   with `startAfter`, `heartbeatSeconds` 10) opens a short session about every 2 s, reads `log` with `tail -c +<offset+1>`
   and `status.json`, redacts secrets, stores the chunks and the new byte offset in one transaction, then closes the
   session. After a hub restart the job resumes from the stored offset; the spike lost and repeated no bytes. After a
   hard kill pg-boss hands the job to a new instance in about 45–60 s. If the server stays unreadable for 15 minutes the
   deploy becomes `unknown`; the hub never reruns it on its own.
6. **Code travels as an archive.** For `git-archive`, the hub streams `scm.archive(commit)` over SFTP into
   `src.new.tar.gz` (mode 600) and `run.sh` unpacks it. The spike measured 5–10 MiB/s for a stream on localhost, so
   T016 may write a temporary file and use `fastPut` for large archives. The server directory is cleaned after 14 days.
7. **Access is narrow.** Only `servers.manage` edits commands and target configuration; configuration is versioned and
   every edit is audited with a diff. A pre-check compares the directory, the Compose project and the `.env` file with
   the target configuration and stops on a mismatch. The documentation recommends a dedicated deploy user on the
   server, not `root`.
8. **No runner machine in the first release.** Q14 and Q16 (a shared Linux runner that does not run agents) are kept
   as a constraint for a later change, for networks the hub cannot reach.

## Consequences

- Good: no runner, no worker protocol change and no extra service; SC-002 can run from the Hive screen.
- Good: a deploy survives a hub restart or crash (SC-007), including a deploy of the hub itself (risk R8).
- Good: the key is never on disk at the hub, and a changed host key stops the run before any command.
- Bad: the hub holds a key to every declared server (R1). Whoever holds the database and `HIVE_MASTER_KEY` can
  reach all of them. Mitigations: per-server keys, per-record encryption, audit, easy rotation and a dedicated server
  user. `.env` is kept out of backups; the administrator stores `.env` apart and protects it like the SSH keys
  themselves, and older backups that still contain `.env` need the same protection until they are deleted.
- Bad: the hub must reach the server's SSH port. It cannot reach the internal machines (T006), so those use
  Jenkins or Argo CD until a runner exists (R2).
- Bad: each poll pays a full JS handshake, about 0.45 s on localhost; many parallel deploys cost hub CPU.
  Holding a session open is a possible optimization and is untested.
- Bad: `ssh2` is a new runtime dependency to track for advisories.
- Not verified: Ubuntu 22.04 and 24.04, the `sshd` test image, `ETIMEDOUT` against a silent host, throughput on a
  real network, and the path from the Docker bridge to the host's own port 22 on a real server (all in research.md
  section 4.6).

## Alternatives considered

- The `ssh` binary in the hub image: needs the private key written to a temporary file and makes per-connection host
  key checks awkward. `ssh2` keeps both in memory.
- A runner machine holds the key and runs the commands (the earlier recommendation): safer for key custody but needs a
  worker protocol change and a machine in each network. The owner chose the hub (Q1, Q2); the runner stays a later
  option.
- Hold one SSH session for the whole deploy: loses the running step when the hub restarts, so it fails SC-007.
- `crypto.generateKeyPairSync` for key generation: its PKCS#8 output is not read by `ssh2`; wrapping the seed into
  `openssh-key-v1` by hand works but adds code for no gain.
- Storing server keys in a new secret store: adds a service against ADR 0003; `platform/secrets.ts` already encrypts
  per record.

## Links

- [Spec 020](../../specs/020-cicd-console/spec.md), [plan sections 5 and 9](../../specs/020-cicd-console/plan.md),
  [research: network (section 2) and T001 spike (section 4)](../../specs/020-cicd-console/research.md).
- [SRS 3.26 DEPLOY](../srs.md#326-deploy-deploy).
- Risks R1, R2, R8, R10 and R11 in the plan.
- [ADR 0000](0000-record-architecture-decisions.md), [ADR 0003](0003-postgresql-only-state.md),
  [ADR 0004](0004-row-level-security-tenancy.md), [ADR 0031](0031-external-ci-and-deploy-sources.md).
