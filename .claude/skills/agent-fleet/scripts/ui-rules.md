# Việc có giao diện (web, desktop) — bắt buộc

Repo có sẵn skill trong `.claude/skills/` (nguồn, giấy phép: `packages/skill-pack/NOTICE.md`). Dùng theo thứ tự:

1. **Thiết kế** (trước khi viết code của màn mới hay sửa bố cục): gọi skill `ui-ux-pro-max` để chọn bố cục, mật độ,
   mẫu UX cho loại màn (bảng quản trị, form, trạng thái rỗng/lỗi/đang tải). Không đổi màu, font của Hive theo gợi ý
   của skill: hệ thống thiết kế v2 đã chốt ở `docs/design-system/README.md`, `tokens.json`, `xdev-hive/MASTER.md`.
2. **Code**:
   - Token và component theo design system v2 (tên token kiểu shadcn: `background`, `card`, `primary`, `muted`…;
     không viết mã màu, cỡ chữ tự chế). Dùng skill `design-system` khi cần thêm/sửa token, `ui-styling` khi dựng
     component bằng shadcn/ui + Tailwind.
   - Lấy component qua MCP `shadcn` (`.mcp.json`, cwd `apps/web`) hoặc skill `shadcn`; ưu tiên component đã có trong
     `packages/ui` và `apps/web/src/components` trước khi thêm mới.
   - React: theo `vercel-react-best-practices` (fetch song song, không re-render thừa) và `vercel-composition-patterns`
     (không chồng prop boolean).
   - Chữ trên giao diện, lỗi: tiếng Việt, theo mục Content của design system; desktop thêm cả từ điển vi/en.
3. **Tự review trước khi xong**: chạy skill `web-design-guidelines` trên các file UI đã sửa (đọc `command.md` trong
   thư mục skill nếu không tải được URL), sửa hết lỗi accessibility (nhãn, focus, bàn phím, tương phản), trạng thái
   (đang tải, rỗng, lỗi), chữ bị cắt ở màn hẹp. Ghi kết quả review vào tóm tắt.
4. Test: e2e Playwright (web, fake hub) hoặc vitest (desktop) cho luồng chính của màn.
