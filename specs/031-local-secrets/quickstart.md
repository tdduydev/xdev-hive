# Quickstart: kiểm tay kho bí mật tại máy

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Dùng giá trị giả. Không dùng khoá thật khi thử. Mọi bước chạy trên Windows và macOS; Linux chạy khi có Secret Service.

## 0. Chuẩn bị

- Build sidecar: trong `worker/` chạy `go build ./cmd/hive-worker`. Chạy desktop bằng
  `pnpm --filter @xdev-hive/desktop app:dev`.
- Có một repo git tạm đã thêm vào "Dự án trên máy". Ghi lại `localId` bằng
  `hive-worker projects list --json`.

## 1. Kiểm nền tảng (T001)

```sh
# Giá trị 8 KiB nhiều dòng: tạo bằng script, đưa qua stdin, không gõ vào lệnh
python -c "import json,sys;v=('dòng-'+'x'*90+'\n')*85;sys.stdout.write(json.dumps({'value':v[:8192]}))" \
  | hive-worker secrets set --json --name QS_BIG
hive-worker secrets reveal --json --name QS_BIG | python -c "import json,sys;print(len(json.load(sys.stdin)['value']))"
```

Mong đợi:

- Lệnh in 8192.
- Credential Manager (Windows) hoặc Keychain Access (macOS) có các mục `dev.xdev.hive.secrets` / `QS_BIG`, `QS_BIG#1`…
- Kiểm thêm:
  - giới hạn khối thật (research D2);
  - macOS khoá keychain thì lệnh hết giờ sau 5 giây với `store_locked`;
  - `tauri-plugin-clipboard-manager` đọc lại được clipboard;
  - claude nhận `--append-system-prompt` trong terminal.

Ghi kết quả vào research.md mục "Kết quả kiểm".

## 2. US1: thêm, gán, xoá

1. Mở desktop, chưa đăng nhập Hive. Menu Dự án → **Bí mật** hiện.
2. Thêm `QS_TOKEN`, giá trị `qs-secret-123456`, mô tả "Token thử", gán cho dự án tạm.
3. Kiểm lỗi:
   - tên `path` bị từ chối với lý do tên dành riêng;
   - tên `1ABC` bị từ chối với lý do sai mẫu;
   - giá trị `short` bị từ chối với lý do ngắn hơn 8 ký tự;
   - mô tả `ghp_` + 36 ký tự bị từ chối với lý do giống bí mật.
4. `grep -r "qs-secret-123456"` trong thư mục cấu hình worker và dữ liệu app: không có kết quả (SC-004).

## 3. US2 + US4 + US5: run của worker

1. Tạo task cho dự án tạm. Prompt: "In `$QS_TOKEN`, base64 của nó, URL-encode của nó, và JSON `{"t":"$QS_TOKEN"}`".
2. Mong đợi:
   - agent thấy biến;
   - log run tại máy và trên web hiện `[đã che]` ở cả bốn chỗ;
   - nhật ký cấp có dòng `run` gắn dấu "xuất hiện trong output";
   - web run detail hiện "Dùng 1 bí mật tại máy", không có tên.
3. Prompt "Ghi `$QS_TOKEN` vào file `leak.txt` rồi commit": run dừng ở bước commit với lỗi chặn (FR-038).
4. Run cho một dự án khác: `env | grep QS_` rỗng (SC-002).

## 4. US3: terminal desktop

1. Từ màn Dự án, mở terminal claude và terminal shell.
2. `echo "$QS_TOKEN"` (Unix) hoặc `echo %QS_TOKEN%` (Windows) in đúng giá trị.
3. Với giá trị có dấu nháy, `$` và xuống dòng: `printf %s "$QS_MULTI" | od -c` khớp từng byte.
4. Script tạm của terminal (xem thư mục tạm trước khi script tự xoá) không có giá trị.

## 5. US7: chính sách

1. Trên web `/admin/policies`, đặt "Bí mật tại máy" = Hỏi trước. Audit có dòng `policies.update`.
2. Chạy task:
   - desktop hiện hộp thoại liệt kê `QS_TOKEN`;
   - Từ chối → run chạy không có biến; khối ngữ cảnh ghi "không có bí mật";
   - nhật ký ghi `declined`.
3. Đặt "Không cho": run không đọc kho (nhật ký `denied`, không hộp thoại mở khoá).
4. Tắt mạng, xoá `secrets-policy.json`, mở terminal cho dự án liên kết. Mong đợi: `deny` (FR-053).

## 6. US9: kho không dùng được

- macOS: khoá keychain (`security lock-keychain`), chạy task. Run dừng trước khi tạo agent, với lý do tiếng Việt trong
  5 giây (SC-006).
- Xoá tay mục `QS_TOKEN` trong Credential Manager, chạy task. Mong đợi: lỗi `store_missing` có tên `QS_TOKEN`.

## 7. US8: hiện, sao chép, gỡ

1. Hiện → xác nhận → giá trị hiện rồi tự ẩn sau 10 giây.
2. Sao chép → dán được. Sau 30 giây clipboard rỗng. Nếu đã chép thứ khác trong 30 giây đó thì clipboard giữ nguyên.
3. Gỡ dự án khỏi "Dự án trên máy": gán của nó mất.
4. Xoá dữ liệu app: app hỏi xoá bí mật khỏi kho.

## Rủi ro đã biết

- Worker cũ ghi lại `projects.json` làm mất `localId` (data-model §3).
- Base64 của chuỗi con lệch vị trí không bị che (research D7).
- Terminal codex, gemini không có khối tên (research D8).
- Tên bí mật có thể lọt vào log nếu agent in tên trong lệnh (research D8).
