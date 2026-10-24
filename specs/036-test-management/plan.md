# Implementation Plan: Quản lý kiểm thử cấp dự án

**Branch**: `ai/SPEC036` · **Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

- Thiết kế dữ liệu: [data-model.md](data-model.md).
- Giao diện:
  - [contracts/tc-markdown.md](contracts/tc-markdown.md): định dạng file khu;
  - [contracts/hub-api.md](contracts/hub-api.md): route oRPC `testing.*`;
  - [contracts/worker-test-report.md](contracts/worker-test-report.md): loại việc `test-report`, sự kiện `test-results`;
  - [contracts/mcp-tools.md](contracts/mcp-tools.md): công cụ MCP cho agent;
  - [contracts/csv-export.md](contracts/csv-export.md): file CSV của đợt test.
- Kiểm tay: [quickstart.md](quickstart.md).

Nhãn **[Unverified]** đánh dấu điều chưa kiểm trên máy thật hoặc trên GitLab nội bộ. Máy viết plan này không có toolchain
Go, nên mã Go chỉ được CI kiểm. API báo cáo test của GitLab nội bộ chưa được kiểm (research D7); người dùng kiểm ở
quickstart bước 6.

## Tóm tắt

Hôm nay tester giữ test case (TC) trong Excel. Kết quả CI chỉ có đỏ/xanh ở `ci_runs_seen`. Kết quả chạy tay không nằm trong
hive. Plan này thêm một thư viện TC dạng Markdown trong docs home, vai trò Tester, nhận kết quả test của pipeline qua
worker, đợt test tay và dashboard theo khu và theo yêu cầu.

**Contracts** (`packages/contracts/src/`):

- `test-library.ts` (mới): bộ đọc file khu, hàm thuần, web và hub dùng chung (D2);
- `testing.ts` (mới): `testingContract`, gắn vào root contract với key `testing`, đường dẫn `/v1/testing/...`; hằng số D11;
  enum `testCaseKind`; dùng lại `qaPriority` của `qa.ts`;
- `roles.ts`: nhánh `testing` trong `PERMISSION_TREE`, bốn quyền `qa.*`, vai trò hệ thống `team-tester` (D5);
- `delivery-worker.ts`: kind `test-report`, khả năng `kinds`, sự kiện `test-results` và `pipelines` (D6);
- `delivery-worker.test.ts` và kiểu Go ở `worker/internal/delivery/` cập nhật cùng commit; chạy `pnpm openapi`.

`qa.ts` của 035 giữ nguyên (Q2 = A).

**Hub**:

- module mới `apps/hub/src/modules/qa/` (D1):
  - `schema.ts`: 13 bảng ở [data-model.md](data-model.md), bật và ép RLS;
  - hook đọc file khu khi tài liệu có phiên bản mới (D3);
  - provider quyền lưu cho thư mục TC (D4);
  - nguồn CI, nhận webhook pipeline, giao việc `test-report`, nhận `test-results` (D6, D7);
  - đợt test, kết quả tay, khoá lạc quan (D13);
  - truy vấn dashboard trên bảng chiếu `qa_case_status` (D12);
  - `mcp-tools.ts` (D14), `retention.ts` (D16), xuất CSV bằng `z.file()` (D15);
- `knowledge`: `provideDocSaved` và `provideDocAccess` đổi từ một chỗ sang danh sách; `DocAccessGrant` thêm `save` (D3, D4);
- `tenancy`: enum `team_role` thêm `tester`; `TEAM_RANK` (ba bản), nhãn vai trò (D5);
- `docsync`: export `ensureProjectInclude()` (D3b);
- `audit`: export `csvRow()`, `csvCell()` (D15);
- `scm`: không sửa. `qa` đăng ký `onScmEvent("pipeline", …)` qua `scm/index.ts`; registry giữ nhiều handler mỗi loại,
  nên `delivery/ci/gitlab-events.ts` giữ nguyên (D6);
- `delivery`: export hàm tạo việc trong transaction của người gọi, ví dụ `enqueueDeliveryJob(tx, spec)`. Hàm này thuộc
  032 T011, T020; 036 chỉ gọi (D6). `selectRunner` nhận `need: { method } | { kind }` (D6, mục "Chọn máy");
- `main.ts`: nối hook, provider, bộ nghe webhook, MCP, cron.

**Worker**:

- `internal/testreport`: thêm `Options{Library}` và regex mã thư viện (D8);
- `internal/delivery/testreport.go` (mới): client GitLab ba mode `pipeline-report`, `junit-artifact`,
  `playwright-artifact` (D7).

**Web** (`apps/web/src/pages/testing/`):

- tab Tổng quan, Thư viện, Đợt test, Nguồn CI, Việc của tôi; màn chi tiết TC (D17);
- panel lỗi theo dòng khi sửa file khu, dùng bộ đọc ở contracts;
- biểu đồ xu hướng bằng SVG, có bảng số liệu đi kèm;
- bộ chọn vai trò và nhãn quyền thêm Tester.

**Phụ thuộc 032**: US3 và phần CI của dashboard cần 032 T011 (`delivery_jobs`), T012 (nhận `deliveryEvent`), T017 (nối
`channel` ở worker), T020 (hàng việc theo đăng ký). Bốn task chưa xong ngày 2026-10-23. Thứ tự làm ở mục
[Giai đoạn](#giai-đoạn).

036 cần thêm từ bốn task đó:

- T011: hàm tạo việc nhận `maxWaitSec` theo việc (mặc định 900, `test-report` 86.400). Không có thì `qa` tạo lại việc
  khi nhận `runner_offline`, tới đủ 24 giờ (D6).
- T012: điểm nối nhận sự kiện theo kind, để `qa` nhận `test-results` và `pipelines` mà `delivery` không import `qa`.
- T017: worker xử lý `op = list` và gửi sự kiện `pipelines`.
- T020: khả năng `kinds` và `selectRunner` nhận `need: { method } | { kind }`.

## Technical Context

| Mục | Giá trị |
|---|---|
| Ngôn ngữ | TypeScript (hub chạy bằng Node, web React, contracts); Go 1.27.2 (worker) |
| Phụ thuộc mới | không. Biểu đồ vẽ bằng SVG; CSV dùng `audit/csv.ts`; khớp glob dùng `contracts/glob.ts` |
| Lưu trữ | Postgres: 13 bảng mới, giá trị enum `tester`; migration sau `0089_machine_keys_run_git_tokens.sql` |
| Kiểm thử | vitest cho bộ đọc và hàm thuần; `*.db.test.ts` cho bảng, RLS, nâng cấp migration; Playwright cho web; `go test` trên ba OS |
| Nền tảng | hub và web như hiện tại; worker Windows, macOS, Linux |
| Ràng buộc | hub không gọi GitLab (FR-022); tên test, log, thông báo lỗi không về hub (Q3 = A); schema sự kiện strict |
| Quy mô | 5.000 TC, 90 ngày lịch sử, 20 người xem, mỗi góc nhìn dưới 3 giây P95 (SC-005); thiết kế chịu 20.000 TC (A8) |

## Constitution Check

Kiểm trước research và kiểm lại sau thiết kế. Cả hai lần đều đạt.

| Nguyên tắc | Đạt | Ghi chú |
|---|---|---|
| I. Contract first | có | zod ở `testing.ts`, `test-library.ts`; `pnpm openapi`; kind, trường `kinds` và nhánh union mới là thay đổi cộng thêm, cập nhật `delivery-worker.test.ts` và kiểu Go cùng commit |
| II. Tenant isolation | có | 13 bảng có `org_id`, bật và ép RLS, thêm vào `rls.db.test.ts`; truy vấn qua `withTenant()`; kiểm quyền trong `qa`; ghi audit khi đổi nguồn CI, đóng/mở đợt, đổi cài đặt |
| III. Module boundaries | có | `qa` import module khác qua `index.ts`; `knowledge`, `delivery`, `docsync`, `scm` không import `qa`, nhận hook lúc khởi động; `pnpm deps` |
| IV. Tested before merged | có | mỗi task kèm test; test nâng cấp migration cho enum `tester`; Go test trên ba OS |
| V. Secure by default | có | token GitLab chỉ ở kho tại máy worker; ghi chú tester qua `csvCell()`; tester không có quyền task, run, artifact |
| VI. Vietnamese UI, English code | có | thông báo lỗi bộ đọc, lỗi quyền, nhãn web tiếng Việt; mã, bảng, commit tiếng Anh |
| VII. Postgres only | có | không thêm kho dữ liệu; bảng chiếu thay materialized view |
| UI | có | shadcn/Base UI, token, rộng 360 px, sáng và tối, phím tắt, test Playwright theo role |
| ADR | cần | ADR 0038: định dạng TC Markdown và hook tài liệu ghép được (xem Complexity Tracking) |

## Cấu trúc mã

```text
packages/contracts/src/
├── test-library.ts              # mới: bộ đọc file khu (D2)
├── testing.ts                   # mới: testingContract, hằng số, testCaseKind
├── roles.ts                     # nhánh testing, team-tester
├── delivery-worker.ts           # kind test-report, kinds, sự kiện test-results và pipelines
├── delivery-worker.test.ts      # kiểm schema mới
└── index.ts                     # gắn testing vào contract

apps/hub/src/modules/qa/         # module mới
├── schema.ts                    # 13 bảng
├── library.ts                   # áp dụng file khu, mã đã dùng, ngừng dùng
├── doc-hooks.ts                 # hook lưu tài liệu, provider quyền lưu
├── access.ts                    # kiểm thành viên đội + quyền qa.*
├── ci-sources.ts                # cấu hình nguồn CI, ensureProjectInclude
├── ci-intake.ts                 # webhook pipeline → việc test-report → test-results
├── rounds.ts                    # đợt test, người được giao, kết quả tay
├── status.ts                    # bảng chiếu qa_case_status
├── dashboard.ts                 # góc nhìn theo khu, yêu cầu, xu hướng, chập chờn
├── export.ts                    # CSV của đợt
├── mcp-tools.ts                 # qa_get_case, qa_list_cases
├── retention.ts                 # cron 37 3 * * *
├── router.ts
└── index.ts

apps/hub/src/modules/knowledge/  # hook và provider thành danh sách, grant save
apps/hub/src/modules/tenancy/    # enum tester, TEAM_RANK, nhãn
apps/hub/src/modules/artifacts/  # TEAM_RANK (hai bản)
apps/hub/src/modules/docsync/    # export ensureProjectInclude
apps/hub/src/modules/audit/      # export csvRow, csvCell
apps/hub/src/main.ts             # nối module qa
apps/hub/db/migrations/          # hai migration: thêm enum tester, rồi bảng qa_*

worker/internal/testreport/      # Options{Library}, regex mã thư viện
worker/internal/delivery/
└── testreport.go                # mới: client GitLab ba mode

apps/web/src/pages/testing/      # mới: các tab, chi tiết TC, biểu đồ SVG
apps/web/src/router.tsx          # /projects/$key/testing
apps/web/src/lib/                # nhãn quyền, vai trò

docs/adr/0038-*.md               # mới
```

## Giai đoạn

| Giai đoạn | Nội dung | Phụ thuộc |
|---|---|---|
| 1. Nền | contracts, enum `tester`, schema `qa`, đổi hook `knowledge` sang danh sách, ADR 0038 | không |
| 2. US1, US2 | bộ đọc, áp dụng file khu, quyền lưu thư mục TC, vai trò Tester, trang Thư viện | giai đoạn 1 |
| 3. US4, US5 tay | đợt test, kết quả tay, Việc của tôi, dashboard với dữ liệu tay | giai đoạn 2 |
| 4. US6, US7 | MCP cho agent, xuất CSV | giai đoạn 2 |
| 5. US3 | nguồn CI, việc `test-report`, client GitLab ở worker, phần CI của dashboard, giữ dữ liệu | giai đoạn 1 và 032 T011, T012, T017, T020 |

Giai đoạn 3 và 4 làm song song được. Giai đoạn 5 bắt đầu khi 032 xong bốn task trên. Phần worker
(`internal/testreport`, `testreport.go`) viết và test được trước, vì không cần `channel`.

## Quyết định của người viết

Chưa được chủ dự án chốt; đổi thì sửa task tương ứng.

- Q1 = A: worker đọc báo cáo test của pipeline GitLab sau webhook. Hub không gọi GitLab.
- Q2 = A: thư viện tách khỏi TC theo hạng mục của 035. QA gate của 035 giữ nguyên.
- Q3 = A: không lưu thông báo lỗi. Dashboard dẫn sang job GitLab.
- Tên: module hub `qa`, contracts `testing.ts`, route `/v1/testing/...`, trang `/projects/$key/testing` (D1).

## Complexity Tracking

| Điểm lệch | Vì sao cần | Phương án đơn giản hơn đã loại |
|---|---|---|
| `provideDocSaved`, `provideDocAccess` đổi từ một chỗ sang danh sách (API công khai của `knowledge`) | `docsync` chiếm `provideDocSaved`, sdlc chiếm `provideDocAccess`; `qa` cần cả hai điểm nối | hook gộp trong `knowledge`: `knowledge` phải biết `docsync`, sdlc và `qa`, trái nguyên tắc III |
| `DocAccessGrant` thêm `save` | tester lưu thẳng file TC mà không có `manage` trên tài liệu khác (FR-011) | cho tester vai trò `member`: mở cả task, run (trái FR-013) |
| Enum `team_role` thêm `tester` bằng migration riêng | `ALTER TYPE … ADD VALUE` không dùng được giá trị mới trong cùng transaction [Unverified với drizzle-kit hiện tại] | vai trò tuỳ chỉnh thay enum: không có `TEAM_RANK`, mọi kiểm `requireTeamRole` phải sửa |
| Ba bản `TEAM_RANK` cùng sửa | các bản nằm ở `tenancy` và `artifacts`, chưa gộp | gộp ba bản trong spec này: ngoài phạm vi; ghi việc riêng |
| Tên khác nhau: module `qa`, contracts `testing.ts`, `qa.ts` của 035 | `delivery/testing/` đã là tên helper test; `qa.ts` đã là của 035 | đổi tên `qa.ts` của 035: đổi API đã phát hành |
| ADR 0038 | định dạng TC Markdown và hook ghép được là quyết định kiến trúc | ghi trong research: constitution đòi ADR cho quyết định kiến trúc |
| Khả năng worker thêm `kinds`; `selectRunner` nhận `need: { method } \| { kind }` | việc `test-report` không phải cách triển khai, nhưng cần cùng hàng việc, lease và chọn máy của 032 | thêm `test-report` vào `DELIVERY_METHODS`: màn môi trường deploy liệt kê nó như cách triển khai |
