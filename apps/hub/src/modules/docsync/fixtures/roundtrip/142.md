# Kiểm tra UI — SPEC11UI2

## Phạm vi đã đối chiếu

| Yêu cầu | Bằng chứng |
|---|---|
| SC-009, T054/T055 | Web và desktop tạo hạng mục, trả lời câu hỏi, duyệt spec/plan/research và bản tách, chạy đợt, thấy liên kết PR. Web mở PR trong cửa sổ mới; desktop kiểm liên kết PR qua Vitest. |
| D27, T055 | Mọi đội là BA/PO hoặc viewer → hồ sơ writer; quyền ghi AI SDLC vẫn tính theo từng đội. Màn cần hub mời kết nối khi chưa liên kết tài khoản. |
| SC-016, T055 | Desktop mở ba dự án, chuyển tab và thu hồi tự duyệt; web giữ bộ kiểm hạng mục nhiều dự án có sẵn. |
| US15, T062 | Đội máy hiển thị run/quota, lọc đội, điều khiển gói theo quyền hub trả; mã đăng ký có nhãn và lệnh cài ba OS; trang Máy sửa nhãn/cờ. |
| US8, FR-056, T084 | Sao chép preset, cấu hình giai đoạn/tài liệu/cổng/bước, chạy thử, lưu/xoá; lỗi tự duyệt hiện ở giai đoạn vi phạm. |
| SC-012 | Các màn mới kiểm không tràn ngang ở 360 px, sáng/tối; ảnh trong thư mục bên dưới. |

Các lỗi UI đã sửa khi rà soát: lọc quyền menu mới; giữ dấu phẩy/dòng mới khi nhập danh sách; sinh mã và đường dẫn
tài liệu duy nhất giữa các giai đoạn; làm mới hạng mục sau quyết định duyệt; Tailwind desktop quét package UI dùng chung.

## Kết quả kiểm tra

- `pnpm install --frozen-lockfile`: thành công.
- `pnpm biome check --write .`: thành công; 16 cảnh báo và 1 thông tin có sẵn, không thêm cảnh báo ở file mới.
- `pnpm --filter @xdev-hive/web typecheck`, `pnpm --filter @xdev-hive/desktop typecheck`,
  `pnpm --filter @xdev-hive/sdlc-ui typecheck`: thành công.
- `pnpm --filter @xdev-hive/web test`: 36 file, 590 test qua.
- `pnpm --filter @xdev-hive/desktop test`: 26 file, 208 test qua.
- `pnpm --filter @xdev-hive/sdlc-ui test`: 10 file, 55 test qua.
- `HIVE_WEB_E2E_PORT=4392 HIVE_WEB_E2E_WORKERS=2 pnpm --filter @xdev-hive/web exec playwright test
  e2e/sdlc.spec.ts e2e/sdlc-multi.spec.ts e2e/sdlc-mvp.spec.ts e2e/sdlc-fleet.spec.ts e2e/sdlc-modes.spec.ts`:
  25 bài qua sau thay đổi cuối.
- Kiểm hồi quy cùng 5 spec trên và `e2e/machine-accounts.spec.ts e2e/reviews.spec.ts e2e/workflows.spec.ts`:
  79 bài qua; 12 bài chụp ảnh máy có điều kiện được bỏ qua vì không đặt `HIVE_SHOTS_DIR`.
- `pnpm --filter @xdev-hive/desktop build`: thành công, có cảnh báo kích thước chunk lớn.

Không chạy `pnpm ci:local` theo quy tắc kiểm của PO. Không sửa hub, worker, contracts, migration hay Rust nên không
chạy kiểm DB, Go, OpenAPI hoặc Cargo. Kiểm UI dùng hub giả; chưa xác nhận toàn luồng với hub thật hoặc ứng dụng Tauri.

## Ảnh

11 ảnh trong [screenshots/spec11ui2](../../apps/web/e2e/screenshots/spec11ui2): bảng, chi tiết, câu hỏi, đội máy và
cấu hình chế độ đều có sáng/tối ở 360 px; thêm ảnh cài đặt dự án ở giao diện tối. Ảnh dùng dữ liệu giả, không có token thật.

## Phần còn chờ

- T054: hàng số liệu trong chính sách tổ chức chưa có contract; không tạo số liệu giả.
- T082: chỉ số tổng hợp chưa có API; mục Tiến độ desktop dùng danh sách giai đoạn/độ phủ hiện có.
- T091: đã đối chiếu phần UI và lưu ảnh. Chưa chạy `/speckit-analyze` toàn bộ đặc tả; giữ task mở để đợt tích hợp
  kiểm tiếp cả phần hub/worker và những mâu thuẫn ngoài phạm vi UI.
- Quyền trên web vẫn theo tổ chức như phiên bản trước; hub phải kiểm lại theo đội/dự án. Kiểm UI không thay cho
  kiểm RLS và quyền của hub. Phần nối T070 thuộc SPEC11HUB.
