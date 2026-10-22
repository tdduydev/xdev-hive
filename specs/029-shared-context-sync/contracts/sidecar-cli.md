# Contract: lệnh sidecar `hive-worker` (desktop ↔ worker)

Mọi lệnh in **một** JSON ra stdout khi có `--json`; lỗi in `{"error":{"code","message"}}` (message tiếng Việt), mã thoát
khác 0. Dữ liệu lớn (nguồn, memory hub, kế hoạch, chính sách) đi qua file tạm do Rust tạo, xoá sau khi chạy. Kiểu TS
tương ứng nằm ở `apps/desktop/src/lib/context-sync.ts`, `optimize-all.ts`, `outbox.ts`, có test khớp fixture Go trong
`worker/internal/*/testdata/`.

## `hive-worker context`

| Lệnh | Vào | Ra |
|---|---|---|
| `context status --json [--project <khoá>]` | | `{ projects: ContextProject[] }` |
| `context enable --json --folder <dir> [--project-id <uuid>]` | | `ContextProject` (kèm `migration?` nếu có chia sẻ memory cũ) |
| `context disable --json --project <khoá>` | | `{ removed: string[], trashed: string[] }` |
| `context save-source --json --project <khoá> --content-file <f>` | Markdown | `ContextProject` (đã đồng bộ file đích) |
| `context sync --json --project <khoá> [--hub-file <f>] [--policy-file <f>]` | `HubSnapshot`, `DevOptimizerPolicy` | `ContextProject` |
| `context resolve --json --project <khoá> --target <id> --keep file\|source` | | `ContextProject` |
| `context migrate --json --project <khoá> [--apply]` | | `{ draft: string, files: string[] }`; `--apply` thì lưu nguồn và `Unshare` |

```ts
type ContextTargetId = "claude" | "codex" | "gemini" | "antigravity";
type ContextTarget = {
  id: ContextTargetId;
  path: string;                 // tương đối với folder
  status: "ok" | "stale" | "conflict" | "skipped";
  reason: string | null;        // tiếng Việt
  conflict?: { file: string; source: string } | null;
};
type ContextProject = {
  key: string;
  projectId: string | null;
  folder: string;
  enabled: boolean;
  sourceTokens: number;
  blockTokens: number;
  targets: ContextTarget[];
  hub: { syncedAt: string | null; items: number; omitted: { budget: number; secret: number }; lastError: string | null } | null;
  autoSync: { enabled: boolean; minutes: number; source: "machine" | "policy" };
  locked?: boolean;             // true khi optimize.lock đang bận, không ghi
};
type HubSnapshot = {
  projectId: string;
  items: { id: string; kind: string; pinned: boolean; createdAt: string; content: string }[];
};
```

## `hive-worker optimize all`

| Lệnh | Vào | Ra |
|---|---|---|
| `optimize all --preview --json [--policy-file <f>]` | `{ [projectId]: DevOptimizerPolicy }` | `OptimizePlan` |
| `optimize all --apply --json --plan-file <f>` | `OptimizePlan` đã chọn (`selected`) | `OptimizeRun` |
| `optimize all --undo --json --run <id>` | | `OptimizeRun` (`undoneAt` có giá trị) |
| `optimize all --last --json` | | `OptimizeRun \| null` |

```ts
type StepGroup = "cli" | "tools" | "context" | "score";
type PlanStep = {
  id: string;                    // optimizer.enable | fix.<fixId> | tool.<id> | context.sync | score.recompute
  group: StepGroup;
  target: string;                // id gói, khoá dự án hoặc id công cụ
  title: string;                 // tiếng Việt
  changes: { file: string; key: string; before: string | null; after: string | null }[];
  selected: boolean;             // mặc định do sidecar đặt; aggressive = false
  requiresConfirm: boolean;
  undoable: boolean;             // tool.* = false
  reason: string;                // "Theo chính sách dự án acme/web" | "Mặc định"
};
type OptimizePlan = { createdAt: string; scoreBefore: number | null; steps: PlanStep[] };
type OptimizeRun = {
  id: string;
  scoreBefore: number | null;
  scoreAfter: number | null;
  steps: (PlanStep & { status: "skipped" | "ok" | "failed" | "undone"; error: string | null })[];
  undoneAt: string | null;
};
```

Bước `tool.*` do Rust chạy (bảng `doctor.rs`) trước khi gọi `--apply`; Rust ghi kết quả vào kế hoạch gửi kèm để nhật ký
đủ. Lỗi `OPTIMIZE_LOCKED` khi khoá bận.

## `hive-worker outbox`

| Lệnh | Vào | Ra |
|---|---|---|
| `outbox submit --json --kind <kind> --payload-file <f>` | payload theo `client-events.ts` | `{ key: string, state: "pending" }` |
| `outbox flush --json` | | `{ sent: number, rejected: {key, code, message}[], pending: number }` |
| `outbox status --json` | | `{ pending: number, rejected: {key, kind, code, message, at}[] }` |

`kind`: `memory.propose`, `project.token_usage`, `machine.token_score`.
