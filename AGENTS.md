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
- Database dev: `docker compose -f deploy/dev/compose.yaml up -d`, chép `apps/hub/.env.example` thành `.env`, rồi `pnpm --filter @xdev-hive/hub db:setup`.
- Đổi bảng: sửa `src/modules/<tên>/schema.ts`, chạy `pnpm --filter @xdev-hive/hub db:generate`, commit cả file SQL trong `apps/hub/db/migrations`.
- Test có database (`*.db.test.ts`) cần Docker. Với Colima trên macOS, đặt trước khi chạy test:
  `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`.
  Bị Docker Hub giới hạn lượt tải (429) thì thêm `HIVE_TEST_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:18-trixie`.
- Worker: trong `worker/` chạy `gofmt -l .`, `go vet ./...`, `go test ./...`.
- Desktop: `pnpm --filter @xdev-hive/desktop app:dev` (cần Rust).

## Quy ước

- Module của hub chỉ import module khác qua `index.ts`. `pnpm deps` chặn import vượt ranh giới.
- Mọi truy vấn dữ liệu của tổ chức đi qua `withTenant()` bằng role `hive_app`. Bảng mới phải bật và ép RLS; test `rls.db.test.ts` sẽ hỏng nếu quên.
- Import file TypeScript ghi rõ đuôi `.ts`. Hub chạy trực tiếp bằng Node, không qua bước build.
- Comment giải thích vì sao, không giải thích cái gì.
- Chữ trên giao diện và thông báo lỗi viết tiếng Việt.
- Không commit secret, token, mật khẩu.
- Làm trên nhánh riêng, mở PR vào `main`. CI phải xanh mới merge.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
