# Tasks: Quy trình review code tự động

**Input**: [spec.md](spec.md), [plan.md](plan.md), [ADR 0018](../../docs/adr/0018-code-review-workflows.md)

**Tests**: bắt buộc (feature-checklist mục 5). Mỗi task tự viết test của phần mình và để `pnpm check` xanh.

## Cách đọc

- Dạng: `- [ ] T### [P?] [US?] Mô tả` rồi các dòng **Scope** (file được sửa/tạo, chỉ task đó đụng), **Phụ thuộc**,
  **Mức** (`nặng` → Opus 5.5 `--effort high`; `vừa` → Sonnet 5.5 `--effort high`; `nhẹ` → Sonnet 5.5 `--effort medium`,
  theo CLAUDE.md).
- `[P]`: chạy song song được với các task `[P]` khác **khi phụ thuộc đã xong** (khác file, không chờ nhau).
- Hai task cùng một **làn** (bảng cuối) sửa chung file nên phải làm nối tiếp trong cùng worktree hoặc sau khi task trước
  đã merge.
- `packages/contracts/openapi.json` chỉ T001 sinh lại. Task khác cần đổi contract thì báo người điều phối thêm vào T001
  hoặc mở task contract mới, không tự sửa.
- Migration chỉ T002 sinh (số `0055`). Task khác cần đổi bảng thì làm sau T002 và sinh migration số kế tiếp.

---

## Phase 1: Nền (chặn mọi story)

- [x] T001 Contract cho quy trình Code và phiên review code
  - `workflows.ts`: `workflowSubject`, preset `code-basic|code-strict|code-fast` + `CODE_WORKFLOW_PRESETS`, `ruleCheck`
    thêm `command|max-files|deny-paths|agent-report`, `codeScope`, `codeOptions`, trường checkpoint mới (ai.reviewers,
    aggregate, blockOn, runner; commands, maxFiles, denyPaths; ext.whenNone; reviewers.allowRequester; conditions.paths,
    taskTypes), `workflowInput.subject` (mặc định `doc`) + `code`, `superRefine` theo subject; list nhận `subject`.
  - `code-reviews.ts` mới: schema và route như plan.md (list, count, get, files, decide, override, enqueue, recheck,
    dryRun, workflowFromProject) + hàm thuần `outcomeToCodeWorkflow(settings, projectKey)`.
  - `glob.ts` mới: chuyển nguyên `matchGlob` (kèm test) từ hub.
  - `roles.ts`: lá `reviews.override` (danger) trong nhánh `work`, thêm vào quyền quản trị đội.
  - `notify.ts`: `code_review.awaiting|overdue|returned|approved`.
  - `worker-protocol.ts`: comment mô tả `spec.checks.commands` và `report.commands` (không đổi schema).
  - `index.ts`: gắn `codeReviews`; chạy `pnpm openapi`.
  - Test: `workflows.test.ts` (mới: quy trình tài liệu cũ vẫn parse; quy tắc sai loại bị từ chối; preset hợp lệ),
    `code-reviews.test.ts`, `glob.test.ts`, `roles` snapshot nếu có.
  - **Scope**: `packages/contracts/src/{workflows.ts,code-reviews.ts,glob.ts,roles.ts,notify.ts,worker-protocol.ts,index.ts}`,
    `packages/contracts/src/{workflows,code-reviews,glob}.test.ts`, `packages/contracts/openapi.json`
  - **Phụ thuộc**: không · **Mức**: nặng

- [ ] T002 Bảng và migration
  - `knowledge/schema.ts`: `review_workflows.subject`, `code`, hai CHECK.
  - `codereview/schema.ts` mới: `code_reviews`, `code_review_gate_runs` đúng plan.md (chỉ số, unique một phiên mở mỗi
    PR, `orgScoped`, policy `hive_owner` select).
  - `pnpm --filter @xdev-hive/hub db:generate` → `0055_code_review_workflows.sql`; thêm tay `FORCE ROW LEVEL SECURITY` và
    hàm `hive.code_review_overdue_orgs()` như 0051.
  - `codereview/rls.db.test.ts`; thêm ca nâng cấp vào `migrations-upgrade.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/knowledge/schema.ts`, `apps/hub/src/modules/codereview/schema.ts`,
    `apps/hub/src/modules/codereview/rls.db.test.ts`, `apps/hub/db/migrations/0055_*.sql`, `apps/hub/db/migrations/meta/*`,
    `apps/hub/src/migrations-upgrade.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T003 [P] `GitProvider.prFiles` và `setCommitStatus`
  - GitHub `GET /pulls/{n}/files` (phân trang, tối đa 3 000 file, `patch` có thể thiếu → `truncated`), GitLab
    `GET /merge_requests/{iid}/diffs`; `setCommitStatus(ref, sha, { context, state, description, targetUrl })`.
  - Bản `memory` và `local` cho test; fixture HTTP.
  - **Scope**: `apps/hub/src/modules/scm/{types.ts,github.ts,gitlab.ts,memory.ts,local.ts,index.ts}`,
    `apps/hub/src/modules/scm/{github,gitlab,local}.test.ts`, `apps/hub/src/modules/scm/fixtures/**`
  - **Phụ thuộc**: không · **Mức**: vừa

- [ ] T004 [P] Thiết kế UI hai màn (cấu hình Code, khung review PR) bằng skill `ui-ux-pro-max`, theo design system và
  shadcn/ui; ghi lại thành mô tả component, trạng thái, 360 px, sáng/tối.
  - **Scope**: `docs/design-system/screens/CodeReview.dc.html` (mới), `docs/design-system/screens/Workflows.dc.html`
    (thêm biến thể Code)
  - **Phụ thuộc**: không · **Mức**: vừa

**Checkpoint**: contract, bảng, provider sẵn sàng → các story bắt đầu.

---

## Phase 2: User Story 1 — Cấu hình quy trình Code (P1) 🎯 MVP

- [ ] T010 [US1] `knowledge` nhận quy trình Code
  - `saveWorkflow`, `listWorkflows` theo `subject`; `matchWorkflow` và `dryRunWorkflow` chỉ xét `subject = 'doc'`;
    từ chối CLI/model bị chính sách agent cấm (FR-011, đọc qua `governance/index.ts`).
  - Export qua `index.ts`: `listCodeWorkflows(tx, scope)`, `flatGates`, `slaOf`, `requiredApprovals`, `eligible`.
  - Test trong `reviews.db.test.ts`: quy trình tài liệu cũ không đổi; Code lưu được; quyền `workflows.write`.
  - **Scope**: `apps/hub/src/modules/knowledge/{reviews.ts,review-rules.ts,router.ts,index.ts,reviews.db.test.ts}`
  - **Phụ thuộc**: T001, T002 · **Mức**: vừa

- [ ] T011 [P] [US1] Luật thuần của `codereview`
  - `match.ts`: chọn quy trình theo phạm vi và độ cụ thể (dự án > đội > tổ chức, rồi `updated_at`), trả cả quy trình
    bị lấn.
  - `gates.ts`: điều kiện checkpoint (đường dẫn, loại task, số dòng), quy tắc `max-files`, `deny-paths`, `max-diff`,
    `agent-report`, `command` (từ `report.commands`, thiếu → chờ người), `no-secrets` trên patch, gộp AI `all`/`avg`
    với `blockOn`.
  - **Scope**: `apps/hub/src/modules/codereview/{match.ts,gates.ts,match.test.ts,gates.test.ts}`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T012 [US1] Chạy thử và tạo từ cấu hình dự án (hub)
  - `dry-run.ts` + route `codeReviews.dryRun`, `codeReviews.workflowFromProject`; `router.ts` khởi tạo.
  - Test DB: chạy thử trên run có `diffStats`; dự án bật review chéo → bản nháp đúng.
  - **Scope**: `apps/hub/src/modules/codereview/{dry-run.ts,router.ts,index.ts,dry-run.db.test.ts}`
  - **Phụ thuộc**: T010, T011 · **Mức**: vừa

- [ ] T013 [US1] Web: trang Quy trình duyệt cho Code
  - Hộp chọn Tài liệu/Code khi tạo; nhãn và bộ lọc loại; `workflow-code-config.tsx` (phạm vi, Khi đạt, trường checkpoint
    theo loại); chạy thử chọn run gần đây; nút "Tạo từ cấu hình dự án".
  - Hub giả và Playwright: tạo quy trình Code từ khung mẫu, lỗi quy tắc sai loại, chạy thử, người chỉ đọc; 360 px, tối.
  - **Scope**: `apps/web/src/pages/knowledge/{workflows-page.tsx,workflow-gate-config.tsx,workflow-code-config.tsx}`,
    `apps/web/src/lib/{review-workflows.ts,review-workflows.test.ts}`, `apps/web/e2e/{workflows.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T001, T004 · **Mức**: vừa

**Checkpoint**: quản trị tạo, chạy thử, lưu quy trình Code; chưa có gì chạy khi run kết thúc.

---

## Phase 3: User Story 2 — Checkpoint tự động sau run code (P1)

- [ ] T020 [US2] Máy trạng thái phiên
  - `service.ts`: `matchFor`, `start` (bản chụp, `head_sha`, số liệu, `run_reasons`), `advance` (bỏ qua theo điều kiện,
    `rule`, `ext` qua job, `human` đặt `due_at` + `code_review.awaiting`), `cancel`; khoá `FOR UPDATE`; audit
    `codereview.start|gate|cancel`.
  - `jobs.ts`: queue `codereview` (advance, CI mỗi 2 phút tối đa 60 lần), đăng ký worker.
  - `index.ts`: export `matchFor`, `startCodeReview`, `onReviewRunFinished`, `registerCodeReviewWorker`,
    `type CodeReviewDeps` (gồm `startReviewRuns`, `queueFixRun`, `providerFactory`, `masterKey`, `jobs`, `publicUrl`).
  - Tạo khung `ai.ts` (`startAiGate`, `onReviewRunFinished`: checkpoint AI chờ, chưa gộp) và `merge.ts` (`onApproved`:
    chỉ đổi trạng thái) để `service.ts` gọi; T022 và T050 thay phần thân, không sửa `service.ts`.
  - Test DB: mở phiên từ run giả; quy tắc đạt/không đạt; CI pending → success; tới checkpoint người duyệt; audit.
  - **Scope**: `apps/hub/src/modules/codereview/{service.ts,jobs.ts,index.ts,ai.ts,merge.ts,service.db.test.ts}`
  - **Phụ thuộc**: T002, T011 · **Mức**: nặng

- [ ] T021 [US2] Nối `runs` với `codereview`
  - `verifyCode`: gọi `matchFor`; có quy trình thì đánh giá chính sách bỏ `review` (ghi `skipped` + lý do), không tạo run
    review chéo, không `enqueueMerge`, gọi `startCodeReview` trong transaction kết luận run; không có thì giữ nguyên.
  - `verifyReview`: run review có phiên (tra `run_ids`) thì gọi `onReviewRunFinished` thay vì `verify(parent)`.
  - `engine` expose `startReviewRuns(tx, input)` (run `review`, chủ theo `runner`, `created_by = workflow:<id>`, prompt
    rubric) và `queueFixRun(tx, input)` (`queueRun` với `instructions`, `plan: false`, chủ run gốc).
  - `review.ts`: `reviewPrompt` nhận rubric, đường dẫn trọng tâm; `reviewReportInput.checklist` tuỳ chọn.
  - `policy.ts`: import `matchGlob` từ contracts, re-export.
  - Test: `runs.db.test.ts`, `review.db.test.ts` thêm ca có/không có quy trình; mọi test cũ giữ nguyên (SC-001).
  - **Scope**: `apps/hub/src/modules/runs/{engine.ts,review.ts,policy.ts,mcp.ts,index.ts}`,
    `apps/hub/src/{runs.db.test.ts,review.db.test.ts}`
  - **Phụ thuộc**: T020 · **Mức**: nặng

- [ ] T022 [US2] Checkpoint AI
  - `ai.ts`: tạo một run review mỗi reviewer qua deps, lưu `run_ids`; `onReviewRunFinished` gom kết quả vào `details`,
    gộp theo `gates.ts`, kết luận khi đủ; run review lỗi/huỷ → checkpoint không đạt với lý do; đăng một bình luận tổng
    hợp lên PR (`commentOnIssue`).
  - `prompt.ts`: rubric, `blockOn`, phạm vi đường dẫn.
  - Test DB với engine giả: 2 reviewer `all`/`avg`, `blockOn`, một reviewer lỗi, máy dùng chung vắng (`waiting_machine`).
  - **Scope**: `apps/hub/src/modules/codereview/{ai.ts,prompt.ts,ai.db.test.ts,prompt.test.ts}`
  - **Phụ thuộc**: T020 (T021 cho test tích hợp thật) · **Mức**: nặng

**Checkpoint**: run code xong → phiên chạy hết checkpoint tự động và dừng ở người duyệt.

---

## Phase 4: User Story 3 — "Chờ tôi duyệt" cho PR (P1)

- [ ] T030 [US3] Đọc và quyết định (hub)
  - `queries.ts`: list (scope, status, dự án, SLA, con trỏ), count, get (`canDecide`, `canOverride`, `canEnqueue`),
    files (qua `prFiles`, đệm theo `head_sha` 10 phút).
  - `decide.ts`: approve (quorum), changes (gọi `routing` của T040 qua hàm nội bộ; trước T040 chỉ hướng `author`),
    override (`reviews.override`, ghi chú bắt buộc), enqueue (`merge.enqueue`), recheck; kiểm `headSha`; audit.
  - Gắn route vào `router.ts`. Test DB: quyền (người được chỉ định, người giao việc, quản trị tổ chức), quorum 2, hai
    người quyết đồng thời, `headSha` cũ, SC-003 với 1 000 phiên.
  - **Scope**: `apps/hub/src/modules/codereview/{queries.ts,decide.ts,router.ts,decide.db.test.ts,queries.db.test.ts}`
  - **Phụ thuộc**: T012, T020, T003 · **Mức**: nặng

- [ ] T031 [P] [US3] Package UI `@xdev-hive/code-review`
  - `CodeReviewPane`, `FileDiff` (patch unified, phát hiện gắn dòng, file lớn → link ra PR), `AiResults`, `GateStepper`,
    `DecisionForm` (hướng trả lại, ghi chú bắt buộc khi trả lại, báo `headSha` cũ); chữ nhận qua props/từ điển để web và
    app dùng chung; test component.
  - **Scope**: `packages/code-review/**` (package mới), `pnpm-workspace.yaml` nếu cần, `pnpm-lock.yaml`
  - **Phụ thuộc**: T001, T004 · **Mức**: vừa

- [ ] T032 [US3] Web: tab Code trong "Chờ tôi duyệt"
  - `reviews-page.tsx` hai tab có số đếm (`?tab=code&id=`), `code-reviews-tab.tsx`, `lib/code-reviews.ts`, badge menu.
  - Playwright `code-reviews.spec.ts`: hàng chờ, mở PR, diff, duyệt, trả lại theo ba hướng, người không đủ quyền, 360 px,
    tối; hub giả trả diff 100 file (SC-007).
  - **Scope**: `apps/web/src/pages/knowledge/{reviews-page.tsx,code-reviews-tab.tsx}`,
    `apps/web/src/lib/{code-reviews.ts,code-reviews.test.ts,nav.ts}`, `apps/web/e2e/{code-reviews.spec.ts,fake-hub.ts,code-reviews-fixture.ts}`
  - **Phụ thuộc**: T013 (cùng `fake-hub.ts`), T031 · **Mức**: vừa

- [ ] T033 [P] [US3] Desktop: tab Code trong màn "Chờ tôi duyệt"
  - Dùng `@xdev-hive/code-review`; từ điển vi/en; route `#/reviews/code/<id>`.
  - **Scope**: `apps/desktop/src/screens/{reviews-screen.tsx,reviews-screen.test.tsx}`, `apps/desktop/package.json`
  - **Phụ thuộc**: T031 · **Mức**: vừa

**Checkpoint**: người duyệt thấy và quyết trên web và app.

---

## Phase 5: User Story 4 — Trả lại và vòng mới (P1)

- [ ] T040 [US4] Hướng trả lại, run sửa, vòng
  - `routing.ts`: `agent` (chỉ dẫn ≤ 16 000 ký tự từ ghi chú, phát hiện chặn, đuôi lệnh lỗi; `queueFixRun`; đếm lượt;
    hết lượt/hết ngân sách → `author`), `author` (task `todo`, `code_review.returned`), `previous` (xoá phê duyệt
    checkpoint đó); `supersede` + vòng mới với bản chụp cũ, `resume_gate_index`, `dismissStaleApprovals`.
  - `scm.ts`: handler `push` vào nhánh có phiên mở (SHA khác → vòng mới).
  - Nối `decide.ts` với `routing` (thay chỗ tạm của T030).
  - Test DB: ba hướng, hết lượt, run sửa `no_changes`/`failed`, push ngoài Hive, giữ/bỏ phê duyệt.
  - **Scope**: `apps/hub/src/modules/codereview/{routing.ts,scm.ts,decide.ts,routing.db.test.ts}`
  - **Phụ thuộc**: T030, T021 · **Mức**: nặng

---

## Phase 6: User Story 5 — Vào hàng merge (P2)

- [ ] T050 [US5] Hàng merge tôn trọng phiên
  - `catalog/merge-queue.ts`: `MergeDeps.reviewGate?` → `waiting` "Chờ quy trình duyệt code".
  - `codereview/merge.ts`: `reviewGate`; khi phiên `approved` gọi `enqueueMerge` theo chế độ hiệu lực (FR-027) hoặc gửi
    `code_review.approved`; handler `pull_request.merged|closed` → `merged`/`cancelled`, huỷ run review đang chạy.
  - Test: `merge-queue.db.test.ts` (SC-004), `codereview/merge.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/catalog/merge-queue.ts`, `apps/hub/src/merge-queue.db.test.ts`,
    `apps/hub/src/modules/codereview/{merge.ts,merge.db.test.ts}`
  - **Phụ thuộc**: T020 · **Mức**: vừa

---

## Phase 7: User Story 7 — SLA và quyết thay (P3)

- [ ] T060 [P] [US7] Nhắc hạn checkpoint người duyệt
  - `sla.ts`: job cron 10 phút dùng `hive.code_review_overdue_orgs()`, gửi `code_review.overdue` một lần mỗi lượt chờ.
  - **Scope**: `apps/hub/src/modules/codereview/{sla.ts,sla.db.test.ts}`
  - **Phụ thuộc**: T020 · **Mức**: nhẹ

---

## Phase 8: Nối hub

- [ ] T070 Nối deps, router, job, handler
  - `main.ts`: tạo `CodeReviewDeps` (từ engine: `startReviewRuns`, `queueFixRun`), `registerCodeReviewWorker`, SLA cron,
    handler SCM của `codereview`, `MergeDeps.reviewGate`.
  - `app.ts`: `codeReviews: codeReviewRouter(...)`.
  - `pnpm deps` không có vòng; test khói `app.test.ts`.
  - **Scope**: `apps/hub/src/{main.ts,app.ts,app.test.ts}`
  - **Phụ thuộc**: T021, T022, T030, T040, T050, T060 · **Mức**: vừa

---

## Phase 9: User Story 6 — Tương thích và chuyển đổi (P2)

- [ ] T080 [US6] Cài đặt dự án báo quy trình đang thay review chéo
  - Ghi chú + link quy trình ở mục Review chéo; nút "Tạo quy trình từ cấu hình này" mở trang Quy trình duyệt với bản
    nháp.
  - **Scope**: `apps/web/src/pages/project-settings-page.tsx`, `apps/web/src/lib/{project-settings.ts,project-settings.test.ts}`,
    `apps/web/e2e/projects-runs.spec.ts`
  - **Phụ thuộc**: T013, T012 · **Mức**: nhẹ

- [ ] T081 [US6] Kiểm hồi quy: chạy toàn bộ `pnpm check` và bộ DB test của run, review chéo, hàng merge không sửa test
  cũ; ghi kết quả vào PR (SC-001).
  - **Scope**: không sửa file (chỉ báo cáo)
  - **Phụ thuộc**: T070 · **Mức**: nhẹ

---

## Phase 10: Quy tắc `command` trên worker

- [ ] T090 [P] Worker chạy lệnh kiểm
  - Đọc `spec.checks.commands`; chạy sau khi agent thoát 0, trước khi đẩy, trong worktree hoặc container; env theo
    allowlist; timeout từng lệnh; 200 dòng cuối, che bí mật; `report.commands`. Shell theo OS.
  - `gofmt -l .`, `go vet ./...`, `go test ./...`.
  - **Scope**: `worker/internal/runner/{checks.go,checks_test.go,runner.go}`, `worker/internal/channel/jobs_test.go`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T091 Hub gửi lệnh và đánh giá `command`
  - `buildSpec` thêm `checks.commands` từ quy trình khớp (checkpoint `rule` có `command`) và từ `outcome.command`;
    `evaluatePolicy` đánh giá `command` từ `report.commands` (thiếu → như cũ "chưa hỗ trợ"); cập nhật RUN-07.
  - **Scope**: `apps/hub/src/modules/runs/{engine.ts,policy.ts,policy.test.ts}`, `apps/hub/src/runs.db.test.ts`
  - **Phụ thuộc**: T021 (cùng file), T090 · **Mức**: vừa

---

## Phase 11: Tài liệu và hoàn thiện

- [ ] T100 [P] Cập nhật tài liệu kiến trúc: module `codereview` và luồng trong `docs/architecture.md`, `docs/add.md`,
  `docs/sdd.md`; trạng thái CR-xx, RUN-07 trong `docs/srs.md`; ghi chú ADR 0009 khi `command` chạy thật.
  - **Scope**: `docs/{architecture.md,add.md,sdd.md,srs.md}`, `docs/adr/0009-configurable-outcome-policy.md`
  - **Phụ thuộc**: T070, T091 · **Mức**: nhẹ

- [ ] T101 Commit status `xdev-hive/review` và gợi ý bảo vệ nhánh — **chỉ làm khi Q1 chốt theo đề xuất**.
  - **Scope**: `apps/hub/src/modules/codereview/{status.ts,status.db.test.ts}`, `apps/web/src/pages/project-settings-page.tsx`
  - **Phụ thuộc**: T003, T070, T080 · **Mức**: vừa

- [ ] T102 `/speckit-analyze` trên spec, plan, tasks; xử lý mâu thuẫn; chụp ảnh màn mới (sáng, tối, 360 px).
  - **Scope**: `specs/009-code-review-workflows/*`, `apps/web/e2e/screenshots/**`
  - **Phụ thuộc**: T032, T033 · **Mức**: nhẹ

---

## Phụ thuộc và song song

```text
T001 ──┬─ T002 ─┬─ T010 ─┐
       │        └────────┼─ T011 ─┬─ T012 ─────────────┐
       ├─ T011 ──────────┘        └─ T020 ─┬─ T021 ─┬─ T040 ─┐
       ├─ T013 (cần T004)                  ├─ T022  │        │
       ├─ T031 (cần T004) ─┬─ T032 (cần T013)        │        │
       │                   └─ T033                   │        │
       └─ T090 ─────────────────────── T091 (cần T021)        │
T003 ─────────────────────── T030 (cần T012, T020) ───────────┤
T004                         T050, T060 (cần T020) ───────────┴─ T070 ─ T081, T100
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T003, T004 |
| 2 | T002, T011, T031, T090, T013 (sau T004) |
| 3 | T010, T020, T033, T032 (sau T013, T031) |
| 4 | T012, T021, T022, T050, T060 |
| 5 | T030, T091 (sau T021, T090) |
| 6 | T040, T080 |
| 7 | T070 → T081, T100, T102; T101 khi Q1 chốt |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 | `packages/contracts/**`, `openapi.json` |
| db | T002 | `migrations/**`, `knowledge/schema.ts`, `codereview/schema.ts` |
| knowledge | T010 | `knowledge/reviews.ts`, `knowledge/index.ts` |
| codereview-core | T011 → T020 → T012 → T030 → T040 | `codereview/index.ts`, `codereview/router.ts`, `codereview/decide.ts` |
| codereview-ai | T022 | `codereview/ai.ts` (khung do T020 tạo), `prompt.ts` |
| codereview-merge | T050, T060 | `catalog/merge-queue.ts`, `codereview/merge.ts`, `sla.ts` |
| runs | T021 → T091 | `runs/engine.ts`, `runs/policy.ts`, `runs.db.test.ts` |
| scm | T003 | `scm/**` |
| web | T013 → T032 → T080 | `apps/web/e2e/fake-hub.ts`, `lib/nav.ts` |
| ui-desktop | T004 → T031 → T033 | `packages/code-review/**`, `apps/desktop/**` |
| worker | T090 | `worker/**` |
| wiring-docs | T070 → T081 → T100 → T102 | `apps/hub/src/main.ts`, `app.ts`, `docs/**` |

`codereview/index.ts` thuộc làn core; T022, T050, T060 cần export thêm thì ghi vào ghi chú bàn giao để T070 (hoặc làn
core) gộp, tránh sửa chung một file khi chạy song song.

## Implementation Strategy

- **MVP** (US1 + US2 với `rule`/`ext`/`human` + US3 trên web): T001–T004, T010–T013, T020, T021, T030, T031, T032, T050,
  T070. Không cần worker mới; dự án thử trên một nhánh.
- **Tăng dần**: T022 (AI nhiều reviewer) → T040 (vòng sửa) → T033 (app) → T090/T091 (lệnh kiểm) → T101 (sau Q1).
- Mỗi PR chỉ đổi hành vi khi có quy trình `subject = 'code'` bật, nên merge từng phần không ảnh hưởng dự án đang chạy.
