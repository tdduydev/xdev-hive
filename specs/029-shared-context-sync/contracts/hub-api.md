# Contract: thay đổi API hub (`packages/contracts`)

Chạy `pnpm openapi` sau khi sửa; commit `openapi.json`.

## `projects.ts`

```ts
export const devOptimizerPolicy = z.object({
  level: z.enum(["off", "balanced", "aggressive"]).default("balanced"),
  rtk: z.boolean().default(false),
  codegraph: z.boolean().default(false),
  autoCompactWindow: z.number().int().min(50_000).max(1_000_000).nullable().default(null),
  contextBudgetTokens: z.number().int().min(500).max(8_000).default(2_000),
  memoryAutoSync: z.boolean().default(false),
  memorySyncMinutes: z.number().int().min(15).max(1_440).default(60),
});
```

- `projectSettings`: thêm `devOptimizer: devOptimizerPolicy.nullable()` (null = chưa đặt). **Không** đụng `tokenSaving`.
- `projectSettingsPatch`: thêm `devOptimizer: devOptimizerPolicy.nullable().optional()`.
- Route mới `projects.tokenUsage`: `GET /v1/projects/{key}/token-usage?days=7` →
  `{ rows: { userId, userName, machineId, machineName, periodEnd, tokens, sessions, score, policyDrift }[] }`.
  Quyền: thành viên dự án. Lỗi `NOT_FOUND` khi không thấy dự án.

## `knowledge.ts`

- `memory` (đầu ra): thêm `pinned: boolean`.
- `memoryContract.list`: thứ tự `pinned desc, createdAt desc` (ghi trong mô tả route; không đổi input).
- Route mới `memory.pin`: `POST /v1/memories/{id}/pin` body `{ pinned: boolean }` → `memory`. Quyền như duyệt memory ở
  phạm vi của memory. Audit `memory.pin`.

## `client-events.ts`

Thêm hai nhánh vào `machineEventInput` và `MACHINE_EVENT_KINDS`:

```ts
const memoryProposePayload = z.object({
  projectId: z.uuid(),
  kind: memoryKind,                         // dùng lại enum sẵn có
  content: z.string().min(1).max(MEMORY_MAX_CHARS),
}).strict();

const projectTokenUsagePayload = z.object({
  projectId: z.uuid(),
  periodStart: z.iso.datetime(),
  periodEnd: z.iso.datetime(),
  tokens: z.record(z.enum(["claude", "codex"]), z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
    cacheRead: z.number().int().nonnegative(),
    weighted: z.number().nonnegative(),
  }).strict()),
  sessions: z.number().int().nonnegative(),
  score: z.number().int().min(0).max(100).nullable(),
  policyDrift: z.array(z.enum(["level", "rtk", "codegraph", "autoCompactWindow", "contextBudgetTokens", "memoryAutoSync"])),
}).strict();
```

`.strict()` và chỉ có số/enum/uuid/ngày: payload không chứa chuỗi tự do (SC-007). Mã từ chối mới: `MEMORY_DISABLED`,
`NOT_PROJECT_MEMBER`, `TOO_LONG`, `RATE_LIMITED` (đã có).

## `fleet.ts`

Route mới `fleet.deleteMyProjectUsage`: `DELETE /v1/machines/{id}/project-usage` → `{ deleted: number }`. Quyền: chủ máy.
