# API kiểm thử của hub

Hợp đồng ở `packages/contracts/src/testing.ts` (`testingContract`, khoá `testing` trong router). Mọi route là
`orgRoute(...)` dưới `/v1/testing/...`, nhận `projectKey` thay vì id dự án. Danh sách phân trang theo mẫu hiện có:
`cursor` (tối đa 2.000 ký tự), `limit` 1–100, mặc định 20.

Luật chung:

- Mọi route kiểm dự án thuộc đội của người gọi (FR-015, D22). Dự án ngoài đội trả `404`, như dự án không tồn tại.
- Từ chối quyền trả `403` với thông điệp nêu quyền còn thiếu (FR-016), ví dụ: "Cần quyền `qa.record` ở đội của dự án
  này."
- Dự án chưa bật thư viện (`qa_project_settings.enabled = false`) thì mọi route trừ `projectSettings.*` trả
  `403 QA_LIBRARY_DISABLED`.
- Route ghi dữ liệu nêu ở FR-070 ghi audit trong cùng giao dịch.

## Cài đặt

- `testing.settings.get()`, `testing.settings.update({retentionDays})`: thời gian giữ của tổ chức, 90–3.650 ngày
  (FR-072). Đọc cần `qa.read`; sửa cần vai trò tổ chức `owner` hoặc `admin`. Ghi audit.
- `testing.projectSettings.get({projectKey})`: `enabled`, `tcDir`, `includeResult` (D3b). Cần `qa.read` hoặc
  `projects.settings`.
- `testing.projectSettings.update({projectKey, enabled?, tcDir?})`: cần `projects.settings`. `tcDir` tương đối, kết thúc
  bằng `/`, không `..`, tối đa 200 ký tự. Bật lần đầu thì hub gọi `ensureProjectInclude` và trả `includeResult`.

## Thư viện

- `testing.areas.list({projectKey})`: mỗi khu gồm mã, tên, `docKey`, số TC đang dùng, `parsedVersion`, `parseErrors`
  (`[{line, message}]`, FR-004), `archived`. Cần `qa.read`.
- `testing.areas.create({projectKey, code, name})`: tạo file từ mẫu FR-008 ([tc-markdown.md](tc-markdown.md)) qua
  docsync. Cần `qa.cases.write`. Mã khu trùng thì `409 QA_AREA_CODE_TAKEN`. Trả `docKey` để web mở editor.
- `testing.cases.list({projectKey, q?, area?, label?, priority?, kind?, requirement?, currentStatus?, state?, cursor?,
  limit?})`: lọc theo FR-009. `q` so với mã và tên. `state` mặc định `active`. Mỗi dòng có trạng thái hiện tại và nguồn
  của nó (D12). Cần `qa.read`.
- `testing.cases.get({projectKey, code})`: nội dung TC, `version`, các phiên bản cũ, kết quả CI gần nhất và kết quả tay
  gần nhất tách riêng (FR-052), `docKey` và `line` để mở editor. Cần `qa.read`.
- `testing.cases.history({projectKey, code, source: "ci" | "manual", cursor?, limit?})`: lịch sử theo thời gian mới trước
  (FR-057). Dòng CI có mã pipeline, nhánh, SHA, trạng thái, liên kết job dựng từ `repo_web_url` (FR-026). Dòng tay có
  đợt, người ghi, trạng thái, bước lỗi, ghi chú, liên kết lỗi.

Sửa nội dung TC không có route riêng: web sửa file khu qua route tài liệu của docsync. Hub cho phép sửa khi người gọi có
`docs.write`, hoặc có `qa.cases.write` và đường dẫn nằm trong `tcDir` (FR-011, D4).

## Nguồn kết quả CI

Mọi route ghi cần `projects.settings` và ghi audit (FR-070). Đọc cần `qa.read`.

- `testing.sources.list({projectKey})`: nguồn, lần chạy gần nhất, `backfillState`.
- `testing.sources.create({projectKey, label, repoPath, branchFilter, jobFilter, mode, artifactPath?, referenceBranch?,
  credential})`: `repoWebUrl` lấy từ kết nối SCM của tổ chức, chỉ `https://`. `artifactPath` bắt buộc với hai mode
  artifact. `referenceBranch` mặc định nhánh mặc định của dự án. Nhãn trùng trong dự án thì `409 QA_SOURCE_LABEL_TAKEN`.
  Tạo xong thì hub xếp việc `op = list` cho 20 pipeline gần nhất trên nhánh tham chiếu (FR-029, D18).
- `testing.sources.update({sourceId, ...})`: cùng trường như tạo. Đổi bộ lọc không đọc lại pipeline cũ.
- `testing.sources.delete({sourceId})`: xoá nguồn và các lần chạy của nó (CASCADE), rồi tính lại `qa_case_status`.
- `testing.sources.refetch({sourceId})`: "Lấy lại kết quả" (FR-028). Hub xếp việc `op = list` với
  `updatedAfter = now() - 7 ngày`, rồi một việc `op = read` cho mỗi pipeline chưa có hoặc chưa ở `done`. Đang có
  `op = list` chưa xong cho nguồn thì trả `409 QA_REFETCH_RUNNING`.
- `testing.sources.runs({sourceId, cursor?, limit?})`: lịch sử lần chạy gồm `readState`, `waitReason`, `readErrorCode`,
  tổng theo trạng thái, `unmapped`, `ambiguous`, `unknownCodes`, `truncated`, liên kết pipeline.

## Đợt test tay

- `testing.rounds.list({projectKey, state?, cursor?, limit?})`, `testing.rounds.get({roundId})`: đợt, tiến độ theo
  trạng thái, danh sách TC kèm người được giao, `revision` và cờ `caseChanged` (FR-037). Cần `qa.read`.
- `testing.rounds.create({projectKey, name, environment, build, startDate, plannedEndDate, openRecording?, select})`:
  cần `qa.rounds.manage`. `select` là `{areas?, labels?, priorities?, kinds?, caseIds?}`; TC thoả bất kỳ điều kiện nào
  thì vào đợt (FR-030). Chỉ chọn TC `active`. Kết quả rỗng thì `400 QA_ROUND_EMPTY`.
- `testing.rounds.createNext({fromRoundId, name, environment, build, startDate, plannedEndDate, statuses?})`: cần
  `qa.rounds.manage`. `statuses` mặc định `failed`, `untested`, `deferred`, `other` (FR-038). Giữ người được giao của
  đợt cũ nếu họ còn trong đội. Ghi `previous_round_id`.
- `testing.rounds.assign({roundId, roundCaseIds?, areaCodes?, userIds, mode: "add" | "replace"})`: cần
  `qa.rounds.manage` (FR-031). Người không thuộc đội thì `400 QA_ASSIGNEE_NOT_MEMBER` kèm danh sách. Ghi audit.
- `testing.rounds.record({roundCaseId, revision, status, failedStep?, note?, links?})`: cần `qa.record`, và người gọi
  được giao TC hoặc đợt có `openRecording` (data-model `qa_rounds`). Không thoả thì `403 QA_NOT_ASSIGNED`. Trả bản mới
  với `revision` mới.
- `testing.rounds.history({roundCaseId})`: lịch sử sửa của một kết quả (FR-034). Ghi chú đã bị xoá hiện là
  "Ghi chú đã bị quản trị xoá". Cần `qa.read`.
- `testing.rounds.close({roundId})`, `testing.rounds.reopen({roundId, reason})`: cần `qa.rounds.manage`. Lý do 10–500
  ký tự (FR-036). Ghi audit.
- `testing.rounds.deleteNote({roundCaseId})`: xoá ghi chú ở bản hiện tại và mọi bản trong lịch sử. Cần vai trò tổ chức
  `owner` hoặc `admin`. Audit ghi người xoá và thời điểm, không ghi nội dung.
- `testing.rounds.export({roundId})`: CSV, xem [csv-export.md](csv-export.md).

## Việc của tôi

- `testing.myWork.list({projectKey?, cursor?, limit?})`: TC được giao cho người gọi trong các đợt `open` (FR-032). Bỏ
  `projectKey` thì lấy mọi dự án người gọi thấy. Mỗi dòng có đợt, mã, tên, trạng thái hiện tại, cờ `caseChanged`.

## Dashboard

Cần `qa.read`. Công thức ở data-model, mục "Tính số liệu dashboard".

- `testing.dashboard.overview({projectKey})`: tổng TC đang dùng, số và tỉ lệ theo loại, tỉ lệ đạt, số không đạt, số
  "Chưa có kết quả" (FR-050, FR-051), lần chạy gần nhất mỗi nguồn với `unmapped`, `ambiguous`, `unknownCodes`
  (FR-058), các đợt đang mở và tiến độ.
- `testing.dashboard.areas({projectKey})`: mỗi khu một dòng (FR-053).
- `testing.dashboard.requirements({projectKey, cursor?, limit?})`: mỗi mã yêu cầu một dòng, số TC, trạng thái xấu nhất
  (FR-054).
- `testing.dashboard.trend({projectKey, sourceId?, areaCode?, days?})`: mỗi lần chạy tham chiếu một điểm; `days` 1–90,
  mặc định 90 (FR-055).
- `testing.dashboard.flaky({projectKey})`: TC chập chờn theo FR-056, kèm số lần đổi và lần chạy gần nhất.

## Mã lỗi

`QA_ERRORS` trong `testing.ts`, cùng kiểu với `ARTIFACT_ERRORS` của `artifacts.ts`.

| Mã | Status | Thông điệp |
|---|---|---|
| `QA_LIBRARY_DISABLED` | FORBIDDEN | "Dự án chưa bật thư viện test case. Admin dự án bật ở Cài đặt → Kiểm thử." |
| `QA_NOT_ASSIGNED` | FORBIDDEN | "Bạn chưa được giao TC này trong đợt. Nhờ người quản lý đợt giao, hoặc bật cho mọi tester ghi." |
| `QA_RESULT_CONFLICT` | CONFLICT | "Kết quả này vừa được người khác lưu. Xem bản mới nhất rồi lưu lại." Kèm `data.latest` |
| `QA_ROUND_CLOSED` | CONFLICT | "Đợt đã đóng, không nhận kết quả mới. Mở lại đợt nếu cần ghi thêm." |
| `QA_AREA_CODE_TAKEN` | CONFLICT | "Mã khu `{KHU}` đã dùng ở `{đường dẫn}`. Chọn mã khu khác." |
| `QA_SOURCE_LABEL_TAKEN` | CONFLICT | "Dự án đã có nguồn tên `{nhãn}`." |
| `QA_REFETCH_RUNNING` | CONFLICT | "Đang lấy lại kết quả cho nguồn này. Chờ lần trước xong." |
| `QA_NOTE_REQUIRED` | BAD_REQUEST | "Trạng thái Khác và Không đạt cần ghi chú hoặc liên kết lỗi." |
| `QA_LINK_INVALID` | BAD_REQUEST | "Liên kết lỗi phải bắt đầu bằng http:// hoặc https://, tối đa 2.000 ký tự." |
| `QA_FAILED_STEP_INVALID` | BAD_REQUEST | "Bước lỗi phải từ 1 tới {n}." |
| `QA_ASSIGNEE_NOT_MEMBER` | BAD_REQUEST | "Người sau không thuộc đội của dự án: {tên}." |
| `QA_ROUND_EMPTY` | BAD_REQUEST | "Không có TC đang dùng nào khớp điều kiện chọn." |

Kiểm độ dài, mẫu và giá trị enum ở zod; thông điệp tiếng Việt như các hợp đồng hiện có.

Không có route tải ảnh hay file đính kèm (FR-039), cách ly hoặc bỏ qua TC chập chờn (FR-056), hay ghi kết quả CI từ
người dùng: kết quả CI chỉ đến từ việc `test-report` của worker ([worker-test-report.md](worker-test-report.md)).
