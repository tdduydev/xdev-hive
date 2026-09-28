# Roadmap

Làm lần lượt, mỗi lượt một mục (mỗi mục một PR). Mục có **[CẦN HỎI]** chờ quyết định trước khi làm; câu trả lời ghi ngay dưới mục.

## 0. Đa ngôn ngữ (tiếng Việt, tiếng Anh; thêm ngôn ngữ = thêm một file dịch)

- [x] **0a. i18n-core**: bộ dịch `packages/ui/src/i18n` (vi là nguồn key, TypeScript bắt các ngôn ngữ khác dịch đủ), chọn ngôn ngữ ở trang đăng nhập và menu tài khoản, ngày giờ theo ngôn ngữ; đã dịch khung app, đăng nhập, đổi mật khẩu, menu tài khoản, bộ chọn phạm vi, diff.
- [x] **0b. i18n-pages-1**: Tổng quan, Tài liệu, Đề xuất, Memory, Task; thêm nhóm chuỗi dùng chung (trạng thái task/đề xuất/run, loại memory, vai trò agent, phần cài đặt) để các trang sau dùng lại.
- [x] **0c. i18n-pages-2**: Board, Gói sub & agent, Máy & run, Cài đặt máy, Dự án & cài đặt; `rich()` chèn thẻ (code, link) vào câu đã dịch; smoke chụp được giao diện tiếng Anh (`HIVE_SMOKE_LOCALE=en`) và không còn thoát im lặng khi app thật đang mở.
- [x] **0d. i18n-pages-3**: Quản trị, Người dùng & quyền, Token; nhật ký hiện tên thao tác cho cả đăng nhập, tài khoản, phân quyền và lần nhập từ Forge. Toàn bộ chuỗi giao diện trong `packages/ui` giờ nằm trong catalog.
- [x] **0e1. i18n-errors**: lỗi của hub và core mang `key` + `vars` (`HiveError`, JSON lỗi của hub, IPC desktop, `HubBackend`), giao diện dịch theo catalog `errors.*`; agent/MCP vẫn nhận message cũ. Test quét mã nguồn để chắc mọi key lỗi có trong catalog.
- [ ] **0e2. i18n-desktop**: tiến trình chính của app desktop theo ngôn ngữ đã chọn: menu tray, thông báo, hộp thoại, nhãn các mục ở Cài đặt máy, lỗi runner/GitLab/cài đặt; chi tiết nhật ký do hub ghi; nhãn mẫu profile mặc định trong core.

## Tính năng

- [ ] **1. runner-hardening**: `claude -p` không chạy hook và `.mcp.json` của repo: `--settings '{"disableAllHooks":true}'`, `--setting-sources user`, `--mcp-config` do app sinh (hive-mcp, codegraph). Codex giữ sandbox `workspace-write`.
- [ ] **2. content-safety**: chặn ký tự ẩn (bidi, zero-width) khi ghi docs, memory, proposal. Lưu nguồn mỗi lần ghi (máy, run, task). Token chỉ-đọc cho agent.
- [ ] **3. cost-tracking**: `total_cost_usd` theo run, profile, dự án. Hiện trên Board và Máy & run. Hạn mức theo dự án.
- [ ] **4. memory-freshness**: `lastUsedAt`, hết hạn khi lâu không dùng, trích dẫn file để kiểm lại, liên kết supersedes/contradicts thay vì xoá.
- [ ] **5. webhooks**: Slack/Teams cho đề xuất chờ duyệt, run lỗi, MR mới, yêu cầu cài.
- [ ] **6. gitlab-ci-loop**: đọc pipeline của MR, gửi lỗi cho agent sửa, MR merge thì task chuyển sang Xong.
- [ ] **7. task-deps**: task phụ thuộc, tự mở khoá, gợi ý "task sẵn sàng tiếp theo".
- [ ] **8. scoped-docs**: tài liệu theo glob đường dẫn, sinh `.claude/rules` hoặc `AGENTS.md` lồng nhau, giữ `AGENTS.md` ngắn.
- [ ] **9. hybrid-search** [CẦN HỎI: model embedding chạy local hay qua API].
- [ ] **10. oidc-sso** [CẦN HỎI: GitLab, Entra hay Google].
- [ ] **11. container-runs** [CẦN HỎI: có dùng Docker cho run không].
- [ ] **12. best-of-n**: chạy 2–4 lần một task, chọn bản tốt nhất.
- [ ] **13. github-pr** [CẦN HỎI: team có dùng GitHub không].
