# 0017. Split the admin web from the client app, and run personal machines only for their owner

- Status: Accepted
- Date: 2026-10-13
- Deciders: product owner (tdduydev), maintainers

## Context

Two problems showed up while testing the desktop app v0.2.2:

1. After registration the app opened the full hub web inside its window, so BA and DEV users saw every admin screen
   (members, roles, policies, audit). Spec 008 (US1, scenario 4) already said the app opens `AppNav`; the code still
   followed the v1 behaviour.
2. The run engine handed any run to any online worker of the team. A worker drives the agent CLIs that the machine
   owner logged in to, so a run started by one person (or by the Leader, a review gate, an issue webhook) could run on
   a colleague's laptop with that colleague's personal subscription.

## Decision

**Two surfaces, one set of contracts.**

| Surface | Users | Features |
|---|---|---|
| Admin web (`apps/web`) | Org and team admins, leads, anyone without the app | Projects, machines, sandbox, MCP and tools, agent policies, members, teams, roles, sign-in, review workflow setup, proposal approval, costs, notifications, audit, task board, Leader. Also keeps every client feature below. |
| Client app (`apps/desktop`, `AppNav`) | BA and DEV on their own machine | Machine home, runs on this machine, environment, skills installed into CLIs, tokens and context, docs from code, worker and tray; plus document editor (DocEditor), my tasks and my runs, awaiting my review, knowledge lookup (read-only). |

The app never embeds the hub web as its main window. It opens a hub page only when the user asks (tray "Mở xDev
Hive", or a link to one hub page). Features present on both surfaces share contracts and logic in `packages/`;
screens are not copied between apps.

**Machine ownership.**

- A machine is personal by default (`machines.shared = false`): it runs only runs whose owner
  (`runs.owner_user_id`) is the user who registered it.
- A team admin can mark a machine as shared (team servers). Shared machines and runner hosts run any run of the team.
- A run started by a user is owned by that user; child plan and review runs inherit the owner; the document assistant
  stays pinned to the requester's machine.
- Team runs have no owner (Leader, AI review gate, issue and comment webhooks) and run only on shared machines or
  runner hosts. With none available the run waits and records why (`waiting_machine` event).
- Choosing a colleague's personal machine for a run is refused (`MACHINE_NOT_YOURS`).

## Consequences

- Good: a personal CLI login (and its subscription) is only ever used by its owner.
- Good: BA and DEV get a focused app; admin screens stay on the web.
- Bad: a team with no shared machine cannot run Leader, review-gate or webhook runs until an admin marks one shared.
- Existing machines become personal on upgrade. Runs created before the upgrade have no owner; there were none in
  flight on the production hub when this shipped, so no backfill was added.

## Links

- [0016](0016-desktop-local-ui.md), [specs/008-desktop-v2](../../specs/008-desktop-v2/spec.md) (US1, US8)
- `apps/hub/src/modules/runs/engine.ts` (`usableBy`), `apps/hub/src/modules/fleet/machines.ts` (`setMachineShared`)
