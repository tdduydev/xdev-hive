# 80. tokens-plugins-path: bớt token cho agent, kho plugin Claude Code, sơ đồ đường đi của task

Hỏi 10/10: "nghiên cứu cách tối ưu token tối đa nhất", "thêm sơ đồ kiểu code-modernization trong client vs admin", "với kho plugin thêm này vô đi https://github.com/anthropics/claude-plugins-official".

**Trạng thái: bản nháp, chờ người dùng duyệt.** Người dùng chọn ngày 10/10:

- **Token:** nghiên cứu, viết spec, tạo task; chưa sửa code.
- **Kho plugin:** admin duyệt kho trong danh mục tool trên hub, ghim plugin và phiên bản, bật theo project; máy client tự cài khi run dùng.
- **Sơ đồ:** đường đi của task (các bước, bước hiện tại, chỗ người phải quyết), trên desktop theo task/run và trên hub theo project.

Đọc code main `b8d87dcf` ngày 10/10. Số đo token là **ước lượng** (số ký tự ÷ 4), đo trên bản sao `local.db` ngày 9/10 và 19 run trong `runs.db` của một máy Windows. Chỗ nào chưa thử trên máy thật thì ghi [Chưa kiểm].

## 1. Bớt token cho agent

### 1.1 Số đo

| Phần | Cỡ | ≈ token |
|---|---|---|
| Danh sách tool MCP, run task (30 tool) | 17.8 KB | 4.5k |
| Danh sách tool MCP, leader chat (42 tool) | 33.8 KB | 8.5k |
| Danh sách tool MCP, leader hub / leader CLI | 38.9 / 32.4 KB | 9.7k / 8.1k |
| Tool chỉ dành cho vận hành có trong run task (run_*, machine_*, cost_*, tool_*, policy_get, setup_missing, token_usage, skill_propose, artifact_*, task_next, task_claim) | 9.6 KB | 2.4k |
| Khoá `$schema` lặp ở mọi tool / mô tả trường `project` lặp | 1.5 / 1.4 KB | 0.75k |
| Prompt của một run review | 5.2 KB | 1.3k |
| …trong đó danh sách skill | 2.3 KB | 0.6k |
| AGENTS.md | 2.8 KB | 0.7k |
| Lời dặn leader (`--append-system-prompt`) | 4.0 KB | 1.0k |
| Lịch sử chat gửi khi mở phiên mới | tới 24 KB | tới 6k |
| `task_list` mặc định (109 task, 66 đã done) | 54.8 KB | 13.7k |
| `task_list full:true` | 179 KB | 45k |
| `doc_list` (88 doc) | 31.8 KB | 8k |
| `doc_get` trung vị / lớn nhất | 8.5 / 107.9 KB | 2.1k / 27k |
| `memory_search` | 2.2–7.1 KB | ~1k |
| `run_get` lớn nhất (log 48 KB + patch 400 KB) | tới 448 KB | tới 112k |

Run thật của Claude: cache read chiếm 74–96% input, nhưng mỗi run vẫn ghi 20–77k token vào cache, tức phần đầu ngữ cảnh không được dùng lại giữa các run. Run review nhỏ nhất: 19.9k cache write + 56.7k cache read. Có một run tới 1.9M token (R-292954). 12 run Codex trên máy đo đều lỗi nên không có số.

### 1.2 Chỗ tốn

1. **Kết quả tool quá to.** `task_list` trả cả task đã done, lặp `project` ở mọi dòng, kèm note dài (`packages/mcp/src/server.ts:455-470`). `run_get` trả cả patch (`server.ts:552`, `sqlite.ts:1186`). `doc_get` không cắt được theo mục.
2. **Run task nhận cả bộ tool vận hành** mà nó không dùng (`server.ts:134+`), và mô tả tool dài (`propose_policy` 2.6 KB, `propose_plan` 2.5 KB).
3. **Giao thức lặp ba lần:** AGENTS.md (`seed.ts:20`), `INSTRUCTIONS` của MCP (`server.ts:51`), `frameLines` (`prompt-layers.ts:86`). Prompt bảo "đọc AGENTS.md trước" (`prompt-layers.ts:55/76/86`) trong khi Claude Code đã tự nạp nó. AGENTS.md bảo gọi `task_claim` trong khi runner đã nhận task (`runner.ts:2532`). Danh sách skill của run có cả `hive-leader`, skill tự nói không dùng cho task.
4. **Run Claude dùng `--setting-sources user`** (`command.ts:569`). [Chưa kiểm] Profile không có thư mục cấu hình riêng thì run nạp cả plugin và skill của người dùng, ước 4–7k token mỗi run.
5. **Phân loại bằng Codex** (`classify.ts:80`) không tắt `mcp_servers` và plugin như `codexChatArgs` (`chat.ts:186`). [Chưa kiểm] Nó nạp MCP xdev-hive từ cấu hình người dùng.
6. **Leader hub nhét JSON các project vào system prompt** (`chat.ts:86`), nên prompt đổi mỗi khi project hay máy đổi, mất cache.
7. **Không có trần token theo task.** Chỉ có `MAX_MCP_OUTPUT_TOKENS` và `BASH_MAX_OUTPUT_LENGTH`, và chỉ cho Claude (`command.ts:828`).

Chỗ đã ổn: giá trị riêng của run (id task, worktree, SHA) nằm ở tin nhắn người dùng, không ở phần đầu; thứ tự tool MCP cố định; steer và chat dùng `--resume` nên không gửi lại cả ngữ cảnh; cache read/write đã lưu theo run và hiện trên giao diện.

### 1.3 Việc cần làm (xếp theo tiết kiệm ÷ công sức)

| Mục | Làm gì | Ước tiết kiệm | Rủi ro |
|---|---|---|---|
| 80a | `task_list` mặc định bỏ task done, bỏ `project` và trường rỗng; task done không kèm note; `status:"done"` để lấy lại | ~8–10k token mỗi lần gọi | thấp |
| 80b | `run_get` mặc định không kèm patch, log chỉ lấy đuôi ~8 KB; `full:true` để lấy hết | tới ~100k token mỗi lần gọi | thấp |
| 80c | `doc_list` bỏ trường rỗng; `doc_get` thêm `section` và `maxChars`, có cờ báo đã cắt | ~5k mỗi `doc_list`, tới 25k mỗi doc lớn | thấp |
| 80d | Run task chỉ nhận tool cần dùng (18 tool vận hành sau một cờ); bỏ `$schema`, gom mô tả `project`, rút mô tả dài | ~3k token trong mọi run, ~2k ở leader | vừa: agent mất vài tool đọc |
| 80e | Bỏ giao thức lặp trong `frameLines`, bỏ "đọc AGENTS.md trước" với Claude và Codex, sửa dòng `task_claim`, bỏ skill `hubOnly` khỏi prompt run | ~0.5–1k token, có thể bớt một lần gọi tool | thấp |
| 80f | Mỗi profile Claude có thư mục cấu hình riêng hoặc không dùng nguồn `user`; phân loại bằng Codex tắt MCP và plugin | [Chưa kiểm] 4–7k token mỗi run | vừa: đăng nhập và cài đặt của người dùng |
| 80g | Leader hub lấy project qua `project_list` thay vì nhét vào system prompt; lịch sử chat khi mở phiên mới chỉ 8 tin hoặc bản tóm tắt | giữ được cache giữa các lượt, tới ~4k mỗi phiên mới | thấp |
| 80h | Trần token hoặc USD theo task: runner đọc usage từ stream, vượt thì dừng run và ghi lý do | chặn run bất thường như 1.9M token | vừa |

Đo trước và sau: dùng chính bảng 1.1 (script đo đặt trong test của 80a–80e) và số cache write/read của run trên trang Runs. Mục tiêu: run task bớt ít nhất 5k token ngữ cảnh đầu, các tool đọc lớn nhất không vượt 10k token ở chế độ mặc định.

[Chưa kiểm] Claude Code có tự hoãn nạp tool MCP (tool search) hay không, và CLI đang cài có `--max-budget-usd`/`--max-turns` hay không. 80h kiểm việc này trước khi tự viết phần dừng.

## 2. Kho plugin claude-plugins-official

### 2.1 Kho

`anthropics/claude-plugins-official` (HEAD `b8e53f1c`, 9/10): `.claude-plugin/marketplace.json` 190 KB, **315 plugin**. 262 plugin trỏ sang repo khác (`url` hoặc `git-subdir`) và **đều có `sha` 40 ký tự**; 53 plugin nằm trong kho (`./plugins/…`, `./external_plugins/…`) chỉ ghim được theo commit của kho. 301 plugin có `category` (13 loại).

Claude Code (theo tài liệu code.claude.com, [Chưa kiểm] trên máy thật):

- `claude plugin marketplace add <nguồn> --scope user --json`, `claude plugin install <tên>@<kho> --scope user --json`, `claude plugin list --json`.
- Không có tham số chọn phiên bản khi cài; ghim bằng `sha` trong mục của kho.
- `enabledPlugins` chỉ trong `.claude/settings.json` của repo **không** cài plugin nguồn ngoài; `extraKnownMarketplaces` của repo cần trust workspace.
- Ở chế độ `-p` plugin cài nền, lượt đầu có thể chưa có; `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1` bắt chờ.

### 2.2 Hiện trạng Hive

- Danh mục tool có kiểu `plugin` (`packages/core/src/types.ts:540,562`), bảng `tools` và `tool_projects` (`sqlite.ts:468-474`), trang `packages/ui/src/pages/Tools.tsx`. Admin nhập tay từng id plugin.
- Superpowers được seed với nhãn `6.4.2` (`sqlite.ts:941`, `apps/desktop/src/main/runner/tools.ts:44`), nhưng **nhãn này không được kiểm hay cài**: Claude Code cài theo SHA kho đang ghi (`5bf4e78…`), mà `plugin.json` ở SHA đó ghi `6.4.1`.
- Chỉ Claude Code dùng plugin; `codexToolArgs` chỉ giữ MCP (`tools.ts:218-220`).

### 2.3 Thiết kế

- **Hub lưu:** `plugin_sources(id, repo, ref, allowed, added_by)` là danh sách kho được phép, seed sẵn `anthropics/claude-plugins-official`; `plugin_index(source_id, commit, fetched_at, json)` là bản cache `marketplace.json` tại một commit. Làm mới bằng nút và mỗi ngày một lần, luôn lấy theo commit, không theo nhánh.
- **Mục tool kiểu plugin** thêm `pluginSource: {marketplace, commit, entry}`. Mục trong kho được viết lại thành `git-subdir` có `sha` là commit của kho. `package.version` là version trong `plugin.json` nếu có, không thì 12 ký tự đầu của SHA. `toolProblem` đòi SHA 40 ký tự và `agents == ["claude"]`; `toolHash` tính cả `pluginSource`, nên ghim lại thì từng máy phải duyệt lại.
- **Admin:** trong trang Tool có khu Kho plugin: chọn kho, tìm, lọc theo loại; xem chi tiết (mô tả, tác giả, nguồn, SHA, plugin có kèm hook hay MCP không, link GitHub tại SHA đó); nút Ghim (mặc định commit trong bản cache, ô nâng cao nhập SHA khác, hub kiểm SHA có thật); bật theo project dùng `tools.setProject` sẵn có.
- **Máy client:** app ghi một kho cục bộ tên `xdev-hive` (`<appData>/hive-marketplace/.claude-plugin/marketplace.json`) chỉ gồm plugin đã ghim và đã duyệt, đăng ký một lần bằng `claude plugin marketplace add`. Cài bằng `claude plugin install <tên>@xdev-hive`, kiểm bằng `claude plugin list --json` so với `package.version`, lệch thì `claude plugin update`. Run đặt `enabledPlugins` qua `--settings` và `CLAUDE_CODE_SYNC_PLUGIN_INSTALL=1`.
- **An toàn:** chỉ kho trong danh sách cho phép; mỗi plugin ghim SHA 40 ký tự; từ chối nguồn `command`, `npm`, `archive` và `headersHelper`; chỉ admin thêm kho và ghim; audit ghi ai ghim SHA nào; máy duyệt theo hash (`machine_tool_approvals`). Chi tiết plugin liệt kê hook và MCP mà nó mang theo.
- **Mất mạng và app cũ:** bản ghim cũ vẫn chạy khi bản cache của hub cũ; máy mất mạng chạy từ cache của Claude Code, thiếu plugin thì ghi chú vào run thay vì làm run lỗi. App cũ bỏ qua `pluginSource`; heartbeat theo phiên bản app để không gửi mục plugin cho app chưa hỗ trợ.

[Chưa kiểm] trên máy thật: cài từ kho `directory` có giữ đúng SHA không; version Claude Code tự tính cho `git-subdir` có khớp `plugin.json` không. 80l kiểm hai việc này trước khi viết phần cài.

### 2.4 Việc cần làm

| Mục | Làm gì | Cỡ |
|---|---|---|
| 80i | Core: trường `pluginSource`, schema, `toolProblem` (SHA, chỉ Claude), `toolHash`, test | s |
| 80j | Hub: migration `plugin_sources` và `plugin_index`, method `plugins.sources/index/refresh`, lấy `marketplace.json` theo commit | m |
| 80k | Giao diện Kho plugin trong trang Tool: duyệt, tìm, lọc, chi tiết, ghim; chữ vi/en; bước e2e | m |
| 80l | Desktop: kho cục bộ `xdev-hive`, cài, kiểm, cập nhật; `enabledPlugins` và chờ cài trong run | m |
| 80m | Ghim lại superpowers theo SHA thật (6.4.1) kèm migration seed; ra bản app cùng lúc vì đổi hash | s |

## 3. Sơ đồ đường đi của task

Giống bảng các bước của plugin code-modernization: các bước theo thứ tự, bước hiện tại sáng lên, chỗ người phải quyết có dấu riêng.

### 3.1 Các bước

| # | Bước | Lấy từ | Người quyết? |
|---|---|---|---|
| 0 | Chờ | `todo`, không còn phụ thuộc mở | |
| 0b | Bị chặn (nhánh) | `waitingOn` khác rỗng hoặc `blocked` | gỡ phụ thuộc |
| 1 | Đã nhận | `doing` + chủ (audit `tasks.claim`) | |
| 2 | Kế hoạch | `implementation_plans` đang chờ | **duyệt kế hoạch** |
| 3 | Đang chạy | run `running` (máy, profile, model) | |
| 3x | Run lỗi (nhánh) | run `failed`/`rate_limited`, `agent.hold` | **chạy lại** |
| 4 | Review | `review`, verdict của run review, gate `review` | **duyệt / yêu cầu sửa** |
| 4x | Yêu cầu sửa (nhánh) | `requestChanges`, quay về 0 | |
| 5 | Merge | `RunRecord.mr` / `merge`, mục trong hàng merge | **merge** (người, hoặc tự động theo 79m) |
| 6 | Xong | `done` | |
| bên | Chờ duyệt đề xuất | đề xuất từ `holdForApproval` | **duyệt đề xuất** |

Thời điểm và người làm lấy từ audit (`tasks.update`, `claim`, `requestChanges`, `runs.merge`, `auto:*`), `run_records`, `sdlc_gates.decided_by/at`, `task_notes.author`. Hiện chưa có bảng sự kiện riêng cho task, và `history.list` bỏ audit khi lọc theo `taskId` (`sqlite.ts:11116`).

Mẫu:

```
(0 Chờ)✓ ─ (1 Đã nhận duy·10:02)✓ ─ (3 Đang chạy mac-2/claude)✓ ─ [4 Review ⚑ BẠN]● ─ (5 Merge ⚑) ─ (6 Xong)
                                      └ 3x Run #1 lỗi ✕ → chạy lại trên mac-3
```

### 3.2 Thiết kế

- **Method `tasks.path({id})`** trên hub trả các bước đã tính sẵn, mỗi bước `{step, state, at, actor, mode, ref}`, áp quyền, gộp cả audit của chính task. Tính ở hub để web và desktop thấy giống nhau.
- **Component `packages/ui/src/components/TaskPath.tsx`** dùng chung: trạng thái `done | current | human | failed | skipped | todo`, màu theo token `--status-*`; bước hiện tại nhấp nháy nhẹ (tắt khi giảm chuyển động); bước chờ người có biểu tượng người. Nằm ngang từ `md`, dưới 768px thành danh sách dọc; mỗi bước cao ít nhất 44px; `aria-current="step"`.
- **Hub:** khối Đường đi ở đầu tab chi tiết của `TaskDetail` (`packages/ui/src/pages/Tasks.tsx:622`); trang Pipeline có thanh đếm số task ở mỗi bước cho mọi task, không chỉ task trong flow (mở rộng `stepCounts` ở `lib/pipeline.ts:53`).
- **Desktop:** bản gọn trong chi tiết run (`Runs.tsx:823/994`) và Inspector của Board (`Board.tsx:459`).

Chưa quyết: task chưa có trạng thái rollback; dấu tự merge chỉ có khi 79m xong.

### 3.3 Việc cần làm

| Mục | Làm gì | Cỡ |
|---|---|---|
| 80n | `tasks.path` trong core: ánh xạ bước, gộp audit, quyền, test | m |
| 80o | Component `TaskPath`, chữ vi/en, đặt vào `TaskDetail`; bước e2e `task-path` và ảnh mobile | s |
| 80p | Thanh đếm theo bước trên Pipeline cho mọi task | m |
| 80q | Desktop: đặt bản gọn vào chi tiết run và Inspector; smoke desktop | s |

## 4. Thứ tự đề xuất

1. **80a, 80b, 80c, 80e:** nhỏ, rủi ro thấp, bớt token ngay.
2. **80n, 80o:** sơ đồ đường đi trên hub.
3. **80i, 80j, 80k:** kho plugin phía hub.
4. **80l, 80m:** kho plugin phía máy, ra bản app.
5. **80d, 80f, 80g, 80h, 80p, 80q.**

Mỗi mục xong: tăng `version` trong `apps/desktop/package.json` nếu đụng app, đánh dấu [x] trong `docs/roadmap.md`.
