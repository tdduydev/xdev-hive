---
description: "Task list: quản lý kiểm thử cấp dự án, vai trò Tester, thư viện test case, kết quả CI và dashboard"
---

# Tasks: Quản lý kiểm thử cấp dự án

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

**Định dạng**: `- [ ] T### [P?] [USn?] <Luồng> — mô tả (file)`.

- **Luồng**:

  | Luồng | Phạm vi |
  |---|---|
  | **C** | contracts: `packages/contracts/src/testing.ts`, `test-library.ts`, `roles.ts`, `delivery-worker.ts`, `openapi.json` |
  | **H** | hub: `apps/hub/src/modules/qa/**`, phần sửa ở `tenancy`, `knowledge`, `docsync`, `audit`, `artifacts`, `sdlc`, `main.ts`, `app.ts`, migration |
  | **W** | worker Go: `worker/internal/testreport/**`, `worker/internal/delivery/**` |
  | **U** | web: `apps/web/src/**`, `apps/web/e2e/**` |
  | **D** | tài liệu: `docs/**`, `specs/036-test-management/**` |
  | **G** | cổng: chờ task của specs/032 vào `main`, rồi nối phần 036 cần ở `delivery` |

- **Mỗi task kèm test trong cùng commit.**
- **Chữ tiếng Việt** (FR-073): chữ giao diện, thông báo lỗi, mẫu file khu.
- **Kiểm theo loại**:
  - Contracts và hub: vitest file liên quan, biome, typecheck, `pnpm deps`. Test `*.db.test.ts` cần Docker (AGENTS.md).
  - Web: vitest file liên quan, biome, typecheck, Playwright spec liên quan. Trang có hai bảng chữ (tiếng Việt, tiếng
    Anh, ví dụ `admin/policies-page.tsx`) thì thêm chữ vào cả hai bảng.
  - Go, trong `worker/`: `gofmt -l .`, `go vet ./...`, `GOOS=windows go vet ./...`, `go test ./internal/testreport/...
    ./internal/delivery/...`. Máy dev Windows hiện không có Go; CI kiểm.
  - Đổi `packages/contracts`: chạy `pnpm openapi`, commit `openapi.json`.
- **Migration**: sinh tại máy để chạy test DB, không commit giữa chừng. Mỗi PR sinh lại và commit migration của mình ở
  task cuối của PR, sau `git merge origin/main`. Enum `tester` là migration riêng, đứng trước migration bảng `qa_*`.
- **Route**: mỗi nhóm route một file `apps/hub/src/modules/qa/routes/<nhóm>.ts`, `qa/router.ts` ghép các nhóm, theo
  cách của `delivery/routes/` và `docsync/routes/`.
- **Mặc định Q1–Q3** (spec.md): worker đọc báo cáo test của GitLab, hub không gọi GitLab; thư viện tách khỏi specs/035,
  không sửa `qa.ts`, dùng lại `qaPriority`; không lưu thông báo lỗi, dashboard liên kết tới job GitLab.
- **MVP** = Phase 1, Phase 2, US1, US2.

---

## Phase 1: Chuẩn bị

- [x] T001 [P] D — ADR 0038 cho D2 (định dạng file khu), D3 (hook lưu tài liệu), D4 (quyền lưu theo thư mục). Ghi
  phương án đã loại ở mục Complexity Tracking của plan.md. Thêm một dòng vào bảng ADR
  (`docs/adr/0038-tc-markdown-and-doc-hooks.md`, `docs/adr/README.md`)
  Số 0038 đã dùng cho `0038-local-secrets-keyring.md` trên `main`, nên ADR là `0039-tc-markdown-and-doc-hooks.md`.
- [x] T002 [P] H — Khung module `qa`: `index.ts` chưa export gì, `schema.ts` rỗng. Không sửa `.dependency-cruiser.cjs`
  và `apps/hub/drizzle.config.ts`: cả hai đã nhận mọi `src/modules/*`. `pnpm deps` và typecheck phải qua
  (`apps/hub/src/modules/qa/index.ts`, `apps/hub/src/modules/qa/schema.ts`)

---

## Phase 2: Nền

Chặn mọi story. Không có nhãn story.

- [x] T003 C — `testing.ts`: hằng D11 (`QA_READ_WAIT_HOURS` 24, `QA_REFETCH_DAYS` 7, `QA_BACKFILL_PIPELINES` 20,
  `QA_TREND_DAYS` 90, `QA_FLAKY_WINDOW` 10, `QA_FLAKY_FLIPS` 3, `QA_UNKNOWN_CODES_MAX` 200, `QA_NOTE_MAX` 500,
  `QA_LINKS_MAX` 5, `QA_RETENTION_DAYS_DEFAULT` 365, `QA_RETENTION_DAYS_MIN` 90); enum trạng thái CI
  (`passed`, `flaky`, `failed`, `skipped`), trạng thái tay (`passed`, `failed`, `untested`, `not-applicable`,
  `deferred`, `other`), trạng thái TC (`active`, `retired`), trạng thái đọc (`waiting`, `reading`, `done`,
  `no-report`, `error`, `expired`); `testCaseKind` (`automated`, `manual`, `planned`); regex mã khu
  `^[A-Z][A-Z0-9]{1,15}$`, mã TC `^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$`, mã yêu cầu D10: mã spec
  `^(\d{3}/)?(FR|AC|NFR|US)-\d{3,4}(\.\d+)?$` hoặc mã SRS `^(?!(FR|AC|NFR|US)(\d|$))[A-Z][A-Z0-9]{2,15}$`;
  `QA_ERRORS` đủ 12 mã và thông báo ở contracts/hub-api.md; nhãn tiếng Việt của trạng thái ở data-model.md. Dùng lại
  `qaPriority` của `qa.ts`, không sửa `qa.ts`. Thêm `export *` ở `index.ts`
  (`packages/contracts/src/testing.ts`, `testing.test.ts`, `index.ts`)
- [x] T004 C — `testingContract` đủ route của contracts/hub-api.md: `settings`, `projectSettings`, `areas`, `cases`,
  `sources`, `rounds` (gồm `export`), `myWork`, `dashboard`. Mọi route là `orgRoute` dưới `/v1/testing/...`. Phân trang
  `cursor` tối đa 2000, `limit` 1–100, mặc định 20. Thêm `testing: testingContract` vào object contract. Chạy
  `pnpm openapi` (`packages/contracts/src/testing.ts`, `testing.test.ts`, `index.ts`, `packages/contracts/openapi.json`)
- [x] T005 [P] C — Quyền `qa.read`, `qa.cases.write`, `qa.record`, `qa.rounds.manage` ở nhánh `testing` nhãn
  "Kiểm thử" (FR-010). Vai trò `team-tester` trong `systemRoleId`, tập `TEAM_TESTER` liệt kê đủ quyền như `TEAM_BA`
  (FR-012). Gán quyền cho vai trò có sẵn theo FR-014 và research.md D5. Test: `team-tester` không có quyền nào ở
  FR-013 (`packages/contracts/src/roles.ts`, `roles.test.ts`)
- [ ] T006 [P] C, W — `test-report` vào `DELIVERY_JOB_KINDS`, không vào `DELIVERY_METHODS`. Khả năng `kinds` mặc định
  `[]` nếu specs/032 T020 chưa thêm. `params` là union theo `op`:
  - `read`: `projectPath` `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$` (1–255), `pipelineId` ≥ 1, `mode`, `jobFilter`
    tối đa 20 mục, mỗi mục tối đa 100, `artifactPath` tối đa 255;
  - `list`: `ref?`, `updatedAfter?`, `limit` 1–500.

  Sự kiện strict `test-results` (`cases` tối đa 5000, `unknownCodes` tối đa 200, `jobIds` tối đa 100, `retries`
  0–20) và `pipelines` (`items` tối đa 100). Mã `finished`: `no_report`, `report_too_large`, `report_invalid`,
  `gitlab_auth`, `gitlab_not_found`, `gitlab_unreachable`, `unsupported`, `runner_offline`. Test: sự kiện có trường
  `name` hoặc `message` bị từ chối (SC-003). Sửa kiểu Go `JobSpec`, `Event` cùng commit. Không sửa
  `fixtures/worker-protocol.json` (`packages/contracts/src/delivery-worker.ts`, `delivery-worker.test.ts`,
  `worker/internal/delivery/executor.go`)
- [x] T007 H — Enum `team_role` thêm `tester`. `TEAM_SYSTEM_ROLE.tester = "team-tester"`. `TEAM_RANK.tester = 2` ở cả
  ba chỗ. Nhãn "Tester" ở `TEAM_LABEL`, `knowledge/reviews.ts`, `knowledge/editor.ts`, `TEAM_ROLE_ID` của
  `sdlc/access.ts`. Test: `permissions.db.test.ts`, `roles.db.test.ts` thêm ca `tester`. Sau T005
  (`apps/hub/src/modules/tenancy/schema.ts`, `tenancy/roles.ts`, `tenancy/permissions.ts`, `artifacts/access.ts`,
  `artifacts/service.ts`, `knowledge/reviews.ts`, `knowledge/editor.ts`, `sdlc/access.ts`,
  `tenancy/permissions.db.test.ts`, `tenancy/roles.db.test.ts`)
- [x] T008 H — Bảng thư viện. Quy tắc chung của data-model.md (FR-071): `org_id uuid not null`, `orgScoped(<tên bảng>)`,
  `.enableRLS()`, FK con `(parent_id, org_id) → (id, org_id)`, bảng cha có `unique("<bảng>_id_org")`. FK tới
  `projects`, `docs`, `users` chỉ viết trong migration tay (T019). Ràng buộc:
  - `qa_settings`: `retention_days int not null default 365`, check `BETWEEN 90 AND 3650`; policy như
    `audit_settings` (`_select`, `_insert`, `_update` cho `hive_app`, `_owner_select` cho `hive_owner`);
  - `qa_project_settings`: `enabled bool not null default false`, `tc_dir text not null default 'test-cases/'`,
    "`tc_dir` là đường dẫn tương đối, kết thúc bằng `/`, không chứa `..`, tối đa 200 ký tự.";
  - `qa_areas`: `code` `^[A-Z][A-Z0-9]{1,15}$`, `doc_id` "FK `(doc_id, org_id) → docs ON DELETE SET NULL (doc_id)`
    (Postgres 15+)", `parse_errors jsonb not null default '[]'` tối đa 100 dòng; unique `(project_id, code)`, unique
    `(doc_id)` khi khác null;
  - `qa_cases`: `name` "tối đa 300 ký tự", `requirements` "ít nhất 1 mã, mỗi mã khớp regex của D10", `labels`
    "không dấu cách, tối đa 20 nhãn", `steps` `[{ n, action, expected }]` "ít nhất 1 bước", `script`
    "bắt buộc khi `kind = automated`", `version int not null default 1`, `state` `active`/`retired`; unique
    `(project_id, code)`, index `(project_id, area_id, state)`, GIN `requirements`, GIN `labels`. Index tìm theo tên
    chốt ở T042;
  - `qa_case_versions`: pk `(case_id, version)`, FK `case_id` CASCADE;
  - `qa_case_status`: pk `case_id`, `current_status` và `current_source` là cột generated stored; index
    `(project_id, current_status)`, `(project_id, area_id)`.

  Thêm sáu bảng vào `rls.db.test.ts` (`apps/hub/src/modules/qa/schema.ts`, `apps/hub/src/modules/qa/rls.db.test.ts`)
- [x] T009 H — Bảng CI, cùng quy tắc chung:
  - `qa_ci_sources`: `label` tối đa 80, `repo_web_url` chỉ `https`, `branch_filter` và `job_filter` text[] (rỗng là
    mọi), `mode` `pipeline-report`/`junit-artifact`/`playwright-artifact`, `artifact_path` "bắt buộc với hai mode
    artifact; đường dẫn tương đối, không `..`", `backfill_state` `pending`/`listing`/`done`/`error`; unique
    `(project_id, label)`, index `(project_id, repo_path)`;
  - `qa_ci_runs`: `read_attempts int not null default 0`, `pipeline_status`
    `success`/`failed`/`canceled`/`skipped`/`manual`, `sha` 40 ký tự hex, `kind` `branch`/`mr`, `unknown_codes`
    tối đa 200; unique `(source_id, pipeline_id)`, index `(source_id, is_reference, finished_at desc)`,
    `(org_id, read_state)`. Không có cột tên test, thông báo lỗi hay URL. Cột `delivery_job_id` chưa có FK: FK tới
    `delivery_jobs` đợi specs/032 T011 (T062);
  - `qa_ci_run_cases`: pk `(run_id, case_id)`, index `(case_id, run_id)`, FK `run_id` CASCADE.

  Thêm ba bảng vào `rls.db.test.ts` (`apps/hub/src/modules/qa/schema.ts`, `apps/hub/src/modules/qa/rls.db.test.ts`)
- [x] T010 H — Bảng đợt test, cùng quy tắc chung:
  - `qa_rounds`: `name` 1–120, `environment` tối đa 80, `build` tối đa 80, `planned_end_date >= start_date`,
    `state` `open`/`closed`, `previous_round_id` `ON DELETE SET NULL (previous_round_id)`, `reopen_reason` 10–500,
    `open_recording bool not null default false`; index `(project_id, state)`;
  - `qa_round_cases`: `status` mặc định `untested`, `failed_step` "≥ 1 và ≤ số bước của TC", `note` "tối đa 500 ký
    tự", `links` "tối đa 5, mỗi liên kết `http://` hoặc `https://`, tối đa 2.000 ký tự", `revision int not null
    default 0`; check "`status IN ('other', 'failed')` thì `note` hoặc `links` khác rỗng" và
    "`cardinality(links) <= 5`, `char_length(note) <= 500`"; unique `(round_id, case_id)`, index
    `(case_id, recorded_at desc)`;
  - `qa_round_assignees`: pk `(round_case_id, user_id)`, index `(user_id)`;
  - `qa_result_history`: pk `(round_case_id, revision)`, `note_deleted` mặc định `false`.

  Thêm bốn bảng vào `rls.db.test.ts` (`apps/hub/src/modules/qa/schema.ts`, `apps/hub/src/modules/qa/rls.db.test.ts`)
- [x] T011 [P] H — Knowledge (D3, D4): `provideDocSaved` và `provideDocAccess` nhận nhiều hàm thay vì một. Quyền của
  các provider gộp bằng OR. `DocAccessGrant` thêm `save`, `Scope` thêm `saveGranted`. `authorize` cho `manage` khi
  `reader.kind === "user"` và `saveGranted`. Chạy lại test của `sdlc` và `docsync` đang dùng hai hook
  (`apps/hub/src/modules/knowledge/access.ts`, `knowledge/docs.ts`, `knowledge/index.ts`, test cùng thư mục)
- [x] T012 [P] H — Docsync (D3b): export `ensureProjectInclude(tx, actor, projectId, glob)` trả `"no-home"`,
  `"covered"` hoặc `"added"`. `"added"` ghi include, ghi audit, gọi `queuePull`. So glob bằng `contracts/glob.ts`.
  Không gọi `configureProjectHome` (`apps/hub/src/modules/docsync/homes.ts`, `docsync/index.ts`,
  `docsync/homes.db.test.ts`)
- [x] T013 [P] H — Export `csvRow`, `csvCell` của `audit/csv.ts` qua `audit/index.ts` cho US7
  (`apps/hub/src/modules/audit/index.ts`)
- [x] T014 H — Kiểm quyền chung: dự án ngoài đội trả 404; `requireTeamRole(..., "viewer")`, rồi
  `effectivePermissions().has(perm)`; thiếu quyền trả `ForbiddenError` "Cần quyền `<quyền>` ở đội của dự án này."
  (FR-016); dự án chưa bật thư viện trả `QA_LIBRARY_DISABLED`, trừ route `projectSettings.*`. Sau T004, T007
  (`apps/hub/src/modules/qa/access.ts`, `apps/hub/src/modules/qa/access.db.test.ts`)
- [x] T015 H — Bảng chiếu `qa_case_status` (D12, FR-052): bên mới hơn thắng, bằng giờ thì kết quả tay thắng, không có dữ liệu
  là null; thứ tự xấu nhất `failed` > `other` > `flaky` > `skipped` > `passed`; CI `skipped` tính là có kết quả. Hàm
  cập nhật cho: run `done` trên nhánh tham chiếu, gửi lại, đổi `reference_branch`, lưu kết quả tay, xoá nguồn hoặc
  dọn dữ liệu, TC mới (thêm hàng rỗng) (`apps/hub/src/modules/qa/status.ts`, `apps/hub/src/modules/qa/status.db.test.ts`)
- [x] T016 H — Mọi nhóm route ở dạng chờ, trả lỗi tiếng Việt "Chức năng chưa có.": `settings`, `project-settings`,
  `areas`, `cases`, `sources`, `rounds`, `rounds-export`, `my-work`, `dashboard`. `qa/router.ts` ghép các nhóm. Export
  `qaRouter` ở `qa/index.ts`, thêm vào object router ở `app.ts` (dòng 272). Các story sau chỉ thay file nhóm của mình,
  không sửa `qa/router.ts` (`apps/hub/src/modules/qa/routes/*.ts`, `qa/router.ts`, `qa/index.ts`, `apps/hub/src/app.ts`)
- [x] T017 [P] U — Fixture e2e `testingDefaults()` theo cách `delivery-ci-fixture.ts`, nạp ở fake-hub
  (`apps/web/e2e/testing-fixture.ts`, `apps/web/e2e/fake-hub.ts`)
- [x] T018 H — Migration enum: chỉ `ALTER TYPE hive.team_role ADD VALUE 'tester'`. Sinh bằng
  `pnpm --filter @xdev-hive/hub db:generate` sau `git merge origin/main`, kiểm file SQL trước khi commit
  (`apps/hub/db/migrations/*.sql`)
  Đã làm: drizzle-kit gộp enum và bảng vào một file, nên `0091_team_role_tester` sinh khi tạm thay
  `qa/schema.ts` bằng file rỗng, rồi mới sinh `0092_qa_tables`.
- [x] T019 H — Migration bảng `qa_*` (T008–T010) và SQL viết tay: `FORCE ROW LEVEL SECURITY` mọi bảng, FK tới
  `projects`, `docs`, `users`, `ON DELETE SET NULL (<cột>)`, GIN, policy của `qa_settings`. Chưa có FK tới
  `delivery_jobs` và chưa có `hive.purge_qa_data()` (`apps/hub/db/migrations/*.sql`)

**Checkpoint**: `pnpm check` xanh. Các story bắt đầu được.

---

## Phase 3: User Story 1 — Thư viện test case bằng Markdown trong docs home (P1) 🎯 MVP

**Mục tiêu**: tester viết TC bằng Markdown trong docs home. Hub đọc file thành thư viện có phiên bản (FR-001…FR-009).

**Kiểm độc lập**: "tạo một khu có 3 TC hợp lệ. Thư viện hiện 3 TC đủ trường. Sửa một TC trong repo docs, đợi đồng bộ.
Thư viện có nội dung mới và lịch sử phiên bản của TC."

- [ ] T020 [P] [US1] C — Bộ đọc file khu theo contracts/tc-markdown.md: `# <KHU> <tên>`, `### TC-<KHU>-<SỐ> <tên>`,
  trường `- <Trường>: <giá trị>`, bảng `| # | Thao tác | Kết quả mong đợi |`. Trả `ParsedArea`
  (`area`, `cases`, `errors` có `line`, `message`), tối đa 100 lỗi. Kiểm trường bắt buộc (FR-002), mã TC (FR-003) và mã
  yêu cầu theo thứ tự ở contracts/tc-markdown.md. Hàm chuẩn hoá TC bỏ `line` để hub băm. Hàm
  `areaTemplate(code, name)` sinh mẫu tiếng Việt có một TC ví dụ (FR-008). Test: file đúng, thiếu trường, mã khác khu,
  không có bước, quá 100 lỗi, `automated` thiếu `script`, mã yêu cầu `FR-001`, `036/AC-012.2`, `OPD02`, `OPD02P00108`,
  `USR01` được nhận, `FR001` và `NFR` báo lỗi mã spec sai dạng, `opd02` và `OPD-02` báo lỗi sai mẫu
  (`packages/contracts/src/test-library.ts`, `test-library.test.ts`, `index.ts`)
- [ ] T021 [US1] H — Áp dụng file khu trong tx lưu tài liệu. `content_hash` là SHA-256 của JSON đã chuẩn hoá. Sáu quy
  tắc của data-model.md (quy tắc 3–5 là FR-006):
  1. mã mới: thêm, `version = 1`;
  2. cùng khu: cập nhật; hash đổi thì `version + 1` và thêm hàng `qa_case_versions`;
  3. mã ở khu khác, đang dùng: từ chối cả file "Mã đã có ở khu khác";
  4. mã ở khu khác, đã ngừng: từ chối "Mã đã dùng trước đây, chọn số khác";
  5. mã không còn trong file: `retired`;
  6. mã ngừng xuất hiện lại: `active`, kiểm phiên bản như quy tắc 2.

  File có lỗi: chỉ cập nhật `parse_errors`, `errors_version`, giữ TC cũ (FR-004). Lưu trữ tài liệu: mọi TC của khu
  `retired`, đặt `archived_at`. Khôi phục: đọc lại file. TC mới thêm hàng rỗng ở `qa_case_status` (T015)
  (`apps/hub/src/modules/qa/library.ts`, `apps/hub/src/modules/qa/library.db.test.ts`)
- [ ] T022 [US1] H — Hook lưu tài liệu: lọc key có tiền tố `project/<key>/<slug của tcDir>/` (key không có `.md`), gọi
  T021 trong tx lưu, chỉ throw khi lỗi DB. Nối hook ở `main.ts`. Test: `saveDoc` trên web và `saveDocFromSync` cho
  cùng kết quả (FR-005); lưu trữ và khôi phục
  (`apps/hub/src/modules/qa/doc-hooks.ts`, `qa/doc-hooks.db.test.ts`, `qa/index.ts`, `apps/hub/src/main.ts`)
- [ ] T023 [US1] H — Route `projectSettings.get`, `projectSettings.update` (cần `projects.settings`; bật lần đầu gọi
  `ensureProjectInclude`, trả `includeResult`), `areas.list` (gồm `parseErrors`), `areas.create` (cần
  `qa.cases.write`; tạo tài liệu từ `areaTemplate()` qua `saveDoc`; mã trùng trả 409 `QA_AREA_CODE_TAKEN`; trả
  `docKey`), `cases.list` (lọc `q`, `area`, `label`, `priority`, `kind`, `requirement`, `currentStatus`, `state`
  mặc định `active`, FR-009), `cases.get` (nội dung, `version`, các phiên bản cũ). Ghi audit FR-070 trong cùng tx
  (`apps/hub/src/modules/qa/routes/project-settings.ts`, `qa/routes/areas.ts`, `qa/routes/cases.ts`,
  `qa/library-routes.db.test.ts`)
- [ ] T024 [P] [US1] U — Trang "Kiểm thử" có năm tab: Tổng quan, Thư viện, Đợt test, Nguồn CI, Việc của tôi. Tab chưa
  làm hiện "Chưa có". Tab Thư viện có bộ lọc FR-009. Route lazy `/projects/$key/testing` và
  `/projects/$key/testing/cases/$code` như `CiCdPage`. Liên kết "Kiểm thử" ở thanh điều hướng dự án
  (`apps/web/src/pages/testing/testing-page.tsx`, `pages/testing/library-tab.tsx`, `apps/web/src/router.tsx`,
  `apps/web/src/pages/tasks-page.tsx`)
- [ ] T025 [US1] U — Màn chi tiết TC: nội dung, các bước, lịch sử phiên bản (FR-007). Hộp "Thêm khu chức năng": mã và
  tên khu, tạo xong mở editor tại `docKey`
  (`apps/web/src/pages/testing/case-detail-page.tsx`, `pages/testing/add-area-dialog.tsx`)
- [ ] T026 [P] [US1] U — Mục "Kiểm thử" ở cài đặt dự án: bật thư viện, `tcDir`, thông báo theo `includeResult`
  (`no-home` hướng dẫn cấu hình docs home). Đặt cạnh `ProjectDocsSettings`
  (`apps/web/src/pages/project-testing-settings.tsx`, `apps/web/src/pages/project-settings-page.tsx`)
- [ ] T027 [P] [US1] U — Ô lỗi đọc file ở editor tài liệu: với tài liệu trong `tcDir`, hiện `parseErrors` (dòng, thông
  báo) lấy từ `testing.areas.list` (`apps/web/src/pages/knowledge/doc-editor-page.tsx`)
- [ ] T028 [US1] U — e2e theo Kiểm độc lập US1 và luồng SC-001 (`apps/web/e2e/testing-library.spec.ts`,
  `apps/web/e2e/testing-fixture.ts`)

**Checkpoint**: chạy quickstart §1, §2.

---

## Phase 4: User Story 2 — Vai trò Tester (P1) 🎯 MVP

**Mục tiêu**: `team-tester` có đủ quyền kiểm thử, không có quyền ngoài FR-012 (FR-010…FR-016).

**Kiểm độc lập**: "gán `team-tester` cho một người. Kiểm từng quyền ở FR-012 và FR-013: quyền được cho chạy được, quyền
bị cấm trả lỗi 403 kèm thông báo tiếng Việt."

- [ ] T029 [US2] H — Provider quyền lưu: trả `{ read, propose, save }` cho key trong `tcDir` khi người gọi có
  `qa.cases.write`. Nối ở `main.ts`. Test: tester lưu được file TC; lưu tài liệu khác bị từ chối nếu không có
  `docs.write` (FR-011). Sau T022 (`apps/hub/src/modules/qa/doc-hooks.ts`, `qa/doc-hooks.db.test.ts`,
  `qa/index.ts`, `apps/hub/src/main.ts`)
- [ ] T030 [US2] H — Ma trận FR-012 cho route `testing.*`: mỗi quyền được cho chạy được; thiếu quyền trả 403 với tên
  quyền thiếu (FR-016); người ngoài đội nhận 404 (FR-015) (`apps/hub/src/modules/qa/access.db.test.ts`)
- [ ] T031 [P] [US2] H — Ma trận FR-013 (SC-007): thành viên `team-tester` bị từ chối mọi quyền cấm, gọi qua hàm kiểm
  quyền mà route tương ứng dùng (`apps/hub/src/modules/tenancy/tester-role.db.test.ts`)
- [ ] T032 [P] [US2] U — Nhãn "Tester" và chọn được vai trò ở đội, thành viên, mời; nhóm quyền "Kiểm thử" có bốn quyền
  (`apps/web/src/lib/roles.ts`, `lib/permissions.ts`, `pages/teams-page.tsx`, `pages/members-page.tsx`,
  `components/invite-form.tsx`, `components/outside/onboarding-invite-form.tsx`)
- [ ] T033 [US2] U — Ẩn hoặc khoá nút theo quyền ở trang Kiểm thử. e2e theo Kiểm độc lập US2. Sau T024, T025
  (`apps/web/src/pages/testing/testing-page.tsx`, `pages/testing/library-tab.tsx`, `apps/web/e2e/testing-roles.spec.ts`)

**Checkpoint**: chạy quickstart §3. MVP xong.

---

## Phase 5: User Story 4 — Đợt test chạy tay (P1)

**Mục tiêu**: quản lý đợt, giao TC, ghi kết quả song song không mất dữ liệu (FR-030…FR-039).

**Kiểm độc lập**: "tạo đợt 20 TC, giao cho 2 người, hai người ghi song song. Đóng đợt. Tạo lần 2 từ TC chưa đạt. Lần 2
có đúng các TC đó, kết quả lần 1 không đổi."

Test hub nạp TC thẳng vào bảng, không cần US1.

- [ ] T034 [US4] H — Route `rounds.list`, `rounds.get` (dấu "TC đã đổi sau khi giao" khi
  `qa_cases.version > case_version_at_add`, FR-037), `rounds.create` (chọn TC khớp bất kỳ điều kiện; không TC nào thì
  `QA_ROUND_EMPTY`; mọi TC bắt đầu `untested`, FR-031), `rounds.createNext` (mặc định Không đạt, Chưa test, Chuyển đợt sau,
  Khác; đặt `previous_round_id`, FR-038), `rounds.assign` (người được giao phải thuộc đội lúc giao, không thì
  `QA_ASSIGNEE_NOT_MEMBER`), `rounds.close`, `rounds.reopen` (lý do 10–500 ký tự, FR-036). Audit FR-070 trong cùng tx
  (`apps/hub/src/modules/qa/rounds.ts`, `qa/routes/rounds.ts`, `qa/rounds.db.test.ts`)
- [ ] T035 [US4] H — `rounds.record` (FR-033): khoá lạc quan `UPDATE … WHERE id = $1 AND revision = $2`, bản cũ vào
  `qa_result_history`; xung đột trả `QA_RESULT_CONFLICT` kèm `data.latest` (FR-035); chưa được giao thì
  `QA_NOT_ASSIGNED` trừ khi `open_recording`; đợt đóng thì `QA_ROUND_CLOSED`; kiểm `QA_NOTE_REQUIRED`,
  `QA_LINK_INVALID`, `QA_FAILED_STEP_INVALID` theo ràng buộc ở T010; ghi `recorded_case_version`; cập nhật bên tay của
  `qa_case_status` (T015). TC đã ngừng vẫn ghi được tới khi đóng đợt. `rounds.history` (FR-034). `rounds.deleteNote`
  (admin): `note = null`, `note_deleted = true` ở mọi hàng lịch sử, audit không chứa nội dung
  (`apps/hub/src/modules/qa/rounds.ts`, `qa/routes/rounds.ts`, `qa/rounds-record.db.test.ts`)
- [ ] T036 [US4] H — `myWork.list`: TC được giao cho người gọi trong các đợt `open` (FR-032)
  (`apps/hub/src/modules/qa/routes/my-work.ts`, `qa/my-work.db.test.ts`)
- [ ] T037 [US4] H — Tải SC-004: 20 tester ghi song song 500 TC, không mất kết quả nào, mọi `revision` liên tục. Chạy
  khi đặt `HIVE_LOAD_TEST=1`, mặc định bỏ qua. Ghi số đo vào research.md
  (`apps/hub/src/modules/qa/rounds.load.db.test.ts`, `specs/036-test-management/research.md`)
- [ ] T038 [P] [US4] U — Tab Đợt test: danh sách, tạo đợt có bộ lọc chọn TC, tạo đợt tiếp theo. Màn đợt: bảng TC,
  giao người, dấu "TC đã đổi sau khi giao", đóng và mở lại có lý do. Hộp ghi kết quả: trạng thái, bước lỗi, ghi chú,
  liên kết lỗi; khi xung đột hiện bản mới nhất. Sau T024
  (`apps/web/src/pages/testing/rounds-tab.tsx`, `pages/testing/round-page.tsx`,
  `pages/testing/record-result-dialog.tsx`, `pages/testing/testing-page.tsx`, `apps/web/src/router.tsx`)
- [ ] T039 [US4] U — Tab Việc của tôi. e2e theo Kiểm độc lập US4
  (`apps/web/src/pages/testing/my-work-tab.tsx`, `pages/testing/testing-page.tsx`, `apps/web/e2e/testing-rounds.spec.ts`)

**Checkpoint**: chạy quickstart §5.

---

## Phase 6: User Story 5 — Dashboard kết quả (P1)

**Mục tiêu**: các góc nhìn FR-050…FR-058 khớp số tính tay.

**Kiểm độc lập**: "nạp dữ liệu mẫu gồm 3 khu, 30 TC, 10 lần chạy CI và 2 đợt tay. Mỗi góc nhìn ở FR-050…FR-057 cho số
liệu khớp với tính tay trên dữ liệu mẫu."

Test hub nạp dữ liệu CI thẳng vào bảng, không cần US3.

- [ ] T040 [US5] H — `dashboard.overview` (FR-050; tỉ lệ đạt FR-051 = Đạt / số TC đang dùng có trạng thái khác null),
  `dashboard.areas` (FR-053), `dashboard.requirements` (FR-054, `unnest` mã yêu cầu, lấy trạng thái xấu nhất),
  `dashboard.trend({ projectKey, sourceId?, areaCode?, days 1–90 })` (FR-055, run `done` trên nhánh tham chiếu,
  `passed / (passed + flaky + failed + skipped)`), `dashboard.flaky` (FR-056, trong `QA_FLAKY_WINDOW` run gần nhất có
  `flaky` hoặc đổi trạng thái ít nhất `QA_FLAKY_FLIPS` lần), số test chưa gắn mã, mơ hồ, mã lạ của run gần nhất mỗi
  nguồn (FR-058). Chốt TC đã ngừng có tính vào xu hướng không, ghi vào data-model.md. Test bằng dữ liệu mẫu của Kiểm
  độc lập, so với số tính tay (SC-009) (`apps/hub/src/modules/qa/dashboard.ts`, `qa/routes/dashboard.ts`,
  `qa/dashboard.db.test.ts`, `specs/036-test-management/data-model.md`)
- [ ] T041 [US5] H — `cases.history({ projectKey, code, source })`: kết quả CI và kết quả tay, mới trước; liên kết job
  GitLab dựng từ `repo_web_url`, mã pipeline, mã job (FR-026, FR-057). Sau T023
  (`apps/hub/src/modules/qa/routes/cases.ts`, `qa/cases-history.db.test.ts`)
- [ ] T042 [US5] H — Đo SC-005: 5.000 TC, 90 ngày, 20 người xem đồng thời, p95 mỗi góc nhìn dưới 3 giây. Chốt index
  tìm theo tên (trigram hoặc `lower(name)`), thêm vào `schema.ts`. Chạy khi đặt `HIVE_LOAD_TEST=1`. Ghi số đo vào
  research.md (`apps/hub/src/modules/qa/dashboard.perf.db.test.ts`, `qa/schema.ts`,
  `specs/036-test-management/research.md`)
- [ ] T043 [P] [US5] U — Tab Tổng quan: thẻ số, bảng theo khu, bảng theo yêu cầu, danh sách chập chờn, số test chưa gắn
  mã. Biểu đồ xu hướng SVG theo cách `pages/machine-token-score.tsx` (dòng 267). Sau T024
  (`apps/web/src/pages/testing/overview-tab.tsx`, `pages/testing/trend-chart.tsx`, `pages/testing/trend-chart.test.tsx`,
  `pages/testing/testing-page.tsx`)
- [ ] T044 [US5] U — Màn chi tiết TC thêm lịch sử kết quả CI và tay, liên kết job GitLab và liên kết lỗi. e2e theo Kiểm
  độc lập US5. Sau T025 (`apps/web/src/pages/testing/case-detail-page.tsx`, `apps/web/e2e/testing-dashboard.spec.ts`)

**Checkpoint**: chạy quickstart §6, đo SC-006.

---

## Phase 7: User Story 6 — Agent đọc test case theo mã (P2)

**Mục tiêu**: agent trong run đọc TC của dự án mình qua MCP, không ghi được gì (FR-060, FR-061).

**Kiểm độc lập**: "trong một run của dự án, agent hỏi TC theo mã và theo khu. Kết quả đúng nội dung thư viện. Run của
dự án khác không đọc được."

- [ ] T045 [P] [US6] H — `registerMcpTools(registry)` với `qa_get_case`, `qa_list_cases`, cả hai `readOnly: true`.
  Phạm vi qua `knowledgePrincipal`, giới hạn qua `MCP_LIMITS`. Lỗi `PROJECT_NOT_FOUND`, `PROJECT_REQUIRED`,
  `QA_LIBRARY_DISABLED` theo contracts/mcp-tools.md. Export qua `qa/index.ts`, đăng ký ở `app.ts` như
  `tenancyMcpTools(registry)` (dòng 164). Test: run đọc dự án mình; dự án khác trả `PROJECT_NOT_FOUND`; không có công
  cụ ghi (`apps/hub/src/modules/qa/mcp-tools.ts`, `qa/mcp-tools.db.test.ts`, `qa/index.ts`, `apps/hub/src/app.ts`)

**Checkpoint**: chạy quickstart §7.

---

## Phase 8: User Story 7 — Xuất kết quả đợt (P3)

**Mục tiêu**: người có `qa.read` xuất đợt ra CSV UTF-8 có BOM (FR-062).

**Kiểm độc lập**: "xuất đợt 20 TC. File có 20 dòng với mã, tên, khu, người ghi, trạng thái, bước lỗi, ghi chú, liên
kết lỗi, thời điểm."

- [ ] T046 [P] [US7] H — Dựng CSV: BOM, 10 cột theo contracts/csv-export.md, `csvRow` và `csvCell` của `audit` (T013),
  tên file `dot-test-<slug>-<YYYY-MM-DD>.csv`. Test: ô bắt đầu bằng `=`, `+`, `@`, `-` có tiền tố `'`; dòng kết thúc
  `\r\n` (`apps/hub/src/modules/qa/export.ts`, `qa/export.test.ts`)
- [ ] T047 [US7] H — Route `rounds.export` (`POST /v1/testing/rounds/export`, trả `z.file()`, cần `qa.read`), audit
  `qa.rounds.export` trên `qa_round` kèm `{ count }`. Đổi tên file test trong contracts/csv-export.md thành
  `qa/export.db.test.ts` (`apps/hub/src/modules/qa/routes/rounds-export.ts`, `qa/export.db.test.ts`,
  `specs/036-test-management/contracts/csv-export.md`)
- [ ] T048 [US7] U — Nút "Xuất CSV" ở màn đợt, tải file theo cách `admin/audit-page.tsx`. e2e theo Kiểm độc lập US7.
  Sau T038 (`apps/web/src/pages/testing/round-page.tsx`, `apps/web/e2e/testing-export.spec.ts`)

**Checkpoint**: chạy quickstart §8.

---

## Phase 9: User Story 3 — Nhận kết quả test của pipeline GitLab (P1)

**Mục tiêu**: worker đọc báo cáo test tại máy, hub chỉ nhận số liệu theo mã TC (FR-020…FR-029).

**Kiểm độc lập**: "khai một nguồn, cho pipeline thử xuất JUnit với 5 test chứa 4 mã TC. Hub có một lần chạy với tổng số
đúng và 4 dòng TC. Database và request vào hub không chứa tên test hay thông báo lỗi."

Story P1 nhưng đặt sau cùng: phần hub cần specs/032 T011, T012, T017, T020 ở `main`. Phần worker T049, T050 làm được
ngay sau T006.

- [ ] T049 [P] [US3] W — `testreport.Options{Library bool}`: tìm mã bằng `\bTC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}\b` trong
  tên test; nhiều mã tính `ambiguous`, không mã tính `unmapped`; giới hạn 32 MiB và 5000 ca
  (`worker/internal/testreport/summary.go`, `worker/internal/testreport/summary_test.go`)
- [ ] T050 [P] [US3] W — Việc `test-report` (FR-023, FR-025). `op=read` theo ba mode (D7): `pipeline-report` gọi
  `/pipelines/:id/test_report`; hai mode artifact gọi `/pipelines/:id/jobs` rồi `/jobs/:job_id/artifacts/*path`;
  `total_count = 0` báo `no_report`. `op=list` theo D18. Phát `test-results`, `pipelines`, `finished` với mã T006.
  Test bằng `httptest`: JSON sự kiện không chứa tên test, tên suite, thông báo lỗi (SC-003)
  (`worker/internal/delivery/testreport.go`, `worker/internal/delivery/testreport_test.go`)
- [ ] T051 [US3] G — Chờ specs/032 T011. Hàm tạo việc nhận `maxWaitSec` (mặc định 900, `test-report` 86.400). Nếu 032
  không nhận tham số này: tạo lại việc khi `runner_offline` tới 24 giờ sau `waiting_since`, rồi `expired`. Cách này tạo
  tới 96 việc lỗi mỗi pipeline [Inference] (`apps/hub/src/modules/delivery/` file tạo việc của 032 T011, test cùng file)
- [ ] T052 [US3] G — Chờ specs/032 T012. `delivery` cho đăng ký hàm nhận sự kiện theo kind, để `qa` nhận
  `test-results`, `pipelines`, `finished` mà `delivery` không import `qa`
  (`apps/hub/src/modules/delivery/index.ts`, file nhận `deliveryEvent` của 032 T012, test cùng file)
- [ ] T053 [US3] G — Chờ specs/032 T020. `selectRunner` nhận `need: { method } | { kind }`. Lọc: online, có kind, có
  credential. Chọn đăng ký cũ nhất, `requireLabel: false`. Trả lý do chờ (FR-022) `no_machines`, `offline`, `no_capability`,
  `missing_credential` (`apps/hub/src/modules/delivery/runner-select.ts`, `delivery/runner-select.test.ts`)
- [ ] T054 [US3] W — Chờ specs/032 T017. `Executor` chạy `test-report`; worker báo `kinds: ["test-report"]` khi chào
  hub. Nếu phần chào nằm ở `worker/internal/channel/**` thì phối hợp với luồng X của 032
  (`worker/internal/delivery/executor.go`, `worker/internal/delivery/executor_test.go`)
- [ ] T055 [US3] H — Nguồn CI: `sources.list`, `create`, `update`, `delete`, `refetch`, `runs` (cần `projects.settings`
  để ghi). Nhãn trùng trả `QA_SOURCE_LABEL_TAKEN`. Đổi `reference_branch` tính lại `is_reference` và `qa_case_status`
  trong cùng tx. Xoá nguồn: xoá run theo cascade, tính lại trạng thái, ghi audit. Tạo nguồn: việc `op=list` với
  `ref = reference_branch`, `limit` 20, đặt `backfill_state` (FR-029). `refetch`: `updatedAfter = now() - 7 ngày`,
  `limit` 500; đang chạy thì 409 `QA_REFETCH_RUNNING` (FR-028). Audit FR-070
  (`apps/hub/src/modules/qa/ci-sources.ts`, `qa/routes/sources.ts`, `qa/ci-sources.db.test.ts`)
- [ ] T056 [US3] H — Nhận webhook (FR-021): `onScmEvent("pipeline", handler)` chạy trong tx webhook. Khớp `repo_path`, bỏ trạng
  thái thuộc `CI_ACTIVE_STATUSES` và nhánh ngoài `branch_filter`; `merge_request_event` là kind `mr`. Không trùng theo
  `(source_id, pipeline_id)` (FR-027). Tạo run `waiting` và việc `op=read`. Test: gửi lại ba lần cho cùng pipeline vẫn
  một run (SC-008) (`apps/hub/src/modules/qa/ci-intake.ts`, `qa/ci-intake.db.test.ts`)
- [ ] T057 [US3] H — Nhận sự kiện worker (FR-024, FR-025): `test-results` chuyển run sang `done`, ghi `qa_ci_run_cases`, cập nhật
  `qa_case_status` khi run trên nhánh tham chiếu; `finished` chuyển `no-report` hoặc `error` theo mã; `pipelines` tạo
  run `waiting` khi chưa có hàng hoặc hàng ở `error`, `expired`, `no-report` (D18); sự kiện `finished` của việc list đặt
  `backfill_state`; quá `QA_READ_WAIT_HOURS` thì `expired`. Chỉ `done` ghi `run_cases` và bảng chiếu. Test: database
  không chứa tên test hay thông báo lỗi (SC-003) (`apps/hub/src/modules/qa/ci-intake.ts`, `qa/ci-intake.db.test.ts`)
- [ ] T058 [US3] H — Nối ở `main.ts`: handler webhook, hàm nhận sự kiện của T052. Export qua `qa/index.ts`
  (`apps/hub/src/main.ts`, `apps/hub/src/modules/qa/index.ts`)
- [ ] T059 [P] [US3] U — Tab Nguồn CI: form nguồn, danh sách run với nhãn trạng thái đọc (Chờ máy, Đang đọc, Đã đọc,
  Không có báo cáo, Lỗi đọc, Hết hạn), lý do chờ, liên kết pipeline và job, nút "Lấy lại kết quả". e2e theo Kiểm độc
  lập US3. Sau T024 (`apps/web/src/pages/testing/sources-tab.tsx`, `pages/testing/testing-page.tsx`,
  `apps/web/e2e/testing-sources.spec.ts`)
- [ ] T060 [US3] H — Đo dung lượng `qa_ci_run_cases` (ước tính trường hợp xấu khoảng 9 GB mỗi năm mỗi dự án
  [Inference]) và ảnh hưởng của 500 việc `refetch` lên hàng việc của `delivery`. Ghi số đo vào research.md
  (`specs/036-test-management/research.md`)
- [ ] T061 [US3] D — Chỉ làm khi repo nguồn khác repo dự án: kiểm webhook của repo thứ hai có tới hub không
  [Unverified], cập nhật quickstart §4 (`specs/036-test-management/quickstart.md`)
- [ ] T062 [US3] H — Migration của PR này, sau `git merge origin/main`: FK `qa_ci_runs.delivery_job_id → delivery_jobs`
  `ON DELETE SET NULL (delivery_job_id)` (`apps/hub/db/migrations/*.sql`)

**Checkpoint**: chạy quickstart §4, đo SC-002.

---

## Phase 10: Hoàn thiện

- [ ] T063 H — Giữ dữ liệu (FR-072): `settings.get`, `settings.update({ retentionDays })` cho owner và admin tổ chức,
  90–3.650 ngày, audit. Cron `QA_RETENTION_CRON = "37 3 * * *"` gọi `hive.purge_qa_data()` qua `withTenant`. Hàm SQL
  `SECURITY DEFINER`, `REVOKE` khỏi `PUBLIC`, `GRANT` cho `hive_app`; xoá đợt đã đóng và run CI cũ hơn mốc
  (`finished_at` hoặc `created_at`), rồi tính lại trạng thái; không xoá `qa_cases`, `qa_case_versions`. Policy
  `_owner_select`, `_owner_purge` ở bảng bị dọn. Nối cron ở `main.ts`. Migration sinh ở cuối PR
  (`apps/hub/src/modules/qa/retention.ts`, `qa/routes/settings.ts`, `qa/retention.db.test.ts`, `apps/hub/src/main.ts`,
  `apps/hub/db/migrations/*.sql`)
- [ ] T064 [P] U — Mục "Giữ dữ liệu kiểm thử" cạnh "Giữ log run" ở trang chính sách tổ chức
  (`apps/web/src/pages/admin/policies-page.tsx`)
- [ ] T065 [P] D — Thêm module `qa` và luồng `test-report` vào tài liệu kiến trúc (`docs/architecture.md`)
- [ ] T066 D — Kiểm cuối: `pnpm openapi` không đổi `openapi.json`; `pnpm check` xanh; Go xanh trên CI; chạy đủ quickstart
  §0–§9, ghi kết quả vào quickstart (`specs/036-test-management/quickstart.md`)

---

## Phụ thuộc

### Thứ tự phase

| Phase | Cần trước |
|---|---|
| 1 Chuẩn bị | không |
| 2 Nền | Phase 1 |
| 3 US1 | Phase 2 |
| 4 US2 | Phase 2; T029 sau T022, T033 sau T024 và T025 |
| 5 US4 | Phase 2; phần web sau T024 |
| 6 US5 | Phase 2; T041 sau T023, phần web sau T024 và T025 |
| 7 US6 | Phase 2 |
| 8 US7 | Phase 2 và T013; T048 sau T038 |
| 9 US3 | Phase 2; G sau task 032 tương ứng ở `main`; T049, T050 chỉ cần T006 |
| 10 Hoàn thiện | các story muốn phát hành |

### Trong Phase 2

- T003 → T004 (cùng file). T005 → T007. T008 → T009 → T010 (cùng file).
- T014 sau T004, T007. T015 sau T008. T016 sau T004, T014. T017 sau T004.
- T018, T019 cuối phase, theo thứ tự đó.

### File nhiều task cùng sửa (làm lần lượt)

| File | Task |
|---|---|
| `apps/hub/src/main.ts` | T022, T029, T058, T063 |
| `apps/hub/src/app.ts` | T016, T045 |
| `apps/hub/src/modules/qa/index.ts` | T016, T022, T029, T045, T058 |
| `apps/hub/src/modules/qa/doc-hooks.ts` | T022, T029 |
| `apps/hub/src/modules/qa/routes/cases.ts` | T023, T041 |
| `apps/hub/src/modules/qa/ci-intake.ts` | T056, T057 |
| `apps/web/src/pages/testing/testing-page.tsx` | T024, T033, T038, T039, T043, T059 |
| `apps/web/src/pages/testing/case-detail-page.tsx` | T025, T044 |
| `apps/web/src/pages/testing/round-page.tsx` | T038, T048 |
| `apps/web/src/router.tsx` | T024, T038 |

## Chạy song song

- **Phase 1**: T001 và T002.
- **Phase 2**: T005, T006, T011, T012, T013 cùng lúc với T003; T017 cùng lúc với T008–T016.
- **US1**: T020 cùng lúc với T024, T026, T027; sau T020 thì T021 → T022 → T023.
- **US2**: T031 và T032 cùng lúc với T029, T030.
- **US4**: T038 cùng lúc với T034–T037.
- **US5**: T043 cùng lúc với T040–T042.
- **Giữa story**: sau Phase 2, US4, US5, US6 và phần hub US7 chạy cùng lúc với US1, US2 vì test hub nạp dữ liệu thẳng
  vào bảng. Phần worker US3 (T049, T050) chạy bất cứ lúc nào sau T006.

## Chiến lược

1. **MVP**: Phase 1, Phase 2, US1, US2. Tester viết TC, thư viện có phiên bản, vai trò Tester đúng quyền. Dừng, chạy
   quickstart §1–§3.
2. **Đợt tay và dashboard**: US4, US5. Dashboard có số liệu từ kết quả tay trước khi có CI.
3. **Agent và xuất**: US6, US7.
4. **CI**: US3, sau khi specs/032 T011, T012, T017, T020 vào `main`. Phần worker viết và test trước.
5. **Hoàn thiện**: Phase 10.

Mỗi bước là một hoặc vài PR vào `main`. Mỗi PR cập nhật với `main` mới nhất, CI xanh rồi mới merge.

## Chưa kiểm

- [Unverified] Webhook của repo nguồn thứ hai tới được hub (T061).
- [Unverified] Tải `reports:junit` qua `/jobs/:job_id/artifacts/*path` ở mode artifact (T050).
- [Unverified] Tên trạng thái pipeline của GitLab khớp `CI_ACTIVE_STATUSES` và `pipeline_status` (T009, T056).
- Đã kiểm: drizzle-kit không tự tách `ALTER TYPE ... ADD VALUE` thành migration riêng (T018).
- [Unverified] Tham số `updated_after`, `ref`, `per_page` của API list pipeline GitLab (T050, T055).
- [Unverified] Các trường của `DocSaveInput` đủ cho `areas.create` (T023).
- [Inference] `selectRunner` chưa có nơi gọi ngoài test (T053).
- [Inference] Tên hàm tạo việc của specs/032 T011 là `enqueueDeliveryJob` (T051).
- [Inference] oRPC cần đủ mọi route của contract nên T016 dựng route chờ.
- [Inference] CSV dựng trong bộ nhớ đủ cho một đợt (T046).
- [Inference] TC đã ngừng có tính vào xu hướng: chốt ở T040.
- [Inference] Ước tính dung lượng và ảnh hưởng 500 việc: đo ở T060.
- [Inference] Biến `HIVE_LOAD_TEST` để bật test tải chưa có trong repo; T037 thêm.
