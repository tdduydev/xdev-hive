# Goal: làm đủ tính năng theo thiết kế v2

## Câu goal

> Làm cho mọi màn trong `docs/design-system/screens` (web và app desktop) chạy bằng dữ liệu thật của hub hoặc của
> máy, đúng bố cục, chữ VI/EN, sáng/tối của thiết kế. Không còn route "Sắp có", không còn số liệu mẫu. Mọi yêu cầu
> ROLE, POL, WF, DOC, SKILL, MCP, OPS, DESK trong `docs/srs.md` ở trạng thái Implemented, có test kiểm chứng ghi ở cột
> Verification. Mỗi phần merge vào `main` với CI xanh, chạy trên máy 34, và app desktop có bản cài cho macOS, Windows,
> Linux trong GitHub Release.

## Thế nào là xong

Một màn hoặc tính năng chỉ tính là xong khi đủ các điều sau (theo `docs/feature-checklist.md`):

1. Bố cục, trạng thái (trống, đang tải, lỗi, không có quyền) và câu chữ đúng file `.dc.html`, dựng bằng component
   shadcn/ui và token màu, import bằng alias `@/`.
2. Dữ liệu thật: API hub (hợp đồng trong `packages/contracts`, `openapi.json` khớp) hoặc lệnh Rust của app. Không số mẫu.
3. Quyền do hub chặn; giao diện chỉ ẩn hoặc tắt. Bảng mới bật và ép RLS, `rls.db.test.ts` xanh.
4. Test: hub `*.db.test.ts`, web Playwright (VI/EN, sáng/tối, 360px), desktop Vitest và `cargo test`.
5. Yêu cầu SRS tương ứng chuyển sang Implemented, ghi tên test ở cột Verification.
6. Merge vào `main` khi CI xanh; tự deploy lên máy 34; app desktop đóng gói qua workflow `Desktop`.

## Hiện trạng (2026-10-12)

### Web

| Màn | Trạng thái | Còn thiếu | Spec / SRS |
|---|---|---|---|
| Home, Runs, Leader, Plan, Projects, ProjectSettings, ProjectSandbox, OrgSandbox | Xong | — | — |
| Onboarding, Invite, McpConsent, Status, Login | Xong | — | — |
| Members, Teams, LoginSettings | Xong | Nút "Gửi lại" lời mời (hub chưa có thao tác) | TEN |
| Docs | Một phần | Nút sửa mở DocEditor | 005, DOC-01…05 |
| DocEditor | Chưa | Cả màn: khối Tiptap, đề xuất AI, bình luận neo, phiên bản | 005, DOC-01…05, ADR 0015 |
| Skills | Một phần | Đồng bộ hai chiều với kho Git | 006, SKILL-01…05, ADR 0014 |
| Memory, Proposals | Xong | — | KNOW |
| Workflows | Chưa ("Sắp có") | Quy trình duyệt AI-DLC, Spec Kit, BMAD, tự tạo | 004, WF-01…05 |
| DocReview | Chưa ("Sắp có") | Hàng chờ tôi duyệt, diff, AI tự kiểm, truy vết R-n | 004, WF-01…05 |
| Roles | Chưa ("Sắp có") | Vai trò tự tạo dạng cây quyền, gán cho người và đội | 001, ROLE-01…04 |
| McpTools | Một phần | Quy tắc MCP server ngoài và phát xuống máy chạy | 003, MCP-05, MCP-06 |
| Policies | Chưa ("Sắp có") | Model, quyền CLI, hook, file hướng dẫn, giới hạn | 002, POL-01…05 |
| Audit | Một phần | Lưu giữ theo chính sách tổ chức (365 ngày) | 007, OPS-07 |
| Sidebar | Một phần | Số đếm (badge) trên mục | — |

### App desktop

| Màn | Trạng thái | Còn thiếu | Spec / SRS |
|---|---|---|---|
| AppNav | Xong | — | 008 T004, T008, T023 |
| AppRegister | Xong | — | DESK-02 |
| AppTray | Xong | — | 008 T004–T006, DESK-03 |
| AppHome | Xong | — | 008 T007–T009, DESK-04 |
| AppDocs | Xong | Hộp tài khoản AI chưa có đăng xuất và chuyển gói khi hết hạn mức | 008 T010–T013, DESK-05 |
| AppSkills | Xong | — | 008 T014–T016, DESK-06 |
| AppTokens | Xong | Gợi ý có nút áp dụng (cần dữ liệu MCP/skill theo thư mục) | DESK-07 |
| AppSetup | Một phần | Dò MCP server, `.hive/setup.sh`, yêu cầu theo chính sách tổ chức | DESK-08 |
| Đăng nhập người dùng | Xong | — | 008 T023, DESK-09 |
| Cập nhật app | Chưa | Bật Tauri updater (khoá ký, manifest trên hub) | 008 T025, DESK-10 |

## Thứ tự làm

Mỗi bước là một hoặc vài PR. Bước sau dùng kết quả của bước trước:

1. **Vai trò tự tạo** (spec 001). Quyền dạng cây là nền cho Audit (`audit.read`), người duyệt của Workflows, writer của
   app desktop.
2. **Desktop: danh tính và khung**: token cá nhân trong keychain (T023), khay 7 trạng thái (T004), bộ chọn thư mục và
   AppHome (T007, T008).
3. **Đồng bộ skill với Git** (spec 006), rồi **AppSkills** (T014–T016) dùng kho skill đó.
4. **Quy trình duyệt và DocReview** (spec 004).
5. **Trình soạn tài liệu** (spec 005), rồi **AppDocs** (T010–T013).
6. **Chính sách agent** (spec 002, có phần worker Go), rồi AppSetup đọc yêu cầu từ chính sách.
7. **MCP server ngoài** (MCP-05/06), lưu giữ nhật ký (OPS-07), badge sidebar, gửi lại lời mời, Tauri updater (T025).

## Cần người quyết hoặc cấp

- Các mục **NEEDS CLARIFICATION** trong `specs/001`…`008`: trả lời trước khi làm spec đó.
- Kho skill Git (thiết kế ghi `tdduydev/xdev-skills`): đã có chưa, ai có quyền ghi.
- HTTPS và tên miền cho hub: OAuth MCP (MCP-02) và app desktop đăng nhập qua trình duyệt cần HTTPS.
- Chứng chỉ ký mã: Apple Developer (macOS notarize) và chứng chỉ Windows; thiếu thì bản cài vẫn chạy nhưng hệ điều
  hành cảnh báo (`docs/releasing.md`).
- Khoá ký Tauri updater (`TAURI_SIGNING_PRIVATE_KEY`) khi bật cập nhật tự động.
