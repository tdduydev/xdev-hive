# Contract: việc worker `test-report`

Mở rộng giao thức việc của 032 ([delivery-job-protocol.md](../../032-worker-delivery/contracts/delivery-job-protocol.md)).
Định nghĩa zod ở `packages/contracts/src/delivery-worker.ts`. Mọi thay đổi là cộng thêm: worker cũ vẫn đọc được việc cũ.

## Khả năng

```json
{
  "methods": ["ssh-script"],
  "credentials": ["gitlab-main"],
  "kinds": ["test-report"]
}
```

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `kinds` | mảng enum, tối đa 16, mặc định `[]` | loại việc không phải cách triển khai. Bản này chỉ có `test-report` |

- `test-report` KHÔNG nằm trong `DELIVERY_METHODS`: cấu hình môi trường deploy không được chọn nó.
- Worker cũ không gửi `kinds` nên nhận mặc định `[]` và không được chọn cho việc `test-report`.

## Chọn máy

[Inference: `selectRunner` ở `apps/hub/src/modules/delivery/runner-select.ts` chưa có nơi gọi ngoài test, nên tổng quát
hoá chưa ảnh hưởng code đang chạy.]

- `RunnerNeeds.method` đổi thành `need: { method } | { kind: "test-report" }`.
- Danh sách máy: mọi máy của tổ chức, xếp theo thời điểm đăng ký, cũ trước. Nguồn CI không có danh sách máy riêng.
- Không đòi nhãn (`requireLabel: false`).
- Lọc theo thứ tự: trực tuyến, có `test-report` trong `kinds`, có `credential` của nguồn trong `credentials`.

Thông điệp chờ của `test-report` (hiện ở dòng lần chạy CI, trạng thái "Chờ máy"):

| Lý do | Thông điệp |
|---|---|
| `no_machines` | "Tổ chức chưa có máy nào để đọc kết quả test. Đăng ký một máy ở mục Máy." |
| `offline` | "Không có máy đọc kết quả test nào đang trực tuyến." |
| `no_capability` | "Máy trực tuyến chưa hỗ trợ đọc kết quả test. Cập nhật worker." |
| `missing_credential` | "Máy trực tuyến chưa có credential GitLab của nguồn này. Thêm credential trên máy đó." |

## Job spec

| Trường | Giá trị |
|---|---|
| `kind` | `test-report` |
| `deployId` | `null` |
| `configVersion` | `0`: nguồn CI không có phiên bản cấu hình |
| `target` | `{ "baseUrl": "https://gitlab.example.com" }`, lấy từ `repo_web_url` của nguồn |
| `credential` | `qa_ci_sources.credential` (`credentialRef`) |
| `params` | union theo `op`, xem dưới |
| `timeoutSeconds` | `read`: 600; `list`: 120 |

### `op = read`

```json
{
  "op": "read",
  "projectPath": "group/e2e-tests",
  "pipelineId": 18342,
  "mode": "playwright-artifact",
  "jobFilter": ["e2e:*"],
  "artifactPath": "playwright-report/results.json"
}
```

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `projectPath` | string | 1–255 ký tự, mẫu `^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)+$` |
| `pipelineId` | int | ≥ 1 |
| `mode` | enum | `pipeline-report`, `junit-artifact`, `playwright-artifact` |
| `jobFilter` | mảng string | tối đa 20, mỗi mục ≤ 100 ký tự, `*` là ký tự đại diện; rỗng là mọi job |
| `artifactPath` | string | ≤ 255 ký tự, không có `..`, không bắt đầu bằng `/`; bắt buộc với hai mode artifact |

### `op = list`

```json
{ "op": "list", "projectPath": "group/e2e-tests", "ref": "main", "updatedAfter": "2026-10-16T00:00:00Z", "limit": 20 }
```

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `ref` | string, không bắt buộc | ≤ 255 ký tự |
| `updatedAfter` | datetime, không bắt buộc | |
| `limit` | int | 1–500 |

Worker chỉ trả pipeline đã xong (`success`, `failed`, `canceled`, `skipped`, `manual`).

## Sự kiện

Hai nhánh mới của `deliveryEvent`, đều dùng `eventBase` (`jobId`, `seq`, `at`) và đều `.strict()`. Việc vẫn kết thúc bằng
`finished`.

### `test-results` (một lần cho `op = read`)

```json
{
  "type": "test-results",
  "jobId": "2f0c…",
  "seq": 3,
  "at": "2026-10-23T08:10:00Z",
  "pipeline": {
    "ref": "main",
    "sha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
    "status": "failed",
    "source": "push",
    "startedAt": "2026-10-23T07:52:00Z",
    "finishedAt": "2026-10-23T08:05:00Z"
  },
  "jobIds": [99120, 99121],
  "totals": { "total": 214, "passed": 205, "failed": 4, "skipped": 3, "flaky": 2 },
  "unmapped": 11,
  "ambiguous": 1,
  "unknownCodes": ["TC-KHAM-0999"],
  "truncated": false,
  "cases": [
    { "code": "TC-KHAM-001", "status": "passed", "retries": 0, "durationMs": 4210, "worstJobId": 99120 },
    { "code": "TC-KHAM-002", "status": "flaky", "retries": 1, "durationMs": 9800, "worstJobId": 99121 }
  ]
}
```

| Trường | Ràng buộc |
|---|---|
| `pipeline.status` | `success`, `failed`, `canceled`, `skipped`, `manual` |
| `pipeline.sha` | 40 ký tự hex |
| `jobIds` | tối đa 100 |
| `totals.*` | int ≥ 0; `total` là số test đọc được, kể cả test không có mã |
| `unmapped` | số test không có mã TC |
| `ambiguous` | số test có từ hai mã TC trở lên; không đưa vào `cases` |
| `unknownCodes` | mã đúng mẫu nhưng worker không biết có trong thư viện hay không; tối đa 200 (`QA_UNKNOWN_CODES_MAX`) |
| `cases` | tối đa 5.000; mỗi mã một dòng |
| `cases[].status` | `passed`, `failed`, `skipped`, `flaky` |
| `cases[].retries` | int 0–20 |
| `cases[].durationMs` | int ≥ 0 |
| `cases[].worstJobId` | job có kết quả xấu nhất của mã đó; hub dựng liên kết job từ `repo_web_url` |
| `truncated` | `true` khi worker cắt `cases` ở 5.000 |

`unknownCodes` là mã worker thấy trong báo cáo. Hub so với thư viện và chỉ giữ mã không có trong thư viện.
[Inference: worker không có danh sách mã, nên lọc ở hub.]

[Inference: 5.000 dòng `cases` khoảng 500 KB JSON, dưới `maxPayload` 2 MiB của websocket fleet
(`fleet/gateway.ts:131`).]

### `pipelines` (một hoặc nhiều lần cho `op = list`)

```json
{
  "type": "pipelines",
  "jobId": "7a1d…",
  "seq": 2,
  "at": "2026-10-23T08:00:00Z",
  "items": [
    {
      "pipelineId": 18342,
      "ref": "main",
      "sha": "9fceb02d0ae598e95dc970b74767f19372d61af8",
      "status": "failed",
      "source": "push",
      "startedAt": "2026-10-23T07:52:00Z",
      "finishedAt": "2026-10-23T08:05:00Z"
    }
  ]
}
```

- `items` tối đa 100 mỗi sự kiện. `startedAt`, `finishedAt` có thể `null`.
- Hub tạo `qa_ci_runs` cho pipeline chưa có, rồi tạo việc `op = read` cho từng dòng mới.

## Đọc báo cáo tại worker

1. Lấy danh sách job của pipeline, lọc theo `jobFilter`.
2. Đọc báo cáo theo `mode` (research D7). File lớn hơn 32 MiB thì dừng với `report_too_large`.
3. Hai mode artifact dùng bộ đọc `worker/internal/testreport` với `Library = true` (research D8): cùng luật đổi trạng
   thái JUnit và Playwright của 035 FR-007, regex mã `\bTC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}\b`.
4. Mode `pipeline-report` đổi trạng thái của GitLab test report:

   | `status` của GitLab | `status` gửi hub |
   |---|---|
   | `success` | `passed` |
   | `failed`, `error` | `failed` |
   | `skipped` | `skipped` |

   [Unverified: tên trạng thái lấy từ tài liệu GitLab test report API, chưa đối chiếu với pipeline thật. Mode này
   không có `flaky`.]
5. Một mã xuất hiện ở nhiều test hoặc nhiều job: giữ kết quả xấu nhất theo thứ tự `failed` > `flaky` > `skipped` >
   `passed`; `retries` lấy lớn nhất; `durationMs` cộng dồn. Luật này giống `testreport` hiện tại.

## Không được gửi (FR-025)

Sự kiện KHÔNG ĐƯỢC chứa tên test, tên file, thông báo lỗi, stack trace, stdout, stderr, ảnh, trace, đường dẫn artifact
ngoài `artifactPath` đã nhận. Schema `.strict()` làm hub từ chối trường lạ: hub đánh dấu lần chạy `error` với
`read_error_code = report_invalid`.

## Mã lỗi của `finished`

| `error.code` | Khi nào | `qa_ci_runs.read_state` |
|---|---|---|
| `no_report` | pipeline không có báo cáo hoặc không có file ở `artifactPath` | `no-report` |
| `report_too_large` | file báo cáo lớn hơn 32 MiB | `error` |
| `report_invalid` | không đọc được JSON hoặc XML | `error` |
| `gitlab_auth` | GitLab trả 401 hoặc 403 | `error` |
| `gitlab_not_found` | không thấy project hoặc pipeline | `error` |
| `gitlab_unreachable` | lỗi mạng, timeout, 5xx | `error`, hub cho đọc lại |
| `unsupported` | worker không hỗ trợ `mode` | `error` |
| `runner_offline` | hết thời gian chờ máy (032 FR-014) | giữ `waiting` tới 24 giờ, rồi `expired` |

- `error.message` tiếng Việt, tối đa 200 ký tự, không chứa token hay nội dung báo cáo.

## Quy tắc

- Worker chỉ gọi GitLab bằng credential của việc. Không ghi token vào log hay sự kiện.
- Worker không giữ file báo cáo sau khi việc xong.
- Việc `test-report` chỉ đọc. Worker không gọi API ghi của GitLab.
- Nhiều tổ chức trên một máy: việc chỉ chạy trong đăng ký của tổ chức tạo việc (032 multi-org).
- Đổi schema thì cập nhật `packages/contracts/src/delivery-worker.test.ts` và kiểu Go ở `worker/internal/delivery/`
  cùng commit (nguyên tắc I).
