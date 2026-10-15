# xDev Hive cho VS Code

Kết nối công việc, agent và tri thức của đội ngay trong editor. Extension có ID `xdev.xdev-hive`, dành cho VS Code desktop **1.101 trở lên** và các editor tương thích như Cursor, Windsurf, VSCodium.

**Bạn cần hub xDev Hive của tổ chức để dùng tính năng cộng tác.** Cài extension không tạo hub hoặc tài khoản AI. Hỏi quản trị viên URL hub và quyền tham gia tổ chức. Có thể để trống hub để dùng phần tại máy khi các tính năng đó được tích hợp.

Bản `0.1.0` đang chuẩn bị phát hành. Đăng nhập và quản lý worker đã có; chat, MCP, các màn nghiệp vụ và tiện ích tại máy còn chờ tích hợp. Bảng dưới mô tả phạm vi bản đầu sau khi hoàn tất tích hợp, không phải cam kết mọi lệnh đã hoạt động trong bản phát triển.

## Tính năng và điều kiện

| Tính năng | Chạy tại máy, không cần hub | Cần hub |
| --- | --- | --- |
| Tối ưu token, quét memory, dựng và chép context pack | Có; cần CLI tương thích | Không |
| Tóm tắt diff, review sơ bộ bằng model của editor | Có; cần model và quyền sử dụng của editor | Không |
| Việc của tôi, chờ duyệt, run và hàng merge | Không | Có; cần đăng nhập và quyền phù hợp |
| Chat `@hive`, giao việc và Leader | Không, trừ thao tác sơ bộ tại máy | Có; công việc agent chạy qua hub/worker |
| Review chính thức, bình luận theo dòng, đồng bộ PR | Không | Có; đồng bộ GitHub/GitLab cần kết nối Git của dự án |
| SDLC, tài liệu, memory dùng chung và artifact | Không | Có |
| Hive MCP cho agent | Cấu hình nằm tại máy | Có, để truy cập dữ liệu Hive |
| Worker chạy việc Hive | Binary chạy tại máy | Có; máy phải đăng ký |

## Bắt đầu

1. Mở Command Palette, chọn **xDev Hive: Nhập URL hub** và nhập URL quản trị viên cung cấp. Có thể đặt `xdevHive.hubUrl` trong cài đặt người dùng. Dùng HTTPS khi hub không nằm trên máy của bạn.
2. Chọn **Đăng nhập xDev Hive**. Trình duyệt mở trang đăng nhập của hub; đăng nhập và chọn tổ chức rồi trở lại editor. Token được lưu trong keychain qua CLI và `SecretStorage` của VS Code. Không dán token vào settings hoặc file trong dự án.
3. Bật Hive MCP cho công cụ bạn dùng theo bảng dưới. Không cần cài mọi công cụ.
4. Chọn **Cài hive CLI và worker**, sau đó đăng ký máy với hub theo hướng dẫn quản trị viên. Worker không tự khởi động mặc định; chỉ bật `xdevHive.worker.autoStart` khi bạn muốn máy nhận việc.

Extension tải binary khi cần và kiểm chữ ký cùng checksum; không gói binary trong VSIX. Nếu không tải được bản phát hành, hỏi quản trị viên cách cung cấp binary và đặt `xdevHive.binPath` tới thư mục tin cậy chứa chúng. Không tải binary từ liên kết lạ.

Khi đã đăng nhập, mở biểu tượng xDev Hive ở thanh bên để xem việc và trạng thái máy. Nếu phiên hết hạn, đăng nhập lại. Để ngắt phiên của editor, dùng **Đăng xuất xDev Hive**; việc thu hồi token dùng chung với CLI/desktop cần thao tác đăng xuất chung hoặc thu hồi trên hub.

## Hive MCP cho từng công cụ

| Công cụ | Cách kết nối sau khi tích hợp |
| --- | --- |
| VS Code / Copilot | Hive MCP được extension đăng ký qua API MCP của editor. Mặc định HTTP tới `{hub}/mcp`, token chỉ gắn trong bộ nhớ khi kết nối. Chọn `xdevHive.mcp.transport = stdio` nếu muốn dùng `hive mcp`. |
| Claude Code | Chạy **Thêm Hive MCP cho Claude Code**; dùng cấu hình người dùng qua `claude mcp add`, hoặc `~/.claude.json` khi không có lệnh `claude`. |
| Cursor | Chạy **Thêm Hive MCP cho Cursor**; dùng cấu hình `~/.cursor/mcp.json`. |
| Windsurf | Chạy **Thêm Hive MCP cho Windsurf**; dùng cấu hình `~/.codeium/windsurf/mcp_config.json`. |

Cấu hình ngoài VS Code chỉ chứa đường dẫn CLI và đối số `mcp`, không chứa token. CLI lấy token từ keychain. Extension hỏi trước khi ghi và giữ cấu hình server khác. Dùng **Gỡ Hive MCP** để gỡ mục đã thêm; nếu gỡ thủ công, chỉ xoá khoá `xdev-hive` trong `mcpServers`, giữ nguyên các server khác. Gỡ extension không tự xoá cấu hình của công cụ khác.

## Remote và Workspace Trust

- Remote SSH và WSL: worker chạy ở máy có mã nguồn. Đăng ký máy remote riêng với hub; cài CLI và cấu hình đường dẫn ở phía remote. Không dùng đăng ký của máy giao diện thay cho máy remote.
- Máy đã có desktop giữ worker: extension dùng worker đang chạy, không khởi động bản thứ hai. Worker do VS Code khởi động sống theo cửa sổ giữ nó.
- Dev Container không chạy worker. Bản đầu chưa hỗ trợ vscode.dev, github.dev và Codespaces.
- Restricted Mode giới hạn các thao tác chạy tiến trình và ghi cấu hình. Chỉ cấp Workspace Trust cho mã nguồn bạn tin cậy.
- Khả năng Chat/Language Model/MCP phụ thuộc editor. Nếu không có model, dùng nội dung gốc khi giao việc hoặc nhờ hub review; chat dự phòng dùng Leader qua hub sau khi tích hợp.

## Quyền riêng tư và hỗ trợ

Extension **không thu telemetry**. Dữ liệu nghiệp vụ gửi tới hub bạn cấu hình. Chỉ gửi nội dung tới model của editor khi bạn chủ động dùng lệnh `@hive`, với bước che bí mật; vẫn xem lại đoạn mã trước khi gửi. Cài binary có thể truy cập dịch vụ phát hành; đồng bộ PR được hub thực hiện qua kết nối Git của tổ chức.

Đọc chính sách đầy đủ trong **PRIVACY.md** đi kèm VSIX (tiếng Việt và tiếng Anh). Giấy phép riêng nằm trong **LICENSE**, bản dự thảo đang chờ chủ dự án duyệt trước phát hành. Extension miễn phí để dùng cùng hub xDev Hive theo giấy phép được duyệt; quyền sử dụng model do nhà cung cấp model quyết định.

Xem [trang xDev Hive](https://xdev.asia/hive/) để tìm thông tin sản phẩm. Với lỗi đăng nhập, quyền hoặc hub, liên hệ quản trị viên tổ chức. Mở **xDev Hive: Mở nhật ký** để xem log tại máy đã che token; xem lại log trước khi chia sẻ và không gửi mật khẩu, token hoặc mã nguồn nhạy cảm.

## English

xDev Hive connects your editor to your team's Hive hub. VS Code desktop 1.101+ is required. Collaboration, shared knowledge, MCP data and agent runs require your organization's hub and an authorized account. Local tools need a compatible CLI; editor model features need an available model. Version 0.1.0 is in preparation: chat, MCP, business views and local tools await integration.

Configure the hub URL, sign in through your browser, enable MCP for your tool, then install and register a worker only if this machine should run jobs. Remote SSH/WSL use a separately registered remote machine. Worker auto-start is off by default. No telemetry is collected. Read the bundled PRIVACY.md and LICENSE before use; the proprietary license draft awaits owner approval.
