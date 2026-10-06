# 52. Điều khiển quota trong app

Viết ngày 6/10. Người dùng hỏi: "với control quota á, chưa thấy chỗ hiển thị số lần reset, hiển thị đi, và có thể bấm reset trên giao diện client được". Họ chọn cả bốn ý:
1. giờ reset 5 giờ / tuần;
2. nút bỏ nghỉ (cooldown);
3. số lần chạm giới hạn;
4. nút đọc lại quota.

Task: **R-52**.

## Hiện trạng (main 906b39c)

Trang *Agent và quota* (`packages/ui/src/pages/Agents.tsx`) đã có gần đủ dữ liệu, nhưng giấu hoặc chỉ hiện lúc có lúc không:
- **Số lần chạm giới hạn**: `p.stats.rateLimited` (`agents.statQuota` "{count} hết quota") chỉ nằm trong dòng chữ nhỏ ở khung chi tiết của gói.
- **Nút bỏ nghỉ**: chỉ hiện khi trạng thái của dòng là `resting`, và vì "một nút mỗi dòng" nên nó bị nút khác thay mất. IPC `desktop:resetCooldown` gọi `runner.resetCooldown` đã có.
- **Giờ reset**:
  - Claude: lấy từ `claude -p /usage`;
  - Codex: lấy từ file phiên (45);
  - cả hai thành `sessionResets` / `weekResets` của `PlanUsage`, nhưng dòng gói không hiện rõ còn bao lâu.
- **Đọc lại quota**: `logins.refresh(ids)` có trong `apps/desktop/src/main/index.ts`, nhưng giao diện không có nút gọi riêng nó.

## Làm gì

**Mỗi gói** (cả chế độ cục bộ lẫn hub) có một khối quota luôn hiện:
- **Thanh 5 giờ và thanh tuần**:
  - % đã dùng (màu theo ngưỡng dừng của 3c);
  - giờ reset tuyệt đối (giờ máy) và còn bao lâu ("còn 2 giờ 15 phút", "còn 3 ngày"), tự cập nhật mỗi phút;
  - không biết thì hiện "chưa biết" và lý do ngắn: chưa đăng nhập, Codex chưa có phiên nào.
- **Dòng đếm**: chạm giới hạn N lần, M run, xong, lỗi, tính từ mốc đếm. Mốc mặc định là từ đầu; khi người đặt lại thì hiện "từ <ngày>".
- **Trạng thái nghỉ**: chip "Đang nghỉ tới HH:MM" và nút **Bỏ nghỉ**. Nút luôn hiện khi gói đang có `cooldownUntil`, không phụ thuộc nút đăng nhập hay cài CLI.
- **Nút đọc lại** (biểu tượng làm mới, có `aria-label`) cho gói đó; trong lúc đọc thì hiện trạng thái quay.
- **Nút Đặt lại bộ đếm**: hỏi xác nhận rồi đặt mốc đếm là bây giờ. Không xoá lịch sử run; chỉ đổi mốc.

**Đầu phần *Quản lý gói***:
- nút **Đọc lại quota** cho mọi gói đang bật;
- dòng "cập nhật lúc HH:MM".

**Desktop main:**
- IPC `desktop:refreshUsage(ids?)`: gọi `logins.refresh(ids)` rồi `runner.tick()`, trả `profileStatuses()`. Không cho gọi dồn: đang đọc thì trả kết quả của lần đang chạy.
- IPC `desktop:resetStats(id)`: lưu `statsSince` của gói trong store của runner (cột hay khoá cài đặt mới, có migration nếu là SQLite). `stats` tính từ mốc đó.

**Hub (chế độ hub):** heartbeat đã gửi % và giờ reset. Thêm `statsSince` nếu cần để *Bản đồ agent* trên web hiện cùng số đếm. Web không có nút đặt lại bộ đếm của máy khác.

Chữ vào `vi.ts` trước rồi `en.ts`. Màu và khoảng cách theo token. Dùng skill `ui-ux-pro-max`, nếu đã có trong repo, để rà:
- vùng chạm;
- tương phản của thanh;
- `aria-label`;
- chữ đếm ngược không làm trình đọc màn hình đọc lại mỗi phút (`aria-live` tắt).

## Test

- **UI**:
  - khối quota hiện đủ 4 phần;
  - đếm ngược đúng với giờ giả;
  - nút Bỏ nghỉ hiện khi có `cooldownUntil` dù đang có nút khác;
  - Đặt lại bộ đếm đổi chữ "từ <ngày>".
- **Desktop**:
  - `refreshUsage` gọi refresh đúng gói;
  - không chạy dồn;
  - `resetStats` làm `stats` về 0 với run cũ và đếm run mới.
- **Smoke**: ảnh *Agent và quota* có gói Claude và Codex với số liệu mẫu (giờ reset, đang nghỉ, đếm).

## Ràng buộc khi làm

- Không đổi luật chọn gói hay ngưỡng dừng.
- Không tăng version, không đánh dấu roadmap.
- Comment giải thích vì sao.
