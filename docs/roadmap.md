# Roadmap

Làm lần lượt, mỗi lượt một mục (mỗi mục một PR). Mục có **[CẦN HỎI]** chờ quyết định trước khi làm; câu trả lời ghi ngay dưới mục.

## 0. Đa ngôn ngữ (tiếng Việt, tiếng Anh; thêm ngôn ngữ = thêm một file dịch)

- [x] **0a. i18n-core**: bộ dịch `packages/ui/src/i18n` (vi là nguồn key, TypeScript bắt các ngôn ngữ khác dịch đủ), chọn ngôn ngữ ở trang đăng nhập và menu tài khoản, ngày giờ theo ngôn ngữ; đã dịch khung app, đăng nhập, đổi mật khẩu, menu tài khoản, bộ chọn phạm vi, diff.
- [x] **0b. i18n-pages-1**: Tổng quan, Tài liệu, Đề xuất, Memory, Task; thêm nhóm chuỗi dùng chung (trạng thái task/đề xuất/run, loại memory, vai trò agent, phần cài đặt) để các trang sau dùng lại.
- [x] **0c. i18n-pages-2**: Board, Gói sub & agent, Máy & run, Cài đặt máy, Dự án & cài đặt; `rich()` chèn thẻ (code, link) vào câu đã dịch; smoke chụp được giao diện tiếng Anh (`HIVE_SMOKE_LOCALE=en`) và không còn thoát im lặng khi app thật đang mở.
- [x] **0d. i18n-pages-3**: Quản trị, Người dùng & quyền, Token; nhật ký hiện tên thao tác cho cả đăng nhập, tài khoản, phân quyền và lần nhập từ Forge. Toàn bộ chuỗi giao diện trong `packages/ui` giờ nằm trong catalog.
- [x] **0e1. i18n-errors**: lỗi của hub và core mang `key` + `vars` (`HiveError`, JSON lỗi của hub, IPC desktop, `HubBackend`), giao diện dịch theo catalog `errors.*`; agent/MCP vẫn nhận message cũ. Test quét mã nguồn để chắc mọi key lỗi có trong catalog.
- [x] **0e2a. i18n-desktop-shell**: tiến trình chính desktop biết ngôn ngữ giao diện (renderer báo qua IPC, lưu `locale` trong config.json): menu tray, tooltip, thông báo (run, đề xuất, yêu cầu cài), hộp thoại lỗi cấu hình, lỗi của `index.ts` mang key.
- [x] **0e2b. i18n-desktop-setup**: nhãn, mô tả và nút ở Cài đặt máy (`setup.ts`), ghi chú cài cấu hình agent (`installer.ts`) và đồng bộ tài liệu (`sync.ts`) theo ngôn ngữ giao diện; đổi ngôn ngữ thì kiểm tra lại để nhãn đổi theo. `main/i18n.ts` dùng chung cho tiến trình chính.
- [x] **0e2b2. i18n-desktop-runner**: lỗi và ghi chú của runner, lịch chạy, worktree, GitLab trên Board theo ngôn ngữ giao diện (lỗi ném ra mang key, ghi chú lưu vào run dùng `tr()`); giữ nguyên ghi chú bàn giao task và mô tả MR vì là dữ liệu của team.
- [x] **0e2c. i18n-core-texts**: nhật ký lưu thêm `detail_key` + `detail_vars` (migration), trang Quản trị hiện chi tiết theo ngôn ngữ người xem (mục cũ vẫn hiện chữ đã lưu); nhãn mẫu profile mặc định không còn gắn tiếng Việt.

## Tính năng

- [x] **1. runner-hardening**: run Claude Code thêm `--settings '{"disableAllHooks":true}' --setting-sources user --strict-mcp-config --mcp-config` do app sinh (xdev-hive, codegraph và superpowers nếu checkout chính bật); commit của runner không chạy git hook và không đưa tài liệu render vào; prompt bảo agent đọc `AGENTS.md` trước. Codex giữ sandbox `workspace-write`.
- [x] **2a. hidden-chars**: hub từ chối docs, đề xuất, memory có ký tự ẩn (bidi, tag, bộ chọn biến thể, độ rộng 0; emoji vẫn được), lỗi báo mã ký tự + dòng + cột; trang Tài liệu và Memory cảnh báo trước khi lưu, có nút xoá. Dữ liệu trên .52 không có ký tự ẩn nào.
- [x] **2b. write-provenance**: phiên bản tài liệu, đề xuất và memory lưu nguồn ghi (kênh do hub quyết: web/desktop/mcp/api; máy, run, task do client báo, `hive-mcp` đọc `HIVE_RUN`/`HIVE_TASK`, run Claude Code luôn có), hiện cạnh người ghi; memory không ghi task thì lấy task của run.
- [x] **2c. read-only-agent-token** (hỏi 28/9: làm cả hai hướng): token `viewer` qua MCP chỉ thấy tool đọc (memory_search, doc_list, doc_get, task_list); profile desktop có *Chỉ đọc Hive*, runner đặt `HIVE_READONLY=1` (Claude Code luôn nhận qua cấu hình MCP của app), `hive-mcp` chỉ mở tool đọc, prompt bỏ bước ghi. Không phải ranh giới bảo mật cứng.
- [x] **2d. cli-status** (yêu cầu 28/9): app kiểm đăng nhập từng profile (`claude auth status --json`, `codex login status` với env của profile; lúc mở, mỗi 10 phút, khi sửa profile, khi bấm *Kiểm tra CLI*), runner bỏ qua gói chưa đăng nhập, thẻ Gói sub hiện trạng thái và lệnh đăng nhập; heartbeat báo `loggedIn`, trang Máy & run và Quản trị hiện từng gói: tắt / chưa có CLI / chưa đăng nhập / nghỉ đến giờ nào / sẵn sàng. Quota còn lại thì CLI không cho đọc; trang Cài đặt máy chưa đổi.
- [ ] **2e. cli-login-button** (yêu cầu 28/9): nút *Đăng nhập* trên thẻ Gói sub mở Terminal (macOS Terminal, Windows cmd, Linux terminal mặc định) chạy sẵn lệnh đăng nhập của profile (kèm `CLAUDE_CONFIG_DIR`/`CODEX_HOME`); app kiểm lại đăng nhập khi cửa sổ app được focus lại.
- [x] **3a. run-cost**: run Claude Code thêm `--output-format json` (profile tự chọn định dạng thì giữ), runner đọc câu trả lời cuối làm tóm tắt, `total_cost_usd` và token vào/ra, lưu vào runs.db; Board hiện chi phí từng run, thẻ Gói sub hiện tổng theo gói (ước tính theo giá API). Dải gói trên Board hiện cả "chưa đăng nhập". Sửa thêm cho mục 1: CLAUDE.md của worktree (cả `@AGENTS.md`) được nạp lại bằng `--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, đã kiểm với Claude Code thật.
- [ ] **3b. cost-on-hub**: heartbeat báo chi phí các run đã xong; trang Máy & run hiện tổng theo dự án và gói (hôm nay, 7 ngày, 30 ngày).
- [ ] **3c. project-budget** [CẦN HỎI: vượt hạn mức thì chặn run mới hay chỉ cảnh báo; hạn mức theo ngày hay theo tháng].
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
