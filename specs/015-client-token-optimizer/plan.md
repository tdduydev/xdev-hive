# Implementation Plan: Quản lý memory và bộ tối ưu token trong app client

**Branch**: `015-client-token-optimizer` | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md) | **Đánh giá**:
[research.md](research.md)

## Summary

Bộ tối ưu và quản lý memory nằm trong sidecar `hive-worker` (Go), dưới dạng lệnh con mới:
- `hive-worker optimize …`: bật, tắt, xem trạng thái, báo cáo token;
- `hive-worker memory …`: quét, sửa, gộp, dùng chung, nén;
- `hive-worker hook … --local`: hook mà CLI gọi trong phiên của người dùng.

App desktop thêm lệnh Tauri mỏng gọi sidecar (giống `profiles.rs` gọi `accounts`), một màn Memory và một khối "Tối ưu" trong
màn Token. Preset biến token, bảng phiên bản CLI, hook cắt output và context pack đều dùng lại code trong
`worker/internal/runner`.

## Chọn cách nhúng

| Tiêu chí | (a) Mở rộng sidecar Go `hive-worker` | (b) Viết mới bằng Rust trong Tauri | (c) Dùng RTK, CodeGraph bên ngoài |
|---|---|---|---|
| Dùng lại code đã có | Cao: `savingEnv`, `claudeMinVersion`, `HookMain`/`postTool`/`truncateKeep`, `buildContextPack`, `prepareRTK`, `codegraphServer`, `accounts` | Thấp: viết lại hook, preset, pack; có hai nguồn sự thật | Chỉ phần nén output lệnh |
| Đã đi kèm app | Có: `externalBin: binaries/hive-worker`, build bằng `build-sidecar.ts` | Có (cùng binary app) | Không: người dùng phải cài, và có telemetry phải tắt |
| Hook cần một binary chạy nhanh, không cần app mở | Có: binary Go tĩnh, khởi động khoảng 10 ms **[Inference]** | Phải tách binary riêng: binary Tauri là app GUI, không hợp làm hook | Có (RTK) |
| Offline, không đăng nhập | Có | Có | Có |
| Windows, macOS, Linux | Có (worker đã chạy CI Windows) | Có | RTK, CodeGraph tuỳ nền tảng |
| Tác động đo được (research.md mục 4, 7) | Env + cắt output: lớn nhất | Như (a) nếu viết lại đủ | RTK: nhỏ trên kiểu việc này |

**Chọn (a)**. RTK và CodeGraph vẫn dùng khi máy có sẵn: phát hiện bằng `prepareRTK`/`MachineCapabilities` và cài hook RTK
theo lựa chọn. Bộ tối ưu không phụ thuộc vào chúng. Phần Rust chỉ gọi sidecar và hiển thị.

## Kiến trúc

```
apps/desktop (React)          màn Token: khối Tối ưu + bảng trước/sau;  màn Memory
        │ invoke
apps/desktop/src-tauri        optimizer.rs, memory.rs  → chạy sidecar với --json, như profiles.rs
        │ spawn
hive-worker optimize …        worker/internal/optimizer  (settings Claude, khối Codex, manifest, sao lưu, liên kết bin)
hive-worker memory …          worker/internal/memstore   (quét, cờ, thao tác, dùng chung, nén)
hive-worker optimize report   worker/internal/tokenreport (bản Go của scripts/token-audit.ts + trước/sau)
        │ ghi
~/.xdev-hive/accounts/<gói>/settings.json   env + hooks  ──►  claude (mọi cách mở gói)
~/.xdev-hive/accounts/<gói>/config.toml     khối đánh dấu ──►  codex
        │ CLI gọi mỗi lượt tool
~/.xdev-hive/bin/hive-worker hook post-tool --local   worker/internal/runner/guard*.go
        └─ ~/.xdev-hive/optimizer/sessions/<session_id>/{state.json,out/,ledger.jsonl}
```

Thư mục dữ liệu `~/.xdev-hive/optimizer/`:
- `state.json`: manifest.
- `backups/<gói>/<ts>.json|toml`: bản sao lưu.
- `sessions/`: trạng thái hook theo phiên.
- `trash/`: memory đã xoá.

Memory dùng chung: `~/.xdev-hive/memory/claude/<khoá dự án>/`.

## Preset

Nguồn sự thật nằm ở `worker/internal/runner/tokensaving.go`. T001 tách ra hàm xuất `InteractivePreset(cli, version,
level)`. Run vẫn dùng `savingEnv`, và hai bên đọc chung một bảng.

| Khoá | `balanced` (mặc định) | `aggressive` | Lý do không lấy y nguyên preset run |
|---|---|---|---|
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | 200000 | 200000 | Đòn bẩy chính: 84% chi phí tương tác ở phiên > 400k |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | 80 | 70 | Phiên tương tác cần giữ ngữ cảnh lâu hơn run |
| `BASH_MAX_OUTPUT_LENGTH` | 15000 | 15000 | Giống run |
| `CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS` | 15000 | 10000 | Read là 41% phần bị đọc lại |
| `MAX_MCP_OUTPUT_TOKENS` | 15000 | 10000 | |
| `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` (≥ 2.1.280) | – | 512 | Có thể làm model hiểu sai tool MCP lạ |
| `CLAUDE_CODE_SUBAGENT_MODEL` | – | `sonnet` | Đổi chất lượng subagent, người dùng phải tự chọn |
| Cache TTL, `DISABLE_AUTO_MEMORY`, `DISABLE_BUNDLED_SKILLS`, `DISABLE_WORKFLOWS` | không đặt | không đặt | Tính năng người dùng cần khi làm tay. Phiên tương tác hay nghỉ quá 5 phút |
| Hook `PostToolUse` cắt > 12.000 ký tự (`Bash\|Grep\|mcp__.*`) | có (≥ 2.1.296) | có | |
| Hook `PreToolUse` ngân sách khám phá, `cat` file lớn | nhắc (`additionalContext`) | nhắc | Chặn như run sẽ làm người dùng khó chịu |
| Hook RTK | tuỳ chọn, khi có `rtk` | tuỳ chọn | Đo thấy tác động nhỏ (research.md mục 4) |
| Codex `tool_output_token_limit` | 8000 | 6000 | `exec` trung bình 3.697 token |
| Codex `model_auto_compact_token_limit` | 150000 | 120000 | |

Không có preset cho Gemini và Antigravity: chưa có biến tương đương đã được kiểm, worker cũng chưa có.

## Hook cục bộ

- Dạng lệnh:
  - Unix: `{"type":"command","command":"<HOME>/.xdev-hive/bin/hive-worker","args":["hook","post-tool","--local"],"timeout":15}`.
    Đây là dạng exec, dùng được từ `hook-args` ≥ 2.1.296.
  - CLI cũ hơn: dạng shell `[ -x X ] && exec X hook post-tool --local || exit 0`.
  - Windows: chỉ dạng exec.
- Không có `HIVE_RUN_GUARD_DIR` mà có `--local` thì hook đọc `session_id` từ stdin và dùng
  `~/.xdev-hive/optimizer/sessions/<id>/`. Cấu hình lấy từ manifest (preset của gói, xác định qua `CLAUDE_CONFIG_DIR`)
  và được cache trong thư mục phiên.
- Output đầy đủ bị cắt được ghi vào `out/<n>.txt` của thư mục phiên. Lời nhắc trong output trỏ tới file đó, agent đọc
  bằng `Read`.
  **[Inference]** Phiên tương tác không có `--add-dir`, nên `Read` ngoài thư mục dự án có thể hỏi quyền. Cách xử lý:
  T002 ghi `out/` vào `<dự án>/.claude/.hive-out/` (thêm vào git exclude) nếu thư mục dự án ghi được. Không được thì
  để ở thư mục phiên, chấp nhận việc hỏi quyền.
- Ledger chỉ có số: `{ts, tool, before, after}`. Báo cáo đọc ledger để ra "ký tự đã cắt".
- Dọn dẹp: lần chạy hook đầu tiên mỗi ngày xoá thư mục phiên quá 7 ngày. Có khoá file để hai phiên không cùng dọn.

## Ghi file cấu hình an toàn

- Đọc file → kiểm JSON hoặc TOML hợp lệ → sao lưu → sửa trong bộ nhớ, giữ thứ tự khoá (JSON đọc bằng
  `json.Decoder.Token` thành cây có thứ tự, không dùng `map`) → ghi file tạm cùng thư mục → `rename`.
- Nếu mtime hoặc cỡ file đổi giữa lúc đọc và rename thì làm lại, tối đa 3 lần.
- Manifest ghi từng khoá Hive đã thêm và giá trị cũ (hoặc "không có").
- Khi tắt, mỗi khoá:
  - còn đúng giá trị Hive đặt: trả lại giá trị cũ;
  - người dùng đã đổi: giữ nguyên và báo lại.
- Hook nhận diện bằng `args` chứa `--local` và tên `hive-worker`. Không dựa vào vị trí trong mảng.
- Codex: chỉ thêm hoặc xoá khối `# >>> xdev-hive optimizer >>>`. Khối này khác khối `# >>> xdev-hive >>>` (MCP) đã có.
  Nếu một khoá trong khối đã có ở chỗ khác của file thì không thêm khoá đó (TOML không cho khoá trùng).
- `~/.xdev-hive/bin/hive-worker` là liên kết (Windows: bản sao) tới sidecar hiện tại. App cập nhật nó lúc khởi động,
  qua `hive-worker optimize link`.

## Báo cáo token

- `worker/internal/tokenreport` là bản Go của `scripts/token-audit.ts`: cùng cách chia nguồn, cùng công thức token quy
  đổi.
- Thêm:
  - lọc theo gói;
  - mốc trước/sau lấy từ manifest;
  - số ký tự đã cắt từ ledger;
  - số của `rtk gain --format json` nếu có RTK.
- Đọc dòng theo luồng, bỏ qua thư mục `memory/` và `tool-results/`. Cache kết quả theo (file, mtime, cỡ) trong
  `~/.xdev-hive/optimizer/report-cache.json` để mở màn lần sau nhanh.
- Sau khi T006 xong, `scripts/token-audit.ts` gọi `hive-worker optimize report --json` hoặc bị xoá (T015).

## Memory

- Quét theo CLI:
  - Claude: `<config>/projects/*/memory/*.md`, `MEMORY.md`, `<config>/CLAUDE.md`; CLAUDE.md và AGENTS.md của dự án local
    (danh sách dự án lấy từ `hive-worker projects`).
  - Codex: `<CODEX_HOME>/AGENTS.md`, AGENTS.md của dự án. `memories_1.sqlite` chỉ báo cỡ, không sửa.
  - Gemini: `~/.gemini/GEMINI.md`, GEMINI.md của dự án.
- Khoá dự án: tên thư mục `projects/<khoá>` của Claude (đường dẫn đổi `/` thành `-`), đối chiếu với đường dẫn dự án local.
- Cờ:
  - **trùng**: cùng tên file ở gói khác, hoặc độ giống Jaccard trên shingle 5 từ ≥ 0,6;
  - **cũ**: mtime quá 30 ngày, hoặc nhắc đường dẫn hay ký hiệu không còn trong repo (kiểm bằng `git ls-files` và
    `git grep -q` có giới hạn số lần);
  - **link chết**, **mồ côi**, **vượt trần** (`MEMORY.md` > 1.500 token, CLAUDE.md > 2.000 token).
- Dùng chung (US4): làm sau khi T010 kiểm được CLI có theo liên kết `memory/` hay không.
- Nén (US5): chạy `claude -p --restricted --strict-mcp-config --tools Read,Glob,Grep` như docs agent (`cli.rs`) với gói
  người dùng chọn. Đầu ra là JSON `{files:[{path, content}]}` để dựng diff. Ghi chỉ qua `memory apply`.

## Đồng bộ hub (US6)

Dùng API knowledge sẵn có (`api.memory.search`, đề xuất memory theo luồng review). T012 kiểm contracts. Nếu chưa có
endpoint tạo đề xuất từ máy thì thêm vào `packages/contracts/src/knowledge*.ts` và module `knowledge`. Phần này ở hub,
không ở sidecar.

## Cấu trúc file

| Phần | File |
|---|---|
| Preset dùng chung | `worker/internal/runner/tokensaving.go`, `claudeversion.go` (xuất `ClaudeSupports`) |
| Hook cục bộ | `worker/internal/runner/guard_local.go` (mới), sửa nhỏ `guard.go` (`HookMain` nhận `--local`) |
| Context pack cục bộ | `worker/internal/runner/contextpack_local.go` (mới, gọi `buildContextPack`), hook `prompt` |
| Cài/gỡ cấu hình | `worker/internal/optimizer/` (mới): `claude.go`, `codex.go`, `manifest.go`, `atomic.go`, `link.go` |
| Báo cáo | `worker/internal/tokenreport/` (mới) |
| Memory | `worker/internal/memstore/` (mới): `scan.go`, `flags.go`, `ops.go`, `shared.go`, `compress.go` |
| Lệnh con | `worker/cmd/hive-worker/optimize.go`, `memory.go` (mới), mỗi lệnh một dòng `case` trong `main.go` |
| Tauri | `apps/desktop/src-tauri/src/optimizer.rs`, `memory_store.rs` (mới), đăng ký trong `lib.rs` |
| UI | `apps/desktop/src/components/optimizer-panel.tsx`, `apps/desktop/src/screens/memory-screen.tsx` (mới), `lib/optimizer.ts`, `lib/memory-store.ts` (mới); một dòng trong `tokens-screen.tsx`, `screens/index.ts`, nav |
| Hub (US6) | `packages/contracts/src/…`, `apps/hub/src/modules/knowledge/…` (sau khi T012 kiểm) |
| Tài liệu | `docs/adr/00NN-client-token-optimizer.md` (lấy số kế tiếp lúc commit), `docs/token-optimizer.md` |

## Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Ghi hỏng `settings.json` khi CLI đang ghi | Ghi nguyên tử, kiểm mtime, sao lưu, `optimize restore` |
| Nén sớm làm mất ngữ cảnh người dùng cần | Mức `balanced` nén ở 80% của 200k. Bật theo gói, và báo cáo cho thấy số lần nén |
| Hook làm chậm mỗi lượt tool | Binary Go, không mạng, timeout 15 giây, đo SC-004 trong test |
| Liên kết `memory/` bị CLI thay bằng thư mục thật | T010 kiểm trước. Không được thì đồng bộ hai chiều khi app mở |
| Tên biến Claude đổi giữa các phiên bản | Bảng `claudeMinVersion` dùng chung. Báo cáo cho thấy cấu hình có hiệu lực không (ngữ cảnh đỉnh) |
| Trùng file với DESKCLIENT | Task desktop chạy sau khi DESKCLIENT merge. Sửa file chung chỉ một dòng đăng ký |
