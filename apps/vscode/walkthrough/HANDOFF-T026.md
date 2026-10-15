# Bàn giao T026 — gói đăng T037

Chỉ sửa manifest ở task tích hợp T026. Không đổi publisher `xdev`, tên `xdev-hive`, VS Code tối thiểu 1.101 hoặc thêm `repository` trỏ vào repo private.

## Metadata đề xuất

```json
{
  "license": "SEE LICENSE IN LICENSE",
  "homepage": "https://xdev.asia/hive/",
  "bugs": { "url": "https://xdev.asia/hive/" },
  "categories": ["AI", "Chat", "SCM Providers", "Other"],
  "keywords": ["hive", "agent", "mcp", "review", "workflow"],
  "galleryBanner": { "color": "#142745", "theme": "dark" },
  "pricing": "Free",
  "icon": "media/icon.png"
}
```

`homepage`/`bugs` dùng trang sản phẩm công khai, không dùng GitHub Issues của repo private. Chủ dự án cần chốt kênh hỗ trợ công khai trước đăng; thay `bugs.url` nếu có trang hỗ trợ riêng. LICENSE là dự thảo giấy phép riêng theo FR-052, cần chủ dự án duyệt. Không suy ra giấy phép extension từ AGPL của hub.

## Walkthrough đã có trong manifest

Giữ `contributes.walkthroughs` ID `xdevHive.getStarted`, tiêu đề **Bắt đầu với xDev Hive**, bốn bước theo thứ tự dưới. Các khoá dịch `walkthrough.*` đã có trong hai file nls. File Markdown có cả tiếng Việt và tiếng Anh.

| ID bước | Media Markdown | Lệnh chính / completionEvent hiện có |
| --- | --- | --- |
| `hub` | `walkthrough/hub.md` | `onCommand:xdevHive.setHubUrl` |
| `signIn` | `walkthrough/signIn.md` | `onCommand:xdevHive.signIn` |
| `mcp` | `walkthrough/mcp.md` | `onCommand:xdevHive.mcp.addClaudeCode` |
| `worker` | `walkthrough/worker.md` | `onCommand:xdevHive.worker.install` |

T026 nối lệnh `xdevHive.openWalkthrough` tới `workbench.action.openWalkthrough` với ID `xdev.xdev-hive#xdevHive.getStarted`. Cân nhắc completionEvents cho cả Cursor/Windsurf và MCP VS Code để người dùng không phải cài Claude Code chỉ để hoàn tất bước MCP. Event `onCommand` chỉ xác nhận đã gọi lệnh, không chứng minh cấu hình/đăng nhập/cài đặt thành công; kiểm hành vi và context thực tế khi tích hợp.

## Trước khi đăng Marketplace / Open VSX

- Sau khi tích hợp và kiểm thử tính năng, cập nhật các dòng “đang chờ tích hợp” trong README, CHANGELOG, PRIVACY và walkthrough; chốt ngày phát hành, không quảng bá tính năng còn trống.
- `media/icon.png`: 128×128, nền đặc trắng, vẽ từ `docs/design-system/assets/logos/xdev-hive-icon.svg`. Không dùng SVG làm ảnh README Marketplace.
- Chụp ảnh màn thật sau T026, không dùng mockup giả làm ảnh sản phẩm. Đưa PNG lên nơi công khai HTTPS được chủ dự án quản lý, rồi thêm URL tuyệt đối vào README. Chưa có ảnh màn hoặc URL ảnh công khai ở T037 vì các màn còn chờ tích hợp; không tạo URL dự đoán tới repo private. Đây là phần FR-049 còn chờ T026/T029 trước đăng.
- Đưa PRIVACY và LICENSE đã duyệt lên trang công khai, nối link HTTPS từ README. Hiện hai file có trong VSIX theo `.vscodeignore`; README không dùng link tương đối mà vsce có thể viết lại thành URL repo private.
- Giữ `--allow-missing-repository` khi package; kiểm `vsce ls`/VSIX có README, CHANGELOG, LICENSE, PRIVACY, icon, bốn Markdown và không có secret/test/source map. `.vscodeignore` đang cho phép cả `walkthrough/**`; T026/T029 cần loại `walkthrough/HANDOFF-T026.md` khỏi gói bán cho người dùng.
- Kiểm thật walkthrough bằng Extension Development Host ở T026: mở bốn bước, media hiển thị, link lệnh hoạt động, chưa có hub vẫn dùng được phần tại máy. T037 không sửa lệnh runtime hoặc manifest.
