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
| `authentication.registerAuthenticationProvider`, `comments.createCommentController`, `window.registerTerminalProfileProvider`, `window.registerWebviewViewProvider`, `languages.registerCodeLensProvider`, `window.registerUriHandler`, `env.asExternalUri`, `env.isTelemetryEnabled`, `env.remoteName`, `ExtensionKind` | có ở 1.140.0; có từ lâu trước 1.90 **[Chưa kiểm từng bản]**. Chạy thật: đủ ở 1.101.0 và 1.142.0 (mục 6, S1) | grep `index.d.ts` 1.140.0 |

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
| Cursor, Windsurf, VSCodium cài extension từ Open VSX, không từ VS Code Marketplace | Điều khoản Marketplace chỉ cho sản phẩm Microsoft dùng. **Đã kiểm 2026-10-15 (S13)**: Cursor 3.24.18 và Windsurf 3.10.67 không gọi thẳng `open-vsx.org`; mỗi bản có chợ riêng (`marketplace.cursorapi.com`, `marketplace.windsurf.com`) phản chiếu Open VSX. Extension chỉ có trên Open VSX vẫn tìm được ở cả hai chợ | **[Đã kiểm, S13]** (VSCodium: chưa kiểm) |
| Cursor/Windsurf không có khung Chat của VS Code: `chat.createChatParticipant` có thể có nhưng không hiện ở đâu; `lm.selectChatModels` có thể trả mảng rỗng | `createChatParticipant` là hàm và tạo được participant trên cả Cursor lẫn Windsurf. `selectChatModels()` trả mảng rỗng trên cả hai (và cả trên VS Code không có Copilot). Có hiện ở khung chat hay không: **chưa rõ** (S2, S3) | **[Đã kiểm một phần, S2, S3]** |
| Cursor có API riêng để extension đăng ký MCP server (`vscode.cursor.mcp.registerServer`) | **Có** ở Cursor 3.24.18, gọi được từ VSIX cài thường (S5) | **[Đã kiểm, S5]** |
| Cursor đọc MCP từ `~/.cursor/mcp.json` và `.cursor/mcp.json`; Windsurf từ `~/.codeium/windsurf/mcp_config.json` | Đọc mã hai bản ngày 2026-10-15: đúng cả hai đường dẫn (S6). Windsurf nay hiện tên **Devin** | **[Đã kiểm bằng đọc mã, S6, S7]** |
| `env.uriScheme` trả `vscode`, `vscode-insiders`, `cursor`, `windsurf`… nên URI callback đăng nhập khác nhau theo editor | API `env.uriScheme`. Đã chạy: `vscode`, `cursor`, **`devin`** (không phải `windsurf`) (S7) | **[Đã kiểm, S7]**; `vscode-insiders` vẫn [Suy luận] |

Hệ quả cho thiết kế: **mọi tính năng phải dò khả năng lúc chạy** (feature detection), không dò theo tên editor:
- có `vscode.chat?.createChatParticipant` **và** khung chat hiện được → dùng `@hive`;
- không có → dùng webview chat của chính extension (gọi hub, không cần LM của editor);
- có `vscode.lm.registerMcpServerDefinitionProvider` → đăng ký bằng API; không có → ghi file cấu hình MCP của editor sau
  khi người dùng đồng ý.

Task T002 (spike) đã kiểm lại các dòng trên Cursor và Windsurf bản mới nhất: xem mục 6.

## 3. Đóng gói và phát hành

| Điều | Hiện biết | Nhãn |
|---|---|---|
| `@vscode/vsce` bản mới nhất 4.0.0; `ovsx` 1.2.0 | `npm view` ngày 2026-10-15 | kiểm |
| `vsce package --target <nền tảng>` tạo VSIX theo nền tảng (darwin-arm64, linux-x64, win32-x64…) | Tài liệu vsce. Đã chạy vsce 4.0.0: `--target` ra đúng `TargetPlatform` (S15) | **[Đã kiểm, S15]** |
| VS Code Marketplace ký mọi extension khi đăng và VS Code kiểm chữ ký khi cài | Tài liệu Marketplace. VSIX không ký cài được bằng lệnh `installExtension` (S12, S14); Marketplace ký khi đăng: chưa kiểm vì không đăng thử | **[Chưa rõ, S14]** |
| Open VSX có ký extension | API Open VSX trả `files.signature` (`.sigzip`) cho extension mẫu (S14) | **[Đã kiểm, S14]** |
| VS Code tự cập nhật extension cài từ Marketplace; VSIX cài tay không tự cập nhật | Hành vi VS Code. Đọc mã 1.141.0: `extensions.autoUpdate` mặc định `on` (S17). VSIX cài tay có tự cập nhật không: chưa kiểm | **[Đã kiểm một phần, S17]** |
| Remote (SSH/WSL/Dev Container): extension `extensionKind: ["workspace"]` chạy ở máy có mã nguồn; `SecretStorage` lưu ở phía máy giao diện | Tài liệu Remote Development. Không có SSH/WSL/Dev Container ở máy kiểm (S8) | **[Chưa rõ, S8]** |

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

## 6. Kết quả spike (T002, ngày 2026-10-15)

### 6.1 Cách kiểm

- Máy: macOS 27.0.1, arm64. Mọi lần chạy ở máy này; **không có** kết quả Windows, Linux, SSH, WSL, Dev Container.
- Editor đã chạy thật bằng `@vscode/test-electron` 3.1.0, nạp một extension thử ở `--extensionDevelopmentPath`:

| Editor | Bản | `vscode.version` | `env.appName` | `env.uriScheme` |
|---|---|---|---|---|
| VS Code | 1.101.0 (bản `engines` tối thiểu) | 1.101.0 | Visual Studio Code | `vscode` |
| VS Code | 1.142.0 (stable) | 1.142.0 | Visual Studio Code | `vscode` |
| Cursor | 3.24.18 (tải từ cursor.com ngày 2026-10-15) | 1.128.0 | Cursor | `cursor` |
| Windsurf, nay là **Devin** | 3.10.67 (tải từ API cập nhật của Windsurf ngày 2026-10-15) | 1.126.0 | Devin | `devin` |

- Extension thử, bộ chạy và gói VSIX thử nằm ở thư mục tạm ngoài repo, **không commit**. Webview thử gói bằng esbuild 0.28.2
  (ESM, tách chunk, `minify`) với đúng bản repo đang dùng: `shiki` 4.5.0, `mermaid` 12.0.0. Webview gửi kết quả và các
  sự kiện `securitypolicyviolation` về extension host bằng `postMessage`.
- Nhãn kết quả: **có**, **không**, **chưa rõ**. Mỗi dòng ghi rõ cách kiểm: *chạy* (chạy thật trong editor), *đọc mã*
  (đọc mã nguồn đã đóng gói của editor, không chạy), *API* (gọi dịch vụ công khai).

### 6.2 Bảng kết quả

| # | Điều cần kiểm | Kết quả | Editor, bản, cách kiểm |
|---|---|---|---|
| S1 | Bản engine của Cursor, Windsurf ≥ 1.101 | **có**. Cursor 1.128.0, Windsurf (Devin) 1.126.0. Hai bản đều có đủ `chat.createChatParticipant`, `lm.selectChatModels`, `lm.registerTool`, `lm.registerMcpServerDefinitionProvider`, `McpStdioServerDefinition`, `McpHttpServerDefinition`, `authentication.registerAuthenticationProvider`, `comments.createCommentController`, `window.registerUriHandler`, `window.registerTerminalProfileProvider`, `env.asExternalUri` (kiểu `function`). `engines.vscode ^1.101.0` cài được trên cả hai | Cursor 3.24.18, Devin 3.10.67, 2026-10-15, *chạy* |
| S2 | `createChatParticipant` có hiện không | **chưa rõ**. Hàm có và tạo được participant (không lỗi) ở cả 4 editor. Gửi `@spike hello` qua `workbench.action.chat.open` thì handler **không được gọi** ở Cursor, Devin, và cả VS Code 1.101.0 chưa đăng nhập Copilot, nên chưa chứng minh được khung chat nhận participant của extension ngoài. Số lệnh `workbench.action.chat.*`: VS Code 1.101.0 có 193, Devin 323, Cursor chỉ 2 (`open`, `testOpenWithPrompt`). **[Suy luận]** khung chat của VS Code ở Cursor đã bị thay bằng khung riêng. Hệ quả: `typeof createChatParticipant === "function"` luôn đúng, **không đủ** để quyết định bật `@hive` | 4 editor, 2026-10-15, *chạy* (số lệnh), *chạy* (handler) |
| S3 | `selectChatModels` trả gì | **mảng rỗng** (độ dài 0) ở cả 4. VS Code chưa đăng nhập Copilot nên rỗng là bình thường; với Copilot đã đăng nhập: chưa kiểm (không có tài khoản). Cursor, Devin: rỗng khi chưa có extension cung cấp model | 4 editor, 2026-10-15, *chạy* |
| S4 | `lm.registerMcpServerDefinitionProvider` | **có**, đăng ký và huỷ không lỗi ở cả 4 (cần khai `contributes.mcpServerDefinitionProviders`). Cursor, Devin có hiện server đó trong giao diện MCP của chính họ hay không: **chưa rõ** (không nhìn giao diện) | 4 editor, 2026-10-15, *chạy* |
| S5 | API MCP riêng của Cursor | **có**: `vscode.cursor.mcp.registerServer(config)` và `unregisterServer(name)`. Dạng `{ name, server: { url, headers? } }` hoặc `{ name, server: { command, args, env } }` (stdio cần đủ ba khoá, thiếu thì ném lỗi, theo mã `$registerMCPServer`). Gọi được cả từ extension phát triển lẫn **VSIX cài thường**. `vscode.cursor` là `undefined` ở VS Code và Devin. API này không có trong `vscode.d.ts` công khai nên có thể đổi không báo trước. Server hiện ở giao diện MCP của Cursor hay không: chưa rõ | Cursor 3.24.18, 2026-10-15, *chạy* + *đọc mã* |
| S6 | Đường dẫn cấu hình MCP | **có, đúng như plan**. Cursor: `~/.cursor/mcp.json` (người dùng; mã dùng `userHome({preferLocal:false})` nên ở Remote là thư mục nhà của máy remote) và `<dự án>/.cursor/mcp.json`. Windsurf/Devin: `~/.codeium/windsurf/mcp_config.json` (bản Insiders `windsurf-insiders`, Next `windsurf-next`, Airgap `windsurf-airgap`). Devin có thêm lệnh `devin.openDevinForTerminalMcpConfigFile`, đường dẫn file đó **chưa rõ** | Cursor 3.24.18, Devin 3.10.67, 2026-10-15, *đọc mã* |
| S7 | Tên và scheme của editor | `appName`: Visual Studio Code / Cursor / **Devin**. `uriScheme`: `vscode` / `cursor` / **`devin`**. Windsurf đã đổi tên thành Devin (`product.json`: `applicationName devin-desktop`, `dataFolderName .devin`) nhưng thư mục cấu hình vẫn `~/.codeium/windsurf` và bundle id vẫn `com.exafunction.windsurf`. Dò theo tên `windsurf` sẽ **trượt**; URI callback đăng nhập phải lấy từ `env.uriScheme` | 4 editor, 2026-10-15, *chạy* + *đọc mã* |
| S8 | `env.asExternalUri` với loopback trên SSH, WSL | **chưa rõ**. Máy kiểm không có SSH server, WSL hay Dev Container và không bật sshd. Ở máy cục bộ (`remoteName` là `null`) cả 4 editor trả nguyên `http://127.0.0.1:43211/callback`. Hub chuyển hướng về đúng cổng ở máy giao diện hay không, và `SecretStorage`, `extensionKind` ở Remote: chưa kiểm. Cần một máy có SSH hoặc WSL để kiểm sau (xem 6.4) | VS Code 1.101.0, 1.142.0, Cursor, Devin, 2026-10-15, *chạy* (chỉ cục bộ) |
| S9 | `shiki`, Mermaid dưới CSP FR-022 | **có, không cần nới CSP** với cách repo đang dùng. Dưới CSP đúng nguyên văn FR-022: `shiki` 4.5.0 với `createJavaScriptRegexEngine` (như `artifacts-ui`) tô được TypeScript; Mermaid 12.0.0 với `securityLevel: "strict"` vẽ được flowchart và sequence (nạp chunk bằng `import()` từ `cspSource`), báo lỗi cú pháp đúng, không có sự kiện `securitypolicyviolation` nào. `style-src 'unsafe-inline'` đủ cho thẻ `<style>` của Mermaid. Kết quả giống nhau ở cả 4 editor. `shiki` bản **Oniguruma WASM** (`shiki/engine/oniguruma`) **vỡ** dưới FR-022 (`WebAssembly.instantiate(): … 'unsafe-eval' is not an allowed source`); thêm `'wasm-unsafe-eval'` vào `script-src` thì chạy ở cả 4. Kết luận: giữ engine JS, không thêm `'wasm-unsafe-eval'`. Gói webview thử (Mermaid, `shiki` một ngôn ngữ) khoảng 6,2 MB trong 116 file, đa số là chunk nạp khi cần | VS Code 1.101.0, 1.142.0, Cursor, Devin, 2026-10-15, *chạy* |
| S9b | API trình duyệt trong webview (R7) | Dưới FR-022, ở cả 4: `sessionStorage`, `localStorage`, `URL.createObjectURL` + bấm `<a download>`, `navigator.clipboard.writeText` đều **không lỗi**; `isSecureContext` là `true`, origin `vscode-webview://…`; `fetch` tới hub bị chặn (đúng ý `connect-src 'none'`). FR-021 vẫn chuyển clipboard và tải file qua extension host như đã định (hành vi có thể khác ở bản web) | cùng trên, *chạy* |
| S10 | `iframe` http trong webview (mixed content) | **không tái hiện lỗi** ở bản desktop. Khi CSP cho phép (`frame-src http: https:`), `iframe` tới `http://127.0.0.1`, `http://localhost` và `http://<IP LAN>` (HTTP thường) đều tải được ở cả 4 editor. Dưới FR-022 (`frame-src 'none'`) `iframe` bị chặn bằng sự kiện `securitypolicyviolation` (đúng ý). Bản web (vscode.dev, Codespaces, `serve-web`) chạy https: **chưa rõ**. Quyết định "không nhúng `iframe` hub" giữ nguyên | cùng trên, *chạy* |
| S11 | `vscode.changes` có ở 1.101 không | **có**. Lệnh có trong `getCommands` và mở được trình xem nhiều file ("… (1 file)") ở VS Code 1.101.0, 1.142.0, Cursor 1.128.0, Devin 1.126.0; `vscode.diff` cũng chạy. Lưu ý Cursor: khi cửa sổ **không mở thư mục** cả hai lệnh ném `TypeError: Cannot read properties of undefined (reading 'activeEditor')`; mở thư mục thì chạy. Đường lui cho T018: bọc `try/catch`, lỗi thì mở từng file bằng `vscode.diff` | 4 editor, 2026-10-15, *chạy* |
| S12 | `workbench.extensions.installExtension` nhận URI file VSIX | **có**. `executeCommand("workbench.extensions.installExtension", Uri.file(<vsix>))` cài được VSIX **không ký** và extension xuất hiện trong `extensions.getExtension` ở VS Code 1.101.0, 1.142.0, Cursor, Devin. Cursor: extension cài kiểu này kích hoạt được và gọi được `vscode.cursor.mcp.registerServer`. Lưu ý: kế hoạch đăng công khai (Q1) nên extension không cần mã cài VSIX; dòng này chỉ để biết khả năng | 4 editor, 2026-10-15, *chạy* |
| S13 | Cursor, Windsurf cài từ đâu | Cursor: `marketplace.cursorapi.com` (đường `open-vsx-mirror`); Windsurf/Devin: `marketplace.windsurf.com` (đường `open-vsx.org`). Cả hai trả đúng bản mới nhất của extension chỉ có ở Open VSX (`muhammad-sammy.csharp` 2.160.9, trùng Open VSX ngày 2026-10-09). **Chưa kiểm**: độ trễ phản chiếu một extension mới đăng, và có cập nhật tự động không. VSCodium: chưa kiểm | API + *đọc mã* `product.json`, 2026-10-15 |
| S14 | Chữ ký | Open VSX: **có** (`files.signature`, tệp `.sigzip`) với extension mẫu `redhat.java`. VS Code Marketplace ký khi đăng: **chưa rõ** (không đăng thử). VSIX tự đóng, không ký, cài được qua S12 | API Open VSX, 2026-10-15 |
| S15 | `vsce` 4.0.0 | `package --target darwin-arm64 \| linux-x64 \| win32-x64 \| alpine-x64` đều ra VSIX có `TargetPlatform` đúng. Thiếu `repository`: **cảnh báo** "Use --allow-missing-repository to bypass", không dừng khi chạy không tương tác. **README có ảnh/liên kết tương đối mà không có `repository` thì vsce báo LỖI và thoát mã 1**, kể cả khi `git remote` là GitHub (vsce chỉ đọc `package.json`). Cách qua: dùng URL tuyệt đối trong README, hoặc `--no-rewrite-relative-links`, hoặc `--baseContentUrl`/`--baseImagesUrl`. Repo đang private nên ảnh README không thể trỏ vào repo. Thiếu `LICENSE` cũng cảnh báo. `activationEvents: ["*"]` cần `--allow-star-activation` theo `--help` (chưa chạy riêng) | vsce 4.0.0, 2026-10-15, *chạy* |
| S16 | macOS gỡ quarantine khi tải binary bằng Node | **không cần**. File ghi bằng `fetch` + `writeFileSync` của Node chỉ có thuộc tính `com.apple.provenance`, **không** có `com.apple.quarantine`; binary Go (chữ ký ad hoc của linker) sau `chmod 0755` chạy được. `Info.plist` của VS Code, Cursor, Devin không đặt `LSFileQuarantineEnabled`. Chạy từ Node ở terminal, chưa chạy từ extension host | macOS 27.0.1 arm64, Node 26.10.0, 2026-10-15, *chạy* + *đọc mã* |
| S17 | Tự cập nhật | VS Code 1.141.0: `extensions.autoUpdate` mặc định `on` (*đọc mã*). Open VSX → Cursor, Windsurf có tự cập nhật không, và VSIX cài tay có được chợ cập nhật không: **chưa rõ** | VS Code 1.141.0, 2026-10-15, *đọc mã* |
| S18 | Publisher `xdev` còn trống không (cho T036) | **VS Code Marketplace: ĐÃ CÓ NGƯỜI GIỮ**. `marketplace.visualstudio.com/publishers/xdev` trả 200; publisher `xdev` (đã xác minh) có extension `xdev.xdev`. **Open VSX: namespace `xdev` chưa có** (API trả 404). Tên `xdev-hive`, `xdevhive`, `xdev-ai`, `xdevdev` đều 404 ở cả hai nơi, nhưng 404 chưa chứng minh tên còn đăng ký được trên Azure DevOps. Cần chốt lại tên publisher (T036) trước khi T003 ghi `publisher` | API công khai, 2026-10-15 |

### 6.3 Hệ quả cho các task sau

- **T003**: `publisher` không thể là `xdev` trên Marketplace (S18); chờ chủ dự án chốt tên (T036). Manifest không dùng `activationEvents: ["*"]` (S15).
- **T011 (đăng nhập), T021 (MCP)**: nhận diện editor bằng `env.uriScheme` và khả năng chạy, không bằng chữ `windsurf` (S7). Cursor có API MCP riêng, ưu tiên thử `cursor.mcp.registerServer` rồi mới ghi `~/.cursor/mcp.json` (S5, S6). Ghi file cho Windsurf theo S6.
- **T019 (`@hive`), T020 (chat dự phòng)**: dò `typeof createChatParticipant` không đủ (S2); cần tín hiệu khác (ví dụ có extension Copilot Chat, hoặc `selectChatModels()` không rỗng, hoặc `uriScheme` thuộc nhóm fork) và luôn có webview chat dự phòng.
- **T018 (review)**: `vscode.changes` dùng được từ 1.101 (S11); bọc lỗi cửa sổ không có thư mục ở Cursor.
- **T029, T037 (phát hành, gói đăng)**: README không dùng ảnh hoặc liên kết tương đối (hoặc `--no-rewrite-relative-links`), thêm `--allow-missing-repository` khi repo còn private (S15).
- **Webview dùng chung (T013 và sau)**: giữ CSP FR-022, không thêm `'wasm-unsafe-eval'`, giữ engine JS của `shiki` (S9).
- **Cần sửa plan.md khi tới lượt** (T002 không được sửa plan.md): mục 1 dòng "[Chưa kiểm, T002 kiểm trên SSH và WSL]" vẫn còn mở (S8); mục 11 "Open VSX … Cursor, Windsurf" nên ghi rõ hai bản dùng chợ phản chiếu (S13).

### 6.4 Việc còn mở sau spike

- S8 (loopback qua SSH, WSL, Dev Container; `SecretStorage`, `extensionKind` ở Remote): cần máy có SSH hoặc WSL. Cách kiểm đề xuất: chạy lại cùng extension thử, gọi `env.asExternalUri` rồi mở hub thật hoặc một máy chủ giả trên `127.0.0.1` để xem VS Code có chuyển tiếp cổng không.
- S2, S4, S5: xem bằng mắt giao diện Cursor và Windsurf (participant có hiện, server MCP đăng ký bằng API có hiện).
- S10 bản web, S13 độ trễ phản chiếu Open VSX, S14 chữ ký Marketplace, S17: chỉ kiểm được khi có bản đăng thật.
- Các dòng **[Chưa kiểm]** khác (khoá keyring Rust và Go đọc chéo, GitLab gửi webhook khi xoá note, vai trò tối thiểu GitLab, renderer Markdown của `code-review`) không nằm trong phạm vi kiểm bằng extension thử; để T004, T033, T034 và T014.
