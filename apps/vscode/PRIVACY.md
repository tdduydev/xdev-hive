# Quyền riêng tư — xDev Hive cho VS Code

Ngày cập nhật: 15/10/2026. Phạm vi: extension `xdev.xdev-hive`. Bản đầu đang chuẩn bị phát hành; các luồng MCP, model và đồng bộ mô tả hành vi yêu cầu khi được tích hợp.

## Tiếng Việt

**Không telemetry.** Extension không gửi thống kê sử dụng, mã định danh phân tích hoặc báo cáo lỗi tự động tới xDev. Log chẩn đoán nằm tại máy trong Output **xDev Hive**, được che token trước khi ghi. Việc chia sẻ log là do bạn quyết định; hãy xem lại trước khi chia sẻ.

**Hub do bạn chọn.** Dữ liệu nghiệp vụ (câu lệnh, mã được chọn, diff, bình luận, công việc và dữ liệu của run) chỉ được gửi tới hub bạn cấu hình khi thao tác cần dữ liệu đó. Hub áp dụng quyền tổ chức và chính sách lưu giữ của đơn vị vận hành; hỏi quản trị viên về quyền truy cập, lưu giữ, xuất và xoá dữ liệu. Extension không gửi dữ liệu nghiệp vụ sang một dịch vụ phân tích riêng của xDev.

**Model của editor.** Nội dung chỉ được gửi tới model ngôn ngữ của editor khi bạn chủ động gõ lệnh `@hive` sử dụng model; extension che bí mật trước khi gửi. Cơ chế che không bảo đảm phát hiện mọi bí mật: xem lại mã và diff trước khi gửi. Nhà cung cấp model có chính sách xử lý dữ liệu và điều kiện sử dụng riêng. Không có model thì dùng luồng dự phòng qua hub hoặc nội dung nguyên văn phù hợp với lệnh.

**Đăng nhập và lưu token.** Trình duyệt đăng nhập với hub qua PKCE và callback loopback. CLI lưu token trong keychain hệ điều hành; extension có bản lưu trong `SecretStorage` của VS Code để khôi phục phiên, và dùng SecretStorage khi không có CLI. Token không được ghi vào settings, file MCP hoặc webview. Đăng xuất editor xoá phiên/bản lưu của editor; muốn ngắt cả CLI/desktop, chọn đăng xuất chung hoặc thu hồi token tại hub. Gỡ extension không thay thế việc thu hồi token.

**Cấu hình MCP.** Sau khi được bạn xác nhận, extension có thể thêm mục `xdev-hive` vào `~/.claude.json` (hoặc qua `claude mcp add --scope user`), `~/.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`. Các mục chỉ chứa lệnh CLI và đối số `mcp`, không chứa token; CLI đọc keychain. Dùng **Gỡ Hive MCP** hoặc xoá riêng mục đó trong `mcpServers` để gỡ. Giữ nguyên cấu hình server khác. VS Code dùng API MCP; token HTTP được gắn trong bộ nhớ khi kết nối, không ghi vào file cấu hình.

**Các kết nối khác.** Việc tải CLI/worker truy cập dịch vụ phát hành, kiểm checksum và chữ ký. Marketplace/Open VSX, editor và nhà cung cấp model có kết nối và chính sách riêng. Nếu bật đồng bộ PR, hub gửi/nhận bình luận với GitHub/GitLab qua kết nối Git của tổ chức; dữ liệu đó chịu chính sách của tổ chức và nhà cung cấp Git. Đây không phải telemetry của extension.

**Tại máy và Remote.** Các tiện ích tại máy xử lý file dự án; kết quả chỉ gửi ra khi bạn dùng thao tác yêu cầu hub hoặc model. Worker chạy tại máy có mã nguồn; SSH/WSL dùng máy remote đăng ký riêng. Restricted Mode chặn thao tác yêu cầu chạy tiến trình hoặc ghi cấu hình. Worker không tự khởi động mặc định. Quản trị viên hub là đầu mối cho yêu cầu dữ liệu tổ chức; lỗi extension có thể báo qua kênh hỗ trợ trên trang sản phẩm https://xdev.asia/hive/.

## English

**No telemetry.** The extension collects no usage analytics or automatic crash reports. Diagnostic logs stay in the local **xDev Hive** Output channel, with tokens redacted before logging. Review logs before choosing to share them.

**Your hub.** Business data, including prompts, selected code, diffs, comments, tasks and run data, is sent only to the hub you configure when the requested operation needs it. Your hub operator controls organizational access and retention; contact that operator for access, export or deletion requests. The extension sends no business data to a separate xDev analytics service.

**Editor models.** Content is sent to an editor language model only when you explicitly invoke an `@hive` command using that model. Secrets are redacted first, but redaction may miss sensitive content. Review code before sending it. Your model provider's terms and data policy also apply. When no model is available, the relevant action can use the hub or your original text instead.

**Credentials.** Browser login uses PKCE and a loopback callback. The CLI stores tokens in the OS keychain. The extension also keeps a VS Code SecretStorage copy for session restoration, and uses SecretStorage when the CLI is unavailable. Tokens are not written into settings, MCP files or webviews. Editor sign-out removes the editor session/copy; use shared sign-out or hub revocation to end CLI/desktop access too. Uninstalling is not token revocation.

**MCP files.** With your confirmation, configuration can be added through `claude mcp add --scope user` or to `~/.claude.json`, `~/.cursor/mcp.json` and `~/.codeium/windsurf/mcp_config.json`. Only CLI commands and `mcp` arguments are stored, never tokens. Remove the extension-managed `xdev-hive` entry using **Remove Hive MCP**, or remove that entry from `mcpServers` manually, preserving other servers. VS Code's HTTP MCP token is attached in memory at connection time.

**Other services and local processing.** Binary downloads contact release services and verify checksums and signatures. Your editor, Marketplace/Open VSX and model provider have their own policies. Optional PR synchronization runs on the hub through your organization's GitHub/GitLab connection. Local tools process project files locally unless you request a hub/model action. Workers run where the source code lives; SSH/WSL machines are registered separately. Worker auto-start is off by default. Contact your hub administrator for organizational data requests, or use the product support information at https://xdev.asia/hive/ for extension issues.
