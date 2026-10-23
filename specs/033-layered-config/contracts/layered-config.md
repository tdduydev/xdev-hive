# Contract: layeredConfig (oRPC)

Defined in `packages/contracts/src/layered-config.ts`, mounted as `layeredConfig` in the root contract.

| Procedure | Input | Output | Who |
|---|---|---|---|
| `layeredConfig.effective` | `{ projectId }` | `{ settings: EffectiveSetting[], configVersion, schemaVersion, generatedAt }` | any member who can see the project; chain only for writers |
| `layeredConfig.registry` | none | `{ settings: SettingDef[] }` (key, group, kind, layers, dangerous) | any member |
| `layeredConfig.teamGet` | `{ teamId }` | `{ entries: TeamEntry[] }` | team member, org admin |
| `layeredConfig.teamSet` | `{ teamId, key, value \| null, locked?, expectedVersion? }` | `TeamEntry` | team admin, org owner/admin, `team.config.write` |
| `layeredConfig.orgLock` | `{ key, locked }` | `{ key, locked }` | `policies.write` or org admin |

Errors (Vietnamese messages, stable codes): `CONFIG_UNKNOWN_KEY`, `CONFIG_LAYER_NOT_ALLOWED`, `CONFIG_LOCKED`,
`CONFIG_ABOVE_CEILING`, `CONFIG_VALUE_INVALID`, `CONFIG_VERSION_CONFLICT`, `CONFIG_FULLACCESS_REQUIRED`.

Worker and desktop integration (not in the MVP): the worker already receives `policy` in the job offer. The next step is
to add an optional `configVersion` and the safe subset to that offer, which needs an edit in `worker-protocol.ts`
and `worker/internal/channel`, both owned by another agent right now.

Per-org rule (FR-069): every call is scoped by the `x-hive-org` header. The response carries `orgId` so a client that serves two orgs can verify the snapshot belongs to the registration it asked for and cache it per org.
