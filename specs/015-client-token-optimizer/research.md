# Đánh giá token và memory trên máy client (2026-10-14)

**Spec**: [spec.md](spec.md) · **Script đo**: [`scripts/token-audit.ts`](../../scripts/token-audit.ts) (ưu tiên `hive-worker optimize report --json` từ `~/.xdev-hive/bin` hoặc PATH; không có binary thì dùng cách đo cũ, có sidecar thì luôn trả JSON).

Đo trên Mac mini dev ngày 14/10/2026, đọc transcript (chỉ đọc) của mọi gói trong `~/.xdev-hive/accounts/*` và thư mục
mặc định `~/.claude`, `~/.codex`. Báo cáo chỉ có số tổng hợp, không có prompt, output tool hay tên dự án.

Chạy lại: `node scripts/token-audit.ts --days 7` (bảng) hoặc `--json`.

Chỗ nào là suy luận, không đo trực tiếp, có ghi **[Inference]**.

## Cách đọc số

- **Nguồn phiên** (script tự chia theo `cwd` và `entrypoint`):
  - `worker`: run do hub giao, trong worktree `~/.xdev-hive/worktrees`, chạy bằng `claude -p`.
  - `hub-terminal`: phiên tương tác trong worktree của worker (terminal từ xa).
  - `headless`: `claude -p` ngoài worker, ví dụ agent chạy song song theo skill `agent-fleet` hoặc script.
  - `interactive`: người gõ, gồm terminal của app, Terminal.app mở từ "Gói agent" và terminal thường.
  - `test`: repo tạm của test. Không tính vào tổng.
- **Token quy đổi** = input + 0,1 × cache đọc + 1,25 × cache ghi 5 phút + 2 × cache ghi 1 giờ + 5 × output. Đây là tỉ lệ
  giá của Anthropic, quy về giá một token input. Số này dùng để so tỉ trọng, không phải hoá đơn. Codex có giá khác nhưng
  dùng cùng cách tính.
- **Token output tool** = số ký tự / 4, vì transcript không ghi token của từng khối.
- **"Bị đọc lại"**: output của một tool nằm trong ngữ cảnh và được đọc lại qua cache ở mọi lượt gọi API sau đó, cho tới
  lần nén kế tiếp. Số này cho biết output đó thực sự tốn bao nhiêu.
- Theo mtime, transcript còn trên máy phần lớn là của 7 ngày gần đây: 2.017 triệu trên tổng 2.685 triệu token quy đổi.

## 1. Kết quả chính

| # | Phát hiện | Số đo (7 ngày) |
|---|---|---|
| 1 | Phiên Claude tương tác chiếm phần lớn chi phí. Không tối ưu nào của worker áp cho chúng | 72,4% token quy đổi. Run worker Claude chỉ 3,1% |
| 2 | Phiên tương tác dùng ngữ cảnh rất lớn: cache đọc trung bình mỗi lượt gấp 4,4 lần run worker | 353k so với 80k token/lượt. 51/244 phiên vượt 400k token |
| 3 | 51 phiên vượt 400k token chiếm phần lớn chi phí tương tác | 84% token quy đổi của nhóm `interactive` |
| 4 | Cache đã trúng tốt. Chỗ tốn là kích thước ngữ cảnh, không phải tỉ lệ trúng | Hit 96,5–98,6% ở mọi nguồn |
| 5 | Output tool tốn nhất là Bash và Read, phần lớn để đọc file (`sed`, `cat`, `grep`), không phải output build/test | Bash 52,7% + Read 41,2% phần bị đọc lại |
| 6 | RTK giúp ít với kiểu việc này, vì RTK nén output lệnh git/test, không nén `sed`/`cat` | Run worker: 578 so với 586 token/lệnh Bash (7 ngày); 556 so với 670 (toàn bộ) |
| 7 | CLAUDE.md và memory nạp mỗi phiên nhỏ so với phần cố định của ngữ cảnh | Project 1.130 token (trung vị), AutoMem 52 token. Ngữ cảnh lượt đầu 36k token |
| 8 | Memory của một dự án bị chia theo gói: mỗi gói Claude có memory riêng, nội dung khác nhau | Dự án lớn nhất: 3 thư mục memory (37, 11, 10 file) |
| 9 | Guard, context pack và cắt output (#238) chưa có trong transcript nào | #238 merge 13:32 ngày 14/10. Số trên là mốc trước #238 |

## 2. Token theo nguồn

### 7 ngày

| Nguồn | Phiên | Lượt API | Token quy đổi | Tỉ trọng | Cache hit | Cache đọc/lượt | Ngữ cảnh lượt đầu (trung vị) | Ngữ cảnh đỉnh (trung vị) | Phiên > 150k | Phiên > 400k | Phiên có RTK |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| claude/interactive | 244 | 32.110 | 1.460,7M | 72,4% | 98,6% | 353k | 35,9k | 184k | 147 | 51 | 112 |
| claude/headless | 240 | 9.983 | 251,3M | 12,5% | 97,8% | 142k | 26,8k | 126k | 94 | 5 | 0 |
| codex/worker | 189 | 9.122 | 133,2M | 6,6% | 97,5% | 97k | 20,8k | 76k | 36 | 0 | – |
| claude/worker | 150 | 3.939 | 62,0M | 3,1% | 96,9% | 80k | 25,9k | 61k | 12 | 0 | 72 |
| claude/hub-terminal | 73 | 3.137 | 56,8M | 2,8% | 97,8% | 108k | 36,7k | 104k | 19 | 0 | 46 |
| codex/headless | 119 | 3.173 | 43,7M | 2,2% | 96,5% | 82k | 20,3k | 65k | 16 | 0 | – |
| codex/interactive | 93 | 765 | 9,4M | 0,5% | 98,1% | 86k | 19,5k | – | 3 | 0 | – |

### Cơ cấu chi phí (7 ngày)

| Nguồn | Cache đọc | Cache ghi | Output | Input không cache |
|---|---:|---:|---:|---:|
| claude/interactive | 77,5% | 16,4% | 6,0% | ~0 |
| claude/headless | 56,3% | 24,2% | 19,5% | ~0 |
| claude/worker | 50,7% | 31,4% | 17,9% | ~0 |
| codex/worker | 66,1% | – | 16,9% | 17,0% |

Ghi chú:
- Phiên tương tác Claude ghi cache 5 phút 102,6M token và cache 1 giờ 55,9M token. Run worker ghi cache 1 giờ 9,3M token
  và cache 5 phút chỉ 0,8M token, dù nhánh tiết kiệm token đặt `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`.
  **[Inference]** Worker đang chạy trên máy là bản cũ hơn thay đổi đó. Cũng có thể CLI bỏ qua biến này với gói
  subscription. Cần kiểm lại sau khi cập nhật worker.
- Số lần nén ngữ cảnh: 23 lần trong 244 phiên tương tác, 0 lần ở mọi nguồn khác.
  **[Inference]** Ngưỡng nén tự động (mặc định gần cửa sổ 1M) gần như không bao giờ tới. Ngữ cảnh cứ lớn dần, và mỗi
  lượt đọc lại toàn bộ qua cache.
- Phiên tương tác dùng thư mục gói `~/.xdev-hive/accounts` có ngữ cảnh đỉnh trung vị 184,5k token (168 phiên). Phiên
  dùng `~/.claude` mặc định cũng 184,3k token (76 phiên). **[Inference]** Một phần lớn phiên "tương tác" theo gói là
  phiên điều phối của skill `agent-fleet` chạy trong terminal, không phải người gõ trong app.

## 3. Output tool (Claude, 7 ngày, không tính test)

| Tool | Lượt | Token/lần | Tổng output | Phần bị đọc lại |
|---|---:|---:|---:|---:|
| Bash | 41.444 | 502 | 20,8M | 52,7% |
| Read | 2.713 | 6.117 | 16,6M | 41,2% |
| Artifact | 157 | 1.336 | 0,2M | 0,7% |
| `mcp__xdev-hive__memory_search` | 181 | 1.249 | 0,2M | 0,5% (toàn bộ: 486 lượt, 3.180 token/lần) |
| `mcp__codegraph__codegraph_explore` | 20 | 6.163 | 0,1M | 0,4% |

Lệnh Bash nhiều nhất (7 ngày):

| Lệnh | Lượt | Token/lần |
|---|---:|---:|
| `sed` (`sed -n a,bp`) | 6.404 | 932 |
| `grep` | 6.904 | 451 |
| `cat` | 3.946 | 1.013 |
| `python3` | 5.237 | 192 |
| `ls` | 1.384 | 484 |
| `git diff` | 630 | 1.264 |
| `git show` | 629 | 751 |

Codex: tool `exec` có 11.642 lượt, trung bình 3.697 token mỗi lần (7 ngày). Đây là output đơn lẻ lớn nhất trong mọi CLI.

Đọc lại file:
- 115 trên 2.712 lượt `Read` (4,2%) đọc lại đúng file và đoạn đã đọc, tổng 0,94M token.
- Đọc lại không phải chỗ tốn chính.

## 4. RTK

| Nguồn | Có RTK: phiên / token mỗi lệnh Bash | Không RTK: phiên / token mỗi lệnh Bash |
|---|---|---|
| worker (7 ngày) | 72 / 578 | 78 / 586 |
| worker (toàn bộ) | 79 / 556 | 316 / 670 |
| interactive (7 ngày) | 112 / 583 | 132 / 381 |
| headless | 0 | 240 / 621 |

Nhận định:
- Ở run worker, RTK giảm 1% (7 ngày) đến 17% (toàn bộ) token mỗi lệnh Bash.
- **[Inference]** RTK chỉ viết lại các lệnh nó biết (git, test, ls…). `sed`, `cat`, `grep` để đọc code thì gần như giữ
  nguyên, mà đây là phần lớn lệnh Bash.
- Nhóm tương tác có RTK thì output Bash lại cao hơn. **[Inference]** Đây là do dự án khác nhau, không phải do RTK.
- Hook RTK ở phiên tương tác không do app cài:
  - Transcript có 3 dạng lệnh hook. Dạng nhiều nhất (`RTK_TELEMETRY_DISABLED=1 … rtk hook claude`, 3.365 lần chạy hook)
    trùng với `.claude/settings.local.json` mà người dùng tự thêm vào một dự án.
  - `settings.json` của các gói và `~/.claude` không có hook nào.
- **[Inference]** 46/73 phiên `hub-terminal` có RTK cũng nhận hook theo cách đó: worker không gắn RTK vào terminal từ xa.

## 5. Tối ưu nào có, tối ưu nào không ở phiên chạy qua app

Đối chiếu code ngày 14/10:
- Worker: `worker/internal/runner/{tokensaving,tools,guard,contextpack,mcp,routing,interactive}.go`.
- Desktop: `apps/desktop/src-tauri/src/{pty,profiles,cli,usage}.rs`.

| Tối ưu | Run worker (hub giao) | Terminal từ xa (`hub-terminal`) | App desktop: terminal trong app, "Gói agent", Terminal.app | `claude -p` tự chạy (agent-fleet) |
|---|---|---|---|---|
| Biến token Claude (`BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS`, cache TTL…) | Có (`savingEnv`, theo phiên bản `claudeMinVersion`) | Có (`PrepareInteractive`) | **Không**. `pty_open` chỉ truyền env trong allowlist và `CLAUDE_CONFIG_DIR` | **Không** |
| `--exclude-dynamic-system-prompt-sections`, giới hạn `--tools` | Có | Có (cờ thứ nhất) | Không | Không |
| `-c` của Codex (`tool_output_token_limit=8000`, `model_auto_compact_token_limit=150000`, `model_verbosity=low`…) | Có | Có | **Không**. `config.toml` của gói chỉ có khối MCP `xdev-hive` | Không |
| Hook RTK (`rtk hook claude`) | Có, qua `--settings` gắn vào từng run, nếu máy có `rtk` | Không | **Không**. `settings.json` của 6 gói Claude và `~/.claude` đều không có hook | Không |
| CodeGraph MCP | Có, `--mcp-config` cho từng run. Máy này không có `codegraph` trong PATH | Không | Không | Không |
| Context pack (#238) | Có, Claude ≥ 2.1.296, qua `--append-system-prompt-file` | Không | Không | Không |
| Ngân sách khám phá + cắt output > 12.000 ký tự (`hive-worker hook pre-tool/post-tool`) | Có (#238, cần `updatedToolOutput`) | Không | **Không**. App có sidecar `hive-worker` nhưng không gọi `hook` | Không |
| Tắt auto-memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`) | Có (run không đọc memory máy) | Có | Không: auto-memory bật, nạp `MEMORY.md` | Không |
| Project brief, memory dự án trên hub (ADR 0022) | Có, hub chèn vào prompt và tool `memory_search` | Có tool MCP | Chỉ màn Knowledge tìm memory (chỉ đọc), không chèn vào phiên | Không (trừ khi cấu hình MCP `xdev-hive`) |
| Skill của hub | Cài vào `.claude/skills` của worktree | – | Màn Skills cài theo dự án | – |

Kết luận: mọi tối ưu của worker gắn theo từng run (cờ, biến môi trường, `--settings` inline, `--mcp-config` tạm). Không
tối ưu nào được ghi vào `settings.json` của gói. Vì vậy phiên mở qua app, hay mở bằng `CLAUDE_CONFIG_DIR` của gói, không
nhận gì. Mà nhóm phiên này chiếm 85% token quy đổi (`interactive` + `headless`).

Màn "Token" (`tokens-screen.tsx`, `usage.rs`) hiện chỉ đọc `CLAUDE_CONFIG_DIR` hoặc `~/.claude` của tiến trình app,
không đọc các gói trong `~/.xdev-hive/accounts`.

## 6. Memory và instruction

### Nạp vào mỗi phiên (attachment `instructions` trong transcript)

| Loại | Số phiên có | Token trung vị | Token tối đa |
|---|---:|---:|---:|
| Project (CLAUDE.md, AGENTS.md, file `@import`) | 631 | 1.130 | 8.583 |
| AutoMem (`MEMORY.md`) | 251 | 52 | 6.381 |

So với ngữ cảnh lượt đầu (trung vị 35,9k token ở phiên tương tác, 25,9k ở run worker):
- CLAUDE.md và memory chỉ chiếm khoảng 3–4%.
- **[Inference]** Phần còn lại là system prompt, định nghĩa tool, MCP (xdev-hive, trình duyệt, codegraph…) và danh sách
  skill. Repo này có 19 skill trong `.claude/skills`.
- Tất cả đều đọc lại qua cache mỗi lượt với giá 0,1×. Với phiên 50 lượt, khoảng 10k token chênh lệch thành khoảng 50k
  token quy đổi. Con số này nhỏ so với phần ngữ cảnh do phiên tự tích luỹ.

Kết luận: với máy này, quản lý memory trước hết là chuyện **đúng và nhất quán** (memory bị chia theo gói, có link chết).
Tiết kiệm token từ memory là phụ, nhưng vẫn cần giữ trần cho `MEMORY.md` và CLAUDE.md.

### Memory trên đĩa

| Mục | Số |
|---|---|
| Thư mục memory Claude (gói × dự án) | 8, thuộc 4 dự án |
| File `.md` | 72 file, 174 KB |
| `MEMORY.md` (tổng các chỉ mục) | 9,4 KB. Lớn nhất 6,0 KB, khoảng 1,5k token nạp mỗi phiên |
| Link chết (`[..](x.md)`, `[[slug]]`) | 3 |
| File không có trong `MEMORY.md` | 1 |
| Cùng tên file ở nhiều gói của cùng dự án | 2 |
| File cũ hơn 30 ngày | 0 (memory mới có từ đầu tháng 10) |
| Dự án lớn nhất | 3 gói giữ 3 bộ riêng: 37 file / 130 KB, 11 file / 16 KB, 10 file / 14 KB |
| Codex | 4 home, mỗi home có `memories_1.sqlite` 45 KB. Không có `AGENTS.md` cấp người dùng. **[Inference]** Cùng cỡ nên có thể chỉ là schema rỗng |
| Gemini, Antigravity | Không có `~/.gemini/GEMINI.md`. Script chưa đọc transcript Gemini/agy |
| Hub (ADR 0022) | Run nhận brief và memory qua tool `memory_search`. Toàn bộ 486 lượt, 3.180 token mỗi lượt: output MCP lớn thứ ba |

Vấn đề:
1. **Chia mảnh**: memory Claude gắn với `CLAUDE_CONFIG_DIR`, nên mỗi lần đổi gói (khi quota cạn) agent mất phần đã học ở gói
   kia. Cùng một dự án có 3 bộ memory khác nhau.
2. **Không đi lên hub**: worker tắt auto-memory. Những gì agent học khi người dùng làm tay không tới run của hub, và ngược lại.
3. **Không ai dọn**: đã có link chết, file mồ côi, file trùng tên. Không công cụ nào báo về chúng.

## 7. Đòn bẩy, xếp theo tác động ước tính

| # | Việc | Áp cho | Ước tính |
|---|---|---|---|
| 1 | Đặt biến token Claude vào `env` trong `settings.json` của gói (`CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=70`, trần output Bash/Read/MCP) | interactive, headless, Gói agent | **[Inference]** Giảm 30–45% token quy đổi của phiên tương tác. 84% chi phí nhóm này nằm ở phiên > 400k, cache đọc là 77,5%. Đưa đỉnh về khoảng 140k (mức headless) thì cache đọc mỗi lượt giảm khoảng 60%, trừ đi chi phí nén. Phải đo trước/sau |
| 2 | Hook `hive-worker hook post-tool` ở chế độ cục bộ: cắt output > 12k ký tự, giữ bản đầy đủ trong file | như trên | **[Inference]** Vài %. Output Bash trung bình 502 token, chỉ phần đuôi lớn bị cắt |
| 3 | Hook pre-tool chặn `cat`/`sed` cả file lớn, gợi ý `Read` có offset/limit | như trên | **[Inference]** `sed` + `cat` đứng đầu phần bị đọc lại. Tác động trung bình, nên mặc định chỉ nhắc, không chặn |
| 4 | Khối `-c` Codex vào `config.toml` của gói (`tool_output_token_limit`, `model_auto_compact_token_limit`) | Codex tương tác, headless | `exec` 3.697 token mỗi lần. Codex chỉ chiếm 9% tổng nên tác động tuyệt đối nhỏ |
| 5 | RTK cài theo gói (nếu máy có `rtk`) | Claude | Nhỏ theo số đo ở mục 4. Nên để tuỳ chọn |
| 6 | Gộp memory theo dự án, giữ trần `MEMORY.md` | mọi phiên | Token nhỏ (vài trăm đến 1,5k token mỗi phiên). Lợi ích chính là đúng và nhất quán |
| 7 | Cắt output `memory_search` của hub (ít kết quả, đoạn ngắn hơn) | run hub | Ngoài phạm vi client, ghi làm việc tiếp theo cho hub |

## 8. Giới hạn của phép đo

- Token output tool tính theo ký tự / 4. Tiếng Việt có dấu thường tốn hơn.
- Chia nguồn theo đường dẫn và `entrypoint` là heuristic: phiên "interactive" gồm cả terminal app và terminal ngoài.
- Không so được trước/sau cho guard, context pack và cắt output, vì chưa có transcript nào sau #238.
- Chưa đọc transcript Gemini, Antigravity, OpenCode.

## 9. Dùng chung memory giữa các gói: liên kết hay cài đặt (T010, 2026-10-14)

Câu hỏi: nếu `projects/<khoá>/memory` của mỗi gói là liên kết tới một thư mục chung, Claude Code có dùng được không?

### Cách thử

- Claude Code 2.1.299 thật (binary máy dev), chạy `claude -p` trong `HOME`, `CLAUDE_CONFIG_DIR` và dự án giả, không dùng
  gói thật của người dùng.
- Đăng nhập thật không dùng được trong thư mục giả, nên `ANTHROPIC_BASE_URL` trỏ về một máy chủ giả ở `127.0.0.1`. Máy chủ
  này trả một lệnh `Write` vào thư mục memory. Phần CLI (đường dẫn memory, quyền ghi, đọc `MEMORY.md`) là code thật.
- Mỗi trường hợp chạy ở chế độ quyền `default`, để thấy CLI có tự cho phép ghi vào thư mục memory hay không.

### Kết quả

| Trường hợp | Đọc `MEMORY.md` | Ghi file mới vào `memory/` | Liên kết bị thay |
|---|---|---|---|
| Đối chứng: `memory/` là thư mục thật | Có | **Tự cho phép** | – |
| `memory/` là symlink tới thư mục chung | Có (nạp như `AutoMem`, đường dẫn dưới liên kết) | **Không**: "Claude requested permissions to write to …/memory/written.md, but you haven't granted it yet" | Không (liên kết còn nguyên sau khi khởi động và sau phiên) |
| `autoMemoryDirectory` trong `<dự án>/.claude/settings.local.json` | Có | **Tự cho phép** | – |

Giải thích **[Inference]**: CLI so đường dẫn thật của file với `projects/<khoá>/memory/`. Qua symlink, đường dẫn thật nằm ngoài
thư mục đó nên việc ghi bị coi là ghi file thường và hỏi quyền. Phiên tương tác sẽ hỏi quyền ở mỗi lần agent lưu memory.

Windows: chưa thử (không có máy Windows trong lần kiểm này). Junction cũng đổi đường dẫn thật, nên **[Inference]** gặp cùng vấn đề.

Cài đặt `autoMemoryDirectory` có trong schema settings của 2.1.299: "Custom directory path for auto-memory storage",
bỏ qua nếu nằm ở `projectSettings` (`.claude/settings.json` được commit), nhận `~/`. Đặt ở `settings.json` của gói thì áp cho
mọi dự án của gói, nên không hợp với memory theo dự án. Đặt ở `.claude/settings.local.json` của dự án thì áp cho dự án đó
với mọi gói.

### Quyết định

- `share` **không dùng liên kết** (và không đồng bộ hai chiều theo mtime). Nó dùng cách CLI hỗ trợ (spec US4, kịch bản 2):
  - thư mục thật `~/.xdev-hive/memory/claude/projects/<khoá>/memory/`, bố cục như một thư mục cấu hình Claude để `Scan`
    quét nó như gói `shared` mà không phải sửa `scan.go`;
  - `autoMemoryDirectory` trỏ tới thư mục đó trong `<dự án>/.claude/settings.local.json`;
  - thư mục `memory/` riêng của từng gói được sao lưu rồi xoá. `unshare` chép bản chung lại cho từng gói, gỡ cài đặt và cho
    thư mục chung vào thùng rác.
- Chỉ bật khi `claude --version` ≥ 2.1.299 (phiên bản duy nhất đã thử). Bản cũ hơn hoặc không đọc được: báo lỗi, không có
  đường lùi.
- Hệ quả:
  - Cách này áp cho mọi gói Claude cùng lúc, kể cả gói thêm sau.
  - Chỉ có hiệu lực khi chạy Claude trong thư mục dự án có file cài đặt. Worktree chưa có file này (file không vào git) thì
    dùng memory riêng của gói.
  - Hive tạo `settings.local.json` trong repo của người dùng, và thêm dòng vào `.git/info/exclude` nếu git chưa bỏ qua nó.
    `unshare` dọn cả hai.
  - Kiểm sau `share` trên `HOME` giả bằng `hive-worker` đã build và `claude` thật (máy chủ giả): phiên của `claude-2` đọc
    được `MEMORY.md` chung và ghi `from-claude-2.md` vào thư mục chung mà không hỏi quyền.

## 10. Đo trước/sau (T016)

### Cách đo

- Mốc nền được lưu ngày 14/10/2026, trước khi bật `balanced` cho bốn gói Claude. Mỗi báo cáo tổng hợp dùng
  `hive-worker optimize report --json --days 7 --profile claude-4` (lặp lại với `claude-5`, `claude-6`, `claude-7`).
- Sau 7 ngày, đối chiếu báo cáo tự chạy ngày 21/10/2026 của cùng gói với mốc nền tương ứng. Chỉ ghi số tổng hợp; không
  đưa nội dung prompt, output hay đường dẫn máy vào báo cáo này.
- Token quy đổi theo công thức ở mục 2: input + 0,1 × cache đọc + 1,25 × cache ghi 5 phút + 2 × cache ghi 1 giờ +
  5 × output. Cache hit là tỉ lệ input được phục vụ từ cache. Ngữ cảnh đỉnh và số phiên vượt ngưỡng được tính theo
  từng phiên, với các ngưỡng >150k và >400k token.
- Đọc cache write 1 giờ và 5 phút theo số token ghi của từng loại TTL trong báo cáo; đây là số liệu mô tả, không cộng
  trực tiếp với nhau để suy ra tiết kiệm.

### Mốc nền theo gói

| Gói | Phiên | Lượt gọi | Token quy đổi | Cache hit | Phiên đỉnh >150k | Phiên đỉnh >400k | Cache write 1 giờ | Cache write 5 phút | Sau 7 ngày |
|---|---:|---:|---:|---|---:|---:|---:|---:|---|
| claude-4 | 188 | 8.161 | 186,3M | Không có trong bản trích xuất | 45 | 4 | 16,63M | 6,88M | đo 2026-10-21 |
| claude-5 | 145 | 5.316 | 127,2M | Không có trong bản trích xuất | 32 | 2 | 13,94M | 1,43M | đo 2026-10-21 |
| claude-6 | 201 | 18.679 | 700,1M | Không có trong bản trích xuất | 134 | 39 | 25,40M | 67,59M | đo 2026-10-21 |
| claude-7* | 31 | 1.700 | 46,9M | Không có trong bản trích xuất | 18 | 2 | 5,00M | 0,22M | đo 2026-10-21 |

Nguồn các số nền là báo cáo 7 ngày trước thời điểm bật `balanced`, gộp các nguồn `claude/headless`,
`claude/hub-terminal`, `claude/interactive`, `claude/worker` và `claude/test` có trong bản trích xuất. Các cột số
đếm và token là tổng của những dòng nguồn được cung cấp; cache write giữ nguyên đơn vị token. Tỉ lệ cache hit không
có trong bản trích xuất nên không thể tính chính xác từ các trường còn lại. *Bản trích xuất claude-7 chỉ có dòng
`claude/headless`; các số claude-7 chưa đại diện đầy đủ mọi nguồn. Không đưa nội dung prompt, output hay đường dẫn
riêng tư vào bảng.

### Ngưỡng đối chiếu

- **SC-001**: sau 7 ngày mức `balanced`, trung vị ngữ cảnh đỉnh của phiên tương tác phải ≤200k token; số phiên có
  đỉnh >400k phải giảm ít nhất 80% so với mốc nền.
- **SC-002**: token quy đổi trung bình mỗi lượt API của phiên tương tác phải giảm ít nhất 25% so với mốc 7 ngày trước
  khi bật. Mốc chung hiện có ở mục 2 là 1.460,7M / 32.110 ≈45,5k token/lượt; kết quả T016 cần so sánh cùng tập
  bốn gói và cùng khoảng thời gian.
- Mốc supplied cho `interactive` có 41 phiên >400k ở các dòng claude-4/5/6, trong khi SC-001 ghi 51 phiên; cần xác
  minh phạm vi/tập nguồn trước khi kết luận phần trăm giảm. Bản trích xuất hiện cũng thiếu nguồn claude-7 và không
  có số trung vị đỉnh theo phiên, nên chưa đủ để đánh giá đầy đủ SC-001/SC-002. Cột “Sau 7 ngày” ghi lịch đo
  2026-10-21, chưa có kết quả; T016 chưa hoàn tất và không được đánh dấu xong.
