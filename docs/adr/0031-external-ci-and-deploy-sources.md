# 0031. Read and drive external CI and deploy sources from the hub

- Status: Proposed
- Date: 2026-10-20
- Deciders: Project owner

## Context

Spec [020](../../specs/020-cicd-console/spec.md) makes Hive a console over the CI that teams already run, and a place
to start deploys. It does not replace GitLab CI or Jenkins. ACME builds and deploys with Jenkins (Keycloak OIDC,
Harbor, GitOps, Argo CD, RKE2); GitLab CI only runs checks. Jenkins has no webhook, because GitLab cannot reach the
internal network. The project owner settled Q3, Q4, Q6, Q11, Q12, Q13 and Q15 on 17 October 2026. Requirements
are [CICD-01–CICD-12](../srs.md#325-cicd-console-cicd) and [DEPLOY-01–DEPLOY-14](../srs.md#326-deploy-deploy).

Facts that bound the design:

- From the hub's container (T006, 19 October 2026) Jenkins, GitLab and Argo CD answer over HTTPS, but ports 22 and
  6443 of the internal network do not. Deploys to the ACME infrastructure must go through `jenkins-job` or `argocd`;
  `kubectl` works only where the hub can reach the API server.
- T007 (checking Jenkins, Argo CD and the ServiceAccount against the real systems) has **not been done**. Every
  statement below about how the real Jenkins, Argo CD or Kubernetes behaves is an inference from public API
  documentation and from reading the ACME pipeline files. The coordinator updates this record after T007.
- PostgreSQL is the only stateful dependency ([ADR 0003](0003-postgresql-only-state.md)), and every tenant table
  forces RLS ([ADR 0004](0004-row-level-security-tenancy.md)).

## Decision

1. **Jenkins uses each person's own token.** An organization administrator adds a Jenkins connection (name, URL). Each
   user adds their user name and API token for it (Q3); tokens are encrypted with `platform/secrets.ts` under the
   context `ci_jenkins_user_tokens:<id>`. Every write (build, stop, proceed, abort) uses the token of the person who
   pressed the button, so Jenkins records the right user. A person without a token can only look. A token is checked with
   `GET /me/api/json`.
2. **One watcher per connection.** Scheduled reads use the token of a chosen watcher, by default the person who
   created the connection, and that token only reads. Without a watcher token the Jenkins part says so and offers to
   add one; if the watcher's token expires, the part shows "cannot read Jenkins" to everyone until an administrator
   picks another watcher.
3. **Jenkins is polled by the hub (Q4).** `delivery-ci-poll` runs every 5 minutes while idle and re-queues itself after 15
   seconds while a build runs, with `singletonKey` per connection and back-off on errors. Reads use `?tree=` to stay
   small. Stages come from `wfapi/describe` (skipped on 404), logs from `logText/progressiveText?start=<n>` (reading
   `X-Text-Size` and `X-More-Data`), and a waiting `input` from `wfapi/pendingInputActions`. A green build of a job linked
   to a `jenkins-job` target that Hive did not start is recorded as an `external` deploy (Q13); it counts for "running
   now" and rollback but not for the one-active-deploy lock.
4. **GitLab pipelines and jobs come through the existing webhook, plus polling.** `GitProvider` gains pipeline and job
   operations, `compare` returns commits, and the GitLab hook registers `pipeline_events` and `job_events`; `onScmEvent`
   handles them. Pipelines that have not finished are re-read every 5 minutes so a lost event does not hide a result
   (Q4). Operations use the project's Git connection token, and the audit records the real user (FR-035). GitHub Actions
   comes later (Q11).
5. **Argo CD and Kubernetes use shared organization tokens, called with `fetch`.** Argo CD (URL, token) and Kubernetes (API
   server URL, CA, ServiceAccount token) are connections an administrator adds, encrypted per record. Argo CD calls
   `sync`, `GET application` and `rollback`; the hub waits for `Synced` and `Healthy`. Kubernetes uses `GET` and a
   strategic merge `PATCH` on one workload, then watches `observedGeneration`, `updatedReplicas`, `availableReplicas` and
   the `Progressing` condition. No `@kubernetes/client-node` and no Argo CD client are added, and the `kubectl` binary is not
   used. Rollback of an Argo CD application disables auto-sync, so Hive warns first.
6. **CI logs are not stored (Q12).** Pipeline and build logs are read from the source when someone opens them and shown in
   chunks. Deploy logs are Hive's own and are stored in `deploy_log_chunks`, redacted, for `runLogRetentionDays`.
   `ci_runs_seen` keeps only status and notification state.
7. **Approval and locks are Hive's.** For a Jenkins `input` step, Hive proceeds with the approver's token and aborts on
   reject (Q7). A person who presses the button directly in Jenkins or Argo CD bypasses Hive's approval (R7); this is out of
   Hive's reach, and the documentation advises setting `approvers` on `acmePromote`.
8. **Failures are coded in Vietnamese.** Jenkins errors become `JENKINS_NO_TOKEN`, `JENKINS_UNAUTHORIZED`,
   `JENKINS_FORBIDDEN`, `JENKINS_NOT_FOUND` and `JENKINS_UNAVAILABLE`, each with a repair hint. A source that does not
   answer shows the last data with its time and never blocks the others.

## Consequences

- Good: no CI is replaced; Jenkins keeps the audit trail of who pressed what; no CI log is duplicated in the database.
- Good: the ACME infrastructure can be deployed from the hub through HTTPS-only methods the network allows.
- Bad: each user must create and paste a Jenkins token, and token expiry affects only that person. The watcher is a single
  point of failure for reading (R4).
- Bad: Jenkins and Argo CD are polled, so a build that starts outside Hive is seen within about 5 minutes (SC-001).
- Bad: Argo CD and Kubernetes tokens are shared, so the audit records the Hive user but the external system records the shared
  account.
- Not verified until T007: that a person can create an API token under Keycloak OIDC; that `POST` with an API token needs
  no crumb; that the Pipeline Stage View plugin and `pendingInputActions` exist and which Jenkins version runs; how Argo
  CD authenticates and whether its token may `sync` and `rollback`; the ServiceAccount's rights on the cluster. If a crumb
  is required, `clients/jenkins.ts` changes. The Argo CD host used in T006 is a guess the owner has not
  confirmed.

## Alternatives considered

- A Jenkins service account (the earlier recommendation): simpler, but Jenkins would record the service account instead of
  the person. Rejected by Q3.
- Webhooks from Jenkins: ACME's jobs run on Build Now or a poll schedule and have no webhook today
  (research section 1). Whether the hub is reachable from Jenkins is unmeasured, so the first release polls.
- Store CI logs in Hive: duplicates data and grows the database (Q12).
- `@kubernetes/client-node` or a binary `kubectl`: more code and a binary for two calls; `fetch` is enough.
- Hive runs the pipelines itself (direction B): overlaps Jenkins and GitLab CI; the owner chose A + C.
- Write to the GitOps repository directly: out of scope; Argo CD `sync` and `rollback` cover the first release.

## Links

- [Spec 020](../../specs/020-cicd-console/spec.md), [plan sections 2, 3, 4 and 6](../../specs/020-cicd-console/plan.md),
  [research sections 1 and 2](../../specs/020-cicd-console/research.md).
- [SRS 3.25 CICD](../srs.md#325-cicd-console-cicd), [SRS 3.26 DEPLOY](../srs.md#326-deploy-deploy).
- [ADR 0003](0003-postgresql-only-state.md), [ADR 0004](0004-row-level-security-tenancy.md),
  [ADR 0030](0030-hub-deploys-over-ssh.md).
