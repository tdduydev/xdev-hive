# Quyết định cho bản viết lại xDev Hive

Chốt qua hỏi đáp ngày 11/10/2026. Phân tích hệ cũ (repo [`tdduydev/xdev-hive-old`](https://github.com/tdduydev/xdev-hive-old)) nằm ở [history/phan-tich-2026-10](history/phan-tich-2026-10/README.md). Kiến trúc chi tiết: [architecture.md](architecture.md).

## Đã chốt

| Chủ đề | Quyết định |
|---|---|
| Quy mô | Nhiều đội, một hub chung |
| Cách làm | Viết lại toàn bộ trong repo mới **`tdduydev/xdev-hive`** (private). Repo cũ đổi tên thành `tdduydev/xdev-hive-old`, đã xoá CI/CD, giữ để tra cứu và chạy hub cũ tới khi chuyển xong |
| Nơi chạy agent | Cả hai: worker trên máy dev và container dùng một lần |
| Hạ tầng container | Docker trên vài server nội bộ |
| Tài khoản AI trong container | Tuỳ đội: API key của tổ chức hoặc gói đăng ký của từng người |
| Git | Cả GitHub và GitLab |
| CSDL | Postgres từ đầu |
| Đăng nhập | Cả ba: SSO OIDC, GitHub/GitLab OAuth, email + mật khẩu |
| Dữ liệu cũ | Chuyển memory, tài liệu, skill. Task và run để lại hub cũ, chỉ đọc |
| Desktop | App nhẹ bằng Tauri (gói worker + cửa sổ web) |
| Tổ chức, quyền | Tổ chức → Đội → Hệ thống → Dự án |
| Merge | Mỗi dự án tự cấu hình (cần người duyệt hoặc tự merge khi đạt điều kiện) |
| Chi phí AI | Chỉ theo dõi theo đội, dự án, người, CLI. Không tự chặn |
| Kênh vào/ra | Issue GitHub/GitLab để giao việc. Thông báo quản trị qua Telegram hoặc email, cấu hình theo nhóm quản trị |
| MVP | Tạo dự án trên web; bảng việc + giao cho agent; memory, tài liệu, skill qua MCP; review + merge queue; plan mode có duyệt; review chéo giữa agent; chat với leader agent; chặn mạng ra ngoài cho container. **Mọi tính năng bật/tắt và cấu hình được theo dự án** |

## Stack

**Chốt ngày 11/10: phương án lai. Hub và web viết bằng TypeScript, worker viết bằng Go.** Dùng bản mới nhất của mọi thư viện; bản đang RC chỉ dùng khi có đường lui.

- Hub giữ TypeScript vì MCP SDK, Yjs/Hocuspocus và Better Auth chín nhất ở đây, và web dùng chung kiểu dữ liệu với hub.
- Worker dùng Go vì nó chạy nền cả ngày trên máy người dùng và được gắn vào app Tauri. File chạy Go khoảng 15–25 MB, còn Bun khoảng 60–90 MB (ước tính).
- Hợp đồng giữa hub và worker: hub sinh OpenAPI từ oRPC, worker sinh client Go từ đó.
- Không dùng PostgREST làm API chính, vì nghiệp vụ chủ yếu là điều phối và gọi ra ngoài. Có thể thêm sau làm API chỉ đọc nhờ RLS.

Phiên bản kiểm ngày 11/10/2026 trên npm, proxy.golang.org, crates.io và trang release chính thức.

| Lớp | Chọn | Ghi chú |
|---|---|---|
| Runtime hub | Node 24.21 LTS, lên **Node 26** khi thành LTS (28/10/2026) | Node 24 vào giai đoạn maintenance từ 20/10 |
| Ngôn ngữ | TypeScript **7.0.2** (bản native) | TS 7.0 chưa có API lập trình; công cụ cần API thì chạy kèm `@typescript/typescript6` |
| HTTP | Hono **4.13.13** | Khoá 4.x; 5.0 mới RC1 (10/10) |
| API contract | oRPC **1.15.5** + `@orpc/openapi` | Khoá 1.x; 2.0 còn beta |
| Schema | zod **4.6.5** | |
| CSDL | PostgreSQL **18.6** + pgvector **0.8.7** | Chờ 19.1 rồi mới nâng |
| Truy vấn | Drizzle **0.45** + drizzle-kit 0.31, driver `pg` 8.23 | Drizzle 1.0 kẹt ở RC từ tháng 5; đường lui Kysely 0.29 |
| Hàng đợi | pg-boss **12.37.1** | |
| Đăng nhập | Better Auth **1.7.7** + `@better-auth/sso`, `oauth-provider`, `mcp`, `cimd` | MCP spec 2026-07-28 dùng CIMD thay DCR. Better Auth chỉ lo xác thực; tổ chức, đội, vai trò là bảng riêng của module `tenancy` (không dùng plugin organization) để giữ cấu trúc bốn tầng và RLS (chốt khi làm M1) |
| MCP | `@modelcontextprotocol/server` **2.3.1** (dòng v2) | Better Auth MCP bắt buộc v2 |
| Tài liệu cộng tác | Hocuspocus **4.7** + Yjs **13.6.33**, Tiptap **3.31** | Yjs 14 còn beta, Hocuspocus cần Yjs 13 |
| Git | `@octokit/app` 16.1, `@octokit/webhooks` 14.2, `@gitbeaker/rest` 43.8 | Gitbeaker chỉ phủ GitLab API 16.5; endpoint mới gọi REST tay |
| Realtime | SSE (Hono `streamSSE`) từ LISTEN/NOTIFY; `ws` 8.22 cho worker | |
| Log, đo đạc | pino 10.4; OpenTelemetry (sdk-node 0.223, ghim chính xác) | |
| Container | Docker Engine **29.9**, gVisor bản tuần mới nhất, `dockerode` 5.0 (hub) | |
| Web | React **19.3**, Vite **8.3** (Rolldown), TanStack Router 1.170 + Query 5.104, Tailwind **4.3**, shadcn CLI 4.21 + `@base-ui/react` 1.9, `@xyflow/react` 12.12, Mermaid **12.1**, vite-plugin-pwa **2.0** | |
| Worker | Go **1.27.2**; `coder/websocket` 1.8; `aymanbagabas/go-pty` 0.2 (ConPTY); `kardianos/service` 1.3; `creativeprojects/go-selfupdate` 1.6; `oapi-codegen/v2` 2.8; `moby/moby/client` 0.6; MCP `go-sdk` 1.8; gọi git CLI (không dùng go-git); `log/slog`; goreleaser 2.18 | Bỏ gorilla/websocket, creack/pty, minio/selfupdate, docker/docker vì ngừng phát triển hoặc thiếu ConPTY |
| Desktop | Tauri **2.12** + plugin shell 2.5 (sidecar), updater 2.13, notification 2.6 | Tauri 3 mới alpha |
| Công cụ | pnpm **12**, Turborepo 2.11, Biome 2.5 hoặc oxlint 1.87, Vitest **5**, Testcontainers 12, Playwright 1.64 | |

Rủi ro cần theo dõi: MCP spec 2026-07-28 vừa ra, Drizzle 1.0 còn RC, Better Auth có lịch sử CVE, PTY trên Windows, RLS hở nếu quên `SET LOCAL`.

## Đề xuất: điều kiện thành công của run cấu hình động

Thay vì một định nghĩa cố định, mỗi dự án khai báo **chính sách kết quả** gồm các bước kiểm tra. Có thể ghi đè theo loại task. Run kết thúc ở một trong bốn trạng thái:

- `succeeded`: mọi kiểm tra bắt buộc đạt.
- `no_changes`: agent chạy xong nhưng không có gì để nộp.
- `needs_review`: kiểm tra mềm không đạt. Người xem rồi quyết.
- `failed`: kiểm tra bắt buộc không đạt, hoặc agent lỗi hay hết giờ.

Các loại kiểm tra, chạy theo thứ tự rẻ trước:

| Loại | Kiểm gì |
|---|---|
| `changes` | Có commit mới, số file đổi trong giới hạn, không đụng đường dẫn cấm |
| `agentReport` | Agent đã gọi `task_update` qua MCP kèm tóm tắt và bằng chứng |
| `command` | Chạy lệnh trong worktree (test, lint, build), có timeout |
| `review` | Agent khác review, điểm trên ngưỡng (dùng lại review chéo) |
| `ci` | CI trên PR/MR xanh |

```yaml
# .hive/project.yaml trong repo, hoặc cấu hình dự án trên hub
outcome:
  default:            # task code
    - { check: changes, required: true, maxFiles: 80, deny: ["infra/prod/**"] }
    - { check: command, required: true, run: "npm test", timeout: 15m }
    - { check: review, required: false, by: claude, minScore: 7 }
  byType:
    research: [ { check: agentReport, required: true } ]
    docs:     [ { check: changes, required: true }, { check: agentReport, required: false } ]
```

Mặc định khi dự án chưa khai báo: task code dùng `changes` + `command` (nếu repo có lệnh test). Task khác dùng `agentReport`.

## Còn chờ

- Nội dung yêu cầu 2 và 3.
