# Kiểm MCP `xdev-hive` trong Claude Code (roadmap 38b)

Dành cho người merge và chủ máy. Làm theo đúng thứ tự; mỗi bước có kết quả mong đợi.

Nền: trước 38b, Hive ghi `"xdev-hive": { "command": "hive-mcp" }` vào `.mcp.json` của repo. Mục đó chỉ chạy khi thư
mục shim nằm trong `PATH` của tiến trình gọi — mà chương trình mở từ Explorer, Finder hay Dock không có `PATH` của
shell. Nay mục nằm ở **scope local** của Claude Code (`~/.claude.json` → `projects["<repo>"].mcpServers`) với **đường
dẫn đầy đủ** của shim, Windows bọc thêm `cmd /c`.

## Windows (`hc-duytd20`)

1. Cập nhật app xDev Hive lên bản có 38b rồi mở *Cài đặt máy*.
2. Mục **Lệnh hive-mcp**:
   - Chưa cài thì bấm *Cài*.
   - Nếu hiện *Thêm vào PATH* thì bấm. App ghi `%USERPROFILE%\.xdev-hive\bin` vào `Path` của người dùng.
   - Kiểm bằng `cmd`:
     ```cmd
     reg query HKCU\Environment /v Path
     ```
     Mong đợi: kiểu vẫn là `REG_EXPAND_SZ`, các mục `%…%` cũ còn nguyên, cuối chuỗi có `…;C:\Users\<bạn>\.xdev-hive\bin`,
     và thư mục đó chỉ xuất hiện **một lần** (bấm nút lần nữa thì app báo "đã có sẵn", không ghi thêm).
3. Kiểm shim chạy được (vẫn trong `cmd`, không cần mở lại gì):
   ```cmd
   cmd /c "%USERPROFILE%\.xdev-hive\bin\hive-mcp.cmd"
   ```
   Mong đợi: **không** có `'hive-mcp' is not recognized`; lệnh đứng im chờ stdin (server MCP đọc stdio) — `Ctrl+C`
   để thoát. Muốn nó tự thoát thì `echo. | cmd /c "%USERPROFILE%\.xdev-hive\bin\hive-mcp.cmd"`.
4. **Đóng hẳn Claude Code và Claude Desktop trước khi sang bước 5.** Tiến trình đang chạy giữ `~/.claude.json` trong
   bộ nhớ và ghi đè lúc thoát, nên mục Hive vừa ghi có thể mất.
5. Mục **Cấu hình agent** của dự án: bấm *Cài vào agents* (hoặc *Cài lại*). Kết quả liệt kê:
   - `~/.claude.json` — `created` hoặc `updated`
   - `.mcp.json` — `removed` kèm ghi chú "bỏ mục xdev-hive cũ" (nếu repo còn mục cũ), hoặc `unchanged`
6. `.mcp.json` bị đổi thì **commit nó** (`git add .mcp.json`): đồng đội chưa pull vẫn còn mục `xdev-hive` hỏng.
7. **Mở lại terminal** (tiến trình đang chạy giữ `PATH` cũ). Rồi mở `cmd` tại thư mục repo và chạy:
   ```cmd
   claude mcp get xdev-hive
   ```
   Mong đợi: scope `local`, `command` là `cmd`, `args` là `/c C:\Users\<bạn>\.xdev-hive\bin\hive-mcp.cmd`.
8. Chạy `claude`, gõ `/mcp`. **Mong đợi: `xdev-hive` ở trạng thái `connected`** và liệt kê các tool `task_*`,
   `memory_*`, `doc_*`. Repo có bật codegraph thì `codegraph` cũng `connected`.
9. Nếu `xdev-hive` báo *failed* / *Connection closed*, gửi lại:
   - kết quả bước 3 và bước 7,
   - `claude --debug` rồi `/mcp` (dòng lỗi của server),
   - `git -C <repo> diff -- .mcp.json`.

## macOS (Mac mini) — bước người merge kiểm

1. Cập nhật app. **Đóng hẳn Claude Desktop và Claude Code trước** (tiến trình đang chạy ghi đè `~/.claude.json`).
2. *Cài đặt máy* → *Cấu hình agent* của repo → *Cài lại*. `.mcp.json` bị đổi thì commit.
3. Mở Claude Desktop (tab Code) **trong đúng thư mục repo**, không qua terminal — đó là trường hợp hỏng ngày 3/10
   (*Executable not found in $PATH: hive-mcp*).
4. `/mcp`. Mong đợi: `xdev-hive` `connected`. `claude mcp get xdev-hive` phải cho `command` là đường dẫn đầy đủ
   `/Users/<bạn>/.local/bin/hive-mcp`, scope `local`.

## Linux

Giống macOS, không có bước `cmd /c`. Thư mục shim là `~/.local/bin`.

## Nếu `claude mcp get` không thấy mục

Hình dạng file `~/.claude.json` (`projects["<repo>"].mcpServers`) lấy theo tài liệu Claude Code, **chưa đo** trên máy
thật khi viết 38b. Đo bằng:

```sh
claude mcp add --scope local demo-check -- /bin/echo hi
```

rồi xem `~/.claude.json` xem Claude Code đặt mục đó ở đâu. Khác với chỗ Hive ghi thì sửa `installClaudeLocalMcp`
trong `apps/desktop/src/main/installer.ts` cho khớp và gỡ `demo-check` bằng `claude mcp remove demo-check`.
