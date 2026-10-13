# Tasks: Chế độ AI SDLC

**Input**: [spec.md](spec.md), [plan.md](plan.md), [ADR 0021](../../docs/adr/0021-ai-sdlc-mode.md)

**Tests**: bắt buộc (feature-checklist mục 5). Mỗi task tự viết test của phần mình và để `pnpm check` xanh.

## Cách đọc

- Dạng: `- [ ] T### [P?] [US?] Mô tả` rồi các dòng **Scope** (file được sửa/tạo, chỉ task đó đụng), **Phụ thuộc**,
  **Mức** (`nặng` → Opus 5.5 `--effort high`; `vừa` → Sonnet 5.5 `--effort high`; `nhẹ` → Sonnet 5.5 `--effort medium`,
  theo CLAUDE.md).
- `[P]`: chạy song song được với các task `[P]` khác **khi phụ thuộc đã xong** (khác file, không chờ nhau).
- Hai task cùng một **làn** (bảng cuối) sửa chung file nên phải làm nối tiếp trong cùng worktree hoặc sau khi task trước
  đã merge.
- `packages/contracts/openapi.json` và `packages/contracts/src/index.ts` chỉ T001 sửa. Task khác cần đổi contract thì báo
  người điều phối thêm vào T001 hoặc mở task contract mới, không tự sửa.
- Migration chỉ T004 sinh (số `0058`). Task khác cần đổi bảng thì làm sau T004 và sinh migration số kế tiếp.
- **MVP** (đánh dấu 🎯): preset `bugfix`, `small`, `aidlc-express`, `speckit`; chặn cứng; tách task; truy vết cơ bản
  (requirement → task → run → PR → merge); luồng đủ trên web và app.

---

## Phase 1: Nền (chặn mọi story)

- [ ] T001 🎯 Contract chế độ AI SDLC
  - `sdlc.ts` mới: `sdlcMethod`, `sdlcPhaseKind`, `sdlcSize`, `sdlcStepAction`, `sdlcBlocking`, `breakdownParser`,
    `repoPathTemplate`, `sdlcArtifact`, `sdlcStep`, `sdlcPhase`, `sdlcDecomposition`, `sdlcMode` (`superRefine`: id duy
    nhất, tham chiếu, thư mục cấm, regex biên dịch được), `projectSdlcSettings`, schema item/phase/artifact/question/step/
    breakdown/trace/metrics/fleet, lỗi `SDLC_GATE_BLOCKED`, `TASK_DEPENDENCIES_OPEN`, `sdlcContract` đủ route của plan.md.
  - Khung rỗng cho T002, T003: `sdlc-presets/index.ts` (`SDLC_PRESETS = {}` có kiểu), `breakdown.ts` (kiểu
    `Breakdown`, `BreakdownTask`, chữ ký hàm, thân `throw`).
  - `tasks.ts` (`checklist`, `dependsOn`, `blockedBy`, `tasks.setDependencies`), `runs.ts` (`runKind` + `sdlc`,
    `requiredLabels`), `fleet.ts` (`machineLabel`, `labels`, `labelsOnly`, `accounts`, route nhãn và gói, mã đăng ký nhận
    `labels`, `shared`, `labelsOnly`), `projects.ts` (`settings.sdlc`), `workflows.ts` (`no-open-questions`, `breakdown`,
    `coverage` vào `DOC_RULE_CHECKS`), `leader.ts` (`sdlc.item.create`), `roles.ts` (`sdlc.read`, `sdlc.write`,
    `sdlc.override` danger, `sdlc.modes.write`), `notify.ts` (sự kiện `sdlc.*`), `worker-protocol.ts`
    (`heartbeat.accounts?`, `account_set`, comment cho `spec.sdlc`, `report.artifacts`), `index.ts`; `pnpm openapi`.
  - Test: `sdlc.test.ts` (đường dẫn cấm, tham chiếu sai, cài đặt dự án), `worker-protocol.test.ts` (heartbeat cũ vẫn
    parse), roles snapshot nếu có.
  - **Scope**: `packages/contracts/src/{sdlc.ts,sdlc.test.ts,breakdown.ts,sdlc-presets/index.ts,tasks.ts,runs.ts,fleet.ts,projects.ts,workflows.ts,leader.ts,roles.ts,notify.ts,worker-protocol.ts,worker-protocol.test.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: không · **Mức**: nặng

- [ ] T002 🎯 [P] Preset MVP: `bugfix`, `small`, `aidlc-express`, `speckit`
  - Mỗi preset một file: giai đoạn, tài liệu (đường dẫn như bảng ánh xạ của plan.md), khuôn Markdown ngắn, cổng (dùng
    `reviewPhase`), bước agent với prompt viết lại (không chép nguyên văn Spec Kit/AI-DLC; ghi nguồn tham khảo trong
    comment đầu file), `decomposition`.
  - Test: mọi preset parse qua `sdlcMode`; đường dẫn sinh đúng cho `{NNN}`, `{slug}`, `{date}`; khuôn có đủ mục bắt buộc.
  - **Scope**: `packages/contracts/src/sdlc-presets/{index.ts,bugfix.ts,small.ts,aidlc-express.ts,speckit.ts,presets.test.ts}`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T003 🎯 [P] Bộ đọc/ghi bản tách task (thuần)
  - `parseBreakdown(markdown, decomposition)` cho `hive-tasks` (định dạng tasks.md của repo này: `T###`, `[P]`, `[USn]`,
    "Phụ thuộc") và `speckit-tasks`; độ mịn `item`, `heading`, `single`; phụ thuộc, phát hiện chu trình, đợt (sắp topo),
    requirement theo regex; lỗi có số dòng tiếng Việt.
  - `writeBreakdown(breakdown, parser)`: ghi lại Markdown; đọc–ghi–đọc giữ nguyên cấu trúc.
  - `coverage(requirements, breakdown)`.
  - Fixture: `tasks.md` của specs/009, mẫu 58 dòng `T###` của app v1 (SC-005: ≤ 12 task hub với `heading`).
  - **Scope**: `packages/contracts/src/{breakdown.ts,breakdown.test.ts}`, `packages/contracts/src/fixtures/breakdown/**`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T004 🎯 Bảng và migration 0058
  - `sdlc/schema.ts` mới (9 bảng như plan.md, `orgScoped`, policy `hive_owner` select); `tasks/schema.ts` (`checklist`,
    `task_dependencies`); `runs/schema.ts` (`required_labels`, enum `sdlc`); `fleet/schema.ts` (`labels`, `labels_only`,
    `accounts`, `accounts_at`; `registration_tokens` + nhãn, cờ).
  - `pnpm --filter @xdev-hive/hub db:generate` → `0058_ai_sdlc.sql`; thêm tay `FORCE ROW LEVEL SECURITY`, hàm
    `hive.sdlc_active_orgs()`.
  - `sdlc/rls.db.test.ts`; `tasks` RLS cho `task_dependencies`; ca nâng cấp từ 0057 trong `migrations-upgrade.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/sdlc/{schema.ts,rls.db.test.ts}`, `apps/hub/src/modules/tasks/schema.ts`,
    `apps/hub/src/modules/runs/schema.ts`, `apps/hub/src/modules/fleet/schema.ts`, `apps/hub/db/migrations/0058_*.sql`,
    `apps/hub/db/migrations/meta/*`, `apps/hub/src/migrations-upgrade.db.test.ts`, `apps/hub/src/modules/tasks/rls.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T005 🎯 [P] Thiết kế màn app (dùng chung web) bằng skill `ui-ux-pro-max`, design system v2, shadcn/ui; mỗi màn có
  trạng thái rỗng/đang chạy/lỗi, 360 px, sáng/tối, chữ vi/en.
  - **Scope**: `docs/design-system/screens/{AppSdlcBoard,AppSdlcNewItem,AppSdlcItem,AppSdlcQuestions,AppSdlcBreakdown,AppSdlcTrace,AppSdlcMetrics}.dc.html`
    (mới), `docs/design-system/screens/{AppNav,DocEditor,DocReview}.dc.html` (biến thể), `docs/design-system/screens/README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

- [ ] T006 [P] Thiết kế màn web cấu hình và quản trị
  - **Scope**: `docs/design-system/screens/{SdlcModes,SdlcFleet,Machines}.dc.html` (mới),
    `docs/design-system/screens/ProjectSettings.dc.html` (biến thể mục AI SDLC)
  - **Phụ thuộc**: không · **Mức**: vừa

**Checkpoint**: contract, preset MVP, bộ đọc, bảng, thiết kế sẵn sàng.

---

## Phase 2: Lõi hub — chế độ, hạng mục, giai đoạn, cổng (US8, US1, US3, US6) 🎯

- [ ] T010 🎯 [P] Task có checklist và phụ thuộc
  - `tasks.ts`: ghi/đọc `checklist`; `setDependencies` (cùng dự án, kiểm chu trình bằng DFS trong transaction, khoá
    advisory theo dự án), `blockedBy` trong get/list; audit `task.dependencies`; `index.ts` export
    `setTaskDependencies`, `dependenciesOf`, `updateChecklist`, `createSystemTask` nhận `checklist`.
  - Test DB: chu trình bị từ chối, khác dự án bị từ chối, xoá task xoá cạnh, list trả `blockedBy`.
  - **Scope**: `apps/hub/src/modules/tasks/{tasks.ts,router.ts,index.ts,dependencies.ts,dependencies.db.test.ts}`
  - **Phụ thuộc**: T004 · **Mức**: vừa

- [ ] T011 🎯 [P] [US8] [US1] Chế độ và gợi ý cỡ
  - `modes.ts`: preset + chế độ tự tạo trong phạm vi (đội > tổ chức), lưu (kiểm chính sách agent qua `governance`),
    xoá, chạy thử; `suggest.ts` thuần (nhãn issue, độ dài, từ khoá rủi ro của dự án → cỡ, chế độ cho phép phù hợp).
  - Test: `suggest.test.ts`; `modes.db.test.ts` (preset chỉ đọc, đường dẫn cấm, quyền `sdlc.modes.write`).
  - **Scope**: `apps/hub/src/modules/sdlc/{modes.ts,suggest.ts,suggest.test.ts,modes.db.test.ts}`
  - **Phụ thuộc**: T002, T004 · **Mức**: vừa

- [ ] T012 🎯 [US1] [US3] Hạng mục và máy trạng thái giai đoạn
  - `items.ts`: tạo (số `NNN`, slug, chụp chế độ và cài đặt, tài liệu hub theo khuôn, `sdlc_artifacts`, `sdlc_item_phases`),
    từ issue (chống trùng, bình luận lên issue qua `scm`), tạm dừng/tiếp tục/huỷ, đổi chế độ khi chưa có baseline.
  - `phases.ts`: `advance` (giai đoạn theo cỡ, bước `auto` qua deps `startSdlcRun` — khung gọi, T022 làm thân),
    `onBaseline` (cập nhật tài liệu, giai đoạn `approved`, sang giai đoạn kế), bỏ qua giai đoạn `optional`;
    `workflowFor(docKey)` dựng quy trình từ `phase.gate`.
  - `index.ts`: export `onBaseline`, `workflowFor`, `codeRunGate` (khung, T013 làm thân), `type SdlcDeps`;
    `router.ts`: route modes, suggest, items (create, list, board, get, pause/resume/cancel, skip-phase).
  - `jobs.ts`: queue `sdlc` (advance), đăng ký worker.
  - Test DB: tạo, issue trùng, đường dẫn trùng trong repo (provider memory), giai đoạn theo cỡ, onBaseline 2 tài liệu
    bắt buộc, tài liệu tuỳ chọn không chặn, bỏ qua cần lý do, audit.
  - **Scope**: `apps/hub/src/modules/sdlc/{items.ts,phases.ts,jobs.ts,index.ts,router.ts,items.db.test.ts,phases.db.test.ts}`
  - **Phụ thuộc**: T004, T011 · **Mức**: nặng

- [ ] T013 🎯 [US6] Cổng chặn run code và ngoại lệ
  - `gate.ts`: `codeRunGate(tx, {taskId, kind})` (phụ thuộc chưa `done`; tài liệu bắt buộc trước `implementation`; mức chặn
    chặt nhất; ngoại lệ hiệu lực), `createOverride`, `revokeOverride` (lý do ≥ 10 ký tự, hạn, audit, thông báo).
  - Route `overrides.create|revoke` trong hàm đăng ký riêng `overrideRoutes` (T070 gộp vào `router.ts`), tránh sửa chung.
  - Test: `gate.test.ts` (thuần, chặt nhất, hết hạn); `gate.db.test.ts` (chặn/cho qua, ngoại lệ task và hạng mục, thu hồi).
  - **Scope**: `apps/hub/src/modules/sdlc/{gate.ts,overrides.ts,gate.test.ts,gate.db.test.ts}`
  - **Phụ thuộc**: T010, T012 · **Mức**: nặng

- [ ] T014 🎯 [US3] Nối `knowledge` với hạng mục
  - `reviews.ts`: `ReviewDeps.workflowFor?(tx, docKey)` hỏi trước `matchWorkflow` (trong `startReview`, `previewSubmit`);
    `finish` gọi `deps.onBaseline?` trong transaction; hướng `agent` gọi `deps.queueAuthorFix?` khi có (thay task chung);
    `traceOf` dùng `deps.traceFor?` khi có.
  - `review-rules.ts`: `no-open-questions` (dấu `[NEEDS CLARIFICATION` + câu hỏi mở qua deps), `breakdown`, `coverage`
    (dùng `breakdown.ts` của contracts), `requirementsOf(content, regex?)`.
  - Sửa luôn lỗi `saveWorkflow`/`workflowView` bỏ mất `subject`/`code` (reviews.ts:100-104) vì hạng mục cần phân biệt.
  - Test: `review-rules.test.ts` (3 luật mới), `reviews.db.test.ts` (deps có/không có: hành vi cũ giữ nguyên).
  - **Scope**: `apps/hub/src/modules/knowledge/{reviews.ts,review-rules.ts,review-jobs.ts,editor.ts,index.ts,review-rules.test.ts,reviews.db.test.ts}`
  - **Phụ thuộc**: T001, T003 · **Mức**: nặng

**Checkpoint**: tạo hạng mục, viết tay tài liệu, duyệt theo giai đoạn, chặn run code — chưa cần worker mới.

---

## Phase 3: Agent soạn và hỏi lại (US2) 🎯

- [ ] T020 🎯 [P] Worker chạy run `sdlc`
  - `runner`: kind `sdlc` dùng worktree tạm từ nhánh mặc định (như `doccheck`, kể cả dự án có thư mục trên máy theo ADR
    0020), không `readOnlyKind`, quyền `workspace`; ghi `spec.sdlc.seed` (kiểm đường dẫn nằm trong worktree, không theo
    symlink ra ngoài); sau khi CLI thoát đọc `collect`, sha256, giới hạn (20 file, 200 000 ký tự/file, 2 MB tổng), trả
    `report.artifacts`; không commit, không đẩy. `runner.Capabilities` thêm `sdlc`; `accounts.RoleOf("sdlc") = plan`.
  - `gofmt -l .`, `go vet ./...`, `go test ./...` (seed, collect, vượt giới hạn, đường dẫn `../`, Windows path).
  - **Scope**: `worker/internal/runner/{sdlc.go,sdlc_test.go,runner.go}`, `worker/internal/accounts/accounts.go`,
    `worker/internal/channel/jobs_test.go`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T021 🎯 [US2] [US14] `runs`: loại `sdlc`, cổng, nhãn
  - `engine.ts`: `CAPABILITY_KINDS` + `sdlc`; `startSdlcRun(tx, input)` (chủ theo `runner`, `required_labels`,
    `spec.sdlc.seed/collect`, prompt do `sdlc` truyền vào); `verify` → `verifySdlc` gọi `sdlc.onSdlcRunFinished`;
    `queueRun` gọi `sdlc.codeRunGate` (D10) và nhận `requiredLabels`; `pickMachine` lọc `required_labels` ⊆
    `machine.labels`, `labels_only`; lý do `waiting_machine` có nhãn thiếu; `onCodeRunSettled` gọi `sdlc`; prompt task hạng
    mục thêm `sdlc.specContextFor`.
  - `mcp.ts`: `task_update` nhận `checklist?`, `evidence?` (tuỳ chọn, agent cũ vẫn hợp lệ).
  - Test: `runs.db.test.ts` (SC-010 nhãn; worker không capability `sdlc` → chờ; SC-001 qua web, leader `run.dispatch`,
    @bot, issue), mọi test cũ không sửa (SC-011).
  - **Scope**: `apps/hub/src/modules/runs/{engine.ts,mcp.ts,index.ts}`, `apps/hub/src/{runs.db.test.ts,runs-sdlc.db.test.ts}`
  - **Phụ thuộc**: T013 · **Mức**: nặng

- [ ] T022 🎯 [US2] Bước agent, prompt, câu hỏi, MCP
  - `steps.ts`: tạo bước (qua deps `startSdlcRun`), `onSdlcRunFinished` (artifacts → `doc_drafts` qua `knowledge`,
    `size`/`findings` → `result`, `autoSubmit`, lỗi → bước `failed`), giới hạn lượt agent sửa.
  - `prompt.ts`: dựng prompt theo bước (biến `{idea}`, `{artifacts}`, `{answers}`, `{feedback}`, `{constitution}`, skill
    nếu có), seed và collect của bước.
  - `questions.ts`: trả lời, "Dùng đề xuất", soạn lại tự động khi đủ, nhắc hạn 3 ngày (cron, `hive.sdlc_active_orgs()`).
  - `mcp-tools.ts`: `sdlc_context`, `sdlc_ask` (≤ 5 câu), `sdlc_report` (schema theo loại); `runKinds` đúng.
  - Route `items.step`, `questions.list|count|answer` qua hàm đăng ký riêng.
  - Test: `prompt.test.ts`; `steps.db.test.ts` (run giả: câu hỏi → `awaiting_answers` → trả lời → vòng 2 → bản nháp;
    7 câu bị cắt 5; autoSubmit; không file → failed); SC-008 (thời gian ghi → đọc).
  - **Scope**: `apps/hub/src/modules/sdlc/{steps.ts,prompt.ts,questions.ts,mcp-tools.ts,prompt.test.ts,steps.db.test.ts,questions.db.test.ts}`
  - **Phụ thuộc**: T012, T014 (T021 cho test tích hợp thật) · **Mức**: nặng

**Checkpoint**: agent soạn, hỏi lại, người trả lời, tài liệu vào bản nháp và qua cổng.

---

## Phase 4: Tách task, chạy đợt, truy vết cơ bản (US5, US6, US9) 🎯

- [ ] T030 🎯 [US5] Baseline tài liệu tách việc → task hub
  - `breakdown.ts` (hub): `applyBaseline` (tạo task với `checklist`, `dependsOn`, `source = sdlc`, `sdlc_item_tasks`, liên
    kết truy vết `task`; so bản trước theo khoá lát: tạo, cập nhật task `todo`, huỷ task bỏ còn `todo`, cảnh báo task bỏ đã
    chạy), chế độ `single` (một task); route `breakdown.get|save` (lưu = ghi lại Markdown vào bản nháp qua `knowledge`).
  - Test DB: Spec Kit `heading` 3 task; duyệt lại thêm/bỏ; `single` cho bugfix; audit `sdlc.breakdown.apply`.
  - **Scope**: `apps/hub/src/modules/sdlc/{breakdown.ts,breakdown.db.test.ts}`
  - **Phụ thuộc**: T010, T012, T003 · **Mức**: nặng

- [ ] T031 🎯 [US6] [US9] Chạy đợt và truy vết cơ bản
  - `waves.ts`: task sẵn sàng, `maxParallel`, chạy qua deps `startRun` (chủ theo nơi chạy, `requiredLabels`), tự chạy khi
    task `done`; tạm dừng.
  - `trace.ts`: `onCodeRunSettled` (liên kết `run`, `pr`, `test` từ evidence), handler `pull_request.merged` (liên kết
    `commit`, `ci` qua `checksFor`, xét đợt kế, giai đoạn `implementation` xong khi mọi task `done`), độ phủ 3 mức, CSV;
    `specContextFor(task)`.
  - Route `waves.run`, `trace` qua hàm đăng ký riêng; `registerSdlcScmHandlers`.
  - Test: `trace.test.ts` (SC-006), `waves.db.test.ts` (đợt 1 → merge → đợt 2, song song 2, tạm dừng).
  - **Scope**: `apps/hub/src/modules/sdlc/{waves.ts,trace.ts,scm.ts,trace.test.ts,waves.db.test.ts}`
  - **Phụ thuộc**: T030, T021 · **Mức**: nặng

**Checkpoint**: MVP hub đủ: ý tưởng → tài liệu → bản tách → task → PR → merge, có chặn và truy vết.

---

## Phase 5: Đồng bộ hub ↔ repo (US4) — làm khi Q1 chốt

- [ ] T040 [US4] Đồng bộ tài liệu với repo dự án
  - `sync.ts`: job `sdlc-sync` (gộp theo hạng mục, `pr` hoặc `direct` theo Q1, trailer `Hive-Sdlc-Item` +
    `Co-authored-by`, commit status, hàng merge qua deps, thử lại, `sdlc.sync_failed`); job `sdlc-pull` từ `push` (gộp 30 s)
    và cron 15 phút (so hash, bỏ commit của hub, tạo đề xuất + phiên duyệt, `drifted`/`deleted`); `sync` route (retry,
    overwrite-repo); nhập thư mục có sẵn (`items.import`).
  - Test DB với provider `memory`: pr/direct, lỗi quyền, push sửa một dòng → đề xuất, push giống baseline → không, xoá
    file, không có webhook (cron). SC-004 đo thời gian job.
  - **Scope**: `apps/hub/src/modules/sdlc/{sync.ts,import.ts,sync.test.ts,sync.db.test.ts}`
  - **Phụ thuộc**: T012, T014 · **Mức**: nặng

---

## Phase 6: Giao diện dùng chung, web, app (US7, US8) 🎯

- [ ] T050 🎯 [P] Package `@xdev-hive/sdlc-ui` — khung, bảng, tạo hạng mục, câu hỏi
  - `env.tsx` (`SdlcEnv`: api, lang, link, can, errorMessage — như `DocEditorEnv`), `text.ts` (vi/en), `item-board.tsx`,
    `item-list.tsx`, `new-item.tsx` (gợi ý cỡ/chế độ, issue), `questions.tsx`; test component.
  - **Scope**: `packages/sdlc-ui/**` (package mới: `package.json`, `src/{index.ts,env.tsx,text.ts,item-board.tsx,item-list.tsx,new-item.tsx,questions.tsx}`, test),
    `pnpm-workspace.yaml` nếu cần, `pnpm-lock.yaml`
  - **Phụ thuộc**: T001, T005 · **Mức**: vừa

- [ ] T051 🎯 Package `@xdev-hive/sdlc-ui` — chi tiết hạng mục
  - `item-detail.tsx` (tab Tổng quan, Tài liệu, Câu hỏi, Task, Truy vết), `phase-stepper.tsx`, `sync-status.tsx`,
    `override-dialog.tsx`, `steps-panel.tsx` (bước agent, trạng thái máy).
  - **Scope**: `packages/sdlc-ui/src/{item-detail.tsx,phase-stepper.tsx,sync-status.tsx,override-dialog.tsx,steps-panel.tsx}` + test
  - **Phụ thuộc**: T050 · **Mức**: vừa

- [ ] T052 🎯 Package `@xdev-hive/sdlc-ui` — duyệt bản tách và truy vết
  - `breakdown-review.tsx` (gộp/tách, sửa phụ thuộc, chuyển mục task ↔ checklist, độ phủ, lỗi đọc), `dependency-graph.tsx`
    (`@xyflow/react`, có dạng danh sách cho 360 px), `trace-matrix.tsx` (CSV).
  - **Scope**: `packages/sdlc-ui/src/{breakdown-review.tsx,dependency-graph.tsx,trace-matrix.tsx}` + test,
    `packages/sdlc-ui/package.json` (thêm `@xyflow/react`), `pnpm-lock.yaml`
  - **Phụ thuộc**: T051, T003 · **Mức**: vừa

- [ ] T053 [P] `doc-editor`: khung bên "Hạng mục" và thẻ trong ReviewPane
  - Khung bên khi key thuộc `project/<k>/sdlc/…`: giai đoạn, khuôn, mục bắt buộc, câu hỏi đã trả lời, "Nhờ agent soạn
    lại" (gọi `sdlc.items.step` qua `DocEditorEnv` mở rộng tuỳ chọn); ReviewPane thêm thẻ "Câu hỏi đã trả lời", "Bản tách
    task" (nhận component qua props, không import `sdlc-ui`).
  - **Scope**: `packages/doc-editor/src/{env.tsx,doc-editor.tsx,review-pane.tsx,sdlc-panel.tsx,text.ts}` + test
  - **Phụ thuộc**: T001, T005 · **Mức**: vừa

- [ ] T054 🎯 Web: luồng AI SDLC và cấu hình dự án
  - Route `/sdlc`, `/sdlc/new`, `/sdlc/questions`, `/sdlc/$project/$number` (+ tab), `lib/sdlc-env.tsx`, menu
    (`lib/nav.ts`), mục AI SDLC trong cài đặt dự án, thẻ bản tách trong `reviews-page.tsx`.
  - Hub giả + Playwright `sdlc.spec.ts`: luồng MVP (SC-009), bugfix ≤ 5 thao tác (SC-003), người chỉ đọc, 360 px, tối.
  - **Scope**: `apps/web/src/router.tsx`, `apps/web/src/pages/sdlc/**`, `apps/web/src/pages/project-settings-page.tsx`,
    `apps/web/src/pages/knowledge/reviews-page.tsx`, `apps/web/src/lib/{nav.ts,sdlc-env.tsx,project-settings.ts}`,
    `apps/web/e2e/{sdlc.spec.ts,fake-hub.ts,sdlc-fixture.ts}`, `apps/web/package.json`
  - **Phụ thuộc**: T052, T053 · **Mức**: vừa

- [ ] T055 🎯 Desktop: nhóm menu AI SDLC và màn
  - `nav.ts`: quyền `sdlc.use` (dev, writer, lead), `sdlc.manage` (lead), nhóm `sdlc` (Hạng mục, Câu hỏi chờ tôi, Tiến
    độ); `account.ts` `profileOf()` theo Q2; màn `sdlc-screen.tsx` (bảng + chi tiết + tạo + bản tách + truy vết theo
    hash `#/sdlc/<project>/<NNN>/<tab>`), `sdlc-questions-screen.tsx`; `write-screen.tsx` truyền env mở rộng cho khung bên;
    `reviews-screen.tsx` thẻ bản tách; từ điển vi/en.
  - Test: `nav.test.ts` (menu theo hồ sơ), `sdlc-screen.test.tsx`, `sdlc-questions-screen.test.tsx` (SC-009 phần app).
  - **Scope**: `apps/desktop/src/lib/{nav.ts,account.ts,sdlc-env.tsx,nav.test.ts}`,
    `apps/desktop/src/screens/{index.ts,sdlc-screen.tsx,sdlc-questions-screen.tsx,write-screen.tsx,reviews-screen.tsx}` + test,
    `apps/desktop/package.json`
  - **Phụ thuộc**: T052, T053 · **Mức**: vừa

---

## Phase 7: Máy worker AI SDLC (US13, US14, US15)

- [ ] T060 [P] [US13] [US14] Hub: nhãn máy, mã đăng ký có nhãn, tóm tắt gói, `account_set`
  - `machines.ts` (`setMachineLabels`, audit `machine.labels`), `registration.ts` (nhãn, `shared`, `labelsOnly` từ mã),
    `gateway.ts` (lưu `heartbeat.accounts`, gửi `account_set` khi capability `accounts-remote` + máy `shared`, báo `shared`
    trong `welcome.features`), route nhãn và gói; route `GET /v1/machines/sdlc` đặt ở `fleet/router.ts` (máy có nhãn, run
    `sdlc` và run task hạng mục đang chạy) vì `sdlc` không import `fleet`.
  - Test DB: mã đăng ký mang nhãn; nhãn sai định dạng; máy cá nhân không có `account_set`; heartbeat thiếu `accounts` giữ
    giá trị cũ.
  - **Scope**: `apps/hub/src/modules/fleet/{machines.ts,registration.ts,gateway.ts,router.ts,index.ts,fleet-sdlc.db.test.ts}`
  - **Phụ thuộc**: T004 · **Mức**: vừa

- [ ] T061 [P] [US13] [US15] Worker: tóm tắt gói, `account_set`, nhắc linger
  - Heartbeat gửi tóm tắt (không token, nhãn thay email); xử lý `account_set` (khoá file, ghi nguyên tử, chỉ khi hub báo
    `shared`); capability `accounts-remote`; `install.sh` nhắc `loginctl enable-linger` trên Linux.
  - `gofmt -l .`, `go vet ./...`, `go test ./...`.
  - **Scope**: `worker/internal/accounts/{summary.go,summary_test.go,remote.go,remote_test.go}`,
    `worker/internal/channel/{protocol.go,client.go,client_test.go}`, `scripts/install.sh`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T062 [US15] Web: Đội máy AI SDLC và nhãn trên trang Máy
  - `sdlc-ui` `fleet-table.tsx`; trang `/sdlc/fleet` (Thêm máy = mã đăng ký có nhãn, lệnh cài một dòng cho Linux/macOS/
    Windows); trang `/machines` thêm nhãn, "chỉ nhận run có nhãn", gói; Playwright `sdlc-fleet.spec.ts`.
  - **Scope**: `packages/sdlc-ui/src/fleet-table.tsx` + test, `apps/web/src/pages/sdlc/fleet-page.tsx`,
    `apps/web/src/pages/machines-page.tsx`, `apps/web/e2e/sdlc-fleet.spec.ts`
  - **Phụ thuộc**: T060, T054, T006 · **Mức**: vừa

---

## Phase 8: Nối hub

- [ ] T070 🎯 Nối deps, router, job, handler
  - `main.ts`: `SdlcDeps` (từ engine: `startSdlcRun`, `startRun`; từ catalog: `enqueueMerge`; `providerFactory`,
    `masterKey`, `jobs`), `ReviewDeps.workflowFor/onBaseline/queueAuthorFix/traceFor`, `registerSdlcWorker`, cron câu hỏi
    và quét đồng bộ, `registerSdlcScmHandlers`, MCP tools của `sdlc`.
  - `app.ts`: `sdlc: sdlcRouter(...)`.
  - `pnpm deps` không có vòng; test khói `app.test.ts`.
  - **Scope**: `apps/hub/src/{main.ts,app.ts,app.test.ts}`, `apps/hub/src/modules/sdlc/router.ts` (gộp các hàm đăng ký route)
  - **Phụ thuộc**: T013, T021, T022, T031 (T040, T060 khi có) · **Mức**: vừa

- [ ] T071 [P] Leader: hành động `sdlc.item.create`
  - Thực thi khi người duyệt đề xuất; prompt leader biết đề xuất tạo hạng mục cho việc lớn.
  - **Scope**: `apps/hub/src/modules/leader/{router.ts,prompt.ts,leader-sdlc.db.test.ts}`
  - **Phụ thuộc**: T012 · **Mức**: nhẹ

- [ ] T072 🎯 Kiểm hồi quy: `pnpm check`, bộ DB test của task, run, review tài liệu, hàng merge không sửa test cũ (SC-011);
  ghi kết quả vào PR.
  - **Scope**: không sửa file (chỉ báo cáo)
  - **Phụ thuộc**: T070 · **Mức**: nhẹ

---

## Phase 9: Sau MVP

- [ ] T080 [US10] Converge
  - Bước `converge` (prompt, `sdlc_report findings`), liên kết `finding`, vòng tối đa, phát hiện → bước `draft` của tài liệu
    tách việc; hai hướng cho `contradicts`; UI tab Hội tụ trong `item-detail`.
  - **Scope**: `apps/hub/src/modules/sdlc/{converge.ts,converge.db.test.ts}`,
    `packages/contracts/src/sdlc-presets/speckit.ts`, `packages/sdlc-ui/src/converge-panel.tsx`
  - **Phụ thuộc**: T031, T051 · **Mức**: nặng

- [ ] T081 [US11] Release notes và retro
  - Bước `release-notes`, `retro`; đề xuất cho constitution; đóng hạng mục, bình luận issue.
  - **Scope**: `apps/hub/src/modules/sdlc/{release.ts,release.db.test.ts}`, `packages/contracts/src/sdlc-presets/*.ts`
    (thêm giai đoạn release)
  - **Phụ thuộc**: T080 · **Mức**: vừa

- [ ] T082 [US12] Chỉ số và bảng tiến độ đầy đủ
  - `metrics.ts` (lead time theo giai đoạn p50/p90, chờ cổng, trả lại, câu hỏi, độ phủ, converge, vòng review code, chi phí
    qua `cost`), route; `sdlc-ui` `metrics.tsx`; màn app `sdlc-metrics`, web `/sdlc/metrics`. SC-007 với 500 hạng mục.
  - **Scope**: `apps/hub/src/modules/sdlc/{metrics.ts,metrics.test.ts,metrics.db.test.ts}`, `packages/sdlc-ui/src/metrics.tsx`,
    `apps/web/src/pages/sdlc/metrics-page.tsx`, `apps/desktop/src/screens/sdlc-metrics-screen.tsx`
  - **Phụ thuộc**: T031, T054, T055 · **Mức**: vừa

- [ ] T083 [P] Preset và bộ đọc còn lại
  - `aidlc-feature`, `aidlc-enterprise`, `bmad-quick`, `bmad-method`, `kiro-requirements`, `kiro-design`, `kiro-bugfix`,
    `openspec` (+ bước `archive`); bộ đọc `kiro-tasks`, `openspec-tasks`, `bmad-stories`, `aidlc-units`; luật EARS.
  - **Scope**: `packages/contracts/src/sdlc-presets/{aidlc-feature,aidlc-enterprise,bmad-quick,bmad-method,kiro,openspec}.ts`,
    `packages/contracts/src/{breakdown-parsers/*.ts,breakdown-parsers.test.ts}`
  - **Phụ thuộc**: T002, T003 · **Mức**: vừa

- [ ] T084 [P] Trang cấu hình chế độ (web)
  - `sdlc-ui` `mode-editor.tsx` (giai đoạn, tài liệu, cổng dùng lại trình sửa checkpoint của trang Quy trình duyệt, bước,
    chạy thử); trang `/admin/sdlc-modes`; Playwright `sdlc-modes.spec.ts`.
  - **Scope**: `packages/sdlc-ui/src/mode-editor.tsx` + test, `apps/web/src/pages/admin/sdlc-modes-page.tsx`,
    `apps/web/e2e/sdlc-modes.spec.ts`
  - **Phụ thuộc**: T011, T054, T006 · **Mức**: vừa

- [ ] T085 Ngữ cảnh spec cho review code (spec 009)
  - `codereview` nhận deps `specContextFor` cho checkpoint AI; prompt review có requirement và tiêu chí của task.
  - **Scope**: `apps/hub/src/modules/codereview/{ai.ts,prompt.ts}`, `apps/hub/src/main.ts`
  - **Phụ thuộc**: T031, spec 009 T022 · **Mức**: vừa

---

## Phase 10: Tài liệu và hoàn thiện

- [ ] T090 [P] Cập nhật tài liệu: module `sdlc` và luồng trong `docs/architecture.md`, `docs/add.md`, `docs/sdd.md`; trạng
  thái SDLC-xx trong `docs/srs.md`; mục "Máy worker AI SDLC" trong `docs/self-hosting.md` (cài, linger, nhãn, gói);
  `docs/run-permissions.md` (run `sdlc` quyền `workspace`, không đẩy).
  - **Scope**: `docs/{architecture.md,add.md,sdd.md,srs.md,self-hosting.md,run-permissions.md}`
  - **Phụ thuộc**: T070 · **Mức**: nhẹ

- [ ] T091 `/speckit-analyze` trên spec, plan, tasks; xử lý mâu thuẫn; chụp ảnh màn mới (sáng, tối, 360 px).
  - **Scope**: `specs/011-ai-sdlc-mode/*`, `apps/web/e2e/screenshots/**`
  - **Phụ thuộc**: T054, T055 · **Mức**: nhẹ

---

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┬─ T011 ─┐
      ├─ T003 ─┼────────┼─ T014 ───────────────┐
      ├─ T004 ─┼─ T010 ─┼─ T012 ─┬─ T013 ─ T021 ┼─ T031 ─ T070 ─ T072, T090
      │        │        │        ├─ T022 ───────┤
      │        │        │        ├─ T030 (T003) ┘
      │        │        │        ├─ T040 (Q1)
      │        │        │        └─ T071
      │        └─ T060 ─────────────── T062
      ├─ T020, T061
      ├─ T050 (T005) ─ T051 ─ T052 ─┬─ T054 ─┬─ T062, T084, T091
      └─ T053 (T005) ───────────────┴─ T055 ─┘
T005, T006 (không phụ thuộc)
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T005, T006 |
| 2 | T002, T003, T004, T020, T061, T050 |
| 3 | T010, T011, T014, T060, T053, T051 |
| 4 | T012, T052, T083 |
| 5 | T013, T022, T030, T071, T054, T055 |
| 6 | T021, T040 (khi Q1 chốt), T062, T084 |
| 7 | T031 → T070 → T072, T090, T091 |
| 8 | T080 → T081, T082, T085 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002, T003 (file riêng, sau T001) → T083 | `packages/contracts/src/index.ts`, `openapi.json` (chỉ T001) |
| db | T004 | `migrations/**`, các `schema.ts` |
| tasks | T010 | `tasks/tasks.ts`, `tasks/index.ts` |
| knowledge | T014 | `knowledge/reviews.ts`, `review-rules.ts` |
| sdlc-core | T011 → T012 → T013 → T022 → T030 → T031 → T040 → T080 → T081 → T082 | `sdlc/index.ts`, `sdlc/router.ts` (T012 tạo; task sau thêm route bằng hàm đăng ký trong file riêng, T070 gộp) |
| runs | T021 | `runs/engine.ts`, `runs/mcp.ts`, `runs.db.test.ts` |
| fleet | T060 | `fleet/**` |
| worker | T020 → T061 | `worker/internal/channel/**` (T020 chỉ test, T061 sửa protocol) |
| ui-pkg | T050 → T051 → T052 → T062 (phần package) → T084 | `packages/sdlc-ui/**` |
| doc-editor | T053 | `packages/doc-editor/**` |
| web | T054 → T062 → T084 → T091 | `apps/web/src/router.tsx`, `lib/nav.ts`, `e2e/fake-hub.ts` |
| desktop | T055 → T082 (phần app) | `apps/desktop/src/lib/nav.ts`, `screens/index.ts` |
| leader | T071 | `leader/**` |
| wiring-docs | T070 → T072 → T090 | `apps/hub/src/main.ts`, `app.ts`, `docs/**` |
| design | T005, T006 | `docs/design-system/screens/README.md` (T005 sửa; T006 ghi chú bàn giao) |

`sdlc/index.ts` thuộc làn core; task ngoài làn cần export thêm thì ghi vào ghi chú bàn giao để T070 gộp.

## Màn cần thiết kế (T005, T006)

| File | Màn | Story |
|---|---|---|
| `AppSdlcBoard.dc.html` | Bảng hạng mục theo loại giai đoạn + danh sách | US7, US12 |
| `AppSdlcNewItem.dc.html` | Tạo hạng mục, gợi ý cỡ/chế độ | US1 |
| `AppSdlcItem.dc.html` | Chi tiết hạng mục (stepper, tài liệu + đồng bộ, câu hỏi, bước agent, task/đợt, PR, ngoại lệ) | US2–US6 |
| `AppSdlcQuestions.dc.html` | Câu hỏi chờ tôi | US2 |
| `AppSdlcBreakdown.dc.html` | Duyệt bản tách task (đồ thị, đợt, độ phủ) | US5 |
| `AppSdlcTrace.dc.html` | Ma trận truy vết | US9 |
| `AppSdlcMetrics.dc.html` | Tiến độ và chỉ số | US12 |
| `AppNav.dc.html` (biến thể) | Nhóm menu AI SDLC theo hồ sơ dev/writer/lead | US7 |
| `DocEditor.dc.html` (biến thể) | Khung bên "Hạng mục · giai đoạn" | US2, US3 |
| `DocReview.dc.html` (biến thể) | Thẻ câu hỏi đã trả lời, bản tách | US3, US5 |
| `SdlcModes.dc.html` | Cấu hình chế độ (web) | US8 |
| `ProjectSettings.dc.html` (biến thể) | Mục AI SDLC của dự án (web) | US8 |
| `SdlcFleet.dc.html` | Đội máy AI SDLC (web) | US13, US15 |
| `Machines.dc.html` | Máy: nhãn, chỉ nhận run có nhãn, gói (web, bản v2) | US14 |

## Implementation Strategy

- **MVP** 🎯 (AI-DLC Express + Spec Kit + bugfix + small; chặn cứng; tách task; truy vết cơ bản; web và app):
  T001–T005, T010–T014, T020–T022, T030, T031, T050–T055, T070, T072. Đồng bộ repo (T040) vào ngay sau MVP khi Q1 chốt;
  trước đó agent đọc tài liệu qua seed file và MCP.
- **Tăng dần**: T040 (đồng bộ) → T060–T062 (máy AI SDLC) → T083 (preset còn lại) → T084 (cấu hình chế độ) → T080–T082
  (converge, release, chỉ số) → T085 (sau spec 009).
- Mỗi PR chỉ đổi hành vi khi dự án bật `settings.sdlc.enabled` (hoặc khi máy/run có nhãn), nên merge từng phần không ảnh
  hưởng dự án đang chạy.
