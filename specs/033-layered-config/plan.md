# Kế hoạch: Cấu hình hai lớp

Nhánh `ai/SPEC033`, cập nhật 23/10/2026 theo [spec.md](spec.md).

1. Contract chỉ nhận `org` và `project`, trả giá trị, nguồn, chuỗi hai lớp và cờ khoá. Bỏ API team và mọi trường ceiling.
2. Engine thuần sắp tổ chức trước dự án; dự án ghi đè khi tổ chức chưa khoá. Registry chỉ gồm bốn khoá đã có nơi dùng. Không giữ additive khi chưa cần.
3. Adapter dùng chính sách tổ chức và settings dự án làm nguồn. `inheritedConfigKeys` đánh dấu khoá dự án quay về kế thừa, tránh bỏ trường `merge.mode` bắt buộc trong settings cũ. Dữ liệu cũ có giá trị rõ ràng vẫn là ghi đè.
4. Service ghi tổ chức tái dùng `saveAgentPolicy` cho khoá ánh xạ; móc đường ghi chính sách cũ cập nhật phiên bản và giữ khoá. Đường ghi dự án mới tái dùng `updateProjectSettings`, kiểm khoá cho cả API cũ và mới. Khoá transaction theo tổ chức tránh ghi vượt thao tác khoá.
5. Quyền và audit dùng module hiện có qua `index.ts`. Tiêm guard qua `app.ts` để tránh vòng phụ thuộc. Những nơi đang đọc quyền, ngân sách và merge lấy giá trị hiệu lực; không thêm nghiệp vụ thực thi.
6. Web có `/admin/config`, liên kết menu cấu hình; `/projects/$key/config` và phần cấu hình hai lớp ngay trong tab cài đặt dự án. Form chỉ đọc khi thiếu quyền hoặc bị khoá, hiển thị nguồn và giá trị riêng bị tạm ngưng.
7. Sửa toàn bộ tài liệu spec theo hai lớp. Sinh lại migration 0087 và snapshot ở bước cuối, giữ số theo điều phối, thêm FORCE RLS. Sinh OpenAPI và chạy kiểm tra liên quan trước commit tại máy.

## Ngoài phạm vi

- Lớp team: ngoài phạm vi.
- Lớp run: ngoài phạm vi.
- Lớp instance: ngoài phạm vi.
- Ceiling và hạ giá trị khi đọc: ngoài phạm vi.
- Additive/allowlist: ngoài phạm vi.
- Cache desktop và TTL ngoại tuyến: ngoài phạm vi.
- Giao diện lịch sử, chuyển đội, tích hợp sandbox/skill/MCP: ngoài phạm vi.
- Delivery, SDLC, tenancy, worker và desktop: ngoài phạm vi thay đổi.

## Kiểm tra

Biome toàn repo, typecheck hub/web/contracts, `pnpm deps`; vitest layers và các bài liên quan catalog/governance/runs, contracts, web; Playwright các màn đã sửa; sinh `pnpm openapi`. DB test cần Docker; khi Docker hoạt động thì chạy tại máy. Không chạy full CI tại máy.
