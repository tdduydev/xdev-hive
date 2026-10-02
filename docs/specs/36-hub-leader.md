# 36. Leader cấp hub

Viết ngày 2/10. Người dùng hỏi: trên web có cách nào ra prompt cho một agent điều khiển toàn bộ agent, kiểu "control toàn bộ dự án luôn". Họ chọn:
- **chỉ admin hub**, phạm vi cả hub: mọi dự án, mọi máy;
- **cài đặt tự chạy riêng** cho leader cấp hub, không phụ thuộc cài đặt của từng dự án.

Hai task, làm lần lượt:
- **R-36a. Hub và MCP**: thread phạm vi hub, quyền, đề xuất nhắm tới dự án bất kỳ, cài đặt riêng, tool đọc toàn hub.
- **R-36b. Máy và giao diện**: máy chạy leader không gắn repo nào; trang *Chat* có phạm vi *Toàn hub*; skill hướng dẫn.

## Cơ chế có sẵn

- **Chat**: bảng `chat_threads` (`project TEXT NOT NULL`), `chat_messages`, `chat_actions`, `chat_defaults` (theo dự án: máy, gói, model, effort, `auto_kinds` của 29c), lệnh của leader (`chat.setCommands`). Method `chat.*` trong `packages/core/src/sqlite.ts`; kiểm quyền trong `#check` (`chatUse`, `chatApprove`, `projectSettings`).
- **Token của leader**: `ChatGrants` (`apps/web/src/grants.ts`) cắt quyền về mức hẹp hơn giữa người gửi và máy. Token máy là `agent`, nên leader **không bao giờ tự duyệt**, chỉ đề xuất.
- **Đề xuất**:
  - `chatAction` (`methods.ts`), `CHAT_ACTION_KINDS`, `CHAT_ACTION_ALWAYS_CONFIRM` (`types.ts`);
  - bảng loại → method và `CHAT_DECIDE_ORDER` trong `chat.decide` / `decideAll`;
  - tự chạy (29c) qua `chat_defaults.auto_kinds`.
- **Máy**: `ChatWorker` (`apps/desktop/src/main/runner/chat.ts`) chạy `claude -p` với `cwd` là repo của dự án (`req.project`); `ChatRequest` mang `project`, `commands`, `systems`, `files`.
- **MCP của leader**: `createHiveMcpServer` (`packages/mcp/src/server.ts`); các tool `propose_*`; dự án mặc định là dự án của thread.
- **Spec liên quan**: [29-chat-orchestrator.md](29-chat-orchestrator.md).

## Mô hình

- **Phạm vi hub** là `project = "*"` (hằng `HUB_SCOPE` trong `types.ts`).
  - `"*"` không khớp `PROJECT_NAME`, nên không trùng dự án nào.
  - Không cần migration đổi cột: SQLite không bỏ được `NOT NULL` nếu không dựng lại bảng.
- `chat_defaults` và lệnh của leader có thêm dòng `"*"`: máy, gói, model, effort, **`auto_kinds` của leader cấp hub** (đó là "cài đặt riêng"), lệnh.
- `chat_actions.project` là **dự án mà đề xuất nhắm tới**, để *Hôm nay*, bộ lọc và nhật ký theo dự án vẫn đúng. Đề xuất không thuộc dự án nào thì là `"*"`: gói của máy, cài mục của máy, dừng hay chạy lại agent cả hub, chính sách mặc định của hub.

## R-36a. Hub và MCP

**Quyền.** Ở mọi chỗ `#check` gặp thread hay đề xuất có `project === "*"`, kể cả `chat.threads` khi không truyền dự án và lọc kết quả:
- yêu cầu **admin hub** (`actor.role === "admin" && !actor.access`), lỗi `errors.hubAdminOnly` như `agents.stop` cả hub;
- `chat.send`, `chat.get`, `chat.threads`, `chat.rename`, `chat.delete`, `chat.configure`, `chat.cancel`, `chat.decide`, `chat.decideAll`, `chat.defaults`, `chat.setDefaults`, `chat.setCommands`, cài đặt tự chạy: người không phải admin hub không thấy và không làm được gì với thread `"*"`;
- `chat.decide` một đề xuất của thread `"*"`: người duyệt phải là admin hub, **và** method được gọi vẫn tự kiểm quyền như 29b. Không thêm đường tắt.

**Gửi tin** (`chat.send` với `project: "*"`):
- cho phép giá trị này trong schema (`project.or(z.literal("*"))`, chỉ ở các method chat);
- máy phải nhận run từ hub và có gói Claude đã đăng nhập, như hiện nay. Không cần máy có repo dự án nào;
- `ChatRequest` của thread `"*"`:
  - `project: "*"`;
  - `projects`: mọi dự án của hub, mỗi dự án có tên, hệ thống, và máy nào có repo;
  - `commands`, `files` như cũ.

**Đề xuất** (`chat.propose` từ leader của thread `"*"`):
- mọi loại trong `chatAction` có thêm `project?: string`. Thread `"*"` thì **bắt buộc** có `project` (dự án có thật trên hub; lỗi bằng hai key mới `errors.chatProjectRequired` / `errors.chatProjectUnknown`), trừ các trường hợp sau:
  - `machine.profile`;
  - `machine.install` với mục của máy (`cli:*`, `shim`, `tool:*`);
  - `agents.stop` / `agents.resume` không nêu dự án: cả hub;
  - `agent.policy` không nêu dự án: mặc định của hub.

  Các trường hợp này lưu `project = "*"`.
- Kiểm như 29b nhưng theo dự án đã nêu: task thuộc dự án đó, run thuộc dự án đó, mục cài của dự án đó.
- Thread của một dự án bình thường giữ nguyên luật cũ. Trường `project` ở đó chỉ dùng cho task cùng hệ thống, như 19d.
- `CHAT_ACTIONS_PER_REPLY` của thread `"*"` là 50 (hằng mới `CHAT_ACTIONS_PER_HUB_REPLY`), vì một câu lệnh có thể chạm nhiều dự án.

**Tự chạy**: dùng `chat_defaults["*"].auto_kinds`, chỉ admin hub đặt. `CHAT_ACTION_ALWAYS_CONFIRM` (`agent.policy`, `agents.resume`) vẫn luôn chờ duyệt. Việc tự chạy dùng quyền của người gửi tin (admin hub), và nhật ký agent (27c) ghi rõ leader cấp hub làm thay ai.

**MCP** (token leader của thread `"*"`):
- không có dự án mặc định. Mọi tool cần dự án phải nhận `project`; thiếu thì báo lỗi rõ ràng, không đoán;
- tool mới `project_list`: mọi dự án mà token thấy, mỗi dự án có số task theo trạng thái, run đang chạy và đang chờ, máy có repo, hệ thống;
- `run_list`, `run_requests`, `cost_summary`, `machine_list`, `alert_list` gọi không có `project` thì trả **toàn hub**; leader cấp hub có quyền admin hub nên thấy hết;
- mỗi `propose_*` có tham số `project` (mô tả nói rõ là bắt buộc ở phạm vi hub);
- `LEADER_INSTRUCTIONS` thêm một đoạn cho phạm vi hub: đọc `project_list` trước, luôn nêu `project`, gom việc theo dự án.

**Test**:
- `packages/core/test/chat.test.ts`:
  - admin hub mở được thread `"*"`, thành viên hay quản trị dự án thì không, và không thấy trong `chat.threads`;
  - đề xuất ở thread `"*"`: thiếu `project` thì lỗi, có thì lưu `chat_actions.project` là dự án đó; các loại không thuộc dự án lưu `"*"`;
  - duyệt: admin hub duyệt được, quản trị dự án thì không; method vẫn kiểm quyền;
  - tự chạy theo `auto_kinds` của `"*"`; `agent.policy` vẫn chờ;
  - thread của dự án thường không đổi hành vi (test cũ vẫn qua).
- `packages/mcp/test/mcp.test.ts`: `project_list`; tool không có dự án mặc định; các tool đọc trả toàn hub.
- `apps/web/test/chat.test.ts`: một vòng qua RPC: admin gửi tin `"*"`, leader đề xuất tạo task ở hai dự án, duyệt tất cả.

## R-36b. Máy và giao diện

**Máy** (`ChatWorker`), với thread `"*"`:
- `cwd` là thư mục riêng `<dataDir>/chat-hub` (tạo nếu chưa có, không phải repo);
- thêm `--add-dir` cho repo của **mọi dự án máy có**, để leader đọc code ở đó;
- câu dặn đầu (`leaderBrief`) nói rõ phạm vi hub, liệt kê dự án và máy có repo, nhắc luôn nêu `project`;
- leader vẫn không sửa file. Lệnh được chạy là lệnh của dòng `"*"`, mặc định là các lệnh git chỉ đọc. Mỗi lệnh chạy trong repo mà nó nêu.

**Giao diện** (`packages/ui/src/pages/Chat.tsx` và phần cài đặt chat):
- *Chat mới* có lựa chọn **Toàn hub** đầu danh sách dự án, chỉ hiện với admin hub. Thread hub có nhãn *Toàn hub* trong danh sách.
- Thẻ đề xuất có **nhãn dự án** (hay *Cả hub*) cho mọi loại. *Xác nhận tất cả* vẫn theo thứ tự `CHAT_DECIDE_ORDER`.
- Cài đặt của *Toàn hub*: máy, gói, model, effort mặc định; lệnh; **Leader tự chạy** riêng, giống bảng của 29c nhưng lưu vào dòng `"*"`. Chỉ admin hub thấy.
- *Hôm nay* (35c): đề xuất của thread `"*"` chỉ hiện với admin hub, nhóm theo dự án đề xuất nhắm tới.
- Chuỗi giao diện vào `vi.ts` (gốc) và `en.ts`.

**Skill**: seed `hive-leader` thêm mục *Phạm vi hub*:
- đọc `project_list` và `alert_list` trước;
- mỗi đề xuất nêu `project`;
- gom theo dự án, việc rủi ro cao (merge, dừng agent, chính sách) để người quyết.

Hub đang chạy cần một đề xuất trên trang *Skill* sau khi deploy; người merge làm việc này.

**Test**:
- `apps/desktop/test/runner.test.ts` (phần chat): thread `"*"` chạy trong `chat-hub` với `--add-dir` mọi repo, câu dặn có danh sách dự án.
- e2e web: admin mở *Toàn hub*, thấy thẻ đề xuất có nhãn dự án; thành viên không thấy lựa chọn này.

## Ràng buộc khi làm

- Theo quy tắc ngày 2/10 (hub memory #198): việc code do agent trên máy runner làm; người merge chạy typecheck, test, e2e, build và smoke.
- Không tăng `version`, không đánh dấu [x] trong `docs/roadmap.md`.
- Import khác thư mục dùng alias (`#core/`, `#mcp/`, `#ui/`, `#web/`, `#desktop/`). Chuỗi giao diện và key lỗi trong `vi.ts` / `en.ts`.
- Không đổi hành vi của thread theo dự án.
- Không có đường tắt quyền nào: duyệt luôn qua method của web với quyền người duyệt.
- Comment giải thích vì sao.
- Kết thúc: `task_update` sang `review`, ghi chú đã làm / chưa làm / cách kiểm / rủi ro.
