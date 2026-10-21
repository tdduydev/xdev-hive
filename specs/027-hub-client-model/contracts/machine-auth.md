# Contract: khoá máy, access token máy, token git theo run (US3)

Nguồn zod: `packages/contracts/src/fleet.ts` (sửa), `packages/contracts/src/worker-protocol.ts` (sửa).

## Đăng ký khoá

Máy mới: `register` nhận `publicKey` (trường đã có, nay bắt buộc với worker mới) và `keyStorage`:

```ts
export const registerInput = z.object({
  // ...trường hiện có
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(), // Ed25519, base64url không padding
  keyStorage: z.enum(["keychain", "file"]).optional(),
});
```

Máy đã đăng ký trước bản này: `POST /api/v1/worker/key`, xác thực `Authorization: Bearer hwm_…`.

```ts
export const workerKeyInput = z.object({ publicKey, keyStorage: z.enum(["keychain", "file"]) });
export const workerKeyOutput = z.object({ machineId: z.uuid(), registeredAt: z.iso.datetime() });
```

- Máy đã có khoá thì trả `409 MACHINE_KEY_EXISTS`; thay khoá phải đăng ký lại máy bằng mã đăng ký mới.
- Thành công thì `machine_tokens.superseded_at = now()`: `hwm_` này không mở WSS hay gọi API được nữa. Audit
  `machine.key_register`.

## Đổi chữ ký lấy access token

```
GET  /api/v1/worker/challenge?machine=<id>   → { nonce: string, expiresAt }   // HMAC(secret, id|exp), 60 s
POST /api/v1/worker/token                    → { accessToken, expiresAt }
```

```ts
export const workerTokenInput = z.object({
  machineId: z.uuid(),
  nonce: z.string().max(200),
  /** Ed25519 trên chuỗi UTF-8 "xdev-hive-machine-token\n<hubUrl>\n<machineId>\n<nonce>", base64url. */
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
```

- Lỗi chung một mã `401 MACHINE_AUTH_FAILED` cho: nonce sai hoặc hết hạn, chữ ký sai, máy không có khoá, máy bị thu
  hồi. Không cho biết lý do (giống `invalidRegistration`).
- Access token: JWT HS256, khoá HKDF từ `HIVE_AUTH_SECRET` nhãn `xdev-hive machine token v1`. Claims: `iss`,
  `aud=<publicUrl>/worker`, `sub=machine:<id>`, `org_id`, `team_id`, `iat`, `exp` (15 phút), `jti`.
- Giới hạn tốc độ: 30 lần/phút cho mỗi máy, 300 lần/phút cho mỗi IP.

## Dùng access token

| Chỗ | Đổi |
|---|---|
| WSS `/ws/worker` | Nhận `Bearer <access token>`. `hwm_` chỉ còn được nhận khi máy chưa có khoá (giai đoạn chuyển, FR-005) |
| `welcome.accessTokenExp` | Đặt bằng `exp` của token đã mở kết nối |
| `POST /api/v1/client-events` | Chỉ nhận access token máy |

Gói mới worker → hub (máy cũ không gửi, hub cũ bỏ qua là đóng kết nối, nên worker chỉ gửi khi `welcome.accessTokenExp`
có giá trị):

```ts
export const reauth = z.object({ ...envelope("reauth"), accessToken: z.string().max(2048) });
```

Hub kiểm token mới cùng máy; sai thì đóng `4401`. Hết `exp` mà chưa có `reauth` hợp lệ thì đóng `4401`. Worker đổi token
2 phút trước hạn và gửi `reauth`; nhận `4401` thì xin token mới rồi nối lại; xin không được thì dừng như máy bị thu hồi.

## Token git theo run

Gói `lease` thêm trường tuỳ chọn:

```ts
export const runGitCredential = z.object({
  host: z.string().max(255),            // github.com, gitlab.example.com
  username: z.string().max(100),        // x-access-token (GitHub), oauth2 (GitLab)
  token: z.string().max(4096),
  expiresAt: z.iso.datetime(),
  repo: z.string().max(500),
});
// lease: { ...hiện có, git: runGitCredential.nullable().optional() }
```

- `git` không có (hub cũ) hoặc `null` (kết nối SCM là PAT): worker dùng thông tin git trên máy như hiện nay và gửi
  `run_event` `phase` kèm `gitCredential: "machine"`.
- GitHub token hết hạn 1 giờ. Run còn chạy khi còn 10 phút thì worker gửi:

```ts
export const gitTokenRequest = z.object({ ...envelope("git_token_request"), runId, attempt });
// hub trả gói git_token { runId, attempt, git: runGitCredential } hoặc không trả gì nếu run không còn trên máy.
```

- Worker chỉ đưa token vào `gitexec` của run đó (askpass, `credential.helper=` rỗng); không ghi ra đĩa, không đưa vào
  môi trường của CLI agent.
