# Data Model: Ngữ cảnh dùng chung, đồng bộ dự án và nút "Tối ưu"

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

## Trên máy

Mọi file dưới `~/.xdev-hive/` (Windows: `%USERPROFILE%\.xdev-hive\`), quyền 0600 trên Unix, ghi nguyên tử.

### Nguồn ngữ cảnh dự án — `context/<khoá>/source.md`

- `<khoá>`: `p_<projectId>` khi dự án gắn hub, không thì `f_<memstore.ProjectKey(folder)>`.
- Nội dung Markdown người dùng soạn. Rỗng là hợp lệ (khối chỉ có "Từ hub").

### Bản hub — `context/<khoá>/hub.json`

```jsonc
{
  "projectId": "uuid",
  "syncedAt": "2026-10-22T10:00:00Z",   // lần đồng bộ thành công gần nhất
  "lastError": null,                     // chuỗi tiếng Việt khi lần gần nhất lỗi
  "budgetTokens": 2000,
  "items": [{ "id": "uuid", "kind": "note", "pinned": true, "createdAt": "…", "content": "…", "tokens": 120 }],
  "omitted": { "budget": 3, "secret": 1 }
}
```

### Trạng thái — `context/<khoá>/state.json`

```jsonc
{
  "version": 1,
  "enabled": true,
  "folder": "E:/Codes/acme/web",          // thư mục dự án hiện tại
  "autoSync": { "enabled": true, "minutes": 60, "source": "policy" },  // "machine" | "policy"
  "targets": [
    {
      "id": "claude",                      // claude | codex | gemini | antigravity
      "path": "CLAUDE.local.md",            // tương đối với folder
      "created": true,                      // app tạo file (gỡ khi tắt)
      "excludeAdded": "CLAUDE.local.md",    // dòng đã thêm vào .git/info/exclude, null nếu không thêm
      "blockSha": "a1b2c3d4e5f6",           // băm khối lần ghi trước
      "mirrorOf": null,                     // codex: { "path": "AGENTS.md", "sha": "…" }
      "extra": null,                        // gemini: { "settings": ".gemini/settings.json", "added": "GEMINI.local.md", "created": false }
      "status": "ok",                       // ok | stale | conflict | skipped
      "reason": null                        // lý do tiếng Việt khi skipped/conflict
    }
  ]
}
```

Chuyển trạng thái một file đích:

```
(chưa có) ──enable──▶ ok ──nguồn/hub đổi──▶ stale ──sync──▶ ok
ok ──người sửa trong khối──▶ conflict ──resolve keep=source──▶ ok
                                       └─resolve keep=file──▶ ok (bản file thành nguồn "Tại máy")
mọi trạng thái ──file bị git theo dõi / CLI không cài / override tự viết──▶ skipped
mọi trạng thái ──disable──▶ (gỡ khối, file app tạo vào thùng rác)
```

### Lần tối ưu — `optimizer/runs/<runId>.json`

```jsonc
{
  "id": "01JB…",                 // ULID
  "startedAt": "…", "finishedAt": "…",
  "scoreBefore": 48, "scoreAfter": 81,
  "policySources": ["acme/web"],  // dự án có chính sách đã dùng
  "steps": [
    {
      "id": "optimizer.enable",   // danh sách đóng: optimizer.enable | fix.<id> | tool.<id> | context.sync | score.recompute
      "target": "claude-2",
      "status": "ok",             // planned | skipped | ok | failed | undone
      "error": null,
      "undo": { "kind": "optimizer", "profile": "claude-2", "backup": "backups/claude-2/20261022T100000Z.json", "prevEnabled": false }
      // fix.*: { "kind": "scoreFix", "profile": "…", "record": {…} }
      // context.sync: { "kind": "memstore", "entry": "<memstore entry id>" }
      // tool.*: null (không hoàn tác)
    }
  ],
  "undoneAt": null
}
```

Chỉ lần gần nhất chưa hoàn tác được hoàn tác. Giữ 30 lần gần nhất.

### Việc chờ gửi — `outbox/<identity>/<ulid>.json`

Theo [spec 027 data-model](../027-hub-client-model/data-model.md) mục "Mục hộp thư đi". Spec này chỉ dùng kênh `worker`
và ba `kind`: `memory.propose`, `project.token_usage`, `machine.token_score`. `key` (ULID) là `idempotencyKey` gửi hub.

## Trên hub

### `hive.memories` — thêm cột

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `pinned` | `boolean not null default false` | Ghim để luôn được kéo về trước. Đổi qua `memory.pin`, audit `memory.pin` |

`listMemories` sắp `pinned desc, created_at desc`. RLS sẵn có không đổi.

### `projects.settings.devOptimizer` (jsonb sẵn có, tách khỏi `tokenSaving`)

| Trường | Kiểu | Mặc định | Ràng buộc |
|---|---|---|---|
| `level` | `"off" \| "balanced" \| "aggressive"` | `"balanced"` | |
| `rtk` | boolean | `false` | Bỏ qua trên máy không hỗ trợ |
| `codegraph` | boolean | `false` | |
| `autoCompactWindow` | number \| null | `null` | 50.000–1.000.000 token |
| `contextBudgetTokens` | number | `2000` | 500–8.000 |
| `memoryAutoSync` | boolean | `false` | |
| `memorySyncMinutes` | number | `60` | 15–1.440 |

Không có trường thì máy dùng mặc định của máy (không có chính sách). Sửa: `projects.updateSettings` (admin đội/tổ chức),
audit `project.settings.update` sẵn có.

### `hive.project_token_usage` — bảng mới (migration 0084)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid not null | RLS `orgScoped` |
| `team_id` | uuid not null | đội của dự án |
| `project_id` | uuid not null fk `projects` | |
| `machine_id` | uuid not null fk `machines` | |
| `user_id` | uuid not null | chủ máy (`registeredBy`) |
| `period_start`, `period_end` | timestamptz | kỳ 7 ngày |
| `tokens` | jsonb | `{ "claude": {"input":…, "output":…, "cacheRead":…, "weighted":…}, "codex": {…} }` — chỉ số |
| `sessions` | integer | |
| `score` | integer null | điểm máy 0–100 nếu có |
| `policy_drift` | text[] | tên mục chính sách bị lệch (`level`, `rtk`, …) |
| `received_at` | timestamptz | |

- Khoá duy nhất `(machine_id, project_id, period_end)`; upsert.
- Giới hạn 1 lần / 10 phút mỗi `(machine_id, project_id)`; giữ 90 ngày (dọn cùng `machine_token_scores`).
- Bật và ép RLS; thêm vào `fleet/rls.db.test.ts`.
- Đọc: thành viên dự án qua `projects.tokenUsage`. Xoá: chủ máy qua `fleet.deleteMyProjectUsage`.

### Sự kiện máy mới (`POST /v1/client-events`)

| `kind` | Payload | Xử lý |
|---|---|---|
| `memory.propose` | `{ projectId, kind, content (1–2000) }` | `knowledge.proposeFromMachine`: kiểm chính sách memory tổ chức, chủ máy là thành viên dự án → memory `pending`, `source:"machine"`, ghi máy nguồn vào audit. Từ chối: `MEMORY_DISABLED`, `NOT_PROJECT_MEMBER`, `TOO_LONG` |
| `project.token_usage` | Bảng trên trừ id/org/team/user (hub tự điền) | `fleet.recordProjectUsage`. Từ chối: `RATE_LIMITED`, `NOT_PROJECT_MEMBER` |
