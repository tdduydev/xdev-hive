# Brief repo xdev-hive (đọc trước khi mở file nào)

Bản tóm tắt để agent khỏi khảo sát cả repo. Nguồn: AGENTS.md, docs/architecture.md (đối chiếu code 12/10/2026), cấu trúc thư mục ngày 13/10/2026. Code mới hơn brief thì tin code.

## Mục đích
xDev Hive: nhiều đội trong tổ chức giao task cho coding agent CLI (Claude Code, Codex, Gemini, Antigravity) chạy trên máy dev hoặc container; dùng chung memory, tài liệu, skill; review rồi merge kết quả. Hub điều phối, worker Go chạy CLI trong git worktree tạm.

## Cấu trúc
| Thư mục | Nội dung |
|---|---|
| `apps/hub` | Hub TypeScript (Node chạy thẳng `.ts`, Hono + oRPC + Drizzle + pg-boss). Nghiệp vụ ở `src/modules/<tên>/`, mỗi module chỉ lộ `index.ts` |
| `apps/hub/db/migrations` | SQL migration đánh số `00NN_*.sql` (+ `meta/`) |
| `apps/web` | React (Vite, TanStack Query, Tailwind). Trang ở `src/pages/*.tsx`, `src/pages/knowledge/`, `src/pages/admin/`; e2e Playwright ở `apps/web/e2e` (fake-hub) |
| `apps/desktop` | Tauri, gói web + worker sidecar; từ điển vi/en |
| `packages/contracts` | Hợp đồng oRPC + zod (`src/<miền>.ts`), giao thức worker `src/worker-protocol.ts`, `openapi.json` sinh ra |
| `worker` | Go module riêng: `internal/runner` (chạy CLI, worktree, usage), `internal/channel` (WSS, gói, hàng chờ trên đĩa), `internal/accounts`, `internal/projects` |
| `docs` | `architecture.md`, `decisions.md` (không sửa), `adr/00NN-*.md`, `srs.md`, `design-system/` |
| `specs/0NN-*` | spec-kit: spec.md, plan.md, tasks.md của từng tính năng |

Module hub (bảng chính): `identity` (Better Auth), `tenancy` (orgs, teams, members, roles), `catalog` (projects + `settings` jsonb, saga tạo dự án, merge queue), `scm` (GitHub/GitLab, webhook), `tasks` (tasks, plans), `runs` (máy trạng thái run, lease, chính sách kết quả, review chéo, prompt; lõi ở `engine.ts` ~2.300 dòng — đọc theo đoạn), `fleet` (máy, WSS), `sandbox`, `knowledge` (memories, docs, skills, proposals, review workflow; tool MCP ở `mcp-tools.ts`), `leader` (chat), `mcp` (cổng MCP, registry tool theo loại run), `notify`, `cost`, `audit`, `governance` (Chính sách agent của tổ chức, jsonb), `system`, `platform` (db, `withTenant`, pg-boss, lỗi).

Luồng run: `queued → leased → preparing → running → verifying → succeeded|no_changes|needs_review|failed` (+ `lost`, `cancelling`, `planning/awaiting_plan`). Kind: `code`, `review`, `plan`, `leader`, `doccheck`, `docassist`. Hub gửi `job_offer{spec}` (spec do `buildSpec` trong engine.ts), worker gửi `run_event` (enum `runEventKind` — hub cũ đóng kết nối khi gặp loại lạ), `log_chunk`, `run_result{report}` (report tự do).

## Lệnh
- `pnpm install`; `pnpm check` = lint (biome) + typecheck + `pnpm deps` (ranh giới module) + test.
- `pnpm biome check --write .` trước khi commit.
- Hub: `pnpm --filter @xdev-hive/hub test` (vitest). Test DB `*.db.test.ts` cần Docker; Colima: `DOCKER_HOST=unix://$HOME/.colima/default/docker.sock TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock`, Docker Hub 429 thì `HIVE_TEST_POSTGRES_IMAGE=public.ecr.aws/docker/library/postgres:18-trixie`. Chạy một file: `pnpm --filter @xdev-hive/hub exec vitest run src/modules/<m>/<f>.db.test.ts`.
- Đổi bảng: sửa `src/modules/<m>/schema.ts` → `pnpm --filter @xdev-hive/hub db:generate` → commit SQL. Số migration lấy kế tiếp, kiểm lại lúc commit (nhiều nhánh song song).
- Đổi contracts: `pnpm openapi`, commit `packages/contracts/openapi.json`.
- Web: `pnpm --filter @xdev-hive/web test` (vitest), `test:e2e` (Playwright, fake hub).
- Worker: trong `worker/`: `gofmt -l .`, `go vet ./...`, `go test ./...`.

## Quy ước
- Module hub chỉ import module khác qua `index.ts`; vòng phụ thuộc thì đảo bằng `provide*` (xem `mcp/registry.ts`).
- Truy vấn dữ liệu tổ chức qua `withTenant()` (role `hive_app`). Bảng mới: `org_id`, bật + ép RLS (policy `orgScoped`), nếu không `rls.db.test.ts` hỏng.
- Hub import tương đối có đuôi `.ts`; web/desktop dùng alias `@/…` (không `../`).
- Comment giải thích vì sao. Chữ giao diện và lỗi tiếng Việt; commit message tiếng Anh `feat(scope): …`.
- Không commit secret. Không sửa AGENTS.md, CLAUDE.md, docs/decisions.md.
- Thêm trường vào gói worker/spec theo cách tương thích ngược: worker cũ bỏ qua trường lạ của spec (catchall); hub kiểm `runEventKind` chặt.

## Bẫy hay gặp
- `ALTER TYPE ... ADD VALUE` không dùng được giá trị mới trong cùng migration (55P04); `migrations-upgrade.db.test.ts` bắt lỗi này.
- `engine.ts`, `knowledge/reviews.ts`, `knowledge/editor.ts` rất dài: dùng `rg -n` tìm hàm rồi Read theo offset.
- Kind run mới phải thêm ở: enum `runKind` (runs/schema.ts + migration), `PROMPT_KINDS`/`SUBMIT_KINDS`/`CAPABILITY_KINDS` (engine.ts), `readOnlyKind` + `Capabilities` + nhánh worktree detach (worker runner.go), registry tool MCP theo `runKinds`.
- Tool MCP cho run: chỉ tool trong `RUN_TOOLS` (mcp/registry.ts) hoặc tool khai `runKinds` mới hiện cho run.
- Policy tổ chức là jsonb parse bằng zod; trường mới phải có `.default()` để dòng cũ vẫn parse.
- Test DB chạy chậm (testcontainers); chạy đúng file liên quan, không chạy cả bộ khi chưa cần.
