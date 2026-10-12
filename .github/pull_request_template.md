## Tóm tắt

<!-- Thay đổi gì, vì sao. Tính năng mới: link tới specs/<NNN-feature>/spec.md và các mã yêu cầu trong docs/srs.md. -->

## Cách kiểm

<!-- Lệnh đã chạy, test thêm, màn đã xem. -->

## Checklist

Theo [docs/feature-checklist.md](../docs/feature-checklist.md). Mục không áp dụng ghi "n/a" kèm lý do.

- [ ] Spec, SRS, ADR (khi có quyết định kiến trúc) đã cập nhật
- [ ] Contracts và `openapi.json` khớp (`pnpm openapi`)
- [ ] Bảng mới có RLS và test; quyền kiểm ở hub; thao tác quản trị có audit
- [ ] Không có secret trong code, log, fixture
- [ ] Giao diện: component shadcn, design token, 360 px, light/dark, Playwright
- [ ] `pnpm check` qua; worker: `gofmt`, `go vet`, `go test`
- [ ] Tài liệu (ADD, SDD, self-hosting, README) cập nhật nếu cần
