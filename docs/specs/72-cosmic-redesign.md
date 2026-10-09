# 72. cosmic-redesign: giao diện mới theo thiết kế Claude Design

Hỏi 8/10: "đọc thiết kế về làm giao diện". Nguồn là project Claude Design `e9ddc9b3-288b-4753-a1a8-ac83ae14847a`, file `xDev Hive.dc.html`. Bản sao nằm ở [docs/design/hive-2026-10/](../design/hive-2026-10/).

Người dùng đã chọn (8/10):
- **Giao diện:** bản tối làm đúng thiết kế. Bản sáng dùng cùng bố cục và component, chỉ đổi token màu. Nút Sáng/Tối giữ nguyên.
- **Thương hiệu:** dùng nguyên asset trong thiết kế (`assets/planet-*.png`, `x-mark.svg`, `xdev-hive-dark.svg`). Đã báo rủi ro: design system trong project là của LumiBase, và ảnh hành tinh là asset của thương hiệu đó. Không đưa chữ "LumiBase" vào giao diện hay mã.
- **Phạm vi:** cả 20 trang trong một đợt, chia task theo nhóm trang, chạy song song sau token và shell.

Thiết kế này thay cách chia menu của UX-71 (`docs/design/ux71/`). Phần nào của UX-71 đã nối API và quyền thật thì giữ logic, chỉ đổi trình bày.

## Giống thiết kế đến từng điểm ảnh (bổ sung 8/10)

Người dùng: "chưa thấy giống với giao diện thiết kế, có thể làm giống luôn đi". Mục tiêu là **giống thiết kế đến từng điểm ảnh**, không phải "theo phong cách".

- **Bản xem trước chạy được:** `docs/design/hive-2026-10/xDev Hive.preview.html`. Đây là template gốc, có thêm đoạn `return` mình dựng lại ở cuối `renderVals()`. Mở bằng `python3 -m http.server 7821 -d docs/design/hive-2026-10`, rồi vào `http://localhost:7821/xDev%20Hive.preview.html?page=<trang>`. Trang là một trong: today, tasks, chat, pipeline, features, runs, docs, memory, skills, artifacts, history, graph, machines, terminal, settings, admin, start.
- **Ảnh tham chiếu:** `docs/design/hive-2026-10/shots/<trang>-1440.png` (1440×900, tối). Đầy đủ cho today, tasks, chat, pipeline, features, runs, docs, memory, skills, machines. Panel chi tiết của *Hôm nay* chưa hiện. Artifact, Lịch sử, Sơ đồ, Cài đặt service, Quản trị, Terminal, Bắt đầu chỉ có khung, vì dữ liệu của chúng nằm trong phần bị cắt. Với các trang này, dựng theo markup trong template.
- **Số đo lấy đúng từ style inline của template:** px, khoảng cách, bo góc, cỡ và độ đậm chữ, màu, đổ bóng, ring. Chuyển các giá trị này sang token hoặc lớp Tailwind, nhưng giữ nguyên số đo. Không làm tròn sang thang có sẵn nếu lệch, không tự đổi bố cục, không thêm hay bớt khối. Thiếu token thì thêm token.
- **Cách so:** dùng cùng dữ liệu mẫu (fixture có dữ liệu giống thiết kế, ví dụ seed demo trong e2e), chụp trang ở 1440×900 tối, đặt cạnh ảnh tham chiếu (`*-compare.png`), và sửa tới khi bố cục, vị trí, kích thước và màu trùng. Chỗ được khác chỉ là dữ liệu thật khác dữ liệu mẫu. Mỗi chỗ còn khác phải ghi vào note bàn giao kèm lý do.
- **Ghép ảnh so sánh không cần PIL hay ImageMagick** (Mac mini không có). Viết một file HTML gồm hai `<img>` (`file:///…/ours.png` và `file:///…/design.png`), mỗi ảnh rộng 50%, nền đen. Chụp bằng `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=2880,900 --screenshot=<trang>-compare.png file:///…/cmp.html`. Shell chưa gộp thì cắt vùng nội dung (CSS `object-fit`/`object-position`, hoặc chụp riêng phần tử `main`).
- **Asset và icon đúng như thiết kế:** Lucide (tên icon ở `navDef` và trong template), ảnh hành tinh làm avatar theo loại gói (claude = violet, codex = green, gemini = blue).

## Đọc thiết kế thế nào

- `xDev Hive.dc.html` là template của Claude Design: HTML có style inline, binding `{{ … }}`, và `<script data-dc-script>` từ dòng 1875 chứa dữ liệu mẫu và hành vi (`navDef`, `inboxGroups`, các cột board, `artDef`…). File bị cắt ở 256 KB (giới hạn đọc của DesignSync), nên mất phần cuối script. Template (dòng 1–1874) còn nguyên. Đừng cố chạy file; hãy đọc markup và style.
- Dòng của từng trang trong template: Hôm nay 108–230, Task 231–280, Lượt chạy 281–353, Máy & agent 354–443, Tài liệu 444–625, Chat 626–691, Quy trình 692–863, Tính năng 864–914, Memory 915–951, Skill 952–989, Artifact 990–1087, Lịch sử 1088–1108, Sơ đồ 1109–1134, Cài đặt service 1135–1172, Quản trị 1173–1435, Terminal 1436–1500, Bắt đầu 1501–1546. Sidebar và thanh trên nằm trước dòng 108.
- `ref/` là ảnh giao diện cũ, chỉ để so sánh: `home-desktop.png` là bản sáng hiện tại, `dark-*.png` là bản tối cũ.
- `_ds/…/tokens/*.css` là token gốc của thiết kế. `_ds/…/_ds_bundle.js` là bản rút gọn chỉ còn 5 component thiết kế dùng (Button, Input, Tag, Toggle, Badge), giữ nguyên style.

## Ngôn ngữ thiết kế (bản tối)

- Nền: `linear-gradient(135deg, #1E1E20 0%, #0E0E11 32%)` cùng một lớp sao mờ (radial 1px, xem style của khung ngoài cùng). Card đặc `#1D1C20` (surface-1), lồng nhau dùng `#242325`, ô nhập dùng sunken `#171619`.
- Không dùng viền đặc: mọi viền là ring inset `inset 0 0 0 1px rgba(255,255,255,.08)`, mạnh hơn thì `.16`.
- Chữ: trắng → `#BDBDC0` → `#A9A9A9`. Font Inter 400/500/600/700, tự host (app không tải Google Fonts).
- Màu nhấn: tím `#7B61FF` (chính), xanh dương `#18A0FB` (thông tin, đang chạy), xanh lá `#2EC47C` (xong), đỏ `#E85656` (lỗi). Vàng cảnh báo lấy theo thiết kế.
- Bo góc: card 24, khối vừa 16–20, control 12, chip 8, pill 32/999.
- Nút: `glass` (mặc định), `solid` (tím), `blue`, `ghost`, cỡ sm 34 / md 46 / lg 54. Hover sáng lên khoảng 14%, nhấn thu nhỏ còn 0.96. Hiệu ứng kính dùng `backdrop-filter`. Filter SVG `#dgmLensSoft` là tuỳ chọn: tắt khi `prefers-reduced-motion` và trên máy yếu.
- Chuyển động: `cubic-bezier(.22,1,.36,1)` 240 ms. Chấm trạng thái nhấp nháy dùng `hivePulse`.
- Icon: Lucide nét mảnh (thiết kế ghi tên icon trong `navDef`).

## Cách làm

- Token: ánh xạ vào token ngữ nghĩa có sẵn trong `packages/ui/src/tokens/` (`[data-theme="dark"]` lấy đúng giá trị thiết kế). Thêm token mới khi cần: ring kính, glow, radius card/pill, nền sao. Không viết màu cứng trong component. Bản sáng: cùng tên token với giá trị sáng (nền gần trắng, ring tối mờ, giữ tím làm màu chính), contrast WCAG AA.
- Component dùng chung trong `packages/ui` (Button, Card, Tag/Chip, Badge, Input, Toggle, SegmentedTabs, ListRow, StatTile, EmptyState…) theo thiết kế. Trang dùng lại component, không chép style inline của template.
- Chữ trên giao diện vào `packages/ui/src/i18n/locales/vi.ts` (gốc) và `en.ts`.
- Dữ liệu và quyền giữ như hiện tại: thiết kế chỉ là dữ liệu mẫu, không bịa số.
- **Tính năng mới trong thiết kế thì làm luôn** (người dùng, 9/10: "có tính năng mới thì làm tính năng đó luôn"). Nút, hành động, bộ lọc hay số liệu nào có trong thiết kế mà Hive chưa có, task của trang đó làm cả phần dưới: method trong core, quyền, MCP nếu hợp, migration nếu cần, có test. Ví dụ: "Reset tuần" trên thẻ gói, CPU/RAM/ổ đĩa của máy, phiên bản artifact, phím J/K/E trên Hôm nay, "Chuyển thành chung" cho memory, "Đổi gói" cho run lỗi. Tính năng quá lớn cho một run (hệ thống mới, nhiều màn) thì tạo task con `R-72<x>-<slug>` bằng `propose_task`/`task_create`, ghi rõ vào note bàn giao, và trang hiện phần đã có.
- Mobile: mỗi trang chạy được ở 390 px (sidebar thành ngăn kéo, bảng thành danh sách). Thiết kế chỉ có desktop, nên mobile suy ra theo cùng ngôn ngữ.
- App desktop dùng chung shell web, nên làm ở `packages/ui` là cả hai cùng đổi.

## Task

| Task | Nội dung | Chờ |
|---|---|---|
| 72a tokens-primitives | Token tối/sáng theo thiết kế, Inter tự host, nền sao, component dùng chung, trang `DashboardComponentsFixture` hiện đủ biến thể | — |
| 72b shell | Sidebar (bộ chọn phạm vi service/hệ thống, nút *Giao việc cho agent*, 3 nhóm *Làm việc / Không gian / Vận hành* có số đếm và phím tắt, thẻ người dùng), thanh trên, Sáng/Tối, ngăn kéo mobile, trang *chưa thiết kế* | 72a |
| 72c today | Hôm nay: inbox theo nhóm (*Cần duyệt / Cần xử lý / Máy*), panel chi tiết với hành động | 72a, 72b |
| 72d tasks | Task: board 5 cột, thẻ, chi tiết | 72a, 72b |
| 72e runs | Lượt chạy: danh sách, chi tiết run (log, tóm tắt, hành động theo trạng thái) | 72a, 72b |
| 72f docs | Tài liệu: cây, trang đọc, chip phiên bản/đề xuất | 72a, 72b |
| 72g machines | Máy & agent: thẻ máy (CPU/RAM/ổ đĩa), gói, quota | 72a, 72b |
| 72h chat | Chat | 72a, 72b |
| 72i pipeline-features | Quy trình và Tính năng | 72a, 72b |
| 72j knowledge | Memory, Skill, Artifact (phiên bản, xem HTML/log) | 72a, 72b |
| 72k history-graph | Lịch sử, Sơ đồ | 72a, 72b |
| 72l settings-admin | Cài đặt service, Quản trị | 72a, 72b |
| 72m terminal-start | Terminal, Bắt đầu | 72a, 72b |
| 72n e2e-screens | Cập nhật e2e web/mobile và smoke desktop cho bố cục mới, bộ ảnh tối/sáng ở 1440 và 390 | 72c–72m |

Mỗi task trang: so khớp với đoạn template của trang đó ở cả tối lẫn sáng, có test UI hiện có cập nhật theo, `npm run typecheck` và `npm test` xanh, ảnh chụp 1440×900 và 390×844 (tối) để trong artifact của run. Không bump version, không tick roadmap.
