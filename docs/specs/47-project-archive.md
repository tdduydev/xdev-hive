# 47. Lưu trữ và xoá dự án

Viết ngày 5/10. Người dùng thấy ba dự án không dùng nữa trong mục *Dự án khác* (`csdlqg`, `customer`, `customer-ai`) và muốn xoá, nhưng Hive chưa có cách nào. Người dùng chọn:
- **lưu trữ** (ẩn, khôi phục được) **và xoá hẳn**;
- khi tính năng có rồi thì xoá hẳn cả ba dự án đó.

Task: **R-47**.

## Hiện trạng

- Hub không có method `projects.*`. Một dự án tồn tại vì có dữ liệu mang tên nó (task, tài liệu `project/<dự án>/…`, memory, run…), hoặc vì một máy báo nó trong heartbeat (`machines.projects`).
- Hiện trạng ba dự án, đo ngày 5/10:

| Dự án | Task | Tài liệu | Memory | Run | Máy báo có repo |
|---|---|---|---|---|---|
| `csdlqg` | 0 | 1 | 0 | 0 | win-2 |
| `customer` | 0 | 141 (nhập từ XDev Forge ngày 28/9, bản gốc còn trên Mac) | 0 | 0 | — |
| `customer-ai` | 0 | 1 | 0 | 0 | win-runner |

- Bảng có cột dự án (đọc từ `MIGRATIONS` ngày 5/10):
  - `chat_actions`, `chat_defaults`, `chat_files`, `chat_threads`;
  - `doc_assists`, `docs` (theo khoá `project/<dự án>/…`);
  - `machine_commands.project`, `machines.projects`;
  - `memory`, `run_costs`, `run_groups`, `run_records`, `run_requests`;
  - `sdlc_flow_tasks`, `sdlc_flows`, `sdlc_gates`;
  - `spec_features`, `tasks`, `tool_projects`.

  Gắn theo khoá tài liệu: `doc_assets`, `doc_assists`, `proposals` (và lịch sử phiên bản tài liệu).
- Lưu dạng JSON hay trong settings: quyền theo dự án của tài khoản và token (`access.projects`), chính sách agent (`agentPolicy.projects`), chính sách cài đặt (`policy.projects`), trần chi tiêu theo dự án, `systems.projects`, bộ lọc dự án của webhook, lịch sử ghi chú hay kho artifact (41a/41c) nếu có.
- Người làm phải tự rà lại toàn bộ `sqlite.ts` lúc làm, vì sau ngày 5/10 có thể có bảng mới.

## Mô hình

- Bảng mới `project_states(project TEXT PRIMARY KEY, state TEXT NOT NULL, at TEXT NOT NULL, by TEXT NOT NULL)`:
  - `state` là `archived` hoặc `deleted`;
  - không có dòng nghĩa là đang dùng;
  - migration mới ở cuối `MIGRATIONS`, lấy số kế tiếp trên main lúc merge.
- `deleted` là bia mộ: tên dự án đó không sống lại khi một máy còn báo nó. Muốn dùng lại tên thì admin bấm *Khôi phục tên*, tức là xoá dòng.

## Method (chỉ admin hub; kiểm trong `#check`, ghi `AUDITED`, phát sự kiện)

| Method | Làm gì |
|---|---|
| `projects.list` `{}` | Mọi tên dự án hub biết (từ dữ liệu, máy báo, `project_states`) với số task (mở / tổng), tài liệu, memory, run, máy báo có repo, hệ thống, trạng thái. Viewer cũng gọi được, nhưng chỉ thấy dự án mình có `view`. |
| `projects.archive` `{ project }` | Đánh dấu `archived`. |
| `projects.restore` `{ project }` | Bỏ `archived` (hay bỏ bia mộ `deleted`). |
| `projects.delete` `{ project, confirm }` | Chỉ với dự án đã `archived`; `confirm` phải đúng tên dự án. Hub chạy backup trước (như `hub.backup`; backup lỗi thì không xoá), rồi xoá **trong một giao dịch** mọi dòng của dự án ở mọi bảng trên, gỡ dự án khỏi mọi JSON trên, gỡ tệp tài liệu trong SeaweedFS (sau giao dịch; lỗi thì ghi nhật ký, không làm hỏng việc xoá), rồi đặt `deleted`. Trả về số dòng đã xoá theo bảng. |

## Hành vi khi dự án đã lưu trữ hay đã xoá

- Không hiện ở ô phạm vi, *Dự án khác*, bộ chọn dự án, Hôm nay, Board, Lượt chạy, Chat.
- Hub từ chối tạo hay đổi task, xếp run, gửi chat, ghi memory, lưu tài liệu của dự án đó, lỗi `errors.projectArchived` / `errors.projectDeleted`. Đọc của dữ liệu đã lưu trữ thì vẫn cho, để khôi phục được.
- Heartbeat bỏ qua dự án đó trong danh sách máy báo, và trả lại `archivedProjects` để app desktop hiện nhãn *Đã lưu trữ trên hub* ở *Dự án & công cụ*. Runner không nhận run cho dự án đó.

## Giao diện

- Trang *Dự án & hệ thống* của Web Admin có bảng **Dự án**:
  - tên, số liệu như `projects.list`, máy, hệ thống, trạng thái;
  - các nút *Lưu trữ*, *Khôi phục*, *Xoá hẳn*;
  - *Xoá hẳn* mở hộp thoại: liệt kê những gì sẽ mất, nói rõ hub backup trước, và phải gõ tên dự án mới bấm được.
- Chuỗi trong `vi.ts` (gốc) và `en.ts`.

## Test

- Hub test:
  - archive thì ẩn khỏi danh sách và từ chối ghi;
  - restore thì hiện lại;
  - delete khi chưa archive bị từ chối;
  - `confirm` sai bị từ chối;
  - delete thì không còn dòng nào nhắc tên dự án ở mọi bảng có cột dự án. Test tự liệt kê bảng có cột `project` từ `sqlite_master`, nên bảng mới sau này cũng phải được xử lý.
  - JSON (quyền, chính sách, hệ thống, trần chi tiêu) không còn dự án;
  - máy vẫn báo dự án đã xoá thì nó không sống lại;
  - backup chạy trước; backup lỗi thì không xoá.
- E2e web: lưu trữ một dự án tạm rồi xoá hẳn qua hộp thoại.

## Ràng buộc khi làm

- Không xoá gì trên hub thật. Ba dự án của người dùng sẽ do người merge xoá qua giao diện sau khi phát hành.
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
