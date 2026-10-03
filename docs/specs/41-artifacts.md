# 41. Giữ lại những gì agent làm ra

Viết ngày 3/10. Người dùng hỏi: hệ thống có phải lưu cả những gì AI tạo ra làm tài liệu không, "lỡ sau này quên". Ngày 3/10 họ chọn làm cả bốn mục (41a–d), và nhật ký của 41d ghi ở **cấp hệ thống**.

## Hiện trạng (main 3358ba7)

| Thứ agent làm ra | Lưu ở đâu | Mất không |
|---|---|---|
| Tóm tắt, log, diff của run (bàn giao, kết luận review, kết quả đo) | `run_records` trên hub | Xoá cả dòng sau 30 ngày (`RUN_RECORD_DAYS`, `packages/core/src/sqlite.ts:580`, xoá ở `:4635`) |
| Ghi chú bàn giao trên task | cột `tasks.note`, tối đa 2000 ký tự | `tasks.update` ghi đè (`sqlite.ts:4449-4470`, `note = COALESCE(?, note)`), không có lịch sử |
| File agent làm ra (ảnh smoke, báo cáo, kết quả đo, `docs/plans/<task>.md`) | worktree hay branch trên máy chạy | Không lên Hive; branch xoá là mất |
| Memory | bảng `memory` | Không xoá, nhưng ẩn với agent sau 90 ngày không dùng (`HIVE_MEMORY_STALE_DAYS`) |
| Tài liệu Hive và file đính kèm | `doc_versions`, `doc_assets` + SeaweedFS (`BlobStore`, `packages/core/src/blobs.ts`) | Không mất |

Ví dụ ngày 3/10: kết quả đo skill/rules của R-38a và cách kiểm `/mcp` của R-38b chỉ nằm trong tóm tắt run. Nếu không ai chép vào memory, sau 30 ngày chúng mất hẳn.

## Nguyên tắc chung

- Không lưu secret. Chữ đi qua `redactLines` (`packages/core/src/secrets.ts`) và chặn ký tự ẩn (`assertNoHidden`, `packages/core/src/hidden.ts`) như tài liệu và memory.
- Quyền đọc theo dự án như task và run. Hệ thống thì theo quyền trên các service của nó, như tài liệu hệ thống (19c).
- Mọi thứ ghi lại đều có nguồn (2b): máy, run, task, agent.
- Dữ liệu cũ vẫn đọc được. Migration không xoá gì đang có.
- Agent không tăng version, không đánh dấu roadmap.

Thứ tự:

```
41a   41b   41c
  \          |
   └── 41d ──┘
```

## R-41a. Lịch sử ghi chú task

- Mỗi lần `tasks.update` có `note` (cả `tasks.create` kèm note, nếu có), giữ thêm một phiên bản trong bảng mới (ví dụ `task_notes`: task, phiên bản, note, trạng thái lúc đó, ai, nguồn, lúc nào). Cột `tasks.note` vẫn là bản mới nhất, nên mọi chỗ đang đọc nó không đổi.
- Method đọc lịch sử, ví dụ `tasks.notes({ id })`. Tool MCP `task_list` (hay một tool mới) cho agent đọc được vài bản gần nhất khi cần.
- Panel task trên web (`TaskDetail`, `packages/ui/src/pages/Tasks.tsx:418`) có mục *Lịch sử ghi chú*: các bản theo thời gian, xem diff hai bản liền nhau.
- Chuyển trạng thái mà không có note thì không tạo phiên bản (nhật ký đã ghi việc chuyển).
- **Xong khi**: test core cho ba lần cập nhật, đọc đủ 3 bản theo thứ tự, bản mới nhất trùng `tasks.note`; e2e web mở panel thấy lịch sử.

## R-41b. Giữ tóm tắt run vĩnh viễn

- Thay việc xoá cả dòng `run_records` sau 30 ngày bằng: sau `RUN_RECORD_DAYS` chỉ xoá `log` và `patch` (phần nặng). Các trường còn lại giữ mãi: summary, error, role, profile, branch, commits, MR, merge, chi phí, các bước, người yêu cầu.
- Trang *Lượt chạy* trên web và `run_get` của MCP vẫn mở được run cũ, ghi rõ "log đã dọn sau 30 ngày".
- Có thể tắt hay đổi số ngày bằng biến môi trường (mặc định 30); ghi vào README phần biến của hub.
- **Xong khi**: test core cho run cũ hơn 30 ngày còn summary và MR, mất log và patch; run mới không đổi.

## R-41c. Kho artifact

- Agent lưu file mình làm ra vào `.xdev-hive/artifacts/` trong worktree (ảnh, báo cáo, kết quả đo, bản plan). Prompt của run nói điều này. Thư mục nằm ngoài commit như context của 38a.
- Run xong, runner đẩy các file đó lên hub, gắn với run và task. Giới hạn: tối đa 20 file, mỗi file 5 MB (như `DOC_ASSET_MAX_BYTES`); file thừa thì ghi vào log. Hub lưu file trên SeaweedFS (`BlobStore`) theo sha256 như `doc_assets`, kèm metadata (tên, loại, cỡ, run, task, dự án, nguồn).
- File chữ (md, txt, json, log) đi qua `redactLines` và chặn ký tự ẩn trước khi lưu. File nhị phân chỉ nhận loại an toàn (png, jpg, webp, pdf).
- Method: `artifacts.list({ project, taskId?, runId? })`, `artifacts.get({ id })`. Tool MCP `artifact_list` / `artifact_get` cho agent đọc lại (ảnh trả về dạng image như `doc_asset`).
- Web: panel task và chi tiết run có mục *Artifact* (xem ảnh, tải file).
- Artifact không tự xoá. Quản trị dự án xoá được (ghi nhật ký).
- **Xong khi**: test runner (file trong `.xdev-hive/artifacts/` được đẩy, không vào commit, file quá cỡ bị bỏ kèm dòng log); test hub (lưu, đọc, quyền theo dự án, chữ giống secret bị che); test MCP; e2e web thấy artifact của một run.

## R-41d. Nhật ký hệ thống từ task xong

- Khi một task chuyển sang *done*, hub thêm một mục vào trang nhật ký:
  - service thuộc hệ thống: `system/<hệ thống>/nhat-ky-<YYYY-MM>`, nằm trong thư mục `system/<hệ thống>/nhat-ky` (tạo nếu chưa có);
  - repo lẻ: `project/<dự án>/nhat-ky-<YYYY-MM>`.
- Một mục gồm:
  - ngày, service, mã và tiêu đề task;
  - phần "đã làm" và "rủi ro" của bàn giao cuối (bản mới nhất ở 41a, cắt gọn);
  - MR/PR và commit merge nếu có;
  - run cuối và link artifact (41c).
  Mục mới lên đầu trang.
- Trang không vào AGENTS.md (`includeInAgents: false`). Agent tìm bằng `doc_list` / `doc_get`. Trang hệ thống *Tổng quan* có một dòng chỉ tới thư mục nhật ký.
- Hub ghi bằng tên `hub`, ghi chú phiên bản "Nhật ký: <task>". Mục đã có cho task đó thì cập nhật, không thêm trùng (task mở lại rồi xong lần nữa thì thêm một dòng mới).
- **Xong khi**: test core cho một task của service trong hệ thống và một task của repo lẻ: trang đúng chỗ, mục đúng nội dung, không trùng; chữ giống secret bị che.
- Phụ thuộc 41a (bàn giao cuối) và 41c (link artifact).
