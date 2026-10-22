# Quickstart: kiểm spec 029 từ đầu tới cuối

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

## 0. Chuẩn bị

- Máy dev có `claude`, `codex`, `gemini` (và `agy` nếu có), app desktop bản dev (`pnpm --filter @xdev-hive/desktop app:dev`).
- Một repo thử: `git init demo && cd demo`, tạo `CLAUDE.md` có một dòng tự viết, `AGENTS.md` có một dòng, commit.
- Hub dev chạy (`AGENTS.md` mục Lệnh) cho phần P2–P3; hai máy (hoặc hai thư mục `HOME` giả) gắn cùng một dự án.

## 1. Kiểm tay từng CLI (đầu P1, chốt research mục 1)

Tạo tay các file đích với một câu nhận dạng (vd. "Mã kiểm: XH-029"), rồi hỏi từng CLI "Mã kiểm là gì?":

| CLI | File | Kỳ vọng |
|---|---|---|
| Claude Code | `CLAUDE.local.md` | Trả đúng mã; `/memory` liệt kê file |
| Codex | `AGENTS.override.md` (chép `AGENTS.md` + câu) | Trả đúng mã và vẫn biết dòng của `AGENTS.md` |
| Gemini | `GEMINI.local.md` + `.gemini/settings.json` `context.fileName` | Trả đúng mã |
| Antigravity | `.agents/rules/xdev-hive.md` có `trigger: always_on` | Trả đúng mã |

CLI nào không đạt: ghi vào research mục 1, để trạng thái "chưa hỗ trợ" cho CLI đó.

## 2. US1 — Một ngữ cảnh cho mọi CLI

1. Màn Memory → dự án `demo` → bật "Ngữ cảnh dùng chung" → soạn "Chạy test bằng `make test`." → Lưu.
2. Kỳ vọng: bốn file đích có khối; `CLAUDE.md`, `AGENTS.md` không đổi; `git status` sạch; `git check-ignore -v` chỉ ra
   `.git/info/exclude` cho từng file.
3. Sửa tay một chữ trong khối `CLAUDE.local.md` → sửa nguồn → kỳ vọng `claude` ở trạng thái "Xung đột", file không bị ghi.
4. Sửa `AGENTS.md` (commit) → kỳ vọng Codex "Lệch" → Đồng bộ → `AGENTS.override.md` có dòng mới.
5. Tắt → kỳ vọng file app tạo vào thùng rác, dòng exclude bị gỡ, `CLAUDE.md` nguyên vẹn.

Lệnh tự động: `go test ./internal/ctxsync/... ./internal/gitexclude/...` trong `worker/`.

## 3. US2 — Nút "Tối ưu"

1. Gói Claude chưa tối ưu, điểm thẻ < 60. Màn Token → "Tối ưu".
2. Kỳ vọng hộp xem trước có nhóm "Cấu hình CLI", "Công cụ", "Ngữ cảnh"; dòng `aggressive` (nếu có) không chọn sẵn.
3. Bỏ chọn một dòng → Áp dụng → kỳ vọng điểm sau ≥ 75, dòng bỏ chọn không chạy.
4. "Hoàn tác lần này" → kỳ vọng `settings.json`, `config.toml`, khối ngữ cảnh trở về y như trước (so bằng `git diff
   --no-index` với bản chép trước bước 1); công cụ đã cài vẫn còn.
5. Mở hai cửa sổ, bấm "Tối ưu" cùng lúc → cửa sổ sau báo "Đang tối ưu ở cửa sổ khác".

Lệnh: `go test ./internal/optimizeall/...`; Vitest `apps/desktop` cho `optimize-preview-dialog`.

## 4. US3 — Kéo memory đã duyệt

1. Web: duyệt hai memory của dự án, ghim một. Máy B: Đồng bộ.
2. Kỳ vọng mục "Từ hub" có hai memory, bản ghim đứng trước. Gỡ một memory trên web → Đồng bộ → biến mất.
3. Thêm memory chứa `sk-…` giả → Đồng bộ → không có trong khối, màn Memory báo "đã bỏ 1 mục nghi là bí mật".
4. Tắt mạng → Đồng bộ → khối giữ bản cũ, hiện "đồng bộ lần cuối …".

Lệnh: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/knowledge/`.

## 5. US4 — Chính sách dự án

1. Web, admin đội: Cài đặt dự án → "Tối ưu máy dev" → `aggressive`, RTK, ngân sách 1.000 → Lưu. Người không phải admin:
   nút Lưu bị khoá.
2. Máy thành viên → màn Token → kỳ vọng "Lệch chính sách: level, rtk" → "Tối ưu" → các dòng ghi "Theo chính sách dự án",
   `aggressive` vẫn cần chọn tay.

Lệnh: Playwright `apps/web/e2e/project-dev-optimizer.spec.ts`.

## 6. US5 — Outbox

1. Tắt mạng → "Gửi lên hub" một file memory → kỳ vọng "Đã xếp hàng", thẻ "Đang chờ gửi: 1".
2. Tắt app, bật mạng, mở app → kỳ vọng hub có đúng **một** memory `pending`.

Lệnh: `go test ./internal/outbox/...`.

## 7. US6 — Báo cáo token dự án

1. Hai máy bật "Gửi số liệu" → tính lại điểm. Web → trang dự án → bảng có hai dòng theo người/máy.
2. Kiểm payload: `go test ./internal/tokenreport/... -run TestProjectUsagePayloadHasNoText`.
3. Máy A tắt gửi → "Xoá số liệu đã gửi" → dòng của máy A biến mất.

Lệnh: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/fleet/`.
