# Kiểm tra UI — SPEC11UI2

## Phạm vi đã đối chiếu

| Yêu cầu | Bằng chứng |
|---|---|
| SC-009, T054/T055 | Web và desktop tạo hạng mục, trả lời câu hỏi, duyệt spec/plan/research và bản tách, chạy đợt, thấy liên kết PR. Desktop kiểm BA/PO không thấy nút chạy đợt, rồi chuyển sang thành viên được hub cấp quyền chạy. Web mở PR trong cửa sổ mới; desktop kiểm liên kết PR qua Vitest. |
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

- T082: hub chưa có `metrics.ts`; UI Chỉ số và hàng số liệu chính sách (SPEC11W5UI, SPEC11W6UI) chỉ kiểm với hub giả.
  Mục Tiến độ desktop dùng danh sách giai đoạn/độ phủ hiện có.
- T091: đã đối chiếu phần UI và lưu ảnh. Chưa chạy `/speckit-analyze` toàn bộ đặc tả; giữ task mở để đợt tích hợp
  kiểm tiếp cả phần hub/worker và những mâu thuẫn ngoài phạm vi UI.
- Quyền trên web vẫn theo tổ chức như phiên bản trước; hub phải kiểm lại theo đội/dự án. Kiểm UI không thay cho
  kiểm RLS và quyền của hub. Phần nối T070 thuộc SPEC11HUB.

## Kiểm tra khi tiếp tục công việc

Đã merge `ai/SPEC11UI` tại `eb0a0e2`, gồm `ac4cc972` sửa vòng import `env.tsx` ↔ `text.ts` bằng `types.ts`.
Merge không có xung đột; các thay đổi nền hub/worker/contracts thuộc lịch sử nhánh nguồn, không tự sửa trong đợt UI này.

- `pnpm install --frozen-lockfile`: thành công.
- `pnpm biome check --write .`: thành công; 16 cảnh báo và 1 thông tin có sẵn.
- `pnpm -w typecheck`: 12 tác vụ thành công, gồm cả kiểm scripts.
- `pnpm deps`: không có vi phạm (1.399 module, 6.021 phụ thuộc). Công cụ có cảnh báo tương thích API TypeScript 7;
  kết quả vẫn trả mã 0, không thay đổi cấu hình công cụ ngoài phạm vi.
- `pnpm --filter @xdev-hive/sdlc-ui --filter @xdev-hive/doc-editor --filter @xdev-hive/web
  --filter @xdev-hive/desktop test`: thành công; web 590, desktop 208 test.
- `pnpm --filter @xdev-hive/desktop exec vitest run src/screens/sdlc-mvp-screen.test.tsx`: thành công sau sửa test
  chuyển vai trò BA/PO → thành viên; kiểm không gọi `waves/run` khi BA/PO không được hub cấp quyền.
- Kiểm cuối sau thay đổi test: `pnpm --filter @xdev-hive/desktop typecheck` và
  `pnpm --filter @xdev-hive/desktop test` xanh (26 file, 208 test); Biome và `pnpm deps` đều chạy lại thành công.
- `HIVE_WEB_E2E_PORT=4392 HIVE_WEB_E2E_WORKERS=2 pnpm --filter @xdev-hive/web exec playwright test
  e2e/sdlc.spec.ts e2e/sdlc-multi.spec.ts e2e/sdlc-mvp.spec.ts e2e/sdlc-fleet.spec.ts e2e/sdlc-modes.spec.ts
  e2e/machine-accounts.spec.ts e2e/reviews.spec.ts e2e/workflows.spec.ts e2e/policies.spec.ts e2e/projects-runs.spec.ts`:
  118 qua, 12 bỏ qua do không đặt thư mục chụp ảnh máy.

Các giới hạn hub thật/Tauri và phần còn chờ ở trên vẫn áp dụng. Không chạy full `pnpm ci:local`.

## SPEC11W5UI: Chỉ số và Hội tụ

| Yêu cầu | Bằng chứng |
|---|---|
| US12, FR-037, T082 (phần UI) | `metrics.tsx`: khoảng 7/30/90 ngày, lọc dự án và chế độ, lead time p50/p90 theo giai đoạn có nút thắt, bảy thẻ chỉ số, bảng tự duyệt theo chế độ/dự án; web `/sdlc/metrics`, màn app `sdlc-metrics` mời kết nối khi chưa có hub. |
| US10, T080 (phần UI) | `converge-panel.tsx`: "Chưa hội tụ (vòng r/max)", "Đã hội tụ", hết vòng thì báo đã dừng và không cho chạy thêm; chọn vòng; mâu thuẫn có "Sửa code: thêm task" và "Sửa tài liệu"; chế độ không có bước `converge` thì không có tab. |
| SC-012 | 4 ảnh 360 px sáng/tối trong [screenshots/spec11w5ui](../../apps/web/e2e/screenshots/spec11w5ui), không tràn ngang. |

Kiểm:

- `pnpm biome check --write .`: thành công; 18 cảnh báo và 2 thông tin có sẵn, file mới không có cảnh báo.
- `pnpm --filter @xdev-hive/sdlc-ui typecheck`, `… web typecheck`, `… desktop typecheck` (chạy lần lượt): thành công.
- `pnpm deps`: không có vi phạm (1.472 module, 6.425 phụ thuộc).
- Vitest: sdlc-ui 12 file / 71 test, web 36 file / 590 test, desktop 31 file / 242 test, đều qua.
- `HIVE_WEB_E2E_PORT=4392 HIVE_WEB_E2E_WORKERS=2 pnpm --filter @xdev-hive/web exec playwright test e2e/sdlc-converge.spec.ts
  e2e/sdlc.spec.ts e2e/sdlc-mvp.spec.ts e2e/sdlc-multi.spec.ts e2e/sdlc-metrics.spec.ts`: 22 bài qua.

Giới hạn: hub chưa có `metrics.ts` và `converge.ts`, nên UI chỉ kiểm với hub giả theo hợp đồng. Hình dạng
`step.result.findings` là giả định theo `sdlc_report` loại `findings`; cần kiểm lại khi hub ghi kết quả bước.

## SPEC11W6UI: Số liệu tự duyệt trong chính sách và mở bảng từ Chỉ số

| Yêu cầu | Bằng chứng |
|---|---|
| T054 (hàng số liệu Policies.dc.html) | `/admin/policies` mục AI SDLC: tỉ lệ tự duyệt và thu hồi cao nhất theo chế độ trong 30 ngày, số dự án bật tự duyệt trên số dự án bật AI SDLC, liên kết tới `/sdlc/metrics`. Hub từ chối hoặc lỗi `sdlc.metrics` thì ẩn hàng, form vẫn dùng được. Hợp đồng chỉ trả tỉ lệ, nên không có ô số cổng hay điểm trung bình như bản thiết kế. |
| US12 AS3, T082 (phần UI) | Màn Chỉ số có "Mở bảng hạng mục với bộ lọc này", mang dự án và chế độ sang bảng: web `/sdlc?project=…&mode=…`, app `#/sdlc/loc?project=…&mode=…`. Bảng không lọc theo khoảng ngày vì `sdlc.items.list` chưa có lọc ngày; màn nói rõ điều này. |
| SC-012 | 4 ảnh 360 px sáng/tối trong [screenshots/spec11w6ui](../../apps/web/e2e/screenshots/spec11w6ui): Chỉ số có liên kết mới, mục AI SDLC của chính sách có hàng số liệu. Không tràn ngang. |

Kiểm:

- `pnpm biome check --write .`: thành công; 18 cảnh báo và 2 thông tin có sẵn.
- `pnpm --filter @xdev-hive/sdlc-ui typecheck`, `… web typecheck`, `… desktop typecheck` (chạy lần lượt): thành công.
- `pnpm deps`: không có vi phạm (1.474 module, 6.431 phụ thuộc).
- Vitest: sdlc-ui 12 file / 72 test, web 36 file / 591 test, desktop 31 file / 243 test, đều qua.
- `HIVE_WEB_E2E_PORT=4392 HIVE_WEB_E2E_WORKERS=2 pnpm --filter @xdev-hive/web exec playwright test e2e/sdlc.spec.ts
  e2e/sdlc-mvp.spec.ts e2e/sdlc-multi.spec.ts e2e/sdlc-metrics.spec.ts e2e/sdlc-converge.spec.ts e2e/policies.spec.ts`:
  41 bài qua.

Giới hạn: số liệu chỉ kiểm với hub giả theo hợp đồng `sdlc.metrics`. Muốn liên kết từ Chỉ số mở đúng các hạng mục góp vào
số liệu thì cần thêm lọc ngày vào `sdlc.items.list`.
