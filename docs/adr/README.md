# Architecture decision records

One file per decision, in the [MADR](https://adr.github.io/madr/) layout ([template](template.md)). How and when to
write one: [0000](0000-record-architecture-decisions.md).

| ADR | Decision | Status |
|---|---|---|
| [0000](0000-record-architecture-decisions.md) | Record architecture decisions as ADRs | Accepted |
| [0001](0001-modular-monolith-hub.md) | Build the hub as a modular monolith | Accepted |
| [0002](0002-typescript-hub-go-worker.md) | TypeScript hub and web app, Go worker | Accepted |
| [0003](0003-postgresql-only-state.md) | PostgreSQL as the only stateful dependency | Accepted |
| [0004](0004-row-level-security-tenancy.md) | Tenant isolation with row-level security | Accepted |
| [0005](0005-contract-first-api.md) | Contract-first APIs and worker protocol in zod | Accepted |
| [0006](0006-outbound-worker-protocol.md) | Outbound WebSocket for machines, leases and fencing | Accepted |
| [0007](0007-sandbox-gvisor-egress-proxy.md) | gVisor sandbox with a per-run egress proxy | Accepted |
| [0008](0008-better-auth-invite-only.md) | Better Auth, invitation-only sign-up | Accepted |
| [0009](0009-configurable-outcome-policy.md) | Configurable outcome policy per project | Accepted |
| [0010](0010-tenancy-hierarchy.md) | Organization, team, system, project | Accepted |
| [0011](0011-signed-worker-releases-and-own-updater.md) | Signed worker releases and our own updater | Accepted |
| [0012](0012-spec-driven-development.md) | Spec Kit and a definition of done for features | Accepted |
| [0013](0013-ui-shadcn-base-ui.md) | shadcn/ui on Base UI, designed with UI UX Pro Max | Accepted |
| [0014](0014-store-skills-in-git.md) | Store skills in Git with a PostgreSQL read cache | Accepted |
| [0015](0015-doc-editor-collaborative-engine.md) | Block-based document editor using Tiptap and patch proposals | Proposed |
| [0016](0016-desktop-local-ui.md) | Build desktop local UI with React, Vite, Tailwind and shadcn/ui | Proposed |
| [0017](0017-admin-web-client-app-and-machine-ownership.md) | Split the admin web from the client app, and run personal machines only for their owner | Accepted |
| [0018](0018-code-review-workflows.md) | Review agent pull requests with code review workflows | Proposed |
| [0019](0019-hive-cli-and-remote-sessions.md) | Host interactive agent sessions in the worker and control them from a paired phone | Accepted |
| [0020](0020-local-project-folders-and-machine-full-permission.md) | Bind hub projects to local repositories, and grant full permission per project on the machine | Accepted |
| [0021](0021-ai-sdlc-mode.md) | Run an AI SDLC mode as data-defined presets over existing review, task and run machinery | Accepted |
| [0022](0022-project-brief-and-agent-memory.md) | Give every run a project brief, let agents propose memories, and measure exploration before the first edit | Proposed |
| [0023](0023-artifacts.md) | Store versioned artifacts in the hub and run interactive ones in a sandboxed frame on a separate CSP | Accepted |
| [0024](0024-chat-channels.md) | Reach Hive from Telegram and Slack through commands that skip the LLM, and send free text to Leader only | Proposed |
| [0025](0025-agent-skill-learning.md) | Let agents propose skills after hard tasks, in cheap daily batches that a team admin approves | Proposed |
| [0027](0027-vscode-extension.md) | Extension VS Code | Accepted |
| [0028](0028-docs-repo-sync.md) | Keep documents in the hub and synchronize them with repository folders | Accepted |
| [0030](0030-hub-deploys-over-ssh.md) | Run deploy steps from the hub over SSH with `ssh2`, one encrypted key per server and a pinned host key | Proposed |
| [0031](0031-external-ci-and-deploy-sources.md) | Read and drive Jenkins, GitLab, Argo CD and Kubernetes from the hub with per-person Jenkins tokens, and do not store CI logs | Proposed |
