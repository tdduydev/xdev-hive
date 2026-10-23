# Research: Layered configuration

## R1. Where does each layer live today?

- Decision: keep existing storage; add one table only for the team layer and locks.
- Why: `agent_policies` (org) and `projects.settings` (project) are read by run assignment today. Copying them would
  create two sources of truth and make FR-070 hard to prove.
- Alternative rejected: one generic key-value table for all layers. It forces a data migration of live settings and a
  rewrite of the readers in the same change.

## R2. Merge kinds

- Ceiling: boolean restrictive flags (true wins), numbers (min, null means no limit), ordered scale (lowest wins).
  Same as today's `clampBudget` and `resolvePermission`.
- Override: nearest layer wins, unless a higher layer locked it. A value outside the setting domain is dropped and the
  next layer is used.
- Additive: union by identity; entries marked `deny` win. Today's MCP rules use the same idea.
- Lock: only for override and additive. Ceiling does not need it.

## R3. Over-ceiling

A lower layer can hold a value wider than a newly narrowed ceiling. The engine clamps the effective value and reports
`overCeiling` with the layer that holds the wider value. It never rewrites the stored value (FR-015).

## R4. Hub-only merge

Clients receive merged values and a `configVersion`. This matches spec 027 (hub decides) and keeps `worker-protocol.ts`
untouched: the snapshot is exposed through an oRPC contract and the worker integration is a later task.

## R5. Authorization

Team layer: team admin, org owner and admin (`requireTeamRole`, `requireOrgRole`), or the custom permission
`team.config.write` through `allowWith`. Dangerous settings (allow full permission) need `policies.fullaccess` when
loosened, as `saveAgentPolicy` does today.

## R6. Instance layer

Spec Q1 recommends an environment list for instance admins. Storage for instance values is a separate non-RLS table and
needs grants for `hive_app`; it is deferred (US5, P2) and tracked in tasks.
