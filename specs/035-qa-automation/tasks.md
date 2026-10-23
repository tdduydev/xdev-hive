---
description: "Task list: AI SDLC cho tester (QA Automation)"
---

# Tasks: AI SDLC cho tester (QA Automation)

**Input**: [spec.md](spec.md), [plan.md](plan.md), [research.md](research.md), [data-model.md](data-model.md),
[contracts/](contracts/), [quickstart.md](quickstart.md)

## Quy ước

**Định dạng**: `- [ ] T### [P?] [USn?] <Luồng>·<Tier> — mô tả (file)`.

- **[P]**: chạy song song được với task khác trong cùng đợt (không sửa chung file, không chờ task chưa xong).
- **Luồng** (mỗi luồng một agent, hai agent không sửa cùng file):

  | Luồng | Phạm vi |
  |---|---|
  | **A** | contracts: `packages/contracts/src/qa.ts`, `sdlc.ts`, `sdlc-presets/**`, `index.ts`, `openapi.json` |
  | **B** | worker Go: `worker/internal/testreport/**`, `worker/cmd/hive/testsummary.go`, `worker/cmd/hive/main.go` (một case) |
  | **C** | hub: `apps/hub/src/modules/sdlc/**`, `apps/hub/db/migrations/**` |
  | **D** | web: `apps/web/src/**`, `apps/web/e2e/**` |
  | **E** | desktop: `apps/desktop/src/**` |

- **Tier**: nặng = Opus `--effort high`; vừa = Sonnet `--effort high`; nhẹ = Sonnet `--effort medium`.
- **File chung có chủ** (nối tiếp):
  - `packages/contracts/src/sdlc.ts`: T003 → T004 → T005 → T006.
  - `apps/hub/src/modules/sdlc/schema.ts`: T020 (một lần, cả năm bảng).
  - `apps/hub/src/modules/sdlc/steps.ts`: T023 → T024.
  - `apps/hub/src/modules/sdlc/router.ts`: T030 (một lần, thêm `qa`).
- **Chờ spec khác** (`⏸`): không làm trước khi spec đó vào `main`.
  - **⏸027**: kênh worker, outbox, `packages/contracts/src/worker-protocol.ts`, loại run mới.
  - **⏸031**: `worker/internal/secretstore/**`, biến môi trường theo dự án tại máy.
  - **⏸032**: chọn máy trong mạng nội bộ.
  - **⏸034**: `apps/hub/src/modules/tenancy/**` (vai trò), hồ sơ desktop.
- **Không sửa** (agent khác đang làm): `worker/internal/{channel,outbox,localipc,secretstore,secretmask,projects}/**`,
  `worker/internal/runner/runner.go`, `worker/cmd/hive/mcp.go`,
  `apps/hub/src/modules/{delivery,governance,tenancy,mcp}/**`, `packages/contracts/src/worker-protocol.ts`.

## Phase 1: Setup

- [ ] T001 A·nhẹ — Tạo `qa.ts` (enum, kiểu dùng chung) và xuất trong `index.ts`
  (`packages/contracts/src/qa.ts`, `packages/contracts/src/index.ts`)

## Phase 2: Foundational (chặn mọi US)

- [ ] T002 [P] A·vừa — `qaTestReport` (zod, giới hạn như [mcp-report.md](contracts/mcp-report.md)), kiểm tổng khớp khi
  không `truncated` (`packages/contracts/src/qa.ts`)
- [ ] T003 A·nhẹ — `sdlcStepAction` thêm `test-run` (`packages/contracts/src/sdlc.ts`)
- [ ] T004 A·nhẹ — `sdlcStep.labels` tuỳ chọn, tối đa 10, regex nhãn máy (`packages/contracts/src/sdlc.ts`)
- [ ] T005 A·nhẹ — `sdlcReportInput` thêm `{kind: "test-results", data: qaTestReport}` (`packages/contracts/src/sdlc.ts`)
- [ ] T006 A·vừa — `qaContract` (route [hub-api.md](contracts/hub-api.md)), gắn `sdlcContract.qa`; `pnpm openapi`
  (`packages/contracts/src/qa.ts`, `packages/contracts/src/sdlc.ts`, `openapi.json`)

## Phase 3: US1 — Chế độ "QA Automation" (P1)

- [ ] T010 [US1] A·vừa — Preset `qa-automation` bảy pha, mẫu tài liệu, cổng `team-admin`/`team-member`, bước `test-run`
  với nhãn `browser`, `qa-env` (`packages/contracts/src/sdlc-presets/qa-automation.ts`)
- [ ] T011 [US1] A·nhẹ — Đăng ký preset, sửa test đếm preset 12 → 13, kiểm không cảnh báo
  (`packages/contracts/src/sdlc-presets/index.ts`, `presets.test.ts`)

## Phase 4: US2 — TC truy vết được (P1)

- [ ] T012 [P] [US2] A·vừa — `parseTestCaseTable(md)` và `regressionCodes(md)` thuần, có test
  (`packages/contracts/src/qa.ts`, `qa.test.ts`)
- [ ] T020 [US2] C·vừa — Năm bảng QA, RLS; thêm vào `TABLES` (`apps/hub/src/modules/sdlc/schema.ts`, `rls.db.test.ts`)
- [ ] T021 [US2] C·vừa — `onQaBaseline`: baseline `test-cases` upsert TC, TC thiếu thành `retired`; baseline
  `regression` đặt `in_regression`; bảng lỗi ghi audit (`apps/hub/src/modules/sdlc/qa-cases.ts`, `phases.ts`)
- [ ] T022 [US2] C·vừa — Test db: baseline tạo, cập nhật, retire TC, hồi quy (`apps/hub/src/modules/sdlc/qa.db.test.ts`)

## Phase 5: US3 — Worker chạy và báo cáo (P1)

- [ ] T013 [P] [US3] B·nặng — Gói `testreport`: Playwright JSON, JUnit XML (pytest, Surefire `flakyFailure`,
  `rerunFailure`), che và cắt thông điệp, giới hạn số test; test bảng với `testdata/` (`worker/internal/testreport/*.go`)
- [ ] T014 [US3] B·vừa — Lệnh `hive test-summary` ([cli-test-summary.md](contracts/cli-test-summary.md))
  (`worker/cmd/hive/testsummary.go`, `worker/cmd/hive/main.go`)
- [ ] T023 [US3] C·nặng — Bước `test-run`: hành động ghi file, nhãn máy = dự án ∪ bước, prompt hướng dẫn chạy và báo
  cáo; run xong không có `test-results` thì bước lỗi (`apps/hub/src/modules/sdlc/steps.ts`)
- [ ] T025 [US3] C·nặng — Nạp `test-results`: ghi `qa_test_runs`/`qa_test_results`, gửi lại thì thay, giữ ≤ 2.000 dòng
  (ưu tiên fail), khớp TC theo khoá rồi theo mã, che + cắt 500
  (`apps/hub/src/modules/sdlc/qa-results.ts`, `mcp-tools.ts`)
- [ ] T026 [US3] C·vừa — Test đơn vị chọn dòng giữ lại và khớp TC; test db nạp và gửi lại
  (`apps/hub/src/modules/sdlc/qa-results.test.ts`, `qa.db.test.ts`)
- [ ] T027 ⏸027 [US3] B+C·nặng — Job tất định `qa_suite` (không agent): loại run, thông điệp worker, runner chạy lệnh
  test (`packages/contracts/src/worker-protocol.ts`, `worker/internal/runner/**`)
- [ ] T028 ⏸031 [US3] B·vừa — Kiểm đủ biến môi trường test của dự án trước khi chạy; thiếu thì báo tên biến, không
  chạy (`worker/internal/secretstore/**`)
- [ ] T029 ⏸032 [US3] C·vừa — Bộ test ở mạng nội bộ dùng máy chọn theo tên của 032

## Phase 6: US4 — Vòng lỗi (P1)

- [ ] T024 [US4] C·nặng — `onSdlcRunFinished` của `test-run` gọi `settleTestRun` một lần (`settled_at`)
  (`apps/hub/src/modules/sdlc/steps.ts`)
- [ ] T031 [US4] C·nặng — `settleTestRun`: cập nhật TC, `defectAction` thuần, lỗi một-mỗi-TC (mở, tăng, mở lại,
  `passing`), tạo hạng mục `bugfix` trong savepoint, audit (`apps/hub/src/modules/sdlc/qa-defects.ts`, `qa-results.ts`)
- [ ] T032 [US4] C·vừa — Test đơn vị `defectAction`; test db vòng lỗi và tạo hạng mục bugfix
  (`apps/hub/src/modules/sdlc/qa-defects.test.ts`, `qa.db.test.ts`)

## Phase 7: US5 — Chập chờn và cách ly (P2)

- [ ] T033 [US5] C·vừa — `flipCount` thuần, cờ `flaky` khi chốt; route `qa.flaky`, `qa.quarantine`; TC cách ly không
  mở lỗi (`apps/hub/src/modules/sdlc/qa-results.ts`, `qa-routes.ts`)
- [ ] T034 [US5] C·nhẹ — Test đơn vị `flipCount` (`apps/hub/src/modules/sdlc/qa-results.test.ts`)

## Phase 8: US6 — Lịch hồi quy (P2)

- [ ] T015 [P] [US6] A·vừa — `nextCronFire(expr, timeZone, after)` thuần, có test
  (`packages/contracts/src/qa.ts`, `qa.test.ts`)
- [ ] T040 [US6] C·vừa — Route lịch list/save/remove, tính `next_at`, kiểm cron và múi giờ
  (`apps/hub/src/modules/sdlc/qa-routes.ts`)
- [ ] T041 ⏸027 [US6] C·nặng — Job quét lịch mỗi phút, phát `qa_suite`, `no_machine` sau 30 phút
- [ ] T042 ⏸027 [US6] C·vừa — Trigger `merge` (cần nguồn sự kiện merge của repo test, A8) và `release`

## Phase 9: US7 — Vai trò tester (P2)

- [ ] T050 ⏸034 [US7] C·nặng — Vai trò `tester` và quyền theo bảng FR-030 (`apps/hub/src/modules/tenancy/**`)
- [ ] T051 ⏸034 [US7] A·nhẹ — Cổng nhận `team-tester` (`packages/contracts/src/sdlc.ts`)
- [ ] T052 ⏸034 [US7] E·vừa — Hồ sơ desktop `tester` (`apps/desktop/src/lib/**`)

## Phase 10: US2/US8 — Độ phủ, xu hướng, màn tester (P2)

- [ ] T030 [US8] C·vừa — Route `qa.cases`, `qa.runs`, `qa.run`, `qa.trend`, `qa.defects`, `qa.closeDefect`,
  `qa.coverage`; gắn `qa` vào router (`apps/hub/src/modules/sdlc/qa-routes.ts`, `router.ts`)
- [ ] T035 [US8] C·vừa — Test db route độ phủ và xu hướng (`apps/hub/src/modules/sdlc/qa.db.test.ts`)
- [ ] T060 [US8] D·vừa — Trang Kiểm thử của dự án: thẻ số, lần chạy, xu hướng, chập chờn, lỗi, độ phủ, lịch
  (`apps/web/src/pages/qa/**`, route)
- [ ] T061 [US8] D·vừa — Playwright cho trang Kiểm thử (`apps/web/e2e/qa.spec.ts`)
- [ ] T062 ⏸034 [US8] E·vừa — Màn Kiểm thử trên desktop (hồ sơ `tester`)

## Phase 11: Polish

- [ ] T070 C·nhẹ — Sau `git fetch && git merge origin/main`: `db:generate`, thêm `FORCE ROW LEVEL SECURITY` cho năm
  bảng (`apps/hub/db/migrations/**`)
- [ ] T071 Điều phối·nhẹ — Chạy quickstart trên máy thật có nhãn `browser`, `qa-env`

## Thứ tự

Setup → Foundational → US1 → (US2, US3 song song theo luồng) → US4 → US5 → US6 → US8 → Polish. Luồng B (Go) độc lập
với A, C, D ngay từ đầu. Các task `⏸` đợi spec tương ứng.
