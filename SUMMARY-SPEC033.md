# Tóm tắt SPEC033 — cấu hình hai lớp

Nhánh `ai/SPEC033`, tiếp tục phần dở ngày 23/10/2026. Commit hoàn tất: `feat(config): simplify configuration to organization and project layers`. Mã commit được bổ sung sau commit trong bản điều phối tại `C:/Users/duytd20/.xdev-hive/fleet/agents/SUMMARY-SPEC033.md`.

## Đã làm

- Chỉ còn tổ chức/dự án, ghi đè và khoá. Bỏ ceiling, overCeiling, additive chưa cần và API đội; không thêm cache desktop.
- Bốn khoá: quyền CLI, ngân sách mỗi run, chế độ merge và yêu cầu CI. Giữ giá trị riêng khi bị khoá, khôi phục khi mở khoá; có thao tác trở về kế thừa.
- Chính sách tổ chức/settings là nguồn giá trị duy nhất của các khoá ánh xạ. Đường ghi cũ/mới kiểm khoá, quyền, phiên bản và audit. Tuần tự hoá ghi chính sách trước khi đọc để tránh dữ liệu cũ khi ghi đồng thời.
- Những nơi đọc run/merge đang có dùng giá trị hiệu lực hai lớp; ngân sách riêng được cao hơn giá trị chung nếu chưa khoá.
- Trang `/admin/config` có công tắc khoá; `/projects/$key/config` và phần cấu hình trong cài đặt dự án hiển thị kế thừa, ghi đè, khoá và giá trị tạm ngưng. Nhãn và thông báo tiếng Việt.
- Sinh lại migration 0087 tại chỗ, metadata và OpenAPI. CHECK chỉ nhận org/project, bật và ép RLS. Đối chiếu snapshot 0086/0087: chỉ thêm config_layer_entries, không đổi bảng cũ.
- Viết lại spec/plan/tasks và tài liệu phụ; ghi từng phần bị cắt là ngoài phạm vi.

## File chính

- `apps/hub/src/modules/layers/` và test; các adapter/guard trong `modules/catalog`, `modules/governance`, đường đọc `modules/runs/engine.ts`, `app.ts`, `main.ts`.
- `apps/hub/src/{runs,merge-queue,project-settings}.db.test.ts`: kiểm luồng thật và đường HTTP.
- `apps/web/src/pages/projects/config-page.tsx`, `pages/project-settings-page.tsx`, router/menu, test và hai spec Playwright liên quan.
- `packages/contracts/src/{layered-config,projects}.ts`, `packages/contracts/openapi.json`.
- `apps/hub/db/migrations/0087_layered_config.sql`, metadata và `specs/033-layered-config/`.

## Kiểm tra

Các lệnh pnpm dùng `npx.cmd -y pnpm@12.11.2` vì PowerShell chặn npx.ps1; log dài được lọc bằng Select-Object -Last.

- `pnpm biome check --write .`: đạt, còn 40 warning và 2 info có sẵn; không có lỗi.
- `pnpm --filter @xdev-hive/hub --filter @xdev-hive/web --filter @xdev-hive/contracts typecheck`: đạt. Chạy lại hub sau khi thêm test HTTP/run/merge cũng đạt.
- `pnpm deps`: đạt, không vi phạm ranh giới/vòng phụ thuộc. Có cảnh báo compiler TypeScript 7 của dependency-cruiser.
- `pnpm --filter @xdev-hive/hub exec vitest run --project unit src/modules/layers src/modules/catalog src/modules/runs src/app.test.ts`: 12 file, 138 test đạt.
- `pnpm --filter @xdev-hive/hub exec vitest run --project db src/modules/layers src/modules/catalog src/modules/governance src/modules/runs`: 9 file, 139 test đạt. Docker hoạt động trên máy này.
- `pnpm --filter @xdev-hive/hub exec vitest run --project db src/runs.db.test.ts src/project-settings.db.test.ts src/merge-queue.db.test.ts`: API/merge đạt 27 test. Fixture run tham số hoá ban đầu trùng tên máy gây hai ca lỗi; đã sửa và chạy lại `pnpm --filter @xdev-hive/hub exec vitest run --project db src/runs.db.test.ts`: 69 test đạt. Tổng ba file DB này: 96 test đạt.
- `pnpm --filter @xdev-hive/contracts exec vitest run`: 28 file, 595 test đạt.
- `pnpm --filter @xdev-hive/web exec vitest run src/pages/projects/config-page.test.ts src/lib/project-settings.test.ts src/lib/nav.test.ts`: 3 file, 66 test đạt.
- `pnpm --filter @xdev-hive/web exec playwright test layered-config.spec.ts projects-runs.spec.ts`: 27 test đạt; HIVE_WEB_E2E_PORT=4333, HIVE_WEB_E2E_WORKERS=2.
- `pnpm --filter @xdev-hive/hub db:generate --name layered_config`: đạt, giữ số 0087 và thêm lại FORCE RLS.
- `pnpm openapi`: đạt, có thay đổi nội dung thực.
- `git diff --check`: đạt.

Không chạy full pnpm ci:local. Không cần cài dependency mới. Không sửa Go/Rust nên không chạy kiểm tra Go/Rust.

## Phần còn lại và rủi ro

- Không còn việc triển khai trong phạm vi đã chốt. Full GitHub CI phải đạt trước merge; chưa push, mở PR hay deploy.
- Migration 0087 sửa tại chỗ vì chưa merge; không dùng để nâng cấp database đã áp dụng bản 0087 cũ. Giữ số theo điều phối; không fetch hoặc bắt đầu merge mới.
- Giá trị rõ ràng của dự án cũ vẫn là ghi đè đến khi chọn kế thừa. Dự án mới đánh dấu cả bốn khoá là kế thừa.
- Chính sách chưa ánh xạ (model, quyền riêng của máy, sandbox...) giữ nghiệp vụ hiện có. Không sửa delivery, SDLC, tenancy, desktop hay worker/internal/config.
- Playwright còn warning React key trùng của fixture trên màn cài đặt cũ; các bài kiểm đều đạt.
- Worktree ban đầu còn merge dang dở từ agent trước (MERGE_HEAD 02fd1b53, bản main có SPEC031). Đã hoàn tất merge bằng commit riêng với đúng nội dung staged ban đầu, đối chiếu checksum trước commit. Không sửa nội dung Go và không trộn chúng vào commit tính năng SPEC033.
