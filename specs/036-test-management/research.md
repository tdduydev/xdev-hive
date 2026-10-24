# Research: Quản lý kiểm thử cấp dự án

**Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Nhãn:

- **[Unverified]**: chưa kiểm trên máy thật hoặc trên GitLab nội bộ.
- **[Inference]**: suy ra từ mã và tài liệu đã đọc, chưa chạy thử.

Mặc định đã chốt: Q1 = A (worker đọc báo cáo test của pipeline), Q2 = A (thư viện tách khỏi TC theo hạng mục của 035),
Q3 = A (không lưu thông báo lỗi).

## D1. Module hub mới `qa`

**Quyết định**: nghiệp vụ nằm trong `apps/hub/src/modules/qa/`. Module này import `knowledge`, `catalog`, `tenancy`,
`audit`, `delivery`, `mcp` chỉ qua `index.ts`.

**Lý do**:

- Thư viện TC, đợt test, nguồn CI và dashboard là một nghiệp vụ riêng, có bảng riêng.
- `sdlc` đã giữ TC theo hạng mục (035). Đặt chung làm mờ ranh giới Q2 = A.
- Tên `delivery/testing/` đã dùng cho helper test (`fake-http.ts`, `fake-ssh.ts`, `sshd.ts`), nên không đặt tên `testing`.
- Luật `.dependency-cruiser.cjs` áp theo mẫu `^apps/hub/src/modules/([^/]+)/`, nên module mới tự vào luật, không sửa cấu
  hình.

**Phương án đã loại**:

- Đặt trong `sdlc`: lẫn với QA gate 035, module đã lớn.
- Đặt trong `knowledge`: knowledge không có khái niệm đợt test, kết quả, nguồn CI.

**Hệ quả**: `qa` phụ thuộc `knowledge`, `docsync`, `scm` và `delivery`. Các module đó KHÔNG ĐƯỢC import `qa`; `qa` tiêm
hook vào chúng lúc khởi động hub (D3, D4, D6).

## D2. Định dạng file khu và bộ đọc dùng chung

**Quyết định**: bộ đọc nằm ở `packages/contracts/src/test-library.ts`, hàm thuần, không phụ thuộc Node. Web dùng để báo
lỗi ngay khi gõ; hub dùng khi đọc lại file. Định dạng đầy đủ ở [contracts/tc-markdown.md](contracts/tc-markdown.md).

Tóm tắt định dạng:

1. Dòng `# <KHU> <tên khu>` đầu file. `<KHU>` khớp `^[A-Z][A-Z0-9]{1,15}$`.
2. Mỗi TC bắt đầu bằng `### TC-<KHU>-<SỐ> <tên>`. `<SỐ>` khớp `\d{3,5}`. `<KHU>` trong mã PHẢI trùng `<KHU>` của file.
3. Sau tiêu đề là danh sách trường `- <Tên trường>: <giá trị>`: Ưu tiên, Loại, Yêu cầu, Nhãn, Script, Dữ liệu test,
   Điều kiện trước, Ghi chú.
4. Sau danh sách là bảng bước `| # | Thao tác | Kết quả mong đợi |`.
5. Chữ ngoài các khối trên (đoạn mô tả khu, ghi chú chung) được giữ nguyên trong tài liệu và bộ đọc bỏ qua.

Bộ đọc trả `{ area, cases[], errors[] }`. Mỗi lỗi có số dòng và thông điệp tiếng Việt. Có lỗi thì hub không áp dụng file
(FR-004).

**Lý do**:

- Markdown đọc được trong repo, trong editor web và trong ngữ cảnh agent; không cần định dạng thứ hai.
- Tiêu đề `###` có mã giúp tìm TC bằng grep và giúp liên kết neo trong trang tài liệu.
- Một bộ đọc ở contracts làm web và hub báo cùng lỗi (FR-005).

**Phương án đã loại**:

- YAML front matter mỗi TC: khó đọc với tester quen Excel, bảng bước khó viết.
- Một TC mỗi file: 20.000 TC (A8) thành 20.000 file, docsync và editor web chậm hơn [Inference].
- Bảng Excel nhập vào: không sửa được hai phía, trái FR-005.

## D3. Đọc lại file khi tài liệu có phiên bản mới

**Quyết định**:

1. Đổi `provideDocSaved` trong `knowledge/docs.ts` từ một chỗ sang danh sách hook. `docsync` và `qa` cùng đăng ký.
2. Hook của `qa` lọc key có tiền tố `project/<key>/<thư mục TC>/`, rồi đọc và áp dụng file **trong cùng transaction
   lưu**. Key tài liệu không có đuôi `.md` và mỗi đoạn đã qua `slug()` (`docsync/paths.ts:36`, `keyFromPath()`), nên
   tiền tố so bằng bản slug của thư mục TC.
3. Áp dụng theo cả file: xoá, thêm, sửa TC của khu trong một lần. Có lỗi thì giữ bộ TC cũ, ghi lỗi và số dòng vào
   `qa_areas.parse_errors` (FR-004).
4. `change = "archive"` chuyển mọi TC của khu sang "Ngừng dùng". `change = "restore"` đọc lại file.

**Lý do**:

- `docChanged()` đã gọi hook trong transaction lưu. Áp dụng tại đó làm thư viện và tài liệu cùng phiên bản.
- File khu tối đa vài trăm TC [Inference từ A8: 20.000 TC / 200 khu ≈ 100 TC mỗi khu], đọc trong transaction đủ nhanh.
- Sửa web và sửa repo đều đi qua `docChanged()` (docsync ghi tài liệu bằng `DOC_SYNC_ACTOR`), nên một hook phủ cả hai
  phía (FR-005).

**Phương án đã loại**:

- Xếp job đọc sau: thư viện trễ hơn tài liệu, phải thêm trạng thái "đang đọc".
- Thay hook của docsync bằng một hook gộp: `knowledge` phải biết cả hai module.

**Hệ quả**: thứ tự gọi hook không có ý nghĩa nghiệp vụ. Một hook lỗi làm hỏng transaction lưu; hook của `qa` bắt lỗi đọc
file và ghi vào `qa_areas`, chỉ ném lỗi khi database lỗi.

## D3b. Thư mục TC phải được docsync đồng bộ

**Quyết định**: thư mục TC mặc định là `test-cases/`, tính từ `root` của docs home (FR-001). Khi dự án bật thư viện,
`qa` kiểm include của docs home có phủ `<root><thư mục TC>/**` không. Chưa phủ thì thêm glob đó vào include.

**Lý do**:

- `projectDocsSettings` (`packages/contracts/src/projects.ts:373`) đặt mặc định `root = "docs/"` và include là
  `DOC_DEFAULT_INCLUDE` (`docs/**`, `doc/**`, `specs/**`, `adr/**`, `**/adr/**`, `**/README.md`, `*.md`).
- Với mặc định, file TC nằm ở `docs/test-cases/*.md` trong repo. `docs/**` đã phủ đường dẫn này, nên `qa` không phải sửa
  gì.
- Include không phủ thư mục TC trong hai trường hợp: `root` rỗng hoặc ngoài `docs/`, hoặc admin đã đổi include. Hai trường
  hợp này cần bước thêm glob.

**Phương án đã loại**:

- Bắt admin tự sửa include: dễ quên; file sửa trong repo không về hub và không có lỗi nào báo cho tester.
- Thêm `**/test-cases/**` vào `DOC_DEFAULT_INCLUDE` cho mọi dự án: kéo thư mục cùng tên của dự án không dùng thư viện.

**Hệ quả**:

- Include nằm ở cột `doc_homes.include` (`docsync/schema.ts`), ghi bởi `configureProjectHome()` (`docsync/homes.ts:196`).
  Hàm này gọi provider git và đòi quyền quản trị docs home, nên `qa` không gọi lại hàm này.
- `docsync/index.ts` hôm nay chỉ export hàng việc, asset, router, webhook, Word. `docsync` thêm export
  `ensureProjectInclude(tx, actor, projectId, glob)`:
  1. Không có docs home → trả `"no-home"`; web hiện cảnh báo "Dự án chưa có docs home".
  2. Include đã phủ `glob` → trả `"covered"`.
  3. Còn lại → thêm `glob` vào include, ghi audit, xếp `queuePull()` để đọc file đang có → trả `"added"`.
- [Inference] Phần kiểm "đã phủ" dùng `packages/contracts/src/glob.ts`, cùng bộ khớp mà docsync dùng cho include.
- Đường dẫn TC tính từ `doc_homes.root`, giống mọi tài liệu khác của docs home.
- `keyFromPath()` giữ key đã ghim khi file đổi tên trong repo. File chuyển ra khỏi thư mục TC trong repo vẫn giữ key cũ, nên
  vẫn là file khu [Inference]. Thư viện xét theo key, không theo đường dẫn repo; quickstart có bước kiểm trường hợp này.

## D4. Quyền lưu theo thư mục cho `qa.cases.write`

**Quyết định**:

1. Thêm trường `save` vào `DocAccessGrant` (`knowledge/access.ts`) và trường `saveGranted` vào `Scope`.
2. `authorize()` cho qua `action = "manage"` khi `reader.kind === "user"` và `scope.saveGranted`. Run vẫn không được lưu.
3. Đổi `provideDocAccess` sang danh sách provider. `docGrant()` gộp kết quả bằng OR từng trường.
4. Provider của `qa` trả `{ read, propose, save }` cho key trong thư mục TC khi người dùng có `qa.cases.write` ở đội của
   dự án. Key ngoài thư mục TC trả `null`.

**Lý do**:

- Lưu thẳng hôm nay cần `manage` (team admin). Editor web dùng `propose`. Tester cần lưu thẳng file TC mà không có quyền
  quản trị tài liệu khác (FR-011).
- Provider sdlc đang chiếm chỗ duy nhất (`main.ts:250`). Chuyển sang danh sách giữ nguyên hành vi sdlc.

**Phương án đã loại**:

- Cho tester vai trò `member`: mở cả task, run (trái FR-013).
- Bắt tester đề xuất mọi thay đổi để admin duyệt: thêm việc duyệt cho mỗi lần sửa TC, trái US1.

**Hệ quả**: đổi API công khai của `knowledge`. Test của sdlc cho `provideDocAccess` phải chạy lại. Ghi vào Complexity
Tracking.

## D5. Vai trò `team-tester` và nhóm quyền kiểm thử

**Quyết định**:

1. Quyền mới (FR-010, chốt tên): `qa.read`, `qa.cases.write`, `qa.record`, `qa.rounds.manage`. Nhánh mới `testing` trong
   `PERMISSION_TREE`, nhãn web "Kiểm thử".
2. Enum `team_role` thêm giá trị `tester` (`ALTER TYPE hive.team_role ADD VALUE 'tester'`).
3. `TEAM_RANK.tester = 2` (bằng `ba`), nên mọi kiểm `requireTeamRole(..., "member")` từ chối tester (FR-013).
4. `TEAM_SYSTEM_ROLE.tester = "team-tester"`; thêm `team-tester` vào enum `systemRoleId` và danh sách `systemRoles`.
5. Tập `TEAM_TESTER` liệt kê đủ quyền của FR-012, như `TEAM_BA`.
6. Vai trò có sẵn (FR-014):

| Vai trò | Quyền kiểm thử | Cách thêm |
|---|---|---|
| `owner`, `admin` | cả bốn | đã nhận mọi quyền [Inference: hai vai trò này lấy `PERMISSIONS`] |
| `team-admin` | cả bốn | thêm `qa.cases.write`, `qa.rounds.manage` vào `TEAM_ADMIN_EXTRA` |
| `member`, `team-member` | `qa.read`, `qa.record` | thêm `qa.record` vào `MEMBER_EXTRA` |
| `team-viewer` | `qa.read` | tự có vì quyền `.read` không thuộc quản trị vào viewer |
| `team-ba` | `qa.read` | thêm vào `TEAM_BA` |

7. Kiểm quyền trong `qa`: `requireTeamRole(tx, userId, teamId, "viewer")` (là thành viên đội, hoặc owner/admin tổ chức),
   rồi `effectivePermissions(tx, userId, teamId).has(<quyền>)`. Thiếu quyền thì `ForbiddenError` tiếng Việt nêu tên quyền
   (FR-016).

**Lý do**:

- `effectivePermissions` cộng quyền của vai trò tổ chức. Một `member` tổ chức có `qa.record` ở mọi đội; bước kiểm thành
  viên đội giữ FR-015.
- Liệt kê đủ quyền như `team-ba` để thêm quyền mới sau này không tự lọt vào tester.

**Hệ quả**:

- Sửa nhãn vai trò ở `tenancy/permissions.ts` (`TEAM_LABEL`), `knowledge/reviews.ts:1010`, `knowledge/editor.ts:732`,
  `sdlc/access.ts` (`TEAM_ROLE_ID`) và bộ chọn vai trò trên web (`teams-page.tsx`, `members-page.tsx`,
  `invite-form.tsx`, `onboarding-invite-form.tsx`, `lib/roles.ts`).
- Có ba bản `TEAM_RANK`: `tenancy/permissions.ts:11`, `artifacts/access.ts:198`, `artifacts/service.ts:64`. Cả ba PHẢI
  thêm `tester: 2`. Hai bản ở `artifacts` so với `member`, nên tester không được ghi artifact.
- Ngày 2026-10-23 không có lệnh kiểm `requireTeamRole(..., "ba")` trong hub. Kiểm như vậy sau này sẽ cho cả tester qua
  [Inference]; test quyền của US2 phát hiện trường hợp này.
- `Record<TeamRole, …>` làm typecheck báo mọi map thiếu `tester`.
- Vai trò tuỳ chỉnh đã nhân bản trước không nhận quyền mới (edge case của spec). Không migrate.
- `ALTER TYPE … ADD VALUE` không chạy được trong transaction cùng câu dùng giá trị mới [Unverified với drizzle-kit hiện
  tại]. Migration tách riêng câu thêm giá trị. Thêm test nâng cấp.

## D6. Loại việc worker `test-report` và sự kiện `test-results`

**Quyết định**: mở rộng `packages/contracts/src/delivery-worker.ts`. Chi tiết ở
[contracts/worker-test-report.md](contracts/worker-test-report.md).

- `DELIVERY_JOB_KINDS` thêm `test-report`. `deployId` là `null`.
- `params` là union theo `op`:
  - `read`: `{ op, projectPath, pipelineId, mode, jobFilter, artifactPath? }`. `mode` là `pipeline-report`,
    `junit-artifact`, `playwright-artifact`. Hai mode artifact bắt buộc `artifactPath`.
  - `list`: `{ op, projectPath, ref?, updatedAfter?, limit }`, `limit` tối đa 500. Dùng cho "Lấy lại kết quả" và đọc ban
    đầu (D18).
- `deliveryEvent` thêm hai nhánh strict: `test-results` (kết quả của `read`) và `pipelines` (một trang kết quả của `list`,
  tối đa 100 pipeline). Sự kiện `finished` vẫn đóng việc.
- `target` là địa chỉ GitLab của nguồn; `credential` là tên credential GitLab trong kho tại máy (032 `credentialRef`).

**Lý do**:

- Dùng lại hàng việc, chọn máy, lease và outbox của 032. Không thêm kênh thứ hai.
- Thêm kind và thêm nhánh union là thay đổi cộng thêm. Worker cũ không báo khả năng `test-report` nên không được chọn
  [Inference từ cách chọn máy theo khả năng của 032 FR-013].

**Nhận webhook pipeline**:

1. `qa` gọi `onScmEvent("pipeline", handler)` (`scm/index.ts:43`). `createScmEventRegistry()` giữ một Set handler mỗi
   loại sự kiện (`scm/handlers.ts`), nên handler của `delivery/ci/gitlab-events.ts` vẫn chạy và file đó giữ nguyên.
2. Handler chạy trong transaction của webhook (`ctx.tx`, `orgId`, `projectId`) và PHẢI idempotent: khoá
   `(source_id, pipeline_id)` của `qa_ci_runs` chặn dòng thứ hai khi GitLab gửi lại webhook.
3. Handler tìm nguồn có `qa_ci_sources.repo_path` bằng `event.repo` trong dự án của webhook. Không có nguồn thì bỏ qua.
4. Handler bỏ qua pipeline còn chạy (`status` thuộc `CI_ACTIVE_STATUSES`) và pipeline không khớp `branch_filter`.
   Pipeline đã xong thì tạo dòng `qa_ci_runs` (`read_state = waiting`) và một việc `test-report` `op = read`.
5. `CiPipeline.source === "merge_request_event"` đánh dấu pipeline MR; `ref`, `sha`, `status` lấy từ `CiPipeline`.
   Webhook không gửi thời điểm bắt đầu (`startedAt: null`), nên worker gửi lại trong `test-results`.
6. [Unverified] Repo nguồn có thể khác repo của dự án (dự án mẫu để test ở một repo e2e riêng). Chưa kiểm webhook của
   repo thứ hai có tới được hub qua URL webhook của dự án và qua bước kiểm secret của `scm` hay không. Quickstart có bước
   kiểm; nếu không tới được thì thêm cách khai webhook cho nguồn ở tasks.

**Hệ quả**:

- US3 phụ thuộc 032 T011 (bảng `delivery_jobs`), T012 (nhận sự kiện, bỏ trùng `(jobId, seq)`), T017 (nối `channel`),
  T020 (hàng việc theo đăng ký). Bốn task chưa xong ngày 2026-10-23.
- Tài liệu 032 chưa đặt tên hàm tạo việc. `qa` cần `delivery/index.ts` export một hàm tạo dòng `delivery_jobs` trong
  transaction của người gọi, ví dụ `enqueueDeliveryJob(tx, spec)` [Inference]. Tên chốt khi làm 032 T011.
- Kết quả về qua sự kiện `test-results` và `pipelines` của việc. `delivery` không biết `qa`: `qa` đăng ký bộ nhận theo
  kind `test-report` lúc khởi động, cùng cách hook của D3 [Inference: 032 chưa có điểm nối này; thêm khi làm T012].
- Thời gian chờ máy: 032 FR-014 cho việc chờ tối đa 15 phút rồi `failed runner_offline`; 032 A4 ghi giá trị này chưa đo
  và đổi được ở plan. FR-022 của 036 cần 24 giờ.
  - Ưu tiên: hàm tạo việc nhận `maxWaitSec` theo việc, mặc định 900, `test-report` dùng 86.400.
  - Dự phòng: `qa` nhận `runner_offline` thì tạo việc mới cho cùng pipeline tới khi đủ 24 giờ tính từ
    `qa_ci_runs.waiting_since`, rồi chuyển `expired`.
- Cập nhật `packages/contracts/src/delivery-worker.test.ts` và kiểu Go ở `worker/internal/delivery/` cùng commit
  (nguyên tắc I). Giao thức delivery không dùng `fixtures/worker-protocol.json`; file đó là giao thức run.

**Chọn máy**:

- Khả năng của worker thêm trường `kinds` (mảng, mặc định `[]`). `test-report` không vào `DELIVERY_METHODS`, để cấu hình
  môi trường deploy không chọn được nó.
- `RunnerNeeds.method` đổi thành `need: { method } | { kind }`. `selectRunner`
  (`apps/hub/src/modules/delivery/runner-select.ts`) lọc theo thứ tự: trực tuyến, có `test-report` trong `kinds`, có
  `credential` của nguồn.
- Danh sách máy: mọi máy của tổ chức, đăng ký cũ trước, `requireLabel: false`. Nguồn CI không có danh sách máy riêng.
- Bốn thông điệp chờ riêng cho `test-report` ([contracts/worker-test-report.md](contracts/worker-test-report.md), mục
  "Chọn máy").
- [Inference: `selectRunner` chưa có nơi gọi ngoài test, nên tổng quát hoá chưa đổi hành vi đang chạy. Kiểm lại khi làm
  032 T020.]

**Phương án đã loại**: thêm `test-report` vào `DELIVERY_METHODS`. Màn môi trường deploy sẽ liệt kê nó như một cách
triển khai.

## D7. Worker đọc GitLab theo ba cách

**Quyết định**:

| Mode | API GitLab | Có "Chập chờn" | Dùng khi |
|---|---|---|---|
| `pipeline-report` | `GET /projects/:id/pipelines/:pipeline_id/test_report`, `…/test_report_summary` | không | job khai `artifacts:reports:junit` |
| `junit-artifact` | `GET /projects/:id/pipelines/:pipeline_id/jobs`, `GET /projects/:id/jobs/:job_id/artifacts/*path` | không | file JUnit nằm trong `artifacts:paths` |
| `playwright-artifact` | như trên | có | file Playwright JSON nằm trong `artifacts:paths` |

Luồng chung:

1. Worker gọi API bằng token trong kho tại máy. Hub không gọi GitLab (FR-022).
2. Worker lọc job theo `jobFilter` tại máy; tên job không rời máy.
3. `pipeline-report`: suite của báo cáo mang tên job [Inference]; `test_report_summary` cho `build_ids` của mỗi suite
   [Unverified], dùng để gắn mã job xấu nhất cho từng TC.
4. Worker bỏ `system_output`, `stack_trace`, `attachment` ngay khi đọc. Chỉ giữ `status`, `name`, `classname`,
   `execution_time` trong bộ nhớ để tìm mã TC.
5. Hai mode artifact gọi `testreport.Parse` (D8).
6. Worker gửi một sự kiện `test-results`, rồi `finished`.

Trạng thái GitLab sang trạng thái CI của hive: `success` → Đạt; `failed`, `error` → Không đạt; `skipped` → Bỏ qua
[Unverified: danh sách giá trị `status` của bản GitLab nội bộ].

**Lý do**:

- Dự án mẫu khai `artifacts:reports:junit: .report/junit.xml` (đọc `.gitlab-ci.yml` của repo e2e). Mode
  `pipeline-report` đọc được mà không sửa CI của dự án.
- [Unverified] Không rõ file `reports:junit` tải được qua API artifact theo đường dẫn hay không, nên mode artifact chỉ dành
  cho file có trong `artifacts:paths`.

**Hệ quả**:

- Không có "Chập chờn" ở mode `pipeline-report`. Dashboard ghi rõ "nguồn này không báo chập chờn". FR-056 vẫn tính TC đổi
  Đạt/Không đạt nhiều lần.
- Pipeline chưa có báo cáo (`total_count = 0`) cho trạng thái đọc "không có báo cáo", không phải lỗi.
- Cần kiểm trên GitLab nội bộ ở quickstart bước 6. Việc kiểm do người dùng chạy; agent KHÔNG ĐƯỢC dò cổng hay quét máy nội
  bộ.

## D8. Mở rộng bộ đọc `testreport`

**Quyết định**:

1. Thêm regex mã thư viện `\bTC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}\b` bên cạnh regex 035 `\bTC-[0-9]{3,5}\b`.
2. Thêm tuỳ chọn `Options{ Library bool }`. `Library = true`: chỉ nhận mã thư viện; test có nhiều mã khác nhau vào số
   `ambiguous` thay vì trả lỗi; test không có mã vào số `unmapped`.
3. `Library = false` giữ đúng hành vi hiện tại của `hive test-summary` (035 FR-007).
4. Giới hạn giữ nguyên: `MaxBytes` 32 MiB, `MaxCases` 5.000, thứ tự gộp failed > flaky > skipped > passed.
5. Hub so mã với thư viện và lập danh sách mã lạ (tối đa 200 mã). Worker không biết thư viện.

**Lý do**: FR-023 lệch có chủ ý với 035. Giữ một bộ đọc tránh hai luật gộp khác nhau.

**Liên quan contracts**: `packages/contracts/src/qa.ts` là của 035 (`qaCaseCode` dạng `TC-001`, `qaTestReport`, `sdlc.qa`).
036 không sửa file này. 036 dùng lại `qaPriority` (P1, P2, P3); loại TC có ba giá trị nên khai enum mới
`testCaseKind` trong `testing.ts`.

**Hệ quả**: `codeIn()` cần nhánh mới; test Go phủ cả hai chế độ, chạy trên ba OS (nguyên tắc IV).

## D9. A1: mã TC nằm trong tên test

**Quyết định**: tài liệu hướng dẫn đặt mã TC trong tiêu đề test, ví dụ
`test("TC-MPI01-001 Tìm bệnh nhân theo mã @smoke", …)`. Không hỗ trợ mã đặt bằng tuỳ chọn `tag:` của Playwright.

**Bằng chứng**:

- Repo e2e của dự án mẫu dùng Playwright 1.63.0, ghi tag trong tiêu đề (`… @smoke`), bật reporter JUnit khi chạy CI
  (`.report/junit.xml`).
- [Inference] Reporter JUnit ghi tiêu đề test vào thuộc tính `name` của `testcase`, nên mã trong tiêu đề tới được báo cáo
  GitLab.
- [Unverified] Tag khai bằng `tag:` có nằm trong báo cáo JUnit hay không.

**Hệ quả**: quickstart bước 6 kiểm một test thật có mã trong tiêu đề hiện đúng trên dashboard.

## D10. A6: mã yêu cầu

**Quyết định**: trường "Yêu cầu" nhận danh sách cách nhau bằng dấu phẩy. Mỗi mã khớp một trong hai mẫu:

| Loại | Regex | Ví dụ |
|---|---|---|
| Mã spec | `^(\d{3}/)?(FR\|AC\|NFR\|US)-\d{3,4}(\.\d+)?$` | `FR-001`, `036/FR-010`, `AC-012.2` |
| Mã SRS | `^(?!(FR\|AC\|NFR\|US)(\d\|$))[A-Z][A-Z0-9]{2,15}$` | `OPD02`, `BIL101`, `OPD02P00108`, `COMMON` |

- Mã SRS gồm 3–16 chữ hoa hoặc số, bắt đầu bằng chữ, không có dấu gạch. Hai mẫu không giao nhau, vì mã spec luôn có `-`.
- Mẫu SRS không nhận mã bắt đầu bằng `FR`, `AC`, `NFR`, `US` mà theo sau là chữ số hoặc hết mã. Mã gõ thiếu như `FR001`,
  `US01`, `NFR` vẫn báo lỗi, kèm gợi ý dạng mã spec (contracts/tc-markdown.md). `ACC01`, `USR01` vẫn là mã SRS.
- Hive giữ nguyên mã, không đổi hoa thường. `opd02` báo lỗi.
- Cột `requirements` lưu chung hai loại. Góc nhìn theo yêu cầu (FR-054) liệt kê cả hai, mỗi mã một dòng.

**Lý do**:

- Spec của hive và mẫu spec-kit dùng `FR-xxx`, `SC-xxx`, `US`. Tiền tố `NNN/` cho phép trỏ spec khác.
- SRS của BA ở dự án mẫu dùng mã module và chức năng không theo một khuôn: `OPD02`, `BIL101`, `BILA1`, `IPDP10`,
  `ORM04P00201`, `EMEDT`. Ngày 2026-10-23 đã kiểm tên 261 file SRS (tên file là mã): cả 261 mã khớp mẫu SRS, dài 5–11 ký
  tự. Mã module (`APT`, `BILL`, `COMMON`) cũng khớp.
- Một mẫu chung nhận được mã SRS mà dự án không phải cấu hình regex.

**Phương án đã loại**:

- Ghi mã SRS vào Nhãn dạng `srs-<mã>`: góc nhìn theo yêu cầu không thấy mã SRS, tester phải nhớ hai chỗ ghi mã.
- Regex riêng trong cấu hình dự án: thêm màn cài đặt và lỗi cấu hình. Chưa cần khi mẫu chung nhận hết mã đã đọc.

## D11. A7: các ngưỡng

**Quyết định**: giữ hằng số trong `packages/contracts/src/testing.ts`:

| Hằng số | Giá trị | Nguồn |
|---|---|---|
| `QA_READ_WAIT_HOURS` | 24 | FR-022 |
| `QA_REFETCH_DAYS` | 7 | FR-028 |
| `QA_BACKFILL_PIPELINES` | 20 | FR-029 |
| `QA_TREND_DAYS` | 90 | FR-055 |
| `QA_FLAKY_WINDOW` / `QA_FLAKY_FLIPS` | 10 / 3 | FR-056 |
| `QA_UNKNOWN_CODES_MAX` | 200 | D8 |
| `QA_NOTE_MAX` / `QA_LINKS_MAX` | 500 / 5 | FR-033 |
| `QA_RETENTION_DAYS_DEFAULT` / `_MIN` | 365 / 90 | FR-072 |

**Lý do**: 7 ngày lấy lại ngắn hơn `expire_in: 14 days` của artifact ở dự án mẫu, nên báo cáo còn khi lấy lại. Báo cáo test
của pipeline có thời hạn riêng [Unverified].

## D12. Trạng thái hiện tại và số liệu dashboard

**Quyết định**:

1. Bảng chiếu `qa_case_status`: một dòng mỗi TC đang dùng, giữ kết quả CI mới nhất trên nhánh tham chiếu, kết quả tay mới
   nhất và trạng thái hiện tại (FR-052). Cập nhật trong transaction ghi kết quả CI hoặc kết quả tay.
2. Tổng theo trạng thái của mỗi lần chạy lưu ngay trên `qa_ci_runs` để vẽ xu hướng (FR-055) mà không quét
   `qa_ci_run_cases`.
3. Góc nhìn theo khu và theo yêu cầu tính bằng truy vấn gộp trên `qa_case_status` nối `qa_cases`.

**Lý do**: SC-005 cần mỗi góc nhìn mở dưới 3 giây (P95) với 5.000 TC, 90 ngày lịch sử, 20 người xem. A8 cho phép tới
20.000 TC. Bảng chiếu thay việc gộp toàn bộ `qa_ci_run_cases` bằng một lần quét theo dự án [Inference].

**Phương án đã loại**: materialized view (phải refresh, RLS trên view phức tạp hơn).

## D13. Sửa đồng thời kết quả tay

**Quyết định**: kết quả tay hiện tại nằm trên `qa_round_cases`. `qa_round_cases.revision` tăng mỗi lần lưu. Client gửi
`revision` đã đọc. Khác bản hiện có thì hub trả `409 QA_RESULT_CONFLICT` kèm bản mới nhất (FR-035). Mỗi lần lưu chép bản
cũ sang `qa_result_history` (FR-034). Câu cập nhật dùng `WHERE id = $1 AND revision = $2`; không có dòng nào đổi là xung
đột.

**Lý do**: cùng cách khoá lạc quan đang dùng cho tài liệu (`version`). Không cần khoá hàng lâu.

## D14. MCP cho agent

**Quyết định**: hai công cụ `readOnly`, đăng ký qua `registerMcpTools(registry)` của `qa/index.ts`. Chi tiết ở
[contracts/mcp-tools.md](contracts/mcp-tools.md).

- `qa_get_case { project?, code }`
- `qa_list_cases { project?, area?, label?, priority?, kind?, requirement?, limit?, offset? }`

Phạm vi theo `knowledgePrincipal(tx, principal)` của `knowledge/index.ts`, cùng cách `doc_list` và `memory_search`:

- Run bỏ trống `project` thì đọc dự án của run. Run truyền dự án khác thì `PROJECT_NOT_FOUND` (FR-060).
- Người dùng phải truyền `project` và cần `qa.read` ở đội của dự án.

Phân trang `limit`/`offset` và giới hạn `MCP_LIMITS.listMax` như công cụ của knowledge. Không có công cụ ghi (FR-061).

## D15. Xuất CSV

**Quyết định**: route oRPC `testing.rounds.export` (`POST /v1/testing/rounds/export`), `.output(z.file())`, theo mẫu
`audit.export`. Hub trả `File` kiểu `text/csv;charset=utf-8` có BOM `EF BB BF`. Mỗi dòng ghi bằng `csvRow()` của
`audit/csv.ts`; `audit/index.ts` export thêm hàm này. Chi tiết ở [contracts/csv-export.md](contracts/csv-export.md).

**Lý do**:

- `audit.export` (`packages/contracts/src/audit.ts:63`, `audit/query-service.ts:94`) đã trả file qua oRPC; web gọi bằng
  `api.audit.export.mutationOptions` (`pages/admin/audit-page.tsx:253`). Không cần route ngoài oRPC.
- `csvCell()` đã trung hoà ô bắt đầu bằng `=`, `+`, `@`, `-` (chống chèn công thức). Ghi chú của tester là chữ tự do nên
  cần lớp này.

**Phương án đã loại**: route Hono riêng `…/export.csv`: phải tự kiểm quyền và tổ chức ngoài oRPC; tổ chức của hub đi theo
header `x-hive-org`, không theo đường dẫn.

## D16. Giữ dữ liệu

**Quyết định**: cron `QA_RETENTION_CRON = "37 3 * * *"` trong `qa/retention.ts`, cùng cách `delivery/retention.ts`. Hàm
`hive.purge_qa_data()` (`SECURITY DEFINER`) chạy ba bước:

1. Xoá `qa_rounds` đã đóng cũ hơn số ngày cài đặt. CASCADE xoá `qa_round_cases`, `qa_round_assignees`,
   `qa_result_history`.
2. Xoá `qa_ci_runs` cũ hơn số ngày cài đặt. CASCADE xoá `qa_ci_run_cases`.
3. Tính lại `qa_case_status` của TC bị ảnh hưởng.

Cài đặt `qa_settings.retention_days` mức tổ chức, tối thiểu 90 (FR-072). Thư viện (`qa_cases`, `qa_case_versions`) không
bị xoá. Chi tiết ở [data-model.md](data-model.md#giữ-dữ-liệu-fr-072-d16).

**Lý do**: lệch giờ với cron delivery (`17 3 * * *`) để hai việc xoá không chạy cùng phút.

## D17. Web

**Quyết định**: route `/projects/$key/testing`, thư mục `apps/web/src/pages/testing/`. Tab: Tổng quan, Thư viện, Đợt test,
Nguồn CI, Việc của tôi. Màn chi tiết TC `/projects/$key/testing/cases/$code`.

- Sửa TC mở editor tài liệu hiện có ở key của file khu. Panel bên phải chạy bộ đọc D2 và hiện lỗi theo dòng.
- Biểu đồ xu hướng vẽ bằng SVG trong component, không thêm phụ thuộc. `apps/web/package.json` không có thư viện biểu đồ
  (đã grep ngày 2026-10-23). `pages/machine-token-score.tsx:267` đã vẽ đường bằng `<svg>` và `<polyline>`; làm theo mẫu
  này. Biểu đồ có bảng số liệu đi kèm để đọc bằng bàn phím và trình đọc màn hình.
- Theo nguyên tắc UI: shadcn/Base UI, token, rộng 360 px, sáng và tối, phím tắt, test Playwright theo role.

## D18. "Lấy lại kết quả" và đọc ban đầu

**Quyết định**: cả hai dùng việc `test-report` `op = list` (D6), rồi tạo việc `op = read` cho từng pipeline thiếu.

| | Lấy lại kết quả (FR-028) | Đọc ban đầu (FR-029) |
|---|---|---|
| Khi nào | người có `projects.settings` bấm nút | tạo nguồn mới |
| `ref` | không đặt | `reference_branch` |
| `updatedAfter` | `now() - 7 ngày` | không đặt |
| `limit` | 500 | 20 |
| Audit | có (FR-070) | có, cùng bản ghi "thêm nguồn" |

Luồng:

1. Hub tạo việc `list` cho nguồn, đặt `backfill_state = listing` (đọc ban đầu) hoặc `refetch_requested_at` (lấy lại).
2. Worker gọi danh sách pipeline của GitLab, chỉ lấy pipeline đã xong, gửi từng trang bằng sự kiện `pipelines`.
3. Hub lọc mỗi pipeline theo `branch_filter`, rồi tạo dòng `qa_ci_runs` `waiting` khi pipeline chưa có dòng hoặc dòng ở
   `error`, `expired`, `no-report`. Dòng `done` giữ nguyên. Mỗi dòng mới kèm một việc `op = read`.
4. `finished` của việc `list` đặt `backfill_state = done`; lỗi thì `error` kèm mã lỗi của worker.

**Lý do**:

- Hub không gọi GitLab (FR-022), nên danh sách pipeline cũng do worker đọc.
- Tách `list` và `read` để mỗi pipeline có một việc riêng, lease riêng, thử lại riêng; một pipeline hỏng không làm hỏng
  cả lần lấy lại.

**Phương án đã loại**: một việc đọc cả 20 pipeline rồi gửi một sự kiện lớn: vượt giới hạn kích thước sự kiện của 032 khi
mỗi pipeline có 5.000 TC [Inference].

**Hệ quả**:

- [Unverified] API danh sách pipeline của bản GitLab nội bộ nhận `scope=finished`, `updated_after`, `ref` và trả `source`.
  Danh sách có thể không có thời điểm bắt đầu, kết thúc; việc `read` lấy lại hai giá trị này từ chi tiết pipeline.
- Lấy lại kết quả có thể tạo tới 500 việc `read`. Hàng việc của 032 giao theo khả năng máy; cần đo ở tasks xem 500 việc có
  làm chậm việc deploy không. Nếu có thì `qa` giới hạn số việc `read` đang chờ của mỗi nguồn [Inference].
