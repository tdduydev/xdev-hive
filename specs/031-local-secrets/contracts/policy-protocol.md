# Contract: chính sách `secretInjection` và giao thức worker

Đổi `packages/contracts` thì chạy `pnpm openapi`, cập nhật fixture `packages/contracts/fixtures/worker-protocol.json` và
kiểu Go, giữ tương thích ngược (constitution I).

## API hub (oRPC) — `/admin/policies`

`agentPolicyInput` thêm:

```ts
export const secretInjection = z.enum(["allow", "approve", "deny"]);
secretInjection: secretInjection.default("allow"),
```

- **Ghi**:
  - `policies.save` (đã có) parse bằng `agentPolicyInput`.
  - `recordAudit` (đã có) ghi `policies.update` kèm `before`/`after`, nên có trường mới.
  - Không thêm route, không đổi quyền: vẫn `policies.write`.
- **Đọc**: `policies.get` trả trường mới. Dòng cũ không có trường thì parse điền `"allow"`.
- **Ảnh chụp run**: `policy_snapshot` lưu nguyên `Policy`, nên tự có trường. Không cần migration.
- **Web** `apps/web/src/pages/admin/policies-page.tsx` có mục mới "Bí mật tại máy", dạng nhóm radio ba lựa chọn:

  | Giá trị | Chữ trên UI |
  |---|---|
  | `allow` | "Cho phép" — agent nhận bí mật đã gán, không hỏi |
  | `approve` | "Hỏi trước" — người dùng duyệt tại máy mỗi lần |
  | `deny` | "Không cho" — không đưa bí mật nào vào agent |

## Job (`job_offer.spec.policy`)

`jobPolicy` thêm `secretInjection: secretInjection.optional()`.

Hub `jobPolicyOf` thêm trường. `runs/engine.ts` gửi `policy` khi điều kiện sau đúng:

```ts
ctx.policy.hooks.length || ctx.policy.managedHooksOnly || ctx.policy.secretInjection !== "allow"
```

Worker cũ bỏ qua trường lạ. Worker mới hiểu thiếu trường là `allow`.

## `welcome.policy`

```ts
policy: z.object({ totpFallback: z.boolean(), secretInjection: secretInjection.optional() }).optional(),
```

- Hub: `terminal/record.ts` gửi `secretInjection: policy.secretInjection`.
- Worker ghi `secrets-policy.json` theo hub (data-model §5).

## `run_result.report.secretsInjected` (FR-043)

- Worker thêm `SecretsInjected int json:"secretsInjected,omitempty"` vào `runner.Result`. `report` là
  `z.record(z.string(), z.unknown())`, nên hub cũ nhận được.
- Hub mới:
  - đọc bằng `z.number().int().min(0).max(64).optional()`;
  - lưu trong `report` hiện có (không cột mới);
  - web run detail hiện "Dùng N bí mật tại máy" khi N > 0.
- Hub không bao giờ nhận tên hay mô tả bí mật (A1).

## Fixture

`packages/contracts/fixtures/worker-protocol.json` thêm:

- `welcome` có `policy: { totpFallback: true, secretInjection: "approve" }`;
- `job_offer` có `spec.policy.secretInjection: "deny"`;
- `run_result` có `report.secretsInjected: 2`.

Test Go `worker/internal/channel` đọc cùng fixture.

## Danh sách tên dành riêng (dùng chung Go ↔ TS)

`packages/contracts/fixtures/local-secrets.json`:

```json
{
  "reserved": { "exact": ["PATH", "HOME", "…"], "prefixes": ["HIVE_", "LD_", "…"] },
  "names": { "valid": ["STRIPE_TEST_KEY", "_X"], "invalid": ["1ABC", "a-b", "PATH", "HIVE_TOKEN", "…65 ký tự…"] }
}
```

- `packages/contracts/src/local-secrets.ts` xuất `RESERVED_SECRET_NAMES`, `isValidSecretName(name)`,
  `isReservedSecretName(name)`.
- Go `secretstore` có test đọc cùng fixture, như `secret-scan.json` với `checks.go`.
