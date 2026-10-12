# Thiết kế màn (Claude Design, bản 2026-10-12)

Bản chép đầy đủ canvas "xDev Hive — các màn còn thiếu" trên Claude Design:
https://claude.ai/artifact/2iBZNpAxyzovmmVKL5L9cW

Canvas là nơi sửa. Sửa trên canvas rồi chép lại vào đây, không sửa tay hai nơi. Bản cũ (design system v1, 8 màn)
nằm trong [`v1/`](v1/README.md).

## Thư mục

| Đường dẫn | Là gì |
|---|---|
| `*.dc.html` | 40 artboard, mỗi file một màn hoặc một thành phần dùng chung. Tên file là tên artboard trên canvas |
| `canvas.json` | Bố cục canvas: vị trí, kích thước, tiêu đề từng artboard, các hàng và ghi chú |
| `ds/xdev-hive/` | Token v2 mà artboard nạp (`tokens.css` sinh từ `tokens.json`, cùng giá trị với `../tokens.json`) |
| `v1/` | Thiết kế cũ theo design system v1 (navy, `canvas`/`surface`) |

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
| `AppNav.dc.html` | Mọi màn app máy | Một app, menu theo quyền (`role` = dev, writer, lead); `compact` chỉ còn icon |

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
| `AppDocs.dc.html` | Chọn thư mục, viết tài liệu từ code bằng gói thuê bao; khung chat theo đúng Claude Code hoặc Codex; hộp tài khoản AI |
| `AppSkills.dc.html` | Skill áp cho thư mục, cài vào `.claude/skills/` và `.agents/skills/` |
| `AppTokens.dc.html` | Ngữ cảnh theo nhóm của `/context`, thứ tiêu hạn mức theo `/usage`, gợi ý tối ưu |
| `AppSetup.dc.html` | Môi trường: CLI, runtime, công cụ, MCP, thư viện dự án, kèm lệnh cài |

Chế độ quyền, lệnh `/`, cách đăng nhập và đường dẫn skill trong `AppDocs` và `AppSkills` lấy từ Claude Code 2.1.296
và codex-cli 0.162.1 cài trên máy dev ngày 2026-10-12. Định dạng từng dòng thao tác trong khung chat và chữ của Approve
for me chưa đối chiếu với phiên tương tác thật.

## Phần thiết kế chưa có trong code

- Hub chưa đồng bộ skill với repo `tdduydev/xdev-skills`; skill vẫn nằm trong Postgres.
- Chưa có trình soạn tài liệu, quy trình duyệt cấu hình được, vai trò tự tạo, chính sách agent, kết nối gói thuê bao
  trong app.
- Chưa có i18n: web và app hiện chỉ có tiếng Việt.
