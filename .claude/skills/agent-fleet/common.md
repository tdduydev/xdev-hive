# Quy tắc chung (bắt buộc)
- Bạn làm trong một git worktree riêng của repo xDev Hive (thư mục hiện tại). Đọc AGENTS.md trước. Không sửa AGENTS.md, CLAUDE.md, docs/decisions.md.
- KHÔNG `git push`, KHÔNG `gh`, KHÔNG mở PR, KHÔNG deploy, KHÔNG đụng ~/.xdev-hive, ~/Library/Application Support/xdev-hive hay /Applications. Chỉ sửa file trong worktree này.
- Chữ trên giao diện và thông báo lỗi viết tiếng Việt (app desktop có từ điển vi/en như các màn sẵn có). Comment giải thích vì sao, không giải thích cái gì. Viết code giống code xung quanh.
- Web/desktop import bằng alias `@/…`; hub giữ import tương đối có đuôi `.ts`.
- Trước khi xong: `pnpm install` (nếu cần), `pnpm biome check --write .`, rồi chạy test liên quan; worker Go thì `gofmt -l .`, `go vet ./...`, `go test ./...` trong `worker/`. Mọi test phải xanh.
- Commit tại máy (có thể nhiều commit), message TIẾNG ANH kiểu `feat(desktop): add …` (product owner yêu cầu 2026-10-13; chữ trên giao diện và lỗi vẫn tiếng Việt), kết thúc message bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Cuối cùng ghi file tóm tắt (đường dẫn ở cuối đề bài): đã làm gì, file chính, test đã chạy và kết quả, việc chưa làm, rủi ro. Nếu sắp hết lượt dùng, commit phần đã xong và ghi tóm tắt ngay.
