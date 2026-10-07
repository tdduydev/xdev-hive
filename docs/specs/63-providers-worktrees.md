# 63. providers-worktrees: thêm gói lập trình miễn phí, quản trị worktree

Ngày 7/10 bạn hỏi hai việc:
1. "Nghiên cứu thêm, add nhiều provider coding hơn, cái nào cho dùng miễn phí ấy, như GitHub Copilot."
2. "WF (worktree) chưa có phần quản trị, merge xong thì xoá đi cho đỡ đầy bộ nhớ."

Ngày 7/10, worktree của run đã chiếm 158 GB trên Mac mini (143 thư mục) và 37 GB trên .52 (61 thư mục). Mình đã dọn tay các worktree của task đã done.

## Provider

Nghiên cứu RES-providers (run R-edd0ac, artifact `report.md`, `sources.json`, `cli-probes.json` của task RES-providers; đọc bằng `artifact_get`) xếp thứ tự tích hợp: Gemini CLI → GitHub Copilot CLI → Mistral Vibe → OpenCode → Kilo. Mỗi provider có một mục "ĐỀ XUẤT TASK" (template agent, args headless, parser stream, usage và quota, login, cấp model cho bộ chọn 54c).

Không tích hợp:
- Qwen Code: gói OAuth miễn phí đã dừng.
- Kiro CLI: chạy headless cần API key trả phí.
- Cursor CLI: chưa tải được bản để kiểm (403).

Mỗi provider (63a–63e) làm đủ như các loại đã có (claude, codex, antigravity):
- Loại agent và template.
- Lệnh headless và thứ tự tham số.
- Parser output (stream nếu có, tóm tắt cuối, token).
- Đọc usage và quota nếu provider cho, bằng không ghi rõ là không có.
- *Đăng nhập* trong app (device flow, OAuth hay key do người dùng nhập; nhiều tài khoản bằng thư mục cấu hình riêng nếu provider hỗ trợ).
- MCP xdev-hive cho agent.
- Tool trong danh mục (cài và kiểm phiên bản).
- Cấp model cho bộ chọn 54c (light / standard / strong).
- Quyền ghi và sandbox tương đương `acceptEdits` hoặc `workspace-write`.
- Test bằng fake-agent, không gọi provider thật.
- Mục trong README.

Điều khoản hay giới hạn gói miễn phí chưa rõ thì trang cài đặt ghi rõ và link nguồn.

## 63f. worktree-admin

Quản trị worktree của run.

- *Máy & agent* › máy › *Worktree*: danh sách worktree theo service. Mỗi dòng có task (trạng thái), branch, dung lượng, lần sửa cuối, có thay đổi chưa commit không, branch đã vào main chưa. Có tổng dung lượng và dung lượng ổ còn trống.
- Nút *Xoá*, xoá được nhiều dòng một lúc. Có cảnh báo khi worktree còn thay đổi chưa commit hoặc branch chưa vào main. Không xoá được khi task đang có run. Branch giữ lại; mở lại task thì runner tạo lại worktree từ branch.
- Tự dọn (cài đặt máy, mặc định bật): worktree của task `done` mà branch đã vào main (hoặc task đã done quá N ngày) được xoá sau khi task đóng. Đĩa còn dưới ngưỡng thì dọn từ cũ nhất trong các worktree đủ điều kiện. Nhật ký ghi mỗi lần dọn.
- `node_modules` trong worktree: dùng chung (hardlink hay symlink từ checkout chính) khi lockfile giống nhau, để mỗi worktree không giữ bản riêng, nếu làm được an toàn [chưa kiểm chứng: npm workspaces với symlink].
- Hub nhận số liệu worktree qua heartbeat để trang web hiện. Lệnh xoá đi qua máy như 58b (người có quyền máy).
