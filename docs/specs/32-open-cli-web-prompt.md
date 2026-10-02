# 32. Mở CLI theo gói và prompt từ web

Viết ngày 2/10. Người dùng hỏi: trên client có chỗ mở Claude Code bằng profile claude-1, claude-2… để tự code, web admin cũng chọn được profile để prompt; và "hỗ trợ agent map, một lần chạy được nhiều agent". Người dùng chọn:
- nút mở CLI chạy trong **repo của dự án** (không phải worktree của task);
- trên web là **prompt tự do thành run**: chọn máy + gói, hub tự tạo task, máy chạy headless;
- agent map gồm cả ba: **fan-out một prompt** cho nhiều agent, **map nhiều task → agent** trong một lần gửi, và **bản đồ trực quan** máy → gói → run.

Agent map đã có roadmap 31 (R-31a–d trên hub, do một phiên khác tạo lúc 12:28 cùng ngày: batch-run, agent-map, map-reduce, multi-role). Mục này chỉ gồm hai phần người dùng hỏi riêng: R-32a (mở CLI) và R-32b (prompt từ web), không phụ thuộc nhau. Fan-out, map task → agent và bản đồ nằm ở [31-agent-map.md](31-agent-map.md).

## Cơ chế có sẵn

- **Mở terminal**: `openInTerminal` / `terminalScript` (`apps/desktop/src/main/terminal.ts`) ghi một script (`login.command`, `login.sh`, `login.cmd`) rồi mở Terminal / cmd / terminal Linux. Dùng cho *Đăng nhập* (`openLogin`) và `claude setup-token` (`openSetupToken`) trong `apps/desktop/src/main/index.ts`. Env trong script là env không bí mật (thư mục đăng nhập).
- **Env của gói**: `loginParts(profile)` trả env đăng nhập (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); `LOGIN_DIR_ENV` theo loại; `resolveBin(expandHome(profile.bin), PATH)`.
- **MCP của Hive cho một agent**: `mcpEntry(agent, project)` và `runMcpServers` (`apps/desktop/src/main/installer.ts`) — server `xdev-hive` qua shim `hive-mcp`, env `HIVE_AGENT`, `HIVE_PROJECT` (shim tự đọc token, env không có secret). Run Claude dùng `--strict-mcp-config --mcp-config` (`claudeRunArgs`, `runner/command.ts`); Codex dùng `-c mcp_servers.xdev-hive.env={…}` (`codexArgs`).
- **Xếp run từ web**: `runs.dispatch` (`packages/core/src/sqlite.ts`, khoảng dòng 3604) kiểm: dự án không dừng, máy online, bật *Được nhận run từ hub*, có repo, task thuộc dự án, chưa xong, không chờ task khác, gói ghim có và đang bật, best-of-n không ghim gói, không có yêu cầu chờ cho task, không máy nào đang chạy task, trần chi tiêu, chỉ dẫn không có ký tự ẩn / secret. Ghi `run_requests`; máy nhận ở heartbeat (`Runner.heartbeat` → `#takeRequests`), báo `runs.requestResult`.
- **Một task chỉ có một run** tại một thời điểm trên toàn hub (lease + kiểm ở trên). Nên nhiều agent cùng làm "một việc" phải là nhiều task.
- **Best-of-n** (roadmap 12): 2–4 bản của một task trên **một máy**, branch `ai/<task>+c<n>`, giám khảo chọn. Không đổi trong mục này.
- **Song song**: mỗi gói chạy tối đa `maxConcurrent` (1–8) run (`runner/schedule.ts`). Máy chạy nhiều gói cùng lúc. Hub không biết `maxConcurrent` (heartbeat chưa báo).
- **Máy & gói trên hub**: `machines.list` → `Machine.profiles: ReportedProfile[]` (bật, đã cài, đăng nhập, % phiên/tuần, nghỉ tới, số run, ưu tiên) và `Machine.runs: MachineRun[]` (run đang chờ/chạy, gói, task, từ lúc nào; chưa có việc agent đang làm).
- **Trang**: *Task* có `DispatchForm` (`packages/ui/src/pages/Tasks.tsx`), *Máy & run* (`Machines.tsx`), *Gói sub* (`Agents.tsx`), *Lượt chạy* (`Runs.tsx`).

## R-32a. Mở CLI của một gói trong repo dự án (desktop)

Nút **Mở Claude Code** (Codex: *Mở Codex*, Gemini: *Mở Gemini*) trên thẻ gói ở trang *Gói sub*, và trên thẻ dự án ở trang *Dự án* (chọn gói). Cả hai mở hộp chọn: dự án (các dự án có repo trên máy) và gói (gói đã cài; gói chưa đăng nhập hiện lý do và nút *Đăng nhập*).

**Main** (`index.ts`): `openCli(profileId, project)`:
- Tìm gói và dự án như `openLogin`; CLI không có → `desktop.cliNotFound`; repo không còn → `errors.repoMissing` (thêm khoá nếu chưa có).
- Gói biết là chưa đăng nhập (`logins` nói `false`) → lỗi `desktop.cliSignedOut` kèm tên gói; `null` (chưa biết) thì vẫn mở.
- Lệnh, không có `-p` (phiên tương tác của người dùng):
  - claude: `--mcp-config <json>` với đúng server `xdev-hive` của `mcpEntry(profile.id, project)`. Không `--strict-mcp-config`, không `--settings` / `--setting-sources`: đây là phiên của người dùng, giữ MCP, hook, plugin của họ và của repo.
  - codex: `-c mcp_servers.xdev-hive.env={HIVE_AGENT=…,HIVE_PROJECT=…}` như `codexArgs` (phần env), không `exec`.
  - gemini / custom: chỉ bin, env `HIVE_AGENT` / `HIVE_PROJECT` trong script.
  - Không thêm `profile.args` của run (đó là cờ headless như `-p`, `--output-format`).
- Env của script: env đăng nhập của gói (`loginParts(profile).env`) + `HIVE_AGENT`, `HIVE_PROJECT`. Không token.
- Thư mục script: `<config>/cli/<profile>/` (không ghi đè script đăng nhập).
- Không áp chính sách agent 27a và không tính vào trần 27b: người ngồi trước máy điều khiển phiên, như khi tự gõ `claude`. Ghi rõ điều này trong README.

**terminal.ts**: `TerminalCommand.cwd?: string`.
- sh: `cd <shq(cwd)> || exit 1` trước lệnh.
- cmd: `cd /d <cmdq(cwd)>` (cmdq đã từ chối ký tự phá chuỗi).
- `done` của phiên CLI: "Phiên đã kết thúc." (khoá mới).

**IPC**: `desktop:openCli` trong `registerIpc`, `openCli` trong preload, kiểu trong `packages/ui` (giống `openLogin`).

**Đã kiểm (2/10, Claude Code 2.1.283, chế độ `-p`)**: repo có `.mcp.json` với server `xdev-hive` (env `HIVE_AGENT=claude`), chạy thêm `--mcp-config` có server cùng tên (env `HIVE_AGENT=claude-2`): chỉ một server chạy, là bản của `--mcp-config`. Không có `--mcp-config` thì bản của repo chạy. Chế độ tương tác chưa kiểm riêng.

**Test**
- `apps/desktop/test/terminal.test.ts`: script có `cd` đúng cho darwin / linux / win32; đường dẫn có dấu `'` và khoảng trắng; cmd từ chối `"` trong đường dẫn.
- Test cho phần dựng lệnh (tách thành hàm thuần `cliCommand(profile, project, repo)` trong một file không import Electron): claude có `--mcp-config` chứa `HIVE_AGENT":"claude-2"`, không có `-p`; codex có `-c mcp_servers.xdev-hive.env=`; env có `CLAUDE_CONFIG_DIR` của gói.
- Smoke: ảnh trang *Gói sub* có nút và hộp chọn.

## R-32b. Prompt tự do từ web thành run

Trên trang *Task* (nút **Prompt cho agent** cạnh *Tạo task*) và từ bản đồ (31e). Form: prompt (bắt buộc, tối đa 4000 ký tự, giới hạn của `instructions`), tiêu đề (tuỳ chọn), máy, gói (hoặc *Tự xoay*), *Review chéo sau khi xong*.

**Method mới `runs.prompt`**
```ts
"runs.prompt": z.object({
  project,
  title: z.string().max(120).optional(),
  prompt: z.string().min(1).max(4000),
  machineId: machineRef,
  profileId: z.string().max(40).nullable().default(null),
  reviewAfter: z.boolean().default(false),
})
// → { task: Task; request: RunRequest }
```
- Role và quyền như `runs.dispatch` (quản trị dự án), cộng quyền tạo task của dự án (`#check`).
- Trong một giao dịch: kiểm máy / gói / trần / ký tự ẩn / secret như `runs.dispatch` → tạo task `P-<n>` (id task là của cả hub, nên n đếm chung mọi dự án: số lớn nhất của các task `P-<số>` + 1), tiêu đề = `title` hoặc dòng đầu của prompt (cắt 120 ký tự), ghi chú = prompt (cắt 2000 ký tự) → ghi `run_requests`. Runner luôn đưa ghi chú task vào prompt của agent, nên `instructions` để trống khi ghi chú đã chứa đủ prompt; prompt dài hơn 2000 ký tự thì `instructions` = cả prompt.
- Tách phần kiểm của `runs.dispatch` thành `#assertDispatchable({ machineId, project, task?, profileId, role, candidates, instructions }, actor)` dùng chung; `runs.dispatch` giữ nguyên hành vi (test cũ phải qua).
- Nhật ký (`AUDITED`) ghi `runs.prompt`; `chatAction` không đổi trong mục này.

**UI**: `PromptDialog` trong `packages/ui/src/components/`, dùng lại phần chọn máy/gói của `DispatchForm` (tách thành `MachineProfilePicker`). Gửi xong mở panel của task mới (đã có danh sách yêu cầu và trạng thái). Ẩn khi desktop ở chế độ cục bộ (không có hub).

**Test**
- `packages/core/test/`: tạo task + yêu cầu trong một lần; id `P-1`, `P-2`; lỗi kiểm (máy offline, gói tắt, secret trong prompt) không để lại task; người không phải quản trị dự án bị từ chối.
- e2e web: gửi một prompt, thấy task `P-1` với yêu cầu đang chờ.

## Agent map

Fan-out, giao nhiều task một lần và bản đồ agent nằm ở roadmap 31: [31-agent-map.md](31-agent-map.md).

## Chữ trên giao diện

Mọi chữ mới vào `packages/ui/src/i18n/locales/vi.ts` (gốc) và `en.ts`; khoá lỗi mới (`errors.taskTwiceInBatch`, `desktop.cliSignedOut`, …) có bản dịch ở cả hai.

## Chưa làm trong mục này

- Phiên tương tác từ xa trên web (gõ nhiều lượt vào Claude Code đang chạy trên máy client).
- Giám khảo tự động cho nhóm fan-out (so diff nằm trên nhiều máy).
- Fan-out cho task đã có (hiện chỉ cho prompt mới); best-of-n vẫn là cách chạy nhiều bản của một task trên một máy.
