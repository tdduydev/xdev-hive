# Data model: Kho bí mật tại máy cho agent AI

**Spec**: [spec.md](spec.md) · **Research**: [research.md](research.md)

Mọi file dưới đây nằm trong thư mục cấu hình worker, cạnh `projects.json` (`filepath.Dir(workerConfig)`). Quyền 0600,
ghi nguyên tử (file tạm + rename). Không file nào chứa giá trị, băm hay độ dài giá trị (FR-002, SC-004).

## 1. Kho hệ điều hành (giá trị)

| Thuộc tính | Giá trị |
|---|---|
| Dịch vụ | `dev.xdev.hive.secrets` (A9). Không trùng `dev.xdev.hive` (token Hive) và `dev.xdev.hive.git` |
| Tài khoản mục đầu | `<NAME>` (tên biến) |
| Nội dung mục đầu | `v1:<n>:<base64 std của khối 0>`, `n` = số khối (1–5) |
| Tài khoản khối sau | `<NAME>#1` … `<NAME>#<n-1>` |
| Nội dung khối sau | base64 std của khối |
| Cỡ khối | ≤1800 byte giá trị gốc **[Unverified]** (research D2, T001 kiểm) |

Quy tắc:

- **Ghi**:
  1. Ghi khối `n-1` trước, khối 0 sau cùng.
  2. Xoá `<NAME>#k` với `k ≥ n` còn sót từ giá trị cũ dài hơn.
- **Đọc**:
  1. Đọc khối 0 và tách `n`.
  2. Đọc đủ `n-1` khối còn lại.
  3. Ghép rồi giải base64.
  4. Thiếu khối hay sai tiền tố `v1:` thì trả `ErrCorrupt` (báo "Bí mật X bị hỏng trong kho, hãy đặt lại giá trị").
- **Xoá**: xoá mọi khối, rồi mới gỡ khỏi danh mục.

## 2. `secrets.json` — danh mục (LocalSecret + SecretAssignment)

```json
{
  "version": 1,
  "secrets": [
    {
      "name": "STRIPE_TEST_KEY",
      "description": "Khoá Stripe môi trường test, quyền đọc",
      "createdAt": "2026-10-23T08:00:00Z",
      "valueChangedAt": "2026-10-23T08:00:00Z",
      "projects": ["3f9a1c0e7b2d4a55"]
    }
  ]
}
```

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `version` | int | `1`. File có version lớn hơn → chỉ đọc, báo "Danh mục bí mật do bản mới hơn tạo" |
| `secrets[].name` | string | `^[A-Z_][A-Z0-9_]*$`, ≤64, duy nhất (FR-003). Không thuộc danh sách dành riêng (FR-004) |
| `secrets[].description` | string | ≤500 ký tự; `looksSecret` false (FR-021). Rỗng được |
| `secrets[].createdAt` | RFC 3339 UTC | |
| `secrets[].valueChangedAt` | RFC 3339 UTC | Đổi mỗi lần đặt giá trị |
| `secrets[].projects` | string[] | `localId` của `projects.json`, không trùng (FR-010) |

Ràng buộc chéo:

- Mỗi `localId` có tối đa 64 bí mật gán (FR-005). Gán thứ 65 bị từ chối với lỗi "Dự án đã có 64 bí mật".
- **[Inference]** Tổng `len(name)+len(value)+2` của bí mật gán cho một dự án nên ≤ 24 KiB trên Windows. Khối env của
  Windows giới hạn 32 KiB, và cần chừa chỗ cho env của máy.
  - Khi gán, `secretstore` chỉ kiểm được tên, vì danh mục không có độ dài giá trị.
  - Vì vậy kiểm khi `Grant`. Vượt ngưỡng → `ErrEnvTooLarge` (tiếng Việt, liệt kê tên).
- `localId` không còn trong `projects.json` bị bỏ khi đọc. Lệnh `projects unbind` gọi `DropProject` (FR-063).

Tên dành riêng (FR-004), dùng chung Go và TS (`packages/contracts/src/local-secrets.ts` xuất cùng danh sách):

- Đúng tên: `PATH`, `HOME`, `USER`, `USERNAME`, `USERPROFILE`, `SHELL`, `COMSPEC`, `TEMP`, `TMP`, `TMPDIR`, `PATHEXT`,
  `NODE_OPTIONS`.
- Tiền tố: `HIVE_`, `LD_`, `DYLD_`, `GIT_`, `SSH_`, `ANTHROPIC_`, `OPENAI_`, `CLAUDE_`, `CODEX_`, `GEMINI_`.

## 3. `projects.json` — thêm `localId`

```go
type Project struct {
	LocalID        string `json:"localId"`        // mới: 16 hex ngẫu nhiên, không đổi khi dời thư mục
	ProjectID      string `json:"projectId"`
	Name           string `json:"name"`
	Folder         string `json:"folder"`
	FullPermission bool   `json:"fullPermission"`
}
```

- `LocalID` được sinh trong `AddFolder` và `Bind`. Nếu `Load` gặp dòng thiếu, nó sinh `LocalID` trong `WithLock` rồi ghi
  lại một lần.
- Worker cũ đọc file mới vẫn chạy, vì trường lạ bị bỏ qua. Nếu worker cũ ghi lại file, `localId` mất. Worker mới sẽ sinh
  `localId` khác, và gán cũ trở thành mồ côi.
  - **[Inference]** Trường hợp hiếm, vì desktop và worker cập nhật cùng nhau.
  - Ghi vào quickstart mục "Rủi ro".

## 4. `secret-grants.jsonl` — nhật ký cấp (SecretGrantLog)

Mỗi dòng một JSON:

```json
{"id":"g_01JB…","at":"2026-10-23T08:01:02Z","kind":"run","sessionId":"run_abc#1","project":"3f9a1c0e7b2d4a55","projectName":"shop-api","names":["STRIPE_TEST_KEY"],"policy":"allow","outcome":"granted","leaked":[]}
```

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | string | `g_` + 26 ký tự ULID-tương đương; dùng cho `MarkLeaked` |
| `at` | RFC 3339 UTC | |
| `kind` | `run` \| `terminal` \| `reveal` | `reveal` gồm cả Sao chép (`copy: true`) (FR-041) |
| `sessionId` | string | `<runId>#<attempt>`, mã phiên terminal hay rỗng với `reveal` |
| `project` | string | `localId`; rỗng với `reveal` |
| `projectName` | string | tên lúc ghi, để vẫn đọc được sau khi dự án bị gỡ |
| `names` | string[] | tên bí mật đã cấp hoặc đã yêu cầu |
| `policy` | `allow` \| `approve` \| `deny` | chính sách đã áp |
| `outcome` | `granted` \| `denied` \| `declined` \| `timeout` \| `store_error` | `declined` là người dùng từ chối khi `approve` |
| `leaked` | string[] | tên có giá trị xuất hiện trong output (FR-037) |
| `copy` | bool | chỉ với `reveal` |

- Nhãn "đã xoá" (FR-044) không ghi vào file. Lúc đọc, tên không còn trong `secrets.json` được hiện kèm nhãn "đã xoá".
- **`MarkLeaked`**: ghi thêm dòng `{"id":"<id gốc>","kind":"leak","names":[…],"at":…}`. Lúc đọc, `leaked` được gộp vào
  dòng gốc. Cách này giữ file chỉ ghi nối.
- **Cắt tỉa**: mỗi lần mở để ghi, nếu dòng đầu cũ hơn 90 ngày (A7) hoặc file có hơn 10 000 dòng, ghi lại file không có
  các dòng đó.
- **Xoá toàn bộ** (FR-042): `secrets log clear` thay file bằng file rỗng.

## 5. `secrets-policy.json` — chính sách đã biết (SecretPolicy tại máy)

```json
{ "version": 1, "hubs": { "https://hive.example.com": { "secretInjection": "approve", "at": "2026-10-23T08:00:00Z" } } }
```

- Ghi khi nhận `welcome.policy.secretInjection` (hub mới). Hub cũ không gửi trường → không ghi.
- Phiên desktop của dự án liên kết đọc theo hub đang đăng nhập. Không có mục → `deny` (FR-053, A5).

## 6. `secret-approvals/<id>.json` — yêu cầu duyệt (chỉ khi `approve`)

```json
{ "id": "a_01JB…", "runId": "run_abc", "project": "3f9a1c0e7b2d4a55", "projectName": "shop-api",
  "names": ["STRIPE_TEST_KEY"], "createdAt": "…", "expiresAt": "…(+120 s)", "answer": null }
```

- Desktop trả lời bằng cách gọi `secrets approve`, lệnh này ghi `answer: "allow" | "deny"`. Worker đọc lại mỗi giây.
- Worker xoá file khi có trả lời hay hết hạn. Lúc khởi động, worker xoá file quá hạn.

## 7. Contracts và hub

### `packages/contracts/src/policies.ts`

```ts
export const secretInjection = z.enum(["allow", "approve", "deny"]);
// agentPolicyInput: thêm
secretInjection: secretInjection.default("allow"),
// jobPolicy: thêm (tuỳ chọn để hub cũ, worker cũ không vỡ)
secretInjection: secretInjection.optional(),
```

- `DEFAULT_AGENT_POLICY.secretInjection = "allow"`.
- Hub không cần migration: chính sách lưu nguyên object JSON (`governance/schema.ts`). Dòng cũ thiếu trường được
  `default("allow")` điền khi parse.

### `packages/contracts/src/worker-protocol.ts`

- `welcome.policy`: `z.object({ totpFallback: z.boolean(), secretInjection: secretInjection.optional() })`.
- `runResult.report` (record): khoá mới `secretsInjected` (int 0–64) do worker thêm. Hub đọc bằng schema riêng
  `runSecretsReport = z.object({ secretsInjected: z.number().int().min(0).max(64) }).partial()`.
- Fixture `packages/contracts/fixtures/worker-protocol.json` thêm một mẫu `welcome` có `secretInjection` và một mẫu
  `run_result` có `report.secretsInjected`.

### Go (`worker/internal/runner/hooks.go`, `channel/protocol.go`)

```go
type JobPolicy struct {
	Hooks            []Hook `json:"hooks"`
	ManagedHooksOnly bool   `json:"managedHooksOnly"`
	SecretInjection  string `json:"secretInjection,omitempty"` // rỗng = hub không gửi = allow
}
type WelcomePolicy struct {
	TOTPFallback    bool   `json:"totpFallback"`
	SecretInjection string `json:"secretInjection,omitempty"`
}
// runner.Result: thêm
SecretsInjected int `json:"secretsInjected,omitempty"`
```

## 8. Chuyển trạng thái một lần cấp

```
yêu cầu (run / terminal)
  └─ dự án không có gán ─────────────────────────────▶ không ghi nhật ký, không khối ngữ cảnh
  └─ có gán
       ├─ policy deny ──────────────────────────────▶ outcome=denied, khối "không có bí mật"
       ├─ policy approve ─▶ chờ trả lời (≤120 s)
       │       ├─ allow ─▶ (đọc kho)
       │       └─ deny / hết hạn ───────────────────▶ outcome=declined|timeout, chạy không bí mật
       └─ policy allow ─▶ (đọc kho)
                 ├─ ok ─────────────────────────────▶ outcome=granted, env + khối tên + Masker
                 └─ khoá / không có / thiếu mục ────▶ outcome=store_error, run dừng trước spawn (FR-060)
```
