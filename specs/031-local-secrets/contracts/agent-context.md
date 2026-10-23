# Contract: khối tên bí mật trong ngữ cảnh agent (FR-020, FR-022)

Sinh bởi `secretstore.ContextBlock(policy, items)` (Go). Desktop không tự sinh. Khối không bao giờ ghi vào file của repo
(`AGENTS.md`, `CLAUDE.md`, `.mcp.json`, `CLAUDE.local.md`).

## Có bí mật (`allow`, hoặc `approve` đã duyệt)

```markdown
## Bí mật tại máy

Phiên này có các biến môi trường sau do người dùng cấp. Dùng qua tên biến (ví dụ `$STRIPE_TEST_KEY`,
`process.env.STRIPE_TEST_KEY`). Không in, không ghi ra file, không commit giá trị. Không hỏi người dùng nhập các giá trị
này.

- `STRIPE_TEST_KEY`: Khoá Stripe môi trường test, quyền đọc
- `DB_URL_STAGING`
```

## Không có bí mật vì chính sách hoặc người dùng từ chối

```markdown
## Bí mật tại máy

Phiên này không có bí mật nào được cấp (chính sách tổ chức hoặc người dùng đã từ chối). Nếu cần thông tin đăng nhập,
dừng và báo người dùng; không đoán, không tìm trong máy.
```

## Quy tắc

- Chỉ có tên và mô tả của bí mật gán cho dự án của phiên. Không giá trị, độ dài hay băm.
- Mô tả được quét lại bằng `looksSecret` lúc sinh khối. Mô tả không đạt thì bỏ, chỉ giữ tên. Việc này phòng danh mục bị
  sửa tay.
- Dự án không có gán thì không sinh khối.
- **Đường vào agent**:

  | Phiên | Cách đưa |
  |---|---|
  | Run claude có `packInSystemPrompt` | nối vào file `--append-system-prompt-file` |
  | Run CLI khác | ghép đầu `job.Prompt`, sau gói ngữ cảnh hiện có |
  | `hive chat` (`terminal/local.go`) | nối `InteractiveSpec.SystemPrompt` |
  | Terminal desktop, `--cli claude` | `secrets exec` thêm `--append-system-prompt <khối>` |
  | Terminal desktop, CLI khác / shell | không có khối **[Inference]**: chưa có cờ tương đương, xem research D8 |

- Khối dài tối đa 64 dòng mục. Mô tả bị cắt ở 200 ký tự trong khối.
