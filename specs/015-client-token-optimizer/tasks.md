---
description: "Task list: quản lý memory và bộ tối ưu token trong app client"
---

# Tasks: Quản lý memory và bộ tối ưu token trong app client

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md)

## Quy ước

- **Định dạng**: `[ID] [P?] [Story] [Tier]`.
  - **[P]**: chạy song song được. Bộ file không giao nhau và không chờ task chưa xong.
  - **Tier**: chọn model theo CLAUDE.md.
    - **nặng** = Opus `--effort high`;
    - **vừa** = Sonnet `--effort high`;
    - **nhẹ** = Sonnet `--effort medium`.
- **PHẠM VI**: file duy nhất task được sửa. Hai task cùng đợt không có file chung. File chung (`main.go`, `lib.rs`,
  `screens/index.ts`, `lib/nav.ts`) chỉ được thêm một dòng đăng ký, và task sửa chúng phải chạy sau task kia.
- Mỗi task kèm test trong cùng commit.
- Go:
  - `gofmt -l .`, `go vet ./...`, `GOOS=windows go vet ./...`, `go test ./...` trong `worker/`.
  - Test giả `HOME` thì đặt cả `HOME` và `USERPROFILE`.
  - Không kiểm bit thực thi trên Windows.
- Desktop:
  - `pnpm --filter @xdev-hive/desktop test`.
  - Rust: `cargo test` trong `apps/desktop/src-tauri`.
- Task desktop (T007–T009, T011, T013) chờ DESKCLIENT merge vào `main`.

## Đợt 1: nền Go (song song)

- [ ] **T001 [P] [US1] [nặng] Tách preset dùng chung cho run và phiên tương tác**
  - **Goal**:
    - Xuất `InteractivePreset(cli, version, level string) Preset` với `Preset{Env map[string]string; Codex
      map[string]string; Hooks []string; Skipped []SkipReason}`, theo bảng preset trong plan.md.
    - Xuất `ClaudeSupports(version, feature)` và `DetectClaudeVersion` (bọc hàm sẵn có).
    - `savingEnv`, `savingArgs` dùng chung bảng giá trị với preset. Hành vi của run không đổi: test cũ phải xanh.
  - **PHẠM VI**:
    - `worker/internal/runner/tokensaving.go`
    - `worker/internal/runner/tokensaving_test.go`
    - `worker/internal/runner/claudeversion.go`
    - `worker/internal/runner/claudeversion_test.go`
    - `worker/internal/runner/preset.go` (mới)
    - `worker/internal/runner/preset_test.go` (mới)
  - **Test**:
    - Preset từng mức, từng phiên bản: 2.1.250 bỏ `SUBAGENT_MODEL_FORCE` và hook exec; 2.1.296 có đủ.
    - Không có `DISABLE_AUTO_MEMORY` trong preset tương tác.

- [ ] **T002 [P] [US1] [nặng] Hook cục bộ `hive-worker hook pre-tool|post-tool --local`**
  - **Goal**:
    - `HookMain` nhận `--local`: khi không có `HIVE_RUN_GUARD_DIR`, lấy `session_id` từ stdin và dùng
      `~/.xdev-hive/optimizer/sessions/<id>/`.
    - Cấu hình đọc từ `~/.xdev-hive/optimizer/state.json`, mục của gói theo `CLAUDE_CONFIG_DIR`. Không có thì dùng mặc
      định `balanced`.
    - Pre-tool ở chế độ local chỉ nhắc (`additionalContext`), không `deny`.
    - Post-tool cắt bằng `truncateKeep` như run. Output đầy đủ ghi vào `<cwd>/.claude/.hive-out/` (thêm vào git exclude),
      hoặc thư mục phiên nếu không ghi được.
    - Ghi `ledger.jsonl` (chỉ số).
    - Dọn thư mục phiên quá 7 ngày, có khoá file.
    - Lỗi bất kỳ: thoát 0, không in gì (fail-open).
  - **PHẠM VI**:
    - `worker/internal/runner/guard.go` (chỉ nhánh `--local` trong `HookMain`)
    - `worker/internal/runner/guard_local.go` (mới)
    - `worker/internal/runner/guard_local_test.go` (mới)
  - **Test**:
    - stdin mẫu Bash 30k ký tự → output ≤ 12k, có file đầy đủ, có dòng ledger.
    - Hai `session_id` khác nhau có state riêng.
    - JSON stdin hỏng → exit 0.
    - Benchmark < 50 ms.
    - Chạy trên Windows: không dùng shell.

- [ ] **T003 [P] [US1] [nặng] Gói `optimizer`: cài và gỡ cấu hình an toàn**
  - **Goal**: package `worker/internal/optimizer`:
    - `Enable(profile, level)`, `Disable(profile)`, `Status()`, `Restore(profile, backup)`.
    - Claude `settings.json`: JSON giữ thứ tự khoá, thêm `env` và `hooks`.
    - Codex `config.toml`: khối đánh dấu `xdev-hive optimizer`, bỏ khoá đã có ở chỗ khác.
    - Manifest gồm khoá đã thêm và giá trị cũ. Sao lưu `backups/<gói>/<ts>`.
    - Ghi nguyên tử: file tạm + rename, kiểm mtime, thử lại 3 lần.
    - `Link()` tạo `~/.xdev-hive/bin/hive-worker`: liên kết trên Unix, bản sao trên Windows.
    - Nhận preset dưới dạng tham số, không import `runner`. T004 nối hai bên, nên chạy song song với T001 được.
  - **PHẠM VI**: `worker/internal/optimizer/**` (mới)
  - **Test**:
    - Bật rồi tắt trả file về đúng từng byte.
    - Người dùng đổi một khoá giữa chừng → khoá đó được giữ, có cảnh báo.
    - JSON hỏng → lỗi, không ghi.
    - TOML có sẵn `tool_output_token_limit` → không thêm trùng.
    - Hook của người dùng còn nguyên.
    - Gói mặc định `~/.claude` chỉ bật khi chỉ định rõ.

- [ ] **T005 [P] [US3] [vừa] Gói `memstore`: quét và gắn cờ**
  - **Goal**:
    - `Scan(roots, projects) Inventory` cho Claude, Codex, Gemini theo plan.md.
    - Token ước tính: ký tự / 4, tiếng Việt có dấu ký tự / 3.
    - Cờ: trùng (tên, Jaccard shingle 5 từ ≥ 0,6), cũ (mtime > 30 ngày, tham chiếu không còn trong repo, giới hạn số lần
      `git grep`), link chết, mồ côi, vượt trần.
    - Tổng token nạp mỗi phiên theo dự án: `MEMORY.md` + CLAUDE.md các cấp.
  - **PHẠM VI**:
    - `worker/internal/memstore/scan.go`, `flags.go`, `tokens.go` (mới)
    - Test của các file trên.
  - **Test**:
    - Fixture 3 gói, cùng dự án, có file trùng, link chết, file mồ côi → số cờ đúng.
    - 100 file < 1 giây.

- [ ] **T006 [P] [US2] [vừa] Gói `tokenreport`: báo cáo token bản Go**
  - **Goal**:
    - Port `scripts/token-audit.ts`: cùng chia nguồn, cùng công thức quy đổi, cùng các trường JSON.
    - Thêm lọc theo gói, mốc trước/sau (tham số), đọc `ledger.jsonl`, đọc `rtk gain --format json` nếu có.
    - Cache theo (file, mtime, cỡ).
    - Không in nội dung transcript.
  - **PHẠM VI**: `worker/internal/tokenreport/**` (mới), kèm fixture transcript tự tạo trong `testdata/`, không lấy từ máy thật.
  - **Test**:
    - Fixture Claude và Codex → số khớp bảng mong đợi. Fixture gồm phiên có compact, phiên subagent, dòng ghi dở.
    - Mốc trước/sau tách đúng.

## Đợt 2: lệnh con và thao tác memory

- [x] **T004 [US1] [US2] [vừa] Lệnh `hive-worker optimize`** (sau T001, T003, T006)
  - **Goal**:
    - `optimize status|enable --profile ID --level balanced|aggressive [--rtk]|disable --profile ID|restore --profile ID
      [--backup TS]|link|report [--profile ID] [--days N]`, có `--json`. Thông báo lỗi tiếng Việt.
    - Nối preset `runner.InteractivePreset` (theo phiên bản CLI phát hiện được) với `optimizer.Enable`.
    - `report` dùng `tokenreport` với mốc lấy từ manifest.
  - **PHẠM VI**:
    - `worker/cmd/hive-worker/optimize.go` (mới)
    - `worker/cmd/hive-worker/optimize_test.go` (mới)
    - `worker/cmd/hive-worker/main.go`: một `case "optimize"` và chuỗi cách dùng.
  - **Test**: chạy end-to-end trên `HOME` giả: bật → `status --json` → tắt.

- [x] **T010 [US3] [US4] [vừa] Thao tác memory và lệnh `hive-worker memory`** (sau T005; chạy song song với T004 nhưng
  sửa `main.go` sau T004)
  - **Goal**:
    - Lệnh `memory scan|edit|delete|restore|merge|share|unshare --json`.
    - Mọi thao tác có sao lưu. Xoá đưa vào `trash/`.
    - Gộp sửa chỉ mục `MEMORY.md` và link tới file nguồn.
    - **Bước đầu bắt buộc**: thử với `claude` thật trên máy dev xem `projects/<khoá>/memory` là liên kết thì CLI có đọc và
      ghi qua nó không, và có thay liên kết bằng thư mục thật không. Ghi kết quả vào `specs/015-client-token-optimizer/research.md`
      mục 9.
      - Được: `share` dùng liên kết (Windows: junction).
      - Không được: `share` đồng bộ hai chiều theo mtime khi chạy lệnh.
  - **PHẠM VI**:
    - `worker/internal/memstore/ops.go`, `shared.go` (mới) và test.
    - `worker/cmd/hive-worker/memory.go` (mới), `memory_test.go` (mới)
    - `worker/cmd/hive-worker/main.go` (một `case`)
    - `specs/015-client-token-optimizer/research.md` (chỉ thêm mục 9)
  - **Test**:
    - Gộp 2 file → 1 file, chỉ mục và link đúng.
    - Xoá rồi khôi phục.
    - `share` rồi `unshare` trả mỗi gói một bản sao.
    - Windows: junction (skip nếu không tạo được).

## Đợt 3: desktop (sau DESKCLIENT merge)

- [x] **T007 [P] [US1] [US2] [US3] [vừa] Lệnh Tauri gọi sidecar** (sau T004, T010)
  - **Goal**:
    - `optimizer_status`, `optimizer_enable`, `optimizer_disable`, `optimizer_restore`, `optimizer_report`,
      `memory_scan`, `memory_apply`: chạy sidecar với `--json`, như `profiles.rs`.
    - Gọi `optimize link` lúc app khởi động.
    - Không cần đăng nhập.
  - **PHẠM VI**:
    - `apps/desktop/src-tauri/src/optimizer.rs` (mới)
    - `apps/desktop/src-tauri/src/memory_store.rs` (mới)
    - `apps/desktop/src-tauri/src/lib.rs`: `mod`, đăng ký lệnh, gọi `link` trong `setup`.
    - `apps/desktop/src-tauri/capabilities/default.json` nếu cần.
  - **Test**: Rust unit test parse JSON của sidecar, dùng chuỗi mẫu.

- [ ] **T008 [US1] [US2] [vừa] Khối "Tối ưu" trong màn Token** (sau T007)
  - **Goal**:
    - Bảng gói: CLI, phiên bản, mức, trạng thái, nút Bật/Tắt/Khôi phục, lý do bỏ khoá.
    - Bảng trước/sau theo nguồn phiên: token quy đổi mỗi lượt, ngữ cảnh đỉnh, phiên > 400k, cache hit, ký tự đã cắt,
      `rtk gain`.
    - Nút "Chép báo cáo" (chỉ số).
    - Từ điển vi/en kiểu `Dict` như màn hiện có.
  - **PHẠM VI**:
    - `apps/desktop/src/components/optimizer-panel.tsx` (mới) và `.test.tsx`
    - `apps/desktop/src/lib/optimizer.ts` (mới) và test
    - `apps/desktop/src/screens/tokens-screen.tsx`: chỉ chèn `<OptimizerPanel />`.

- [ ] **T009 [US3] [US4] [vừa] Màn Memory** (sau T007; song song với T008)
  - **Goal**:
    - Cây CLI → dự án → gói → file, có token, ngày sửa, cờ.
    - Đầu màn có tổng token nạp mỗi phiên.
    - Xem và sửa (textarea, sao lưu), xoá (thùng rác), khôi phục, gộp có xem trước, bật/tắt "Dùng chung memory".
    - Chữ tiếng Việt, có từ điển vi/en.
  - **PHẠM VI**:
    - `apps/desktop/src/screens/memory-screen.tsx` (mới) và `.test.tsx`
    - `apps/desktop/src/lib/memory-store.ts` (mới)
    - `apps/desktop/src/screens/index.ts`, `apps/desktop/src/lib/nav.ts`: mỗi file một dòng `memory`.

## Đợt 4: mở rộng (P3)

- [ ] **T011 [US5] [vừa] AI nén memory có duyệt** (sau T010, T009)
  - **Goal**:
    - `hive-worker memory compress --profile ID --project KEY [--files …] --json`: chạy `claude -p --restricted
      --strict-mcp-config --tools Read,Glob,Grep` (như docs agent) và trả đề xuất `{files:[{path,content}], tokensUsed}`.
    - Tô dòng mới không có nguồn trong file cũ.
    - UI: nút "Gợi ý nén", diff, "Áp dụng" gọi `memory apply`.
  - **PHẠM VI**:
    - `worker/internal/memstore/compress.go` (mới) và test, giả CLI bằng script (chỉ Unix, `t.Skip` trên Windows).
    - `worker/cmd/hive-worker/memory.go`: thêm nhánh `compress`.
    - `apps/desktop/src/components/memory-compress-dialog.tsx` (mới) và test.
    - `apps/desktop/src/screens/memory-screen.tsx`: một nút mở dialog.

- [x] **T012 [P] [US6] [vừa] Đồng bộ memory với hub khi đã đăng nhập**
  - **Còn lại**: chèn `<MemoryHubSync projectKey items />` vào `memory-screen.tsx` chờ T009 merge. Hub cần thêm cờ `source: "machine"`.
  - **Goal**:
    - Kiểm `memoryContract.write` và `proposalsContract.create` trong `packages/contracts/src/knowledge.ts` xem có tạo
      được memory chờ duyệt từ máy không.
      - Được: chỉ làm phía desktop.
      - Không được: thêm cờ `source: "machine"` vào contract (có `.default()`), chạy `pnpm openapi`, và thêm test hub.
    - Desktop:
      - mục "Hub" trong màn Memory: xem brief và memory dự án (chỉ đọc);
      - "Gửi lên hub" tạo đề xuất;
      - ẩn khi chưa đăng nhập.
  - **PHẠM VI**:
    - `apps/desktop/src/components/memory-hub-sync.tsx` (mới) và test
    - `apps/desktop/src/screens/memory-screen.tsx`: một dòng chèn component
    - Nếu cần: `packages/contracts/src/knowledge.ts`, `packages/contracts/openapi.json`,
      `apps/hub/src/modules/knowledge/<file memory>.ts` và test.

- [x] **T013 [P] [US7] [nặng] Context pack cục bộ qua `UserPromptSubmit`** (sau T002)
  - **Còn lại**: ô chọn trong `optimizer-panel.tsx` chờ T008 merge (preset đã có `PresetOptions.ContextPack`).
  - **Goal**:
    - `hive-worker hook prompt --local`: chỉ ở prompt đầu tiên của phiên, gọi `buildContextPack` với thư mục `cwd` và
      prompt. Timeout 5 giây, ngân sách 14.000 ký tự. Trả `additionalContext`.
    - Dùng `codegraph` nếu máy có, có index trong `DataDir/codegraph/<sha>` như worker.
    - Thêm vào preset dưới dạng tuỳ chọn `contextPack` (mặc định tắt) và một ô chọn trong `optimizer-panel.tsx`.
  - **PHẠM VI**:
    - `worker/internal/runner/contextpack_local.go` (mới) và test.
    - `worker/internal/runner/guard_local.go`: nhánh `prompt`. Sửa sau khi T002 merge.
    - `worker/internal/runner/preset.go`: khoá `contextPack`. Sửa sau khi T001 merge.
    - `apps/desktop/src/components/optimizer-panel.tsx`: một ô chọn. Sửa sau khi T008 merge.
  - **Test**:
    - Repo git tạm, prompt nhắc tên file → pack có file đó.
    - Prompt thứ hai không dựng lại.
    - Quá 5 giây → không có `additionalContext`.

## Đợt 5: tài liệu, dọn

- [x] **T014 [P] [nhẹ] ADR và hướng dẫn**
  - **Goal**:
    - ADR "Bộ tối ưu token và quản lý memory trên client": chọn phương án (a), lý do bỏ (b) và (c), số đo từ research.md.
    - Hướng dẫn người dùng tiếng Việt: bật/tắt, mức, gỡ sạch, đọc bảng trước/sau.
    - Số ADR lấy kế tiếp trên `main` lúc commit.
  - **PHẠM VI**: `docs/adr/00NN-client-token-optimizer.md` (mới), `docs/token-optimizer.md` (mới)

- [x] **T015 [nhẹ] Gom script đo** (sau T006)
  - **Goal**: `scripts/token-audit.ts` gọi `hive-worker optimize report --json` khi có sidecar. Hoặc xoá script và
    cập nhật đường dẫn trong research.md.
  - **PHẠM VI**: `scripts/token-audit.ts`, `specs/015-client-token-optimizer/research.md` (một dòng đường dẫn)

- [ ] **T016 [nhẹ] Đo lại sau 7 ngày bật**
  - **Goal**:
    - Bật `balanced` cho các gói Claude của máy dev. Sau 7 ngày chạy `hive-worker optimize report --json`.
    - Ghi bảng trước/sau vào research.md mục 10, đối chiếu SC-001 và SC-002.
    - Đổi preset nếu số không đạt.
  - **PHẠM VI**: `specs/015-client-token-optimizer/research.md`

## Phụ thuộc và cách chia agent

```
Đợt 1:  T001 ─┐   T002 ──────────────┐      T005 ── T010 ─┐
        T003 ─┼── T004 ─┐            T013   (T010 sửa main.go sau T004)
        T006 ─┘         ├── T007 ── T008 ─┐
                        │           T009 ─┴── T011, T012
Đợt 5:  T014 bất cứ lúc nào; T015 sau T006; T016 sau T008 + 7 ngày
```

| Đợt | Agent song song | Tier |
|---|---|---|
| 1 | T001, T002, T003 (nặng); T005, T006 (vừa) | 5 agent, mỗi agent một worktree |
| 2 | T004, T010 (vừa); T013 (nặng) nếu T002 đã merge | 3 agent |
| 3 | T007, rồi T008 và T009 song song (vừa) | 1, sau đó 2 agent |
| 4–5 | T011, T012 (vừa); T014, T015 (nhẹ) | 4 agent |

Việc của hub, ngoài spec này (research.md mục 7, dòng 7): giảm cỡ output của `memory_search`, trung bình 3.180 token
mỗi lần gọi.
