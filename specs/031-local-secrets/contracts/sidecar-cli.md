# Contract: lệnh sidecar `hive-worker secrets` (desktop ↔ worker)

**Quy tắc chung của mọi lệnh**:

- Lệnh in **một** JSON ra stdout khi có `--json`.
- Lỗi in `{"error":{"code","message","names"?}}` và thoát với mã khác 0.
  - `message` viết tiếng Việt và không bao giờ chứa giá trị (FR-036).
  - `names` liệt kê tên bí mật liên quan, nếu có.
- **Giá trị chỉ đi qua stdin** (FR-009): một JSON `{"value":"…"}` rồi EOF. Không bao giờ qua tham số hay biến môi trường.
- Cách gọi giống `ssh_keys.rs`: Rust `spawn`, `child.write`, đóng stdin, đọc stdout.

Kiểu TS nằm ở `apps/desktop/src/lib/secrets.ts`. Có test khớp fixture Go `worker/internal/secretstore/testdata/cli/*.json`.

Gói Go: `worker/internal/secretstore` (logic) và `worker/cmd/hive-worker/secrets.go` (bảng lệnh).

## Lệnh quản lý (US1, US6, US8, US9)

| Lệnh | stdin | Ra |
|---|---|---|
| `secrets status --json` | | `StoreStatus` |
| `secrets list --json [--project <localId>]` | | `{ secrets: SecretItem[], reserved: ReservedNames }` |
| `secrets set --json --name <N> [--description-file <f>]` | `{"value"}` (bắt buộc khi tạo, tuỳ chọn khi sửa) | `SecretItem` |
| `secrets rename --json --name <N> --to <M>` | | `SecretItem` (chuyển mọi khối sang tên mới rồi xoá khối cũ) |
| `secrets describe --json --name <N> --description-file <f>` | | `SecretItem` hoặc lỗi `description_looks_secret` |
| `secrets assign --json --name <N> --project <localId>` | | `SecretItem` |
| `secrets unassign --json --name <N> --project <localId>` | | `SecretItem` |
| `secrets delete --json --name <N>` | | `{ deleted: N, inUse: boolean }` |
| `secrets reveal --json --name <N> [--copy]` | | `{ value: string }` (ghi dòng `reveal`) |
| `secrets log --json [--name <N>] [--project <localId>] [--limit 200]` | | `{ entries: GrantEntry[] }` |
| `secrets log clear --json` | | `{ cleared: number }` |
| `secrets purge --json [--project <localId> \| --all]` | | `{ removed: string[], left: string[] }` (FR-063, FR-064) |
| `secrets approvals --json` | | `{ pending: ApprovalRequest[] }` |
| `secrets approve --json --id <a_…> --allow\|--deny` | | `{ ok: true }` |

Ghi chú:

- Mô tả đi qua file tạm do Rust tạo và xoá, như 029. Mô tả không phải bí mật, nhưng có thể dài và có xuống dòng.
- `secrets reveal` là lệnh duy nhất in giá trị ra stdout. Rust đọc rồi `wipe` chuỗi sau khi trả cho UI hay clipboard.

## Lệnh chạy (US3)

```
hive-worker secrets exec --project <localId> --kind terminal [--cli claude|codex|gemini|shell] -- <argv…>
```

- Không có `--json`. Lệnh in thông báo tiếng Việt ra stderr của terminal.
- **Trình tự**:
  1. `Grant`.
  2. Nếu chính sách là `approve`, hỏi trong terminal `[c/K]`.
  3. Ghép env.
  4. Nếu `--cli claude`, thêm `--append-system-prompt <khối tên>` vào `argv` ([agent-context.md](agent-context.md)).
  5. Thay tiến trình: Unix dùng `syscall.Exec`. Windows chạy tiến trình con trên cùng console, chờ, rồi thoát bằng mã
     của tiến trình con.
- **Kho lỗi** (FR-060): in lý do và cách sửa ra stderr, chờ Enter để terminal không đóng ngay, rồi thoát mã 78. Không
  chạy `argv`.
- `--project` rỗng hoặc không có gán → chạy `argv` ngay, không ghi nhật ký.

## Kiểu dữ liệu

```ts
type StoreStatus = {
  available: boolean;            // false: Linux không có Secret Service, kho bị chặn (FR-062)
  locked: boolean | null;        // null: không biết được mà không bật hộp thoại
  backend: "wincred" | "keychain" | "secret-service" | "unknown";
  reason: string | null;         // tiếng Việt + cách sửa
};
type SecretItem = {
  name: string;
  description: string;
  createdAt: string;
  valueChangedAt: string;
  projects: { localId: string; name: string; folder: string }[];
  inUseBy: number;               // số phiên đang chạy dùng bí mật này (FR-016)
  missingInStore?: boolean;      // có trong danh mục mà kho thiếu mục (US9)
};
type ReservedNames = { exact: string[]; prefixes: string[] };
type GrantEntry = {
  id: string; at: string;
  kind: "run" | "terminal" | "reveal";
  sessionId: string; project: string; projectName: string;
  names: { name: string; deleted: boolean; leaked: boolean }[];
  policy: "allow" | "approve" | "deny";
  outcome: "granted" | "denied" | "declined" | "timeout" | "store_error";
  copy?: boolean;
};
type ApprovalRequest = {
  id: string; runId: string; project: string; projectName: string;
  names: string[]; expiresAt: string;
};
```

## Mã lỗi

| `code` | Khi nào | `message` mẫu |
|---|---|---|
| `invalid_name` | Sai FR-003 | "Tên biến chỉ gồm chữ in hoa, số và `_`, không bắt đầu bằng số, tối đa 64 ký tự." |
| `reserved_name` | FR-004 | "`PATH` là tên dành riêng, hãy đặt tên khác." |
| `duplicate_name` | Trùng tên | "Đã có bí mật tên `X`." |
| `invalid_value` | <8, >8 KiB, có NUL | "Giá trị phải dài từ 8 ký tự đến 8 KiB và không chứa ký tự NUL." |
| `too_many` | >64 bí mật gán cho dự án | "Dự án đã có 64 bí mật." |
| `description_looks_secret` | FR-021 | "Mô tả có chuỗi giống bí mật. Hãy bỏ chuỗi đó trước khi lưu." |
| `store_unavailable` | FR-062 | "Máy không có kho bí mật (Secret Service). Cài gnome-keyring hoặc KWallet rồi thử lại." |
| `store_locked` | FR-060 | "Kho bí mật đang khoá. Mở khoá máy rồi chạy lại." |
| `store_missing` | Thiếu mục | "Kho thiếu giá trị của: X, Y. Hãy đặt lại giá trị." (`names`) |
| `store_corrupt` | Khối hỏng | "Bí mật X bị hỏng trong kho, hãy đặt lại giá trị." |
| `env_too_large` | Windows >24 KiB | "Bí mật gán cho dự án quá lớn để đưa vào môi trường Windows: X, Y." |
| `not_found` | Tên hay `localId` không có | "Không tìm thấy bí mật `X`." |
