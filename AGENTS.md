# xdev-hive

Bản viết lại của xDev Hive. Đọc [docs/architecture.md](docs/architecture.md) và [docs/decisions.md](docs/decisions.md) trước khi sửa code.

## Cấu trúc

| Thư mục | Là gì |
|---|---|
| `apps/hub` | Hub TypeScript (Hono + oRPC). Nghiệp vụ nằm trong `src/modules/<tên>/` |
| `apps/web` | Web React (Vite, TanStack Query, Tailwind) |
| `apps/desktop` | App Tauri |
| `packages/contracts` | Hợp đồng API (oRPC + zod) và giao thức worker. Sinh `openapi.json` |
| `worker` | Worker Go, module riêng, không nằm trong pnpm workspace |

## Lệnh

- `pnpm install`, rồi `pnpm check` (lint, typecheck, ranh giới module, test) trước khi mở PR.
- `pnpm --filter @xdev-hive/hub dev` và `pnpm --filter @xdev-hive/web dev` để chạy tại máy.
- Đổi `packages/contracts` thì chạy `pnpm openapi` và commit `openapi.json`. CI kiểm hai bên khớp nhau.
- Worker: trong `worker/` chạy `gofmt -l .`, `go vet ./...`, `go test ./...`.
- Desktop: `pnpm --filter @xdev-hive/desktop app:dev` (cần Rust).

## Quy ước

- Module của hub chỉ import module khác qua `index.ts`. `pnpm deps` chặn import vượt ranh giới.
- Import file TypeScript ghi rõ đuôi `.ts`. Hub chạy trực tiếp bằng Node, không qua bước build.
- Comment giải thích vì sao, không giải thích cái gì.
- Chữ trên giao diện và thông báo lỗi viết tiếng Việt.
- Không commit secret, token, mật khẩu.
- Làm trên nhánh riêng, mở PR vào `main`. CI phải xanh mới merge.
