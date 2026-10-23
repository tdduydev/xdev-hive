# Contract: route `sdlc.qa.*`

Tất cả là route của tổ chức (`/orgs/{orgSlug}/sdlc/qa/...`), cần đăng nhập và là thành viên tổ chức; quyền đọc/ghi theo
quyền dự án (`catalog`). Tới khi có 034: ghi (cách ly, đóng lỗi, lịch) cần quyền ghi dự án.

| Route | Method | Input | Output |
|---|---|---|---|
| `qa.cases` | GET | `projectId`, `status?`, `regression?`, `quarantined?` | `qaTestCase[]` |
| `qa.quarantine` | POST | `caseId`, `quarantined`, `reason?` (bắt buộc khi bật) | `qaTestCase` |
| `qa.runs` | GET | `projectId`, `limit?` (≤ 100) | `qaTestRun[]` |
| `qa.run` | GET | `id` | `qaTestRun & { results: qaTestResult[] }` |
| `qa.trend` | GET | `projectId`, `days?` (≤ 90, mặc định 30) | `{ day, total, passed, failed, flaky, runs }[]` |
| `qa.flaky` | GET | `projectId` | `qaTestCase[]` (flaky hoặc quarantined) |
| `qa.defects` | GET | `projectId`, `status?` | `qaDefect[]` |
| `qa.closeDefect` | POST | `id`, `reason` | `qaDefect` |
| `qa.coverage` | GET | `projectId`, `itemId?` | `qaCoverage` |
| `qa.schedules` | GET | `projectId` | `qaSchedule[]` |
| `qa.saveSchedule` | POST | `qaScheduleInput` (`id?` để sửa) | `qaSchedule` |
| `qa.removeSchedule` | POST | `id` | `{ ok: true }` |

`qaCoverage`:

```ts
{
  requirements: { id: string; cases: number; automated: number; passing: number }[];
  totals: { requirements: number; withCase: number; withAutomated: number; withPassing: number };
}
```

Lỗi (tiếng Việt): không thấy → "Không tìm thấy test case."/"Không tìm thấy lần chạy."/"Không tìm thấy lỗi."/
"Không tìm thấy lịch."; cron sai → "Biểu thức cron không hợp lệ."; múi giờ sai → "Múi giờ không hợp lệ.".
