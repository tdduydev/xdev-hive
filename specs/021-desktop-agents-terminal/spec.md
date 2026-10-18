# Spec 021: Agent trên máy và Terminal theo dự án (app desktop)

**Created**: 2026-10-17 · **Status**: Draft, chờ người dùng duyệt · **App**: `apps/desktop` (Tauri + React)

## Vì sao

Người dùng hỏi hai việc:
1. App desktop có cho thấy trên máy đang chạy bao nhiêu Claude Code, Codex và mỗi cái đang làm gì không.
2. Mở được phiên theo từng dự án bằng gói Claude chọn sẵn, đổi gói dễ, gõ thẳng như terminal thật không.

Hiện có (main 9947aeb1):
- Màn "Lượt chạy" chỉ liệt kê run hub giao cho máy này.
- Không màn nào liệt kê tiến trình agent khác trên máy.
- Terminal nhúng (`src-tauri/src/pty.rs` + `components/terminal-pane.tsx`) có chọn CLI và gói, nhưng chỉ là một tab
  trong màn "Tài liệu từ code".

## Mục tiêu, không làm, không được

Mục tiêu:
- Một màn cho thấy mọi phiên agent CLI đang chạy trên máy, ai mở cũng thấy.
- Terminal thành chỗ làm việc chính, theo từng dự án.

Không làm trong spec này:
- Gửi bất cứ dữ liệu nào của màn Agent lên hub (không thống kê, không đồng bộ).
- Gõ vào, hay xem output trực tiếp của, phiên agent không do app mở.
- Mở lại (resume) phiên Claude Code hay Codex từ màn Agent.
- Agent chạy trong sandbox container của worker. [Inference] Tiến trình trong container không hiện như tiến trình
  thường của máy, nên màn không thấy.

Không được (hỏng dù chạy được):
- Lộ token hay biến môi trường của tiến trình khác lên giao diện.
- Dừng nhầm tiến trình: PID đã bị dùng lại, hay tiến trình của người dùng hệ điều hành khác.
- Màn chậm hay ăn CPU khi đang mở.

## Phần 1: Agent trên máy

### Nhận diện tiến trình

| CLI | Nhận theo |
|---|---|
| Claude Code | File chạy `claude` / `claude.exe` (hay file trong `…/claude/versions/` của trình cài native, hay argv[0] là `claude`) **không** nằm trong thư mục cài Claude Desktop (`is_desktop_exe` của `claude_desktop/win.rs`; macOS: trong `Claude.app`). Hoặc `node` chạy `@anthropic-ai/claude-code`. |
| Codex | File chạy `codex` / `codex.exe`. Hoặc `node` chạy `@openai/codex`. |
| Antigravity | File chạy `agy` / `agy.exe`. |

- Trên Windows, Claude Desktop cũng tên `claude.exe` (thấy trên máy dev: `WindowsApps\Claude_…\app\claude.exe`), nên
  phải xét đường dẫn, không chỉ tên.
- Phiên Code của Claude Desktop chạy Claude Code từ `%APPDATA%\Claude\claude-code\<bản>\…\claude.exe`, ngoài thư mục
  cài (thấy trên máy dev), nên vẫn được nhận. [Unverified] macOS: chưa kiểm được trên máy thật; file phiên
  (`entrypoint`) vẫn cho biết nguồn.
- Shim chỉ là một dòng: `node` chạy gói npm của CLI, mà con là binary của cùng CLI, thì gộp làm một dòng (tiến trình
  ngoài cùng). Agent chạy agent khác (ví dụ Claude Code mở `claude -p` cho từng việc) là các dòng riêng.
- Phiên chạy nền (`claude -p`, `codex exec`) vẫn hiện và vẫn đếm, có nhãn "chạy nền".
- CPU và RAM của một dòng cộng cả cây con (rg, MCP server, shell con), trừ cây con của agent con đã có dòng riêng.
- Cha của tiến trình chỉ được tin khi cha chạy trước con: Windows dùng lại pid của cha đã thoát.

### Nguồn: ai mở

Xét theo thứ tự, gặp cái đầu tiên thì dừng:
1. **Hive run**: thư mục làm việc nằm trong `…/xdev-hive/worker/runs/<runId>-<attempt>` (worker `runner.go`). Run id
   lấy từ tên thư mục.
2. **Phiên hive** (spec 010, `hive claude` chạy qua worker để xem và điều khiển từ xa): pid của tiến trình hay tổ tiên
   trùng `pid` trong `hive ls --json`. Danh sách này cho cả id phiên, gói và `hubId`. Chỉ gọi `hive ls` khi có agent có
   tổ tiên `hive-worker` mà thư mục không nằm trong `runs/`, và giữ kết quả 10 giây.
3. **Terminal trong app**: tiến trình là PTY của app hay con cháu của nó (`Ptys` trong `pty.rs` biết pid).
4. **Claude Desktop**: file phiên của Claude Code ghi `entrypoint: "claude-desktop"`, hoặc tổ tiên là Claude Desktop.
5. **App khác**: tổ tiên là app đã biết (Codex Desktop `ChatGPT.exe`, VS Code, Cursor, Antigravity IDE). Hiện tên app.
6. **Terminal của bạn**: còn lại.

### Mỗi dòng hiện

- CLI, PID, giờ bắt đầu, CPU %, RAM.
- Thư mục làm việc. Dự án: thư mục dự án dài nhất chứa thư mục này, trong danh sách `hive-worker projects`
  (`local_projects.rs`). Hive run thì hiện mã dự án trong biến `HIVE_PROJECT` của tiến trình (ví dụ `PAY`) và mã run;
  không hỏi hub tên dự án.
- Gói agent:
  - Đọc `CLAUDE_CONFIG_DIR` / `CODEX_HOME` trong môi trường tiến trình, so với `config_dir` của
    `hive-worker accounts --json` để ra tên gói và email.
  - Không có biến: "Đăng nhập mặc định". Thư mục không thuộc gói nào: hiện đường dẫn rút gọn.
  - [Unverified] Claude Code và Codex không có cờ dòng lệnh chọn thư mục cấu hình, nên chỉ đọc môi trường. Script
    "Mở CLI" của màn Gói agent cũng đặt gói qua biến môi trường.
- Đang làm gì. Chỉ đọc, chỉ trên máy, không gửi hub:
  - **Claude Code**:
    - Đọc `<config>/sessions/<pid>.json`: tên phiên, trạng thái `busy`/`idle`, `sessionId`, `entrypoint`.
    - Rồi đọc tối đa 256 KB cuối của `<config>/projects/<cwd mã hoá>/<sessionId>.jsonl`: lời nhắc cuối
      (`last-prompt`), bước công cụ cuối (tên tool kèm đích ngắn: tên file, mô tả lệnh), và giờ của bước đó.
    - Không có file phiên (bản Claude Code cũ) thì lấy transcript mới nhất của thư mục, sửa sau giờ tiến trình chạy, và
      đánh dấu "đoán theo thư mục".
  - **Codex**:
    - Tìm `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl` từ ngày tiến trình chạy tới nay, có `session_meta.cwd`
      trùng thư mục, sửa sau giờ tiến trình chạy. Lấy file mới nhất.
    - Hiện lời nhắc cuối và lệnh hay tool cuối.
    - Hai Codex cùng thư mục thì có thể lẫn: luôn đánh dấu "đoán theo thư mục".
  - **Antigravity**: chưa biết định dạng phiên, chỉ hiện thông tin tiến trình.
  - Định dạng file phiên là chi tiết nội bộ của từng CLI, không có tài liệu (thấy ở Claude Code 2.1.299 trên máy dev).
    Đọc kiểu cố gắng hết mức: sai định dạng thì để trống, không báo lỗi.
  - Cắt ngắn, một dòng: lời nhắc 300 ký tự, bước 160 ký tự.

### Thao tác

- **Mở run trên web** (Hive run): `open_hub_page` tới trang run. Phiên hive có `hubId` thì mở trang phiên.
- **Mở tab** (Terminal trong app): sang màn Terminal, chọn đúng tab.
- **Terminal ở thư mục này**: mở tab shell trong màn Terminal tại thư mục đó (qua `pty_open`, vẫn kiểm
  `project_folder`).
- **Dừng…**:
  - Hộp xác nhận nêu CLI, PID, thư mục, nguồn. Cảnh báo riêng:
    - Hive run: run sẽ lỗi, nên huỷ trên web.
    - Claude Desktop: phiên trong Claude Desktop sẽ ngắt.
  - Chỉ hiện nút với tiến trình cùng người dùng hệ điều hành với app.
  - Lúc dừng, Rust quét lại pid. Pid phải vẫn là agent, cùng giờ bắt đầu với dòng người dùng thấy, cùng người dùng.
    Sai một điều thì từ chối.
  - Dừng cả cây:
    - Windows: `taskkill /T /F`, như `pty.rs`.
    - macOS, Linux: SIGTERM cho tiến trình và cây con, chờ 5 giây, còn sống thì SIGKILL.
    - Cây có agent con (dòng riêng) thì hộp xác nhận nói rõ: "cũng dừng N agent con".
  - Tab trong app: agent là tiến trình chính của tab thì đi qua `pty_close` để tab đổi trạng thái đúng. Agent chạy
    trong tab shell thì chỉ dừng cây của agent, shell còn mở.
  - Phiên hive: đi qua `remote_session_kill` (`hive kill`) để worker dọn phiên.

### Màn "Máy này"

- Thẻ "Agent đang chạy": số theo CLI (ví dụ Claude Code 12 · Codex 1 · Antigravity 0). Bấm thì sang màn Agent.
- Đọc mỗi 10 giây khi màn mở, bằng lệnh đếm nhẹ (không đọc file phiên, không đọc môi trường).

### Làm mới

- Màn Agent đọc lại mỗi 3 giây khi đang mở. CPU % tính giữa hai lần đọc. Rời màn thì dừng. Có nút "Làm mới".
- Lệnh Tauri mới, chỉ cửa sổ app (`capabilities/app.json`): `machine_agents`, `machine_agent_counts`,
  `machine_agent_stop { pid, startedAt }`.

### Thư viện đọc tiến trình: `sysinfo`

Chọn `sysinfo` 0.39.6 (phát hành 09/07/2026, khoảng 224 triệu lượt tải). Tắt tính năng mặc định, chỉ bật `system` và
`user`. Lý do:
- Một API cho cả ba hệ điều hành: tên, file chạy, dòng lệnh, thư mục làm việc, môi trường, cha, giờ bắt đầu, CPU, RAM,
  người dùng.
- Đọc thư mục làm việc và môi trường của tiến trình khác:
  - Windows cần đọc PEB qua `NtQueryInformationProcess` và `ReadProcessMemory`;
  - macOS cần `KERN_PROCARGS2` và `proc_pidinfo`.
  Tự viết là nhiều `unsafe` riêng cho từng hệ điều hành. `CreateToolhelp32Snapshot` trong `win.rs` không cho thư mục
  làm việc, môi trường hay CPU.
- Thêm vào cây: `ntapi` (Windows), `objc2-*` (macOS). `windows` 0.62 đã có trong `Cargo.lock`.
- Cần Rust 1.95 trở lên. CI dùng `stable` (1.99). Nâng `rust-version` của `src-tauri/Cargo.toml` từ 1.85 lên 1.95.

Dữ liệu nhạy cảm:
- Môi trường đọc xong lọc ngay, chỉ giữ `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `HIVE_PROJECT`.
- Dòng lệnh chỉ dùng để nhận CLI và cờ bỏ hỏi quyền. Không trả dòng lệnh về giao diện.

## Phần 2: Terminal theo dự án

- **Mục menu "Terminal"** trong nhóm "Chạy". Màn chia hai cột:
  - trái: dự án trên máy (từ `hive-worker projects`) và "Thư mục khác…"; mỗi dự án có số tab đang mở;
  - phải: terminal của dự án đang chọn, chỉ tab của dự án đó, thanh công cụ như `TerminalPane` hiện nay.
- **Nút "Terminal"** trên mỗi dòng của "Dự án trên máy": sang màn Terminal, chọn dự án. Dự án chưa có tab thì mở tab
  mới theo mặc định của dự án.
- **Gói mặc định theo dự án**:
  - Nhớ CLI và gói của lần mở cuối ở dự án đó, theo thư mục, trong `localStorage` của app.
  - Không nhớ "bỏ hỏi quyền".
- **"Đổi gói"** trên tab đang mở:
  - Chọn gói khác cùng CLI. App đóng CLI cũ, mở lại trong cùng tab, cùng thư mục, in một dòng phân cách.
  - Gói mới thành mặc định của dự án.
  - [Inference] Hội thoại cũ không mang sang: mỗi gói có thư mục cấu hình riêng, nên transcript cũ nằm ở gói cũ.
- **Tab sống khi đổi màn**:
  - Kho terminal đã nằm ngoài React (`lib/pty.ts`): CLI vẫn chạy, xterm giữ nội dung.
  - Thêm test giữ điều này: mở tab, sang màn khác, quay lại, vẫn đúng tab đó và không mở PTY mới.
- **Màn "Tài liệu từ code"** vẫn có tab Terminal, dùng chung kho, chỉ hiện tab của thư mục đang mở.
- Giữ nguyên quy tắc an toàn của `pty.rs`: không nhận lệnh tuỳ ý từ giao diện, gói lấy từ `hive-worker accounts`,
  không có token trên giao diện, tối đa 8 terminal.

## Menu sau thay đổi

Nhóm "Chạy": Agent trên máy, Terminal, Lượt chạy, Điều khiển từ xa. Hai mục mới hiện cho mọi hồ sơ, vì là việc tại máy
và hồ sơ writer đã có terminal trong màn Tài liệu từ code.

## Các lựa chọn do người viết spec quyết (người dùng xem lại)

1. Vị trí hai mục menu như trên.
2. `sysinfo` 0.39.6 và nâng `rust-version` lên 1.95.
3. "Đổi gói" mở lại tab ở chế độ thường, kể cả khi tab cũ bỏ hỏi quyền. Giữ quy tắc hiện có: mỗi terminal bỏ hỏi quyền
   phải xác nhận lại.
4. CPU và RAM của một dòng cộng cả cây con.
5. Không hiện dòng lệnh đầy đủ của tiến trình.
6. Nút "Dừng" có cho cả Hive run và phiên Claude Desktop, kèm cảnh báo riêng.
7. Phiên chạy nền (`claude -p`, `codex exec`) hiện và đếm như phiên thường. Agent con là dòng riêng; chỉ shim `node`
   mới gộp.
8. Hive run hiện mã dự án và mã run, không hỏi hub tên dự án.

## Kiểm thử và giới hạn kiểm chứng

- Rust, viết test trước:
  - Hàm thuần có test với dữ liệu giả: nhận CLI, nhận nguồn, gộp cây, mã hoá thư mục kiểu Claude Code, đọc đuôi
    transcript Claude và Codex từ file mẫu, khớp gói, khớp dự án, kiểm trước khi dừng.
  - Một test quét thật tiến trình đang chạy test.
- Máy dev Windows này không có MSVC linker. Rust chạy `cargo check` và `cargo test` trong Docker Linux (image
  `hive-tauri-rust`). Phần riêng Windows và macOS chỉ CI kiểm, sau khi người dùng đồng ý push.
- Web, vitest:
  - màn Agent (mock `invoke`), thẻ trên "Máy này";
  - màn Terminal: chọn dự án, nhớ gói, đổi gói, tab sống khi đổi màn;
  - nút Terminal ở "Dự án trên máy".
