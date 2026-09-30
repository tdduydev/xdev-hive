# xDev Hive Design System · v1.0

Design system cho **xDev Hive · Dev Hub**, nền tảng để developer quản lý dự án, điều phối AI coding agent và chia sẻ tài liệu, skill, memory, task.

## Nguồn
- Nhận diện: https://xdev.asia/brand/ (logo X + HIVE / DEV HUB, bảng màu thương hiệu)
- Logo: `assets/hive-light.svg`, `assets/hive-dark.svg` (tải từ xdev.asia/assets/brand/wordmark-v2/)
- Sản phẩm: repo `tdduydev/xdev-hive` (xem `github.md`)

## Chỉ mục
| File | Nội dung |
|---|---|
| `styles.css` | Điểm vào duy nhất, chỉ gồm `@import` |
| `tokens/primitives.css` | Bảng màu gốc: blue, neutral, navy, green, amber, red |
| `tokens/colors.css` | Token semantic sáng (`:root`, `[data-theme="light"]`) và tối (`[data-theme="dark"]`) |
| `tokens/typography.css` | Họ chữ, thang chữ dạng shorthand `font` |
| `tokens/spacing.css` | Khoảng cách 4/8, kích thước điều khiển, radius, border, z-index, breakpoint, mật độ gọn |
| `tokens/motion.css` | Thời lượng, easing, keyframes, giảm chuyển động |
| `tokens/base.css` | Focus-visible, selection, reduced-motion toàn cục |
| `assets/icons.svg`, `assets/icons.json` | 103 icon Lucide 0.460 (ISC), nét 1.5 |
| `DS Foundations.dc.html` | Nguyên tắc, thương hiệu, màu (có tỉ lệ tương phản tính trực tiếp), chữ, khoảng cách, bo góc, bóng, breakpoint, chuyển động, trạng thái, tiếp cận, nội dung |
| `DS Components.dc.html` | 21 component: button, input, textarea, select, checkbox, switch, badge, tooltip, dropdown, tabs/segmented, breadcrumb, card, dialog, drawer, toast, skeleton, empty state, pagination, data table, sidebar, command palette |
| `DS Developer Components.dc.html` | Code block, diff viewer, Markdown editor, task board, trạng thái agent, tiến trình run, log viewer, lịch sử phiên bản |
| `DS Screens.dc.html` | App shell + Dashboard, Projects, Agents, Tasks, Documents, Skills, Memory, Settings; sáng/tối/so sánh; desktop/tablet/mobile |
| `guidelines/*.html` | Thẻ mẫu cho tab Design System |

## Cách dùng
```html
<link rel="stylesheet" href="styles.css">
<html data-theme="dark" data-density="compact">
```
- Component chỉ dùng token semantic (`--bg-*`, `--text-*`, `--border-*`, `--action-*`, `--state-*`, `--status-*`), không dùng primitive.
- Đổi chủ đề cho cả trang hoặc một vùng con bằng `data-theme`. Mặc định theo `prefers-color-scheme` do app đặt.
- Chữ: `font: var(--type-body-md)`. Tiêu đề trang dùng `--type-display-*` (Space Grotesk).

## CONTENT FUNDAMENTALS
- Tiếng Việt trước, giọng đồng nghiệp kỹ thuật: rõ, thẳng, không cảm thán. Xưng hô trung tính; khi cần thì dùng “bạn”.
- Viết hoa đầu câu (sentence case) cho tiêu đề, nút, menu. Không viết hoa mọi từ.
- Giữ nguyên thuật ngữ developer: agent, run, task, skill, memory, commit, PR, worktree, token, webhook.
- Nút bắt đầu bằng động từ: “Tạo task”, “Chạy agent”, “Duyệt”. Xác nhận nêu hậu quả cụ thể: “Xoá dự án payment-gateway? 42 task sẽ mất.”
- Lỗi nói chuyện gì xảy ra và làm gì tiếp: “Không kết nối được máy build-03. Kiểm tra agent đang chạy rồi thử lại.”
- Số theo kiểu Việt: 1.284 · 97,2% · $12,48. Thời gian tương đối cho mục gần (“3 phút trước”), tuyệt đối khi di chuột.
- Tên dự án, slug, ID, đường dẫn, model: font mono. Không emoji.

## VISUAL FOUNDATIONS
- **Màu:** nền sáng #F7F9FC, nền tối #142745 (navy thương hiệu). Chữ #344568 / #E8ECF8. Hành động chính xanh sâu #004CFF (sáng) và #1463FF (tối), chữ trắng ≥ 4.9:1. Trạng thái: xanh lá (xong), hổ phách (cảnh báo/hết quota), đỏ (lỗi), xanh (thông tin/đang chạy), xám (chờ/offline).
- **Gradient** #7BD4FF → #1E90FF → #004CFF chỉ dùng cho: chữ X trong logo, thanh tiến trình run đang chạy, vòng avatar agent đang hoạt động, viền nút Brand (tối đa 1/màn). Không dùng cho nền, chữ, bảng, editor, vùng đọc.
- **Chữ:** Space Grotesk (tiêu đề, số KPI) · Be Vietnam Pro (giao diện) · JetBrains Mono (code, ID, log). Thang 11–32 px; mặc định 14/22.
- **Khoảng cách:** lưới 4/8. Điều khiển 28/32/40 px (44 px mobile). Hàng bảng 40 px, gọn 32 px.
- **Bo góc:** 4 (badge, checkbox) · 6 (nút sm, mục menu) · 8 (nút, input) · 12 (card, dialog, toast) · 16 (drawer, bảng lệnh) · tròn (avatar, pill, switch).
- **Card:** nền surface, viền 1 px `--border-default`, không bóng. Card tương tác: hover đổi viền `--border-strong` + `--shadow-1`. Card đang chọn: viền 2 px `--border-selected` + dấu ✓. Không viền trái màu.
- **Bóng/độ cao:** 5 mức; bóng chỉ cho lớp nổi (dropdown 2, dialog/drawer/bảng lệnh 3, toast 4). Ở tối, lớp nổi sáng hơn nền và có viền sáng mờ.
- **Nền:** phẳng, không ảnh, không hoạ tiết, không blur. Scrim tối 48% (sáng) / 64% (tối) sau dialog và drawer.
- **Hover:** lớp phủ `--state-hover` (6–7%) hoặc nền đậm hơn 1 bậc cho nút đặc. **Nhấn:** lớp phủ 12% / nền đậm nhất, không co nút. **Focus:** vòng 2 px `--focus-color` cách 2 px, chỉ khi dùng bàn phím.
- **Chuyển động:** 80–320 ms, `--ease-standard`; lớp mở dùng `--ease-enter`. Không nảy. Giảm chuyển động: mọi thời lượng về 0, spinner/shimmer/vòng gradient dừng.
- **Bố cục:** sidebar 240 px (≥ 1024), thanh icon 64 px (768–1023), drawer + tab bar dưới (< 768). Topbar 56 px. Nội dung tối đa 1200 px, trang đọc 72ch.
- **Không dùng màu làm tín hiệu duy nhất:** trạng thái luôn có icon + chữ; lỗi form có viền 2 px + icon + thông điệp; diff có dấu +/−; log có nhãn INFO/WARN/ERROR.

## ICONOGRAPHY
- Bộ icon: **Lucide 0.460** (ISC), nét 1.5 px, đầu tròn, không tô. Kích thước 14 / 16 / 20 px. Màu theo `currentColor`.
- File: `assets/icons.svg` (sprite `<symbol id="i-…">`) và `assets/icons.json` (tên → path `d`, dùng khi cần vẽ inline).
- Icon luôn đi kèm nhãn, trừ nút icon (có `aria-label` + tooltip). Không emoji, không ký tự unicode làm icon (trừ ✓/✕ trong bảng hướng dẫn).
- Logo: không tự vẽ lại. Dưới 24 px chiều cao dùng `assets/x-mark.svg` (X đứng riêng, dựng lại từ chữ X trong wordmark bằng cùng font và gradient).

## Ghi chú
- `x-mark.svg` được dựng từ chữ X Space Grotesk + gradient của wordmark vì bộ brand chưa có file X đứng riêng. Thay bằng file chính thức nếu có.
- Font tải từ Google Fonts; chưa có file font tự host.
