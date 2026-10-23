# Implementation Plan: AI SDLC cho tester (QA Automation)

**Branch**: `ai/SPEC035` | **Ngày**: 2026-10-23 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification từ `specs/035-qa-automation/spec.md`

## Tóm tắt

Thêm luồng QA vào AI SDLC mà không thêm loại run mới và không đụng kênh worker đang làm ở spec 027:

1. **Preset `qa-automation`** trong contracts: bảy pha như FR-001. Pha verification có bước hành động mới `test-run`.
2. **Bước `test-run`** là run `sdlc` thường (agent), chạy trên máy có nhãn của dự án cộng nhãn riêng của bước
   (`labels: ["browser", "qa-env"]`). Agent chạy bộ test với reporter JSON/JUnit, gọi `hive test-summary <file>` để có
   bản tóm tắt chuẩn, rồi gọi `sdlc_report` loại `test-results`. Ảnh, video, trace ở lại máy.
3. **Parser trên worker** (`worker/internal/testreport`, Go thuần): Playwright JSON và JUnit XML (pytest, JUnit,
   Surefire có `flakyFailure`) ra cùng một `Summary`. Lệnh `hive test-summary` in JSON đúng schema `qaTestReport`.
4. **Bảng QA trong module `sdlc`**: `qa_test_cases`, `qa_test_runs`, `qa_test_results`, `qa_defects`,
   `qa_schedules`; mọi bảng có `org_id`, bật và ép RLS.
5. **Nạp và chốt**: `sdlc_report test-results` ghi lần chạy và kết quả; khi run `test-run` kết thúc,
   `onSdlcRunFinished` chốt lần chạy: cập nhật TC, tính chập chờn, mở/cập nhật lỗi, tạo hạng mục bugfix (có `deps`
   nên tạo được hạng mục và bước của nó).
6. **TC từ tài liệu**: baseline của tài liệu `test-cases` (bảng Markdown) tạo/cập nhật TC; baseline của `regression`
   đánh dấu TC thuộc bộ hồi quy.
7. **Route `sdlc.qa.*`**: TC, lần chạy, xu hướng, chập chờn, cách ly, lỗi, độ phủ, lịch.
8. **Web**: màn "Kiểm thử" của dự án.

Phần chờ spec khác: job `qa_suite` tất định và phát lịch tới worker (027), vai trò `tester` và hồ sơ desktop (034),
URL/tài khoản môi trường test (031), chọn máy trong mạng nội bộ (032).

## Technical Context

**Language/Version**: TypeScript 6 (Node 24, chạy thẳng `.ts`), Go 1.27 (worker), React 19 (web)
**Primary Dependencies**: Hono, oRPC, zod 4, Drizzle, pg-boss; Go stdlib (`encoding/xml`, `encoding/json`)
**Storage**: PostgreSQL 18, schema `hive`, RLS theo `org_id`
**Testing**: Vitest (đơn vị + `*.db.test.ts` với Testcontainers), Playwright (web), `go test`
**Target Platform**: hub Linux; worker macOS/Linux/Windows
**Project Type**: monorepo web + hub + worker
**Performance Goals**: nạp báo cáo 2.000 kết quả dưới 2 giây; màn tester dưới 1 giây với 90 ngày dữ liệu
**Constraints**: hub không nhận file đính kèm; báo cáo gửi hub dưới 1 MB; thông điệp lỗi ≤ 500 ký tự đã che
**Scale/Scope**: tới 5.000 TC mỗi dự án, 50 lần chạy mỗi ngày mỗi dự án

## Constitution Check

| Nguyên tắc | Cách tuân |
|---|---|
| I. Contract first | `packages/contracts/src/qa.ts` (schema báo cáo, TC, route `sdlc.qa.*`), `sdlcReportInput` thêm `test-results`, `sdlcStep.labels`, `sdlcStepAction` thêm `test-run`; `pnpm openapi`. Go đọc cùng fixture JSON với test TS |
| II. Tenant isolation | Năm bảng mới có `org_id`, `orgScoped`, `.enableRLS()`, `FORCE ROW LEVEL SECURITY` viết tay trong migration; thêm vào `TABLES` của `rls.db.test.ts`. Bảng con trỏ cha bằng khoá kép `(id, org_id)` |
| III. Module boundaries | Mọi thứ trong module `sdlc`; dùng `catalog`, `audit`, `knowledge`, `platform`, `tenancy` qua `index.ts`. Không sửa `mcp`, `delivery`, `governance`, `tenancy` |
| IV. Tested | Parser Go có test bảng với fixture thật (Playwright, pytest, Surefire); parser bảng TC, chập chờn, quyết định lỗi, cron là hàm thuần có Vitest; nạp, chốt, RLS có `*.db.test.ts` (chạy ở CI) |
| V. Secure by default | Hub chỉ nhận số liệu; thông điệp che bằng `redact` và cắt 500 ký tự; worker che lần nữa trước khi in. URL môi trường nằm ở kho bí mật tại máy (031) |
| VI. Ngôn ngữ | UI, lỗi tiếng Việt; code, commit tiếng Anh; spec tiếng Việt (lệch như 025–031) |
| VII. Simple to self-host | Không dịch vụ mới; một migration; không thư viện cron mới (hàm cron nhỏ tự viết) |
| Giao diện | `@xdev-hive/ui`, token màu, sáng/tối, 360 px; Playwright cho màn Kiểm thử |

Kết quả: **đạt**, một lệch đã biết (VI). Kiểm lại sau thiết kế: không đổi.

## Kiến trúc

```text
QA lead ──tạo hạng mục (preset qa-automation)──► hub (sdlc)
                                                  │ pha verification: bước test-run
                                                  ▼
                                  createSdlcRun(requiredLabels = dự án ∪ bước)
                                                  │ engine chọn máy có browser, qa-env
                                                  ▼
worker/agent: chạy bộ test (env từ kho bí mật 031) → report.json / junit.xml (ở lại máy)
              hive test-summary report.json  → JSON tóm tắt (che, cắt)
              MCP sdlc_report {kind: test-results, data}
                                                  ▼
hub: qa_test_runs + qa_test_results (chưa chốt)
     onSdlcRunFinished(test-run) → settleTestRun: TC.last_*, chập chờn, qa_defects, hạng mục bugfix
web: /projects/:key/qa  (lần chạy, xu hướng, chập chờn, lỗi, độ phủ, lịch)
```

Lịch hồi quy: hub lưu `qa_schedules`, tính `next_at` bằng hàm cron thuần. Job quét mỗi phút và phát việc tới worker cần
kênh 027 (job `qa_suite`), nên trong đợt này chỉ có CRUD và tính lần chạy kế.

## Cấu trúc file

### Luồng A: contracts

- `packages/contracts/src/qa.ts` (mới): enum, `qaTestReport`, `qaTestCase`, `qaTestRun`, `qaDefect`, `qaSchedule`,
  `qaCoverage`, `parseTestCaseTable`, `regressionCodes`, `nextCronFire`, `qaContract`.
- `packages/contracts/src/qa.test.ts` (mới).
- `packages/contracts/src/sdlc.ts`: `sdlcStepAction` thêm `test-run`; `sdlcStep.labels`; `sdlcReportInput` thêm
  `test-results`; `sdlcContract.qa = qaContract`.
- `packages/contracts/src/sdlc-presets/qa-automation.ts` (mới), `index.ts`, `presets.test.ts`.
- `packages/contracts/src/index.ts`: xuất `qa.ts`.
- `openapi.json`.

### Luồng B: worker Go

- `worker/internal/testreport/` (mới): `summary.go`, `playwright.go`, `junit.go`, `redact.go`, test và `testdata/`.
- `worker/cmd/hive/testsummary.go` (mới), một `case "test-summary"` và một dòng `usageText` trong `main.go`.

### Luồng C: hub

- `apps/hub/src/modules/sdlc/schema.ts`: năm bảng QA.
- `apps/hub/src/modules/sdlc/qa-cases.ts` (mới): đồng bộ TC từ baseline, đánh dấu hồi quy, cách ly.
- `apps/hub/src/modules/sdlc/qa-results.ts` (mới): nạp báo cáo, chốt lần chạy, chập chờn.
- `apps/hub/src/modules/sdlc/qa-defects.ts` (mới): vòng lỗi, tạo hạng mục bugfix.
- `apps/hub/src/modules/sdlc/qa-routes.ts` (mới): route `sdlc.qa.*`, độ phủ, xu hướng, lịch.
- Sửa nhỏ: `phases.ts` (`onBaseline` gọi `onQaBaseline`), `steps.ts` (`test-run` là hành động ghi file, nhãn bước,
  chốt khi xong), `mcp-tools.ts` (kind `test-results`), `router.ts` (`qa`), `rls.db.test.ts`, `index.ts`.
- `apps/hub/db/migrations/00xx_qa_automation.sql` (sinh cuối cùng, thêm `FORCE ROW LEVEL SECURITY`).

### Luồng D: web

- `apps/web/src/pages/qa/qa-page.tsx` (mới) và route trong `apps/web/src/router.tsx` hoặc nơi khai route dự án.
- `apps/web/e2e/qa.spec.ts` (mới).

### Luồng E: desktop (chờ 034)

- `apps/desktop/src/lib/account.ts`: hồ sơ `tester`; màn Kiểm thử dùng lại route `sdlc.qa.*`.

## Thiết kế từng phần

### 1. Preset (US1)

Bảy pha, id: `scope` (intake), `plan` (requirements, cổng QA lead `team-admin`), `cases` (design, cổng tester
`team-member`), `breakdown` (decomposition, `hive-tasks`, `heading`, requirementId `TC-\d{3}`), `implement`
(implementation), `verify` (verification, bước `test-run` với `labels: ["browser","qa-env"]`, tài liệu
`test-report`), `release` (release, tài liệu `regression`, cổng QA lead). Tài liệu nằm ở `qa/{NNN}-{slug}/`.

### 2. Bước `test-run` (US3)

- `sdlcStep.labels` (tuỳ chọn, tối đa 10, cùng regex nhãn máy). `startProjectRun` gộp với nhãn của dự án.
- `test-run` thuộc `WRITING_ACTIONS` (ghi `test-report.md`), và `onSdlcRunFinished` báo lỗi nếu bước chưa nhận
  `result["test-results"]`.
- Prompt hướng dẫn: đọc biến môi trường từ kho bí mật (031) theo tên, chạy runner với reporter máy đọc được, gọi
  `hive test-summary`, gửi `sdlc_report`, ghi `test-report.md` ngắn; không dán ảnh hay log.

### 3. Báo cáo và nạp (US3)

`qaTestReport`: `runner`, `suite?`, `environment?`, `commit?`, `totals {total, passed, failed, skipped, flaky}`,
`durationMs`, `cases[] {key, name, file?, status, retries, durationMs, message?}` (≤ 5.000), `truncated`. Hub:
- tìm hoặc tạo `qa_test_runs` theo `run_id` (gửi lại thì thay kết quả cũ);
- giữ tối đa 2.000 kết quả, ưu tiên `failed`, `flaky`, rồi theo thứ tự;
- nối kết quả với TC theo `test_key` (khớp đúng) rồi theo `TC-NNN` có trong tên test;
- che `message` bằng `redactSecrets` của contracts, cắt 500 ký tự.

### 4. Chốt lần chạy, chập chờn, vòng lỗi (US4, US5)

Khi run `test-run` thành công, `settleTestRun` (một lần, `settled_at`):
1. Cập nhật `last_status`, `last_run_id`, `last_run_at` của TC.
2. Chập chờn theo lịch sử: hàm thuần `flipCount(statuses) >= 2` trên 10 kết quả gần nhất (kể cả lần này).
3. `defectAction(result, case)`: `open` khi `failed` và không `quarantined`, không `flaky`; `passing` khi `passed` và có
   lỗi mở; còn lại `none`.
4. Lỗi một-mỗi-TC (`unique(case_id)`): mở mới, tăng `fail_count`, mở lại khi đã đóng.
5. Lỗi mới hoặc mở lại mà chưa có hạng mục bugfix đang chạy: tạo hạng mục `bugfix` ở dự án của TC, chủ là chủ hạng mục
   QA, trong savepoint; lỗi (chế độ không cho phép, thiếu quyền) chỉ ghi audit, lỗi vẫn mở.

### 5. TC từ tài liệu (US2)

`parseTestCaseTable(md)`: bảng có cột `Mã | Tiêu đề | Ưu tiên | Loại | Yêu cầu | Script | Khoá test` (khoá test tuỳ
chọn; nhận cả tên cột tiếng Anh). Lỗi theo dòng. Baseline `test-cases` → upsert theo `(project_id, code)`, TC của hạng
mục này không còn trong bảng thành `retired`. Bảng lỗi: ghi audit `sdlc.qa.cases.invalid` và không đổi gì (luật cổng
`sections` đã chặn phần lớn trường hợp; kiểm bảng ở luật cổng là việc sau).

### 6. Độ phủ (US2, US8)

`sdlc.qa.coverage({projectId, itemId?})`: yêu cầu lấy từ `requirement_ids` của TC đang `active` (và, khi có `itemId`, từ
tài liệu `plan` của hạng mục theo regex `(FR|AC|R|REQ)-[\w.]+`); mỗi yêu cầu: số TC, số tự động, số tự động đang pass.
Tổng: % yêu cầu có TC, có TC tự động, có TC tự động đang pass.

### 7. Lịch (US6)

`qa_schedules` với `trigger` `cron | merge | release`. `nextCronFire(expr, tz, after)` thuần (5 trường, `*`, danh
sách, khoảng, bước; múi giờ qua `Intl`). Route list/save/remove tính `next_at`. Job quét và phát việc: chờ 027.

### 8. Web (US8)

Trang `/projects/:projectKey/qa` (hoặc tab trong trang dự án): thẻ số (tỉ lệ pass 30 ngày, lỗi mở, chập chờn), bảng lần
chạy, biểu đồ cột tỉ lệ pass theo ngày, danh sách chập chờn có nút cách ly, lỗi có nút đóng, bảng độ phủ, lịch.

## Quyết định của người viết

- **D1**: Không thêm loại run. `test-run` là bước của run `sdlc` (agent); job tất định `qa_suite` đợi 027.
- **D2**: Parser ở worker (Go), hub chỉ kiểm schema. Hub không bao giờ nhận file báo cáo gốc.
- **D3**: Bảng QA nằm trong module `sdlc` (một schema, một module), không tạo module `qa` mới để tránh thêm ranh giới.
- **D4**: Chốt ở `onSdlcRunFinished` vì ở đó có `deps` để tạo hạng mục bugfix và đi tiếp.
- **D5**: Chập chờn: trong lần chạy (pass sau thử lại) hoặc lịch sử (≥ 2 lần đổi trong 10). Cách ly thủ công.
- **D6**: Tới khi có 034: QA lead = `team-admin`, tester = `team-member` ở cổng.
- **D7**: Không thêm thư viện cron.
- **D8**: Route `sdlc.qa.*` nằm trong `sdlcContract` để không sửa `app.ts`.
- **D9**: Môi trường test chỉ là tên trên hub; giá trị trong kho 031.

## Rủi ro

| Rủi ro | Giảm nhẹ |
|---|---|
| Agent bỏ qua `hive test-summary`, tự gửi số sai | Bước fail nếu không có `test-results`; schema chặt; tổng phải khớp số `cases` khi không `truncated` |
| Thông điệp lỗi lộ bí mật | Che hai lớp (worker, hub), cắt 500 ký tự; A1 cho phép tắt |
| Vòng lỗi tạo hạng mục ồn | Một lỗi mỗi TC; chập chờn và cách ly không mở lỗi; savepoint để lỗi tạo hạng mục không hỏng lần chạy |
| 027/031/034 đổi giao diện | Chỉ tham chiếu theo tên; phần phụ thuộc đánh dấu chờ trong tasks |

## Complexity Tracking

| Lệch | Vì sao | Cách đơn giản hơn bị bỏ vì |
|---|---|---|
| Spec, plan tiếng Việt (VI) | Như 025–031 | Chủ dự án đọc tiếng Việt |
| Hàm cron tự viết | Không có thư viện cron trong deps | Thêm thư viện cho một hàm 80 dòng không đáng |

## Phân đợt

1. Đợt 1 (không chờ ai): contracts + preset, parser Go + CLI, bảng + RLS, nạp + chốt + vòng lỗi, độ phủ, lịch (CRUD),
   web.
2. Đợt 2 (sau 027): job `qa_suite`, quét lịch, `no_machine` sau 30 phút, trigger `merge`.
3. Đợt 3 (sau 034): vai trò `tester`, `team-tester` ở cổng, chặn duyệt PR code sản phẩm, hồ sơ desktop.
4. Đợt 4 (sau 031): khai môi trường test theo dự án tại máy, kiểm biến đủ trước khi chạy.
