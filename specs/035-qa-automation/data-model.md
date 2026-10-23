# Data Model: AI SDLC cho tester (QA Automation)

Mọi bảng trong schema `hive`, có `org_id uuid not null`, policy `<bảng>_rw` (`org_id = hive.ctx_org()` cho
`hive_app`), `ENABLE` và `FORCE ROW LEVEL SECURITY`. Giá trị liệt kê dùng `text` + `check` như các bảng `sdlc_*`
(không dùng enum Postgres để tránh `ALTER TYPE ADD VALUE`).

## qa_test_cases

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | |
| org_id | uuid | |
| project_id | uuid | dự án chứa TC |
| item_id | uuid null | hạng mục QA tạo ra TC; tham chiếu mềm, không khoá ngoại: TC sống lâu hơn hạng mục (xoá hạng mục không xoá TC) |
| code | text | `TC-\d{3,5}`, `unique(project_id, code)` |
| title | text | ≤ 300 |
| priority | text | `P1` `P2` `P3` |
| automation | text | `manual` `automated` |
| requirement_ids | text[] | FR/AC |
| script_path | text null | đường dẫn trong repo |
| test_key | text null | khoá trong báo cáo; chỉ mục `(project_id, test_key)` |
| status | text | `active` `retired` |
| in_regression | boolean | |
| quarantined | boolean | |
| quarantine_reason | text null | |
| flaky | boolean | theo lịch sử |
| last_status | text null | `passed` `failed` `skipped` `flaky` |
| last_run_id | uuid null | `qa_test_runs.id` |
| last_run_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

## qa_test_runs

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | |
| org_id | uuid | |
| project_id | uuid | |
| item_id | uuid null | hạng mục QA (bước `test-run`) |
| step_row_id | uuid null | `sdlc_steps.id` |
| run_id | uuid null | run của hub; `unique` |
| schedule_id | uuid null | lịch (đợt sau) |
| trigger | text | `step` `schedule` `merge` `release` |
| runner | text | `playwright` `junit` `pytest` `other` |
| suite | text null | |
| environment | text null | tên môi trường, không URL |
| machine_id | uuid null | máy chạy (từ run) |
| status | text | `running` `passed` `failed` `error` `no_machine` |
| total, passed, failed, skipped, flaky | integer | |
| duration_ms | integer | |
| commit_sha | text null | |
| truncated | boolean | hub chỉ giữ một phần kết quả |
| settled_at | timestamptz null | đã chốt vào TC và lỗi |
| created_at, finished_at | timestamptz | |

Chỉ mục: `(project_id, created_at desc)`.

## qa_test_results

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | |
| org_id | uuid | |
| test_run_id | uuid | khoá kép → `qa_test_runs(id, org_id)` cascade |
| case_id | uuid null | TC khớp |
| test_key | text | ≤ 500 |
| name | text | ≤ 500 |
| file | text null | |
| status | text | `passed` `failed` `skipped` `flaky` |
| retries | integer | |
| duration_ms | integer | |
| message | text null | đã che, ≤ 500 |
| created_at | timestamptz | |

Chỉ mục: `(case_id, created_at desc)`, `(test_run_id)`. Tối đa 2.000 dòng mỗi lần chạy.

## qa_defects

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | |
| org_id | uuid | |
| project_id | uuid | |
| case_id | uuid | khoá kép → `qa_test_cases(id, org_id)` cascade; `unique(case_id)` |
| bugfix_item_id | uuid null | hạng mục `bugfix` |
| first_run_id, last_run_id | uuid | `qa_test_runs.id` |
| passing_since_run_id | uuid null | |
| fail_count | integer | |
| status | text | `open` `passing` `closed` |
| last_message | text null | đã che |
| opened_at, closed_at | timestamptz | |
| closed_by | text null | user id |
| close_reason | text null | |

## qa_schedules

| Cột | Kiểu | Ghi chú |
|---|---|---|
| id | uuid pk | |
| org_id | uuid | |
| project_id | uuid | |
| name | text | ≤ 80 |
| trigger | text | `cron` `merge` `release` |
| cron | text null | bắt buộc khi `trigger = cron` (check) |
| timezone | text | IANA |
| labels | text[] | nhãn máy thêm |
| environment | text null | |
| suite | text null | lệnh hoặc tên bộ (vd `regression`) |
| enabled | boolean | |
| next_at | timestamptz null | |
| last_fired_at | timestamptz null | |
| created_by | text | |
| created_at, updated_at | timestamptz | |

## Chuyển trạng thái

- TC: `active` ↔ `retired` (theo bảng `test-cases`). `quarantined` do tester. `flaky` do chốt lần chạy.
- Lỗi: (không có) → `open` (fail thật) → `passing` (pass lại) → `closed` (tester). `closed`/`passing` → `open` khi fail
  thật lại.
- Lần chạy: `running` → `passed`/`failed` (khi nhận báo cáo) → `settled_at` (khi run kết thúc thành công); run lỗi →
  `error`.
