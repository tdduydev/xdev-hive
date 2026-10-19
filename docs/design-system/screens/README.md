# Thiết kế màn (Claude Design, bản 2026-10-12)

Bản chép đầy đủ canvas "xDev Hive — các màn còn thiếu" trên Claude Design:
https://claude.ai/artifact/2iBZNpAxyzovmmVKL5L9cW

Các màn gốc sửa trên canvas rồi chép lại vào đây. Các màn bổ sung của spec 011 và 012 được thiết kế trong repo,
chưa chép lên canvas; dùng bản trong repo khi triển khai các spec này. Bản cũ (design system v1, 8 màn)
nằm trong [`v1/`](v1/README.md).

## Thư mục

| Đường dẫn | Là gì |
|---|---|
| `*.dc.html` | Mỗi file một màn hoặc một thành phần dùng chung. Tên file là tên artboard trên canvas khi được chép lên |
| `canvas.json` | Bố cục canvas: vị trí, kích thước, tiêu đề từng artboard, các hàng và ghi chú |
| `ds/xdev-hive/` | Token v2 mà artboard nạp (`tokens.css` sinh từ `tokens.json`, cùng giá trị với `../tokens.json`) |
| `v1/` | Thiết kế cũ theo design system v1 (navy, `canvas`/`surface`) |

Kiểu Markdown, khối code, sơ đồ Mermaid và terminal dùng chung nằm ở [`../prose-and-terminal.md`](../prose-and-terminal.md).

Các file để phẳng một cấp vì `<dc-import name="X">` nạp `X.dc.html` cùng thư mục. Đừng chia thư mục con.

## Đọc file

- Mỗi `.dc.html` là một Design Component: markup trong `<x-dc>`, dữ liệu mẫu và trạng thái trong khối
  `<script data-dc-script>`. Mở bằng trình duyệt sẽ không chạy vì thiếu `support.js` của Claude Design; xem trên canvas
  hoặc đọc mã.
- Style viết inline theo token v2 (tên biến shadcn/ui: `--primary`, `--muted-foreground`, …). Khi làm web, dùng
  component trong `apps/web/src/components/ui`, không chép style inline.
- Mọi màn có chữ tiếng Việt và tiếng Anh. Câu chữ nằm trong `renderVals()` dạng cặp `['vi', 'en']`; tweak `lang` hoặc
  nút VI/EN trên thanh trên đổi ngôn ngữ.
- `/_blob/00df5cc6b2c7e45808bff2ed403600d4` là `../assets/logos/xdev-hive-icon.svg` đã tải lên canvas. Logo chữ
  (`Logo.dc.html`) vẽ SVG trực tiếp nên không cần file ngoài.
- Số liệu, tên người, máy, mã việc đều là dữ liệu mẫu.

## Thành phần dùng chung

| File | Dùng ở | Ghi chú |
|---|---|---|
| `Foundations.dc.html` | — | Màu, trạng thái, chữ, khoảng cách, bo góc, bóng, logo |
| `Components.dc.html` | — | Button, Badge, Input, Checkbox/Radio/Switch, Tabs, Alert, Card, Dialog, menu nhiều cấp, trạng thái trống |
| `Logo.dc.html` | Thanh bên, màn ngoài khung, app | Wordmark `xdev-hive-light.svg`, màu chữ theo `--brand-letter` |
| `Sidebar.dc.html` | Mọi màn web | Menu nhiều cấp: Tổng quan, Công việc, Kiến thức, Dự án và hạ tầng, Quản trị agent, Người và quyền, Theo dõi |
| `Topbar.dc.html` | Mọi màn web | Đường dẫn, tìm kiếm ⌘K, VI/EN, sáng/tối, thông báo |
| `DataTable.dc.html` | Mọi bảng dữ liệu | Tìm, lọc nhiều lựa chọn có đếm, dòng "Đang lọc", ẩn cột, sắp xếp, chọn hàng loạt, phân trang. Props: `columns`, `rows`, `facets`, `bulk`, `page-size`, `on-row-click`, `active-id` |
| `AppNav.dc.html` | Mọi màn app máy | Một app, menu theo quyền (`role` = dev, writer, lead); `compact` chỉ còn icon. Có nhóm AI SDLC (xem dưới) |

## Mẫu trang quản trị (2026-10-14)

Bốn mẫu theo [`../admin-layout.md`](../admin-layout.md). Mỗi mẫu có prop `lang`, `dark`, `narrow` (360 px), `state`
(`normal`, `loading`, `empty`, `error`; mẫu cài đặt dùng `empty` cho chế độ chỉ đọc) và thanh "Trạng thái xem" để xem
từng trạng thái. Chưa chép lên canvas.

| File | Mẫu | Trang làm chuẩn trong code |
|---|---|---|
| `AdminListTemplate.dc.html` | Danh sách: tab có số đếm, thanh lọc, bảng có cột số canh phải, cột ghim, chọn nhiều, phân trang. Bấm cả dòng (hoặc nút ›) mở trang chi tiết, không có panel bên cạnh | `/admin/members` |
| `AdminDetailTemplate.dc.html` | Chi tiết: liên kết "← danh sách", ô màu + tên + trạng thái, nút phụ + một nút chính + ⋯, một dòng meta; tab theo URL (`?tab=`: Tổng quan, Thành viên, Hệ thống), khối thông tin, bảng liên quan, vùng nguy hiểm | `/admin/teams/$teamId` |
| `AdminSettingsTemplate.dc.html` | Cài đặt nhiều mục: mục lục bám cuộn, mục dạng card, hàng nhãn–ô, công tắc, thẻ radio. Mỗi mục có chân riêng (● Có thay đổi chưa lưu, ✓ Đã lưu, lỗi, Huỷ, Lưu), không có thanh lưu chung; có hộp thoại "Rời trang khi còn thay đổi chưa lưu?" minh hoạ | `/projects/$key/settings` |
| `AdminDashboardTemplate.dc.html` | Số liệu: thẻ số liệu có xu hướng, biểu đồ có bảng thay thế, bảng theo dự án | — (Chi phí) |

Cả bốn mẫu dùng khung quản trị (Quyết định 1): thanh bên chính chỉ còn Tổng quan, Công việc, Kiến thức và một mục "Quản trị" (icon bánh răng, được tô); bên phải nó là menu quản trị thứ hai rộng 208 px với liên kết "← Quản trị" và bốn nhóm (Người và quyền, Dự án và hạ tầng, Quản trị agent, Theo dõi), trang hiện tại được tô. Từ 360 px cả hai cột ẩn, thay bằng một hàng "← Quản trị" + ô chọn "Chọn trang quản trị" phía trên tiêu đề. Khung này vẽ thẳng trong mỗi mẫu (không dùng `Sidebar.dc.html`, vẫn là menu cũ cho các màn khác); đường dẫn trên `Topbar` là "Quản trị › trang".

## Màn web

| File | Màn | Route |
|---|---|---|
| `Home.dc.html` | Trang chủ | `/` |
| `Main.dc.html` | Lượt chạy (DataTable 1.286 dòng mẫu) | `/runs` |
| `Leader.dc.html` | Leader: chat, hộp thoại mở terminal, màn terminal, Bypass và nhật ký (xem "Terminal Leader" dưới) | `/leader`, `/leader/terminal/$id` |
| `Plan.dc.html` | Kế hoạch, duyệt và từ chối | `/tasks/$key/plan` |
| `Projects.dc.html` | Dự án | `/projects` |
| `ProjectSettings.dc.html` | Cấu hình dự án | `/projects/$key/settings` |
| `ProjectSandbox.dc.html` | Sandbox dự án | `/projects/$key/sandbox` |
| `Docs.dc.html` | Tài liệu | `/knowledge/docs` |
| `DocEditor.dc.html` | Soạn tài liệu kiểu Tiptap: đề xuất của AI, bình luận, phiên bản | `/knowledge/docs/$key/edit` |
| `Skills.dc.html` | Skills, đồng bộ với `tdduydev/xdev-skills` | `/knowledge/skills` |
| `Memory.dc.html` | Memory | `/knowledge/memory` |
| `Proposals.dc.html` | Đề xuất sửa tài liệu và skill | `/knowledge/proposals` |
| `Workflows.dc.html` | Quy trình duyệt theo AI SDLC (AI-DLC, Spec Kit, BMAD, tự tạo) | `/knowledge/workflows` |
| `DocReview.dc.html` | Chờ tôi duyệt: diff, AI tự kiểm, truy vết R-n | `/knowledge/reviews` |
| `CodeReview.dc.html` | Chờ tôi duyệt, tab Code (PR): checkpoint máy, diff, review AI, quyết định | `/knowledge/reviews?tab=code` |
| `Members.dc.html` | Thành viên: đang hoạt động, lời mời, chờ duyệt | `/admin/members` |
| `Teams.dc.html` | Đội và hệ thống | `/admin/teams` |
| `Roles.dc.html` | Vai trò và quyền dạng cây | `/admin/roles` |
| `LoginSettings.dc.html` | Cài đặt đăng nhập, SSO, xác minh tên miền | `/admin/sign-in-settings` |
| `OrgSandbox.dc.html` | Sandbox tổ chức | `/admin/sandbox` |
| `McpTools.dc.html` | MCP và công cụ: tool của hub, MCP server ngoài, token | `/admin/mcp` |
| `Policies.dc.html` | Chính sách agent: model, quyền CLI, hook, file hướng dẫn, giới hạn | `/admin/policies` |
| `Audit.dc.html` | Nhật ký | `/admin/audit` |
| `Onboarding.dc.html` | Tạo tổ chức (3 bước) | `/orgs/new` |
| `Invite.dc.html` | Nhận lời mời | `/invite/$token` |
| `McpConsent.dc.html` | Cho phép công cụ dùng hub qua MCP | `/mcp/consent` |
| `Status.dc.html` | Lỗi hub, 404, đang tải | — |

Route của `Docs`, `DocEditor`, `Skills`, `Memory`, `Proposals`, `Workflows`, `DocReview`, `Roles`, `McpTools`,
`Policies`, `Audit` là đề xuất; web chưa có các màn này.

## Terminal Leader (Leader.dc.html)

`Leader.dc.html` dùng chung thanh "Biến thể" cho chat và terminal. Mặc định `artifacts=true`, `view=ready`: chat kèm
khung artifact; các trạng thái artifact (`loading`, `empty`, `error`, `offline`, `runtime`, `compile`, `newer`, `editing`,
`deleted`) vẫn nằm trong tab Chat. Chọn "Mở phiên" để mở terminal, rồi quay về Chat để xem artifact.
Đặt `artifacts=false` để xem chat cũ kèm danh sách phiên terminal. Prop `view` còn nhận `chat`, `open`, `terminal`, `bypass`,
cộng `narrow` (khung 360 px,
không Sidebar), `dark`, `lang`. Bảng màu và hành vi của xterm xem [`../prose-and-terminal.md`](../prose-and-terminal.md).

| Biến thể | Nội dung | Ghi chú |
|---|---|---|
| `chat` (`artifacts=false`) | Nút **Mở terminal Leader** trên đầu cột trái; mục "Phiên terminal" liệt kê phiên: trạng thái, chế độ, máy, model, người mở, link; phiên của người khác có nhãn "Chỉ xem" | Nút chỉ hiện khi tổ chức có dự án |
| `open` | Hộp thoại: dự án, máy (chỉ máy online; máy đủ phiên bị khoá kèm lý do), gói của máy, chế độ Đề xuất / Bypass, model Sonnet (mặc định) / Opus kèm chi phí ước tính 30 ngày (null thì "chưa đủ dữ liệu"), quyền trên máy (Toàn quyền hoặc Accept edits trong worktree tạm) | Hộp thoại tự gọi `terminal.options`: hub chưa bật hay thiếu quyền thì thay form bằng một câu giải thích |
| `terminal` | Trang phiên: đầu trang có trạng thái kết nối, "Cho đội xem", "Đóng phiên"; hàng huy hiệu chế độ, model, máy, gói, quyền; xterm toàn khung; khung phải "Đề xuất của phiên": mỗi thẻ có hành động, **cấp độ Leader chọn + lý do**, ô chọn cấp (Nhẹ, Vừa, Nặng) kèm ý nghĩa của cấp, nút Duyệt và Từ chối | Đề xuất cũ không có cấp: ô chọn có thêm "Để hub tự suy" và duyệt không gửi `tier` |
| `bypass` | Như `terminal` nhưng huy hiệu Bypass (cảnh báo) và khung phải là "Nhật ký hành động": giờ, tool, kết quả, cấp độ, model, lý do | Hộp thoại mở phiên Bypass: cảnh báo đỏ + ô tick xác nhận bắt buộc, nút Mở terminal khoá tới khi tick |
| `narrow` (360 px) | Một cột: terminal 60% chiều cao màn, dưới là nút "Đề xuất (n)" / "Nhật ký (n)" mở ngăn chứa khung phải | Hộp thoại rộng tối đa 328 px, cuộn dọc |

Trạng thái kết nối ở đầu trang: Đang kết nối (xanh), Đã kết nối (lục), Mất kết nối, đang nối lại… (vàng), Phiên đã kết thúc
(xám, kèm lý do và bản ghi phát lại ở cỡ cột của lúc chạy). Người xem không phải chủ phiên thấy "Chỉ xem": terminal không
nhận phím, không có công tắc "Cho đội xem" và nút "Đóng phiên". Canvas chưa vẽ lại các biến thể này bằng công cụ Claude
Design; artboard chép từ code web (`apps/web/src/pages/leader-terminal-page.tsx`).

## App máy (desktop)

Một app cho mọi người, menu hiện theo quyền. Không tách app dev và app viết tài liệu.

| File | Màn |
|---|---|
| `AppRegister.dc.html` | Cửa sổ đăng ký máy (5 trạng thái) |
| `AppTray.dc.html` | Menu khay và thông báo hệ thống (7 trạng thái worker) |
| `AppHome.dc.html` | Tổng quan: máy sẵn sàng, skill áp dụng, tài liệu nói gì, token |
| `AppDocs.dc.html` | Chọn thư mục, viết tài liệu từ code bằng gói thuê bao; cây code bấm mở file (code chỉ xem, tài liệu sửa và lưu vào file); khung phải có tab Chat (theo đúng Claude Code hoặc Codex, chọn model, chế độ Chỉ đọc / Accept edits / Bypass có hộp xác nhận) và Terminal (xterm.js chạy Claude Code, Codex, Antigravity hay shell bằng gói agent); hộp tài khoản AI |
| `AppSkills.dc.html` | Skill áp cho thư mục, cài vào `.claude/skills/` và `.agents/skills/` |
| `AppTokens.dc.html` | Ngữ cảnh theo nhóm của `/context`, thứ tiêu hạn mức theo `/usage`, gợi ý tối ưu |
| `AppSetup.dc.html` | Môi trường: CLI, runtime, công cụ, MCP, thư viện dự án, kèm lệnh cài |
| `AppPlans.dc.html` | Gói agent nhóm theo CLI: ô "Cả máy", khối Claude Code / Codex / Antigravity với lưới thẻ gói, băng tìm đăng nhập chưa thêm, hộp thêm gói theo bước. Tweak `view` mở hộp thêm hoặc hộp tìm thấy |
| `AppWork.dc.html` | Việc của tôi (hồ sơ dev và lead, quyền `work.mine`): bảng "Task của tôi" có nút Giao cho agent, bảng "Lượt chạy của tôi", và màn theo dõi một run (trạng thái, lý do đang chờ máy, log trực tiếp). Tweak `view`: `list`, `run`, `waiting`, `loading`, `empty`, `error` |
| `AppKnowledge.dc.html` | Tra cứu tri thức (mọi hồ sơ, chỉ đọc): một ô tìm cho Tài liệu, Memory và Skill, bản đọc tài liệu có nút sang trình soạn và bản đọc skill. Tweak `view`: `results`, `start`, `none`, `loading`, `error`, `doc`, `skill` |

Chế độ quyền, lệnh `/`, cách đăng nhập và đường dẫn skill trong `AppDocs` và `AppSkills` lấy từ Claude Code 2.1.296
và codex-cli 0.162.1 cài trên máy dev ngày 2026-10-12. Định dạng từng dòng thao tác trong khung chat và chữ của Approve
for me chưa đối chiếu với phiên tương tác thật.

## AI SDLC (spec 011, T005)

Bảy màn mới và ba biến thể. App máy và web dùng chung một component (`@xdev-hive/sdlc-ui`), nên mỗi màn chỉ có một file:
dạng cửa sổ app 1440 × 900 (có `AppNav`), còn web đặt cùng nội dung trong `Sidebar` + `Topbar`. Mọi màn có prop `narrow`
(360 px: một cột, bảng và đồ thị thành danh sách), `dark`, `lang`, và thanh "Trạng thái xem" (bình thường, đang tải, rỗng,
lỗi, cộng trạng thái riêng của màn) để xem từng trạng thái. Prop `role` (dev, writer, lead) đổi nút theo quyền: nút Chạy
đợt, Tạm dừng, Tạo ngoại lệ, Huỷ hạng mục chỉ hiện với `sdlc.manage` (lead); người chỉ đọc không thấy nút ghi.

| File | Màn | Route app / web | Story | Giao cho |
|---|---|---|---|---|
| `AppSdlcBoard.dc.html` | Bảng hạng mục theo 7 loại giai đoạn + danh sách, chip dự án | `#/sdlc` · `/sdlc` | US7, US12, US16 | T050 `item-board`, `item-list` |
| `AppSdlcNewItem.dc.html` | Tạo hạng mục, chọn dự án tham gia, gợi ý cỡ và chế độ | tạo từ màn `sdlc` · `/sdlc/new` | US1, US16 | T050 `new-item`, `project-picker` |
| `AppSdlcItem.dc.html` | Chi tiết: stepper, tab Tổng quan / Dự án / Tài liệu / Contract / Câu hỏi / Task / Truy vết, tự duyệt + Thu hồi, ngoại lệ | `#/sdlc/<dự án>/<NNN>/<tab>` · `/sdlc/$project/$number` | US2–US6, US16–US18 | T051 |
| `AppSdlcQuestions.dc.html` | Câu hỏi chờ tôi, trả lời nhanh, "Dùng đề xuất" | màn `sdlc-questions` · `/sdlc/questions` | US2 | T050 `questions` |
| `AppSdlcBreakdown.dc.html` | Duyệt bản tách task: đồ thị theo làn dự án, đợt, độ phủ, lỗi đọc | tab Task của hạng mục, và thẻ trong Chờ tôi duyệt | US5, US16 | T052 `breakdown-review`, `dependency-graph` |
| `AppSdlcTrace.dc.html` | Ma trận truy vết, độ phủ tổng và theo dự án, CSV | tab Truy vết | US9, US16 | T052 `trace-matrix` |
| `AppSdlcMetrics.dc.html` | Tiến độ và chỉ số, tỉ lệ tự duyệt và thu hồi | màn `sdlc-metrics` · `/sdlc/metrics` | US12, US18 | T082 |
| `AppNav.dc.html` (biến thể) | Nhóm menu AI SDLC theo hồ sơ dev / writer (cả BA/PO) / lead | — | US7 | T055 `nav.ts` |
| `DocEditor.dc.html` (biến thể, prop `sdlc`) | Khung bên "Hạng mục · giai đoạn" | khung của editor | US2, US3 | T053 `sdlc-panel` |
| `DocReview.dc.html` (biến thể, prop `sdlc`) | Thẻ "Câu hỏi đã trả lời", "Bản tách task", checkpoint theo đội, checkpoint tự duyệt | `/knowledge/reviews` | US3, US5, US16, US18 | T053, T054 |

Ghi chú bàn giao:

- Mọi chữ có cặp vi/en trong `renderVals()`; từ điển của package đặt cùng khoá để sau này không phải dịch lại.
- Đồ thị phụ thuộc vẽ SVG; cạnh liên dự án khác cạnh thường bằng nét và nhãn, không chỉ màu. Bản dự phòng là danh sách
  (bắt buộc ở 360 px). Khi làm bằng `@xyflow/react` (T052) giữ cả hai dạng.
- "Tự duyệt bởi AI" luôn kèm điểm, ngưỡng và hạn thu hồi; nút Thu hồi cần lý do. Contract và giai đoạn yêu cầu của chế
  độ nặng không bao giờ có nhãn này.
- Dữ liệu mẫu dùng một bộ chung: hạng mục `012-hoan-tien-mot-phan` (Spec Kit, cỡ L) với `payment-api` là dự án chính,
  `web-shop` và `mobile-app` tham gia, contract `refund-api`.
- Chưa có trên canvas Claude Design; khi chép lên canvas thì thêm artboard cho từng file (1440 × 900 và bản `narrow`
  360 × 1900) và cập nhật `canvas.json`.

## Phần thiết kế chưa có trong code

- Hub chưa đồng bộ skill với repo `tdduydev/xdev-skills`; skill vẫn nằm trong Postgres.
- Chưa có trình soạn tài liệu, quy trình duyệt cấu hình được, vai trò tự tạo, chính sách agent, kết nối gói thuê bao
  trong app.
- Chưa có i18n: web và app hiện chỉ có tiếng Việt.

## Bàn giao: màn web cấu hình AI SDLC (spec 011, T006)

| File | Màn | Route đề xuất | Story |
|---|---|---|---|
| `SdlcModes.dc.html` | Chế độ AI SDLC: preset chỉ đọc và chế độ tự tạo, giai đoạn, tài liệu, cổng (theo dự án), contract, tự duyệt, chạy thử | `/admin/sdlc-modes` | US8, US18 |
| `ProjectSettings.dc.html` (mục `#sdlc`, `#sdlc-auto`) | Bật AI SDLC, chế độ cho phép, đồng bộ, nơi chạy, Tự duyệt chỉ siết thêm | `/projects/$key/settings` | US8, US18 |
| `Policies.dc.html` (mục `#sdlc`) | Chính sách tổ chức: cho phép tự duyệt, sàn ngưỡng, `denyPaths`/`denyKeywords` | `/admin/policies` | US18 |
| `SdlcFleet.dc.html` | Đội máy AI SDLC: nhãn, run đang chạy theo hạng mục và bước, gói và quota, bật/tắt gói, Thêm máy (lệnh cài một dòng) | `/sdlc/fleet` | US13, US15 |
| `Machines.dc.html` | Máy (bản v2): sửa nhãn, "chỉ nhận run có nhãn", gói, mã đăng ký có nhãn; hộp thoại Gói agent (danh sách, bật/tắt, thêm gói đăng nhập từ web, T063). Bản v1 ở `v1/` | `/machines` | US14, US15 |

- Tweak `view` của `SdlcModes` (`edit`, `preset`, `dryrun`, `invalid`, `empty`, `loading`, `error`), `SdlcFleet` (`list`,
  `add`, `waiting`, `empty`, `loading`, `error`) và `Machines` (`list`, `edit`, `invalid`, `add`, `empty`, `loading`,
  `error`, `accounts`, `accounts-how`, `accounts-claude`, `accounts-codex`, `accounts-done`) mở từng trạng thái.
- `Sidebar.dc.html` chưa có mục `sdlc-modes` và `sdlc-fleet` (các màn gọi `active` với hai id đó): menu thật do
  `apps/web/src/lib/nav.ts` (T054) quyết định.
- Máy cá nhân chỉ hiện trạng thái và nhãn (ADR 0017); nút bật/tắt gói bị khoá khi worker không báo `accounts-remote`.
- Màn dùng được từ 360 px (thẻ máy xuống dòng, không bảng ngang).


## Bàn giao: Artifact MVP (spec 012, T005)

Thiết kế theo [spec đã chốt](../../../specs/012-artifacts/spec.md#clarifications),
[plan](../../../specs/012-artifacts/plan.md#ui) và [ADR 0023](../../adr/0023-artifacts.md).
Đã dùng `ui-ux-pro-max` cho mật độ công cụ cộng tác và bố cục hộp thoại; màu, chữ, độ bo giữ nguyên v2.
Đây là thiết kế tương tác với dữ liệu mẫu, chưa phải tính năng của web/app. Chưa đưa lên canvas hoặc sửa `canvas.json`.

| File | Màn / nơi dùng | Bàn giao |
|---|---|---|
| `ArtifactPanel.dc.html` | Tab artifact, thanh công cụ, năm loại MVP, khung cạnh chat hoặc toàn màn | T020; `layout=chat` cho chat + thẻ tham chiếu + đề xuất + khung |
| `ArtifactLibrary.dc.html` | `/artifacts`: tìm, lọc cá nhân/dự án, loại, nguồn, dự án, thùng rác; bảng/thẻ | T022, T030; `desktop=true` thêm bản đã tải |
| `ArtifactDetail.dc.html` | `/artifacts/:id[/v/:n]`: nội dung, phiên bản, liên kết, hoạt động | T022, T030; prop `tab` chọn vùng |
| `ArtifactVersions.dc.html` | Chọn hai bản, khác biệt dòng, cạnh nhau, đặt tên, xác nhận khôi phục | T021; tác giả người/run, nguồn, thời gian, kích thước và lời nhắn |
| `ArtifactShare.dc.html` | Cá nhân/dự án, xác nhận chia sẻ cả lịch sử, chuyển chủ, lối vào link công khai | T021; chuyển chủ xác nhận thu hồi link |
| `ArtifactPublicLink.dc.html` | Chọn phiên bản, hạn, URL một lần, danh sách và xác nhận thu hồi | T023; `maxDays` mô phỏng trần chính sách |
| `PublicArtifactPage.dc.html` | `/_artifact/s/:token`: tiêu đề, loại, bản, hạn, cảnh báo và vùng khung | T004, T015; 404 chung, 429, offline và lỗi biên dịch |
| `ArtifactFixRequest.dc.html` | Xem/sửa/bỏ lỗi, lời nhắn, chọn đích, xác nhận gửi | T023; `fromThread=false` chỉ cho cuộc trò chuyện mới |
| `AdminPublicLinks.dc.html` | `/admin/public-links`: bật/tắt, hạn tối đa, bảng/thẻ link, thu hồi | T031; chỉ metadata, không có lối mở nội dung |
| `AppLeader.dc.html` | Leader tối thiểu trong app: cuộc trò chuyện, chat, gửi, đề xuất, thẻ và khung | T041; `role=dev/writer/lead` |
| `AppArtifacts.dc.html` | Thư viện app, bộ lọc bản đã tải, bản offline | T041; dùng lại `ArtifactLibrary` |
| `Leader.dc.html` (biến thể) | Leader web và khung artifact | T030; `artifacts=true` mặc định; `false` xem thiết kế cũ |
| `AppNav.dc.html` (biến thể) | Leader và Artifact cho cả ba hồ sơ | T041; `artifacts=false` mô phỏng hub chưa hỗ trợ |

### Cách xem và trạng thái

- Mỗi màn mới có prop `lang=vi/en`, `dark`, `narrow` (360 px), `view` và `embedded`. Thanh có nhãn
  “Trạng thái thiết kế” chỉ dành cho người xem artboard; `embedded=true` ẩn thanh này. Trang công khai chỉ chọn prop
  trên canvas, không có thanh điều khiển trong trang.
- Tất cả 11 màn mới có `ready`, `loading`, `empty`, `error`, `offline`. `ArtifactPublicLink.empty` giữ form tạo nhưng
  danh sách chưa có link; `PublicArtifactPage.empty` dùng cùng 404 với link không hợp lệ.
- `ArtifactPanel`: thêm `newer`, `editing`, `runtime`, `compile`, `deleted`, `uncached`, `unavailable`. Chọn prop `type` hoặc loại trên thanh thiết kế để thử
  `markdown`, `code`, `html`, `mermaid`, `react`. Bản mới trong lúc sửa không thay nội dung đang gõ.
- `ArtifactLibrary` / `AppArtifacts`: `trash`; `ArtifactDetail.tab`: `content`, `versions`, `links`, `activity`.
- `ArtifactPublicLink`: `once`, `nonowner`, `disabled`, `limit`, `compile`, `secret`. Đổi `maxDays` để thử trần 1…30.
  Chỉ URL mẫu `EXAMPLE_ONLY` xuất hiện trong hộp một lần, không phải token dùng được.
- `ArtifactFixRequest`: `readonly`, `unavailable`, `overflow` (27 lỗi đầu vào, chỉ giữ 20).
  Mỗi lỗi và lời nhắn tối đa 2 000 ký tự. Bỏ hết lỗi vẫn gửi được nếu có lời nhắn.
- `AdminPublicLinks`: `disabled`; `PublicArtifactPage`: `notfound`, `ratelimited`, `compile`.
  Các nguyên nhân mã sai/hết hạn/thu hồi/chính sách tắt đều dùng cùng 404, không nêu nguyên nhân riêng.
- Nút và bộ lọc thực hiện chuyển trạng thái mẫu trong canvas, không gọi hub. Sao chép chỉ minh hoạ phản hồi;
  tải về là file mẫu. Dữ liệu mẫu dùng ngày 14/10/2026, hiển thị qua `Intl` theo ngôn ngữ.

### Bố cục và component khi triển khai

- Dùng component hiện có trong `@xdev-hive/ui`: `Button`, `Card`, `Badge`, `Field`, `Input`, `Select`, `Tabs`,
  `Alert`, `Skeleton`, `Empty`, `Table`, `Dialog`, `AlertDialog`, `Sheet`, `Resizable` theo shadcn/ui Base UI (ADR 0013).
  Markup/CSS trong artboard thể hiện bố cục; không chép chúng thành bộ component mới.
- Từ 1024 px: chat và khung chia đôi; cỡ khung 30–70% có điều khiển bàn phím. Triển khai nhớ cỡ và trạng thái đóng
  theo người dùng. Dưới 1024 px: `Sheet` toàn màn, nút “Về cuộc trò chuyện”; thẻ chat mở lại đúng bản.
  360 px: bảng thành thẻ, bộ lọc một cột, nút tối thiểu 44 px, không cuộn ngang trang.
- Hộp thoại trên canvas là bản xem không modal. Bản thật dùng Base UI để giữ focus, Escape đóng, trả focus về nút mở,
  cuộn bên trong và không che trường đang focus. Tên/miêu tả hộp và nhãn trường lấy từ cặp vi/en trong `renderVals()`.
  Lưu trạng thái lọc/tab/phiên bản trên URL khi triển khai, giữ cảnh báo khi rời bản sửa chưa lưu.
- Khi offline, app chỉ đọc bản đã tải; sửa, chia sẻ, lịch sử, tạo/thu hồi link, gửi chat và nhờ sửa đều tắt.
  Artifact chưa tải cần kết nối hub. Bộ đệm 200 MiB theo hồ sơ/tổ chức, xoá khi đăng xuất/đổi tổ chức.
  Không có hàng đợi sửa offline. Web mất mạng chỉ giữ nội dung đang mở, không hứa có thư viện offline.
- Khác biệt luôn có dấu `−` / `+` cùng token destructive/success; không chỉ dựa vào màu.
  Khôi phục tạo bản mới, không xoá lịch sử. Chia sẻ rộng hơn phải xác nhận cả phiên bản cũ.

### Quyền và vùng nội dung không tin cậy

- Chỉ chủ tạo link, kể cả khi người khác có quyền sửa. Hạn mặc định 7 ngày hoặc trần thấp hơn;
  không có link vĩnh viễn; tối đa 10 link còn hiệu lực. URL chỉ xuất hiện một lần, đóng/ẩn hộp là mất.
  Danh sách chỉ có bản, thời gian tạo/hạn, lượt xem, lần xem cuối và Thu hồi; không có nút lấy lại URL.
- Link ghim bản đang chọn, thay bản mới không tự cập nhật link. Chuyển chủ hoặc xoá artifact thu hồi mọi link.
  Tắt chính sách ngừng phục vụ ngay; bật lại chỉ cho link chưa hết hạn/thu hồi.
  Quét bí mật chặn tạo link, chỉ báo dòng/loại; lỗi biên dịch vẫn cho tạo kèm cảnh báo.
- Quản trị chỉ xem metadata artifact đã công khai và thu hồi link; không đọc artifact cá nhân từ màn quản trị.
  Cá nhân và dự án là hai phạm vi MVP. Không có lựa chọn đội/tổ chức, CDN hoặc chế độ che bí mật.
- Nội dung trong vùng xem là minh hoạ tĩnh/an toàn của artboard. Bản thật **bắt buộc** dùng `SandboxFrame` nạp URL vé
  cùng host hub (`/_artifact/frame/:ticket`), `sandbox=allow-scripts`, CSP chặn mạng và thư viện đóng gói sẵn;
  app nạp `hive-artifact://`. Không dùng `srcdoc`, không thực thi chữ của agent trong trang cha.
  “Dừng trang” gỡ iframe; lấy lỗi qua schema postMessage và kiểm `event.source` (T020).
- Trang công khai thật là HTML tĩnh không script, không SPA/RPC/cookie; chỉ tiêu đề đã escape, loại, phiên bản, hạn,
  cảnh báo ngoài khung và iframe. Không có tên tổ chức/chủ/dự án, lịch sử, chia sẻ hoặc nhờ Leader sửa.
  `data-dc-script` và `support.js` trong artboard chỉ dùng cho canvas, không đưa vào HTML công khai.
- “Nhờ Leader sửa” chỉ hiện khi có lỗi và có quyền Leader. Không có quyền: nút tắt kèm giải thích.
  Đích là cuộc trò chuyện đang mở của người xem hoặc một cuộc trò chuyện mới của chính họ;
  từ thư viện/chi tiết mặc định cuộc trò chuyện mới. Chỉ đọc thì Leader nhân bản cá nhân rồi sửa.
  Lỗi là dữ liệu không tin cậy; không tự gửi khi trang báo lỗi, không gửi quá 20 mục.

Phần sau MVP (T006) có làn riêng: soạn tay đầy đủ, Terminal Leader, chính sách artifact tổng thể, dung lượng,
liên kết task/run/dự án/hạng mục và chuyển thành tài liệu/lưu repo không được thêm vào các màn MVP này.

## Bàn giao: Điều khiển từ xa (spec 010, T006)

Thiết kế tương tác với dữ liệu mẫu, thiết kế trong repo, chưa đưa lên canvas hay sửa `canvas.json`. Bàn giao cho T014
(danh sách phiên, phát lại), T022 (terminal sống), T032 (mở phiên mới, ghép, thiết bị) và T052 (app desktop).

| File | Màn / nơi dùng | Trạng thái (`view`) |
|---|---|---|
| `Remote.dc.html` | Web điện thoại `/remote`: máy của tôi kèm trạng thái từ xa, phiên ghi, terminal có thanh phím và ô soạn dòng, bottom sheet Mở phiên mới, ghép thiết bị, thiết bị đã ghép, hướng dẫn cài PWA | `list`, `terminal`, `sheet`, `pair`, `devices`, `pwa`, `empty`, `loading`, `error`, `offline`, `http` |
| `AppRemote.dc.html` | App desktop, màn "Điều khiển từ xa": công tắc, thư mục được phép, thiết bị kèm QR ghép và Cho phép/Từ chối tại máy, phiên kèm Ngắt/Ngắt tất cả, hộp xác nhận, mã Authenticator, cảnh báo HTTP | `on`, `off`, `pairing`, `confirm`, `confirmAll`, `totp`, `http`, `loading`, `error` |

- Mặc định `Remote` ở 360 px (`narrow=true`); mọi nút chạm cao tối thiểu 44 px, thanh phím cuộn ngang trong khung của
  nó nên trang không cuộn ngang. Cả hai màn có `lang=vi/en`, `dark`, `embedded` như các màn khác.
- Nút Bật từ xa, Thêm thiết bị và Thêm thư mục chỉ có ở `AppRemote`. Web điện thoại chỉ tắt, gỡ thiết bị, ngắt phiên
  (FR-012): `Remote` không có công tắc bật.
- Máy offline hoặc chưa có thư mục được phép thì nút Mở phiên mới tắt và có chú thích lý do ngay dưới nút.
- Trên HTTP, cả hai màn hiện cảnh báo "nội dung phiên và phím gõ không được mã hoá"; mục PWA nói rõ cần HTTPS.
- Terminal trong artboard chỉ minh hoạ. Bản thật dùng `TerminalView` (xterm.js) với `terminalTheme`, tắt OSC 52 và hỏi
  xác nhận trước khi mở link.
- "Ngắt tất cả" và "Ngắt" luôn qua hộp xác nhận (`alertdialog`), nút huỷ là "Giữ lại".


## Đồng bộ tài liệu với repo (spec 018, T010)

Tám bản mẫu dưới đây là nguồn bàn giao cho T018, T020–T023 và phần desktop. Q1–Q12 được coi là đã chốt
ngày 15/10/2026 theo chỉ dẫn chủ dự án. Không đổi spec hay phần triển khai sản phẩm trong T010.

| File | Màn / route dự kiến | Biến thể riêng |
|---|---|---|
| [DocsSettings.dc.html](DocsSettings.dc.html) | Cài đặt dự án → Tài liệu; `/projects/$key/settings` | Mặc định PR, nhánh đổi, mất quyền, nhánh bảo vệ, thư mục chồng, chỉ đọc; xem trước đưa tài liệu hub vào PR riêng |
| [OrgDocsRepo.dc.html](OrgDocsRepo.dc.html) | Thẻ Kho tài liệu tổ chức cạnh kho skill | Chọn / tạo repo riêng tư, mặc định commit thẳng, `org/`, `teams/<slug>/`, tạm dừng, chồng kho skill, đội không tồn tại |
| [DocImport.dc.html](DocImport.dc.html) | `/knowledge/docs/import` | Quét, cây chọn, cảnh báo, tiến độ, huỷ, báo cáo, hết hạn mức API, xác nhận bí mật từng file |
| [DocsTree.dc.html](DocsTree.dc.html) | `/knowledge/docs` | Cây theo repo, đủ bảy nhãn đồng bộ, bộ lọc, tìm theo nghĩa, tìm theo từ, không có kết quả, file đã xoá trên repo |
| [DocConflict.dc.html](DocConflict.dc.html) | `/knowledge/docs/conflicts/$id` | Ba cột ở 1280 px; ba lựa chọn đổi bản ở 360 px; giữ hub / repo / sửa tay, phiên bản đã đổi, chỉ đọc, đã giải quyết |
| [DocExtracts.dc.html](DocExtracts.dc.html) | `/knowledge/docs/extracts` | File gốc + bản trích sửa được, duyệt / từ chối, chặn bí mật, PDF không có chữ, giữ bản đã duyệt cũ khi trích lại |
| [DocEditorAssets.dc.html](DocEditorAssets.dc.html) | `/knowledge/docs/$key/edit` | Ảnh minh hoạ, markdown tương đối, chọn file, tiến độ, quá lớn, kho đầy, link gãy, thiếu đối tượng LFS |
| [AppWriteSync.dc.html](AppWriteSync.dc.html) | Desktop `#/write` — Soạn tài liệu | Cây, nhãn, tìm kiếm, mất kết nối, chỉ đọc, chuyển VI/EN; mở màn xung đột dùng chung |

**Cách xem.** Khác các màn canvas cũ, tám file T010 mở trực tiếp được trong trình duyệt, không cần `support.js`
hay mạng ngoài. Chạy từ gốc worktree:

```sh
python3 -m http.server 48110 --bind 127.0.0.1
```

Mở `http://127.0.0.1:48110/docs/design-system/screens/DocsSettings.dc.html`. Mỗi file có thanh **Trạng thái xem**,
nút **Sáng / tối**, **Khung 360 px**; desktop có thêm **VI / EN**. Có thể mở thẳng bằng
`?theme=dark&view=loading&narrow=1`. Các giá trị `view` nằm trong ô chọn của từng màn. Mọi màn có
bình thường, đang tải, rỗng, lỗi và nút thử lại; nhấn Tab có viền focus, Escape đóng dialog,
phím mũi tên chuyển ba bản so sánh trên điện thoại. Đã xem ảnh chụp của cả tám màn ở 360/1280 px, sáng/tối.

**Handoff.** Dùng token v2 từ `ds/xdev-hive/tokens.css` và các quyết định đã sinh bằng UI UX Pro Max trong
[MASTER.md](../xdev-hive/MASTER.md). Phiên này không có skill `ui-ux-pro-max`; không sinh lại design system.
Khi triển khai, thay phần HTML minh hoạ bằng component shadcn/ui (Base UI) sẵn có: `Card`, `Button`, `Input`,
`Textarea`, `Select`, `Checkbox`, `RadioGroup`, `Badge`, `Alert`, `Progress`, `Dialog` và `Tabs` cho ba bản so sánh.
Các file tự chứa CSS/script vì phạm vi T010 không cho thêm runtime dùng chung; chưa nhập lại hay kiểm trên canvas.
Font dùng tên trong token và fallback hệ thống khi xem độc lập, không tải Google Fonts.

Các mẫu không gọi API, không lưu thật, không kiểm quyền phía máy chủ. Nút ghi chỉ thay trạng thái hoặc báo
**Mẫu thiết kế**; tìm kiếm trong bản mẫu lọc dữ liệu minh hoạ tại máy, kết quả tìm theo nghĩa là fixture.
Link Git dùng namespace `example`, cần thay bằng URL provider trả về khi triển khai. Ảnh trong editor là sơ đồ SVG
minh hoạ cho ảnh repo; nút chọn file chỉ trình diễn tiến độ, kéo thả/dán thuộc T018.
Desktop dùng cặp câu vi/en trong `data-en` và các thuộc tính tương ứng để bàn giao cho từ điển app.

Các hành vi cần giữ khi triển khai:

- Dự án mặc định PR; tổ chức mặc định commit thẳng; tắt đồng bộ vẫn giữ nội dung trên hub.
- Cấu hình cảnh báo phạm vi đọc; chặn thư mục chồng SDLC/kho skill. Tài liệu chưa có nhà cần xem trước và PR riêng.
- Nhãn PR đang mở khác nhãn đã đồng bộ. Nhánh đổi cần xác nhận và so lại toàn bộ; mất quyền vẫn cho lưu trên hub.
- File nghi có bí mật chỉ hiện loại và dòng, xác nhận riêng từng file bởi quản trị, có audit và hướng dẫn thu hồi.
- Bản trích chỉ ở hub; chỉ bản đã duyệt vào tìm kiếm/MCP. Bản cũ vẫn dùng tới khi bản mới được duyệt.
- Tải lên theo hạn mức hiện tại; LFS chỉ dùng khi repo đã có quy tắc khớp. Giữ đường dẫn markdown tương đối.
- Chỉ người quản lý được lưu cấu hình, duyệt hoặc giải quyết xung đột; trạng thái chỉ đọc vẫn đọc được.

**Kiểm tự động của bản mẫu.** Sau `pnpm install --frozen-lockfile`, giữ HTTP server ở terminal khác rồi chạy từ gốc
worktree đoạn dưới. Dùng Chromium đã cài của Playwright. Không cần hub, Postgres hay provider thật; kiểm toàn bộ
260 tổ hợp màn × kích thước × theme × trạng thái và các luồng tương tác chính. Không thay thế test ứng dụng
của T018/T020–T023.

```sh
node --input-type=module <<'JS'
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(`${process.cwd()}/apps/web/package.json`);
const { chromium, expect } = require('@playwright/test');
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:360,height:1000}});
const errors=[];
page.on('pageerror',e=>errors.push(String(e)));
page.on('response',r=>{ if(r.status()>=400) errors.push(`${r.status()} ${r.url()}`); });
const base='http://127.0.0.1:48110/docs/design-system/screens/';
const open=name=>page.goto(base+name+'.dc.html');
const view=value=>page.getByLabel('Trạng thái xem',{exact:true}).selectOption(value);
const click=name=>page.getByRole('button',{name,exact:true}).click();
const screens=['DocsSettings','OrgDocsRepo','DocImport','DocsTree','DocConflict','DocExtracts','DocEditorAssets','AppWriteSync'];
let combinations=0;
for (const name of screens) {
  for (const width of [360,1280]) {
    await page.setViewportSize({width,height:1000});
    for (const theme of ['light','dark']) {
      await page.goto(`${base}${name}.dc.html?theme=${theme}`);
      const states=await page.locator('#design-view option').evaluateAll(els=>els.map(el=>el.value));
      for (const state of states) {
        await view(state);
        const bounds=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,content:document.documentElement.scrollWidth}));
        assert(bounds.content<=bounds.viewport,`${name}/${width}/${theme}/${state}: tràn ngang`);
        await expect(page.getByRole('heading',{level:1})).toBeVisible();
        combinations++;
      }
      if (width===1280) {
        await view('ready');
        await click('Khung 360 px');
        const frame=await page.locator('.board').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth}));
        assert(frame.width<=360 && frame.content<=frame.width,'Khung 360 px bị tràn');
        await expect(page.locator('.nav')).toBeHidden();
        await click('Khung 360 px');
      }
    }
  }
}
assert.equal(combinations,260);
await page.setViewportSize({width:360,height:1000});
await open('DocsSettings');
await click('Đưa tài liệu hub vào repo');
await expect(page.getByRole('dialog')).toBeVisible();
await page.keyboard.press('Escape');
await expect(page.getByRole('dialog')).toBeHidden();
await click('Tạm dừng');
await expect(page.getByRole('button',{name:'Tạm dừng',exact:true})).toBeHidden();
await click('Dùng nhánh mới');
await click('Xác nhận nhánh mới');
await expect(page.locator('[data-home-status]')).toHaveText('✓ Đang hoạt động');
await view('readonly');
await expect(page.getByRole('button',{name:'Lưu cấu hình'})).toBeDisabled();
await open('OrgDocsRepo');
await page.getByLabel('Cách chọn repo').selectOption('new');
await expect(page.getByLabel('Tên repo riêng tư')).toBeVisible();
await open('DocImport');
await page.getByLabel('Chọn mọi file hợp lệ').uncheck();
await expect(page.getByRole('button',{name:'Nhập file đã chọn'})).toBeDisabled();
await page.getByLabel('Chọn mọi file hợp lệ').check();
await click('Nhập file đã chọn');
await expect(page.getByRole('progressbar')).toBeVisible();
await click('Xem báo cáo');
await click('Xem file bị chặn');
await expect(page.getByRole('button',{name:'Không phải bí mật, vẫn nhập'})).toBeDisabled();
await page.getByLabel('Tôi có quyền quản trị và đã kiểm tra riêng file này.').check();
await click('Không phải bí mật, vẫn nhập');
await expect(page.getByRole('heading',{name:'4. Báo cáo nhập'})).toBeVisible();
await open('DocsTree');
await page.getByLabel('Trạng thái đồng bộ',{exact:true}).selectOption('conflict');
assert.equal(await page.locator('[data-doc-row]:visible').count(),1);
await page.getByLabel('Tìm theo nghĩa hoặc từ khoá').fill('zzzz');
await expect(page.locator('#no-results')).toBeVisible();
await page.getByLabel('Chế độ tìm kiếm').selectOption('keyword');
await expect(page.locator('#keyword-help')).toBeVisible();
await open('DocConflict');
await expect(page.locator('[data-pane]:visible')).toHaveCount(1);
await page.getByRole('radio',{name:'Gốc chung',exact:true}).focus();
await page.keyboard.press('ArrowRight');
await expect(page.locator('[data-pane=hub]')).toBeVisible();
await page.getByRole('radio',{name:'Sửa tay',exact:true}).check();
await page.getByLabel('Nội dung kết quả').fill('# Bản hợp\nGiữ 6 bản sao lưu.');
await click('Lưu cách giải quyết');
await expect(page.getByRole('heading',{name:'✓ Đã giải quyết xung đột'})).toBeVisible();
await view('stale');
await expect(page.getByRole('button',{name:'Lưu cách giải quyết'})).toBeDisabled();
await open('DocExtracts');
await view('secret');
await expect(page.getByRole('button',{name:'Duyệt bản trích'})).toBeDisabled();
await click('Xác nhận không phải bí mật');
await click('Không phải bí mật');
await click('Duyệt bản trích');
await expect(page.getByText('✓ Đã duyệt. Bản mới được đưa vào tìm kiếm và cho agent đọc.')).toBeVisible();
await open('DocEditorAssets');
await click('Chèn ảnh');
await page.getByLabel('Chọn ảnh hoặc file').setInputFiles({name:'diagram.png',mimeType:'image/png',buffer:Buffer.from('prototype')});
await expect(page.getByRole('dialog')).toBeHidden();
await expect(page.getByRole('progressbar')).toBeVisible();
await open('AppWriteSync');
await click('VI / EN');
await expect(page.getByRole('heading',{name:'Write documents',exact:true})).toBeVisible();
await page.getByLabel('Preview state',{exact:true}).selectOption('offline');
await expect(page.getByRole('button',{name:'Save to hub'})).toBeDisabled();
await page.getByLabel('Preview state',{exact:true}).selectOption('ready');
await click('Save to hub');
await expect(page.locator('#feedback')).toHaveText('Prototype: saved to hub; pending synchronization.');
assert.deepEqual(errors,[]);
console.log(`PASS: ${combinations} tổ hợp; 8 luồng, bàn phím, quyền, tìm kiếm, tải lên, VI/EN; không có lỗi trình duyệt.`);
await browser.close();
JS
```

## Bảng điều khiển CI/CD và triển khai (spec 020, T003)

Tám bản mẫu dưới đây là nguồn bàn giao cho T011 (khung web, kết nối CI, token cá nhân), T021 (tab CI/CD), T022 (máy chủ,
môi trường, đích), T023 (bảng triển khai, trang lần triển khai) và T030 (duyệt, khoá, quay về). Làm theo plan.md mục 10, Q1–Q16 đã chốt ngày 17/10/2026, Navy Hive (token màu, sáng/tối,
360 px). Không đổi spec hay mã sản phẩm trong T003.

| File | Màn / route dự kiến | Các giá trị `view` |
|---|---|---|
| [CicdTab.dc.html](CicdTab.dc.html) | Tab CI/CD của dự án; `/projects/$key/cicd` | `ready`, `detail-jenkins` (giai đoạn + log), `input` (Jenkins chờ xác nhận), `detail-gitlab` (job, chạy job chờ tay), `params` (form Build with Parameters sinh từ tham số khai báo), `no-token` ("Chưa có token để đọc Jenkins"), `readonly`, `stale`, `loading`, `empty`, `error` |
| [CiConnections.dc.html](CiConnections.dc.html) | Quản trị → Kết nối CI; `/admin/ci-connections` | `ready`, `watcher-error` ("Không đọc được Jenkins", đổi người theo dõi), `test-ok`, `add`, `readonly`, `stale`, `loading`, `empty`, `error`. Có Jenkins, Argo CD, Kubernetes |
| [JenkinsTokens.dc.html](JenkinsTokens.dc.html) | Cài đặt cá nhân → Token Jenkins; `/settings/jenkins-tokens` | `ready`, `none`, `expired`, `adding`, `test-fail`, `stale`, `loading`, `empty` (chưa có kết nối), `error` |
| [Servers.dc.html](Servers.dc.html) | Quản trị → Máy chủ; `/admin/servers` | `ready` (danh sách), `new`, `install` (khoá công khai + lệnh cài), `tested`, `confirm` (xác nhận dấu vân tay), `detail`, `rotate` (đổi khoá), `hostkey` ("Host key của máy chủ đã đổi"), `unreachable`, `authfail`, `readonly`, `stale`, `loading`, `empty`, `error` |
| [DeployTargets.dc.html](DeployTargets.dc.html) | Hệ thống → Môi trường; `/systems/$systemId/environments` | `ready` (tab môi trường, chính sách duyệt, bảng đích), `edit-ssh`, `edit-jenkins`, `edit-gitlab`, `edit-argocd`, `edit-kubectl`, `conflict` (có người sửa trước), `locked`, `lock-dialog`, `readonly`, `stale`, `loading`, `empty`, `error` |
| [DeployBoard.dc.html](DeployBoard.dc.html) | Hệ thống → Triển khai; `/systems/$systemId/deploys` | `ready` (bảng "đang chạy", lịch sử), `approvals`, `deploy`, `deploy-prod`, `promote` (đẩy từ môi trường), `rollback`, `rollback-argocd`, `running-busy`, `locked`, `readonly`, `stale`, `loading`, `empty`, `error` |
| [DeployRun.dc.html](DeployRun.dc.html) | Lần triển khai; `/deploys/$id` | `running`, `running-k8s`, `reconnecting` (hub khởi động lại), `stale`, `waiting`, `success`, `failed`, `review`, `unknown`, `cancelled`, `cancel-dialog`, `external` (ngoài Hive), `readonly`, `loading`, `notfound`, `error` |
| [DeployApproval.dc.html](DeployApproval.dc.html) | Duyệt triển khai; `/deploys/$id` (khối duyệt) | `ready`, `jenkins-input` (duyệt = Proceed bằng token người duyệt), `no-token`, `self-request`, `readonly`, `reject-dialog`, `locked`, `expired`, `approved`, `rejected`, `stale`, `loading`, `empty`, `error` |

**Cách xem.** Như tám màn T010: mở trực tiếp được trong trình duyệt, không cần `support.js` hay mạng ngoài. Từ gốc
worktree chạy `python3 -m http.server 48110 --bind 127.0.0.1`, rồi mở
`http://127.0.0.1:48110/docs/design-system/screens/CicdTab.dc.html`. Mỗi file có ô **Trạng thái xem**, nút
**Sáng / tối**, **Khung 360 px**, và mở được thẳng bằng `?theme=dark&view=input&narrow=1`. Từ 900 px trở xuống (đo theo
khung chứa) thanh bên ẩn, thay bằng thanh trên có Menu, bảng thành thẻ.

**Handoff.**

- Chỉ tiếng Việt, theo yêu cầu của T003; không có nút VI/EN như các màn cũ.
- Các file nhúng sẵn token Navy Hive (từ `../tokens.json`, v3), vì `ds/xdev-hive/tokens.css` vẫn là bản v2 (xanh `#1D4ED8`,
  IBM Plex). Khi triển khai dùng token của web, không chép khối `<style id="tokens">`. Nên cập nhật `ds/` ở một việc riêng.
- Chữ dùng font hệ thống khi xem độc lập (không tải Be Vietnam Pro). Icon là SVG outline 1,5 px vẽ tay; thay bằng bộ icon
  của web khi làm.
- Dữ liệu mẫu giả: dự án `his-portal`, URL kiểu `jenkins.example.vn`, IP thuộc dải tài liệu (`192.0.2.x`,
  `198.51.100.x`). Không có IP hay tên máy nội bộ thật.
- Thay phần HTML minh hoạ bằng component shadcn/ui có sẵn: `Card`, `Button`, `Badge`, `Alert`, `Table`, `Tabs`, `Dialog`,
  `Select`, `Input`, `Textarea`, `Checkbox`, `RadioGroup`, `Progress`. Log dùng `LogCard` (T011 tách khỏi `run-page.tsx`).
- Bản mẫu không gọi API, không lưu thật, không kiểm quyền; nút ghi chỉ đổi trạng thái hoặc báo "Mẫu thiết kế".

Các hành vi cần giữ khi triển khai:

- Mỗi màn có đủ: bình thường, đang tải, rỗng, lỗi (nút Thử lại), và **dữ liệu cũ kèm giờ** khi nguồn không trả lời (Jenkins,
  Argo CD, GitLab, hub); phần khác của trang vẫn hiện.
- Trạng thái luôn có chữ và icon, không chỉ màu. Lần triển khai: chờ duyệt, chờ, đang chạy, thành công, thất bại,
  thất bại cần xem, không rõ kết quả, đã huỷ, bị từ chối, hết hạn. Lần Jenkins tự build mang nhãn **Ngoài Hive**.
- **Nút tắt luôn kèm lý do hiện ngay bên dưới**, nhất là: chưa có token Jenkins (kèm link Cài đặt cá nhân), thiếu quyền
  (`ci.operate`, `deploy.run`, `deploy.approve`, `servers.manage`, `ci.connections.manage`), đích đang có lần triển khai
  (ghi người và giờ), môi trường đang khoá, chưa có bản thành công để quay về, đích promote không có Quay về,
  người yêu cầu không tự duyệt, yêu cầu hết hạn.
- Token và khoá riêng không bao giờ hiện lại: ô token chỉ ghi, "Đã lưu". Tham số mật khẩu của Jenkins và biến đánh dấu
  bí mật không ghi giá trị vào audit và log (log hiện `***`). Khoá công khai và lệnh cài có nút sao chép.
- Host key đổi: dừng ngay, không chạy lệnh nào; xác nhận dấu vân tay mới cần lý do. Xác nhận lần đầu cần đối chiếu dấu
  vân tay và tick xác nhận. Đổi khoá giữ khoá cũ tới khi khoá mới kiểm thành công. "Hub không kết nối được" tách khỏi
  "Máy chủ từ chối khoá".
- Duyệt Jenkins có bước `input`: duyệt = Proceed, từ chối = Abort, đều bằng token của người duyệt; thiếu token thì không
  duyệt được. Từ chối cần lý do. Quay về đi qua duyệt của môi trường, ghi "quay về từ …", không hoàn tác dữ liệu; Argo CD
  cảnh báo tắt `autoSync` và cần tick đã hiểu.
- Hub khởi động lại giữa lần triển khai: hiện "Đang nối lại", các bước vẫn chạy trên máy chủ, không chạy lại bước nào.
- Form đích chọn một trong năm cách (`ssh-script`, `jenkins-job`, `gitlab-manual`, `argocd`, `kubectl`), mỗi cách hiện
  đúng nhóm trường của FR-013; sửa có phiên bản cấu hình, xung đột phiên bản được chặn kèm xem khác biệt.
