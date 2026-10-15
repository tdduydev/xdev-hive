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
  (requirement → task → run → PR → merge); luồng đủ trên web và app; hạng mục nhiều dự án ở mức tối thiểu; tự duyệt AI
  và thu hồi; vai trò BA/PO (chi tiết ở "Implementation Strategy").
- Quyết định của PO ngày 2026-10-13 (spec "Clarifications"): Q1 đồng bộ bằng PR mỗi repo; Q2 vai trò `team-ba`; Q3 hạng
  mục nhiều dự án; có tự duyệt AI. Các task dưới đã cập nhật theo plan.md D11, D19–D27.

---

## Phase 1: Nền (chặn mọi story)

- [x] T001 🎯 Contract chế độ AI SDLC
  - `sdlc.ts` mới: `sdlcMethod`, `sdlcPhaseKind`, `sdlcSize`, `sdlcStepAction`, `sdlcBlocking`, `breakdownParser`,
    `repoPathTemplate`, `sdlcArtifactScope`, `contractFormat`, `sdlcArtifact` (`scope`, `repeatable`), `sdlcAutoApprove`,
    `sdlcStep`, `sdlcPhase` (`perProjectGates`, `autoApprove`), `sdlcDecomposition`, `sdlcMode` (`superRefine`: id duy
    nhất, tham chiếu, thư mục cấm, regex biên dịch được, luật tự duyệt FR-056), `projectSdlcSettings` (`autoApprove`),
    `orgSdlcPolicy` + `DEFAULT_SDLC_DENY_PATHS`/`KEYWORDS`, `sdlcItemCreate` (`participants`), `sdlcContractInput`, schema
    item/project tham gia/phase/artifact/sync/question/step/breakdown (task có `project`)/trace (theo dự án)/metrics/
    auto-approval/fleet, lỗi `SDLC_GATE_BLOCKED`, `TASK_DEPENDENCIES_OPEN`, `sdlcContract` đủ route của plan.md (cả
    `items.projects.*`, `contracts.*`, `autoApprovals.*`).
  - Khung rỗng cho T002, T003: `sdlc-presets/index.ts` (`SDLC_PRESETS = {}` có kiểu), `breakdown.ts` (kiểu
    `Breakdown`, `BreakdownTask`, chữ ký hàm, thân `throw`).
  - `tasks.ts` (`checklist`, `dependsOn`, `blockedBy`, `tasks.setDependencies`), `runs.ts` (`runKind` + `sdlc`,
    `requiredLabels`), `fleet.ts` (`machineLabel`, `labels`, `labelsOnly`, `accounts`, route nhãn và gói, mã đăng ký nhận
    `labels`, `shared`, `labelsOnly`), `projects.ts` (`settings.sdlc`), `workflows.ts` (`no-open-questions`, `breakdown`,
    `coverage` vào `DOC_RULE_CHECKS`; `reviewerRole` + `team-ba`; kết quả checkpoint + `auto?`; `reviewers.teamScope`
    nội bộ), `leader.ts` (`sdlc.item.create`), `roles.ts` (`sdlc.read`, `sdlc.write`, `sdlc.override` danger,
    `sdlc.modes.write`; vai trò hệ thống `team-ba` theo FR-061), `tenancy.ts` (`teamRole` + `ba`), `policies.ts`
    (`agentPolicyInput.sdlc`), `notify.ts` (sự kiện `sdlc.*` gồm `project_added`, `auto_approved`, `auto_revoked`),
    `worker-protocol.ts` (`heartbeat.accounts?`, `account_set`, comment cho `spec.sdlc`, `report.artifacts`), `index.ts`;
    `pnpm openapi`.
  - Test: `sdlc.test.ts` (đường dẫn cấm, tham chiếu sai, cài đặt dự án, tự duyệt: cổng không phải human, không có ai
    trước, ngưỡng < passScore, requirements của chế độ nặng), `worker-protocol.test.ts` (heartbeat cũ vẫn parse), roles
    snapshot nếu có, `policies` cũ không có `sdlc` vẫn parse.
  - **Scope**: `packages/contracts/src/{sdlc.ts,sdlc.test.ts,breakdown.ts,sdlc-presets/index.ts,tasks.ts,runs.ts,fleet.ts,projects.ts,workflows.ts,leader.ts,roles.ts,tenancy.ts,policies.ts,notify.ts,worker-protocol.ts,worker-protocol.test.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: không · **Mức**: nặng

- [x] T002 🎯 [P] Preset MVP: `bugfix`, `small`, `aidlc-express`, `speckit`
  - Mỗi preset một file: giai đoạn, tài liệu (đường dẫn như bảng ánh xạ của plan.md), khuôn Markdown ngắn, cổng (dùng
    `reviewPhase`), bước agent với prompt viết lại (không chép nguyên văn Spec Kit/AI-DLC; ghi nguồn tham khảo trong
    comment đầu file), `decomposition`; `perProjectGates`, `autoApprove` và contract theo bảng "Mặc định của preset" của
    plan.md (D21, D23, D26); khuôn `tasks.md` của `speckit` có ví dụ thẻ `[@dự-án]`.
  - Test: mọi preset parse qua `sdlcMode`; đường dẫn sinh đúng cho `{NNN}`, `{slug}`, `{date}` và `<home>-<NNN>` ở repo
    tham gia; khuôn có đủ mục bắt buộc; `speckit` không có `autoApprove` ở Specify.
  - **Scope**: `packages/contracts/src/sdlc-presets/{index.ts,bugfix.ts,small.ts,aidlc-express.ts,speckit.ts,presets.test.ts}`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T003 🎯 [P] Bộ đọc/ghi bản tách task (thuần)
  - `parseBreakdown(markdown, decomposition)` cho `hive-tasks` (định dạng tasks.md của repo này: `T###`, `[P]`, `[USn]`,
    "Phụ thuộc") và `speckit-tasks`; độ mịn `item`, `heading`, `single`; phụ thuộc, phát hiện chu trình, đợt (sắp topo),
    requirement theo regex; thẻ dự án (`[@key]` trên dòng task, dòng "Dự án: key" dưới tiêu đề phần, mặc định dự án chính;
    key ngoài danh sách tham gia → lỗi, D24); danh sách file nêu trong task (cho luật nhạy cảm của tự duyệt); lỗi có số
    dòng tiếng Việt.
  - `writeBreakdown(breakdown, parser)`: ghi lại Markdown; đọc–ghi–đọc giữ nguyên cấu trúc.
  - `coverage(requirements, breakdown)` tổng và theo dự án.
  - Fixture: `tasks.md` của specs/009, mẫu 58 dòng `T###` của app v1 (SC-005: ≤ 12 task hub với `heading`).
  - **Scope**: `packages/contracts/src/{breakdown.ts,breakdown.test.ts}`, `packages/contracts/src/fixtures/breakdown/**`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [x] T004 🎯 Bảng và migration 0058
  - `sdlc/schema.ts` mới (12 bảng như plan.md, gồm `sdlc_item_projects`, `sdlc_artifact_syncs`, `sdlc_auto_approvals`;
    `orgScoped`, policy `hive_owner` select); `tasks/schema.ts` (`checklist`, `task_dependencies`); `runs/schema.ts`
    (`required_labels`, enum `sdlc`); `fleet/schema.ts` (`labels`, `labels_only`, `accounts`, `accounts_at`;
    `registration_tokens` + nhãn, cờ); `tenancy/schema.ts` (`team_role` + `ba`).
  - `pnpm --filter @xdev-hive/hub db:generate` → `0058_ai_sdlc.sql`; thêm tay `FORCE ROW LEVEL SECURITY`, hàm
    `hive.sdlc_active_orgs()`.
  - `sdlc/rls.db.test.ts`; `tasks` RLS cho `task_dependencies`; ca nâng cấp từ 0057 trong `migrations-upgrade.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/sdlc/{schema.ts,rls.db.test.ts}`, `apps/hub/src/modules/tasks/schema.ts`,
    `apps/hub/src/modules/runs/schema.ts`, `apps/hub/src/modules/fleet/schema.ts`,
    `apps/hub/src/modules/tenancy/schema.ts`, `apps/hub/db/migrations/0058_*.sql`,
    `apps/hub/db/migrations/meta/*`, `apps/hub/src/migrations-upgrade.db.test.ts`, `apps/hub/src/modules/tasks/rls.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T005 🎯 [P] Thiết kế màn app (dùng chung web) bằng skill `ui-ux-pro-max`, design system v2, shadcn/ui; mỗi màn có
  trạng thái rỗng/đang chạy/lỗi, 360 px, sáng/tối, chữ vi/en. Gồm phần nhiều dự án (chọn dự án tham gia, tab Dự án, tab
  Contract, làn dự án trong bản tách, độ phủ theo dự án) và tự duyệt (nhãn, điểm, hạn, Thu hồi, "Không tự duyệt: …").
  - **Scope**: `docs/design-system/screens/{AppSdlcBoard,AppSdlcNewItem,AppSdlcItem,AppSdlcQuestions,AppSdlcBreakdown,AppSdlcTrace,AppSdlcMetrics}.dc.html`
    (mới), `docs/design-system/screens/{AppNav,DocEditor,DocReview}.dc.html` (biến thể), `docs/design-system/screens/README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

- [x] T006 [P] Thiết kế màn web cấu hình và quản trị (chế độ có cổng theo dự án, tự duyệt mỗi giai đoạn, contract; mục
  Tự duyệt của dự án; mục AI SDLC của chính sách tổ chức)
  - **Scope**: `docs/design-system/screens/{SdlcModes,SdlcFleet,Machines}.dc.html` (mới),
    `docs/design-system/screens/{ProjectSettings,Policies}.dc.html` (biến thể mục AI SDLC)
  - **Phụ thuộc**: không · **Mức**: vừa

**Checkpoint**: contract, preset MVP, bộ đọc, bảng, thiết kế sẵn sàng.

---

## Phase 2: Lõi hub — chế độ, hạng mục, giai đoạn, cổng (US8, US1, US3, US6) 🎯

- [x] T010 🎯 [P] Task có checklist và phụ thuộc
  - `tasks.ts`: ghi/đọc `checklist`; `setDependencies` (hai đầu cùng tổ chức, được khác dự án — D24; người gọi phải có
    quyền sửa task ở cả hai dự án; tác nhân hệ thống của `sdlc` bỏ qua kiểm quyền người; kiểm chu trình bằng DFS trong
    transaction, khoá advisory theo tổ chức), `blockedBy` trong get/list (kèm key dự án khi khác dự án); audit
    `task.dependencies`; `index.ts` export `setTaskDependencies`, `dependenciesOf`, `updateChecklist`, `createSystemTask`
    nhận `checklist`.
  - Test DB: chu trình bị từ chối (cả chu trình trải hai dự án), phụ thuộc khác dự án được khi có quyền hai bên, bị từ
    chối khi thiếu quyền một bên, xoá task xoá cạnh, list trả `blockedBy`.
  - **Scope**: `apps/hub/src/modules/tasks/{tasks.ts,router.ts,index.ts,dependencies.ts,dependencies.db.test.ts}`
  - **Phụ thuộc**: T004 · **Mức**: vừa

- [x] T011 🎯 [P] [US8] [US1] Chế độ và gợi ý cỡ
  - `modes.ts`: preset + chế độ tự tạo trong phạm vi (đội > tổ chức), lưu (kiểm chính sách agent qua `governance`),
    xoá, chạy thử; `suggest.ts` thuần (nhãn issue, độ dài, từ khoá rủi ro của dự án → cỡ, chế độ cho phép phù hợp).
  - Test: `suggest.test.ts`; `modes.db.test.ts` (preset chỉ đọc, đường dẫn cấm, quyền `sdlc.modes.write`).
  - **Scope**: `apps/hub/src/modules/sdlc/{modes.ts,suggest.ts,suggest.test.ts,modes.db.test.ts}`
  - **Phụ thuộc**: T002, T004 · **Mức**: vừa

- [x] T012 🎯 [US1] [US3] Hạng mục và máy trạng thái giai đoạn
  - `items.ts`: tạo (số `NNN`, slug, chụp chế độ và cài đặt, dòng `sdlc_item_projects` `home`, tài liệu hub theo khuôn,
    `sdlc_artifacts` + `sdlc_artifact_syncs` nguồn, `sdlc_item_phases`), từ issue (chống trùng, bình luận lên issue qua
    `scm`), tạm dừng/tiếp tục/huỷ, đổi chế độ khi chưa có baseline. Bản này chỉ dự án chính; T015 thêm dự án tham gia và
    bộ lọc quyền (thân `access.ts` tối thiểu: thành viên đội dự án chính).
  - `phases.ts`: `advance` (giai đoạn theo cỡ, bước `auto` qua deps `startSdlcRun` — khung gọi, T022 làm thân),
    `onBaseline` (cập nhật tài liệu, giai đoạn `approved`, sang giai đoạn kế), bỏ qua giai đoạn `optional`;
    `workflowFor(docKey)` dựng quy trình từ `phase.gate`.
  - `index.ts`: export `onBaseline`, `workflowFor`, `codeRunGate` (khung, T013 làm thân), `type SdlcDeps`;
    `router.ts`: route modes, suggest, items (create, list, board, get, pause/resume/cancel, skip-phase).
  - `jobs.ts`: queue `sdlc` (advance), đăng ký worker.
  - Test DB: tạo, issue trùng, đường dẫn trùng trong repo (provider memory), giai đoạn theo cỡ, onBaseline 2 tài liệu
    bắt buộc, tài liệu tuỳ chọn không chặn, bỏ qua cần lý do, audit.
  - **Scope**: `apps/hub/src/modules/sdlc/{items.ts,phases.ts,jobs.ts,access.ts,index.ts,router.ts,items.db.test.ts,phases.db.test.ts}`
  - **Phụ thuộc**: T004, T011 · **Mức**: nặng

- [x] T013 🎯 [US6] Cổng chặn run code và ngoại lệ
  - `gate.ts`: `codeRunGate(tx, {taskId, kind})` theo dự án của task (plan.md "Chặn ở engine"): dự án đã bỏ/tắt AI SDLC;
    phụ thuộc chưa `done` ở mọi dự án; tài liệu bắt buộc trước `implementation` có `scope` item, project của dự án đó,
    contract dự án đó cung cấp/dùng; `approval = revoked` coi như chưa có baseline; mức chặn chặt nhất của chế độ và cài
    đặt dự án; ngoại lệ hiệu lực phạm vi task, dự án, hạng mục), `createOverride`, `revokeOverride` (lý do ≥ 10 ký tự,
    hạn, audit, thông báo; quyền `sdlc.override` ở đội của dự án, cả hạng mục cần mọi đội).
  - Route `overrides.create|revoke` trong hàm đăng ký riêng `overrideRoutes` (T070 gộp vào `router.ts`), tránh sửa chung.
  - Test: `gate.test.ts` (thuần, chặt nhất, hết hạn, tập tài liệu theo dự án, `revoked`); `gate.db.test.ts` (chặn/cho qua,
    ngoại lệ task, dự án và hạng mục, thu hồi; hạng mục ba dự án: contract chưa duyệt chặn bên cung cấp và bên dùng, không
    chặn dự án khác).
  - **Scope**: `apps/hub/src/modules/sdlc/{gate.ts,overrides.ts,gate.test.ts,gate.db.test.ts}`
  - **Phụ thuộc**: T010, T015 · **Mức**: nặng

- [x] T014 🎯 [US3] Nối `knowledge` với hạng mục
  - `reviews.ts`: `ReviewDeps.workflowFor?(tx, docKey)` hỏi trước `matchWorkflow` (trong `startReview`, `previewSubmit`);
    `finish` gọi `deps.onBaseline?` trong transaction; hướng `agent` gọi `deps.queueAuthorFix?` khi có (thay task chung);
    `traceOf` dùng `deps.traceFor?` khi có.
  - Hook mới (D21, D22, D25): `reviewers.teamScope` (vai trò của checkpoint tính trong đội đó thay vì đội của tài liệu);
    vai trò `team-ba` được chọn làm người duyệt; `access.ts` hỏi `deps.docAccessFor?(tx, reader, key)` cho đọc và
    `propose` (không mở `manage`); `advance` tới checkpoint `human` gọi `deps.autoDecide?` → ghi quyết định
    `system:ai-auto` với `auto: {score, threshold, approvalId}`, hoặc ghi sự kiện "Không tự duyệt: …"; `startReview`
    nhận `reaffirm` (đạt thì gọi `onBaseline` với cờ `reaffirm`, không tạo phiên bản mới).
  - `review-rules.ts`: `no-open-questions` (dấu `[NEEDS CLARIFICATION` + câu hỏi mở qua deps), `breakdown`, `coverage`
    (dùng `breakdown.ts` của contracts), `requirementsOf(content, regex?)`.
  - Sửa luôn lỗi `saveWorkflow`/`workflowView` bỏ mất `subject`/`code` (reviews.ts:100-104) vì hạng mục cần phân biệt.
  - Test: `review-rules.test.ts` (3 luật mới), `reviews.db.test.ts` (deps có/không có: hành vi cũ giữ nguyên; `teamScope`;
    `autoDecide` đồng ý/từ chối; `reaffirm`), `access` (`docAccessFor` mở đọc/đề xuất, không mở lưu thẳng).
  - **Scope**: `apps/hub/src/modules/knowledge/{reviews.ts,review-rules.ts,review-jobs.ts,editor.ts,access.ts,index.ts,review-rules.test.ts,reviews.db.test.ts,access.db.test.ts}`
  - **Phụ thuộc**: T001, T003 · **Mức**: nặng

- [x] T015 🎯 [US16] Hạng mục nhiều dự án: dự án tham gia, quyền, cổng theo đội
  - `participants.ts`: `items.create` nhận `participants` (≤ 7 + dự án chính; cùng tổ chức; đã bật AI SDLC; chụp cài đặt
    từng dự án); `items.projects.add|remove` (D19: bỏ chỉ khi chưa có task đã chạy, huỷ task `todo`); audit, thông báo
    `sdlc.project_added`.
  - `access.ts` (D22): `visibleItemsWhere(reader)`, `requireProjectWrite(tx, user, projectIds, perm)`, `docAccessFor`;
    thay kiểm quyền tạm của T012 ở mọi route đọc/ghi hiện có; người nhận thông báo lọc qua đây.
  - `phases.ts`: `workflowFor` nhân cổng `perProjectGates` theo đội tham gia (D21), gộp dự án cùng đội, điền `teamScope`.
  - Route `items.projects.*` qua hàm đăng ký riêng.
  - Test: `access.db.test.ts` (SC-013: ba đội; người ngoài không thấy qua list/get/board/questions/trace; ghi thiếu quyền
    một dự án → từ chối cả thao tác), `participants.db.test.ts` (thêm/bỏ, dự án chưa bật, task đã chạy, giới hạn 8),
    `phases.db.test.ts` thêm ca cổng theo đội.
  - **Scope**: `apps/hub/src/modules/sdlc/{participants.ts,access.ts,phases.ts,participants.db.test.ts,access.db.test.ts,phases.db.test.ts}`
  - **Phụ thuộc**: T012, T014 · **Mức**: nặng

- [x] T016 🎯 [US17] Contract liên repo
  - `contracts.ts` (D23): `contracts.create|update` (bên cung cấp, bên dùng thuộc hạng mục; `requireProjectWrite` mọi
    bên), tạo `sdlc_artifacts` `scope = contract` + tài liệu hub + `sdlc_artifact_syncs` (nguồn ở bên cung cấp, bản sao
    ở bên dùng); nhận `sdlc_report contracts` từ T022 (hàm `contractsFromReport`); `workflowFor` thêm checkpoint cho đội
    các bên; cảnh báo khi baseline mới sau khi task bên dùng đã chạy.
  - Test `contracts.db.test.ts`: checkpoint mỗi đội, không tự duyệt (gọi `autoDecide` của T017 khi có, hoặc kiểm cờ
    `scope`), bên dùng bị chặn tới khi baseline (cùng T013), đổi bên dùng sau baseline bị từ chối.
  - **Scope**: `apps/hub/src/modules/sdlc/{contracts.ts,contracts.db.test.ts}`
  - **Phụ thuộc**: T015 · **Mức**: vừa

- [x] T017 🎯 [US18] Tự duyệt AI và thu hồi
  - `autoapprove.ts` (D25, D26): `autoDecide` — thuần (`decide(input) → {approve, reasons}` theo bảng điều kiện của
    plan.md "Tự duyệt") + đọc DB (chính sách tổ chức qua `governance`, cài đặt dự án, điểm checkpoint `ai`, run tác giả
    bản nháp); ghi `sdlc_auto_approvals`, audit `sdlc.auto_approve`, thông báo `sdlc.auto_approved`;
    `autoApprovals.list|revoke` (khoá dòng, hạn, quyền, `approval = revoked`, phiên duyệt lại `reaffirm`, giai đoạn về
    `in_review`, audit, `sdlc.auto_revoked`); `onBaseline` đặt `approval` (`human`, `auto`, `reaffirmed`).
  - `governance/policies.ts`: đọc `policy.sdlc` với mặc định `orgSdlcPolicy`; export `sdlcPolicyOf(tx)`.
  - Test: `autoapprove.test.ts` (SC-014: mỗi điều kiện một ca; ngưỡng hiệu lực; nặng theo cỡ chế độ hoặc hạng mục; từ khoá
    bỏ dấu; glob đường dẫn; reviewer trùng tác giả), `autoapprove.db.test.ts` (tự duyệt → baseline, audit, thông báo;
    thu hồi → phiên mới, `codeRunGate` chặn — SC-015; thu hồi trùng; quá hạn; tổ chức tắt giữa chừng).
  - **Scope**: `apps/hub/src/modules/sdlc/{autoapprove.ts,autoapprove.test.ts,autoapprove.db.test.ts}`,
    `apps/hub/src/modules/governance/{policies.ts,index.ts,policies.db.test.ts}`
  - **Phụ thuộc**: T013, T014 · **Mức**: nặng

- [x] T018 🎯 [P] [US7] Vai trò BA/PO ở hub
  - `tenancy`: thứ hạng `viewer < ba < member < admin` trong `checkTeamRole`; vai trò hệ thống `team-ba` trong danh sách
    vai trò và `effectivePermissions`; mời/đổi vai trò nhận `ba`; tài khoản app trả `ba`; `knowledge` nhận `team-ba` làm
    người duyệt (qua T014).
  - Test: thành viên `ba` tạo hạng mục và duyệt tài liệu được; tạo task, tạo run, quản trị máy bị từ chối; danh sách vai
    trò có "BA/PO".
  - **Scope**: `apps/hub/src/modules/tenancy/{permissions.ts,roles.ts,router.ts,roles.db.test.ts}`
  - **Phụ thuộc**: T004 · **Mức**: vừa

**Checkpoint**: tạo hạng mục (một hoặc nhiều dự án), viết tay tài liệu, duyệt theo giai đoạn và theo đội, contract, tự
duyệt, chặn run code theo dự án — chưa cần worker mới.

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
  - `engine.ts`: `CAPABILITY_KINDS` + `sdlc`; `startSdlcRun(tx, input)` (dự án = dự án chính; chủ theo `runner`,
    `required_labels`, `spec.sdlc.seed/collect`, prompt do `sdlc` truyền vào); run code của task hạng mục lấy nơi chạy,
    nhãn từ cài đặt dự án của task (do `sdlc` truyền qua `startRun`); `verify` → `verifySdlc` gọi `sdlc.onSdlcRunFinished`;
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
  - `prompt.ts`: dựng prompt theo bước (biến `{idea}`, `{artifacts}`, `{answers}`, `{feedback}`, `{constitution}`,
    `{projects}`, skill nếu có), seed và collect của bước; hạng mục nhiều dự án: seed thêm tóm tắt repo tham gia
    (`repo-digest.ts`, FR-066) và contract đã duyệt.
  - `repo-digest.ts`: đọc qua `GitProvider` (`listFiles` 2 cấp, README, manifest gói, contract hiện có), giới hạn 50 000
    ký tự mỗi repo, cache theo SHA đầu nhánh.
  - `questions.ts`: trả lời, "Dùng đề xuất", soạn lại tự động khi đủ, nhắc hạn 3 ngày (cron, `hive.sdlc_active_orgs()`).
  - `mcp-tools.ts`: `sdlc_context` (lọc theo dự án của run, D22), `sdlc_ask` (≤ 5 câu), `sdlc_report` (schema theo
    loại, `contracts` gọi `contractsFromReport` của T016); `runKinds` đúng.
  - Route `items.step`, `questions.list|count|answer` qua hàm đăng ký riêng (đọc qua `visibleItemsWhere`).
  - Test: `prompt.test.ts` (cả tóm tắt repo); `steps.db.test.ts` (run giả: câu hỏi → `awaiting_answers` → trả lời → vòng
    2 → bản nháp; 7 câu bị cắt 5; autoSubmit; không file → failed; `sdlc_report contracts` → bản nháp contract); SC-008
    (thời gian ghi → đọc).
  - **Scope**: `apps/hub/src/modules/sdlc/{steps.ts,prompt.ts,repo-digest.ts,questions.ts,mcp-tools.ts,prompt.test.ts,steps.db.test.ts,questions.db.test.ts}`
  - **Phụ thuộc**: T015, T016 (T021 cho test tích hợp thật) · **Mức**: nặng

**Checkpoint**: agent soạn, hỏi lại, người trả lời, tài liệu vào bản nháp và qua cổng.

---

## Phase 4: Tách task, chạy đợt, truy vết cơ bản (US5, US6, US9) 🎯

- [x] T030 🎯 [US5] Baseline tài liệu tách việc → task hub
  - `breakdown.ts` (hub): `applyBaseline` (tạo task **trong dự án của task** với `checklist`, `dependsOn` (kể cả liên dự
    án, gọi `setTaskDependencies` bằng tác nhân hệ thống), `source = sdlc`, `sdlc_item_tasks.project_id`, liên kết truy vết
    `task`; so bản trước theo khoá lát: tạo, cập nhật task `todo`, huỷ task bỏ còn `todo`, cảnh báo task bỏ đã chạy; đổi
    dự án của task `todo` = huỷ + tạo mới), chế độ `single` (một task, dự án chính); route `breakdown.get|save` (lưu = ghi
    lại Markdown vào bản nháp qua `knowledge`).
  - Test DB: Spec Kit `heading` 3 task; duyệt lại thêm/bỏ; `single` cho bugfix; ba dự án: task đúng dự án, phụ thuộc liên
    dự án; audit `sdlc.breakdown.apply`.
  - **Scope**: `apps/hub/src/modules/sdlc/{breakdown.ts,breakdown.db.test.ts}`
  - **Phụ thuộc**: T010, T015, T003 · **Mức**: nặng

- [ ] T031 🎯 [US6] [US9] Chạy đợt và truy vết cơ bản
  - `waves.ts`: task sẵn sàng (phụ thuộc ở mọi dự án `done`), `maxParallel` **theo dự án**, chạy qua deps `startRun`
    (chủ, `requiredLabels` theo cài đặt dự án của task), chỉ task của dự án người bấm có quyền; tự chạy khi task `done`;
    tạm dừng.
  - `trace.ts`: `onCodeRunSettled` (liên kết `run`, `pr`, `test` từ evidence, có `project_id`), handler
    `pull_request.merged` từ repo của mọi dự án tham gia (liên kết `commit`, `ci` qua `checksFor`, xét đợt kế, giai đoạn
    `implementation` xong khi mọi task của mọi dự án `done`), độ phủ 3 mức tổng và theo dự án, CSV có cột dự án;
    `specContextFor(task)` (gồm contract dự án của task cung cấp/dùng).
  - Route `waves.run`, `trace` qua hàm đăng ký riêng; `registerSdlcScmHandlers`.
  - Test: `trace.test.ts` (SC-006, theo dự án và tổng), `waves.db.test.ts` (đợt 1 → merge → đợt 2, song song 2, tạm
    dừng; ba dự án: merge backend mở task web và mobile, mỗi dự án tự giới hạn song song).
  - **Scope**: `apps/hub/src/modules/sdlc/{waves.ts,trace.ts,scm.ts,trace.test.ts,waves.db.test.ts}`
  - **Phụ thuộc**: T030, T021 · **Mức**: nặng

**Checkpoint**: MVP hub đủ: ý tưởng → tài liệu → bản tách → task → PR → merge, có chặn và truy vết.

---

## Phase 5: Đồng bộ hub ↔ repo (US4, US17) — Q1 đã chốt

- [ ] T040 [US4] [US17] Đồng bộ tài liệu với repo của từng dự án
  - `sync.ts`: job `sdlc-sync(itemId, projectId)` (một job mỗi repo; gộp file của repo; `pr` mặc định: nhánh
    `hive/sdlc/<ref>-<slug>`, PR, commit status `xdev-hive/sdlc` = success, `enqueueMerge` với `runId` null qua deps,
    không review code; `direct`; `off`; trailer `Hive-Sdlc-Item` + `Co-authored-by`; thử lại; `sdlc.sync_failed` cho quản
    trị dự án đó); bản sao contract ở repo bên dùng (dòng đầu "Bản sao…" khi định dạng có comment); `README.md` mục lục ở
    repo không phải dự án chính; job `sdlc-pull` từ `push` (gộp 30 s) và cron 15 phút (so hash cả nguồn và bản sao, bỏ
    commit của hub, tạo đề xuất + phiên duyệt, sửa bản sao → đề xuất cho contract nguồn, `drifted`/`deleted`); `sync`
    route (retry, overwrite-repo theo dự án); nhập thư mục có sẵn (`items.import`).
  - Test DB với provider `memory`: pr/direct/off, lỗi quyền ở một repo không chặn repo khác, ba repo nhận đúng file,
    push sửa một dòng → đề xuất, sửa bản sao contract → đề xuất cho contract, push giống baseline → không, xoá file, không
    có webhook (cron). SC-004 đo thời gian job.
  - **Scope**: `apps/hub/src/modules/sdlc/{sync.ts,import.ts,sync.test.ts,sync.db.test.ts}`
  - **Phụ thuộc**: T015, T016, T014 · **Mức**: nặng

---

## Phase 6: Giao diện dùng chung, web, app (US7, US8) 🎯

- [x] T050 🎯 [P] Package `@xdev-hive/sdlc-ui` — khung, bảng, tạo hạng mục, câu hỏi
  - `env.tsx` (`SdlcEnv`: api, lang, link, can, errorMessage — như `DocEditorEnv`), `text.ts` (vi/en), `item-board.tsx`
    (chip dự án, lọc khớp dự án tham gia), `item-list.tsx`, `new-item.tsx` (gợi ý cỡ/chế độ, issue, `project-picker.tsx`:
    dự án chính + dự án tham gia, chỉ dự án có quyền, báo dự án chưa bật), `questions.tsx`; test component.
  - **Scope**: `packages/sdlc-ui/**` (package mới: `package.json`, `src/{index.ts,env.tsx,text.ts,item-board.tsx,item-list.tsx,new-item.tsx,project-picker.tsx,questions.tsx}`, test),
    `pnpm-workspace.yaml` nếu cần, `pnpm-lock.yaml`
  - **Phụ thuộc**: T001, T005 · **Mức**: vừa
  - Đã làm: thêm `format.ts`, `parts.tsx`, `test-fixtures.tsx`. Contract chưa có route đọc issue nên màn tạo không xem
    trước tiêu đề/nhãn của issue; hub đọc issue khi gợi ý và khi tạo. App chủ còn phải thêm `@source` của package vào CSS.

- [x] T051 🎯 Package `@xdev-hive/sdlc-ui` — chi tiết hạng mục
  - `item-detail.tsx` (tab Tổng quan, Dự án, Tài liệu, Contract, Câu hỏi, Task, Truy vết), `phase-stepper.tsx`,
    `sync-status.tsx` (theo repo), `override-dialog.tsx` (phạm vi task/dự án/hạng mục), `steps-panel.tsx` (bước agent,
    trạng thái máy), `projects-panel.tsx` (đội, thêm/bỏ dự án), `contracts-panel.tsx` (bên cung cấp → bên dùng, duyệt
    từng đội, Thêm contract), `auto-approval.tsx` (nhãn "Tự duyệt bởi AI", điểm/ngưỡng/lý do, hạn, Thu hồi kèm lý do).
  - **Scope**: `packages/sdlc-ui/src/{item-detail.tsx,phase-stepper.tsx,sync-status.tsx,override-dialog.tsx,steps-panel.tsx,projects-panel.tsx,contracts-panel.tsx,auto-approval.tsx}` + test
  - **Phụ thuộc**: T050 · **Mức**: vừa
  - Đã làm: tab Task và Truy vết nhận nội dung qua `renderTasks`/`renderTrace` (T052 điền); mặc định là danh sách task
    theo đợt. "Duyệt từng đội" của contract dẫn tới phiên duyệt (contract chưa trả checkpoint theo đội trong `sdlcArtifactView`).

- [x] T052 🎯 Package `@xdev-hive/sdlc-ui` — duyệt bản tách và truy vết
  - `breakdown-review.tsx` (gộp/tách, sửa phụ thuộc, chuyển mục task ↔ checklist, đổi dự án của task, độ phủ, lỗi đọc),
    `dependency-graph.tsx` (`@xyflow/react`, làn theo dự án, cạnh liên dự án tô riêng, có dạng danh sách cho 360 px),
    `trace-matrix.tsx` (cột dự án, độ phủ tổng và theo dự án, CSV).
  - **Scope**: `packages/sdlc-ui/src/{breakdown-review.tsx,dependency-graph.tsx,trace-matrix.tsx}` + test,
    `packages/sdlc-ui/package.json` (thêm `@xyflow/react`), `pnpm-lock.yaml`
  - **Phụ thuộc**: T051, T003 · **Mức**: vừa
  - Đã làm: thao tác sửa thuần ở `breakdown-edit.ts` (tính lại đợt, từ chối chu trình); tab Task có nút chuyển "Task đã
    tạo" ↔ "Bản tách" (nạp lười), tab Truy vết là `TraceMatrix`. Bản tách xuất ở `@xdev-hive/sdlc-ui/breakdown` để màn
    khác (ReviewPane) không kéo `@xyflow` qua `index.ts`; app chủ cần nạp CSS qua Vite như mọi import CSS.

- [x] T053 [P] `doc-editor`: khung bên "Hạng mục" và thẻ trong ReviewPane
  - Khung bên khi key thuộc `project/<k>/sdlc/…`: giai đoạn, khuôn, mục bắt buộc, câu hỏi đã trả lời, "Nhờ agent soạn
    lại" (gọi `sdlc.items.step` qua `DocEditorEnv` mở rộng tuỳ chọn); ReviewPane thêm thẻ "Câu hỏi đã trả lời", "Bản tách
    task" (nhận component qua props, không import `sdlc-ui`); checkpoint theo đội hiện tên đội và dự án; checkpoint có
    `auto` hiện "Tự duyệt bởi AI · điểm/ngưỡng" và slot nút Thu hồi (qua props); sự kiện "Không tự duyệt: …".
  - **Scope**: `packages/doc-editor/src/{env.tsx,doc-editor.tsx,review-pane.tsx,sdlc-panel.tsx,text.ts}` + test
  - **Phụ thuộc**: T001, T005 · **Mức**: vừa
  - Đã làm: khung bên bật khi app chủ truyền `env.sdlc.itemLink`; ReviewPane nhận `sdlc={{ breakdown, revoke }}`. Tên
    đội và dự án của checkpoint theo đội lấy từ tên cổng hub đặt (`phases.ts`), contract không có trường đội riêng. Sự
    kiện "Không tự duyệt" đọc từ ghi chú cổng có tiền tố đó.

- [x] T054 🎯 Web: luồng AI SDLC và cấu hình dự án
  - Route `/sdlc`, `/sdlc/new`, `/sdlc/questions`, `/sdlc/$project/$number` (+ tab), `lib/sdlc-env.tsx`, menu
    (`lib/nav.ts`), mục AI SDLC trong cài đặt dự án (gồm Tự duyệt: bật, ngưỡng, giai đoạn, hạn thu hồi, từ khoá/đường dẫn
    nhạy cảm), mục AI SDLC trong `/admin/policies` (cho phép tự duyệt, sàn ngưỡng, danh sách nhạy cảm của tổ chức), thẻ bản
    tách và checkpoint tự duyệt trong `reviews-page.tsx`, vai trò BA/PO trong trang thành viên/đội.
  - Hub giả + Playwright `sdlc.spec.ts`: luồng MVP (SC-009), bugfix ≤ 5 thao tác (SC-003), người chỉ đọc, 360 px, tối;
    `sdlc-multi.spec.ts`: ba dự án (SC-016), tự duyệt + thu hồi.
  - **Scope**: `apps/web/src/router.tsx`, `apps/web/src/pages/sdlc/**`, `apps/web/src/pages/project-settings-page.tsx`,
    `apps/web/src/pages/admin/policies-page.tsx`, `apps/web/src/pages/{members-page.tsx,teams-page.tsx}`,
    `apps/web/src/pages/knowledge/reviews-page.tsx`, `apps/web/src/lib/{nav.ts,sdlc-env.tsx,project-settings.ts}`,
    `apps/web/e2e/{sdlc.spec.ts,sdlc-multi.spec.ts,fake-hub.ts,sdlc-fixture.ts}`, `apps/web/package.json`
  - **Phụ thuộc**: T052, T053 · **Mức**: vừa
  - Đã làm: cài đặt dự án ở `pages/project-sdlc-settings.tsx`, hai mục lưu riêng nhưng mỗi lần gửi cả `settings.sdlc`;
    `/admin/policies` bỏ `sdlc` khỏi lần lưu mục khác để hub giữ bản đã lưu; BA/PO chọn được qua `lib/roles.ts`.
    SC-009 đã kiểm qua `sdlc-mvp.spec.ts`: tạo, trả lời, duyệt spec/plan/research và bản tách, chạy đợt, mở PR.
    Quyết định duyệt làm mới cache AI SDLC. Chưa làm: hàng số liệu của mục AI SDLC trong chính sách (contract chưa có).

- [x] T055 🎯 Desktop: nhóm menu AI SDLC và màn
  - `nav.ts`: quyền `sdlc.use` (dev, writer, lead), `sdlc.manage` (lead), nhóm `sdlc` (Hạng mục, Câu hỏi chờ tôi, Tiến
    độ); `account.ts` `profileOf()`: mọi đội là `viewer` hoặc `ba` → `writer` (D27); màn `sdlc-screen.tsx` (bảng + chi tiết + tạo + bản tách + truy vết theo
    hash `#/sdlc/<project>/<NNN>/<tab>`), `sdlc-questions-screen.tsx`; `write-screen.tsx` truyền env mở rộng cho khung bên;
    `reviews-screen.tsx` thẻ bản tách; từ điển vi/en.
  - Test: `nav.test.ts` (menu theo hồ sơ), `account.test.ts` (`ba` → `writer`), `sdlc-screen.test.tsx` (cả hạng mục ba dự
    án, nhãn tự duyệt và thu hồi), `sdlc-questions-screen.test.tsx` (SC-009, SC-016 phần app).
  - **Scope**: `apps/desktop/src/lib/{nav.ts,account.ts,account.test.ts,sdlc-env.tsx,nav.test.ts}`,
    `apps/desktop/src/screens/{index.ts,sdlc-screen.tsx,sdlc-questions-screen.tsx,write-screen.tsx,reviews-screen.tsx}` + test,
    `apps/desktop/package.json`
  - **Phụ thuộc**: T052, T053 · **Mức**: vừa
  - Đã làm: UI dùng chung qua cầu Rust, hash chi tiết/tab, quyền BA theo đội, khung bên và thẻ duyệt; thiếu kết nối
    thì mời kết nối Hive. SC-009 có test qua các màn thật, SC-016 kiểm hạng mục ba dự án và thu hồi. Tiến độ dùng danh
    sách giai đoạn/độ phủ; số liệu tổng hợp chờ T082. Tailwind quét cả package `sdlc-ui` khi dựng app.

---

## Phase 7: Máy worker AI SDLC (US13, US14, US15)

- [x] T060 [P] [US13] [US14] Hub: nhãn máy, mã đăng ký có nhãn, tóm tắt gói, `account_set`
  - `machines.ts` (`setMachineLabels`, audit `machine.labels`), `registration.ts` (nhãn, `shared`, `labelsOnly` từ mã),
    `gateway.ts` (lưu `heartbeat.accounts`, gửi `account_set` khi capability `accounts-remote` + máy `shared`, báo `shared`
    trong `welcome.features`), route nhãn và gói; route `GET /v1/machines/sdlc` đặt ở `fleet/router.ts` (máy có nhãn, run
    `sdlc` và run task hạng mục đang chạy) vì `sdlc` không import `fleet`.
  - Test DB: mã đăng ký mang nhãn; nhãn sai định dạng; máy cá nhân không có `account_set`; heartbeat thiếu `accounts` giữ
    giá trị cũ.
  - **Scope**: `apps/hub/src/modules/fleet/{machines.ts,registration.ts,gateway.ts,router.ts,index.ts,fleet-sdlc.db.test.ts}`
  - **Phụ thuộc**: T004 · **Mức**: vừa
  - Đã làm cùng T063: migration `0060_machine_labels_accounts.sql`, `fleet/sdlc-fleet.ts` (`machines.sdlc`, run lấy qua
    `provideSdlcFleetRuns` cho T070 nối), test ở `apps/hub/src/fleet-accounts.db.test.ts`.

- [x] T061 [P] [US13] [US15] Worker: tóm tắt gói, `account_set`, nhắc linger
  - Heartbeat gửi tóm tắt (không token, nhãn thay email); xử lý `account_set` (khoá file, ghi nguyên tử, chỉ khi hub báo
    `shared`); capability `accounts-remote`; `install.sh` nhắc `loginctl enable-linger` trên Linux.
  - `gofmt -l .`, `go vet ./...`, `go test ./...`.
  - **Scope**: `worker/internal/accounts/{summary.go,summary_test.go,remote.go,remote_test.go}`,
    `worker/internal/channel/{protocol.go,client.go,client_test.go}`, `scripts/install.sh`
  - **Phụ thuộc**: T001 · **Mức**: vừa
  - Đã làm cùng T063; kênh không có `client.go` nên phần nối nằm ở `worker/internal/channel/{accounts.go,accounts_test.go}`.

- [x] T062 [US15] Web: Đội máy AI SDLC và nhãn trên trang Máy
  - `sdlc-ui` `fleet-table.tsx`; trang `/sdlc/fleet` (Thêm máy = mã đăng ký có nhãn, lệnh cài một dòng cho Linux/macOS/
    Windows); trang `/machines` thêm nhãn, "chỉ nhận run có nhãn", gói; Playwright `sdlc-fleet.spec.ts`.
  - **Scope**: `packages/sdlc-ui/src/fleet-table.tsx` + test, `apps/web/src/pages/sdlc/fleet-page.tsx`,
    `apps/web/src/pages/machines-page.tsx`, `apps/web/e2e/sdlc-fleet.spec.ts`
  - **Phụ thuộc**: T060, T054, T006 · **Mức**: vừa
  - Đã làm: `/sdlc/fleet`, lọc đội, run/quota, bật/tắt gói theo quyền hub trả; thêm máy dùng chung có nhãn `sdlc`,
    cờ chỉ nhận run có nhãn và lệnh cài cho ba hệ điều hành. Trang Máy sửa nhãn/cờ qua menu phụ. Vitest và Playwright
    kiểm quyền chỉ đọc, tải lỗi/thử lại, thao tác ghi, 360 px sáng/tối.

- [x] T063 [US15] Đăng nhập gói từ web (Claude Code, Codex) cho máy dùng chung không màn hình (FR-062)
  - Giao thức: `account_login_start|input|cancel` (hub → worker), `account_login_event { kind: url|code|prompt|done|error }`
    (worker → hub), cùng điều kiện `accounts-remote` + máy `shared` như `account_set`; tối đa một phiên/máy, 10 phút.
  - Worker: gói dở (`pending`) với thư mục cấu hình mới; `claude auth login [--sso|--console]` hoặc `codex login
    --device-auth` trong PTY (`creack/pty`; Windows báo chưa hỗ trợ); chỉ gửi URL, mã thiết bị, lời nhắc cố định; dán
    token `claude setup-token` ghi file 0600 + `CLAUDE_CODE_OAUTH_TOKEN`; huỷ/lỗi/hết hạn/khởi động lại xoá gói dở.
  - Hub: phiên trong bộ nhớ, không lưu mã/URL/token; route `machines.accounts.{list,loginStart,loginGet,loginInput,
    loginCancel}`, `machines.setAccount`; chỉ quản trị đội sở hữu máy hoặc quản trị tổ chức; audit
    `machine.account_login.*` không có mã. Web hỏi `loginGet` mỗi 1,5 giây (không thêm kênh đẩy).
  - Web: nút "Gói agent" ở trang Máy mở hộp thoại: danh sách gói (đăng nhập, quota phiên/tuần, bật/tắt), "Thêm gói" theo
    bước; vi/en, 360 px. Thiết kế: biến thể Gói agent trong `docs/design-system/screens/Machines.dc.html`.
  - **Scope**: `packages/contracts/src/{worker-protocol.ts,fleet.ts}`, `packages/contracts/fixtures/worker-protocol.json`,
    `apps/hub/src/modules/fleet/accounts.ts`, `apps/hub/src/fleet-accounts.db.test.ts`,
    `worker/internal/accounts/{login.go,login_test.go,pty_unix.go,pty_windows.go,remote.go}`,
    `worker/internal/channel/accounts.go`, `apps/web/src/pages/machine-accounts.tsx`,
    `apps/web/e2e/machine-accounts.spec.ts`, `docs/design-system/screens/Machines.dc.html`
  - **Phụ thuộc**: T060, T061 · **Mức**: nặng

---

## Phase 8: Nối hub

- [ ] T070 🎯 Nối deps, router, job, handler
  - `main.ts`: `SdlcDeps` (từ engine: `startSdlcRun`, `startRun`; từ catalog: `enqueueMerge`; `providerFactory`,
    `masterKey`, `jobs`), `ReviewDeps.workflowFor/onBaseline/queueAuthorFix/traceFor/autoDecide`, `KnowledgeDeps.docAccessFor`,
    `registerSdlcWorker`, cron câu hỏi và quét đồng bộ, `registerSdlcScmHandlers`, MCP tools của `sdlc`.
  - `app.ts`: `sdlc: sdlcRouter(...)`.
  - `pnpm deps` không có vòng; test khói `app.test.ts`.
  - **Scope**: `apps/hub/src/{main.ts,app.ts,app.test.ts}`, `apps/hub/src/modules/sdlc/router.ts` (gộp các hàm đăng ký route)
  - **Phụ thuộc**: T013, T016, T017, T018, T021, T022, T031 (T040, T060 khi có) · **Mức**: vừa

- [x] T071 [P] Leader: hành động `sdlc.item.create`
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
    tách việc; hai hướng cho `contradicts`; UI tab Hội tụ trong `item-detail`. Hạng mục nhiều dự án: một run `converge`
    mỗi dự án (repo của dự án, máy của đội đó), gộp phát hiện; phát hiện gắn `project_id`.
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
    qua `cost`, tỉ lệ tự duyệt và thu hồi theo chế độ/dự án/người tạo; lọc theo dự án gồm dự án tham gia), route; `sdlc-ui` `metrics.tsx`; màn app `sdlc-metrics`, web `/sdlc/metrics`. SC-007 với 500 hạng mục.
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
  - `sdlc-ui` `mode-editor.tsx` (giai đoạn, tài liệu có phạm vi item/project/contract, cổng dùng lại trình sửa checkpoint
    của trang Quy trình duyệt, cổng theo dự án, tự duyệt mỗi giai đoạn với lỗi FR-056 hiện tại chỗ, bước, chạy thử); trang
    `/admin/sdlc-modes`; Playwright `sdlc-modes.spec.ts`.
  - **Scope**: `packages/sdlc-ui/src/mode-editor.tsx` + test, `apps/web/src/pages/admin/sdlc-modes-page.tsx`,
    `apps/web/e2e/sdlc-modes.spec.ts`
  - **Phụ thuộc**: T011, T054, T006 · **Mức**: vừa

- [ ] T085 Ngữ cảnh spec cho review code (spec 009)
  - `codereview` nhận deps `specContextFor` cho checkpoint AI; prompt review có requirement và tiêu chí của task.
  - **Scope**: `apps/hub/src/modules/codereview/{ai.ts,prompt.ts}`, `apps/hub/src/main.ts`
  - **Phụ thuộc**: T031, spec 009 T022 · **Mức**: vừa

- [ ] T086 [US16] Run soạn checkout nhiều repo
  - Hub: `spec.sdlc.repos?: [{ projectKey, cloneUrl, branch, dir }]` cho run `sdlc` của hạng mục nhiều dự án (chỉ repo
    mà máy của đội chủ trì được phép đọc theo kết nối Git của dự án đó; không được thì giữ tóm tắt repo như MVP).
  - Worker: checkout nông (depth 1), chỉ đọc, vào `.hive/repos/<key>/` trong worktree tạm; không đẩy; dọn cùng worktree;
    giới hạn kích thước; capability `sdlc-multirepo`.
  - Test: Go (checkout, chỉ đọc, dọn, giới hạn), hub DB (máy không có capability → dùng tóm tắt).
  - **Scope**: `worker/internal/runner/{sdlc_repos.go,sdlc_repos_test.go}`, `apps/hub/src/modules/sdlc/{prompt.ts,steps.ts}`,
    `apps/hub/src/modules/runs/engine.ts` (phần `spec.sdlc`)
  - **Phụ thuộc**: T020, T022, T070 · **Mức**: nặng

---

## Phase 10: Tài liệu và hoàn thiện

- [ ] T090 [P] Cập nhật tài liệu: module `sdlc` và luồng trong `docs/architecture.md`, `docs/add.md`, `docs/sdd.md`; trạng
  thái SDLC-xx trong `docs/srs.md`; mục "Máy worker AI SDLC" trong `docs/self-hosting.md` (cài, linger, nhãn, gói);
  `docs/run-permissions.md` (run `sdlc` quyền `workspace`, không đẩy); hạng mục nhiều dự án, tự duyệt và vai trò BA/PO
  trong tài liệu người dùng.
  - **Scope**: `docs/{architecture.md,add.md,sdd.md,srs.md,self-hosting.md,run-permissions.md}`
  - **Phụ thuộc**: T070 · **Mức**: nhẹ

- [ ] T091 `/speckit-analyze` trên spec, plan, tasks; xử lý mâu thuẫn; chụp ảnh màn mới (sáng, tối, 360 px).
  - **Scope**: `specs/011-ai-sdlc-mode/*`, `apps/web/e2e/screenshots/**`
  - **Phụ thuộc**: T054, T055 · **Mức**: nhẹ

---

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┬─ T011 ─┐
      ├─ T003 ─┼────────┼─ T014 ──────────────────────────────┐
      ├─ T004 ─┼─ T010 ─┼─ T012 ─ T015 ─┬─ T013 ─┬─ T021 ──────┼─ T031 ─ T070 ─ T072, T090, T086
      │        │        │               │        └─ T017 (T014)─┤
      │        │        │               ├─ T016 ─┬─ T022 ───────┤
      │        │        │               │        └─ T040        │
      │        │        │               ├─ T030 (T010, T003) ───┘
      │        │        │               └─ T071 (T012)
      │        ├─ T018                                          (T018 → T070)
      │        └─ T060 ───────────────────────── T062
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
| 3 | T010, T011, T014, T018, T060, T053 |
| 4 | T012, T051, T083 |
| 5 | T015, T052, T071 |
| 6 | T013, T016, T030, T054, T055 |
| 7 | T017, T021, T022, T040, T062, T084 |
| 8 | T031 → T070 → T072, T090, T091 |
| 9 | T080 → T081, T082, T085, T086 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002, T003 (file riêng, sau T001) → T083 | `packages/contracts/src/index.ts`, `openapi.json` (chỉ T001) |
| db | T004 | `migrations/**`, các `schema.ts` |
| tasks | T010 | `tasks/tasks.ts`, `tasks/index.ts` |
| knowledge | T014 | `knowledge/reviews.ts`, `review-rules.ts`, `access.ts` |
| sdlc-core | T011 → T012 → T015 → T013 → T016 → T017 → T022 → T030 → T031 → T040 → T080 → T081 → T082 → T086 (phần hub) | `sdlc/index.ts`, `sdlc/router.ts` (T012 tạo; task sau thêm route bằng hàm đăng ký trong file riêng, T070 gộp), `sdlc/phases.ts` (T012, T015), `sdlc/access.ts` (T012 khung, T015 thân), `sdlc/prompt.ts` (T022, T086) |
| tenancy | T018 | `tenancy/**` |
| governance | T017 (phần policy) | `governance/policies.ts`, `governance/index.ts` |
| runs | T021 → T086 (phần `spec.sdlc`) | `runs/engine.ts`, `runs/mcp.ts`, `runs.db.test.ts` |
| fleet | T060 → T063 | `fleet/**` |
| worker | T020 → T061 → T063 → T086 | `worker/internal/channel/**` (T020 chỉ test, T061 sửa protocol), `worker/internal/runner/**` (T020, T086) |
| ui-pkg | T050 → T051 → T052 → T062 (phần package) → T084 | `packages/sdlc-ui/**` |
| doc-editor | T053 | `packages/doc-editor/**` |
| web | T054 → T062 → T084 → T091 | `apps/web/src/router.tsx`, `lib/nav.ts`, `e2e/fake-hub.ts`, `pages/admin/policies-page.tsx` |
| desktop | T055 → T082 (phần app) | `apps/desktop/src/lib/nav.ts`, `screens/index.ts` |
| leader | T071 | `leader/**` |
| wiring-docs | T070 → T072 → T090 | `apps/hub/src/main.ts`, `app.ts`, `docs/**` |
| design | T005, T006 | `docs/design-system/screens/README.md` (T005 sửa; T006 ghi chú bàn giao) |

`sdlc/index.ts` thuộc làn core; task ngoài làn cần export thêm thì ghi vào ghi chú bàn giao để T070 gộp.

## Màn cần thiết kế (T005, T006)

| File | Màn | Story |
|---|---|---|
| `AppSdlcBoard.dc.html` | Bảng hạng mục theo loại giai đoạn + danh sách, chip dự án | US7, US12, US16 |
| `AppSdlcNewItem.dc.html` | Tạo hạng mục, chọn dự án tham gia, gợi ý cỡ/chế độ | US1, US16 |
| `AppSdlcItem.dc.html` | Chi tiết hạng mục (stepper, dự án, tài liệu + đồng bộ theo repo, contract, câu hỏi, bước agent, task/đợt theo dự án, PR, ngoại lệ, tự duyệt + thu hồi) | US2–US6, US16–US18 |
| `AppSdlcQuestions.dc.html` | Câu hỏi chờ tôi | US2 |
| `AppSdlcBreakdown.dc.html` | Duyệt bản tách task (đồ thị theo làn dự án, đợt, độ phủ) | US5, US16 |
| `AppSdlcTrace.dc.html` | Ma trận truy vết, độ phủ tổng và theo dự án | US9, US16 |
| `AppSdlcMetrics.dc.html` | Tiến độ và chỉ số (cả tỉ lệ tự duyệt/thu hồi) | US12, US18 |
| `AppNav.dc.html` (biến thể) | Nhóm menu AI SDLC theo hồ sơ dev/writer (cả BA/PO)/lead | US7 |
| `DocEditor.dc.html` (biến thể) | Khung bên "Hạng mục · giai đoạn" | US2, US3 |
| `DocReview.dc.html` (biến thể) | Thẻ câu hỏi đã trả lời, bản tách; checkpoint theo đội; checkpoint tự duyệt | US3, US5, US16, US18 |
| `SdlcModes.dc.html` | Cấu hình chế độ: cổng theo dự án, tự duyệt, contract (web) | US8, US18 |
| `ProjectSettings.dc.html` (biến thể) | Mục AI SDLC của dự án, gồm Tự duyệt (web) | US8, US18 |
| `Policies.dc.html` (biến thể) | Mục AI SDLC của chính sách tổ chức (web) | US18 |
| `SdlcFleet.dc.html` | Đội máy AI SDLC (web) | US13, US15 |
| `Machines.dc.html` | Máy: nhãn, chỉ nhận run có nhãn, gói (web, bản v2) | US14 |

## Implementation Strategy

- **MVP** 🎯 (AI-DLC Express + Spec Kit + bugfix + small; chặn cứng; tách task; truy vết cơ bản; web và app; nhiều dự
  án tối thiểu; tự duyệt; BA/PO): T001–T005, T010–T018, T020–T022, T030, T031, T050–T055, T070, T072.
- **Nhiều dự án trong MVP — mức tối thiểu** (PO chốt Q3 "ngay bản này"; người soạn chọn ranh giới):
  - Có: danh sách dự án tham gia khi tạo và thêm/bỏ sau (T015); bộ lọc quyền theo đội và kiểm quyền từng dự án (T015);
    tài liệu chung ở dự án chính, thành viên đội tham gia đọc và đề xuất được (T014, T015); cổng theo đội (T015); task
    gắn dự án và DAG liên dự án (T003, T010, T030); chặn, ngoại lệ, đợt theo dự án (T013, T031); contract liên repo trên
    hub với cổng mỗi đội và chặn bên dùng (T016); tóm tắt repo tham gia cho agent soạn (T022); truy vết và độ phủ theo
    dự án (T031); UI chọn dự án, tab Dự án, Contract, làn dự án (T050–T052).
  - Sau MVP: ghi tài liệu, bản sao contract và README mục lục vào nhiều repo (T040 — cả đồng bộ một repo cũng sau MVP như
    bản trước); run soạn checkout nhiều repo (T086); converge theo dự án (T080); chỉ số theo dự án ngoài độ phủ (T082).
  - Lý do: phần trong MVP là phần làm đổi mô hình dữ liệu và quyền — để sau thì phải chuyển dữ liệu và sửa mọi route.
    Phần để sau chỉ thêm job/worker trên mô hình đã có; trước khi có, agent đọc tài liệu và contract qua seed file.
- **Tự duyệt trong MVP**: T017 (hub), hiển thị và thu hồi (T051, T053, T054, T055), cấu hình dự án và tổ chức (T054);
  preset mang mặc định (T002). Trình sửa chế độ (T084) để sau: trước đó chỉ preset và chế độ nhân bản qua API.
- **Tăng dần**: T040 (đồng bộ nhiều repo) → T060–T062 (máy AI SDLC) → T083 (preset còn lại) → T084 (cấu hình chế độ) →
  T080–T082 (converge, release, chỉ số) → T086 (checkout nhiều repo) → T085 (sau spec 009).
- Mỗi PR chỉ đổi hành vi khi dự án bật `settings.sdlc.enabled` (hoặc khi máy/run có nhãn), nên merge từng phần không ảnh
  hưởng dự án đang chạy.
