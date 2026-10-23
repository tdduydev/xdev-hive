# Contract: công cụ MCP của thư viện test case

`qa/mcp-tools.ts`, export `registerMcpTools(registry)` qua `qa/index.ts`, đăng ký trong `app.ts` như các module khác.
Cả hai công cụ khai `readOnly: true`. Không có công cụ ghi (FR-061).

## Phạm vi

`qa` gọi `knowledgePrincipal(tx, principal)` của `knowledge/index.ts` để biết dự án của run, cùng cách `doc_asset_get`
của docsync.

| Người gọi | `project` bỏ trống | `project` có giá trị |
|---|---|---|
| Run (`kind = "run"`) | dự án của run | khác dự án của run thì `PROJECT_NOT_FOUND` (FR-060) |
| Người dùng OAuth | `400 PROJECT_REQUIRED` | cần `qa.read` ở đội của dự án; không có thì `PROJECT_NOT_FOUND` |

- Dự án chưa bật thư viện thì `QA_LIBRARY_DISABLED`.
- Thông điệp lỗi giống route của knowledge: "Không tìm thấy dự án trong tổ chức." Run không phân biệt được dự án không
  có và dự án của người khác.
- [Inference: run được đọc thư viện của dự án mình mà không kiểm `qa.read`, như `memory_search` và `doc_list` cho run đọc
  tri thức của dự án. Quyền của run do người giao việc quyết định lúc tạo run.]

## `qa_get_case`

| | |
|---|---|
| Tiêu đề | "Đọc test case" |
| Mô tả | "Đọc một test case của thư viện theo mã, gồm các bước, yêu cầu và kết quả gần nhất." |

Đầu vào:

```ts
z.object({
  project: projectRef.optional().describe("Dự án; mặc định là dự án của run."),
  code: z.string().regex(/^TC-[A-Z][A-Z0-9]{1,15}-[0-9]{3,5}$/).describe("Mã TC, ví dụ TC-DANGNHAP-001."),
})
```

Đầu ra:

```json
{
  "code": "TC-DANGNHAP-001",
  "name": "Đăng nhập bằng email và mật khẩu đúng",
  "area": { "code": "DANGNHAP", "name": "Đăng nhập" },
  "state": "active",
  "version": 3,
  "priority": "P1",
  "kind": "automated",
  "requirements": ["FR-001", "036/AC-012.2"],
  "labels": ["smoke", "dang-nhap"],
  "script": "tests/auth/login.spec.ts",
  "testData": "TK-NGUOIDUNG-01",
  "preconditions": "Tài khoản đã kích hoạt.",
  "note": null,
  "steps": [{ "n": 1, "action": "Mở trang đăng nhập", "expected": "Thấy ô email và ô mật khẩu" }],
  "docKey": "test-cases/dang-nhap",
  "line": 13,
  "current": { "status": "passed", "source": "ci", "at": "2026-10-23T08:05:00Z" },
  "lastCi": { "status": "passed", "pipelineId": 18342, "ref": "main", "at": "2026-10-23T08:05:00Z" },
  "lastManual": null
}
```

- Mã không có trong thư viện của dự án: `NotFoundError("QA_CASE_NOT_FOUND", "Không có TC {mã} trong thư viện của dự án.")`.
- TC `retired` vẫn trả, với `state: "retired"`, để agent biết không viết test mới cho mã này.
- `lastManual` gồm `status`, tên đợt, `at`. Không trả ghi chú, liên kết lỗi hay người ghi: agent cần trạng thái, không
  cần chữ tự do của tester.

## `qa_list_cases`

| | |
|---|---|
| Tiêu đề | "Danh sách test case" |
| Mô tả | "Liệt kê test case của thư viện theo khu, nhãn, ưu tiên, loại hoặc mã yêu cầu." |

Đầu vào:

```ts
z.object({
  project: projectRef.optional().describe("Dự án; mặc định là dự án của run."),
  area: z.string().regex(/^[A-Z][A-Z0-9]{1,15}$/).optional().describe("Mã khu."),
  label: z.string().max(40).optional(),
  priority: z.enum(["P1", "P2", "P3"]).optional(),
  kind: z.enum(["automated", "manual", "planned"]).optional(),
  requirement: z.string().max(40).optional().describe("Mã yêu cầu, ví dụ FR-001."),
  limit: z.number().int().min(1).max(MCP_LIMITS.listMax).optional().describe("Số mục; mặc định 10."),
  offset: z.number().int().min(0).optional().describe("Vị trí bắt đầu danh sách."),
})
```

Đầu ra:

```json
{
  "items": [
    {
      "code": "TC-DANGNHAP-001",
      "name": "Đăng nhập bằng email và mật khẩu đúng",
      "area": "DANGNHAP",
      "priority": "P1",
      "kind": "automated",
      "requirements": ["FR-001"],
      "labels": ["smoke"],
      "script": "tests/auth/login.spec.ts",
      "currentStatus": "passed"
    }
  ],
  "truncated": false,
  "nextOffset": null
}
```

- Chỉ TC `active`. Xếp theo mã khu rồi mã TC.
- Không trả các bước: agent gọi `qa_get_case` cho TC cần viết test. Danh sách giữ nhỏ vì `tools/list` và kết quả tool đi
  vào ngữ cảnh của run.
- Phân trang `limit`/`offset` như `doc_list`, dùng chung `MCP_LIMITS`.

## Kiểm

- `qa/mcp-tools.db.test.ts`:
  - run của dự án A đọc được TC của A;
  - run của dự án A truyền `project` của B nhận `PROJECT_NOT_FOUND`;
  - người dùng không có `qa.read` nhận `PROJECT_NOT_FOUND`;
  - `tools/list` có `readOnlyHint: true` cho cả hai công cụ.
