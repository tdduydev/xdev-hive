# Research: Điểm tối ưu token trên máy dev

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-18

Nhãn:
- **[Unverified]**: chưa kiểm được từ nguồn chính thức hoặc từ code.
- **[Inference]**: suy luận của người viết.
- "Có chuỗi trong binary": tên khoá có trong binary CLI đã cài trên máy dev Windows (Claude Code 2.1.300, Codex
  0.142.5). Việc này chỉ xác nhận tên, chưa xác nhận cách CLI dùng khoá.

Trang tài liệu được đọc qua công cụ tóm tắt. Trước khi code phải đọc lại trang gốc để kiểm tên khoá và giá trị mặc định.

## 1. Hive đã có gì

Đối chiếu code trên `origin/main` tại `9d2bc66b` ngày 2026-10-18.

### 1.1 Run do hub giao: `tokenSaving`

- `packages/contracts/src/projects.ts:125–206`: cài đặt "Tiết kiệm token" của dự án.
  - Các mục: `enabled`, `bashMaxChars`, `autocompactPct`, `subagentModel`, `cacheTtl`, `autocompactWindow` (mặc định
    200.000), `allowWeb`, `rtk`, `codegraph`, `contextPack`, `exploreBudget` (mặc định 4), `toolOutputMaxChars` (mặc
    định 12.000).
  - Bật mặc định.
- `apps/hub/src/modules/runs/engine.ts`:
  - `:486` `CODEGRAPH_HINT`: câu nhắc agent dùng `codegraph_explore` trước khi grep hay đọc file;
  - `:494` `codegraphAvailable()`: chỉ bật khi máy khai capability `codegraph`, không chạy sandbox, và dự án bật mục này;
  - `:639`: gửi `tokenSaving` trong spec của job.
- `worker/internal/runner/tokensaving.go:118` `savingEnv()`: đổi cài đặt thành biến môi trường của Claude Code. Biến mới
  chỉ đặt khi CLI đủ phiên bản (`setGated`, bảng `claudeMinVersion` ở `claudeversion.go:20`).
- `worker/internal/runner/tools.go:123` `MachineCapabilities()`: máy khai `codegraph` và `rtk` khi tìm thấy công cụ.
  - Trên Windows, worker không khai `rtk` (`:135`) và không gắn RTK vào run (`:207`).
  - Lý do trong code: chưa kiểm Claude Code chạy lệnh hook qua shell nào trên Windows.

Phạm vi: các tối ưu này chỉ áp cho run do hub giao. Phiên người dùng tự mở không nhận được.

### 1.2 Số liệu token của run trên hub

- Bảng `runs` (`apps/hub/src/modules/runs/schema.ts:111–137`):
  - `tokens_in`, `tokens_out`, `cache_read`, `cache_write`, `cost_usd`, `turns`, `account_id`;
  - `explore`: usage trước lần sửa file đầu tiên (ADR 0022);
  - `rtk`: số lệnh qua RTK và số token RTK ước tính đã bớt;
  - `token_guard`: số file context pack, số lệnh khảo sát bị chặn, số ký tự output đã cắt.
- Kiểu dữ liệu: `packages/contracts/src/worker-protocol.ts:150–181` (`exploreUsage`, `rtkUsage`, `guardUsage`, đi trong
  sự kiện `cost`).
- `packages/contracts/src/cost.ts`:
  - `costSummary` nhóm theo `day`, `task`, `cli`, `machine`, `account`;
  - `costExplore.costShare`: tỉ lệ chi phí của phần khảo sát trước khi sửa.
- Web: `apps/web/src/pages/costs-page.tsx` hiện:
  - ô "Cache trúng" (đọc cache ÷ (đọc + ghi cache + token vào));
  - bảng nhóm theo máy;
  - mục "Khảo sát trước khi sửa".
- Trang run (`run-view.ts`) hiện số RTK và guard của từng run.

Giới hạn:
- Chỉ có run của hub.
- Chỉ quản trị đội xem được, và xem theo từng dự án.
- Không có điểm hay đánh giá theo máy.

### 1.3 Spec 015 trên máy client

Spec [015-client-token-optimizer](../015-client-token-optimizer/spec.md),
ADR [0026](../../docs/adr/0026-client-token-optimizer.md). Task T001–T015 đánh dấu xong, một số còn mục "Còn lại"
(mục 1.4). T016 (đo lại sau 7 ngày, lịch 2026-10-21) chưa xong.

| Phần | File | Làm gì |
|---|---|---|
| Bộ tối ưu theo gói | `worker/internal/optimizer/*`, `worker/cmd/hive-worker/optimize.go` | `optimize status/enable/disable/restore/link/report`. Ghi `env` và hook vào `settings.json` của gói Claude, khối đánh dấu vào `config.toml` của Codex. Có sao lưu và manifest. Mức `balanced` và `aggressive` |
| Hook cục bộ | `hive-worker hook pre-tool/post-tool --local` | Cắt output tool trên 12.000 ký tự. Nhắc khi khảo sát nhiều |
| Báo cáo token | `worker/internal/tokenreport/*` | Đọc transcript Claude và Codex trong `~/.xdev-hive/accounts/claude*`, `codex*` và thư mục mặc định (`report.go:82–104`). Số theo nguồn phiên (`aggregate.go:139–169`): `weighted`, `cacheHit`, `medianFirstContext`, `medianPeakContext`, `peakOver150k/400k`, `weightedOver400k`, `compactions`, `rtkSessions`, `guardSessions`. Số chung: bảng tool và lệnh Bash, đọc lại file, token chỉ dẫn mỗi phiên (`instructionsPerSession`, chung mọi gói). Cột trước/sau, `rtk gain`. Transcript subagent tính là phiên riêng (`report.go:194`) |
| Danh sách gói | `optimizeStatus` (`cmd/hive-worker/optimize.go:327`) | Ghép `accounts.json` với manifest. `optimizer.Status()` chỉ trả gói đã có trong manifest (`optimizer.go:363–387`) |
| Hạn mức theo gói | `worker/internal/accounts/usage.go:129–185` | Chạy `claude -p /usage` theo từng gói với `CLAUDE_CONFIG_DIR` và token OAuth của gói. Có cả `agy -p /usage` cho Antigravity (`:135`) |
| Memory | `worker/internal/memstore/*`, `memory-screen.tsx` | Quét memory và file chỉ dẫn, token ước tính, cờ trùng/cũ/link chết/vượt trần. Dùng chung theo dự án. Nén bằng AI có duyệt |
| Màn Token | `apps/desktop/src/screens/tokens-screen.tsx`, `lib/usage.ts`, `src-tauri/src/usage.rs` | Ô token vào 7 ngày, cache trúng, ngữ cảnh lúc đầu (`claude -p /context`), hạn mức gói (`/usage`), bảng phiên. 4 gợi ý rút từ số liệu (`usage.ts:87` `tips()`): `compact`, `subagents`, `cache`, `codexCompact`. Gợi ý chỉ hiện, không sửa gì |
| Khối Tối ưu | `components/optimizer-panel.tsx`, `lib/optimizer.ts`, `src-tauri/src/optimizer.rs` | Bật/tắt/khôi phục theo gói, bảng trước/sau, chép báo cáo số |
| Màn Môi trường | `src-tauri/src/doctor.rs` | Dò công cụ trên máy, gợi ý lệnh cài. Giao diện chỉ gửi id, Rust tự sinh lệnh từ bảng của nó |
| Đếm MCP | `src-tauri/src/setup_extra.rs:150`, `:189` | `claude_mcp_names()`, `codex_mcp_names()` |

### 1.4 Spec 015 còn để mở

- T016 chưa đo (Mac mini, gói `claude-4`…`claude-7`, lịch 2026-10-21). Vì vậy SC-001 và SC-002 của 015 (ngữ cảnh đỉnh,
  token mỗi lượt sau khi bật) chưa có kết quả.
- T011, T012, T013 đánh dấu xong nhưng còn mục "Còn lại" (015 `tasks.md:191`, `:205`, `:222`):
  - `MemoryCompressDialog` và `MemoryHubSync` chưa gắn vào `memory-screen.tsx`;
  - ô chọn context pack chưa có trong `optimizer-panel.tsx`.
- Gemini và Antigravity: không có preset, không đọc transcript.
- RTK trên Windows: worker không gắn. `optimize enable --rtk` trả lỗi "RTK chưa hỗ trợ trên Windows"
  (`cmd/hive-worker/optimize.go:280–283`). Hook của chính Hive (cắt output) vẫn cài được trên Windows ở dạng exec khi CLI
  ≥ 2.1.296. Trên máy dev Windows, người dùng tự cài hook RTK ở mức người dùng và hook đó chạy (mục 2).
- Cache TTL: 015 thấy run ghi cache 1 giờ dù worker đặt `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`. Tài liệu Claude Code nói
  phiên dùng gói thuê bao, còn trong hạn mức, có TTL 1 giờ cho hội thoại chính [Unverified: chưa đọc trang gốc].
  **[Inference]** Đây có thể là lý do. Chưa kiểm biến này có thắng mặc định của gói thuê bao hay không.
- Chưa có số "token trước lần sửa đầu" cho phiên tại máy. Số này chỉ có ở run hub (`explore`).
- Cắt output `memory_search` của hub (research 015 mục 7, dòng 7): chưa làm.
- Màn Token có số liệu, gợi ý và nút bật tối ưu, nhưng không có một con số cho biết máy đã tối ưu tới đâu. Gợi ý không
  dẫn tới nút sửa.

## 2. Đo trên máy dev Windows (2026-10-18)

Lệnh: `hive-worker optimize report --json --days 7` (sidecar trong `~/.xdev-hive/bin`). Chỉ ghi số tổng hợp. Mọi phiên
trong báo cáo thuộc gói mặc định `~/.claude` (`interactiveHome` chỉ có `default`).

Cấu hình:

| Mục | Giá trị |
|---|---|
| CLI | Claude Code 2.1.300, Codex 0.142.5, Gemini CLI có trong PATH, `rtk` 0.51.0, `codegraph` có trong PATH |
| Gói Hive | `claude-1`, `claude-2`, `codex-1`; chưa gói nào bật bộ tối ưu |
| `~/.claude/settings.json` | `model: opus`, `effortLevel: medium`; không có biến trần ngữ cảnh hay trần output; hook `PreToolUse` có RTK; 6 plugin bật |
| `~/.claude.json` | 1 MCP server cấp người dùng (`codegraph`) |
| File chỉ dẫn | `~/.claude/CLAUDE.md` 815 B, `RTK.md` 460 B; `~/.codex/AGENTS.md` rỗng |
| Repo `xdev-hive` | Không có `.codegraph/` |

Phiên Claude tương tác, 7 ngày (Codex không có phiên trong báo cáo):

| Số đo | Giá trị |
|---|---|
| Phiên / lượt API | 151 / 13.115 |
| Token quy đổi | 565,5M |
| Token quy đổi mỗi lượt | 43,1k |
| Cache trúng | 98,7% |
| Ngữ cảnh lượt đầu (trung vị) | 49,2k |
| Ngữ cảnh đỉnh (trung vị) | 179,7k |
| Phiên > 150k / > 400k | 93 / 18 |
| Token quy đổi trong phiên > 400k | 435,4M (77%) |
| Số lần nén | 8 |
| Phiên có RTK / có guard Hive | 143 / 0 |
| Output tool trung bình | 746 token/lượt (13.762 lượt) |
| Tool tốn nhất (phần bị đọc lại) | Bash 42,5%, Read 32,8%, `browser_batch` 9,1%, `codegraph_explore` 3,8% |
| Chỉ dẫn nạp mỗi phiên (trung vị) | Project 1.279, User 305, AutoMem 118 token |
| Đọc lại cùng đoạn file | 1,9% lượt `Read` |
| `rtk gain` (luỹ kế) | 7.533 lệnh, bớt 27,5% output đã lọc (1,0M token), trung bình 787 ms mỗi lệnh |

Nhận xét:
- Giống máy Mac mini ở 015: cache đã trúng cao. Chỗ tốn là ngữ cảnh lớn: 77% token quy đổi nằm ở 18 phiên > 400k.
- Ngữ cảnh lượt đầu 49,2k, cao hơn Mac mini (35,9k). **[Inference]** Phần thêm đến từ danh sách skill của plugin và tool
  của app desktop Claude. Cần `/context` để biết đúng nhóm nào.
- RTK: 787 ms mỗi lệnh là số do `rtk gain` tự báo. **[Unverified]** Chưa rõ số này là thời gian chạy lệnh gốc hay phần
  RTK thêm vào.

## 3. Cách giảm token: nguồn và cách đo trên máy

| # | Cách | Tác dụng theo nguồn | Khoá, lệnh | Đo trên máy thế nào |
|---|---|---|---|---|
| 1 | Prompt caching | Đọc cache 0,1× giá input; ghi cache 5 phút 1,25×, 1 giờ 2×. Trang giá ghi 0,05× cho Opus 5.5 và Sonnet 5.5 [S1]. Đổi model, đổi effort (một số model), bật fast mode, `/compact`, nâng phiên bản CLI, thêm/bớt MCP khi tool không hoãn nạp đều làm mất cache [S2]. Sửa CLAUDE.md giữa phiên không làm mất cache, nhưng chỉ có hiệu lực sau `/clear`, `/compact` hoặc khởi động lại [S2] | `DISABLE_PROMPT_CACHING` (và bản theo model), `CLAUDE_CODE_PROMPT_CACHE_TTL`, `ENABLE_PROMPT_CACHING_1H` [S3]. Có chuỗi trong binary: `DISABLE_PROMPT_CACHING` | Có biến `DISABLE_PROMPT_CACHING*` trong env hoặc `settings.json` là xấu. Tỉ lệ cache trúng từ transcript |
| 2 | Lọc output lệnh (RTK) | README ghi "60–90%" cho lệnh dev thường gặp [S4], là số của nhà phát triển [Unverified]. Chỉ áp cho lệnh Bash, không áp cho Read, Grep, Glob [S4]. Đo ở 015: run worker bớt 1–17% token mỗi lệnh Bash | `rtk init -g`, `rtk init -g --codex`, `rtk gain --all --format json` [S4] | `rtk --version`; hook `PreToolUse` khớp `Bash` có lệnh chứa `rtk` trong `settings.json` |
| 3 | Trần output tool | `BASH_MAX_OUTPUT_LENGTH` mặc định 30.000 ký tự; `MAX_MCP_OUTPUT_TOKENS` mặc định 25.000; `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` mặc định 25.000 [S3]. Hook `PreToolUse` sửa lệnh qua `updatedInput` có thể bớt "từ hàng chục nghìn xuống hàng trăm" token [S5] | Các biến trên; `bashOutputMaxChars` (có chuỗi trong binary); Codex `tool_output_token_limit` [S6] (có chuỗi) | Đọc `env` của `settings.json` gói; hook post-tool của Hive; khối Codex |
| 4 | Chỉ mục code thay grep/read | Anthropic: Claude Code lấy ngữ cảnh "just-in-time" bằng glob và grep [S7]. Tài liệu Claude Code khuyên plugin code intelligence (LSP), không có số [S5]. CodeGraph tự báo 62% ít token hơn [S8] [Unverified, số của nhà phát triển]. Serena không có số [S9]. aider repo map mặc định 1k token [S10] | `codegraph init` tạo `.codegraph/`; MCP `codegraph_explore` | `codegraph --version`; MCP tên `codegraph` trong `~/.claude.json`, `.mcp.json`, `config.toml`; thư mục `.codegraph/` ở dự án |
| 5 | File chỉ dẫn ngắn | Claude Code: CLAUDE.md nên dưới 200 dòng; `@import` không giảm chi phí ngữ cảnh; `MEMORY.md` chỉ nạp 200 dòng hoặc 25 KB đầu [S11]. Codex: `project_doc_max_bytes` mặc định 32 KiB, quá thì ngừng nạp thêm [S12]. Antigravity: file rule quá 24.000 byte bị cắt; rule toàn cục và `always_on` dùng chung 20.000 token [S13] | `claudeMdExcludes`, `.claude/rules/*.md` có `paths:`; Codex `project_doc_max_bytes` (có chuỗi) | Đếm dòng, byte, token ước tính; `instructionsPerSession` của `tokenreport` cho số token nạp thật |
| 6 | Ít MCP và tool | Claude Code hoãn nạp định nghĩa tool MCP theo mặc định, chỉ nạp tên [S14]. `ENABLE_TOOL_SEARCH=false` nạp hết ngay từ đầu; `alwaysLoad: true` ép nạp một server [S3][S14]. CLI như `gh` gọn hơn MCP vì không thêm danh sách tool [S5] | `ENABLE_TOOL_SEARCH`, `alwaysLoad` (có chuỗi); Codex `mcp_servers.<id>.enabled`, `enabled_tools`, `disabled_tools` [S6] (có chuỗi) | Đếm server; tìm `ENABLE_TOOL_SEARCH=false`, `alwaysLoad`; nhóm "MCP tools" của `/context` |
| 7 | Skill nạp theo nhu cầu | Mỗi lượt chỉ nạp mô tả skill; nội dung `SKILL.md` chỉ nạp khi gọi. `disable-model-invocation: true` bỏ mô tả khỏi ngữ cảnh. `skillOverrides` ẩn skill [S15] | `disable-model-invocation`, `skillOverrides` (có chuỗi). Codex `skills.max_context_tokens` [S6] (không có chuỗi trong 0.142.5 [Unverified]) | Đếm skill và tổng độ dài mô tả; nhóm "Skills" của `/context` |
| 8 | Chọn model và effort | Tài liệu chi phí: chi phí cao thường do phiên dài không `/clear` hoặc để Opus làm model mặc định; Sonnet làm tốt phần lớn việc code [S5]. Effort `low…max`; thinking tính như output [S16] | `model`, `effortLevel`, `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL` (có chuỗi); Codex `model_reasoning_effort`, `model_verbosity` [S6] (có chuỗi) | Đọc `settings.json`, `config.toml`; tỉ trọng token theo `message.model` trong transcript |
| 9 | Nén ngữ cảnh | Model 1M token tự nén ở khoảng 967k token theo mặc định; model 200k nén ở 200k [S16]. Cửa sổ lớn làm mỗi lượt đọc cache nhiều hơn. `/clear` giữa các việc không liên quan [S5]. Nén làm mất cache của hội thoại [S2] | `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `DISABLE_AUTO_COMPACT`, `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` (đều có chuỗi); Codex `model_auto_compact_token_limit` [S6] (có chuỗi) | Đọc khoá; số lần nén và ngữ cảnh đỉnh từ transcript |
| 10 | Subagent đọc thay phiên chính | Subagent có cửa sổ ngữ cảnh riêng, phiên chính chỉ nhận bản tóm tắt; nhưng subagent vẫn tính vào hạn mức, và lượt đầu không đọc cache của phiên cha [S17]. Hệ nhiều agent dùng khoảng 15× token so với chat [S18] | `CLAUDE_CODE_SUBAGENT_MODEL`; `model:` trong `.claude/agents/*.md` | Không chấm trực tiếp. Gợi ý theo số `/usage` (`subagent-heavy`, đã có ở `tips()`) |
| 11 | Trần output của model | `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, mặc định theo model [S3]. Output đắt 5× input theo bảng giá [S1]. **[Inference]** Hạ effort thường có tác dụng hơn hạ trần output | Codex `model_verbosity` | Không chấm. Ghi ở gợi ý |
| 12 | `.claudeignore` | Không phải tính năng chính thức; có báo cáo nó không chặn `Read` [S19]. Cách có tài liệu là `permissions.deny` | – | Không chấm |

## 4. Dữ liệu đọc được tại máy

- Claude Code:
  - transcript `<config>/projects/<dự án>/<phiên>.jsonl`; dòng `assistant` có `message.usage` (`input_tokens`,
    `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`) [S20];
  - `tokenreport` của Hive đã đọc các trường này;
  - file quá `cleanupPeriodDays` (mặc định 30 ngày) bị xoá khi CLI khởi động [S21]. Vì vậy máy chỉ giữ khoảng 30 ngày.
- Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, sự kiện `token_count` với số luỹ kế [S22] [Unverified: nguồn
  thứ ba]. `tokenreport` của Hive đã đọc rollout Codex.
- Antigravity: không có log token được tài liệu hoá. Một bài trên diễn đàn Google nói không thấy số token trong
  transcript [S23]. Hive đã đọc hạn mức bằng `agy -p /usage` (`accounts/usage.go:135`), nhưng đó là phần trăm hạn mức,
  không phải token. **[Inference]** Chỉ chấm được cấu hình.
- OpenTelemetry: Claude Code có metric `claude_code.token.usage` [S24], Codex có khối `[otel]` [S25]. Hive chưa nhận
  OTel (`docs/architecture.md:395` ghi "[Chưa làm]"). Spec này không dùng.
- Statusline của Claude Code nhận JSON có `rate_limits.five_hour`, `rate_limits.seven_day`, `prompt_cache` [S26]. App
  hiện đọc hạn mức bằng `/usage`.

## 5. Cơ sở chọn ngưỡng

| Ngưỡng | Cơ sở |
|---|---|
| CLAUDE.md ≤ 200 dòng; `MEMORY.md` ≤ 200 dòng và ≤ 25 KB; `AGENTS.md` ≤ 32 KiB; rule Antigravity ≤ 24.000 byte, rule nạp sẵn ≤ 20.000 token | Tài liệu chính thức [S11][S12][S13]. Quá ngưỡng thì CLI cắt hoặc bỏ phần sau |
| Cache trúng: đủ điểm ở ≥ 90%, 0 điểm ở ≤ 60% | `/usage` báo cờ khi cache miss hoặc ngữ cảnh dài chiếm ≥ 10% usage gần đây [S5]. Gợi ý `cache` hiện có của app dùng mốc 60% |
| Tỉ trọng token ở phiên > 400k: đủ điểm ở ≤ 10% | Cùng mốc 10% của `/usage`. 400k là mốc của 015 |
| Ngữ cảnh đỉnh, ngữ cảnh lượt đầu, token mỗi lượt | **[Inference]** Lấy từ hai máy đo: Mac mini (015) và Windows (mục 2). Run worker là mức tốt đã đạt: đỉnh 61k, lượt đầu 25,9k. Phiên tương tác là mức hiện tại: đỉnh 180–184k, lượt đầu 36–49k, 43–46k token mỗi lượt |
| Trần output Hive: Bash 15.000 ký tự, Read và MCP 15.000 token, Codex 8.000 | Preset `balanced` của 015 |
| Token trước lần sửa đầu | **[Inference]** Không nguồn nào đề xuất số này [S20]. Hive dùng nó cho run (ADR 0022) |

## 6. Ví dụ chấm máy dev Windows

Gói mặc định `~/.claude` của máy dev Windows, theo thang ở [spec.md](spec.md) mục "Thang điểm" và công thức ở
[plan.md](plan.md) mục 2, số ở mục 2.

Giới hạn của ví dụ:
- A4 và B7 chưa đo (cần `/context` theo gói và số mới của `tokenreport`), nên không tính vào điểm.
- A1 dùng đường lùi (không có `/context`).
- A5 mục (3) chỉ xét repo `xdev-hive`, vì báo cáo hiện chưa có danh sách dự án top 3.
- Nhóm B tính nguồn `interactive` (151 phiên). Nguồn `headless` chỉ có 1 phiên, 4 lượt, nên bỏ qua không làm đổi số.

| Tiêu chí | Đo | Điểm |
|---|---|---:|
| A1 Trần ngữ cảnh | Không đặt; đã có phiên > 200k nên coi là model 1M, nén ở khoảng 967k | 0 / 10 |
| A2 Trần output tool | Bash, Read, MCP để mặc định (mỗi mục 0,5); không có hook cắt (0) | 3,00 / 8 |
| A3 File chỉ dẫn | Trung vị nạp khoảng 1,7k token (≤ 2.000); không file nào bị cắt | 5,00 / 5 |
| A5 Chỉ mục code | Có `codegraph`, có MCP; repo chưa có `.codegraph/` | 3,33 / 5 |
| A6 Lọc output lệnh | Có RTK và hook | 3,00 / 3 |
| A7 Cache và phiên bản | Không tắt cache; CLI 2.1.300 | 3,00 / 3 |
| A8 Model và effort | Effort `medium`; chưa đặt model subagent | 2,00 / 4 |
| B1 Ngữ cảnh đỉnh | 179,7k | 8,02 / 12 |
| B2 Phiên > 400k | 77% | 0 / 10 |
| B3 Ngữ cảnh lượt đầu | 49,2k | 0,23 / 8 |
| B4 Cache trúng | 98,7% | 6,00 / 6 |
| B5 Token mỗi lượt | 43,1k | 3,38 / 8 |
| B6 Output tool | 746 token/lượt | 4,62 / 5 |
| **Tổng** | Đo được 87/100 điểm | **41,57 / 87 → 47,8** |

**[Inference]** Bấm "Bật tối ưu Cân bằng" cho gói này thì A1 lên 10 và A2 lên 8, tức thêm 15 điểm trên 87. Điểm lên
khoảng 65 ngay. Nhóm B chỉ đổi sau khi có phiên mới.

## Nguồn

Truy cập ngày 2026-10-18.

- [S1] Prompt caching (Claude API): https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- [S2] How Claude Code uses prompt caching: https://code.claude.com/docs/en/prompt-caching
- [S3] Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- [S4] rtk README: https://github.com/rtk-ai/rtk
- [S5] Claude Code costs: https://code.claude.com/docs/en/costs
- [S6] Codex config reference: https://learn.chatgpt.com/docs/config-file/config-reference (chuyển từ
  developers.openai.com/codex/config-reference); mẫu cấu hình: https://learn.chatgpt.com/docs/config-file/config-sample.md
- [S7] Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [S8] CodeGraph: https://github.com/colbymchenry/codegraph
- [S9] Serena: https://github.com/oraios/serena
- [S10] aider repo map: https://aider.chat/docs/repomap.html
- [S11] Claude Code memory: https://code.claude.com/docs/en/memory
- [S12] Codex AGENTS.md: https://learn.chatgpt.com/docs/agent-configuration/agents-md
- [S13] Antigravity rules: https://www.antigravity.google/docs/rules?tab=ide
- [S14] Claude Code MCP: https://code.claude.com/docs/en/mcp
- [S15] Claude Code skills: https://code.claude.com/docs/en/skills
- [S16] Claude Code model config: https://code.claude.com/docs/en/model-config
- [S17] Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- [S18] How we built our multi-agent research system: https://www.anthropic.com/engineering/multi-agent-research-system
- [S19] Báo cáo `.claudeignore` không chặn Read: https://claudeissues.com/issue/17052-claudeignore-not-blocking-read-tool-access-to-env-files ;
  https://www.theregister.com/2026/01/28/claude_code_ai_secrets_files/
- [S20] Đọc log token của Claude Code và Codex (nguồn thứ ba): https://dev.to/newtorob/claude-code-and-codex-are-logging-your-token-usage-locally-here-is-how-to-read-it-580
- [S21] Claude Code context window: https://code.claude.com/docs/en/context-window ; settings `cleanupPeriodDays` trong
  https://code.claude.com/docs/en/settings [Unverified: trang settings chưa đọc trực tiếp]
- [S22] Codex rollout (nguồn thứ ba, chỉ thấy đoạn trích): https://codex.danielvaughan.com/2026/03/30/codex-cli-session-analytics-jsonl-rollout
- [S23] Token trong Antigravity (diễn đàn): https://discuss.ai.google.dev/t/how-to-check-token-usage-in-antigravity-hooks/172967
- [S24] Claude Code monitoring: https://code.claude.com/docs/en/monitoring-usage
- [S25] Codex advanced config: https://learn.chatgpt.com/docs/config-file/config-advanced
- [S26] Claude Code statusline: https://code.claude.com/docs/en/statusline
- OpenAI prompt caching: https://developers.openai.com/api/docs/guides/prompt-caching (tự động từ 1.024 token)
- Gemini caching: https://ai.google.dev/gemini-api/docs/caching (cache ngầm bật mặc định; mức giảm giá chưa đọc được
  [Unverified])
