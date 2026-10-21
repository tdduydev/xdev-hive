# Research: Cây giao việc của agent

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-21

Kiểm trên `main` tại `2881aad2` và Claude Code 2.1.306.

## 1. Hiện trạng đã kiểm

- Leader thực hiện hành động ở `executeLeaderAction` (`apps/hub/src/modules/leader/actions.ts:71`), gọi từ hai chỗ, cả
  hai đều biết phiên: duyệt đề xuất (`leader/service.ts:140`, có `approvals.threadId`) và tool `leader_action` chế độ
  bypass (`leader/mcp-tools.ts:197`, có `principal.terminal.threadId`).
- `task.create` ghi `tasks.source = { kind: "leader", … }`, không có phiên. `run.dispatch` gọi `runs.startRun` như người
  dùng, run không biết Leader.
- `runs.leader_thread_id` đã có nhưng **chỉ dành cho run Leader**: unique index `runs_leader_thread_active` cho phép một
  run đang chạy mỗi phiên. Gắn cột này vào run code sẽ vi phạm index.
- Có 9 chỗ chèn `runs` trong `runs/engine.ts` (code, review, plan, sửa, sdlc…). Run con có `parent_run_id` và cùng
  `task_id` với run cha.
- `runs.account_id` có sẵn (nhãn gói), `runs.machine_id`, `cli`, `state`, thời gian; chi phí ở `run_events` loại `cost`.
- Web trang Leader đang poll (`apps/web/src/pages/leader-page.tsx:275`, `refetchInterval`). Desktop đọc hub qua `hub_rpc`.
- Worker đọc stream-json của Claude từng dòng trong `runner/usage.go` (`claudeUsage`), gắn vào stdout bằng
  `io.MultiWriter`. Sự kiện runner đổi thành gói giao thức ở `channel/jobs.go` `durableSink.Emit`.
- `runEventKind` trong `packages/contracts/src/worker-protocol.ts:133` là enum đóng: hub cũ gặp loại lạ sẽ không parse
  được gói và đóng kết nối.

## 2. Định dạng sub-agent của Claude Code 2.1.306

Bản ghi thật (đã bỏ nội dung) ở `worker/internal/runner/testdata/claude-subagent-stream.jsonl`:

| Dòng | Ý nghĩa |
|---|---|
| `assistant` có khối `tool_use` tên `Agent` (bản cũ: `Task`), input `subagent_type`, `description`, `prompt` | Agent gọi sub-agent; `parent_tool_use_id` của dòng là sub-agent cha (null nếu gọi từ phiên chính) |
| `system/task_started` với `task_id`, `tool_use_id`, `subagent_type`, `description`, `spawn_depth`, `is_backgrounded` | Sub-agent bắt đầu |
| `user` có `tool_result` + `tool_use_result.isAsync = true` | Sub-agent chạy nền; chưa phải kết thúc |
| `assistant` có `parent_tool_use_id = <tool_use_id>` và `agent_id` | Tin của sub-agent (có `usage`) |
| `system/task_updated` với `patch.status`, `end_time` | Đổi trạng thái |
| `system/task_notification` với `status`, `usage.total_tokens`, `usage.tool_uses`, `usage.duration_ms`, `summary` | Sub-agent xong; `summary` là chữ tự do |

Bản Claude cũ chạy sub-agent đồng bộ: không có dòng `task_*`, kết thúc là `tool_result` của đúng `tool_use_id`.

## 3. Quyết định

### R1. Bảng liên kết riêng thay vì cột trên `runs`

- **Decision**: bảng `leader_delegations (org_id, thread_id, task_id, run_id null, kind, created_at)`, module `leader`.
  `executeLeaderAction` nhận `threadId` và ghi một dòng cho `task.create` (task) và `run.dispatch` (run + task của run).
  Cây lấy mọi run của các task đó; run con tự nằm dưới run cha qua `parent_run_id`.
- **Rationale**: chỉ sửa một chỗ thay vì 9 chỗ chèn run; không đụng index của run Leader; FR-003 (run con thuộc phiên)
  có sẵn vì run con cùng task.
- **Alternatives**: cột `delegated_by_thread_id` trên `runs` và `tasks`: phải truyền qua 9 chỗ, dễ sót run con.
  Ghi `leaderThreadId` vào `tasks.source` (jsonb): không có cho run giao cho task người dùng tạo, không có khoá ngoại.

### R2. Nhận diện sub-agent theo dòng `system/task_*`, rơi về `tool_use`/`tool_result`

- **Decision**: bộ đọc `subagentTracker` (writer theo dòng, như `claudeUsage`) bắt đầu sub-agent ở `task_started` hoặc
  `tool_use` tên `Agent`/`Task`; kết thúc ở `task_notification` hoặc `tool_result` không `isAsync`. Cha con: `tool_use`
  nằm trong tin có `parent_tool_use_id = X` thì cha là sub-agent của X. Token: `usage.total_tokens` của
  `task_notification`; không có thì cộng `usage` của tin có `parent_tool_use_id` của nó (theo `message.id`).
- **Rationale**: dòng `task_*` có id và số liệu sẵn; đường `tool_use` giữ cho bản Claude cũ.
- **Alternatives**: đọc transcript `subagents/` trên đĩa: chậm, phụ thuộc đường dẫn của CLI.

### R3. Chỉ gửi siêu dữ liệu, chữ qua bước che

- **Decision**: gói `run_event` loại `subagent` với `{id, parentId, type, description, status, depth, tokens, toolUses,
  durationMs, phase: "start"|"end"}`. `description` cắt 120 ký tự, che bằng `redactSecrets` của worker
  (`runner/checks.go`) rồi hub che lại bằng `redactSecrets` của contracts. Không gửi `prompt`, `summary`, output.
- **Rationale**: spec FR-021 và ranh giới dữ liệu spec 027 FR-050, FR-051.

### R4. Tương thích giao thức bằng cờ trong `welcome`

- **Decision**: hub mới thêm `subagents` vào `welcome.features` và nhận `runEventKind = "subagent"`. Worker chỉ gửi loại
  này khi hub có cờ. Run trên CLI không hỗ trợ: worker gửi một lần `subagent` với `status: "unsupported"` để cây ghi rõ.
- **Rationale**: constitution I; hub cũ không bị đóng kết nối vì gói lạ.

### R5. Cây dựng ở hub, client chỉ vẽ

- **Decision**: thủ tục `leader.tree({ threadId })` trả cây đã gộp (nút, quan hệ, số liệu, số mục bị ẩn). Lọc quyền theo
  quyền xem dự án của người gọi. `leader.treeLinks({ taskId } | { runId })` trả các phiên chứa task/run (FR-016).
- **Rationale**: web và desktop dùng chung một hình dữ liệu; quyền kiểm một chỗ.

### R6. Cập nhật bằng poll, không thêm luồng mới

- **Decision**: web và desktop gọi lại `leader.tree` mỗi 3 giây khi cây còn nút đang chạy, 30 giây khi không.
- **Rationale**: SC-002 cần ≤ 5 giây; trang Leader đã poll; tránh thêm endpoint SSE gộp nhiều run. Truy vấn cây là vài
  câu `select` theo index.
- **Alternatives**: SSE theo phiên nghe `hive_runs` NOTIFY: đúng lúc hơn nhưng thêm kết nối dài cho mỗi người xem.

### R7. Vẽ cây bằng HTML/CSS, không thêm thư viện

- **Decision**: danh sách lồng `role="tree"` với đường nối bằng CSS, thu gọn/mở rộng, phím mũi tên theo WAI-ARIA tree.
  Một component dùng chung đặt ở `packages/ui` để web và desktop cùng dùng.
- **Rationale**: 200 nút vẽ nhanh bằng DOM; truy cập bàn phím tốt hơn canvas; không phụ thuộc mới (constitution VII).

### R8. Mở terminal từ cây

- **Decision**: web: bấm run mở trang run hiện có. Desktop: run chạy trên máy này (so `machineId` với máy của worker) mở
  màn "Agent trên máy" và chọn run; run ở máy khác mở trang run trên web bằng trình duyệt.
- **Rationale**: không đổi terminal (spec); dùng lối vào sẵn có.
