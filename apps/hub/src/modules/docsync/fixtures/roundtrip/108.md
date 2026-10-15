# Feature Specification: Extension VS Code tích hợp sâu (mức 2)

**Feature Branch**: `017-vscode-extension`

**Created**: 2026-10-15

**Status**: Draft (chờ chủ dự án xác nhận các câu hỏi mở và giả định)

**Input**: Người dùng chốt ngày 2026-10-15: làm extension VS Code **mức 2** (tích hợp sâu). Phạm vi bắt buộc:
- chat participant `@hive` và Language Model API;
- tự đăng ký Hive MCP; Authentication Provider;
- Comments API và diff để review code;
- Tree/Webview View;
- terminal profile, CodeLens/Hover;
- sidecar `hive-worker` dùng chung với app desktop;
- dùng được phần tại máy khi chưa đăng nhập;
- phát hành lên Marketplace và Open VSX, chạy được với Remote;
- bảo mật.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md) · **Task**: [tasks.md](tasks.md)

## Câu hỏi mở cho chủ dự án

Mỗi câu có khuyến nghị. Spec và plan đang viết theo khuyến nghị, ghi **[Giả định]**. Mọi giả định **chờ chủ dự án xác
nhận**.

| # | Câu hỏi | Khuyến nghị (đang dùng) | Ảnh hưởng nếu chọn khác |
|---|---|---|---|
| Q1 | Kênh phát hành: Marketplace công khai và Open VSX, hay chỉ file VSIX nội bộ do hub phát? Repo đang private, hub chạy nội bộ. | **Cả hai.** Kênh nội bộ (hub phát VSIX, extension tự cập nhật) làm trước. Đăng Marketplace và Open VSX khi chủ dự án đồng ý công khai tên extension. | Chỉ nội bộ: bỏ T029 phần publish. Chỉ công khai: bỏ T027, T028. |
| Q2 | Publisher ID và tên hiển thị | `xdev` / "xDev Hive". ID extension `xdev.xdev-hive`. | Đổi tên sau khi đăng Marketplace thì người dùng phải cài lại. |
| Q3 | Binary `hive`, `hive-worker`: gói vào VSIX theo nền tảng, hay tải khi cần? | **Tải khi cần**, kiểm chữ ký như ADR 0011, đặt ở `~/.xdev-hive/bin/`, dùng chung với desktop. VSIX nhẹ, chỉ một gói cho mọi nền tảng. | Gói sẵn: VSIX khoảng 40–50 MB mỗi nền tảng **[Suy luận]**, phải build 6 bản, và có hai bản worker trên máy. |
| Q4 | Máy không có app desktop: extension có tự chạy worker không? | **Có, khi người dùng bật** `xdevHive.worker.autoStart` (mặc định tắt). Worker sống theo cửa sổ VS Code giữ khoá. Máy có desktop thì desktop giữ worker. | Không chạy: máy chỉ có VS Code không nhận run, chỉ dùng được chat, review, view. |
| Q5 | Bình luận theo dòng có đồng bộ sang PR trên GitHub/GitLab không? | **Không** trong spec này. Hub là nguồn. Spec 009 cũng không tính phê duyệt trên nhà cung cấp. | Có: thêm job đẩy và kéo comment qua module `scm`, xử lý xung đột. Ước thêm khoảng 5 ngày **[Suy luận]**. |
| Q6 | Remote SSH/WSL: máy remote là một máy Hive riêng (đăng ký riêng, worker riêng)? | **Có.** Worker chạy ở máy có mã nguồn. Extension gợi ý đăng ký máy remote. Dev Container và vscode.dev không chạy worker. | Không: phải chuyển tiếp lệnh từ máy remote về worker máy local. Phức tạp, không khuyến nghị. |
| Q7 | Chấp nhận VS Code tối thiểu **1.101** (6/2025)? Bản fork Cursor/Windsurf cũ hơn sẽ không cài được. | **Chấp nhận.** Đây là bản đầu có MCP provider chính thức (research.md mục 1). | Hạ xuống 1.90: phải bỏ MCP provider bằng API, chỉ ghi file cấu hình. |
| Q8 | Telemetry | **Không thu gì** ở bản đầu. Chỉ ghi log tại máy (đã che token). | Thu: cần chính sách dữ liệu, tôn trọng `env.isTelemetryEnabled`, mặc định tắt. |
| Q9 | Token do extension xin có cần nhãn riêng `xdev-hive-vscode` để thu hồi riêng không? | **Bản đầu dùng chung luồng `purpose=cli`**, không cần đổi hub. Nhãn riêng để sau (T030, P3). | Cần ngay: T030 thành P1, thêm migration ở `desktop_connect_codes`. |

## Rủi ro chính

| # | Rủi ro | Mức | Cách giảm |
|---|---|---|---|
| R1 | Cursor/Windsurf không có khung Chat của VS Code, hoặc `lm.selectChatModels` trả rỗng; API MCP riêng của Cursor chưa kiểm | Cao | Dò khả năng lúc chạy. Có webview chat gọi hub (FR-012). Có thể ghi file cấu hình MCP (FR-017). Spike T002 kiểm trước khi làm |
| R2 | Node không đọc được keychain hệ điều hành nếu không có module native. Desktop (Rust `keyring`) và CLI (Go `go-keyring`) dùng chung mục `dev.xdev.hive`/hub URL, nhưng chưa ai kiểm hai thư viện đọc được mục của nhau | Cao | Extension không đọc keychain trực tiếp. Extension gọi `hive auth token --json` (T004). Test chéo Rust↔Go trong T004. Không có `hive` thì dùng `SecretStorage` của VS Code |
| R3 | Token Hive lọt vào file cấu hình MCP dạng chữ thường (`~/.claude.json`, `~/.cursor/mcp.json`) | Cao | File cấu hình chỉ ghi lệnh `hive mcp` (stdio proxy, T005). Proxy tự lấy token từ keychain. VS Code nhận token qua `resolveMcpServerDefinition`, chỉ trong bộ nhớ |
| R4 | Hub chạy HTTP (`http://10.86.224.34:3000`). Webview của VS Code là ngữ cảnh an toàn, nên `iframe` tới hub HTTP có thể bị chặn vì mixed content **[Suy luận]** | Vừa | Không nhúng `iframe` hub. Artifact chạy trong webview riêng, có CSP của artifact (FR-024). Spike T002 kiểm |
| R5 | Comments API cần bình luận theo dòng, nhưng hub chưa có: `codeReviews` chỉ có phát hiện AI `{file, line}`, không có luồng bình luận của người | Vừa | Task hub T008 thêm bảng, API và RLS. Web và desktop hiện cùng luồng (T014) |
| R6 | Hai worker cùng chạy trên một máy (desktop và VS Code) | Vừa | Khoá `~/.xdev-hive/worker.lock`; tiến trình thứ hai thoát mã 4. Extension hỏi trạng thái qua socket trước khi chạy (FR-028) |
| R7 | Package React dùng chung (`sdlc-ui`, `artifacts-ui`) dùng `shiki`, Mermaid, `sessionStorage`, `URL.createObjectURL`. Có thể vỡ dưới CSP chặt của webview | Vừa | Spike T002. Cầu nối webview chuyển clipboard và tải file sang extension host (FR-021) |
| R8 | Kênh Open VSX: chưa kiểm cơ chế ký, rủi ro mạo danh tên | Thấp | Giữ namespace `xdev` trên Open VSX. Kênh nội bộ kiểm sha256 và chữ ký ECDSA (FR-034) |
| R9 | Số spec 017 trùng với nhánh khác mở sau ngày 2026-10-15 | Thấp | Đã kiểm `origin/*` và các worktree ngày 2026-10-15: chưa có `specs/017-*`. Kiểm lại trước khi merge |

## Clarifications

### Session 2026-10-15 (tự trả lời theo khuyến nghị, chờ chủ dự án xác nhận)

- Q: Editor nào được hỗ trợ? → A: **[Giả định]** Chỉ bản desktop: VS Code ≥ 1.101, VS Code Insiders, Cursor, Windsurf,
  VSCodium. Có hỗ trợ Remote SSH và WSL. Chưa hỗ trợ vscode.dev, github.dev, Codespaces (không có loopback, không chạy
  được worker).
- Q: Extension chạy ở phía nào khi dùng Remote? → A: **[Giả định]** `extensionKind: ["workspace"]`. Extension chạy ở
  máy có mã nguồn: cần git, file và worker ở đó. Webview vẫn hiện ở máy giao diện. `SecretStorage` lưu ở máy giao diện.
- Q: LM API dùng vào việc gì? → A: **[Giả định]** Chỉ dùng model của editor cho việc nhẹ tại máy, không thay agent của
  Hive:
  - soạn tiêu đề và mô tả task từ câu lệnh và đoạn code đang chọn;
  - tóm tắt diff;
  - review sơ bộ diff tại máy theo quy tắc review của dự án.

  Việc nặng (sửa code, review chính thức, trả lời của Leader) vẫn chạy trên hub và worker.
- Q: Không có LM thì sao? → A: **[Giả định]** `/giao` dùng nguyên văn câu lệnh. `/review` chuyển thành "nhờ hub chạy run
  review" (spec 009). Chat chuyển sang webview gọi Leader của hub.
- Q: Đăng nhập thế nào? → A: **[Giả định]** Authentication Provider id `xdev-hive`, dùng luồng PKCE S256 qua loopback như
  `hive login`:
  - mở `{hub}/desktop/connect?…&purpose=cli`, đổi mã tại `POST /api/v1/desktop/connect/exchange`;
  - trên Remote, cổng loopback được chuyển ra máy giao diện bằng `env.asExternalUri`;
  - token `hive_pat_…` 90 ngày, gắn một tổ chức;
  - lưu qua `hive auth store` (keychain, dùng chung desktop và CLI), không có `hive` thì lưu vào `SecretStorage`.
- Q: Tree và webview lấy dữ liệu thế nào khi hub không có luồng đẩy? → A: **[Giả định]** Hỏi lại định kỳ như web:
  - 60 giây với danh sách;
  - 30 giây với phiên review đang mở;
  - chỉ khi cửa sổ đang được dùng.

  Run đang chạy dùng SSE `GET /api/v1/runs/:id/stream` (đã nhận token cá nhân qua `withPersonalTokens`).
- Q: Chữ trên giao diện? → A: Tiếng Việt mặc định, có từ điển vi/en. Setting `xdevHive.language` = `vi` | `en` |
  `auto` (theo ngôn ngữ của VS Code), mặc định `vi`.

## Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **Extension** | Gói `apps/vscode`, ID đề xuất `xdev.xdev-hive`, chạy trong extension host (Node) của VS Code và bản fork |
| **Webview** | Trang React chạy trong khung cách ly của VS Code, chỉ nói chuyện với extension host qua `postMessage` |
| **Cầu nối** (bridge) | Lớp `postMessage` giữa webview và extension host. Mọi lời gọi hub đi qua đây; webview không có token |
| **Phần tại máy** | Tính năng không cần hub: trạng thái worker, tối ưu token, memory, context pack, terminal agent tại máy, CodeLens task từ `specs/*/tasks.md` |
| **Dự án của workspace** | Dự án hub gắn với thư mục đang mở, lấy từ `hive-worker projects --json` (ADR 0020) hoặc từ `X-Hive-Project` trong `.mcp.json` |

## User Scenarios & Testing

### User Story 1 - Đăng nhập một lần, dùng chung với desktop và CLI (Priority: P1)

Dev đã đăng nhập app desktop hoặc chạy `hive login`. Dev mở VS Code. Extension thấy token trong keychain và hiện "Đã
đăng nhập: <tên> · <tổ chức>" mà không hỏi gì. Máy chưa đăng nhập thì menu Accounts có "Đăng nhập xDev Hive". Lệnh này
mở trình duyệt, người dùng duyệt trên hub, rồi quay về VS Code.

**Why this priority**: mọi tính năng hub (US2–US7) cần token.

**Independent Test**: hub giả (fake hub) có route `desktop/connect`. Kiểm:
- luồng PKCE ra token;
- `hive auth store` được gọi;
- cửa sổ thứ hai nhận phiên qua `authentication.onDidChangeSessions`.

**Acceptance Scenarios**:

1. **Given** keychain có token hợp lệ cho hub URL trong `xdevHive.hubUrl` (hoặc `hive.json`, `worker.json`), **When**
   extension khởi động, **Then** `authentication.getSession("xdev-hive", [], { silent: true })` trả phiên, không mở
   trình duyệt.
2. **Given** chưa có token, **When** chọn "Đăng nhập xDev Hive", **Then** mở `{hub}/desktop/connect` có `challenge` S256
   và `state` ngẫu nhiên. Callback sai `state` thì từ chối, báo "Phiên đăng nhập không khớp, thử lại". Quá 5 phút thì huỷ.
3. **Given** Remote SSH, **When** đăng nhập, **Then** cổng loopback ở máy remote được chuyển ra bằng `env.asExternalUri`.
   Hub nhận đúng cổng phía máy giao diện, và đăng nhập xong mà người dùng không cần mở cổng tay.
4. **Given** hub trả 401 (token bị thu hồi hoặc hết hạn), **Then** phiên bị gỡ, view hiện "Phiên đăng nhập đã hết hạn" kèm
   nút "Đăng nhập lại", và không hỏi lại liên tục.
5. **When** đăng xuất trong VS Code, **Then** hỏi "Đăng xuất cả app desktop và hive CLI?". Chọn "Chỉ VS Code" thì chỉ xoá
   phiên trong `SecretStorage` và bộ nhớ, giữ keychain.

### User Story 2 - Thấy việc của tôi, chờ duyệt, lượt chạy ngay trong VS Code (Priority: P1)

Thanh hoạt động có biểu tượng xDev Hive, gồm các view:
- **Việc của tôi**;
- **Chờ duyệt**: review code, duyệt tài liệu, đề xuất của Leader, câu hỏi AI SDLC;
- **Lượt chạy**;
- **Hàng merge**;
- **AI SDLC**;
- **Artifact**.

Badge trên biểu tượng là số mục chờ tôi. Bấm một mục thì mở webview chi tiết, dùng lại package React.

**Why this priority**: là lý do chính để dev ở lại trong editor thay vì mở web.

**Independent Test**: fake hub trả dữ liệu mẫu. Kiểm cây có đúng nhóm và số. Kiểm webview nhận dữ liệu qua cầu nối, và
HTML webview không chứa chuỗi `hive_pat_`.

**Acceptance Scenarios**:

1. **Given** đã đăng nhập, **Then** "Việc của tôi" gọi `tasks.list({ mine: true })`, nhóm theo trạng thái. Mỗi mục có
   "Mở", "Chạy lại" (`runs.start`) và "Huỷ".
2. **Then** "Chờ duyệt" gộp:
   - `codeReviews.list({ scope: "mine" })`;
   - `reviews.list({ scope: "mine" })`;
   - `leader.approvals.list({ status: "pending" })`;
   - `sdlc.questions.list`.

   Badge = tổng `codeReviews.count().awaitingMe`, số đề xuất chờ và số câu hỏi.
3. **Given** run đang chạy, **When** mở, **Then** log hiện trực tiếp trong panel Output qua SSE. Mất mạng rồi nối lại thì
   không mất đoạn (`Last-Event-ID`).
4. **Then** "Hàng merge" hiện `projects.mergeQueue` của dự án của workspace. Có "Bỏ khỏi hàng" nếu đủ quyền.
5. **Then** "AI SDLC" mở `ItemDetail`/`Questions` của `@xdev-hive/sdlc-ui`. "Artifact" mở `ArtifactViewer` của
   `@xdev-hive/artifacts-ui` (artifact tương tác theo US8).
6. **Given** chưa đăng nhập, **Then** các view hub hiện "Kết nối xDev Hive để xem việc" và nút đăng nhập, không báo lỗi.
7. **Given** cửa sổ không được dùng (mất focus), **Then** ngừng hỏi lại định kỳ, và hỏi ngay khi focus lại.

### User Story 3 - Review code theo dòng, Duyệt/Trả lại trong editor (Priority: P1)

Reviewer mở một phiên review code từ "Chờ duyệt". VS Code mở danh sách file đổi, mỗi file là diff base ↔ head. Phát hiện
của AI hiện thành luồng bình luận (chỉ đọc) ở đúng dòng. Reviewer thêm bình luận theo dòng, trả lời, đánh dấu đã xử lý.
Cuối cùng reviewer bấm **Duyệt** hoặc **Trả lại** (bắt buộc ghi lý do). Mọi thứ đồng bộ với web và desktop.

**Why this priority**: review là điểm nghẽn của quy trình (spec 009). Đọc diff trong editor có điều hướng code, tốt hơn
đọc trên web.

**Independent Test**: fake hub có phiên review với 2 file, 3 phát hiện AI và 1 luồng bình luận. Kiểm:
- `CommentController` tạo đúng 4 luồng;
- thêm bình luận gọi `codeReviews.comments.add` với `path`, `line`, `side`, `headSha`;
- Duyệt gọi `codeReviews.decide` với `headSha` của phiên.

**Acceptance Scenarios**:

1. **Given** workspace là repo của dự án, **When** mở phiên review, **Then** extension chạy `git fetch` nhánh PR. Diff mở
   bằng nội dung `git show <sha>:<path>` qua scheme `hive-review:`, không checkout, không đổi working tree.
2. **Given** không có repo tại máy (hoặc fetch lỗi), **Then** mở webview `CodeReviewPane` của `@xdev-hive/code-review`
   với patch từ `codeReviews.files`. Bình luận và quyết định vẫn dùng được.
3. **When** thêm bình luận ở dòng 42 bên mới, **Then** hub lưu `{reviewId, path, line: 42, side: "new", headSha, body}`.
   Web thấy bình luận sau lần hỏi lại kế tiếp (≤ 60 giây), và ngược lại (≤ 30 giây khi phiên đang mở trong VS Code).
4. **Given** PR có commit mới sau khi bình luận, **Then** luồng cũ gắn nhãn "Đã cũ" (outdated) và vẫn đọc được. Bấm
   Duyệt khi `headSha` đã đổi thì hub từ chối, VS Code báo "PR đã có commit mới, tải lại trước khi duyệt".
5. **When** bấm **Trả lại**, **Then** hộp nhập bắt buộc lý do, rồi gọi `codeReviews.decide({ decision: "changes",
   note })`. Có thể kèm danh sách bình luận chưa xử lý vào lý do.
6. **Given** người dùng không có quyền quyết định ở checkpoint, **Then** nút Duyệt/Trả lại ẩn, chỉ còn bình luận.

### User Story 4 - `@hive` trong khung Chat: giao việc, hỏi Leader, review (Priority: P1)

Trong khung Chat của VS Code (Copilot Chat), dev gõ một trong các lệnh:
- `@hive /giao sửa lỗi phân trang ở #file:list.ts`;
- `@hive /hoi tuần này dự án còn gì chặn?`;
- `@hive /review`.

Lệnh `/trangthai` (việc và run của tôi) dùng được mọi lúc. Mỗi lệnh làm như sau:
- **`/giao`**: dùng model đang chọn để soạn task, có tiêu đề, mô tả, tiêu chí xong và file liên quan từ context pack. Hiện
  bản nháp kèm nút "Giao cho agent" và "Sửa". Chỉ tạo task khi người dùng bấm.
- **`/hoi`**: gửi câu hỏi vào cuộc trò chuyện Leader của dự án (`leader.threads.send`). Chat hiện tiến độ, rồi hiện câu
  trả lời. Đề xuất của Leader có nút Duyệt/Từ chối.
- **`/review`**: review sơ bộ diff chưa commit hoặc diff của nhánh so với nhánh đích, bằng model đang chọn và quy tắc
  review của dự án. Kết quả hiện trong chat, kèm nút "Gắn vào editor" (bình luận chỉ ở máy, không gửi hub) và "Nhờ hub
  review" (`runs.start` loại review, theo quyền).

**Why this priority**: đây là điểm khác biệt của mức 2 so với chỉ có view.

**Independent Test**: test extension host với `vscode.lm` giả (model trả chuỗi cố định) và fake hub. Kiểm:
- `/giao` không gọi `tasks.create` trước khi bấm nút;
- `/hoi` gọi `leader.threads.send` rồi hỏi lại tới khi có tin của Leader;
- `/review` gửi diff đã che bí mật (dùng `secret-scan` của contracts).

**Acceptance Scenarios**:

1. **Given** editor có khung Chat và `@hive` đã đăng ký, **When** gõ `@hive`, **Then** gợi ý lệnh `/giao`, `/hoi`,
   `/review`, `/trangthai`, mô tả tiếng Việt.
2. **Given** `request.model` không dùng được (hết lượt, bị từ chối), **Then** `/giao` dùng nguyên văn câu lệnh làm mô tả.
   `/review` đề nghị "Nhờ hub review". Chat ghi lý do.
3. **Given** prompt có `#file`, `#selection`, **Then** nội dung đó vào mô tả task dạng đường dẫn và khoảng dòng, kèm
   commit SHA hiện tại. Không chép cả file nếu file vượt 200 dòng.
4. **When** `/hoi`, **Then** dùng cuộc trò chuyện gần nhất của dự án, hoặc tạo mới "VS Code · <tên workspace>". Leader quá
   5 phút chưa trả lời thì hiện "Leader đang bận, xem sau trong view Chờ duyệt" kèm link.
5. Diff gửi cho model hoặc hub đã che bí mật. File khớp `.gitignore`, `.env*` và đường dẫn cấm của dự án bị bỏ.

### User Story 5 - Hive MCP tự có cho Copilot, Claude Code, Cursor (Priority: P1)

Sau khi đăng nhập, agent trong editor (Copilot agent mode) thấy tool của Hive (`memory_search`, `doc_get`,
`task_update`…) mà không phải sửa file cấu hình. Với Claude Code, Cursor, Windsurf, extension đề nghị thêm Hive MCP
vào cấu hình của từng công cụ. Cấu hình không chứa token.

**Why this priority**: MCP là đường chính để agent dùng memory và tài liệu của Hive (M4).

**Independent Test**:
- `provideMcpServerDefinitions` trả một server khi đã đăng nhập, không trả gì khi chưa.
- `resolveMcpServerDefinition` gắn `Authorization` mới nhất.
- Ghi `~/.claude.json` giả (`HOME` tạm) giữ nguyên khoá khác; gỡ thì trả về đúng từng byte.

**Acceptance Scenarios**:

1. **Given** VS Code ≥ 1.101 và đã đăng nhập, **Then** provider `xdev-hive.mcp` trả `McpHttpServerDefinition` tới
   `{hub}/mcp`. Khi VS Code khởi động server, `resolveMcpServerDefinition` thêm header `Authorization: Bearer <pat>` và
   `X-Hive-Project` của workspace. Đăng xuất hoặc đổi workspace thì phát `onDidChangeMcpServerDefinitions`.
2. **Given** máy có `claude`, **When** người dùng chọn "Thêm Hive MCP cho Claude Code", **Then** extension chạy
   `claude mcp add --scope user xdev-hive -- <đường dẫn hive> mcp`, hoặc ghi file nếu lệnh không có (ghi kiểu nguyên tử,
   có sao lưu). File chỉ chứa lệnh, không chứa token.
3. **Given** Cursor: nếu có API đăng ký MCP của Cursor (T002 kiểm) thì dùng API; không có thì đề nghị ghi
   `~/.cursor/mcp.json`. Windsurf ghi `~/.codeium/windsurf/mcp_config.json`. Cả hai cùng cách stdio `hive mcp`.
4. **Given** không có binary `hive`, **Then** chỉ còn provider HTTP trong VS Code. Mục cho công cụ khác hiện "Cần cài
   hive CLI" kèm nút cài (US7).
5. **When** "Gỡ Hive MCP", **Then** chỉ xoá mục `xdev-hive` mà extension đã thêm (theo manifest), giữ mọi thứ khác.

### User Story 6 - Phần tại máy dùng được khi chưa đăng nhập (Priority: P2)

Dev chưa có tài khoản Hive vẫn có view **Máy này**:
- trạng thái worker;
- tối ưu token theo gói (spec 015: `hive-worker optimize`);
- memory của dự án (`hive-worker memory`);
- context pack cho workspace;
- terminal agent tại máy;
- CodeLens task từ `specs/*/tasks.md`.

**Why this priority**: giống app desktop (ADR 0016). Thấy ích lợi trước khi đăng nhập.

**Independent Test**: không có hub. `HOME` giả, có `hive-worker` giả trả JSON mẫu. Kiểm view Máy này có đủ mục, và
không có request mạng nào (chặn `fetch` trong test).

**Acceptance Scenarios**:

1. **Given** chưa đăng nhập, **Then** không gọi mạng. View hub hiện lời mời đăng nhập; view Máy này đầy đủ.
2. **Then** "Tối ưu token" hiện bảng gói và trạng thái từ `hive-worker optimize status --json`. Có "Bật"/"Tắt" (gọi
   sidecar như desktop), hiện số trước/sau từ `optimize report`.
3. **Then** "Memory" liệt kê theo dự án của workspace, có cờ (trùng, cũ, link chết) và token ước tính từ
   `hive-worker memory scan --json`.
4. **When** "Dựng context pack", **Then** gọi `hive-worker context-pack --json --cwd <workspace> --query <câu>`
   (T007), mở kết quả ở tài liệu Markdown chỉ đọc, có nút "Chép".

### User Story 7 - Một worker cho cả desktop và VS Code (Priority: P2)

Máy có app desktop: extension dùng worker của desktop, không chạy worker thứ hai. Máy chỉ có VS Code: extension tải
`hive`, `hive-worker` (có kiểm chữ ký). Người dùng bật thì extension chạy worker trong lúc VS Code mở.

**Why this priority**: run do hub giao cần worker. Hai worker trên một máy gây tranh lease và trùng việc.

**Independent Test**: Go test cho op `worker.status` của socket (T006). Test TS: binary giả thoát mã 4 → trạng thái
"Worker đang chạy ở chỗ khác", không thử lại liên tục.

**Acceptance Scenarios**:

1. **Given** socket `hive.sock` (hoặc named pipe) trả `hello`, **Then** extension đọc trạng thái qua op `worker.status`
   và hiện ở thanh trạng thái: "Hive: trực tuyến · 2 run". Extension không chạy thêm worker.
2. **Given** không có worker và `xdevHive.worker.autoStart` bật, máy đã đăng ký, **Then** chạy
   `hive-worker run --status-json --stdin-control`. Khi tắt cửa sổ giữ worker: ghi `stop`, chờ, rồi kill.
3. **Given** hai cửa sổ VS Code, **Then** chỉ một cửa sổ giữ worker (khoá). Cửa sổ giữ worker đóng thì cửa sổ còn lại
   nhận giữ trong ≤ 30 giây.
4. **Given** máy không có binary, **When** người dùng bấm "Cài hive CLI và worker", **Then** tải bản phát hành theo nền
   tảng, kiểm `checksums.txt` có chữ ký ECDSA (khoá công khai gói trong extension) và sha256. Rồi đặt vào
   `~/.xdev-hive/bin/`. Kiểm lỗi thì xoá file tải, báo lỗi tiếng Việt.
5. **Given** worker do desktop chạy, **Then** extension không bao giờ gửi `stop` cho worker đó.

### User Story 8 - Artifact tương tác an toàn trong VS Code (Priority: P2)

Dev mở artifact HTML/React (do Leader hoặc agent tạo) từ view Artifact hoặc từ câu trả lời `/hoi`. Artifact chạy trong
panel riêng, không đọc được token, không gọi mạng, không gọi được lệnh của extension.

**Acceptance Scenarios**:

1. **Then** panel artifact là một webview riêng, nội dung do `artifacts.frameDocument` dựng. CSP của panel giống CSP
   khung cách ly của ADR 0023 (`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `frame-src 'none'`).
   Thư viện lấy từ bộ đệm `/_artifact/lib/` của extension (`asWebviewUri`).
2. Webview artifact có `enableCommandUris: false`, `enableForms: false`, và `localResourceRoots` chỉ là thư mục thư viện
   artifact. Extension host chỉ nhận thông điệp đúng lược đồ của `@xdev-hive/artifacts-runtime` (lỗi chạy, kích
   thước); thông điệp khác bị bỏ và ghi log.
3. Artifact Markdown, code, CSV, ảnh hiện trong webview chung bằng `ArtifactViewer`, không chạy script.
4. Đã mở một phiên bản thì xem lại được khi mất mạng (bộ đệm LRU 200 MiB như desktop, xoá khi đăng xuất).

### User Story 9 - Terminal "Hive Leader" và `hive attach` (Priority: P3)

Danh sách profile terminal có:
- **Hive Leader**: chạy `hive chat` trong thư mục workspace;
- **Hive: gắn vào phiên…**: chọn phiên đang chạy trên worker (`session.list`) rồi chạy `hive attach <id>`.

**Acceptance Scenarios**:

1. **Given** có `hive`, **Then** profile hiện trong menu "+" của terminal. Không có `hive` thì profile báo "Cần cài hive
   CLI".
2. **When** chọn phiên, **Then** terminal chạy `hive attach <id>` (chế độ điều khiển), hoặc `--view` nếu người dùng
   chọn "Chỉ xem".

### User Story 10 - CodeLens và Hover (Priority: P3)

- Trong `specs/*/tasks.md`, mỗi dòng task `- [ ] **T0NN …` có CodeLens: "Giao agent", hoặc "Đang chạy · run #…" nếu
  hub có task cùng mã spec và task.
- Ở file code, CodeLens trên hàm (lấy từ `DocumentSymbol`) có "Giao agent sửa" (mở `/giao` với vùng hàm). Lens này tắt
  được.
- Hover trên đường dẫn file có trong mục PHẠM VI của một task hiện "Thuộc T0NN (spec 0NN)".
- Hover trên `CLAUDE.md`, `AGENTS.md`, `MEMORY.md` hiện số token ước tính nạp mỗi phiên (theo `memstore`).

**Acceptance Scenarios**:

1. CodeLens không gọi hub khi chưa đăng nhập. Phần cần hub hiện "Đăng nhập để thấy trạng thái".
2. Mỗi tài liệu dựng CodeLens ≤ 50 ms với `tasks.md` 300 dòng.
3. Workspace chưa tin cậy (Restricted Mode) thì không có lens "Giao agent".

### Edge Cases

- Workspace nhiều thư mục (multi-root): mỗi thư mục gắn dự án riêng. View lọc theo thư mục đang chọn, có mục "Tất cả".
- Workspace không gắn dự án hub: view hub vẫn chạy theo người dùng. `/giao` hỏi chọn dự án.
- Đổi tổ chức: token gắn một tổ chức, nên đổi tổ chức là đăng nhập lại cho tổ chức khác.
- Hub URL đổi trong setting: gỡ phiên cũ, tìm token cho hub mới trong keychain.
- `hive` cũ hơn bản tối thiểu (không có `auth`, `mcp`): báo "Cập nhật hive CLI" và rơi về `SecretStorage` và HTTP MCP.
- Windows: socket là named pipe `\\.\pipe\xdev-hive-<SID>`. Đường dẫn dùng `path.join`. Lệnh con chạy kiểu exec, không qua
  shell.
- Restricted Mode: tắt terminal profile, chạy worker, ghi cấu hình MCP, lens "Giao agent". View hub chỉ đọc vẫn dùng.
- Mất mạng giữa chừng: view giữ dữ liệu cũ, ghi "Cập nhật lúc HH:mm", tự thử lại có backoff (tối đa 5 phút).

## Requirements

### Functional Requirements

**Nền và đăng nhập**

- **FR-001**: Extension nằm ở `apps/vscode`, build bằng esbuild:
  - extension host: CommonJS, Node;
  - webview: ESM, trình duyệt.

  `engines.vscode` = `^1.101.0`. Không dùng proposed API.
- **FR-002**: `extensionKind: ["workspace"]`. `capabilities.untrustedWorkspaces.supported = "limited"`, tắt những phần
  ghi ở Edge Cases.
- **FR-003**: Đăng ký Authentication Provider id `xdev-hive`, nhãn "xDev Hive", `supportsMultipleAccounts: false`.
  Luồng PKCE S256 loopback giống `worker/cmd/hive/login.go`, dùng `purpose=cli`. Trên Remote dùng `env.asExternalUri`
  cho cổng callback.
- **FR-004**: Lưu và đọc token theo thứ tự:
  1. `hive auth token|store|logout --json` (keychain dùng chung: service `dev.xdev.hive`, account là hub URL đã chuẩn
     hoá);
  2. `SecretStorage`.

  Token chỉ nằm trong bộ nhớ extension host. Token không vào webview, log, setting hay file cấu hình.
- **FR-005**: Hub URL lấy theo thứ tự: setting `xdevHive.hubUrl` → `hive.json` → `worker.json` (giống `hive login`).
- **FR-006**: Gọi hub bằng client oRPC dựng từ `@xdev-hive/contracts`: `RPCLink`, `fetch` có `Authorization: Bearer` và
  `x-hive-org` lấy từ token. 401 thì gỡ phiên (US1-4). Lỗi mạng và lỗi hub hiện tiếng Việt.
- **FR-007**: Log ghi vào Output "xDev Hive". Mọi chuỗi khớp `hive_pat_`, `hwm_`, `hwr_` và bộ lọc `secret-scan` bị che.

**Chat và LM**

- **FR-008**: Khai báo chat participant `xdev-hive.hive` (tên `hive`) trong `contributes.chatParticipants`, có lệnh
  `giao`, `hoi`, `review`, `trangthai`. Chỉ đăng ký khi có `vscode.chat?.createChatParticipant`.
- **FR-009**: Dùng `request.model` (model người dùng chọn). Không chọn model riêng, không gửi gì cho model khi người
  dùng chưa gõ lệnh.
- **FR-010**: Mọi hành động ghi (tạo task, chạy run, duyệt đề xuất) chỉ chạy khi người dùng bấm nút trong câu trả lời.
  Model không tự gọi được.
- **FR-011**: Nội dung gửi model và hub phải qua bước che bí mật, và bỏ file bị loại trừ (US4-5).
- **FR-012**: Editor không có khung Chat, hoặc `lm.selectChatModels()` rỗng: lệnh "xDev Hive: Mở chat" mở webview chat
  gọi `leader.threads.*`, `leader.approvals.*`. Webview này cũng có "Giao việc" (form tạo task).

**MCP**

- **FR-013**: Đăng ký `lm.registerMcpServerDefinitionProvider("xdev-hive.mcp")` và khai báo
  `contributes.mcpServerDefinitionProviders`.
- **FR-014**: Server HTTP: `{hub}/mcp`, header gắn trong `resolveMcpServerDefinition`. Có `hive` thì có thể đặt
  `xdevHive.mcp.transport = "stdio"` để dùng `hive mcp`.
- **FR-015**: Lệnh `hive mcp` (Go, T005) là proxy stdio ↔ streamable HTTP tới `{hub}/mcp`:
  - token lấy từ keychain hoặc `hive.json`;
  - `X-Hive-Project` lấy theo `--project` hoặc thư mục hiện tại;
  - không in token ra stderr;
  - token hết hạn thì trả lỗi MCP có lời nhắn "Chạy hive login".
- **FR-016**: Ghi cấu hình MCP cho công cụ khác chỉ khi người dùng đồng ý từng công cụ. Ghi nguyên tử, sao lưu, manifest
  `~/.xdev-hive/vscode/mcp-state.json` như FR-003 của spec 015. Gỡ chỉ xoá mục đã thêm.
- **FR-017**: Với Cursor/Windsurf, dò API đăng ký MCP của editor trước. Không có thì dùng FR-016.

**Review code**

- **FR-018**: Hub (module `codereview`) thêm bình luận theo dòng:
  - bảng `code_review_comments`: `org_id`, `review_id`, `thread_id`, `path`, `line`, `side` (`old` | `new`),
    `head_sha`, `body`, `author_id`, `created_at`, `edited_at`, `resolved_at`, `resolved_by`;
  - RLS bật và ép;
  - API `codeReviews.comments.list|add|reply|resolve|reopen`;
  - audit mọi thao tác ghi;
  - hộp thư báo cho người giao việc khi có luồng mới.
- **FR-019**: Web và desktop hiện và thêm được cùng bình luận trong `FileDiff` của `@xdev-hive/code-review` (props và
  callback mới), để đồng bộ hai chiều.
- **FR-020**: Extension dùng `comments.createCommentController("xdev-hive.review", "xDev Hive")`. Diff dựng bằng
  `TextDocumentContentProvider` scheme `hive-review:` (nội dung theo SHA từ git tại máy). Phát hiện AI là luồng chỉ đọc,
  nhãn "AI · <mức>". Duyệt/Trả lại gọi `codeReviews.decide` kèm `headSha`.

**View và webview**

- **FR-021**: Webview là một ứng dụng React dùng lại `@xdev-hive/ui`, `code-review`, `sdlc-ui`, `artifacts-ui`,
  `doc-editor`. Client oRPC trong webview dùng `fetch` giả: chuyển lời gọi qua `postMessage` sang extension host, giống
  `viaRust` của desktop. Extension host chỉ cho phép thủ tục trong danh sách cho phép. Clipboard và tải file cũng đi qua
  extension host.
- **FR-022**: CSP mọi webview (trừ artifact):
  - `default-src 'none'`;
  - `script-src 'nonce-<ngẫu nhiên>' ${cspSource}`;
  - `style-src ${cspSource} 'unsafe-inline'`;
  - `img-src ${cspSource} data: blob:`;
  - `font-src ${cspSource}`;
  - `connect-src 'none'`;
  - `frame-src 'none'`.

  T002 kiểm `shiki` và Mermaid dưới CSP này; cần nới thì ghi lý do vào plan.md.
- **FR-023**: Màu lấy từ biến `--vscode-*` ánh xạ sang token của design system (`--background`, `--primary`…), theo theme
  sáng/tối/tương phản cao của editor.
- **FR-024**: Artifact tương tác theo US8. Không dùng `iframe` tới hub.
- **FR-025**: View hub hỏi lại định kỳ (60 giây; 30 giây với review đang mở), chỉ khi cửa sổ có focus. Run đang xem dùng
  SSE.

**Terminal, CodeLens, tại máy**

- **FR-026**: `contributes.terminal.profiles` có `xdev-hive.leader` và `xdev-hive.attach`.
  `registerTerminalProfileProvider` trả `TerminalProfile` chạy binary `hive` đã tìm thấy.
- **FR-027**: CodeLens và Hover theo US10, bật/tắt bằng `xdevHive.codeLens.enabled`. Dựng từ file tại máy; dữ liệu hub chỉ
  bổ sung khi đã đăng nhập.
- **FR-028**: Worker dùng chung:
  - tìm binary theo thứ tự `xdevHive.binPath` → `~/.xdev-hive/bin/` → `PATH`;
  - hỏi trạng thái qua socket bằng op mới `worker.status` (T006);
  - chỉ chạy worker khi không có worker nào trả lời và `autoStart` bật;
  - mã thoát 4 là "đang chạy ở chỗ khác";
  - không bao giờ dừng worker không do mình chạy.
- **FR-029**: Desktop tạo thêm liên kết `~/.xdev-hive/bin/hive` cạnh `hive-worker` (T009), để extension và terminal
  tìm được.
- **FR-030**: Mọi tính năng ở US6 chạy không cần mạng và không cần đăng nhập.

**Phát hành và bảo mật**

- **FR-031**: CI `.github/workflows/vscode.yml`:
  - lint, typecheck, test đơn vị, test tích hợp `@vscode/test-electron` (Linux có xvfb);
  - `vsce package`;
  - khi có tag `vscode-v*`: `vsce publish` và `ovsx publish` nếu có secret, và đính VSIX vào GitHub Release.
- **FR-032**: Một VSIX chung cho mọi nền tảng (không có binary bên trong, theo Q3). `.vscodeignore` loại source map và
  test.
- **FR-033**: Kênh nội bộ: hub phát `GET /api/v1/vscode/updates/latest` → `{version, url, sha256, signature}`. Extension
  cài từ kênh này kiểm mỗi 24 giờ và hỏi trước khi cài. Cài từ Marketplace/Open VSX thì để editor tự cập nhật, tắt kiểm
  nội bộ.
- **FR-034**: Chữ ký kênh nội bộ: ECDSA, cùng khoá phát hành worker (ADR 0011). Khoá công khai gói trong extension.
- **FR-035**: Không có telemetry. Không gọi mạng ngoài hub đã cấu hình. Tải binary chỉ từ URL phát hành do hub trả hoặc
  GitHub Release của repo.
- **FR-036**: Quyền theo vai trò hub (`hive_whoami`): ẩn nút người dùng không có quyền. Hub vẫn kiểm lại mọi quyền.
- **FR-037**: Chữ giao diện tiếng Việt, có từ điển vi/en (mẫu `Dict` của desktop). `package.nls.json` (tiếng Việt) và
  `package.nls.en.json` cho chữ trong manifest **[Giả định: chưa kiểm VS Code có nạp `package.nls.en.json` khi gốc là
  tiếng Việt]**.

### Key Entities

- **Phiên Hive** (`AuthenticationSession`): `id`, `accessToken` (`hive_pat_…`), `account { id: userId, label: email }`,
  `scopes: []`. Tổ chức lấy từ token.
- **Bình luận review** (mới ở hub): như FR-018. Thuộc một phiên review và một luồng.
- **Manifest MCP tại máy**: theo công cụ (claude, cursor, windsurf): đường dẫn file, khoá đã thêm, bản sao lưu, thời điểm.
- **Trạng thái worker**: `state` (7 trạng thái DESK-03), `hubConnected`, `registered`, `machineId`, `version`, `runs`,
  `owner` (`desktop` | `vscode` | `cli`).

## Success Criteria

- **SC-001**: Máy đã đăng nhập desktop: mở VS Code thấy "Việc của tôi" có dữ liệu trong ≤ 5 giây, không có bước đăng nhập.
- **SC-002**: Một review code 10 file, 20 bình luận: mở diff file đầu tiên ≤ 3 giây sau khi bấm (repo đã có tại máy).
- **SC-003**: Bình luận thêm ở VS Code hiện trên web ≤ 60 giây. Bình luận thêm ở web hiện ở VS Code ≤ 30 giây khi phiên
  đang mở.
- **SC-004**: `grep -r "hive_pat_"` trên `~/.claude.json`, `~/.cursor/mcp.json`, file setting của VS Code và log Output
  sau một ngày dùng: 0 kết quả.
- **SC-005**: Khởi động extension (activate) ≤ 300 ms trên máy dev. View và webview chỉ nạp khi mở.
- **SC-006**: VSIX ≤ 8 MB **[Giả định, ước theo cỡ bundle React của desktop]**.
- **SC-007**: Một máy chỉ có một worker trong mọi tổ hợp: desktop + 2 cửa sổ VS Code, mở và tắt theo thứ tự bất kỳ.
  Kiểm bằng test tích hợp có binary giả.
- **SC-008**: Trên Cursor bản mới nhất: đăng nhập, view, review, webview chat và MCP (qua API hoặc file) đều chạy.
  `@hive` không có không làm lỗi activate.

## Ngoài phạm vi

- vscode.dev, github.dev, Codespaces; JetBrains.
- Đồng bộ bình luận sang PR GitHub/GitLab (Q5).
- Sửa tài liệu tri thức trong VS Code (doc-editor đầy đủ). Bản này chỉ mở duyệt tài liệu (`ReviewPane`) và mở web để sửa.
- Đăng ký nhà cung cấp model (`registerLanguageModelChatProvider`) để đưa model của Hive vào VS Code.
- Remote control bằng điện thoại (ADR 0019) trong VS Code.

## Assumptions

- `/mcp` của hub nhận `hive_pat_…` (đã kiểm: `apps/hub/src/modules/mcp/endpoint.ts`, desktop `hub.rs` `call_tool`).
- SSE `GET /api/v1/runs/:id/stream` nhận token cá nhân, vì `app.ts` truyền `auth` đã bọc `withPersonalTokens`. Đã đọc
  code, chưa có test riêng cho đường này. T010 thêm test.
- Rust `keyring` 4.2 và Go `zalando/go-keyring` đọc được mục của nhau trên macOS, Windows, Linux (Secret Service). **Chưa
  kiểm**; T004 kiểm. Không được thì `hive auth` là nguồn chung duy nhất, và desktop đổi sang gọi `hive auth` (thêm task).
- `artifacts.frameDocument` đã có trên hub cho desktop (`packages/contracts/src/artifacts.ts:570`). Extension dùng lại.
- DESKCLIENT và spec 015 đang sửa `apps/desktop`, `worker/internal/optimizer`. T006, T009, T014 chạy sau khi các nhánh đó merge.
