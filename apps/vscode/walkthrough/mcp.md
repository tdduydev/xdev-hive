# 3. Bật Hive MCP

MCP cho agent truy cập memory, tài liệu và công việc trên hub theo quyền của bạn. Cần hub và đăng nhập; cấu hình nằm tại máy không có nghĩa dữ liệu Hive dùng được ngoại tuyến. Phần MCP đang chờ tích hợp vào bản phát hành.

VS Code/Copilot dùng API MCP của editor, mặc định HTTP tới `{hub}/mcp`. Muốn dùng CLI stdio, đặt `xdevHive.mcp.transport` thành `stdio` và cài CLI.

Chọn đúng công cụ bạn đang dùng:

- [Thêm Hive MCP cho Claude Code](command:xdevHive.mcp.addClaudeCode)
- [Thêm Hive MCP cho Cursor](command:xdevHive.mcp.addCursor)
- [Thêm Hive MCP cho Windsurf](command:xdevHive.mcp.addWindsurf)

Extension hỏi trước khi ghi cấu hình. File MCP chỉ chứa lệnh `hive mcp`, không có token; CLI lấy token từ keychain. Không chia sẻ keychain hoặc token cho agent.

[Gỡ Hive MCP](command:xdevHive.mcp.remove) khi không cần nữa. Nếu gỡ thủ công, chỉ xoá mục `xdev-hive` trong `mcpServers` của công cụ; giữ server khác.

## English

Hive MCP needs a hub and an authenticated account. Choose the command for your tool. External MCP files contain CLI commands only, never tokens. VS Code attaches HTTP credentials in memory. Remove the managed MCP entry when no longer needed. MCP integration is pending in this development build.
