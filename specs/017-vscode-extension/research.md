# Research: extension VS Code tích hợp sâu (mức 2)

**Ngày**: 2026-10-15 · **Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Quy ước nhãn: điều kiểm trực tiếp (đọc file, chạy lệnh) ghi nguồn. Điều chưa kiểm được ghi **[Chưa kiểm]**; điều tự suy
ra ghi **[Suy luận]**.

## 1. API VS Code: phiên bản tối thiểu

Kiểm ngày 2026-10-15 bằng cách tải `@types/vscode` từ npm và tìm khai báo hàm (`npm pack @types/vscode@<bản>`, `grep`).
Bản mới nhất trên npm là **1.140.0** (sửa ngày 2026-10-01).

| API | Có từ `@types/vscode` | Cách kiểm |
|---|---|---|
| `chat.createChatParticipant`, `lm.selectChatModels` | **1.90.0** (1.89.0 chưa có) | grep `function createChatParticipant`, `function selectChatModels` |
| `lm.registerTool` (Language Model Tool) | **1.95.0** (1.94.0 chưa có) | grep `function registerTool<` |
| `lm.registerMcpServerDefinitionProvider`, `McpStdioServerDefinition`, `McpHttpServerDefinition` | **1.101.0** (1.100.0 chưa có) | grep `function registerMcpServerDefinitionProvider` |
| `lm.registerLanguageModelChatProvider` | **1.104.0** (1.103.0 chưa có) | grep, không dùng trong spec này |
| `ChatRequest.model` (model người dùng chọn trong khung chat) | có ở 1.140.0 | đọc `interface ChatRequest` |
| `authentication.registerAuthenticationProvider`, `comments.createCommentController`, `window.registerTerminalProfileProvider`, `window.registerWebviewViewProvider`, `languages.registerCodeLensProvider`, `window.registerUriHandler`, `env.asExternalUri`, `env.isTelemetryEnabled`, `env.remoteName`, `ExtensionKind` | có ở 1.140.0; có từ lâu trước 1.90 **[Chưa kiểm từng bản]** | grep `index.d.ts` 1.140.0 |

Chi tiết đọc từ `index.d.ts` 1.140.0:

- `McpHttpServerDefinition` có `uri` và `headers`. Header chỉ gửi tới đúng origin của `uri`, không gửi khi chuyển hướng
  sang origin khác (comment của API).
- `McpServerDefinitionProvider` có `provideMcpServerDefinitions`, `resolveMcpServerDefinition` (gọi ngay trước khi
  khởi động server, hợp để gắn token mới) và `onDidChangeMcpServerDefinitions`. Provider phải khai thêm trong
  `contributes.mcpServerDefinitionProviders` của `package.json`.
- `McpStdioServerDefinition` chạy tiến trình con của extension host, mặc định không qua shell; `env` ghi đè biến môi
  trường.
- `ChatResponseStream` có `markdown`, `anchor`, `button`, `filetree`, `progress`, `reference`, `push`.
- `ChatRequest` có `prompt`, `command`, `references`, `toolReferences`, `toolInvocationToken`, `model`.
- `AuthenticationProviderOptions.supportsMultipleAccounts`.
- `CommentController` có `commentingRangeProvider`, `reactionHandler`.

**Kết luận**: `engines.vscode` tối thiểu **`^1.101.0`** để có đủ chat participant, LM, LM tool và MCP provider bằng API
chính thức (không dùng proposed API). Dưới 1.101 extension không cài được. Cursor/Windsurf báo bản engine của bản fork;
nếu bản đó thấp hơn 1.101 thì extension không cài được trên editor đó (xem mục 2, rủi ro R1 trong spec).

## 2. Editor không phải VS Code (Cursor, Windsurf, VSCodium)

| Điều | Hiện biết | Nhãn |
|---|---|---|
| Cursor, Windsurf, VSCodium cài extension từ Open VSX, không từ VS Code Marketplace | Điều khoản Marketplace chỉ cho sản phẩm Microsoft dùng | [Chưa kiểm lại ngày 2026-10-15] |
| Cursor/Windsurf không có khung Chat của VS Code: `chat.createChatParticipant` có thể có nhưng không hiện ở đâu; `lm.selectChatModels` có thể trả mảng rỗng | Kinh nghiệm cộng đồng; API của bản fork không công bố đầy đủ | [Chưa kiểm] |
| Cursor có API riêng để extension đăng ký MCP server (`vscode.cursor.mcp.registerServer`) | Nhớ từ tài liệu Cursor 2025 | [Chưa kiểm] |
| Cursor đọc MCP từ `~/.cursor/mcp.json` và `.cursor/mcp.json`; Windsurf từ `~/.codeium/windsurf/mcp_config.json` | Tài liệu của hai editor | [Chưa kiểm lại] |
| `env.uriScheme` trả `vscode`, `vscode-insiders`, `cursor`, `windsurf`… nên URI callback đăng nhập khác nhau theo editor | API `env.uriScheme` | [Suy luận] về giá trị cụ thể |

Hệ quả cho thiết kế: **mọi tính năng phải dò khả năng lúc chạy** (feature detection), không dò theo tên editor:
- có `vscode.chat?.createChatParticipant` **và** khung chat hiện được → dùng `@hive`;
- không có → dùng webview chat của chính extension (gọi hub, không cần LM của editor);
- có `vscode.lm.registerMcpServerDefinitionProvider` → đăng ký bằng API; không có → ghi file cấu hình MCP của editor sau
  khi người dùng đồng ý.

Task T002 (spike) kiểm lại các dòng [Chưa kiểm] ở bảng trên trên Cursor và Windsurf bản mới nhất trước khi làm phần
fallback.

## 3. Đóng gói và phát hành

| Điều | Hiện biết | Nhãn |
|---|---|---|
| `@vscode/vsce` bản mới nhất 4.0.0; `ovsx` 1.2.0 | `npm view` ngày 2026-10-15 | kiểm |
| `vsce package --target <nền tảng>` tạo VSIX theo nền tảng (darwin-arm64, linux-x64, win32-x64…) | Tài liệu vsce | [Chưa kiểm lại với 4.0] |
| VS Code Marketplace ký mọi extension khi đăng và VS Code kiểm chữ ký khi cài | Tài liệu Marketplace | [Chưa kiểm lại] |
| Open VSX có ký extension | | [Chưa kiểm] |
| VS Code tự cập nhật extension cài từ Marketplace; VSIX cài tay không tự cập nhật | Hành vi VS Code | [Chưa kiểm lại] |
| Remote (SSH/WSL/Dev Container): extension `extensionKind: ["workspace"]` chạy ở máy có mã nguồn; `SecretStorage` lưu ở phía máy giao diện | Tài liệu Remote Development | [Chưa kiểm lại] |

## 4. Hiện trạng trong repo (đọc code ngày 2026-10-15)

### 4.1 Đăng nhập và token

| Điều | Nguồn |
|---|---|
| `hive login`: PKCE S256 qua loopback `127.0.0.1:0`. Mở `{hub}/desktop/connect?port&state&challenge&machine&purpose=cli`, đổi mã ở `POST /api/v1/desktop/connect/exchange` (không cần auth), kiểm bằng `GET /api/v1/me` | `worker/cmd/hive/login.go` |
| Hợp đồng: `purpose` = `desktop` \| `cli`; cổng 1024–65535; mã `hdc_…` sống 5 phút | `packages/contracts/src/desktop-connect.ts` |
| Hub chuyển hướng cứng về `http://127.0.0.1:${port}/callback` | `apps/hub/src/modules/fleet/desktop-connect.ts:89` |
| Bảng `desktop_connect_codes` có ràng buộc `purpose = 'cli' or (purpose = 'desktop' and team_id is not null)`. Thêm `purpose` mới cần migration | `apps/hub/src/modules/fleet/schema.ts:164-177` |
| Token cá nhân `hive_pat_<orgUUID>_<secret>`, 90 ngày, không có refresh. Phát bởi `issueDesktopToken`, clientId `xdev-hive-desktop` / `xdev-hive-cli`, lưu ở `hive.mcp_user_tokens` | `apps/hub/src/modules/mcp/admin-service.ts:145` |
| `withPersonalTokens` bọc auth cho `/rpc`, `/api` và SSE `GET /api/v1/runs/:id/stream` | `apps/hub/src/personal-token-auth.ts`, `apps/hub/src/app.ts:311` |
| Keychain: Rust `keyring` 4.2, service `dev.xdev.hive`, account = hub URL bỏ `/` cuối | `apps/desktop/src-tauri/src/account.rs:12,76` |
| Go `hive login` dùng `zalando/go-keyring` cùng mục, cố ý để desktop và CLI dùng chung | `worker/cmd/hive/login.go:28-33` |
| File dự phòng của CLI: `<UserConfigDir>/xdev-hive/hive.json` (0600, `{hubUrl, token}`). Hub URL của worker: `<UserConfigDir>/xdev-hive/worker.json` (`hubUrl`, `machineId`, `machineToken hwm_…`, `teamId`). Thứ tự của CLI: `HIVE_HUB_URL` → `hive.json` → `worker.json` | `worker/cmd/hive/` |
| Desktop gọi hub qua lệnh Tauri `hub_rpc`: chỉ cho đường dẫn `/rpc/…`, gắn `Authorization: Bearer` và `x-hive-org`; giao diện không thấy token | `apps/desktop/src-tauri/src/hub.rs:169-224` |
| Client oRPC của desktop: `RPCLink` url `http://hub.local/rpc`, `fetch` tự viết `viaRust` gọi `hub_rpc` | `apps/desktop/src/lib/hub-rpc.ts` |

Kết luận: extension đi lại đúng luồng `purpose=cli`, không cần đổi hub ở bản đầu. Node không đọc được keychain nếu không
có module native, nên dùng `hive auth` (Go) làm cầu nối (T004).

**[Chưa kiểm]**: Rust `keyring` và Go `go-keyring` đọc được mục của nhau trên cả ba hệ điều hành. Trên macOS cả hai dùng
generic password cùng service/account **[Suy luận]**; trên Linux, thuộc tính Secret Service có thể khác nhau.

### 4.2 MCP

| Điều | Nguồn |
|---|---|
| `app.all("/mcp")` streamable HTTP không trạng thái. Nhận PAT, run token hoặc OAuth JWS (Better Auth + CIMD) | `apps/hub/src/app.ts:395`, `apps/hub/src/modules/mcp/endpoint.ts` |
| Mẫu `.mcp.json` của repo dự án dùng `Authorization: Bearer ${HIVE_MCP_TOKEN}` và `X-Hive-Project` | `apps/hub/src/modules/governance/templates.ts:52-66` |
| Desktop gọi tool MCP: `POST {hub}/mcp` với cùng bearer | `apps/desktop/src-tauri/src/hub.rs` (`call_tool`) |
| Desktop chỉ đọc `~/.claude.json`, `.mcp.json`; không có chỗ nào ghi cấu hình Hive MCP cho Cursor | `apps/desktop/src-tauri/src/setup_extra.rs` |
| CLI `hive` chưa có lệnh `mcp` hay `auth`. Lệnh hiện có: `chat`, `run`, `ls`, `attach`, `kill`, `remote`, `login`, `logout` | `worker/cmd/hive/main.go` |

### 4.3 Worker, khoá, socket

| Điều | Nguồn |
|---|---|
| Desktop chạy `hive-worker run --status-json --stdin-control`, dừng bằng cách ghi `stop\n` vào stdin. Lệnh một lần: `hive-worker <lệnh> --json` (`config`, `register`, `accounts`, `optimize`, `memory`, `projects`, `gitgroups`) | `apps/desktop/src-tauri/src/worker.rs` |
| Khoá `~/.xdev-hive/worker.lock` (flock). Chỉ `run` và `host` lấy khoá; tiến trình thứ hai thoát mã 4 | `worker/internal/instancelock` |
| Socket `<UserConfigDir>/xdev-hive/run/hive.sock` (`HIVE_SOCKET`), Windows `\\.\pipe\xdev-hive-<SID>`, quyền 0600, kiểm UID bên kia. NDJSON, bắt tay `{"op":"hello","v":1,"client":"…"}`. Op: `session.create/list/attach/kill`, `watch`, `remote.*`. **Chưa có op trạng thái**, không có HTTP localhost | `worker/internal/localipc`, `worker/cmd/hive-worker/local.go` |
| `hive attach <id> [--view] [--escape KEY]` | `worker/cmd/hive/` |
| `hive-worker` chưa có lệnh context pack. Hàm `buildContextPack` ở `worker/internal/runner/contextpack.go:197`, bản tại máy ở `contextpack_local.go` | |
| `optimizer.Link(src)` tạo `~/.xdev-hive/bin/hive-worker`; chưa tạo `hive` | `worker/internal/optimizer/link.go:15`, test `link_test.go`, `cmd/hive-worker/optimize_test.go:438` |
| Tauri `externalBin`: `binaries/hive-worker`, `binaries/hive` | `apps/desktop/src-tauri/tauri.conf.json` |
| Desktop khi chưa đăng nhập: mục cần hub hiện màn "Kết nối Hive"; worker chỉ chạy khi máy đã đăng ký | `apps/desktop/src` |
| Route cập nhật desktop `/api/v1/desktop/updates/{os}/{arch}/{version}` (DESK-10) | `apps/hub/src/app.ts` |

### 4.4 Package React và hợp đồng

| Điều | Nguồn |
|---|---|
| Mọi package: peer `react ^19.3`, không router (nhận callback `link`), không CSS riêng. Host dựng Tailwind 4 với `@source` và biến theme | `apps/web/src/styles.css` |
| `@xdev-hive/code-review`: chỉ props và callback (`CodeReviewPane`, `FileDiff`, `DecisionForm`…). Dùng ở web `pages/knowledge/code-reviews-tab.tsx` và desktop `screens/reviews-screen.tsx` | `packages/code-review/src` |
| `@xdev-hive/sdlc-ui`: `SdlcEnv{api, lang, errorMessage, link, can}` | `packages/sdlc-ui` |
| `@xdev-hive/artifacts-ui`: `ArtifactsEnv{api, lang, theme, errorMessage, link, frameBase, offline, offlineCache?, canAskLeader, …}`. Dùng `sessionStorage`, clipboard, `iframe` tới hub | `packages/artifacts-ui` |
| `@xdev-hive/ui` dùng clipboard, tải file bằng `URL.createObjectURL`, nạp Mermaid kiểu lazy; có `shiki` | `packages/ui` |
| Khung artifact: `<iframe sandbox="allow-scripts">` tới `/_artifact/frame/{ticket}` trên host hub, CSP chặt. Desktop dùng `hive-artifact://` và thủ tục `artifacts.frameDocument` | `packages/contracts/src/artifacts.ts:564,567,570` |
| `codeReviews.{list(scope mine\|all), count{awaitingMe}, get, files, decide{id, headSha, decision, note}, override, enqueue, recheck, dryRun, …}`. **Không có bình luận theo dòng của người**, chỉ phát hiện AI `{file, line\|null, severity, message}` | `packages/contracts/src/code-reviews.ts` |
| `leader.threads.{create, list, get → {thread, messages}, send({id, content, cli?}) → {message, runId}}`, `leader.approvals.{list, approve, reject}` | `packages/contracts/src/leader.ts` |
| `tasks.{list({projectId?, status?, mine?}), get, create, update, cancel}`, `runs.{start, list, latest, get, steer, events, logs}`, `projects.{mergeQueue, enqueueMerge, removeMerge}` | `packages/contracts/src` |
| Không có thủ tục streaming; web hỏi lại định kỳ (review code 60 giây, hàng merge 10 giây) | `apps/web/src` |
| esbuild đã có trong repo (`packages/artifacts-runtime`, 0.28.2) | `packages/artifacts-runtime/package.json` |
| ADR mới nhất 0026, migration mới nhất `0072_third_wasp.sql`, SRS tới mục 3.21 (ART) | `docs/adr`, `apps/hub/db/migrations`, `docs/srs.md` |

### 4.5 Kết nối Git và SCM (cho Q5, đọc code ngày 2026-10-15)

| Điều | Nguồn |
|---|---|
| `GitProvider` có `checkAccess(owner)`, `commentOnIssue(ref, number, body, opts?)`, webhook. **Chưa có** API bình luận theo dòng trên PR, sửa, xoá, trả lời hay resolve luồng | `apps/hub/src/modules/scm/types.ts:139,151` |
| `WebhookEvent = "push" \| "pull_request" \| "issues" \| "issue_comment"`. GitLab bật `noteEvents` | `scm/types.ts:57`, `scm/gitlab.ts` |
| `GitProviderError` mã `rate_limited`, `retryAfterMs` lấy từ `Retry-After` hoặc lúc hạn mức đặt lại; `retryable` đúng với `rate_limited`, `unavailable` | `scm/errors.ts:8,17,33,61` |
| Kiểm chữ ký webhook ở `verify.ts`; test dùng `mock-http.ts`, `fixtures/`, `MemoryProvider` (`memory.ts`) | `apps/hub/src/modules/scm` |
| Code review nhận sự kiện scm qua `registerCodeReviewScm` | `apps/hub/src/modules/codereview/scm.ts:38` |
| Cờ tính năng dự án ở `projectSettings.features`, mặc định tắt | `packages/contracts/src/projects.ts:399,530` |

Hệ quả: đồng bộ hai chiều (US11) cần thêm thao tác provider (T033) và phần đồng bộ trong `codereview` (T034); không
phải viết lại client GitHub/GitLab.

## 5. Quyết định rút ra

| Quyết định | Lý do | Phương án bỏ |
|---|---|---|
| `engines.vscode ^1.101.0` | Bản đầu có MCP provider chính thức (mục 1) | 1.90: phải bỏ MCP bằng API |
| Đăng nhập bằng luồng `purpose=cli` có sẵn | Không đổi hub, không migration | `purpose=ide` mới: cần migration, để T030 |
| Keychain qua `hive auth` (Go) | Một nơi đọc/ghi, cùng thư viện với `hive login` | Module native `keytar`: đã ngừng phát triển **[Chưa kiểm lại]**, phải build theo nền tảng |
| MCP cho công cụ khác qua stdio `hive mcp` | Không ghi token vào file chữ thường | Ghi header Bearer vào file cấu hình: lộ token |
| Webview gọi hub qua cầu nối `postMessage` | Giống `viaRust` của desktop; webview không có token, `connect-src 'none'` | Webview gọi thẳng hub: lộ token, cần nới CSP |
| Artifact trong webview riêng, tài liệu từ `artifacts.frameDocument` | Không phụ thuộc HTTP/HTTPS của hub | `iframe` tới hub: có thể bị chặn mixed content **[Suy luận]** |
| Trạng thái worker qua op `worker.status` của socket | Socket đã có, đã kiểm UID | Đọc file pid hoặc thử lấy khoá: không biết ai giữ |
| Binary tải khi cần, kiểm chữ ký | VSIX nhỏ, dùng chung `~/.xdev-hive/bin` với desktop | Gói sẵn theo nền tảng (Q3) |
| Đăng Marketplace và Open VSX từ bản đầu (Q1, chủ dự án chốt 2026-10-15) | Cursor, Windsurf, VSCodium chỉ cài từ Open VSX (mục 2); editor tự cập nhật | Kênh VSIX nội bộ do hub phát (T027, T028 bỏ) |
| Bình luận review đồng bộ hai chiều với PR qua kết nối Git của dự án (Q5, chốt 2026-10-15) | Dùng lại `GitProvider`, webhook, lỗi hạn mức có sẵn (mục 4.5) | Chỉ lưu ở hub; đăng bằng OAuth riêng của từng người |
