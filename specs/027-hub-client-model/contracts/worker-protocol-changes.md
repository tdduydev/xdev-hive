# Contract: thay đổi giao thức worker và API vận hành (US4, US5)

Mọi thay đổi là trường tuỳ chọn mới hay loại gói mới mà bên cũ bỏ qua được (constitution I). Cập nhật
`packages/contracts/fixtures/worker-protocol.json` và kiểu Go trong `worker/internal/channel/protocol.go`.

## `welcome` (hub → worker)

```ts
welcome: {
  // ...hiện có: sessionId, heartbeatSec, accessTokenExp, features, owner, policy.totpFallback
  features: string[],          // thêm "logs-local" (US5), "client-events" (hub nhận Idempotency-Key)
  policy: {
    totpFallback,              // hiện có
    runLogRetentionDays: z.number().int().min(1).max(3650).optional(),  // mới, POL-05
  },
  dbEpoch: z.uuid().optional(),           // mới, R7
  dbRestoredTo: z.iso.datetime().nullable().optional(),
}
```

## Log run (US5)

| Bên | Hành vi |
|---|---|
| Worker mới + hub có `logs-local` | Không gửi `log_chunk`. Ghi log vào `DataDir/runs/` |
| Worker mới + hub cũ | Gửi `log_chunk` như cũ, **và** ghi log vào máy |
| Worker cũ + hub mới | Hub ack `log_chunk` rồi bỏ, không ghi `run_logs` |

`run_result.report` và `run_event` loại `agent_report` đi qua bước che secret ở worker (R12) rồi ở hub.

## PTY (US5, R11)

- Hub mới không ghi `terminal_chunks`. `term_output` của phiên đang có người xem từ xa vẫn được chuyển tới trình duyệt
  đang mở, không lưu.
- `term_ack` giữ nguyên để worker xoá `DataDir/terminal/<id>.pending`.

## `/api/v1/health`

```ts
healthOutput: {
  // ...hiện có
  dbEpoch: z.uuid().optional(),
  roles: z.array(z.enum(["api", "jobs"])).optional(),    // vai trò của tiến trình trả lời
}
```

`GET /api/v1/health/jobs` (mới, chỉ gọi từ trong mạng compose): tiến trình `jobs` trả `{ ok, lastTickAt }` để healthcheck
của service `hub-jobs`.

## Trang "Dữ liệu hub giữ" (FR-054)

```ts
export const hubDataItem = z.object({
  id: z.string(),                 // "tasks", "client_events"…
  label: z.string(),              // tiếng Việt
  tables: z.array(z.string()),    // "hive.tasks"
  source: z.array(clientSource.or(z.literal("hub"))),
  retention: z.string(),          // "Theo chính sách audit (90–3650 ngày)"
  userContent: z.boolean(),       // nội dung người dùng hay agent chủ động gửi
});
export const HUB_DATA_INVENTORY: HubDataItem[] = [/* ... */];
export const HUB_DATA_EXCLUDED = ["Log terminal", "Mã nguồn", "Secret của máy", "Thông tin tài khoản AI"];
```

Web đọc thẳng hằng này (không cần API). Test db: mọi bảng của schema `hive` và `auth` có trong đúng một mục.
