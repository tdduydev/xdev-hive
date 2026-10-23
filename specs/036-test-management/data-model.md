# Data model: Quản lý kiểm thử cấp dự án

**Date**: 2026-10-23 · **Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

Luật chung cho mọi bảng dưới đây (FR-071, nguyên tắc II):

- Có `org_id uuid not null`, policy `orgScoped(<tên bảng>)` theo mẫu `delivery/schema.ts`, `.enableRLS()`; migration thêm
  `FORCE ROW LEVEL SECURITY`.
- Bảng con nối bảng cha bằng khoá ngoại ghép `(parent_id, org_id) → (id, org_id)`; bảng cha có
  `unique("<bảng>_id_org").on(t.id, t.orgId)`.
- Khoá ngoại tới bảng của module khác (`projects`, `docs`, `users`, `delivery_jobs`) chỉ viết trong migration tay, cùng
  cách các module đang làm.
- Mọi bảng vào danh sách của `rls.db.test.ts`.
- Schema ở `apps/hub/src/modules/qa/schema.ts`. Hằng số giới hạn ở `packages/contracts/src/testing.ts` (D11).

Nhãn **[Inference]** và **[Unverified]** theo nghĩa của research.md.

## Tổng quan

```text
qa_settings (1 / tổ chức)

projects ─┬─ qa_project_settings (1 / dự án)
          ├─ qa_areas ── qa_cases ─┬─ qa_case_versions
          │                        └─ qa_case_status (1 / TC)
          ├─ qa_ci_sources ── qa_ci_runs ── qa_ci_run_cases ── qa_cases
          └─ qa_rounds ── qa_round_cases ─┬─ qa_round_assignees ── users
                               │          └─ qa_result_history
                               └─ qa_cases
```

## Hub: bảng `qa_settings` (mới, RLS)

Cài đặt mức tổ chức. Không có dòng thì dùng mặc định.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `org_id` | uuid pk | |
| `retention_days` | int not null default 365 | check `BETWEEN 90 AND 3650` (FR-072) |
| `updated_by` | uuid null | |
| `updated_at` | timestamptz | |

Policy theo mẫu `audit_settings`: `_select`, `_insert`, `_update` cho `hive_app` trong tổ chức; `_owner_select` cho
`hive_owner` để hàm giữ dữ liệu đọc được.

## Hub: bảng `qa_project_settings` (mới, RLS)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `project_id` | uuid pk | FK `(project_id, org_id) → projects ON DELETE CASCADE` |
| `org_id` | uuid | |
| `enabled` | bool not null default false | bật thư viện cho dự án |
| `tc_dir` | text not null default `test-cases/` | thư mục TC tính từ `doc_homes.root` (FR-001, D3b) |
| `include_result` | text null | kết quả `ensureProjectInclude`: `no-home`, `covered`, `added` (D3b) |
| `updated_by` | uuid null | |
| `updated_at` | timestamptz | |

Kiểm: `tc_dir` là đường dẫn tương đối, kết thúc bằng `/`, không chứa `..`, tối đa 200 ký tự.

## Hub: bảng `qa_areas` (mới, RLS)

Một dòng mỗi file khu (FR-001). Mã khu là định danh; đổi mã khu là khu mới (edge case "Đổi mã khu").

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `project_id` | uuid | FK tới `projects` (CASCADE) |
| `code` | text | `^[A-Z][A-Z0-9]{1,15}$` (FR-003) |
| `name` | text | từ dòng `# <KHU> <tên>` |
| `doc_id` | uuid null | FK `(doc_id, org_id) → docs ON DELETE SET NULL (doc_id)` (Postgres 15+) |
| `doc_key` | text | key tài liệu lúc đọc gần nhất; giữ khi tài liệu bị xoá |
| `parsed_version` | int null | phiên bản tài liệu của bộ TC đang áp dụng (FR-004) |
| `parse_errors` | jsonb not null default `[]` | `[{ line, message }]` của lần đọc gần nhất, tối đa 100 dòng |
| `errors_version` | int null | phiên bản tài liệu có lỗi; null khi lần đọc gần nhất hợp lệ |
| `archived_at` | timestamptz null | tài liệu lưu trữ hoặc bị xoá (D3 bước 4) |
| `created_at`, `updated_at` | timestamptz | |

Chỉ mục: unique `(project_id, code)`, unique `(doc_id)` khi `doc_id` not null.

Luật:

- File có lỗi: chỉ cập nhật `parse_errors`, `errors_version`. Bộ TC và `parsed_version` giữ nguyên (FR-004).
- `archived_at` khác null: mọi TC của khu là `retired`.

## Hub: bảng `qa_cases` (mới, RLS)

Một dòng mỗi mã TC đã từng có trong dự án. Không xoá dòng, nên mã không được cấp lại (FR-006).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `project_id` | uuid | FK tới `projects` (CASCADE) |
| `area_id` | uuid | FK ghép tới `qa_areas` |
| `code` | text | `TC-<KHU>-<SỐ>`, `<KHU>` trùng `qa_areas.code` (FR-003) |
| `name` | text | tối đa 300 ký tự |
| `priority` | text | `P1`, `P2`, `P3` (`qaPriority` của 035) |
| `kind` | text | `automated`, `manual`, `planned` (`testCaseKind`) |
| `requirements` | text[] | ít nhất 1 mã, mỗi mã khớp regex mã spec hoặc mã SRS của D10 |
| `labels` | text[] | không dấu cách, tối đa 20 nhãn |
| `preconditions` | text null | |
| `steps` | jsonb | `[{ n, action, expected }]`, ít nhất 1 bước (FR-002) |
| `test_data` | text null | mã tham chiếu dữ liệu test, không phải dữ liệu thật |
| `script` | text null | bắt buộc khi `kind = automated` (FR-002) |
| `note` | text null | |
| `line` | int | dòng tiêu đề `###` trong file, để mở editor đúng chỗ |
| `version` | int not null default 1 | tăng khi một trường của FR-002 đổi (FR-007) |
| `content_hash` | text | băm các trường của FR-002, so để biết có tăng `version` không |
| `state` | text | `active`, `retired` |
| `retired_at` | timestamptz null | |
| `created_at`, `updated_at` | timestamptz | |

Chỉ mục: unique `(project_id, code)`; `(project_id, area_id, state)`; GIN `(requirements)`; GIN `(labels)`; trigram
hoặc `lower(name)` cho tìm theo tên [Inference: chọn khi đo SC-005].

Luật áp dụng file (D3):

1. Mã có trong file, chưa có dòng → thêm, `version = 1`.
2. Mã có dòng ở cùng khu → cập nhật; `content_hash` đổi thì `version + 1` và thêm `qa_case_versions`.
3. Mã có dòng ở khu khác và dòng đó `active` → từ chối cả file: "Mã đã có ở khu khác".
4. Mã có dòng ở khu khác và dòng đó `retired` → từ chối cả file: "Mã đã dùng trước đây, chọn số khác" (FR-006).
5. Dòng `active` của khu không còn trong file → `retired`.
6. Dòng `retired` của khu xuất hiện lại trong file → `active`, xét `version` như bước 2.

## Hub: bảng `qa_case_versions` (mới, RLS)

Bản chụp nội dung mỗi phiên bản, để màn đợt so "TC đã đổi sau khi giao" (FR-037) và màn chi tiết hiện lịch sử.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `case_id` | uuid | FK ghép tới `qa_cases` (CASCADE) |
| `version` | int | |
| `org_id` | uuid | |
| `content` | jsonb | các trường của FR-002 |
| `doc_version` | int | phiên bản tài liệu sinh ra bản này |
| `created_at` | timestamptz | |

Khoá chính: `(case_id, version)`.

## Hub: bảng `qa_ci_sources` (mới, RLS)

Nguồn kết quả CI (FR-020). Một dự án có thể có nhiều nguồn.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `project_id` | uuid | FK tới `projects` (CASCADE) |
| `label` | text | nhãn hiển thị, tối đa 80 ký tự |
| `repo_path` | text | đường dẫn GitLab đầy đủ, so với `ScmEvent.repo` |
| `repo_web_url` | text | gốc URL để dựng liên kết pipeline và job (FR-026); chỉ `https://` |
| `branch_filter` | text[] | glob nhánh; rỗng là mọi nhánh |
| `job_filter` | text[] | glob tên job; rỗng là mọi job. Worker lọc tại máy (D7) |
| `mode` | text | `pipeline-report`, `junit-artifact`, `playwright-artifact` |
| `artifact_path` | text null | bắt buộc với hai mode artifact; đường dẫn tương đối, không `..` |
| `reference_branch` | text | mặc định `projects.default_branch` |
| `credential` | text | tên credential GitLab trong kho tại máy, khớp `credentialRef` của 032 |
| `backfill_state` | text | `pending`, `listing`, `done`, `error` (FR-029) |
| `refetch_requested_at` | timestamptz null | lần "Lấy lại kết quả" gần nhất (FR-028) |
| `created_by` | uuid | |
| `created_at`, `updated_at` | timestamptz | |

Chỉ mục: unique `(project_id, label)`; `(project_id, repo_path)`.

Luật:

- Đổi `reference_branch`: tính lại `qa_ci_runs.is_reference` của nguồn và `qa_case_status` của dự án trong cùng
  transaction.
- Xoá nguồn: xoá `qa_ci_runs` của nguồn (CASCADE), tính lại `qa_case_status`, ghi audit (FR-070).
- [Unverified] Pipeline của repo khác repo của dự án chỉ tới hub khi webhook của repo đó trỏ tới URL webhook của dự án.
  Cách khai webhook cho repo thứ hai chốt ở tasks.

## Hub: bảng `qa_ci_runs` (mới, RLS)

Một dòng mỗi pipeline của một nguồn (FR-024, FR-027).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `source_id` | uuid | FK ghép tới `qa_ci_sources` (CASCADE) |
| `pipeline_id` | bigint | |
| `read_state` | text | xem sơ đồ dưới |
| `delivery_job_id` | uuid null | việc `test-report` gần nhất; FK `ON DELETE SET NULL (delivery_job_id)` |
| `read_attempts` | int not null default 0 | số việc đã giao cho pipeline này |
| `waiting_since` | timestamptz null | mốc tính 24 giờ (FR-022) |
| `wait_reason` | text null | lý do tiếng Việt khi chờ máy |
| `read_error_code` | text null | mã lỗi của worker, ví dụ `report_too_large`, `gitlab_auth` |
| `pipeline_status` | text | `success`, `failed`, `canceled`, `skipped`, `manual` |
| `ref` | text | |
| `sha` | text | 40 ký tự hex |
| `kind` | text | `branch`, `mr` (`source = merge_request_event`) |
| `is_reference` | bool | `kind = branch` và `ref = reference_branch` |
| `started_at`, `finished_at` | timestamptz null | webhook GitLab không gửi `started_at`; lấy từ sự kiện của worker |
| `job_ids` | bigint[] | job đã đọc |
| `passed`, `flaky`, `failed`, `skipped` | int | tổng TC theo trạng thái (FR-055 dùng ngay) |
| `unmapped`, `ambiguous` | int | test chưa gắn mã, test mơ hồ (FR-023, FR-058) |
| `unknown_codes` | text[] | mã lạ, tối đa 200 (D8) |
| `retired_codes` | int | số TC ngừng dùng còn test (edge case) |
| `truncated` | bool | worker đã cắt ở 5.000 TC |
| `received_at` | timestamptz null | lần nhận `test-results` gần nhất |
| `created_at`, `updated_at` | timestamptz | |

Chỉ mục: unique `(source_id, pipeline_id)`; `(source_id, is_reference, finished_at desc)`; `(org_id, read_state)` cho
việc kiểm hết hạn.

Không có cột tên test, thông báo lỗi, URL do worker gửi (FR-025, FR-026). Liên kết dựng từ `repo_web_url`,
`pipeline_id`, `job_ids`.

### Chuyển trạng thái đọc

```text
waiting -> reading -> done        (có báo cáo)
   |          |  \--> no-report   (pipeline huỷ, job lỗi trước khi có báo cáo, total = 0)
   |          \-----> error       (vượt 32 MiB, lỗi GitLab, lỗi đọc)
   \--> expired                   (24 giờ không có máy, FR-022)

done | no-report | error | expired --(Lấy lại kết quả, FR-028)--> waiting
done --(gửi lại cùng pipeline, FR-027)--> done   (thay metadata và các dòng TC)
```

- `waiting` ↔ `reading` theo trạng thái `delivery_jobs`: `leased`, `running` là `reading`; mất lease và giao lại vẫn là
  `reading` (032 `lost`).
- Chỉ `done` ghi `qa_ci_run_cases` và cập nhật `qa_case_status`. Ba trạng thái còn lại không đổi trạng thái hiện tại
  của TC (edge case "File báo cáo vượt 32 MiB", "Pipeline bị huỷ").
- Hết 24 giờ: xem "Phụ thuộc 032" ở cuối file.

## Hub: bảng `qa_ci_run_cases` (mới, RLS)

Một dòng mỗi TC của một lần chạy (FR-024).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `run_id` | uuid | FK ghép tới `qa_ci_runs` (CASCADE) |
| `case_id` | uuid | FK ghép tới `qa_cases` |
| `org_id` | uuid | |
| `area_id` | uuid | chép từ `qa_cases.area_id`; mã TC gắn cố định một khu, nên không lệch |
| `status` | text | `passed`, `flaky`, `failed`, `skipped` |
| `retries` | int | |
| `duration_ms` | int | |
| `worst_job_id` | bigint null | job có kết quả xấu nhất (edge case "nhiều job e2e") |

Khoá chính: `(run_id, case_id)`. Chỉ mục: `(case_id, run_id)` cho lịch sử TC và FR-056.

[Inference] Ước lượng xấu nhất theo A8: 50 lần chạy/ngày × 5.000 TC × 365 ngày ≈ 91 triệu dòng/năm/dự án, khoảng
9 GB. Thực tế nhỏ hơn vì chỉ pipeline có test e2e mới có dòng. Đo lại ở tasks; nếu cần thì chỉ giữ dòng của lần chạy
trên nhánh tham chiếu và MR quá 30 ngày.

## Hub: bảng `qa_rounds` (mới, RLS)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `project_id` | uuid | FK tới `projects` (CASCADE) |
| `name` | text | 1–120 ký tự |
| `environment` | text | chữ tự do, tối đa 80 ký tự (FR-030) |
| `build` | text | bản phần mềm, tối đa 80 ký tự |
| `start_date`, `planned_end_date` | date | `planned_end_date >= start_date` |
| `state` | text | `open`, `closed` (FR-036) |
| `previous_round_id` | uuid null | đợt gốc khi tạo đợt tiếp theo (FR-038); FK ghép, `ON DELETE SET NULL (previous_round_id)` |
| `reopen_reason` | text null | 10–500 ký tự, lý do lần mở lại gần nhất |
| `open_recording` | bool not null default false | "đợt cho phép" của FR-010: mọi người có `qa.record` ở đội của dự án ghi được, không cần được giao |
| `created_by` | uuid | |
| `closed_at`, `created_at`, `updated_at` | timestamptz | |

Chỉ mục: `(project_id, state)`.

Ai ghi được kết quả của một TC trong đợt: người có `qa.record` ở đội của dự án, và (là người được giao TC đó hoặc
`open_recording = true`). Không thoả thì `403 QA_NOT_ASSIGNED`.

### Chuyển trạng thái đợt

```text
open --(đóng)--> closed --(mở lại: lý do 10–500 ký tự, audit)--> open
```

Đợt `closed` từ chối ghi kết quả: `409 QA_ROUND_CLOSED` (FR-036).

## Hub: bảng `qa_round_cases` (mới, RLS)

Một dòng mỗi TC trong một đợt. Giữ kết quả tay hiện tại (D13).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid | |
| `round_id` | uuid | FK ghép tới `qa_rounds` (CASCADE) |
| `case_id` | uuid | FK ghép tới `qa_cases` |
| `case_version_at_add` | int | `version` lúc thêm vào đợt (FR-037) |
| `status` | text default `untested` | `passed`, `failed`, `untested`, `not-applicable`, `deferred`, `other` (FR-031) |
| `failed_step` | int null | ≥ 1 và ≤ số bước của TC |
| `note` | text null | tối đa 500 ký tự (FR-033) |
| `links` | text[] | tối đa 5, mỗi liên kết `http://` hoặc `https://`, tối đa 2.000 ký tự |
| `recorded_by` | uuid null | |
| `recorded_at` | timestamptz null | |
| `recorded_case_version` | int null | `version` của TC lúc ghi (FR-034) |
| `revision` | int not null default 0 | tăng mỗi lần lưu; khoá lạc quan (FR-035) |

Chỉ mục: unique `(round_id, case_id)`; `(case_id, recorded_at desc)` cho kết quả tay mới nhất.

Check trong database:

- `status IN ('other', 'failed')` thì `note` hoặc `links` khác rỗng (FR-033).
- `cardinality(links) <= 5`, `char_length(note) <= 500`.

Luật:

- "TC đã đổi sau khi giao" = `qa_cases.version > case_version_at_add` (FR-037).
- TC `retired` vẫn ở trong đợt và ghi kết quả được tới khi đóng đợt (edge case).
- Lưu kết quả: client gửi `revision` đã đọc; khác `revision` hiện tại thì `409 QA_RESULT_CONFLICT` kèm bản mới nhất.

## Hub: bảng `qa_round_assignees` (mới, RLS)

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `round_case_id` | uuid | FK ghép tới `qa_round_cases` (CASCADE) |
| `user_id` | uuid | FK tới `users`; PHẢI là thành viên đội của dự án lúc giao |
| `org_id` | uuid | |
| `assigned_by` | uuid | |
| `assigned_at` | timestamptz | |

Khoá chính: `(round_case_id, user_id)`. Chỉ mục: `(user_id)` cho "Việc của tôi" (FR-032), lọc thêm `qa_rounds.state =
open`.

## Hub: bảng `qa_result_history` (mới, RLS)

Bản cũ của kết quả tay trước mỗi lần lưu (FR-034).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `round_case_id` | uuid | FK ghép tới `qa_round_cases` (CASCADE) |
| `revision` | int | `revision` của bản cũ |
| `org_id` | uuid | |
| `status`, `failed_step`, `note`, `links` | như `qa_round_cases` | |
| `recorded_by`, `recorded_at`, `recorded_case_version` | như `qa_round_cases` | |
| `note_deleted` | bool default false | admin đã xoá ghi chú (edge case dữ liệu người bệnh); `note` thành null |
| `changed_by` | uuid | người lưu bản mới |
| `changed_at` | timestamptz | |

Khoá chính: `(round_case_id, revision)`.

Admin xoá ghi chú: đặt `note = null` ở `qa_round_cases` và mọi dòng lịch sử của TC đó trong đợt, đặt `note_deleted =
true`, ghi audit không chứa nội dung ghi chú (FR-070).

## Hub: bảng `qa_case_status` (mới, RLS)

Bảng chiếu trạng thái hiện tại, một dòng mỗi TC (D12, FR-052).

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `case_id` | uuid pk | FK ghép tới `qa_cases` (CASCADE) |
| `org_id` | uuid | |
| `project_id`, `area_id` | uuid | chép từ `qa_cases` để gộp theo dự án và khu |
| `ci_status` | text null | trạng thái CI mới nhất trên nhánh tham chiếu |
| `ci_at` | timestamptz null | `qa_ci_runs.finished_at` của lần đó |
| `ci_run_id` | uuid null | FK `ON DELETE SET NULL (ci_run_id)` |
| `manual_status` | text null | `passed`, `failed`, `other`; ba trạng thái còn lại không tính (FR-052) |
| `manual_at` | timestamptz null | `recorded_at` |
| `manual_round_case_id` | uuid null | FK `ON DELETE SET NULL (manual_round_case_id)` |
| `current_status` | text generated stored | xem luật dưới |
| `current_source` | text generated stored | `ci`, `manual`, null |
| `updated_at` | timestamptz | |

Chỉ mục: `(project_id, current_status)`, `(project_id, area_id)`.

Luật `current_status` (FR-052):

- Chỉ một phía có giá trị → giá trị đó.
- Hai phía có giá trị → phía có thời điểm mới hơn. Bằng nhau → kết quả tay.
- Không phía nào → null, dashboard hiện "Chưa có kết quả" (FR-051).

Luật cập nhật:

| Sự kiện | Việc trong cùng transaction |
|---|---|
| Lần chạy chuyển `done`, `is_reference`, `kind = branch` | ghi `ci_*` cho TC của lần chạy khi `finished_at > ci_at` hoặc `ci_at` null |
| Gửi lại cùng pipeline (FR-027) | xoá rồi thêm `qa_ci_run_cases` của lần chạy, tính lại `ci_*` của TC liên quan |
| Đổi `reference_branch` của nguồn | tính lại `ci_*` của mọi TC của dự án |
| Lưu kết quả tay | tính lại `manual_*` của TC từ `qa_round_cases` mới nhất có trạng thái tính |
| Xoá nguồn, hàm giữ dữ liệu | tính lại `ci_*`, `manual_*` của TC bị ảnh hưởng |
| TC mới | thêm dòng rỗng |

Quyết định của người viết, cần chủ dự án xác nhận:

1. CI "Bỏ qua" tính là có kết quả, theo câu chữ của FR-051 và FR-052. Hệ quả: TC luôn bị skip không vào số "Chưa có
   kết quả".
2. Trạng thái xấu nhất cho FR-054 gộp cả hai nguồn: `failed` > `other` > `flaky` > `skipped` > `passed` > chưa có.
3. Hai nguồn cùng thời điểm thì kết quả tay thắng.

## Mã trạng thái và chữ giao diện

| Nguồn | Mã | Chữ giao diện |
|---|---|---|
| CI | `passed`, `flaky`, `failed`, `skipped` | Đạt, Chập chờn, Không đạt, Bỏ qua |
| Tay | `passed`, `failed`, `other` | Đạt, Không đạt, Khác |
| Tay | `untested`, `not-applicable`, `deferred` | Chưa test, Không test, Chuyển đợt sau |
| TC | `active`, `retired` | Đang dùng, Ngừng dùng |
| Lần chạy | `waiting`, `reading`, `done`, `no-report`, `error`, `expired` | Chờ máy, Đang đọc, Đã đọc, Không có báo cáo, Lỗi đọc, Hết hạn |

Mã sống ở `packages/contracts/src/testing.ts`; chữ giao diện ở web.

## Tính số liệu dashboard

| Số liệu | Cách tính | FR |
|---|---|---|
| Tỉ lệ đạt | `count(current_status = passed) / count(current_status not null)` trên TC `active` | FR-051 |
| Theo khu | gộp `qa_case_status` nối `qa_cases` theo `area_id` | FR-053 |
| Theo yêu cầu | `unnest(qa_cases.requirements)` rồi lấy trạng thái xấu nhất | FR-054 |
| Xu hướng | `qa_ci_runs` có `is_reference`, `read_state = done`, 90 ngày; tỉ lệ = `passed / (passed + flaky + failed + skipped)` | FR-055 |
| Xu hướng theo khu | gộp `qa_ci_run_cases` theo `area_id` của các lần chạy trên | FR-055 |
| Chập chờn | `qa_ci_run_cases` của 10 lần chạy tham chiếu gần nhất mỗi nguồn; có `flaky`, hoặc ≥ 3 lần đổi giữa `passed` và `failed` | FR-056 |

[Inference] Xu hướng tính tỉ lệ đạt trên mọi TC của lần chạy, kể cả TC ngừng dùng. FR-055 không nói rõ; chốt ở tasks.

## Giữ dữ liệu (FR-072, D16)

Hàm `hive.purge_qa_data()` (`SECURITY DEFINER`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE TO hive_app`), gọi qua
`withTenant()`:

1. Lấy `retention_days` của tổ chức (mặc định 365).
2. Xoá `qa_rounds` `closed` có `closed_at` cũ hơn mốc. CASCADE xoá `qa_round_cases`, `qa_round_assignees`,
   `qa_result_history`.
3. Xoá `qa_ci_runs` có `finished_at` (hoặc `created_at` khi null) cũ hơn mốc. CASCADE xoá `qa_ci_run_cases`.
4. Tính lại `qa_case_status` của TC bị ảnh hưởng.

Các bảng bị xoá có thêm policy `<bảng>_owner_select` và `<bảng>_owner_purge` cho `hive_owner`. Không xoá `qa_cases`,
`qa_case_versions`: thư viện là dữ liệu của tài liệu, không phải dữ liệu chạy.

## Phụ thuộc 032

- `delivery_jobs.kind` thêm `test-report` (D6). `deploy_id` null.
- 032 FR-014 cho việc chờ máy tối đa 15 phút rồi `failed runner_offline`. FR-022 cần 24 giờ.
  - Ưu tiên: hàm tạo việc của 032 (T011) nhận `maxWaitSec` theo việc; mặc định 900, `test-report` dùng 86.400.
  - Dự phòng nếu 032 không thêm: `qa` nhận `runner_offline` thì tạo việc mới cho cùng pipeline khi
    `now() - waiting_since < 24 giờ`; quá 24 giờ thì `expired`.
  - [Inference] Cả hai cách cho cùng hành vi nhìn từ dashboard; cách dự phòng tạo tối đa 96 việc `failed` mỗi pipeline.
