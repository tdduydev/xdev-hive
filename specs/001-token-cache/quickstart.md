# Quickstart: kiểm tính năng cache token

**Feature**: [spec.md](./spec.md) · Hợp đồng: [contracts/](./contracts/) · Dữ liệu: [data-model.md](./data-model.md)

## Chuẩn bị

```bash
npm ci
npm run typecheck
npm test            # node --test: packages/core/test, packages/mcp/test, apps/desktop/test
```

Hub chạy cục bộ và một máy desktop đã nối hub, có ít nhất một gói Claude đăng nhập được. Dự án thử có một tài liệu trên 16 000 ký tự (> 4k token ước tính).

## Kịch bản 1: đo nền (T0/T1, trước khi sửa)

1. Tạo hai task nhỏ giống nhau (ví dụ "ghi ngày vào file X") trong cùng dự án.
2. Giao lần lượt cho cùng gói Claude, cùng vai trò `implement`, cách nhau dưới 1 phút.
3. Trang *Lượt chạy*: ghi `cache write` / `cache read` của run 1 và run 2.
4. Lặp lại với run 2 cách run 1 khoảng 10 phút, và với cùng một task chạy lại (cùng worktree).
5. Ghi kết quả vào `.xdev-hive/artifacts/cache-baseline.md` của task.

**Mong đợi**: có bảng số để chọn hướng R2 (đảo thứ tự prompt / khe đường dẫn cố định / TTL).

## Kịch bản 2: phần đầu ngữ cảnh ổn định (US1)

```bash
node --test apps/desktop/test/prompt-prefix.test.ts   # test mới
```

- Dựng prompt cho hai task khác nhau cùng dự án/vai trò. Phần trước SEPARATOR bằng nhau từng byte, `prefixFp` bằng nhau.
- Đổi phiên bản một skill. `prefixFp` đổi, `prefixParts` chỉ khác ở mục skill đó.
- Chạy lại Kịch bản 1 sau khi sửa. **Mong đợi**: run 2 ghi cache ít hơn run 1 ≥ 50% (SC-001).

## Kịch bản 3: đọc có điều kiện (US2)

```bash
node --test packages/core/test/doc-conditional.test.ts packages/mcp/test/mcp.test.ts
```

Trên `SqliteHive(":memory:")`, với actor có `runCredential.run = "R-1"`:

| Bước | Mong đợi |
|---|---|
| `docs.get {key}` | nội dung đầy đủ, `run_reads` có dòng `(R-1, doc, key, v1)` |
| `docs.get {key}` lần 2 | `{unchanged:true, version:1}` |
| `docs.get {key, full:true}` | nội dung đầy đủ |
| sửa tài liệu → `docs.get {key}` | nội dung v2 |
| gỡ tài liệu → `docs.get {key, have:2}` | lỗi `removed`, không phải `unchanged` |
| thu quyền → `docs.get {key, have:2}` | lỗi quyền |
| `memory.search` cùng câu 2 lần | lần 2 `{same:true}` |
| đánh dấu `stale` một mục → tìm lại | danh sách đầy đủ, không `same` |
| actor không có `runCredential` gọi lại | luôn đầy đủ (không biên nhận) |

Đo cỡ: câu trả lời `unchanged` < 400 ký tự (≈ 100 token, SC-003). Tool list tăng ≤ 1200 ký tự (≈ 300 token, FR-010).

## Kịch bản 4: mục lục và tóm tắt (US3, cần 80c)

```bash
node --test packages/core/test/doc-digest.test.ts
```

- `buildDigest` cho cùng nội dung luôn ra cùng `toc` (tất định). Tiêu đề trùng thì có hậu tố `-2`.
- Tài liệu dài: `doc_get` trả digest < 8 000 ký tự (≈ 2k token, SC-004). `section:<id>` trả đúng nguyên văn mục.
- Sửa tài liệu: digest mới khớp `version` mới. Không có dòng nào trả digest của bản cũ kèm `version` mới.
- Tài liệu ngắn: trả cả nội dung.

## Kịch bản 5: số đo trên trang chi phí (US4)

1. Sau Kịch bản 1–3, mở *Vận hành → Chi phí* (`OpsCosts`).
2. Chọn 24h. Thấy theo dự án và gói: ghi cache trung bình/run, tỉ lệ đọc cache, số lần "không đổi", token tránh được ghi "ước tính".
3. Run Codex/Gemini: cột ghi cache hiện "chưa rõ".
4. Test cảnh báo: `node --test packages/core/test/costs.test.ts` có ca dựng 5 run với `cache_write` gấp 3 kỳ trước, và `prefix_parts` khác ở một doc. Mong đợi: `alerts.check()` tạo `cache_write_spike` nêu đúng doc đó.
5. Giao diện đổi thì chạy thêm: `npm run e2e -w @xdev-hive/web -- <thư mục ảnh>` và `npm run e2e:mobile -w @xdev-hive/web -- <thư mục ảnh>`.

## Kịch bản 6: bản sao trên máy (US5, sau khi chốt FR-016)

1. Chạy hai run liên tiếp cùng dự án. Log run 2 ghi `doc-cache: 0 fetched, N reused`.
2. Sửa một tài liệu, chạy run 3. Log ghi `1 fetched`.
3. Đăng xuất. Thư mục `<appData>/doc-cache/<hubId>/<accountId>` không còn.
4. Desktop đổi thì chạy thêm: `npm run build -w @xdev-hive/desktop` rồi `npm run smoke -w @xdev-hive/desktop -- <thư mục ảnh>`.
