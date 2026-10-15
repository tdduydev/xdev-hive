# Quyền CLI trong run

Dự án có thể đặt `settings.runPermissions = { mode: "workspace" | "full" }`.
Bỏ trường này thì hub gửi `runPermissions: "workspace"` trong spec; worker cũng hiểu spec cũ thiếu trường là workspace.
`full` chỉ nên dùng khi run nằm trong container của M6.

Máy đã gắn dự án với repo trên máy (`projects.json`, [ADR 0020](adr/0020-local-project-folders-and-machine-full-permission.md))
thì không theo `runPermissions` của hub: run code có `full` khi và chỉ khi máy bật "Cho toàn quyền trên máy này" cho dự án
và tổ chức cho phép (`fullAllowed` trong spec). Máy chưa gắn dự án giữ cách cũ.

| CLI | workspace | full |
| --- | --- | --- |
| Claude | `--permission-mode acceptEdits --allowedTools Bash` | `--permission-mode bypassPermissions` |
| Codex | `-s workspace-write -c approval_policy="never"` và `sandbox_workspace_write.writable_roots` | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `--approval-mode auto_edit --skip-trust --policy <file>`; policy cho phép `run_shell_command` | `--approval-mode yolo --skip-trust` |

Codex nhận đường dẫn bare cache, gitdir riêng của worktree, `objects`, `refs`, `logs` qua writable_roots.
Chỉ cấp thư mục bare cache bằng `--add-dir` chưa đủ trên phiên bản đã thử: gitdir vẫn bị bảo vệ.
Cấp các thư mục con trực tiếp giúp git ghi index, object và ref; bare cache còn cần ghi `packed-refs.lock`.
Runner lấy gitdir bằng `git rev-parse --absolute-git-dir`, không đoán tên do Git tạo.

Claude và Gemini dùng cơ chế duyệt tool của CLI, không có sandbox filesystem tương đương Codex.
Cho phép Bash/shell để chạy test/build tuỳ dự án đồng nghĩa lệnh shell có quyền của tài khoản worker.
`workspace` của hai CLI này không bảo đảm cách ly mọi tiến trình trong worktree. Cách ly hệ điều hành thuộc container M6.
Gemini dùng [Policy Engine](https://geminicli.com/docs/reference/policy-engine/) vì `--allowed-tools` đã deprecated.
Các file cấu hình tạm được dọn khi lệnh hoàn tất hoặc bị huỷ.
`CLICommands` và `HIVE_WORKER_CLI_OVERRIDES` tiếp tục thay toàn bộ lệnh, không bị thêm cờ quyền.

## Run AI SDLC (`sdlc`)

Run soạn tài liệu của chế độ AI SDLC ([specs/011](../specs/011-ai-sdlc-mode/spec.md), ADR 0021) luôn chạy `workspace`,
kể cả khi dự án đặt `full` hay máy bật toàn quyền cho dự án: hub gửi cứng `runPermissions: "workspace"` cho kind này.

- Worktree tạm từ nhánh chính, như run kiểm tài liệu. Agent ghi được file trong worktree để soạn tài liệu.
- Worker ghi sẵn các file `seed` (baseline, bản nháp, tóm tắt dự án tham gia) rồi đọc lại các file `collect` sau khi CLI
  thoát. Tài liệu về hub qua `report.artifacts`, không qua git.
- Không commit, không đẩy, không chạy hook Stop của tổ chức. Agent lỡ commit trong worktree tạm thì commit đó cũng bị xoá
  cùng worktree. Hub mới là bên ghi tài liệu vào repo (PR hoặc đẩy thẳng theo `sdlc.repoSync`) sau khi duyệt.
- Đường dẫn `seed` và `collect` được kiểm cả ở hub và worker; worker từ chối symlink trỏ ra ngoài worktree.

Hạng mục nhiều dự án: máy khai capability `sdlc-multirepo` nhận thêm `repos`. Worker clone nông (depth 1) từng repo vào
`.hive/repos/<mã dự án>/`, xoá `.git` và khoá ghi bản checkout, rồi ghi `.hive/repos/STATUS.md`.

- Clone bằng đăng nhập Git sẵn có của máy; hub không gửi token. Máy không có quyền đọc repo nào thì repo đó chỉ có tóm
  tắt. Chờ chủ dự án xác nhận cách này.
- Hub chỉ gửi URL `https`, `http`, `ssh` của kết nối Git dự án; worker từ chối `file://` và `ext::`.
- Giới hạn: 7 repo mỗi run (hub), 200 MB mỗi repo, 500 MB tổng, 5 phút mỗi lần clone. Repo vượt giới hạn bị bỏ và ghi
  lý do vào `STATUS.md`, run vẫn chạy.
- Runner host (sandbox) không khai `sdlc-multirepo` vì không giữ đăng nhập Git của đội.
- Bit chỉ đọc không cản được tiến trình chạy bằng root hay đổi lại quyền file. Đây là rào để agent không sửa nhầm,
  không phải ranh giới bảo mật; cách ly thật thuộc container M6.

## Thử thật ngày 11/10/2026, macOS

Thử trước khi sửa code, trong bare repo và linked worktree nằm trong worktree của task.
Prompt yêu cầu tạo `a.txt` chứa `1`, chạy `ls`, `git add` và `git commit` với danh tính thử.

| CLI/phiên bản | Cờ | Kết quả |
| --- | --- | --- |
| Claude 2.1.296 | acceptEdits | Tạo file và ls được; git add yêu cầu duyệt; 0 commit |
| Claude 2.1.296 | acceptEdits + allowedTools Bash | 1 commit |
| Claude 2.1.296 | bypassPermissions | 1 commit |
| Codex 0.162.1 | full-auto | Exit 2: cờ không còn được hỗ trợ |
| Codex 0.162.1 | workspace-write, approval never | index.lock bị chặn; 0 commit |
| Codex 0.162.1 | workspace-write + add-dir bare cache | index.lock vẫn bị chặn; 0 commit |
| Codex 0.162.1 | workspace-write + writable_roots gitdir/objects/refs/logs | 1 commit; packed-refs.lock bị chặn, vì chưa cấp bare cache |
| Codex 0.162.1 | dangerously-bypass-approvals-and-sandbox | 1 commit |
| Gemini 0.63.0 | auto_edit / yolo | Exit 41: thiếu xác thực; thư mục chưa trust làm mode về default |
| Gemini 0.63.0 | auto_edit + skip-trust + policy | Exit 41: thiếu xác thực; chưa kiểm được sửa file/commit |

Test tuỳ chọn chạy **runner thật** (có clone bare, worktree, kiểm commit/file, push và cleanup):

```sh
cd worker
HIVE_RUNNER_REAL_CLI=claude go test ./internal/runner -run '^TestRealCLIRunPermissions$' -v -count=1
HIVE_RUNNER_REAL_CLI=codex go test ./internal/runner -run '^TestRealCLIRunPermissions$' -v -count=1
```

Kết quả runner thật: Claude PASS (22,53 giây), Codex PASS (33,01 giây).
Cả bốn lượt đều có đúng 1 commit và file thay đổi là `a.txt`.

Mỗi CLI thử cả workspace và full. Không đặt biến thì test bỏ qua, tránh gọi API trả phí trên CI.
MCP ở test dùng HTTP server cục bộ trả 404; test chỉ kiểm quyền file/lệnh/git, chưa kiểm nghiệp vụ MCP.
Codex dùng tên MCP `xdev-hive-run` để tránh ghép cấu hình HTTP với cấu hình stdio cá nhân tên `xdev-hive`.
`mcp_servers={}` của nhánh #38 không xoá được các server cá nhân khi CLI ghép bảng cấu hình;
PR này không giải quyết việc cách ly toàn bộ cấu hình Codex. Cần xử lý riêng nếu muốn chặn mọi MCP cá nhân.
