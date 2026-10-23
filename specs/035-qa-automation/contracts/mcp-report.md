# Contract: `sdlc_report` loại `test-results`

Gọi từ agent trong bước `test-run`, bằng token của run. Gọi lại trong cùng run thì thay toàn bộ kết quả cũ.

```json
{
  "kind": "test-results",
  "data": {
    "runner": "playwright",
    "suite": "regression",
    "environment": "staging",
    "commit": "a1b2c3d",
    "totals": { "total": 120, "passed": 115, "failed": 3, "skipped": 1, "flaky": 1 },
    "durationMs": 482000,
    "truncated": false,
    "cases": [
      {
        "key": "tests/e2e/login.spec.ts › TC-012 đăng nhập sai mật khẩu",
        "name": "TC-012 đăng nhập sai mật khẩu",
        "file": "tests/e2e/login.spec.ts",
        "status": "failed",
        "retries": 2,
        "durationMs": 5120,
        "message": "expect(locator).toHaveText(...) ..."
      }
    ]
  }
}
```

Ràng buộc (zod `qaTestReport` trong `packages/contracts/src/qa.ts`):

| Trường | Ràng buộc |
|---|---|
| `runner` | `playwright` `junit` `pytest` `other` |
| `suite`, `environment` | ≤ 80, `[\w.-]+` cho `environment` (tên, không URL) |
| `commit` | ≤ 64 |
| `totals.*`, `durationMs` | số nguyên ≥ 0 |
| `cases` | ≤ 5.000 |
| `cases[].status` | `passed` `failed` `skipped` `flaky` |
| `cases[].key`, `name` | 1–500 |
| `cases[].message` | ≤ 2.000 (hub che rồi cắt còn 500) |

Lỗi (tiếng Việt): bước không phải `test-run` → "Bước này không nhận kết quả test."; tổng không khớp khi
`truncated = false` → "Tổng số không khớp danh sách test.".

Kết quả gửi về agent: `{ ok: true, testRunId, matched, unmatched }` (số test khớp được TC).
