# Prompt chia việc cho các agent trong Hive

Dán phần **Prompt** bên dưới vào trang Chat của dự án trên hub Hive (leader agent). Leader sẽ tạo plan và task bằng `plan_create`, rồi giao cho các máy.

## Chuẩn bị trước khi dán

1. Trên hub Hive cũ, dùng một **project key mới** cho repo này, ví dụ `xdev-hive-v2`. Key `xdev-hive` đang giữ memory, tài liệu và AGENTS.md của hệ cũ. Nếu dùng chung key, Hive sẽ đồng bộ AGENTS.md cũ đè lên AGENTS.md của repo mới.
2. Trên máy chạy agent, thêm thư mục `~/Work/xDev/xdev-hive` (repo `tdduydev/xdev-hive`) vào project đó.
3. Máy chạy agent cần: Node 24+, pnpm 12, Go 1.27, Docker (test có database), Rust (chỉ task desktop).

## Prompt

```text
Bạn là leader của dự án xdev-hive-v2: bản viết lại xDev Hive trong repo tdduydev/xdev-hive.
Đã xong: M0 (khung repo, CI), M1a (Postgres, role, RLS theo tổ chức), M1b (đăng nhập email, GitHub,
GitLab, SSO bằng Better Auth). Hãy lập plan cho phần còn lại của M1 và việc chuẩn bị M2, M3,
rồi giao cho các agent.

ĐỌC TRƯỚC KHI LẬP PLAN (trong repo):
- docs/architecture.md: module của hub, mô hình dữ liệu, giao thức worker, thứ tự mốc M0–M8.
- docs/decisions.md: phạm vi, stack, phiên bản đã chốt.
- AGENTS.md: lệnh, quy ước, cách chạy test có database.
- docs/ui/m1-dang-nhap-to-chuc.html: mockup giao diện M1.

TẠO PLAN bằng plan_create, mỗi task vừa đúng một PR, có acceptance rõ và dependsOn đúng.
Danh sách task (giữ id, có thể tách nhỏ hơn nếu một task quá một PR):

M1c – API tổ chức (backend, module tenancy của hub):
- M1c-audit: bảng hive.audit_log append-only (hive_app chỉ INSERT, SELECT) + hàm ghi audit dùng
  chung; helper phân quyền theo vai trò tổ chức (owner/admin/member) và vai trò đội
  (admin/member/viewer). Acceptance: test RLS cho bảng mới; test helper phân quyền.
- M1c-org (dependsOn M1c-audit): orgs.create (chỉ người đầu tiên của hub hoặc người được admin
  hub cho phép), orgs.mine, orgs.get, orgs.update. Hợp đồng ở packages/contracts. Liên kết
  org_members.user_id với auth."user". Acceptance: test API + RLS, audit cho mọi thao tác ghi.
- M1c-team (dependsOn M1c-org): teams CRUD, thành viên đội và vai trò đội, systems CRUD theo
  mockup màn 3. Acceptance: viewer không ghi được; admin đội chỉ quản lý đội của mình.
- M1c-invite (dependsOn M1c-team): lời mời bằng link dùng một lần (lưu băm mã, hết hạn 7 ngày),
  nhận lời mời sau khi đăng nhập hoặc đăng ký email bằng mã mời, gán vai trò tổ chức và đội.
  Acceptance: mã sai/hết hạn/đã dùng bị từ chối; test đủ luồng.
- M1c-sso (dependsOn M1c-invite): API cấu hình SSO OIDC theo tổ chức (admin tổ chức), chính sách
  người đăng nhập SSO lần đầu (vào hàng chờ duyệt hoặc tự thêm làm thành viên), duyệt người chờ.
  Acceptance: test luồng OIDC đầy đủ với IdP giả lập (oauth2-mock-server hoặc tương đương).

M1d – Giao diện (web, chỉ làm khi người quản trị đã duyệt mockup docs/ui/m1-dang-nhap-to-chuc.html):
- M1d-shell: TanStack Router, token màu/chữ theo mockup, khung app (sidebar, chọn tổ chức),
  client đăng nhập. Acceptance: Playwright mở được trang, đúng light/dark.
- M1d-login (dependsOn M1d-shell, M1c-org): màn Đăng nhập và Tạo tổ chức theo mockup màn 1–2.
- M1d-admin (dependsOn M1d-shell, M1c-team, M1c-invite): màn Đội và hệ thống, Thành viên, Mời người.
- M1d-sso (dependsOn M1d-admin, M1c-sso): màn Cài đặt đăng nhập.

Chuẩn bị M2 và M3 (chạy song song với M1, không đụng module tenancy):
- M2-mockup: vẽ mockup HTML tự chứa docs/ui/m2-du-an.html cho danh sách dự án, wizard tạo dự án
  (repo mới/có sẵn, GitHub/GitLab, template, máy, quyền) và màn tiến trình. Không viết code giao
  diện. Acceptance: người quản trị duyệt.
- M2-gitprovider: interface GitProvider trong module scm (checkAccess, getRepo, createRepo,
  commitFiles, protectBranch, openPR, addWebhook, removeWebhook) + bản GitHub App (@octokit/app) và
  GitLab (@gitbeaker/rest). Không gọi mạng thật trong test: dùng undici MockAgent.
  Acceptance: test từng phương thức, cả lỗi 401/403/409/429.
- M3-worker-ws: phía worker Go: nối WSS tới hub (github.com/coder/websocket), gói hello/welcome
  theo packages/contracts/src/worker-protocol.ts, kết nối lại có backoff, sinh client OpenAPI bằng
  oapi-codegen v2 từ packages/contracts/openapi.json. Test với server WSS giả trong Go.
  Acceptance: go test xanh trên Linux, macOS, Windows (CI).

QUY TẮC CHO MỌI TASK (ghi vào note của từng task):
1. Làm trên nhánh ai/<task-id>, mở PR vào main. Không push thẳng main.
2. Trước khi mở PR: pnpm check xanh (lint, typecheck, ranh giới module, test); task Go thêm
   gofmt, go vet, go test.
3. Bảng mới phải bật và ép RLS, có policy USING + WITH CHECK, có test. Mọi truy vấn dữ liệu tổ
   chức đi qua withTenant().
4. Đổi bảng: sửa schema.ts rồi pnpm --filter @xdev-hive/hub db:generate. Không sửa migration đã
   merge. Chỉ một task có migration được chạy cùng lúc: các task backend M1c đã nối dependsOn để
   tránh trùng số migration; không giao song song task nào khác có migration.
5. Đổi packages/contracts thì chạy pnpm openapi và commit openapi.json.
6. Module của hub chỉ import module khác qua index.ts.
7. Chữ trên giao diện và thông báo lỗi viết tiếng Việt. Không commit secret.
8. Không sửa docs/architecture.md, docs/decisions.md. Muốn đổi thiết kế thì ghi đề xuất trong mô
   tả PR để người quản trị quyết.
9. Task giao diện chỉ bắt đầu khi mockup tương ứng đã được duyệt.
10. Kết thúc: task_update sang review, note ghi Đã làm / Chưa làm / Cách kiểm / Rủi ro, kèm link PR.

GIAO VIỆC:
- Task Go (M3-worker-ws) ưu tiên Codex; task backend có RLS và đăng nhập ưu tiên Claude Code;
  task giao diện giao cho agent đang rảnh. Điều chỉnh theo máy và agent thực có trên hub.
- Review chéo: PR của một agent được một agent CLI khác review trước khi người quản trị merge.
- Chạy song song tối đa 3 task, với điều kiện không đụng cùng file: một chuỗi M1c, M2-gitprovider,
  M3-worker-ws.

Trước khi tạo plan, đọc board và danh sách máy, rồi trình bày plan (task, dependsOn, agent dự
kiến) để người quản trị xác nhận. Chỉ dispatch sau khi được xác nhận.
```
