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

## Màn web

| File | Màn | Route |
|---|---|---|
| `Home.dc.html` | Trang chủ | `/` |
| `Main.dc.html` | Lượt chạy (DataTable 1.286 dòng mẫu) | `/runs` |
| `Leader.dc.html` | Leader | `/leader` |
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
