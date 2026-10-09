# Prompt thiết kế lại UI: tách Web và App (roadmap 76)

Dán phần dưới vào Claude Design, kèm project thiết kế hiện tại `xDev Hive.dc.html` (e9ddc9b3) làm design system.

```text
Thiết kế lại giao diện xDev Hive thành HAI SẢN PHẨM RIÊNG, không dùng chung shell và menu: (1) Web, (2) App desktop. Giữ nguyên design system của project đang đính kèm ("xDev Hive.dc.html": bản tối glass vũ trụ, tím #7B61FF, surface #1D1C20/#242325/#29292B, ring-glass, bo 16/20/22px, ID dạng SF Mono, avatar hành tinh theo agent). Bản tối giữ đúng màu; bản sáng suy ra từ bản tối và phải đạt WCAG AA. Chữ trên giao diện bằng tiếng Việt.

xDev Hive là hub cho các coding agent (Claude Code, Codex, Gemini…) của một công ty: hub lưu task, tài liệu, memory, skill, run, artifact và chat; các máy (Mac, Windows, Ubuntu) chỉ chạy code. Các phòng ban được cấp tài khoản, nối Claude Code/Codex vào hub qua MCP; người dùng đọc và duyệt tài liệu do agent đề xuất.

=== 1. WEB (hive.xdev.asia) — cho người ===
Một trang web, hai khu tách bạch rõ bằng màu nhấn và nhãn (ví dụ công tắc "Không gian làm việc ⇄ Quản trị" ở đầu sidebar; khu Quản trị có nhãn "Quản trị" và viền nhấn riêng). Không trang nào có ở cả hai khu.

A. Không gian làm việc (mọi người, menu theo quyền):
- Hôm nay: hộp việc theo vai, có khối "Chờ bạn duyệt" (tài liệu, skill, memory) và "Bị kẹt".
- Task (kanban 5 cột + danh sách), Chat với leader, Tính năng, Quy trình (các chốt SDLC), Agent đang chạy (mọi máy), Tài liệu, Memory, Skill, Artifact, Lịch sử, Sơ đồ, Máy & agent (xem mọi máy), Terminal.
- Góc tài khoản: Tài khoản của tôi, Kết nối MCP (token của tôi), Phòng ban của tôi (trưởng phòng quản lý thành viên ở đây).
- Bộ chọn phạm vi: Tất cả service / hệ thống / một service.

B. Quản trị (chỉ Chủ hub, Quản trị; trưởng phòng chỉ thấy phòng của mình):
- Người dùng: danh sách, vai hub (Chủ hub, Quản trị, Thành viên, Người xem), link mời (hạn 1–30 ngày, hiện một lần), khoá, thùng rác 30 ngày.
- Phòng ban (MỚI): tạo phòng, trưởng phòng, thành viên, dự án/hệ thống của phòng và vai của phòng trên từng dự án.
- Token & kết nối MCP: mọi token của hub (loại, chủ, phạm vi, hạn, lần dùng cuối), thu hồi.
- Vai & quyền: bảng chỉ đọc giải thích từng vai làm được gì bằng lời thường.
- Nhật ký (cấp quyền, token, duyệt), Chính sách agent & model, Ngân sách, Cảnh báo, Thông báo & webhook, Phiên bản app & rollout, Vận hành hub (backup, log).

=== 2. APP DESKTOP (Electron, macOS/Windows/Linux) — chỉ việc của CHÍNH MÁY NÀY ===
Cửa sổ nhỏ gọn (tối thiểu 1100×720), giống một "bảng điều khiển runner", không phải bản sao của web:
- Máy này: online/offline với hub, CPU/RAM/ổ đĩa, phiên bản app và cập nhật, số run đang chạy / tối đa.
- Gói agent: đăng nhập từng CLI (Claude, Codex, Gemini…), thanh quota phiên và tuần, bật/tắt, ưu tiên, số run song song.
- Run trên máy: đang chạy, đang chờ, đã xong; log trực tiếp; nhánh và SHA, đã push lên remote chưa; huỷ.
- Worktree: dung lượng, đã push / chưa push, dọn.
- Công cụ & setup: CLI, MCP shim, kiểm tra thiếu gì.
- Cài đặt máy: nhận việc từ hub, thư mục dự án, nhập repo từ GitLab group / GitHub org.
- Mọi thứ khác là nút "Mở trên web" (Task, Tài liệu, Chat, Quản trị…).
- Thêm: màn hình đăng nhập hub lần đầu (device code), và mini view trên menu bar / khay hệ thống (trạng thái máy, run đang chạy, quota).

=== 3. LUỒNG MỚI CẦN THIẾT KẾ KỸ ===
a) Cấp tài khoản cho phòng ban: Quản trị tạo phòng → chọn dự án và vai của phòng (Người xem / Thành viên / QA / Reviewer / Quản lý dự án) → chọn trưởng phòng → tạo link mời; trưởng phòng thêm người, đặt vai không cao hơn vai của phòng.
b) Kết nối MCP: tạo token (tên, dự án, chế độ "Chỉ đọc" hoặc "Đọc và đề xuất", hạn 30/60/90 ngày) → token hiện MỘT lần, nút sao chép, lệnh mẫu cho Claude Code và Codex → danh sách token với lần dùng cuối, thu hồi. Ghi rõ token không bao giờ duyệt hay quản trị được.
c) Duyệt tài liệu: hộp "Chờ bạn duyệt" → xem đề xuất (diff cạnh nhau và gộp dòng, tác giả là người hay agent thay mặt ai, phiên bản gốc) → Duyệt / Yêu cầu sửa (kèm ghi chú) / Từ chối; tác giả có nút Rút; trạng thái Xung đột khi tài liệu đã đổi; nhãn "Cần Quản lý dự án duyệt" cho đường dẫn bắt buộc; lịch sử duyệt.
d) Quyền trên giao diện: nút không có quyền thì ẩn, hoặc khoá kèm gợi ý "Cần vai Reviewer"; trạng thái "Không có quyền xem dự án này".

=== 4. YÊU CẦU ===
- Mỗi trang một hành động chính rõ ràng; dùng component của design system (Button, Tag, Badge, Input, Toggle, Table, Tabs, Dialog, Sheet).
- Trạng thái cho mỗi trang: có dữ liệu, rỗng, đang tải, lỗi, không có quyền.
- Web: 1440 và 390 (mobile, vùng chạm 44px). App: 1100 và 1440.
- Bản tối và bản sáng.

=== 5. GIAO NỘP ===
- Ba nhóm trang riêng: "Web – Không gian làm việc", "Web – Quản trị", "App – Bảng điều khiển máy".
- Sơ đồ menu của từng sản phẩm (web người dùng, web quản trị, app).
- Bảng component mới: RoleBadge, TeamCard, TokenCard (hiện một lần), DiffViewer, ReviewBar, QuotaBar, MachineStatus, PermissionLock.
- Dữ liệu mẫu tiếng Việt thật: phòng "eHospital", "MindMap", "Platform"; dự án xdev-hive, ehospital-ai, billing-api; agent claude-4, codex-2; máy hc-duytd20-macmini, hc-duytd20-linux, hc-duytd20 (Windows).
```
