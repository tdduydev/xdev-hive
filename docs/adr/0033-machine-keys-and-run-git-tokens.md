# 0033. Authenticate machines with a key pair, and give each run its own git token

- Status: Accepted
- Date: 2026-10-23
- Deciders: Project owner
- Accepted: plan of spec 027 settled by the project owner on 2026-10-21 (P1–P3); this record writes it down

## Context

Spec [027](../../specs/027-hub-client-model/spec.md) makes the hub a coordinator. Machines call the hub, never the
other way round, and code, secrets and terminal logs stay on the machine. Before this decision, three long-lived secrets
sat on disk on the machine:

- the machine token `hwm_…`, sent on every WSS connection and REST call; whoever copied `worker.json` became that
  machine until an admin revoked it;
- the git credentials of the person who runs the worker (credential helper, SSH key), which can write to every repo
  that person can, not only the run's repo;
- the `hive` CLI personal token, which fell back to `hive.json` when the OS had no keychain.

Requirements: 027 FR-020 … FR-025, SC-004; research [R8](../../specs/027-hub-client-model/research.md#r8-khoá-máy-ed25519-access-token-15-phút)
and [R9](../../specs/027-hub-client-model/research.md#r9-token-git-theo-run).

## Decision

1. **Machine key.** The worker makes an Ed25519 key pair at registration, or on first start after the upgrade
   (`worker/internal/machinekey`). The private key lives in the OS keychain (service `dev.xdev.hive.machine`, account
   = machine id, apart from the `dev.xdev.hive` entry of the user's token so `hive auth logout` cannot delete it); a
   machine without a keychain uses a `worker.key` file (0600) next to `worker.json`.
2. **Enrolment.** A new machine sends its public key when it registers. A machine registered earlier sends it once with
   `POST /api/v1/worker/key`, authenticated with its `hwm_`. The hub stores `machines.public_key`, `public_key_at` and
   `key_storage` (`keychain` or `file`), and marks the machine's `hwm_` tokens `superseded_at`; a superseded `hwm_` is
   refused from then on.
3. **Short access tokens.** `GET /api/v1/worker/challenge?machine=<id>` returns a stateless nonce (HMAC of `id|exp`,
   60 s). `POST /api/v1/worker/token` checks the Ed25519 signature against the stored key and that the machine is not
   revoked, then returns an HS256 JWT (key derived by HKDF, label `xdev-hive machine token v1`, so it can replace
   neither run tokens nor session cookies), `sub=machine:<id>`, audience `<public URL>/worker`, 15 minutes. The hub
   checks the token before upgrading WSS and sets `welcome.accessTokenExp`.
4. **Renewal on the open connection.** The worker gets a new token two minutes before expiry and sends `reauth`. The
   hub closes the connection with code `4401` when a token expires without `reauth`; the worker reconnects with a new
   token. `reauth` is sent only when `welcome.accessTokenExp` is set, because older hubs close on unknown packets.
5. **Git token per run.** When the hub grants a lease, it asks the project's SCM connection for a credential scoped to
   that repo and sends it in `lease.git` (`{host, username, token, expiresAt, repo}`):
   - GitHub App: installation token for one repository, `contents: write`, `pull_requests: read`; GitHub fixes the
     lifetime at one hour, so a long run asks again with `git_token_request`, and the hub answers `git_token` only
     while that run attempt is still on the machine;
   - GitLab: project access token, `write_repository`, Developer level, expiring the next day (the shortest GitLab
     allows); the hub revokes it when the run ends, and a job (`scm-run-git-tokens`, every 10 minutes) revokes tokens
     of runs that are no longer on a machine;
   - PAT connections cannot issue a narrow token: `lease.git` is `null` and the worker keeps using the machine's git
     credentials. Older hubs omit the field, with the same result.
6. **Records, never values.** `hive.run_git_tokens` (forced RLS) keeps run, attempt, connection, provider, the GitLab
   token id, repo, expiry and revocation time, never the token. Issue and revoke are written to the audit log
   (`scm.run_token_issue`, `scm.run_token_revoke`). The sweep job finds orgs through the `SECURITY DEFINER` function
   `hive.run_git_token_orgs()`, which returns only org ids.
7. **Policy.** The org agent policy gets `git.requireRunGitToken` (off by default). When it is on and the project's
   connection cannot issue a token, the run stays queued with one `policy_git_token` event; when issuing fails at
   accept time, the hub cancels the run on the machine and puts it back in the queue.
8. **CLI personal token only in the keychain.** `hive login` and `hive auth store` refuse to save when the keychain is
   unavailable and point to `HIVE_TOKEN` for the session. A token an older build wrote to `hive.json` moves into the
   keychain on first read; without a keychain it is still used, with a warning to log out.

## Consequences

- Good: a copied `worker.json` is not enough to act as the machine; a stolen access token works for 15 minutes.
- Good: with a GitHub App or a GitLab connection, a run can write only to its own repo, and only while it runs (one
  hour for GitHub, until the run ends for GitLab).
- Good: no inbound connection to machines and no new always-on service; the sweep runs on the existing job queue.
- Bad: a machine without a keychain keeps its private key in a 0600 file, which is no stronger than `hwm_` against
  someone who can read the user's files; the hub records it as `key_storage = 'file'`.
- Bad: GitLab tokens live up to a day if both the revoke on run end and the sweep fail; tokens of a deleted SCM
  connection are dropped with it and only expire.
- Bad: GitLab project access tokens may need a paid tier on gitlab.com [unverified]; such connections behave like PAT
  connections.
- Bad: a resent `job_accept` issues a second token; both are recorded and revoked.
- Bad: the challenge nonce set and the token rate limits are in memory, so they reset on restart and are per hub
  process.
- Not done yet: the worker does not feed `lease.git` into `gitexec` (askpass, `credential.helper` off), and the web
  policy page has no switch for `requireRunGitToken`; both are follow-ups in 027 tasks.

## Alternatives considered

- mTLS for machines: needs a CA and certificate rotation on every machine and proxy; the key pair gives the same proof
  over the existing HTTPS and WSS.
- OAuth device flow for machines: a person must approve again whenever a token expires.
- Long-lived refresh token: still a long-lived secret on disk, which is what US3 removes.
- Deploy key per repo: long-lived, one key per repo, and it cannot be scoped to one run.
- The hub pushes on the machine's behalf: code would have to travel to the hub, against FR-050.
- Keep the CLI token in `hive.json` when there is no keychain: what FR-025 forbids.

## Links

- Spec 027 FR-020 … FR-025, SC-004; research R8, R9; tasks T026 … T033.
- ADR [0019](0019-hive-cli-and-remote-sessions.md) (`hive` CLI), [0032](0032-client-events-and-outbox.md) (client
  writes and outbox).
