---
description: "Task list: điểm tối ưu token trên máy dev"
---

# Tasks: Điểm tối ưu token trên máy dev

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

## Quy ước

- **Định dạng**: `[ID] [P?] [Story] [Tier] · ước lượng`.
  - **[P]**: chạy song song được với task khác cùng đợt. Bộ file không giao nhau và không chờ task chưa xong.
  - **Tier**: chọn model theo CLAUDE.md.
    - **nặng** = Opus `--effort high`;
    - **vừa** = Sonnet `--effort high`;
    - **nhẹ** = Sonnet `--effort medium`.
  - **Ước lượng**: ngày-agent (một agent làm liên tục, gồm test). **[Inference]** theo spec 015.
- **PHẠM VI**: chỉ được sửa các file liệt kê. Cần sửa file ngoài phạm vi thì ghi vào ghi chú bàn giao.
- **File chung có chủ**:
  - `worker/cmd/hive-worker/optimize.go`: T002 (tách danh sách gói), rồi T003 (`case "score"`), rồi T004 (`case "fix"`).
  - `apps/desktop/src-tauri/src/lib.rs`, `build.rs`, `capabilities/app.json`: chỉ T005.
  - `apps/desktop/src/screens/tokens-screen.tsx`: chỉ T006.
- Mỗi task kèm test trong cùng commit. TDD: viết test trước, thấy test hỏng, rồi mới viết code.
- **Kiểm tra theo loại task**:
  - Go: trong `worker/` chạy `gofmt -l .`, `go vet ./...`, `go test ./...`; thêm `GOOS=windows go vet ./...`.
  - Rust: `cargo test --locked` trong `apps/desktop/src-tauri`. **Máy dev Windows không có Rust: CI kiểm.**
  - Desktop: `corepack pnpm --filter @xdev-hive/desktop typecheck`, `test`; `corepack pnpm biome check --write .`
    rồi xem diff (autocrlf làm biome báo sai trên Windows).
- **Giả định**: Q1–Q11 đã chốt theo khuyến nghị ngày 2026-10-19 (spec.md "Câu hỏi đã chốt").
- **Dữ liệu thật**: test chỉ dùng fixture. Không đưa transcript, đường dẫn hay tên dự án thật vào repo.

## Hợp đồng JSON (chốt cho P1)

Go là nguồn sự thật. Kiểu TypeScript ở `apps/desktop/src/lib/token-score.ts` phải khớp. Số điểm làm tròn 2 chữ số
trong JSON; giao diện làm tròn 1 chữ số khi hiện.

```ts
type Status = "ok" | "partial" | "low" | "unknown" | "unsupported";
type FixId = "optimizer.balanced" | "optimizer.rtk" | "optimizer.aggressive" | "tool.rtk" | "tool.codegraph"
  | "codegraph.mcp" | "codegraph.init" | "open.memory" | "open.mcp" | "context.measure";

interface TokenScore {
  scoreVersion: 1;
  generatedAt: string;                    // RFC 3339
  days: number;                           // 7
  machine: { score: number | null; level: "good" | "fair" | "low" | null; coverage: number; provisional: boolean };
  previous?: { score: number | null; at: string };   // bản ghi lịch sử gần nhất trước lần tính này
  profiles: ProfileScore[];
}

interface ProfileScore {
  id: string; label?: string; cli: "claude" | "codex" | "antigravity" | "gemini"; default?: boolean;
  counted: boolean;                       // false: không tính vào điểm máy
  reason?: string;                        // khi counted = false: "no_token_logs" | "unsupported_cli"
  level?: "balanced" | "aggressive";      // mức bộ tối ưu đang bật
  weighted: number; sessions: number; share: number;
  score: number | null; coverage: number;
  groups: { A: { earned: number; max: number }; B: { earned: number; max: number } };
  criteria: Criterion[];
  projects: { key: string; path: string; share: number; codegraph: boolean }[];   // path dạng "~/…"
  context?: { name: string; tokens: number }[];                                   // nhóm của /context
}

interface Criterion {
  id: "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "B1" | "B2" | "B3" | "B4" | "B5" | "B6" | "B7";
  group: "A" | "B"; status: Status;
  value?: number; unit?: "tokens" | "ratio" | "count";
  good?: number; bad?: number;
  earned: number; max: number;
  source?: "settings" | "context" | "sessions" | "files" | "tools";
  reason?: string; userSet?: boolean;
  items?: { id: string; status: Status; value?: number; score?: number; reason?: string; file?: string }[];
  warnings?: { code: string; file?: string }[];
  fixes?: FixId[];
}

interface FixPreview {                    // optimize fix <id> --profile P --preview --json
  fixId: FixId; profile: string;
  changes: { file: string; key: string; before: string | null; after: string | null }[];
  warnings: string[];                     // mã: "quality_may_change", "context_grows", "long_running"
}
interface FixResult { fixId: FixId; profile: string; backup?: string }   // optimize fix … --json
```

- `status`: `ok` khi `earned ≥ max − 0,01`; `partial` khi `earned ≥ max / 2`; còn lại `low`. `unknown` và `unsupported`
  có `earned = 0` và không tính vào `coverage`.
- Mục con (`items[].id`): A2 `bash`, `read`, `mcp`, `hook` (Codex: `toolOutput`); A3 `tokens`, `truncated`; A5 `tool`,
  `mcp`, `index`; A6 `rtk`, `hook`; A7 `cache`, `version`; A8 `effort`, `subagent` (Codex: `effort`, `verbosity`).
- `warnings[].code`: `claude_md_long` (A3), `tool_search_off`, `always_load` (A4), `user_set` (A2), `auto_compact_off` (A1).
- Mã lý do: `not_enough_sessions`, `context_unavailable`, `config_unreadable`, `unsupported_cli`, `no_edit_sessions`,
  `windows_rtk_unsupported`, `cli_version_unknown`, `no_projects`, `no_token_logs`, `codex_not_measured`,
  `context_not_measured`, `default` (mục con để mặc định của CLI).
- `context.measure` chỉ có ở giao diện: chấm lại với `--fresh` để chạy `/context` (gọi model, research mục 7).

## Ghi chú khi làm P1 (2026-10-19)

- Danh sách gói lấy thẳng từ `optimizeStatus` (đã gộp `accounts.json` với manifest), không tách `ListProfiles`.
- A3 đọc file chỉ dẫn trực tiếp trong `score`, không sửa `memstore`.
- `/context` gọi model (research mục 7), nên chỉ chạy khi người dùng bấm đo; kết quả giữ 7 ngày.
- Hoàn tác `optimizer.*` qua `optimize fix … --undo`, không qua `restore` (plan mục 6).
- Tỉ trọng token theo họ model (FR-007) để sang T009.
- Máy dev Windows không có Rust: `token_score.rs` chỉ CI biên dịch và chạy test.

## Đợt 0: kiểm giả định

- [x] **T001 [P] [—] [nhẹ] · 0,5 ngày — Kiểm giả định của plan đợt 0**
  - **Goal**:
    - tên nhóm `/context` trên máy có MCP và plugin (Claude Code 2.1.300);
    - `claude -p /context` có tốn hạn mức không (so `/usage` trước và sau);
    - lệnh cài `rtk` (`winget show rtk-ai.rtk`), cách cài `codegraph` trên Windows và macOS;
    - mặc định `BASH_MAX_OUTPUT_LENGTH`, `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS`, `MAX_MCP_OUTPUT_TOKENS` theo trang
      env-vars hiện tại.
  - **PHẠM VI**: `specs/025-token-score/research.md` (mục 7 "Kết quả kiểm").
  - **Kiểm**: mỗi dòng có kết quả "có / không / chưa rõ" kèm phiên bản và ngày thử.

## Đợt 1: Go (P1)

- [x] **T002 [US1] [nặng] · 1,5 ngày — Danh sách gói và số mới của `tokenreport`**
  - **Goal**:
    - `optimizer.ListProfiles(o, accountsFile, claudeVersion)`: phần gộp `accounts.json` với manifest, tách khỏi
      `optimizeStatus`; `optimizeStatus` gọi lại hàm này, output `optimize status` không đổi.
    - `tokenreport.Options.Roots`: danh sách gốc quét (gói, CLI, thư mục cấu hình). Rỗng thì quét như cũ.
    - `tokenreport.Sessions(ctx, opts)`: trả từng phiên đã đọc, dạng xuất (`SessionSummary`): CLI, nguồn, gói, giờ bắt
      đầu, `Subagent`, `Cwd`, lượt, input, output, đọc/ghi cache, token quy đổi, ngữ cảnh lượt đầu và đỉnh, ký tự và số
      lượt output tool, ký tự chỉ dẫn, `Edited`, token quy đổi trước lần sửa đầu.
    - Token trước lần sửa đầu: không tính lượt có `Edit`/`Write`/`MultiEdit`/`NotebookEdit` đầu tiên (như
      `runner/usage.go` `freezeExplore`).
    - Tăng `cacheVersion`.
  - **PHẠM VI**: `worker/internal/optimizer/profiles.go` (+ test), `worker/cmd/hive-worker/optimize.go`,
    `worker/internal/tokenreport/{report.go,session.go,transcript.go,cache.go,sessions.go,sessions_test.go}`,
    `worker/internal/tokenreport/testdata/**` (chỉ thêm).
  - **Kiểm**: test cũ của `tokenreport` và `optimize` vẫn qua (FR-007); test mới cho gói thư mục tuỳ chọn, cờ subagent,
    token trước lần sửa đầu (có ca tool_use nằm ở dòng sau của cùng message).
- [x] **T003 [US1] [US2] [nặng] · 2 ngày — Gói `score` và `optimize score`** (sau T002)
  - **Goal**: plan mục 1–5.
    - `criteria.go`: bảng tiêu chí, `f(x)`, trạng thái, điểm gói, điểm máy, `scoreVersion`.
    - `config_claude.go`, `config_codex.go`, `config_agy.go`, `tools.go`: đo nhóm A theo plan mục 3. Lệnh ngoài (`rtk
      --version`, `codegraph`) qua biến hàm để test thay.
    - `context.go`: chạy `claude -p /context --no-session-persistence` với `CLAUDE_CONFIG_DIR` của gói, timeout 30
      giây, cache 10 phút trong `~/.xdev-hive/optimizer/context-cache.json`; đọc bảng như `parse_context` của `usage.rs`.
    - `history.go`: ghi `score-history.jsonl` (một dòng mỗi ngày, cộng sau mỗi sửa nhanh), dọn quá 90 ngày, trả
      `previous`.
    - `optimize score --json [--profile P] [--days 7] [--fresh]`.
  - **PHẠM VI**: `worker/internal/score/**`, `worker/cmd/hive-worker/optimize.go` (`case "score"`),
    `worker/cmd/hive-worker/optimize_test.go`.
  - **Kiểm**: test bảng (SC-002): mỗi tiêu chí và mục con có ca đủ, 0, giữa, `unknown`; `HOME`/`USERPROFILE` giả với 2 gói
    Claude (một gói thư mục tuỳ chọn), 1 Codex, 1 Antigravity; riêng tư (SC-005) cho lịch sử.
- [x] **T004 [US3] [vừa] · 1 ngày — `optimize fix`** (sau T003)
  - **Goal**: plan mục 6, phần chạy trong Go: `optimizer.balanced`, `optimizer.rtk`, `optimizer.aggressive`.
    - `--preview`: `FixPreview` mà không ghi gì.
    - Áp dụng: gọi `Enable` như `optimize enable` (giữ `--rtk` khi gói đang có hook RTK của Hive), trả `FixResult` có
      `backup`. Hoàn tác là `optimize restore --backup <backup>` sẵn có.
    - Ghi một dòng lịch sử có `fix`.
  - **PHẠM VI**: `worker/internal/score/fixes.go` (+ test), `worker/cmd/hive-worker/optimize.go` (`case "fix"`),
    `worker/cmd/hive-worker/optimize_test.go`.
  - **Kiểm**: áp dụng rồi `restore` trả file về đúng từng byte (SC-003); `optimizer.rtk` bị từ chối trên Windows.

## Đợt 2: app desktop (P1, song song với Đợt 1 sau khi chốt hợp đồng JSON)

- [x] **T005 [P] [US1] [US3] [vừa] · 1 ngày — Lệnh Tauri**
  - **Goal**:
    - `token_score(fresh)`: chạy sidecar `optimize score --json`, giữ kết quả gần nhất trong state để tra `projectKey`.
    - `token_score_fix_preview(fixId, profileId, projectKey?)`, `token_score_fix(…)`, `token_score_undo(fixId,
      profileId, projectKey?, backup?)`.
    - Bảng cho phép: `optimizer.*` → sidecar `optimize fix` / `optimize restore`; `codegraph.mcp` → `mcp_add_argv` với
      `CLAUDE_CONFIG_DIR`/`CODEX_HOME` của gói, hoàn tác bằng `mcp remove`; `codegraph.init` → `codegraph init <dự án>`
      và `.git/info/exclude`, hoàn tác bằng `codegraph uninit`. Id lạ, `projectKey` lạ bị từ chối.
  - **PHẠM VI**: `apps/desktop/src-tauri/src/token_score.rs` (mới), `lib.rs`, `build.rs`, `capabilities/app.json`.
  - **Kiểm**: `cargo test` (CI): bảng cho phép, id lạ, `projectKey` lạ, argv dựng đúng.
- [x] **T006 [P] [US1] [US2] [US3] [vừa] · 2 ngày — Thẻ điểm, chi tiết, sửa nhanh**
  - **Goal**: plan mục 8 (trừ biểu đồ, huy hiệu, lịch hằng ngày: P2).
    - `lib/token-score.ts`: kiểu theo hợp đồng JSON, lệnh `invoke`, `copyReport()` (chỉ số, id tiêu chí, mã lý do, CLI).
    - `TokenScoreCard`: điểm, mức, phạm vi đo, "tạm tính", nhóm A/B, điểm từng gói, chênh lệch với `previous`, nút
      "Tính lại", "Chép báo cáo điểm".
    - `TokenScoreDetail`: tiêu chí xếp theo điểm thiếu; giá trị, mức, điểm, nguồn, mục con, cảnh báo, gợi ý, nút sửa.
    - Sửa nhanh: hộp xem trước (file, khoá, cũ/mới), hộp xác nhận riêng cho `optimizer.aggressive`, "Hoàn tác".
      `tool.*` mở màn Môi trường; `open.memory` mở màn Memory; `open.mcp` hiện nhóm `/context` của gói.
    - Gợi ý cũ `tips()` hiện dưới tiêu chí liên quan; bỏ khối "Gợi ý tối ưu" riêng.
  - **PHẠM VI**: `apps/desktop/src/lib/token-score.ts` (+ test), `apps/desktop/src/components/token-score-*.tsx`
    (+ test), `apps/desktop/src/screens/tokens-screen.tsx` (+ test).
  - **Kiểm**: Vitest: xếp tiêu chí, nhãn tạm tính, hộp xác nhận A8, `copyReport()` không có id gói và đường dẫn; typecheck;
    biome.

## Đợt 3: P2

- [ ] **T007 [US4] [vừa] · 1,5 ngày — Biểu đồ 30 ngày, huy hiệu, tính lại hằng ngày** (sau T003, T006)
  - **PHẠM VI**: `apps/desktop/src/components/token-score-history.tsx`, `shell/app-nav.tsx`, `token_score.rs`
    (`token_score_last`, lịch chạy nền).
- [ ] **T008 [US5] [nhẹ] · 0,5 ngày — Gợi ý theo hành vi dùng** (sau T006)
- [ ] **T009 [—] [nhẹ] · 0,5 ngày — Tỉ trọng token theo họ model** (FR-007, hiện trong chi tiết A8)

## Đợt 4: P3 (Q5)

- [ ] **T010 [US6] [nặng] · 2 ngày — Hợp đồng, bảng `machine_token_scores`, route** (plan mục 9)
- [ ] **T011 [US6] [vừa] · 1,5 ngày — Web: cột điểm ở danh sách máy, trang chi tiết**

## Đợt 5: tài liệu và đo thật

- [ ] **T012 [—] [nhẹ] · 0,5 ngày — `docs/token-optimizer.md`, đoạn "Score" của ADR 0026** (sau T006)
- [ ] **T013 [—] [nhẹ] · 7 ngày chờ — Đo SC-006 trên máy dev Windows** (sau khi P1 có trong bản phát hành)

## Theo user story

| Story | Task |
|---|---|
| US1 | T002, T003, T005, T006 |
| US2 | T003, T006 |
| US3 | T004, T005, T006 |
| US4 | T007 |
| US5 | T008 |
| US6 | T010, T011 |
