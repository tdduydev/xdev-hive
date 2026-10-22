---
description: "Task list: ngữ cảnh dùng chung, đồng bộ dự án và nút Tối ưu"
---

# Tasks: Ngữ cảnh dùng chung, đồng bộ dự án và nút "Tối ưu"

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

- **Định dạng**: `[ID] [P?] [Story] [Tier] · ước lượng`.
  - **[P]**: chạy song song được với task khác cùng đợt. Bộ file không giao nhau và không chờ task chưa xong.
  - **Tier**: chọn model theo CLAUDE.md.
    - **nặng** = Opus `--effort high`;
    - **vừa** = Sonnet `--effort high`;
    - **nhẹ** = Sonnet `--effort medium`.
  - **Ước lượng**: ngày-agent (một agent làm liên tục, gồm test). **[Inference]** theo spec 015 và 025.
- **PHẠM VI**: chỉ được sửa các file liệt kê. Cần sửa file ngoài phạm vi thì ghi vào ghi chú bàn giao.
- **File chung có chủ** (làm nối tiếp theo thứ tự ghi):
  - `worker/cmd/hive-worker/main.go` (bảng lệnh): T004 (`context`), rồi T006 (`optimize all` qua `optimize.go`), rồi T019 (`outbox`).
  - `worker/cmd/hive-worker/optimize.go`: chỉ T006.
  - `apps/desktop/src-tauri/src/lib.rs`, `capabilities/app.json`: T007, rồi T009, rồi T024.
  - `apps/desktop/src/screens/memory-screen.tsx`: T008, rồi T017, rồi T024.
  - `apps/desktop/src/components/token-score-card.tsx`, `screens/tokens-screen.tsx`: T010, rồi T018.
  - `packages/contracts/**` và `openapi.json`: T012 (P2), rồi T020 (P3).
  - `apps/hub/db/migrations/`: T013 (0084), rồi T022 (0085). Lấy số kế tiếp mới nhất ngay trước commit (common.md).
- Mỗi task kèm test trong cùng commit. Viết test trước, thấy test hỏng, rồi mới viết code.
- **Kiểm tra theo loại task**:
  - Go: trong `worker/` chạy `gofmt -l .`, `go vet ./...`, `GOOS=windows go vet ./...`, `go test ./internal/<gói>/...`.
  - Rust: `cargo test --locked` trong `apps/desktop/src-tauri`. **Máy dev Windows không có Rust: CI kiểm.**
  - Desktop, web: typecheck và Vitest của package đã sửa; Playwright chỉ spec liên quan.
  - Hub: `*.db.test.ts` của module đã sửa, `rls.db.test.ts` khi thêm bảng; `pnpm deps`; `pnpm openapi` khi sửa contracts.
  - Biome: chỉ chạy trên file đã sửa (`core.autocrlf=true` trên Windows làm `biome --write .` đổi cả repo).
- **Dữ liệu thật**: test chỉ dùng fixture và repo git tạm. Không đưa đường dẫn, tên dự án hay memory thật vào repo.
- **Giả định**: D1–D6 đã chốt ngày 2026-10-22 (spec.md "Quyết định").

## Đợt 0: Chuẩn bị (P1)

- [ ] **T001 [P] [—] [nhẹ] · 0,5 ngày — Kiểm tay file ngữ cảnh cục bộ của từng CLI**
  - **Goal**: chạy [quickstart.md](quickstart.md) mục 1 trên máy dev Windows (và Mac nếu có): Claude Code
    `CLAUDE.local.md` (kể cả repo chỉ có `AGENTS.md` + dòng `@AGENTS.md`), Codex `AGENTS.override.md` (có giữ chú thích
    HTML không), Gemini `GEMINI.local.md` qua `context.fileName`, Antigravity `.agents/rules/xdev-hive.md` có
    `trigger: always_on`.
  - **PHẠM VI**: `specs/029-shared-context-sync/research.md` (thêm mục 9 "Kết quả kiểm").
  - **Kiểm**: mỗi CLI có kết quả "đọc được / không / chưa rõ" kèm phiên bản và ngày thử. CLI "không" thì ghi để T003 đặt
    trạng thái `skipped` với lý do "chưa hỗ trợ".

- [x] **T002 [P] [—] [vừa] · 0,5 ngày — Tách `gitexclude`, xuất API sao lưu của `memstore`**
  - **Goal**:
    - chuyển `gitExclude`, `removeGitExclude` (`memstore/shared.go:573`, `:600`) sang gói mới `worker/internal/gitexclude`
      (`Add(repo, rel) (added bool, warn string)`, `Remove(repo, line) string`, `Tracked(repo, rel) bool` dùng
      `git ls-files --error-unmatch`);
    - xuất `Store.begin/save/commit` (`memstore/ops.go:90/114/143`) thành `Begin/Save/Commit`, giữ hành vi;
    - `shared.go` dùng gói mới. Không đổi `runner.go`, `token_score.rs`.
  - **PHẠM VI**: `worker/internal/gitexclude/**`, `worker/internal/memstore/{ops.go,shared.go}` và test của chúng.
  - **Kiểm**: test cũ của `memstore` xanh; test mới cho `Add` idempotent, `Remove`, `Tracked`, worktree git (exclude của
    worktree nằm ở `git rev-parse --git-common-dir`/`info/exclude`).

## Đợt 1: Go (P1)

- [x] **T003 [US1] [nặng] · 2 ngày — Gói `ctxsync`: nguồn, khối, file đích, gương Codex** (sau T002)
  - **Goal**: theo [plan.md](plan.md) mục 1, [data-model.md](data-model.md) "Trên máy", [research.md](research.md) mục 1–2:
    - khoá nguồn `p_<projectId>` / `f_<ProjectKey>`; `source.md`, `state.json` (version 1);
    - `RenderBlock`, `ParseBlocks`: dòng mở `<!-- xdev-hive:context v1 sha=<12 hex> -->`, dòng đóng
      `<!-- /xdev-hive:context -->`, hai mục `## Tại máy`, `## Từ hub`; lỗi khi nhiều khối hoặc dấu hỏng;
    - bốn file đích: `CLAUDE.local.md` (thêm `@AGENTS.md` khi không có `CLAUDE.md` mà có `AGENTS.md`),
      `AGENTS.override.md` (gương `AGENTS.md` + khối, lưu băm `AGENTS.md`, bỏ qua khi override do người dùng tự viết),
      `GEMINI.local.md` + `context.fileName` trong `.gemini/settings.json` (bỏ qua khi settings bị git theo dõi),
      `.agents/rules/xdev-hive.md` (frontmatter `trigger: always_on`);
    - chỉ ghi cho CLI có cài (`accounts` discover) và đạt T001;
    - mỗi lần ghi: `gitexclude.Tracked` → bỏ qua; `gitexclude.Add`; so `sha` → `conflict`; `Store.Begin("context.sync")`,
      `Save`, ghi nguyên tử, `Commit`;
    - `Enable`, `Sync(key, hub *HubSnapshot, policy *Policy)`, `Resolve(key, target, keep)`, `Disable(key)` (gỡ khối, file
      app tạo vào thùng rác, gỡ dòng exclude đã thêm), `Status()`;
    - trạng thái `ok | stale | conflict | skipped`, lý do tiếng Việt.
  - **PHẠM VI**: `worker/internal/ctxsync/{source,block,targets,codex_mirror,sync,state}.go`, test, `testdata/`.
  - **Kiểm**: SC-002 (so byte ngoài khối sau bật/sửa/tắt), CRLF, BOM, khối cuối file không xuống dòng, xung đột, gương
    Codex khi `AGENTS.md` đổi, file bị theo dõi, Gemini settings bị theo dõi, frontmatter Antigravity, tắt rồi khôi phục
    từ thùng rác.

- [x] **T004 [US1] [vừa] · 1 ngày — Lệnh `hive-worker context`, chuyển từ chia sẻ cũ** (sau T003)
  - **Goal**: các lệnh ở [contracts/sidecar-cli.md](contracts/sidecar-cli.md) "`hive-worker context`" (`status`, `enable`,
    `disable`, `save-source`, `sync`, `resolve`, `migrate`), JSON đúng kiểu `ContextProject`; `migrate.go` đọc
    `memory-shared.json`, ghép bản nháp nguồn, `--apply` thì lưu nguồn và gọi `memstore.Unshare` (FR-007). Lỗi
    `{"error":{"code","message"}}` tiếng Việt.
  - **PHẠM VI**: `worker/cmd/hive-worker/{context.go,main.go}`, `worker/internal/ctxsync/migrate.go`, test, fixture JSON
    `worker/internal/ctxsync/testdata/context-project.json` (cho T007 so kiểu TS).
  - **Kiểm**: test lệnh với `HOME`/`USERPROFILE` giả và repo git tạm; fixture JSON ổn định.

- [x] **T005 [P] [US2] [nặng] · 2 ngày — Gói `optimizeall`: kế hoạch, chạy, nhật ký, hoàn tác, khoá** (sau T002; song song T003, T004)
  - **Goal**: theo [plan.md](plan.md) mục 4, [data-model.md](data-model.md) "Lần tối ưu", [research.md](research.md) mục 7–8:
    - `Plan(policies map[string]Policy) (OptimizePlan, error)`: bước `optimizer.enable` mỗi gói chưa đạt mức đích
      (`aggressive` → `selected:false`, `requiresConfirm:true`), `fix.<id>` chỉ id trong `FIXES` của Rust (`codegraph.mcp`,
      `codegraph.init` cho dự án đã gắn, `optimizer.rtk` khi hỗ trợ), `context.sync` mỗi dự án đã bật, `score.recompute`
      (luôn có); `reason` "Theo chính sách dự án <tên>" / "Mặc định";
    - gộp chính sách nhiều dự án: `off < balanced < aggressive` lấy cao nhất; `rtk`, `codegraph` là hoặc; trần nén lấy nhỏ nhất;
    - `Apply(plan)`: chạy bước đã chọn theo thứ tự, ghi `optimizer/runs/<ULID>.json` sau **mỗi** bước, lỗi một bước không
      dừng bước sau, trả điểm trước/sau;
    - `Undo(runId)`: chỉ lần gần nhất chưa hoàn tác; đảo bước `ok` theo thứ tự ngược (`optimizer.Restore`, bản ghi
      `score-fixes`, `memstore.Restore(entry)`); `tool.*` không hoàn tác; giữ 30 lần;
    - khoá `optimizer/optimize.lock` (mẫu `score.LockHistory`), lỗi `OPTIMIZE_LOCKED`;
    - FR-014: danh sách id bước là **đóng** (hằng số + test); bước ngữ cảnh chỉ gọi qua interface `ContextSyncer`
      (bản thật do T006 nối vào `ctxsync`, test dùng bản giả).
  - **PHẠM VI**: `worker/internal/optimizeall/{plan,run,undo,policy,lock}.go`, test, `testdata/`.
  - **Kiểm**: SC-004 (hoàn tác so byte `settings.json`, `config.toml`, khối), bước lỗi giữa chừng, gộp chính sách, khoá
    song song, test danh sách bước đóng.

- [ ] **T006 [US2] [vừa] · 1 ngày — Lệnh `hive-worker optimize all`** (sau T004, T005)
  - **Goal**: `optimize all --preview|--apply --plan-file|--undo --run|--last` theo
    [contracts/sidecar-cli.md](contracts/sidecar-cli.md); nối `optimizeall.ContextSyncer` vào `ctxsync.Sync`; `context
    sync` cũng lấy `optimize.lock` (bỏ lượt với `locked:true` khi bận). Fixture JSON `OptimizePlan`, `OptimizeRun`.
  - **PHẠM VI**: `worker/cmd/hive-worker/{optimize_all.go,optimize.go,context.go}`, test, fixture trong
    `worker/internal/optimizeall/testdata/`.
  - **Kiểm**: test lệnh đầu cuối trên `HOME` giả có hai gói Claude và một gói Codex (quickstart mục 3 bước 1–4 dạng test).

## Đợt 2: Desktop (P1)

- [x] **T007 [US1] [vừa] · 1 ngày — Rust `context_sync.rs` và `lib/context-sync.ts`** (sau T004)
  - **Goal**: lệnh Tauri `context_status`, `context_enable`, `context_disable`, `context_save_source`, `context_sync`,
    `context_resolve`, `context_migrate` gọi sidecar (nguồn, memory hub, chính sách qua file tạm, xoá sau khi chạy); kiểu
    TS khớp fixture Go.
  - **PHẠM VI**: `apps/desktop/src-tauri/src/{context_sync.rs,lib.rs}`, `capabilities/app.json`,
    `apps/desktop/src/lib/context-sync.ts` (+ test).
  - **Kiểm**: Rust test dựng argv; Vitest so kiểu với fixture `context-project.json`.

- [x] **T008 [US1] [vừa] · 1,5 ngày — Màn Memory: mục "Ngữ cảnh dùng chung"** (sau T007)
  - **Goal**: `<SharedContextSection>` theo [plan.md](plan.md) mục 7: chọn dự án, bật/tắt (xác nhận), ô soạn nguồn (lưu →
    đồng bộ), bảng file đích (CLI, đường dẫn ngắn, trạng thái, lý do), hộp so sánh khi xung đột (giữ bản file / bản
    nguồn), đề nghị chuyển từ chia sẻ cũ (xem trước bản nháp), ước lượng token khối. Chữ vi/en, 360 px, bàn phím.
  - **PHẠM VI**: `apps/desktop/src/components/shared-context-section.tsx` (+ test),
    `apps/desktop/src/screens/memory-screen.tsx`.
  - **Kiểm**: Vitest theo vai trò và tên: bật, lưu nguồn, xung đột, tắt, chuyển từ chia sẻ cũ.

- [ ] **T009 [P] [US2] [vừa] · 1 ngày — Rust `optimize_all.rs` và `lib/optimize-all.ts`** (sau T006, sau T007 vì `lib.rs`)
  - **Goal**: `optimize_all_preview(policyFile?)`, `optimize_all_apply(plan)` (chạy bước `tool.*` theo bảng `doctor.rs`
    trước, ghi kết quả vào kế hoạch, rồi gọi sidecar `--apply`), `optimize_all_undo(runId)`, `optimize_all_last`. Chỉ id
    trong bảng cho phép; giao diện chỉ gửi id và cờ `selected`.
  - **PHẠM VI**: `apps/desktop/src-tauri/src/{optimize_all.rs,lib.rs}`, `capabilities/app.json`,
    `apps/desktop/src/lib/optimize-all.ts` (+ test).
  - **Kiểm**: Rust test từ chối id lạ; Vitest kiểu khớp fixture.

- [ ] **T010 [US2] [vừa] · 1,5 ngày — Nút "Tối ưu", hộp xem trước, kết quả, hoàn tác** (sau T009)
  - **Goal**: `<OptimizeAllButton>` ở hàng đầu `token-score-card.tsx` (trước nút tính lại); `<OptimizePreviewDialog>` nhóm
    theo `group` ("Cấu hình CLI", "Công cụ", "Ngữ cảnh", "Điểm"), ô chọn mỗi dòng, cảnh báo `aggressive` như 025, ghi
    `reason`; sau khi chạy: điểm trước → sau, từng dòng ✓/✗ kèm lý do, nút "Hoàn tác lần này"; báo "Đang tối ưu ở cửa sổ
    khác" khi `OPTIMIZE_LOCKED`.
  - **PHẠM VI**: `apps/desktop/src/components/{optimize-all-button,optimize-preview-dialog}.tsx` (+ test),
    `apps/desktop/src/components/token-score-card.tsx`.
  - **Kiểm**: Vitest: xem trước không ghi gì, bỏ chọn dòng, `aggressive` không chọn sẵn, kết quả có lỗi một dòng, hoàn tác.

- [x] **T011 [P] [—] [nhẹ] · 0,5 ngày — ADR 0037, sửa FR-012 spec 025, tài liệu người dùng** (song song đợt 1–2)
  - **Goal**: `docs/adr/0037-shared-context-local-files.md` (một nguồn, file cục bộ, dấu khối, gương Codex, thay FR-012);
    `docs/adr/README.md`; `specs/025-token-score/spec.md` FR-012 và gợi ý A3 trỏ sang spec 029; `docs/token-optimizer.md`
    (nút "Tối ưu", ngữ cảnh dùng chung); `docs/architecture.md` (gói `ctxsync`, `optimizeall`).
  - **PHẠM VI**: các file vừa kể.
  - **Kiểm**: liên kết nội bộ đúng; không mâu thuẫn plan.

**Checkpoint P1**: quickstart mục 2 và 3 đạt trên máy dev; SC-001…SC-004.

## Đợt 3: Hub và đồng bộ (P2)

- [x] **T012 [P] [US3] [US4] [vừa] · 0,5 ngày — Contracts: `devOptimizer`, `pinned`, `memory.pin`**
  - **Goal**: theo [contracts/hub-api.md](contracts/hub-api.md) mục `projects.ts` (chỉ `devOptimizerPolicy`,
    `projectSettings.devOptimizer`, `projectSettingsPatch.devOptimizer`; **không** đụng `tokenSaving`) và `knowledge.ts`
    (`pinned`, route `memory.pin`). Ràng buộc: `contextBudgetTokens` 500–8.000 (mặc định 2.000), `memorySyncMinutes`
    15–1.440 (mặc định 60), `autoCompactWindow` 50.000–1.000.000 hoặc null. `pnpm openapi`.
  - **PHẠM VI**: `packages/contracts/src/{projects.ts,knowledge.ts}` (+ test), `openapi.json`.
  - **Kiểm**: test zod giá trị biên; `pnpm openapi` không lệch.

- [x] **T013 [US3] [vừa] · 1 ngày — Hub `knowledge`: cột `pinned`, sắp, `pinMemory`** (sau T012)
  - **Goal**: migration `0084_*` thêm `memories.pinned boolean not null default false`; `listMemories` sắp
    `pinned desc, created_at desc`; `pinMemory` (quyền như duyệt memory ở phạm vi của memory, audit `memory.pin`); route.
  - **PHẠM VI**: `apps/hub/db/migrations/0084_*.sql` (+ meta drizzle), `apps/hub/src/modules/knowledge/{schema.ts,memory.ts,router.ts}`, `*.db.test.ts`.
  - **Kiểm**: quyền (thành viên thường không ghim được), thứ tự, audit, migration lên từ schema cũ.

- [ ] **T014 [P] [US4] [vừa] · 1 ngày — Hub + web: chính sách "Tối ưu máy dev" của dự án** (sau T012)
  - **Goal**: `updateProjectSettings` nhận `devOptimizer` (quyền và audit sẵn có); mục cài đặt "Tối ưu máy dev" sau mục
    `tokens` trên trang cài đặt dự án, chỉ admin sửa; mô tả rõ "chỉ áp cho máy dev, run hub dùng mục Tiết kiệm token".
  - **PHẠM VI**: `apps/hub/src/modules/catalog/settings.ts` (+ db test), `apps/web/src/lib/project-settings.ts`,
    `apps/web/src/pages/project-settings-page.tsx` (+ component mới), `apps/web/e2e/project-dev-optimizer.spec.ts`.
  - **Kiểm**: db test quyền + audit; Playwright admin/không admin (quickstart mục 5 bước 1).

- [ ] **T015 [P] [US3] [nhẹ] · 0,5 ngày — Web: nút ghim memory** (sau T013)
  - **Goal**: nút "Ghim"/"Bỏ ghim" ở danh sách memory dự án, chỉ hiện với người có quyền; biểu tượng ghim trên mục đã ghim.
  - **PHẠM VI**: trang/danh sách memory của web (`apps/web/src/pages/**/memor*`), e2e liên quan.
  - **Kiểm**: Playwright ghim, bỏ ghim, người không quyền không thấy nút.

- [x] **T016 [P] [US3] [nặng] · 1,5 ngày — `ctxsync`: mục "Từ hub", lọc bí mật, ngân sách** (sau T006; song song T012–T015)
  - **Goal**: `hub.go` đọc `HubSnapshot` (`--hub-file`), bỏ bản `supersededBy`, thứ tự ghim → mới; `secrets.go` dùng lại
    mẫu nhận dạng bí mật sẵn có của worker nếu có, không thì bộ nhỏ (khoá API phổ biến, `PRIVATE KEY`, chuỗi entropy cao);
    ngân sách theo `contextBudgetTokens` (ước lượng như `memstore/tokens.go`); `omitted{budget,secret}`; giữ `hub.json`
    cũ và `lastError` khi lỗi; `autoSync` từ máy hoặc chính sách.
  - **PHẠM VI**: `worker/internal/ctxsync/{hub.go,secrets.go}` (+ test), `worker/internal/ctxsync/sync.go` (gọi phần hub).
  - **Kiểm**: FR-022…FR-025: ngân sách, bỏ bí mật, mục bị gỡ biến mất, mất mạng giữ bản cũ.

- [ ] **T017 [US3] [vừa] · 1 ngày — Desktop: kéo memory hub, đồng bộ định kỳ** (sau T008, T013, T016)
  - **Goal**: `lib/hub-context.ts` gọi `memory.list({project, status:"approved", limit:200})` bằng PAT, ghi file tạm, gọi
    `context_sync`; nút "Đồng bộ", công tắc tự đồng bộ, bộ hẹn giờ khi app mở (như lịch tính điểm hằng ngày của 025);
    phần "Từ hub" của `<SharedContextSection>` (số mục, đã bỏ, lần cuối, lỗi).
  - **PHẠM VI**: `apps/desktop/src/lib/hub-context.ts` (+ test), `apps/desktop/src/components/shared-context-section.tsx`,
    `apps/desktop/src/screens/memory-screen.tsx`.
  - **Kiểm**: Vitest với hub giả: đồng bộ, lỗi mạng, hẹn giờ.

- [ ] **T018 [US4] [vừa] · 1 ngày — Desktop: chính sách dự án vào "Tối ưu", hiện lệch chính sách** (sau T010, T014)
  - **Goal**: đọc `settings.devOptimizer` của các dự án đã gắn (`projects.get`), truyền `--policy-file` cho xem trước;
    thẻ điểm hiện "Lệch chính sách: …" theo từng mục; dòng xem trước ghi "Theo chính sách dự án …".
  - **PHẠM VI**: `apps/desktop/src/lib/hub-context.ts` (thêm hàm chính sách), `apps/desktop/src/components/token-score-card.tsx`,
    `apps/desktop/src/screens/tokens-screen.tsx` (+ test).
  - **Kiểm**: Vitest: có/không chính sách, nhiều dự án, `aggressive` vẫn cần chọn tay.

**Checkpoint P2**: quickstart mục 4, 5; SC-005.

## Đợt 4: Outbox và báo cáo token (P3)

- [x] **T019 [P] [US5] [nặng] · 1,5 ngày — Outbox tối thiểu trong worker**
  - **Goal**: theo [spec 027 data-model](../027-hub-client-model/data-model.md) "Mục hộp thư đi", chỉ kênh `worker`:
    `outbox/<identity>/<ulid>.json` (0600), trạng thái `pending → sending → accepted|duplicate|rejected|expired`, backoff
    5 s → 5 phút, hết hạn 14 ngày, `sent.jsonl`; gửi bằng `hubclient.PostClientEvent` với `idempotencyKey` = ULID; lệnh
    `outbox submit|flush|status`; chuyển `score.PendingReport` (025) sang outbox.
  - **PHẠM VI**: `worker/internal/outbox/**`, `worker/cmd/hive-worker/{outbox.go,main.go,optimize_score_report.go}`, test.
  - **Kiểm**: SC-006 đúng một lần qua khởi động lại (tiến trình bị giết giữa `sending`), từ chối, hết hạn, backoff.

- [x] **T020 [P] [US5] [US6] [vừa] · 0,5 ngày — Contracts: `memory.propose`, `project.token_usage`, token dự án** (sau T012)
  - **Goal**: theo [contracts/hub-api.md](contracts/hub-api.md) mục `client-events.ts` (payload `.strict()`, chỉ số/enum/
    uuid/ngày; `content` 1–2.000 ký tự), `projects.tokenUsage`, `fleet.deleteMyProjectUsage`; `MACHINE_EVENT_KINDS`;
    `pnpm openapi`.
  - **PHẠM VI**: `packages/contracts/src/{client-events.ts,projects.ts,fleet.ts}` (+ test), `openapi.json`.
  - **Kiểm**: test zod: payload có trường lạ bị từ chối; không trường chuỗi tự do ở `project.token_usage` (SC-007).

- [x] **T021 [US5] [vừa] · 1 ngày — Hub: nhận `memory.propose`** (sau T020)
  - **Goal**: `knowledge.proposeFromMachine(tx, machine, payload)` (xuất qua `index.ts`): chính sách memory tổ chức tắt →
    `MEMORY_DISABLED`; chủ máy không là thành viên dự án → `NOT_PROJECT_MEMBER`; ghi `pending`, `source:"machine"`, máy
    nguồn trong audit; nhánh trong `receiveMachineEvent`.
  - **PHẠM VI**: `apps/hub/src/modules/knowledge/{memory.ts,index.ts}`, `apps/hub/src/modules/fleet/token-scores.ts`
    (nhánh mới), `*.db.test.ts`.
  - **Kiểm**: db test các mã từ chối, chống trùng `idempotencyKey`.

- [x] **T022 [P] [US6] [nặng] · 1,5 ngày — Hub: bảng `project_token_usage`, nhận, đọc, xoá** (sau T020; song song T021)
  - **Goal**: migration `0085_*` theo [data-model.md](data-model.md) (khoá duy nhất `(machine_id, project_id, period_end)`,
    chỉ mục `(org_id, project_id, period_end desc)`, bật + ép RLS); `recordProjectUsage` upsert, giới hạn 1 lần/10 phút mỗi
    `(machine_id, project_id)`, kiểm chủ máy là thành viên dự án; dọn 90 ngày cùng `machine_token_scores`;
    `projects.tokenUsage` (thành viên dự án); `fleet.deleteMyProjectUsage` (chủ máy).
  - **PHẠM VI**: `apps/hub/db/migrations/0085_*.sql` (+ meta), `apps/hub/src/modules/fleet/{schema.ts,project-usage.ts,router.ts,rls.db.test.ts}`,
    `apps/hub/src/modules/fleet/token-scores.ts` (nhánh mới, sau T021), `apps/hub/src/modules/catalog/router.ts` (route đọc), `*.db.test.ts`.
  - **Kiểm**: RLS tổ chức khác không đọc được; người ngoài dự án không đọc được; giới hạn; xoá.

- [ ] **T023 [P] [US6] [vừa] · 1 ngày — Worker: gom token theo dự án, gửi `project.token_usage`** (sau T019)
  - **Goal**: `tokenreport` gán phiên vào dự án khi `cwd` nằm trong thư mục đã gắn (`projects.json`); dựng payload 7 ngày
    (tokens theo CLI, số phiên, điểm máy, `policyDrift`); gửi qua outbox khi người dùng bật (cờ theo dự án trong cấu hình
    máy, mặc định tắt).
  - **PHẠM VI**: `worker/internal/tokenreport/**`, `worker/cmd/hive-worker/optimize_score_report.go`, test.
  - **Kiểm**: `TestProjectUsagePayloadHasNoText` (SC-007); gán dự án theo `cwd` (thư mục con, khác ổ đĩa Windows).

- [ ] **T024 [US5] [US6] [vừa] · 1 ngày — Desktop: outbox, gửi memory qua hàng đợi, bật gửi số liệu** (sau T017, T019)
  - **Goal**: Rust `outbox.rs` (`outbox_submit`, `outbox_flush`, `outbox_status`); `lib/outbox.ts`; "Gửi lên hub" trong
    `memory-hub-sync.tsx` đi qua `outbox_submit`, báo "Đã xếp hàng, sẽ gửi khi có mạng"; thẻ "Đang chờ gửi" và việc bị từ
    chối trên màn Memory; flush khi mở app và sau mỗi lần submit; công tắc "Gửi số liệu token của dự án" (mặc định tắt) và
    nút "Xoá số liệu đã gửi".
  - **PHẠM VI**: `apps/desktop/src-tauri/src/{outbox.rs,lib.rs}`, `capabilities/app.json`, `apps/desktop/src/lib/outbox.ts`,
    `apps/desktop/src/components/memory-hub-sync.tsx`, `apps/desktop/src/screens/memory-screen.tsx`, test.
  - **Kiểm**: Vitest: xếp hàng khi lỗi mạng, hiện số chờ, từ chối có lý do.

- [ ] **T025 [P] [US6] [vừa] · 1 ngày — Web: bảng token của dự án** (sau T022)
  - **Goal**: tab/mục "Token" ở trang dự án: bảng theo người và máy (token quy đổi 7 ngày, số phiên, điểm, lệch chính
    sách), chỉ thành viên dự án; trống thì giải thích cách bật trên app desktop.
  - **PHẠM VI**: `apps/web/src/pages/projects/**` (trang/tab mới), `apps/web/src/router.tsx`, `apps/web/e2e/project-token-usage.spec.ts`.
  - **Kiểm**: Playwright: có dữ liệu, trống, người ngoài dự án; 360 px.

**Checkpoint P3**: quickstart mục 6, 7; SC-006, SC-007.

## Đợt cuối

- [ ] **T026 [—] [nhẹ] · 0,5 ngày — SRS, tài liệu, `/speckit-analyze`** (sau mọi task agent)
  - **Goal**: `docs/srs.md` thêm FR-001…FR-062; `docs/token-optimizer.md`, `docs/architecture.md` cập nhật P2–P3; chạy
    `/speckit-analyze` trên spec, plan, tasks và xử lý mâu thuẫn.
  - **PHẠM VI**: `docs/srs.md`, `docs/token-optimizer.md`, `docs/architecture.md`, `specs/029-shared-context-sync/*.md`.

- [ ] **T027 [—] [người: chủ dự án] · 0,5 ngày người — Chạy quickstart trên máy thật và đo SC-008**
  - **Goal**: quickstart mục 2–7 trên máy dev Windows và Mac mini; sau 7 ngày bật, so token ngữ cảnh trung bình mỗi phiên
    với 7 ngày trước (báo cáo token 015). Ghi vào research.md mục 9.

## Phụ thuộc và song song

```
Đợt 0:  T001 ─┐          T002 ─┬──────────────┐
Đợt 1:        └─▶ T003 ─▶ T004 ─┤              └─▶ T005 ─┐
                                └──────────────────────▶ T006
Đợt 2:  T004 ─▶ T007 ─▶ T008          T006 + T007 ─▶ T009 ─▶ T010          T011 (bất kỳ lúc nào)
Đợt 3:  T012 ─▶ T013 ─▶ T015          T012 ─▶ T014          T006 ─▶ T016
        T008 + T013 + T016 ─▶ T017     T010 + T014 ─▶ T018
Đợt 4:  T019 ──────────────┐  T012 ─▶ T020 ─▶ T021 ─▶ T022(nhánh token-scores) ─▶ T025
        T019 ─▶ T023        └─ T017 + T019 ─▶ T024
Cuối:   mọi task ─▶ T026 ─▶ T027
```

Gợi ý chia agent (không đụng cùng file):

| Lượt | Agent A (Go) | Agent B (desktop) | Agent C (hub/web) |
|---|---|---|---|
| 1 | T002 → T003 → T004 | T001 (người/agent nhẹ), T011 | — |
| 2 | T005 → T006 | T007 → T008 | T012 → T013 → T015 |
| 3 | T016 | T009 → T010 | T014 |
| 4 | T019 → T023 | T017 → T018 | T020 → T021 → T022 → T025 |
| 5 | — | T024 | — |

Tổng ước lượng: khoảng 25 ngày-agent; với ba agent song song khoảng 9–10 ngày lịch.

## MVP

P1 (T001–T011) là MVP: một ngữ cảnh cho mọi CLI và nút "Tối ưu" có hoàn tác, không cần hub. Phát hành được riêng.
