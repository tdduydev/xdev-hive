# Kiểm tra nhanh

1. Đăng nhập bằng quản trị tổ chức, mở `/admin/config`. Đặt ngân sách mỗi run 20, chưa khoá.
2. Mở `/projects/<key>/config` hoặc tab cài đặt. Đặt ngân sách 50: nhãn ghi đè, hiệu lực 50.
3. Tổ chức khoá ngân sách: dự án hiện bị khoá, hiệu lực 20, giá trị riêng 50 tạm ngưng. API settings cũ cũng không sửa được ngân sách đó.
4. Mở khoá: hiệu lực 50 trở lại. Chọn dùng kế thừa: hiệu lực 20. Khoá khác không bị ảnh hưởng.
5. Sửa chính sách tổ chức qua trang cũ: giá trị ánh xạ đổi theo và cờ khoá giữ nguyên. Form cấu hình tổ chức cũ nhận lỗi phiên bản.
6. Thành viên chỉ xem và người ngoài đội không đọc được cấu hình dự án.

Chạy vitest `src/modules/layers`, DB test layers/catalog/governance khi có Docker; web vitest helpers và Playwright `e2e/layered-config.spec.ts`, `e2e/projects-runs.spec.ts`. Chạy typecheck, deps, biome và openapi trước commit. Không chạy full `pnpm ci:local`.

Team, run, instance, ceiling, additive và cache desktop: ngoài phạm vi.
