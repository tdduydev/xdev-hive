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
- [x] **2e. cli-login-button** (yêu cầu 28/9): nút *Đăng nhập* trên thẻ gói chưa đăng nhập mở terminal (macOS Terminal, Windows `cmd`, Linux terminal đầu tiên tìm thấy) chạy script `0700` chỉ chứa thư mục đăng nhập và lệnh đăng nhập; quay lại cửa sổ app thì app kiểm lại. Đã thử mở Terminal thật trên macOS.
- [x] **3a. run-cost**: run Claude Code thêm `--output-format json` (profile tự chọn định dạng thì giữ), runner đọc câu trả lời cuối làm tóm tắt, `total_cost_usd` và token vào/ra, lưu vào runs.db; Board hiện chi phí từng run, thẻ Gói sub hiện tổng theo gói (ước tính theo giá API). Dải gói trên Board hiện cả "chưa đăng nhập". Sửa thêm cho mục 1: CLAUDE.md của worktree (cả `@AGENTS.md`) được nạp lại bằng `--add-dir` + `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, đã kiểm với Claude Code thật.
- [x] **3b. cost-on-hub**: heartbeat gửi chi phí các run đã xong chưa báo (máy đánh dấu sau khi hub trả lời; hub giữ bản đầu, xoá sau 90 ngày, migration 6); `costs.summary` và mục *Chi phí ước tính* trên Máy & run: tổng 24 giờ / 7 ngày / 30 ngày theo dự án và theo gói, lọc theo dự án người xem thấy. "Hôm nay" làm thành 24 giờ gần nhất để không phụ thuộc múi giờ của hub.
- [x] **3c. subscription-limits** (hỏi 28/9: hạn mức theo gói sub đã mua, không theo USD; cảnh báo ≥ 80%, dừng ở cả ngưỡng phiên và tuần; bỏ hạn mức USD theo dự án): app đọc `claude -p /usage` (không gọi model) cho từng profile đã đăng nhập, hiện % phiên/tuần và giờ reset trên Gói sub, Board, Máy & run; profile có *Dừng khi phiên đạt* (95%) và *Dừng khi tuần đạt* (90%), runner chuyển gói khi tới ngưỡng.
- [x] **4a. memory-last-used**: hub đếm số lần và lần cuối `memory_search` của agent trả về mỗi mục (migration 7); mục không dùng/ghi/giữ lại 90 ngày (`HIVE_MEMORY_STALE_DAYS`) thành *cũ*, agent không thấy nữa nhưng không bị xoá; trang Memory có lọc *Chỉ mục cũ*, nhãn *Cũ* và nút *Giữ lại* (`memory.keep`).
- [x] **4b. memory-citations**: `memory_write` nhận `files` (đường dẫn trong repo); app desktop mỗi 30 phút gửi mã object git của các file đó trên nhánh dự án (`memory.checkFiles`, migration 8): lần đầu làm mốc, đổi hay mất thì mục *Cần xem lại*, quay về thì hết; trang Memory hiện file và nút *Vẫn đúng* (lấy bản hiện tại làm mốc).
- [x] **4c. memory-links**: `memory_write` nhận `supersedes` / `contradicts` (cùng chủ, migration 9); agent chỉ thấy mục mới nhất của chuỗi (mục thay còn chờ duyệt thì mục cũ vẫn hiện), mục mâu thuẫn hiện cả hai kèm `conflictsWith` tới khi người quản trị chọn (`memory.resolve`: giữ mục này / mục kia / cả hai); xoá mục thay thì mục cũ hiện lại.
- [x] **5a. webhooks-hub** (hỏi 28/9: cả Teams và Slack, cấu hình trên trang Quản trị): tab *Webhook* cho admin hub (thêm/sửa/xoá/gửi thử; URL là bí mật, chỉ hiện dạng che); `SqliteHive` phát sự kiện (`onEvent`), hub gửi Adaptive Card (Teams Workflows) hoặc tin Slack cho đề xuất chờ duyệt, memory chờ duyệt, yêu cầu cài và kết quả; lọc theo sự kiện, dự án, ngôn ngữ.
- [ ] **5b. webhooks-runs**: app desktop báo run lỗi và MR mới lên hub, hub gửi qua cùng các webhook.
- [ ] **6. gitlab-ci-loop**: đọc pipeline của MR, gửi lỗi cho agent sửa, MR merge thì task chuyển sang Xong.
- [ ] **7. task-deps**: task phụ thuộc, tự mở khoá, gợi ý "task sẵn sàng tiếp theo".
- [ ] **8. scoped-docs**: tài liệu theo glob đường dẫn, sinh `.claude/rules` hoặc `AGENTS.md` lồng nhau, giữ `AGENTS.md` ngắn.
- [ ] **9. hybrid-search** [CẦN HỎI: model embedding chạy local hay qua API].
- [ ] **10. oidc-sso** [CẦN HỎI: GitLab, Entra hay Google].
- [ ] **11. container-runs** [CẦN HỎI: có dùng Docker cho run không].
- [ ] **12. best-of-n**: chạy 2–4 lần một task, chọn bản tốt nhất.
- [ ] **13. github-pr** [CẦN HỎI: team có dùng GitHub không].
