# Contract: sự kiện client (US1)

Nguồn zod: `packages/contracts/src/client-events.ts` (mới). OpenAPI sinh lại bằng `pnpm openapi`.

## Header của mọi lần ghi qua `/mcp` (`tools/call`) và `/rpc`

| Header | Bắt buộc | Giá trị |
|---|---|---|
| `Idempotency-Key` | Có từ bản phát hành thứ ba (FR-005); trước đó không | 16–64 ký tự `[A-Za-z0-9_-]`, ULID khuyến nghị |
| `X-Hive-Source` | Không (mặc định `unknown`) | `worker-run`, `worker`, `desktop`, `hive-cli`, `mcp-local`, `vscode`, `web` |
| `X-Hive-Machine` | Không | id máy (uuid). Hub chỉ nhận khi máy cùng tổ chức và do chính người của token đăng ký, hoặc là máy dùng chung của đội người đó |
| `X-Hive-Created-At` | Không | RFC 3339, giờ máy |
| `X-Hive-Client` | Không | `<tên>/<phiên bản>`, vd. `hive-cli/0.42.0` |

MCP còn nhận khoá ở `params._meta["dev.xdev.hive/idempotencyKey"]` cho client không đặt được header; header thắng nếu có
cả hai.

## Kết quả

Với MCP: kết quả tool như hiện nay, thêm `_meta["dev.xdev.hive/clientEvent"]`. Với oRPC: header trả về
`Hive-Client-Event`, body như hiện nay.

```ts
export const clientEventOutcome = z.enum(["accepted", "duplicate", "rejected"]);
export const clientEventResult = z.object({
  key: idempotencyKey,
  outcome: clientEventOutcome,
  /** Mã lỗi nghiệp vụ khi rejected, vd. TASK_CANCELLED. */
  code: z.string().max(64).optional(),
  /** Câu tiếng Việt, đã che secret. */
  reason: z.string().max(500).optional(),
  receivedAt: z.iso.datetime(),
});
```

- `duplicate`: body là `response` đã lưu của lần đầu (lần đầu `rejected` thì lần gửi lại vẫn là lỗi với cùng `code`,
  kèm `outcome: "duplicate"` trong `_meta`).
- `rejected`: MCP trả `isError: true` cùng nội dung lỗi tiếng Việt; oRPC trả lỗi 4xx như hiện nay, thêm header.
- Lỗi 5xx và 503 lúc hub đang khởi động: không có header `Hive-Client-Event`, client coi là lỗi tạm và giữ mục.

## Bảng tool có ghi

```ts
export const clientWriteGroup = z.enum(["progress", "proposal", "immediate"]);
export const CLIENT_WRITE_TOOLS = {
  task_update: "progress",
  sdlc_report: "progress",
  sdlc_ask: "progress",
  doc_propose: "proposal",
  doc_suggest: "proposal",
  doc_comment: "proposal",
  skill_propose: "proposal",
  memory_write: "proposal",
  plan_submit: "proposal",
  review_submit: "proposal",
  skill_proposal_submit: "proposal",
  brief_submit: "proposal",
  doc_check_submit: "proposal",
  doc_assist_submit: "proposal",
  leader_reply: "immediate",
  leader_propose: "immediate",
  leader_action: "immediate",
  artifact_create: "immediate",
  artifact_update: "immediate",
} as const satisfies Record<string, ClientWriteGroup>;

/** Thủ tục oRPC có ghi mà client gọi; middleware clientEvent áp cho các thủ tục này. */
export const CLIENT_WRITE_PROCEDURES = { "memory.write": "proposal" } as const;

/** Sự kiện máy không qua MCP hay oRPC (POST /api/v1/client-events). */
export const MACHINE_EVENT_KINDS = { "machine.token_score": "progress" } as const;
```

- Fixture `packages/contracts/fixtures/client-write-tools.json` sinh từ ba bảng trên (`pnpm openapi` sinh luôn).
- Test hub: mọi tool trong `mcp/registry.ts` mà handler có ghi (đánh dấu `writes: true` ở định nghĩa tool, mới) phải có
  trong `CLIENT_WRITE_TOOLS`; mọi tool trong bảng phải tồn tại.
- Test Go: `worker/internal/outbox/tools.go` khớp fixture.
- `progress`, `proposal`: hộp thư đi giữ khi hub vắng. `immediate`: báo "Hub đang vắng", không xếp hàng (FR-012).

## Sự kiện máy

`POST /api/v1/client-events`, xác thực bằng access token máy (R8). Body:

```ts
export const machineEvent = z.object({
  key: idempotencyKey,
  kind: z.enum(["machine.token_score"]),
  createdAt: z.iso.datetime(),
  payload: z.unknown(), // kiểm theo kind; schema của machine.token_score thuộc spec 025
});
```

Trả `clientEventResult`. Nguồn luôn là `worker`; `machine_id` lấy từ token, không lấy từ body.

## Lịch sử task (FR-006)

`tasks.history({taskId})` (oRPC, mới) trả danh sách gộp từ `client_events` (đối tượng là task hay run của task) và
`run_events` loại `state`, sắp theo `received_at`:

```ts
export const taskHistoryItem = z.object({
  at: z.iso.datetime(),
  clientCreatedAt: z.iso.datetime().nullable(),
  kind: z.string(),
  outcome: clientEventOutcome.exclude(["duplicate"]),
  source: clientSource,
  machine: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  actor: z.object({ id: z.string(), name: z.string() }).nullable(),
  reason: z.string().nullable(),
});
```
