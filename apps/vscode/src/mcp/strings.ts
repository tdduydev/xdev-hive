import { addStrings } from "@/lib/i18n.ts";

addStrings(
  {
    "mcp.noBinary": "Chưa tìm thấy hive. Hãy cài CLI Hive trước khi cấu hình MCP.",
    "mcp.confirm": "Thêm Hive MCP cho {tool}? Cấu hình chỉ chứa lệnh hive mcp, không lưu token.",
    "mcp.accept": "Thêm cấu hình",
    "mcp.done": "Đã thêm Hive MCP cho {tool}.",
    "mcp.failed":
      "Không thể cập nhật cấu hình MCP. Hãy kiểm tra file cấu hình và quyền ghi; cấu hình hiện có được giữ lại.",
    "mcp.remove": "Chọn công cụ cần gỡ cấu hình Hive MCP",
    "mcp.removed": "Đã gỡ cấu hình Hive MCP cho {tool}.",
    "mcp.removeConfirm": "Gỡ cấu hình Hive MCP cho {tool}?",
    "mcp.removeAccept": "Gỡ cấu hình",
    "mcp.untrusted": "Hãy tin cậy workspace trước khi cấu hình MCP cho công cụ khác.",
  },
  {
    "mcp.noBinary": "Hive CLI was not found. Install it before configuring MCP.",
    "mcp.confirm": "Add Hive MCP to {tool}? The configuration contains only hive mcp, never a token.",
    "mcp.accept": "Add configuration",
    "mcp.done": "Hive MCP added to {tool}.",
    "mcp.failed":
      "Could not update MCP configuration. Check the configuration file and write permissions; existing configuration is preserved.",
    "mcp.remove": "Choose a tool to remove Hive MCP from",
    "mcp.removed": "Hive MCP removed from {tool}.",
    "mcp.removeConfirm": "Remove Hive MCP from {tool}?",
    "mcp.removeAccept": "Remove configuration",
    "mcp.untrusted": "Trust the workspace before configuring MCP for another tool.",
  },
);
