# Contracts: Cây giao việc của agent

Nguồn sự thật là zod trong `packages/contracts` (constitution I); file này chỉ tóm tắt.

## Hub API (`packages/contracts/src/leader.ts`)

| Thủ tục | Đường dẫn | Vào | Ra |
|---|---|---|---|
| `leader.tree.get` | `GET /v1/leader/threads/{id}/tree` | `{ id }` (phiên) | `delegationTree` |
| `leader.tree.links` | `GET /v1/leader/tree-links` | `{ taskId? , runId? }` | `[{ threadId, title }]` |

- `delegationTree = { thread, tasks: treeTask[], hidden, active }`.
- `treeTask = { id, key, title, status, projectKey, createdBy: "leader" | "user", runs: treeRun[] }`; `runs` gồm mọi run của
  task, run con có `parentRunId` trỏ về run cha trong cùng danh sách.
- `treeRun.subagents`: `null` khi CLI chưa báo gì; `subagentsUnsupported` khi CLI không hỗ trợ.
- Lỗi: như các route Leader khác (`NOT_FOUND` khi không thấy phiên hay không có quyền xem phiên).

## Giao thức worker (`packages/contracts/src/worker-protocol.ts`)

- `runEventKind` thêm `subagent`; dữ liệu theo `subagentEventData` (xem [data-model.md](../data-model.md)).
- `welcome.features` thêm `subagents`. Worker chỉ gửi `run_event` loại `subagent` khi có cờ này.
- Cập nhật `packages/contracts/fixtures/worker-protocol.json` và kiểu Go (`worker/internal/channel/protocol.go`).

## Leader action (nội bộ hub)

`executeLeaderAction(tx, userId, action, runs, sdlc, threadId?)`: có `threadId` thì ghi `leader_delegations` cho
`task.create` và `run.dispatch`.
