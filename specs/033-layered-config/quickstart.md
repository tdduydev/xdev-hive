# Quickstart: Layered configuration

1. Org admin sets `limits.perRunUsd = 20` on the policy page (unchanged flow).
2. Team admin calls `layeredConfig.teamSet({ teamId, key: "limits.perRunUsd", value: 5 })`.
3. A project in that team sets `budget.perRunUsd = 8` in project settings (unchanged flow).
4. `layeredConfig.effective({ projectId })` returns `limits.perRunUsd = 5`, source `team`, `overCeiling` pointing at the
   project value 8.
5. Org admin calls `layeredConfig.orgLock({ key: "agent.permissionMode", locked: true })`. The project value for that
   override setting stays stored but is no longer applied.

Run the checks:

```bash
npx -y pnpm@12.11.2 biome check --write .
npx -y pnpm@12.11.2 --filter @xdev-hive/hub exec vitest run src/modules/layers
npx -y pnpm@12.11.2 deps
npx -y pnpm@12.11.2 openapi
```
