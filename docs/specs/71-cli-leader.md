# 71. cli-leader: leader của dự án từ Claude Code / Codex

Hỏi 8/10: "sao các service khác khi chat trên claude, codex không tự hiểu là mình làm leader cho dự án? không call MCP của Hive để tạo task, phân task, tài liệu". Chọn hướng 2: phiên CLI tương tác cũng làm leader được.

## Vì sao hiện không được

- MCP chỉ đăng ký `propose_*` khi token là của một reply trong Chat (`actor.chatReply`, `packages/mcp/src/server.ts`). Phiên CLI dùng MCP credential (`mcpCredential`, không có `runCredential`), nên chỉ thấy tool của worker: `task_claim`, `task_update`, `doc_propose`, `memory_*`. Không có tool tạo task, đặt phụ thuộc hay giao task, dù hub đã có `tasks.create`, `tasks.setDeps`, `tasks.assign`, `runs.dispatch` và quyền `taskManage` / `runDispatch`.
- Proposal của leader gắn với một reply (`chat.propose` báo lỗi khi không có `chatReply`), vì người quản trị bấm *Xác nhận* trong thread.
- Agent protocol sinh vào `AGENTS.md` (`org/agent-protocol`) chỉ dạy quy trình worker. Mô tả skill `hive-leader` nói chỉ dùng trong trang Chat. Lời dặn leader (`leaderBrief`, `apps/desktop/src/main/runner/chat.ts`) chỉ đi kèm reply của Chat.

## Hướng làm

Phiên tương tác là người dùng đang ngồi trước CLI, nên agent làm thay họ, bằng quyền của chính họ trên dự án, giống thao tác trên Board. Việc lớn hoặc khó quay lại vẫn cần người xác nhận trên hub.

### 71a. cli-leader-tools (core + mcp)

Điều kiện: actor có `mcpCredential`, không có `runCredential`, không có `chatReply` (phiên tương tác, không phải run, không phải Chat). Tool được đăng ký theo quyền của tài khoản trên dự án. Không có quyền thì không đăng ký tool, giống cách làm với viewer.

Ghi thẳng, bằng quyền của người dùng, có audit (`agent`, `onBehalf`, `source.via = "mcp"`):

- `task_create` (`taskManage`): id theo kiểu dự án, title, note có tiêu chí xong, `dependsOn`, kind/size/risk tuỳ chọn. Gọi `tasks.create`.
- `task_set_deps` (`taskManage`): gọi `tasks.setDeps`.
- `task_status` (`taskManage`): đổi trạng thái task không phải của mình (todo/blocked/…), bắt buộc có note. Không đưa task sang `done` khi task đang review mà không có quyền `codeReview`.
- `task_assign` / `run_dispatch` (`runDispatch`): giao task cho máy hoặc gói, hoặc xếp run (implement/review, `reviewAfter`, chỉ dẫn).
- `plan_create` (`taskManage` + `docPropose`): một spec ở `project/<service>/<slug>` (hoặc `system/<system>/<slug>`) gồm nhiều task có `dependsOn`, cùng cấu trúc với `propose_plan`. Spec lưu dạng đề xuất tài liệu nếu người dùng không có `docEdit`.

Vẫn là đề xuất, chờ người xác nhận trong *Hộp thư* / *Đề xuất* trên hub (`proposals.create`, không gắn reply): merge, dừng/tiếp tục agent, đổi policy, cài đặt trên máy, bật tắt gói.

Instructions của MCP server (`createHiveMcpServer`) có thêm đoạn cho phiên CLI leader: khi người dùng giao việc quản lý thì dùng các tool trên, và nói rõ đã tạo hay giao gì.

Tiêu chí xong:
- Test của `packages/mcp`: đăng ký tool theo bốn loại actor (viewer, member, lead dùng MCP credential, run credential, chat reply). Run credential và chat reply không thấy tool mới. Member không thấy `task_create`.
- Test core: task tạo qua tool có audit đúng `agent`/`onBehalf`. `dependsOn` vòng bị từ chối như `tasks.setDeps`.
- `npm run typecheck`, `npm test` xanh.

### 71b. leader-protocol (tài liệu agent đọc)

- `org/agent-protocol` (seed và bản trên hub qua `doc_propose`) có thêm mục *Vai trò*: người dùng nhờ lập kế hoạch, tạo task, phân việc, cập nhật tài liệu dự án thì làm leader (đọc skill `hive-leader`, dùng tool leader). Đang làm một task đã claim thì làm worker như cũ.
- Skill `hive-leader` (qua `skill_propose` hoặc trang Skill): mô tả áp dụng cho cả trang Chat và phiên Claude Code / Codex tương tác. Thêm mục *Từ CLI*: tên tool khác (`task_create`… thay cho `propose_*`), việc nào ghi thẳng, việc nào vẫn là đề xuất. Codex không tải `.claude/skills`, nên protocol ghi rõ là đọc skill bằng `skill_get`.
- README: mục ngắn *Làm leader từ Claude Code / Codex*.

Tiêu chí xong: repo đã đồng bộ sinh ra `AGENTS.md` / `CLAUDE.md` có mục *Vai trò*. Skill mới đã có trên hub. Test seed cập nhật.

### 71c. cli-leader-e2e (nghiệm thu)

Trên hub demo: mở một phiên MCP bằng credential tương tác của tài khoản `lead`, sau đó tạo hai task có phụ thuộc, giao một task cho một gói, và đề xuất một merge. Kiểm tra: Board hiện hai task và phụ thuộc, run được xếp, đề xuất merge nằm ở *Đề xuất* chờ xác nhận, audit ghi đúng người. Lặp lại với tài khoản `member`: không thấy tool tạo task.

Tiêu chí xong: bước e2e trong `apps/web/e2e` xanh trên máy gate.
