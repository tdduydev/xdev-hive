# Implementation Plan: Điểm tối ưu token trên máy dev

**Branch**: `025-token-score` · **Date**: 2026-10-18 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

Plan viết theo khuyến nghị của Q1–Q11 trong spec. Chủ dự án chưa chốt.

## Tóm tắt

Thêm lệnh `hive-worker optimize score` vào sidecar Go. Lệnh này chấm điểm 0–100 cho từng gói CLI và cho cả máy:
- **nhóm A (cấu hình)**: đọc file cấu hình của gói, công cụ trên máy, file chỉ dẫn, và `/context` của gói;
- **nhóm B (số liệu phiên)**: dùng `tokenreport` của 015, thêm vài số mới.

App desktop thêm:
- thẻ "Điểm tối ưu token" ở đầu màn Token, có chi tiết từng tiêu chí;
- nút sửa nhanh nối với lệnh có sẵn (`optimize enable`, `mcp_add_argv`, cài công cụ của màn Môi trường);
- lịch sử điểm 30 ngày, huy hiệu điểm trên thanh điều hướng.

Hub chỉ đổi ở P3 (Q5): nhận điểm, web hiện cột điểm ở danh sách máy.

Phần không đổi:
- preset `balanced`/`aggressive` của 015;
- worker chạy run hub, giao thức worker;
- `tokenSaving` của dự án.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | Go (sidecar `hive-worker`), Rust (Tauri), TypeScript strict (desktop; P3: hub, web) |
| Phụ thuộc mới | Không |
| Lưu trữ | File cục bộ trong `~/.xdev-hive/optimizer/`: `score-history.jsonl`, `context-cache.json`. P3: bảng hub `machine_token_scores` |
| Test | `go test` với `HOME`/`USERPROFILE` giả và fixture; `GOOS=windows go vet`; Vitest cho desktop; Rust test cho bảng sửa nhanh; P3: `*.db.test.ts`, Playwright |
| Hiệu năng | SC-001: thẻ điểm ≤ 3 giây khi đã có cache |
| Nền tảng | macOS, Linux, Windows. Máy dev Windows không có Rust: phần Rust kiểm bằng CI |

## Constitution Check

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | P1–P2 không có API hub. JSON của sidecar có kiểu TypeScript trong `lib/token-score.ts`, có test khớp với fixture Go. P3: `packages/contracts/src/fleet.ts`, `pnpm openapi` |
| II. Tenant isolation | P3: bảng mới có `org_id`, `team_id`, bật và ép RLS, có trong `modules/fleet/rls.db.test.ts` |
| III. Module boundaries | P3: thêm vào module `fleet` của hub, không import chéo |
| IV. Tested | Test bảng cho từng tiêu chí và mục con (SC-002); test hoàn tác đúng từng byte (SC-003); test riêng tư (SC-005) |
| V. Secure by default | Sửa nhanh theo bảng cho phép, giao diện chỉ gửi id (như `doctor.rs`). Không gửi gì ra mạng khi chưa bật US6 |
| VI. Ngôn ngữ | Chữ giao diện, lỗi tiếng Việt. Code, commit tiếng Anh. Spec tiếng Việt theo yêu cầu chủ dự án: **lệch** VI, ghi ở Complexity Tracking |
| VII. Simple to self-host | Không thêm dịch vụ. P3 thêm một bảng |
| Giao diện | Navy Hive, `@xdev-hive/ui`, token màu, sáng/tối, 360 px, bàn phím |

## Kiến trúc

```
apps/desktop (React)   tokens-screen.tsx: <TokenScoreCard> + chi tiết + lịch sử;  app-nav.tsx: huy hiệu
        │ invoke
src-tauri/token_score.rs   token_score(fresh)       → sidecar `optimize score --json`
                           token_score_last()       → đọc dòng cuối score-history.jsonl (huy hiệu)
                           token_score_fix(fixId, profileId, projectKey?)
                             ├─ optimizer.* → sidecar `optimize fix`
                             └─ tool.*, codegraph.* → chạy lệnh từ bảng của Rust (doctor.rs, mcp_add_argv)
        │ spawn
hive-worker optimize score --json [--profile P] [--days 7]
        ├─ profiles.List()        accounts.json + manifest: id, cli, configDir, mức, khoá Hive đặt
        ├─ score/context.go       claude -p /context theo gói (như accounts.ReadUsage), cache 10 phút
        ├─ score/config_*.go      settings.json, .claude.json, config.toml, rule Antigravity
        ├─ memstore.Scan()        file chỉ dẫn, MEMORY.md (thêm số dòng, byte)
        ├─ tokenreport.Build()    nhóm B theo gói, có cache
        └─ score/criteria.go      bảng tiêu chí, công thức, scoreVersion
hive-worker optimize fix <fixId> --profile P [--preview]
        └─ optimizer.Enable(balanced | aggressive, rtk)
~/.xdev-hive/optimizer/score-history.jsonl
```

### Cấu trúc file

| Phần | File |
|---|---|
| Danh sách gói dùng chung | Tách phần gộp manifest với `accounts.json` khỏi `optimizeStatus` (`worker/cmd/hive-worker/optimize.go:327–375`) sang `worker/internal/optimizer/profiles.go` (mới), `optimizeStatus` gọi lại hàm đó |
| Tiêu chí, công thức | `worker/internal/score/criteria.go`, `score.go` (mới) |
| Đo cấu hình | `worker/internal/score/config_claude.go`, `config_codex.go`, `config_agy.go`, `tools.go`, `context.go` (mới) |
| Lịch sử | `worker/internal/score/history.go` (mới) |
| Số mới của báo cáo | `worker/internal/tokenreport/report.go` (gốc quét từ `accounts.json`), `session.go`, `transcript.go`, `aggregate.go`, `cache.go` (tăng `cacheVersion`) |
| Memory | `worker/internal/memstore/scan.go`: thêm `Lines`, `Bytes` vào `File` |
| Lệnh con | `worker/cmd/hive-worker/optimize.go`: thêm `case "score"`, `case "fix"` |
| Tauri | `apps/desktop/src-tauri/src/token_score.rs` (mới), đăng ký trong `lib.rs`, khai lệnh trong `build.rs` và `capabilities/app.json` |
| Cài công cụ | `apps/desktop/src-tauri/src/doctor.rs`: thêm mục `rtk`, `codegraph` vào bảng cài |
| UI | `apps/desktop/src/lib/token-score.ts`, `components/token-score-card.tsx`, `components/token-score-detail.tsx` (mới); một dòng trong `tokens-screen.tsx`; huy hiệu trong `shell/app-nav.tsx` |
| Gợi ý cũ | `apps/desktop/src/lib/usage.ts` `tips()`: giữ hàm, hiện dưới tiêu chí liên quan thay cho khối riêng |
| Hub (P3) | `packages/contracts/src/fleet.ts`, `apps/hub/src/modules/fleet/` (schema, route, `rls.db.test.ts`), migration trong `apps/hub/db/migrations`, trang máy ở `apps/web` |
| Tài liệu | `docs/token-optimizer.md`: thêm mục "Điểm tối ưu token"; ADR 0026: thêm đoạn "Score" |

## Thiết kế từng phần

### 1. JSON điểm

```json
{
  "scoreVersion": 1,
  "generatedAt": "2026-10-18T09:00:00Z",
  "days": 7,
  "machine": { "score": 47.8, "level": "low", "coverage": 87, "provisional": false },
  "profiles": [
    {
      "id": "default", "cli": "claude", "weighted": 565500000, "sessions": 151, "share": 1.0,
      "score": 47.8, "coverage": 87,
      "groups": { "A": { "earned": 19.33, "max": 38 }, "B": { "earned": 22.24, "max": 49 } },
      "criteria": [
        { "id": "A1", "status": "low", "value": 967000, "unit": "tokens", "earned": 0, "max": 10,
          "source": "context", "userSet": false, "items": [], "fixes": ["optimizer.balanced"] },
        { "id": "B7", "status": "unknown", "reason": "not_measured_yet", "earned": 0, "max": 6 }
      ],
      "projects": [{ "key": "p1", "path": "~/Codes/xDev/xdev-hive", "share": 0.62, "codegraph": false }]
    }
  ],
  "excluded": [{ "cli": "antigravity", "reason": "no_token_logs", "configScore": 60 }]
}
```

- `level`: `good` (≥ 80), `fair` (60–79), `low` (< 60). Chữ hiển thị nằm ở giao diện.
- `projects[].key` là khoá ngắn chỉ có nghĩa trong một lần tính, để giao diện gửi lại khi sửa nhanh cần thư mục dự án.
  Rust tra `key` ra đường dẫn từ kết quả lần tính đó, không nhận đường dẫn từ giao diện.
- `copyReport()`, lịch sử và dữ liệu gửi hub bỏ `id` gói, `projects`, `path` (FR-015).
- Mã lý do cố định: `not_enough_sessions`, `context_unavailable`, `config_unreadable`, `unsupported_cli`,
  `no_edit_sessions`, `windows_rtk_unsupported`, `cli_version_unknown`…

### 2. Công thức

- Giá trị một chiều, thấp là tốt: `f(x) = clamp((bad − x) ÷ (bad − good), 0, 1)`. Cao là tốt thì đổi chiều.
- Tiêu chí: `earned = max × trung bình các mục con`. Tiêu chí không có mục con là một mục.
- Mục con `unknown` bị bỏ khỏi trung bình. Mọi mục con `unknown` thì tiêu chí `unknown`.
- Điểm gói: `100 × Σ earned ÷ Σ max` trên các tiêu chí đo được. `coverage = Σ max` của tiêu chí đo được.
- Điểm máy: `Σ share_p × score_p` với `share_p = weighted_p ÷ Σ weighted`, chỉ gói Claude và Codex có token.
  - Không gói nào có token: trung bình điểm nhóm A của các gói Claude và Codex.
  - `coverage` của máy tính cùng trọng số. `provisional = coverage < 50`.
- Chỉ làm tròn ở bước hiển thị (1 chữ số).
- Token quy đổi dùng công thức của 015 (input + 0,1 × đọc cache + 1,25 × ghi 5 phút + 2 × ghi 1 giờ + 5 × output), để so
  được với số cũ. Trang giá có ghi đọc cache 0,05× cho model 5.5 [Unverified: đọc qua công cụ tóm tắt, research mục 3].
  Không đổi công thức ở spec này: B chỉ so tỉ lệ, và ngưỡng đã lấy theo công thức cũ.

### 3. Đo nhóm A

Thư mục cấu hình lấy từ `profiles.List()`. Gói mặc định là `~/.claude`, `~/.codex`. File `.claude.json` của gói mặc định
là `~/.claude.json`; của gói khác là `<configDir>/.claude.json` (như `claude_config_file` ở `setup_extra.rs:176–180`).

| # | Claude Code | Codex | Antigravity |
|---|---|---|---|
| A1 | `x` = cửa sổ − "Autocompact buffer" từ `/context` (fixture: 1m − 33k = 967k). Không có `/context`: `x` = `CLAUDE_CODE_AUTO_COMPACT_WINDOW`/`autoCompactWindow` × `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`/100; không đặt cửa sổ thì 967k nếu 7 ngày qua có phiên vượt 200k ngữ cảnh, ngược lại 200k. `DISABLE_AUTO_COMPACT=1` → 0. Điểm `f(x)`, good 200k, bad 600k | `model_auto_compact_token_limit`: `f(x)`, good 150k, bad 400k; không đặt → 0 | – |
| A2 | 3 biến: ≤ 15.000 → 1; không đặt → 0,5; từ 15.000 tới mặc định (30.000 / 25.000 / 25.000) → tuyến tính 1 → 0,5; > mặc định → 0. `BASH_MAX_OUTPUT_LENGTH` thua `bashOutputMaxChars` nếu có cả hai. Mục hook: `hooks.PostToolUse[]` có lệnh `hive-worker` với đối số `--local` → 1, không → 0 | `tool_output_token_limit`: ≤ 8.000 → 1; không đặt → 0,5; 8.000 → 24.000 tuyến tính 1 → 0 | – |
| A3 | (1) `f(trung vị token chỉ dẫn)`, good 2.000, bad 8.000; nguồn `instructionsPerSession` của gói (Project + User + AutoMem). Không có phiên: `memstore` (ký tự ÷ 4) cho CLAUDE.md cấp người dùng, CLAUDE.md và `@import` của dự án top 1, `MEMORY.md`. (2) `MEMORY.md` > 200 dòng hoặc > 25 KB → 0, không → 1. CLAUDE.md > 200 dòng: cảnh báo | (1) `memstore`: `AGENTS.md` cấp người dùng + dự án top 1, `f(token)` như Claude. (2) file > 32 KiB → 0 | (2) `~/.gemini/GEMINI.md`, `~/.gemini/AGENTS.md`, `~/.gemini/config/rules/*.md`, `.agents/rules/*.md` của dự án top 3: file > 24.000 byte → 0; tổng rule `always_on` > 20.000 token → 0 |
| A4 | `x` = tổng token nhóm `/context` có tên `Skills`, `MCP tools`, `Custom agents` (so khớp không phân biệt hoa thường; bỏ nhóm có "(deferred)"). Điểm `f(x)`, good 4.000, bad 20.000; nhân 0,5 khi `env.ENABLE_TOOL_SEARCH=false` hoặc có server `alwaysLoad: true` trong `.claude.json` (cấp người dùng và `projects[<dự án top 3>].mcpServers`) hoặc `.mcp.json` của dự án top 3 | Số `[mcp_servers.<id>]` không có `enabled = false` (đọc như `codex_mcp_names`): `f(n)`, good 2, bad 8 | – |
| A5 | (1) `codegraph` hoặc `serena` trong PATH → 1. (2) MCP tên `codegraph` trong `.claude.json` (cấp người dùng, hoặc `projects[<dự án top 1>]`) hoặc `.mcp.json` của dự án top 1 → 1. (3) số dự án top 3 có `.codegraph/` ÷ số dự án top 3 còn trên đĩa | (2) `[mcp_servers.codegraph]` | (1), (3) như Claude; (2) bỏ [Unverified] |
| A6 | (1) `rtk --version` chạy được → 1. (2) `hooks.PreToolUse[]` có `matcher` khớp `Bash` và lệnh chứa `rtk` trong `<configDir>/settings.json` → 1 | `unsupported` | – |
| A7 | (1) không có `DISABLE_PROMPT_CACHING` hay `DISABLE_PROMPT_CACHING_*` trong `env` → 1. (2) `runner.ClaudeSupports(v, "hook-args")` và `runner.ClaudeSupports(v, "updatedToolOutput")` (2.1.296, `claudeversion.go:20–50`) → 1; không đọc được phiên bản → `unknown` | `unsupported` | – |
| A8 | (1) `effortLevel` và `env.CLAUDE_CODE_EFFORT_LEVEL` không phải `xhigh`, `max` → 1. (2) `env.CLAUDE_CODE_SUBAGENT_MODEL` có và không phải Opus → 1 | (1) `model_reasoning_effort` không phải `xhigh`, `max`, `ultra`. (2) `model_verbosity` không phải `high` | – |

- "Dự án top N": N thư mục `cwd` có token quy đổi lớn nhất trong 7 ngày của gói, lấy từ `tokenreport`. Thư mục không còn
  trên đĩa thì bỏ. Không có phiên thì không có dự án top; mục con cần nó là `unknown`.
- Bản đầu chỉ đọc cấu hình cấp gói. Không đọc `settings.json` cấp dự án, cấu hình quản lý của tổ chức, hay biến môi trường
  của shell. JSON ghi `source` để người dùng biết.
- "Hive đặt": khoá có trong `Entry.Env` hoặc `Entry.Codex` của manifest. Khoá có trong file mà không có trong manifest là
  "người dùng đặt" (`userSet: true`).

### 4. Đo nhóm B

`tokenreport` đã có `weighted`, `calls`, `cacheHit`, `medianFirstContext`, `medianPeakContext`, `weightedOver400k` theo
nguồn phiên (`aggregate.go:149–169`). Việc cần làm:

| Việc | Cách làm | Dùng cho |
|---|---|---|
| Gốc quét theo `accounts.json` | Hiện `roots()` chỉ quét thư mục có tiền tố `claude`/`codex` trong `~/.xdev-hive/accounts` và thư mục mặc định (`report.go:82–104`). Đổi sang danh sách từ `profiles.List()`, để gói có thư mục tuỳ chọn có điểm riêng | Mọi tiêu chí B, trọng số máy |
| Số theo gói và nguồn | `session.Account` đã gán theo thư mục đang đọc (`report.go:183–189`). Thêm `byProfile[gói][nguồn]`, chỉ nguồn `interactive` và `headless` vào điểm (Q11) | Mọi tiêu chí B |
| Phiên chính | Cờ `Subagent` khi file nằm trong `<phiên>/subagents/` (`report.go:194`). Trung vị và ngưỡng 5 phiên chỉ dùng phiên chính | B1, B3, FR-006 |
| `instructionsPerSession` theo gói | Hiện tính chung mọi phiên Claude không phải test (`aggregate.go:292`, `359–383`). Tách theo gói | A3 |
| Output tool | Tổng token output và số lượt tool, theo gói | B6 |
| Trước lần sửa đầu | Mỗi phiên chính: token quy đổi của các lượt trước lượt có `tool_use` `Edit`, `Write`, `MultiEdit` hoặc `NotebookEdit` đầu tiên, không tính lượt sửa đó (như `freezeExplore`, `runner/usage.go:211–228`). Chỉ cộng phiên có sửa | B7 |
| `cwd` | Thêm `Cwd` vào phiên trong cache; chỉ dùng trong sidecar để tìm dự án top | A3–A5 |
| Họ model | Token theo họ của `message.model` (`opus`, `sonnet`, `haiku`, `fable`, khác) | Hiện trong chi tiết A8, không chấm |

- Cache báo cáo (`report-cache.json`, theo file, mtime, cỡ): thêm trường mới, tăng `cacheVersion` (`cache.go:10`) để không
  đọc nhầm bản cũ.
- Codex: B7 là `unknown`. **[Unverified]** Codex sửa file qua `apply_patch`; cách nhận ra trong rollout cần kiểm ở task.
- `optimize report` giữ nguyên các trường đang có; test so với fixture hiện có.

### 5. `/context` theo gói

- `score/context.go` chạy `claude -p /context --no-session-persistence` (cùng đối số app đang dùng,
  `usage.rs:251`) với `CLAUDE_CONFIG_DIR` của gói và token OAuth như `accounts.ReadUsage` (`accounts/usage.go:166–185`).
- Không dùng `--strict-mcp-config`: cần MCP của gói để đếm A4.
- Timeout 30 giây như `usage.rs:20`. Cache 10 phút trong `context-cache.json` theo gói.
- Đọc bảng theo cách `parse_context` của `usage.rs`. Bản Go dùng cùng fixture (`usage.rs:857`) để hai bên đọc giống nhau.
- **[Unverified]** Chạy `/context` có tốn hạn mức không, và có khởi động MCP server của gói hay không: đợt 0 kiểm. Tốn hạn
  mức thì chỉ chạy khi người dùng bấm "Tính lại", không chạy hằng ngày.

### 6. Sửa nhanh

Bảng cho phép có ở Rust (id, chạy ở đâu). Phần chạy trong sidecar có bảng riêng ở Go. Test so khớp danh sách id hai bên.

| fixId | Tiêu chí | Chạy ở | Làm gì | Hoàn tác | Xác nhận |
|---|---|---|---|---|---|
| `optimizer.balanced` | A1, A2 | Go | `optimizer.Enable(profile, balanced)`, thêm `--rtk` khi dòng trạng thái của gói có `rtk: true` (`optimize.go:394`) để không gỡ hook RTK đang có | `optimize disable` hoặc `restore` (015) | Xem trước. Không hiện khi gói đã ở `aggressive` |
| `optimizer.rtk` | A6 | Go | `optimizer.Enable(profile, mức hiện tại hoặc balanced, rtk)` | Như trên | Xem trước. Ẩn trên Windows (`optimize.go:280–283`) và khi không có `rtk` |
| `optimizer.aggressive` | A8 | Go | `optimizer.Enable(profile, aggressive, rtk như hiện tại)`. Mức này đặt `CLAUDE_CODE_SUBAGENT_MODEL` và `_FORCE` (`runner/preset.go:121–122`) | Như trên | **Hộp xác nhận** liệt kê mọi khoá của mức này |
| `tool.rtk`, `tool.codegraph` | A5, A6 | Rust | Mở màn Môi trường ở mục đó. `doctor.rs` thêm mục cài: `winget install rtk-ai.rtk`, `brew install rtk` [Unverified: README RTK, chưa chạy]; lệnh cài `codegraph` [Unverified], đợt 0 kiểm | Gỡ bằng tay | Theo màn Môi trường |
| `codegraph.mcp` | A5 | Rust | `mcp_add_argv` (`setup_extra.rs:205`) với server `codegraph` và lệnh `codegraph serve --mcp` (như `runner/tools.go:455`). Windows: `cmd /c codegraph.cmd serve --mcp`, như cấu hình đang chạy trên máy dev. Đặt `CLAUDE_CONFIG_DIR` hoặc `CODEX_HOME` của gói | `claude mcp remove -s user codegraph` hoặc `codex mcp remove codegraph` (có trong `codex mcp --help` của 0.142.5) | Xem trước; ghi rõ A4 sẽ tăng một chút |
| `codegraph.init` | A5 | Rust | `codegraph init <dự án>`; thêm `.codegraph/` vào `.git/info/exclude` khi `git check-ignore` báo chưa bỏ qua. Chạy nền, có tiến độ, dừng sau 10 phút | `codegraph uninit <dự án>` (có trong `codegraph --help` trên máy dev); gỡ dòng exclude | **Hỏi trước**: tạo chỉ mục là việc người dùng quyết |
| `open.memory` | A3 | UI | Mở màn Memory, lọc file vượt trần | – | – |
| `open.mcp` | A4 | UI | Mở danh sách MCP và skill của gói với token ước tính (chỉ đọc) | – | – |

- `hive-worker optimize fix <fixId> --profile P --preview` trả danh sách thay đổi (file, khoá, cũ, mới, cảnh báo) mà không
  ghi gì.
- Không có lệnh ghi từng khoá lẻ. Lý do: `Enable` gỡ khoá của mức cũ trước khi áp mức mới (`claude.go:49–57`), nên một
  khoá lẻ đặt ngoài preset sẽ bị gỡ ở lần bật sau.
- Sau khi áp dụng: chạy lại `score` với số nhóm B lấy từ cache, ghi lịch sử.

### 7. Lịch sử

- Mỗi dòng: `{ts, scoreVersion, machine, coverage, groups, profiles:[{cli, score, share}], criteria:{A1: earned…}, fix?}`.
  Không có id gói, đường dẫn hay tên dự án.
- Ghi khi: lần tính đầu tiên trong ngày, sau mỗi sửa nhanh. Dọn dòng quá 90 ngày khi ghi.
- Khoá file (cùng cách khoá thư mục phiên của 015) để hai lần tính không ghi chồng.

### 8. Giao diện và lịch chạy

- `TokenScoreCard` ở đầu `TokensScreen`, trên các ô số hiện có:
  - số điểm lớn, mức, `coverage`, nhãn "tạm tính";
  - thanh nhóm A/B;
  - điểm từng gói;
  - nút "Xem chi tiết", "Tính lại", "Chép báo cáo điểm".
- `TokenScoreDetail` (mở rộng trong thẻ, không mở cửa sổ mới):
  - bảng tiêu chí xếp theo điểm thiếu;
  - mỗi dòng có giá trị đo, mức, điểm, nguồn, gợi ý, nút sửa;
  - tiêu chí `unknown` hiện lý do.
- Biểu đồ 30 ngày: cột theo ngày như `CostChart` của `costs-page.tsx`, có bảng xem dạng chữ.
- Gợi ý cũ (`tips()`): `compact` dưới B1, `cache` dưới B4, `codexCompact` dưới A1 của gói Codex, `subagents` trong gợi
  ý hành vi (US5). Bỏ khối "Gợi ý tối ưu" riêng.
- Huy hiệu ở mục Token của `AppNav` (`shell/app-nav.tsx`): đọc `token_score_last()`, không tính gì lúc khởi động.
- Tính lại hằng ngày: khi app mở và bản ghi gần nhất cũ hơn 24 giờ, Rust chạy `score` ở nền sau 2 phút, không chặn giao
  diện. Tắt được trong cài đặt của màn Token.

### 9. Hub (P3, US6)

- Module `fleet`, bảng `machine_token_scores`: `org_id`, `team_id`, `machine_id`, khoá ngoại `(machine_id, org_id)` như
  các bảng `fleet` hiện có (`fleet/schema.ts:45–46`, `106–117`); `score`, `coverage`, `score_version`, `criteria` jsonb,
  `reported_at`. Giữ bản mới nhất và lịch sử 90 ngày (dọn bằng job).
- Bật và ép RLS; thêm vào `modules/fleet/rls.db.test.ts`. Migration sinh bằng `db:generate`, commit file SQL.
- Hợp đồng zod `strict`: chỉ số, enum, mã lý do. `pnpm openapi`, commit `openapi.json`.
- App gửi bằng PAT đang dùng (`hub.rs:168–197`). Hub kiểm người gửi là chủ máy theo ADR 0017. Máy dùng chung: chỉ chủ
  máy gửi được; đợt 5 kiểm lại ADR 0017 cho trường hợp này.
- Web: cột "Điểm token" ở danh sách máy, trang chi tiết tiêu chí. Quyền xem như danh sách máy hiện tại.

### 10. Kiểm thử

| Mức | Nội dung |
|---|---|
| Go unit | Bảng tiêu chí: mỗi tiêu chí và mục con 4 ca (đủ, 0, giữa, `unknown`); công thức điểm gói và máy; đọc cấu hình hỏng; `optimizer.rtk` bị bỏ trên Windows; đọc `/context` bằng fixture của `usage.rs` |
| Go với `HOME`/`USERPROFILE` giả | Fixture `accounts.json` có 2 gói Claude (một gói thư mục tuỳ chọn), 1 gói Codex, 1 Antigravity; `score --json` khớp file mong đợi; `/context` giả bằng binary `claude` giả trong PATH; mọi sửa nhanh qua Go: `--preview`, áp dụng, hoàn tác đúng từng byte (SC-003) |
| Tương thích | `optimize report --json` với fixture cũ ra đúng các trường cũ (FR-007) |
| Nền tảng | `GOOS=windows go vet ./...`, như CI của 015 |
| Riêng tư | Fixture có chuỗi đánh dấu; tìm chuỗi trong báo cáo chép, lịch sử, dữ liệu gửi hub, và (prompt, output) trong JSON điểm (SC-005) |
| Rust | Bảng id sửa nhanh khớp Go; id lạ bị từ chối; `projectKey` lạ bị từ chối; lệnh `codegraph.*` dựng từ bảng |
| Vitest | `TokenScoreCard`, `TokenScoreDetail`: xếp tiêu chí, nhãn tạm tính, hộp xác nhận A8, `copyReport()` không có id gói và đường dẫn |
| P3 | `*.db.test.ts`: gửi bằng PAT của chủ máy, đọc bằng quản trị đội, người ngoài đội không đọc được, RLS; Playwright: cột điểm ở danh sách máy |
| Đo thật | Máy dev Windows: chấm trước và 7 ngày sau `optimizer.balanced` (SC-006), ghi vào research |

## Quyết định của người viết

- **Chấm trong Go, không trong TypeScript**: một nguồn sự thật cho tiêu chí, test được với `HOME` giả, P3 dùng lại được.
  `tips()` ở TypeScript chỉ giữ vai trò gợi ý.
- **Sidecar tự chạy `/context` theo gói**: đã có tiền lệ `accounts.ReadUsage` chạy `/usage` theo gói. Như vậy mọi gói đều
  đo được A1, A4, không chỉ gói của tiến trình app. Rust giữ `parse_context` cho màn Token như cũ.
- **A1 lấy từ `/context`** ("Autocompact buffer"), vì đó là số CLI thật sự dùng. Cách tính từ cấu hình chỉ là đường lùi.
- **A4 dùng `/context` thay vì đếm server**: Claude Code hoãn nạp tool MCP theo mặc định (research mục 3, dòng 6), nên số
  server không cho biết token.
- **A8 dùng mức `aggressive`**, không thêm khoá lẻ: giữ mô hình manifest của 015 và ADR 0026 (đổi model subagent nằm
  trong `aggressive`).
- **Chỉ đọc cấu hình cấp gói** ở bản đầu. Cấu hình cấp dự án và biến môi trường shell làm số đúng hơn, nhưng nhiều nguồn
  ghi đè nhau. JSON ghi `source` để người dùng biết.
- **RTK ít điểm (3)**: đo ở hai máy cho thấy tác dụng nhỏ với việc đọc code (015 mục 4, research mục 2).
- **B7 trọng số 6** dù không có nguồn ngoài đề xuất: Hive đã dùng số này cho run (ADR 0022), và nó chỉ ra việc dò repo.
- **Không đổi công thức token quy đổi** của 015.

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Tên khoá hay giá trị mặc định của CLI đổi theo phiên bản | Đợt 0 kiểm lại mặc định; mục con `unknown` khi không đọc được phiên bản; `scoreVersion` |
| Người dùng chạy theo điểm, bật mọi thứ, chất lượng giảm | Sửa nhanh đổi chất lượng cần xác nhận; màn hình ghi rõ điểm không đo chất lượng; nhóm B nặng hơn nhóm A |
| Ngưỡng [Inference] không hợp máy khác | `scoreVersion`; xem lại sau T016 và sau 2 tuần dùng |
| `/context` theo gói tốn hạn mức, chậm, hoặc khởi động MCP server của gói | Đợt 0 kiểm; cache 10 phút; timeout 30 giây; không đo được thì A4 `unknown`, A1 dùng đường lùi |
| `codegraph init` lâu trên repo lớn, ghi vào repo | Hỏi trước, chạy nền, exclude git, `uninit` để gỡ |
| Đọc transcript lớn làm chậm lần mở đầu | Dùng cache của 015; hiện nhóm A trước |
| ADR 0026 nói bộ tối ưu không phụ thuộc RTK, CodeGraph, mà A5, A6 cho 8 điểm cho chúng | Ghi trong đoạn "Score" bổ sung ADR 0026: tính năng không phụ thuộc, nhưng điểm thưởng cho máy có công cụ |

## Phương án đã cân nhắc

| Phương án | Bỏ vì |
|---|---|
| Chấm trong TypeScript từ các lệnh Tauri sẵn có | Logic nằm ở giao diện, khó test với `HOME` giả, không dùng lại được cho hub |
| Rust chạy `/context` rồi đưa file cho Go | Chỉ đo được gói của tiến trình app |
| Lệnh ghi khoá lẻ (`set-key`) cho A8 | Bị gỡ ở lần `Enable` sau; cần đổi mô hình manifest và ADR 0026 |
| Chỉ nhóm cấu hình | Bấm nút là được điểm cao mà token không giảm (Q2) |
| Thang theo mốc riêng từng máy | Máy mới không có điểm; khó so giữa các máy (Q3) |
| Điểm theo hoá đơn USD | Gói thuê bao không có hoá đơn theo token; số USD của Claude chỉ là ước tính |
| Đọc OpenTelemetry thay transcript | Cần collector; Hive chưa nhận OTel; transcript đã có sẵn trên máy |

## Complexity Tracking

| Lệch | Lý do | Phương án đơn giản hơn bị loại vì |
|---|---|---|
| Spec viết tiếng Việt (constitution VI nói spec tiếng Anh) | Chủ dự án yêu cầu, như spec 011–021 | — |
| Đọc bảng `/context` ở cả Go và Rust | Go cần cho điểm mọi gói; Rust đang dùng cho màn Token | Chuyển màn Token sang Go: đổi màn đang chạy, ngoài phạm vi |

## SRS và ADR

- Không cần ADR mới cho P1–P2: theo ADR 0026 (logic trong sidecar Go). Thêm đoạn "Score" vào ADR 0026 khi làm (đang ở
  trạng thái Proposed).
- P3 cần ADR "Machines report token score" vì máy gửi dữ liệu lên hub ngoài giao thức worker. Chọn số khi gộp.
- SRS: thêm mục cho điểm token ở phần app desktop. Số mục chọn khi gộp.
- `docs/token-optimizer.md`: thêm mục "Điểm tối ưu token" và bảng tiêu chí rút gọn.

## Phân đợt và ước lượng

| Đợt | Nội dung | Ước lượng |
|---|---|---|
| 0 | Kiểm mặc định CLI; tên nhóm `/context` trên máy có MCP; `/context` có tốn hạn mức, có khởi động MCP không; lệnh cài `codegraph` | 0,5–1 ngày |
| 1 (P1) | Mục 2–5: `profiles.List()`, `score` Go, số mới của `tokenreport`, `/context` theo gói, test bảng: US1 | 4–5 ngày |
| 2 (P1) | Mục 8: Rust `token_score`, thẻ và chi tiết: US1, US2 | 2–3 ngày |
| 3 (P1) | Mục 6: `fix`, mục cài trong `doctor.rs`, `codegraph.*`: US3 | 2,5–3,5 ngày |
| 4 (P2) | Mục 7, lịch chạy hằng ngày, huy hiệu, gợi ý hành vi: US4, US5 | 2 ngày |
| 5 (P3) | Mục 9: hub, web, ADR: US6 | 3–4 ngày |

Tổng khoảng 14–18,5 ngày-agent **[Inference]**. Đợt 1 và đợt 2 làm song song được sau khi chốt JSON ở mục 1. Bước tiếp
theo: chủ dự án trả lời Q1–Q11, rồi viết `tasks.md`.
