# Feature Specification: Extension VS Code tích hợp sâu (mức 2)

**Feature Branch**: `017-vscode-extension`

**Created**: 2026-10-15

**Status**: Draft. Chủ dự án đã chốt Q1–Q9 ngày 2026-10-15. Q1 và Q5 đổi so với khuyến nghị.

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

Ngày 2026-10-15 chủ dự án chốt thêm:
- phát hành công khai ngay từ bản đầu (Q1);
- bình luận review đồng bộ hai chiều với PR GitHub/GitLab (Q5).

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md) · **Task**: [tasks.md](tasks.md)

## Câu hỏi đã chốt

Chủ dự án chốt ngày 2026-10-15. Q1 và Q5 khác khuyến nghị ban đầu. Các câu còn lại giữ khuyến nghị.

| # | Câu hỏi | Quyết định (đã chốt) | Hệ quả trong spec |
|---|---|---|---|
| Q1 | Kênh phát hành: Marketplace công khai và Open VSX, hay chỉ file VSIX nội bộ do hub phát? | **Công khai ngay.** Đăng VS Code Marketplace và Open VSX từ bản đầu, publisher `xdev`, ID `xdev.xdev-hive`. Không có giai đoạn "nội bộ trước", không có kênh VSIX do hub phát. | Bỏ T027, T028. Thêm T036 (tài khoản publisher, PAT trong secret CI) và T037 (README, CHANGELOG, icon, giấy phép, chính sách quyền riêng tư, thông báo cần hub). FR-033, FR-034 sửa; thêm FR-047…FR-052 |
| Q2 | Publisher ID và tên hiển thị | **Đã chốt:** `xdev` / "xDev Hive". ID extension `xdev.xdev-hive`. | Publisher `xdev` còn trống trên Marketplace và Open VSX hay không: **[Chưa kiểm]**, T036 kiểm trước khi làm việc khác |
| Q3 | Binary `hive`, `hive-worker`: gói vào VSIX theo nền tảng, hay tải khi cần? | **Đã chốt: tải khi cần**, kiểm chữ ký như ADR 0011, đặt ở `~/.xdev-hive/bin/`, dùng chung với desktop. Một VSIX cho mọi nền tảng. | Như bản trước |
| Q4 | Máy không có app desktop: extension có tự chạy worker không? | **Đã chốt: có, khi người dùng bật** `xdevHive.worker.autoStart` (mặc định tắt). Worker sống theo cửa sổ VS Code giữ khoá. Máy có desktop thì desktop giữ worker. | Như bản trước |
| Q5 | Bình luận theo dòng có đồng bộ sang PR trên GitHub/GitLab không? | **Có, đồng bộ hai chiều.** Dùng kết nối Git của dự án trên hub và provider sẵn có trong module `scm`. | Thêm US11, FR-038…FR-046, SC-009…SC-011. Thêm T033, T034, T035. T008 thêm sửa/xoá bình luận |
| Q6 | Remote SSH/WSL: máy remote là một máy Hive riêng (đăng ký riêng, worker riêng)? | **Đã chốt: có.** Worker chạy ở máy có mã nguồn. Extension gợi ý đăng ký máy remote. Dev Container và vscode.dev không chạy worker. | Như bản trước |
| Q7 | Chấp nhận VS Code tối thiểu **1.101** (6/2025)? | **Đã chốt: chấp nhận.** Bản fork Cursor/Windsurf cũ hơn không cài được. | Như bản trước |
| Q8 | Telemetry | **Đã chốt: không thu gì.** Chỉ ghi log tại máy (đã che token). Chính sách quyền riêng tư (FR-050) ghi rõ điều này. | Như bản trước |
| Q9 | Token do extension xin có cần nhãn riêng `xdev-hive-vscode` để thu hồi riêng không? | **Đã chốt: bản đầu dùng chung luồng `purpose=cli`.** Nhãn riêng để sau (T030, P3). | Như bản trước |

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
| R8 | Phát hành công khai (Q1): người khác giữ trước tên `xdev` trên Open VSX hoặc Marketplace và mạo danh; PAT đăng bài bị lộ thì kẻ xấu đẩy được bản độc hại tới mọi người dùng | Vừa | T036 giữ publisher và namespace ngay ở Đợt 0. PAT chỉ ở GitHub environment `vscode-publish` có người duyệt, hạn ngắn, chỉ quyền publish (FR-048) |
| R9 | Số spec 017 trùng với nhánh khác mở sau ngày 2026-10-15 | Thấp | Đã kiểm `origin/*` và các worktree ngày 2026-10-15: chưa có `specs/017-*`. Kiểm lại trước khi merge |
| R10 | Đồng bộ PR (Q5) lặp vòng: hub đẩy bình luận lên GitHub, webhook gửi về, hub tạo bản sao, rồi lại đẩy lên | Cao | Mỗi bình luận có bảng liên kết với id phía nhà cung cấp. Bình luận do hub đẩy có dấu ẩn `<!-- xdev-hive:c=<id> -->`, webhook về sớm hơn phản hồi API vẫn nhận ra. Bình luận đến từ nhà cung cấp không bao giờ được đẩy ngược lại (FR-041). SC-010 |
| R11 | GitHub chỉ nhận bình luận theo dòng nằm trong hunk của diff (lỗi 422). GitLab cần `diff_refs` đúng phiên bản MR | Vừa | Ngoài hunk hoặc không tìm được phiên bản diff thì đăng bình luận chung trên PR, ghi `path:line@sha` (FR-040). Test với fixture lỗi 422 |
| R12 | Hết hạn mức API của GitHub/GitLab khi review lớn hoặc nhiều dự án dùng chung một kết nối | Vừa | Job theo hàng đợi, giới hạn số lời gọi theo kết nối, theo `retryAfterMs` của `GitProviderError` (FR-044). Bình luận vẫn lưu ở hub, trạng thái "Chờ đồng bộ" |
| R13 | Người dùng tải bản Marketplace nhưng tổ chức không có hub | Vừa | Màn chào (walkthrough) và README ghi rõ phần nào cần hub. View hub hiện "Chưa cấu hình hub" kèm nút nhập URL, không báo lỗi. Phần tại máy vẫn chạy (FR-051) |

## Clarifications

### Session 2026-10-15 (chủ dự án chốt)

- Q: Kênh phát hành? → A: Công khai ngay trên VS Code Marketplace và Open VSX từ bản đầu, publisher `xdev`, ID
  `xdev.xdev-hive`. Không có kênh VSIX nội bộ do hub phát. Editor tự cập nhật extension.
- Q: Publisher và tên? → A: Đã chốt theo khuyến nghị: `xdev` / "xDev Hive".
- Q: Binary gói sẵn hay tải khi cần? → A: Đã chốt theo khuyến nghị: tải khi cần, kiểm chữ ký, một VSIX chung.
- Q: Máy không có desktop có tự chạy worker không? → A: Đã chốt theo khuyến nghị: có, khi bật
  `xdevHive.worker.autoStart` (mặc định tắt).
- Q: Bình luận review có đồng bộ sang PR GitHub/GitLab không? → A: Có, hai chiều. Dùng kết nối Git của dự án trên hub và
  provider của module `scm`. Gồm:
  - ánh xạ dòng và commit;
  - sửa, xoá, trả lời theo luồng, đánh dấu đã xử lý;
  - chống lặp vòng đồng bộ;
  - kiểm quyền ghi PR của kết nối;
  - giới hạn tốc độ gọi API;
  - test với GitHub/GitLab giả.
- Q: Remote SSH/WSL? → A: Đã chốt theo khuyến nghị: máy remote là máy Hive riêng.
- Q: VS Code tối thiểu? → A: Đã chốt theo khuyến nghị: 1.101.
- Q: Telemetry? → A: Đã chốt theo khuyến nghị: không thu.
- Q: Nhãn token riêng? → A: Đã chốt theo khuyến nghị: dùng `purpose=cli` ở bản đầu, nhãn riêng để sau (T030).

### Session 2026-10-15 (tự trả lời theo khuyến nghị, chủ dự án không có ý kiến khác)

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

### Chi tiết đồng bộ PR (tự trả lời sau khi chốt Q5, chờ chủ dự án xem)

- Q: Bình luận đẩy lên PR đứng tên ai? → A: **[Giả định]** Đứng tên tài khoản của kết nối Git (GitHub App hoặc token của
  kết nối), vì hub không giữ token GitHub/GitLab của từng người. Thân bình luận mở đầu bằng "**<tên người Hive>** (qua
  xDev Hive):". Đăng theo tên từng người cần OAuth từng người với nhà cung cấp, để sau.
- Q: Bình luận từ PR về hub đứng tên ai? → A: **[Giả định]** Login phía nhà cung cấp, nhãn "GitHub" hoặc "GitLab". Không
  tự ghép với người dùng Hive ở bản đầu.
- Q: Bật đồng bộ ở đâu? → A: **[Giả định]** Theo dự án: `features.prCommentSync`, mặc định bật khi dự án có kết nối
  GitHub/GitLab đủ quyền ghi PR. Dự án dùng provider `local` không đồng bộ.
- Q: Hai bên cùng sửa một bình luận? → A: **[Giả định]** Bản sửa sau cùng thắng, so theo thời điểm sửa phía nhà cung
  cấp. Xoá thắng sửa.
- Q: Đồng bộ phê duyệt (Approve/Request changes) của PR? → A: Không. Chỉ đồng bộ bình luận. Quyết định review vẫn ở hub
  như spec 009.

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
Cuối cùng reviewer bấm **Duyệt** hoặc **Trả lại** (bắt buộc ghi lý do). Mọi thứ đồng bộ với web và desktop, và với PR
trên GitHub/GitLab theo US11.

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
7. **When** tác giả sửa hoặc xoá bình luận của mình, **Then** hub gọi `codeReviews.comments.edit|delete`. Bình luận đã
   xoá hiện "Bình luận đã bị xoá" nếu luồng còn trả lời khác.

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

### User Story 11 - Bình luận review đồng bộ hai chiều với PR GitHub/GitLab (Priority: P2)

Reviewer bình luận theo dòng trong VS Code, web hoặc desktop. Bình luận hiện trên PR GitHub (hoặc merge request GitLab)
ở đúng file và dòng. Người khác trả lời ngay trên GitHub thì câu trả lời về đúng luồng trong Hive. Sửa, xoá, đánh dấu đã
xử lý ở bên nào cũng sang bên kia.

**Why this priority**: chủ dự án chốt Q5. Người ngoài Hive (đồng nghiệp chỉ dùng GitHub) vẫn tham gia review được.
US3 chạy được khi chưa có US11, nên US11 là P2.

**Independent Test**: GitHub và GitLab giả (`mock-http.ts` và `fixtures/` của module `scm`) cùng `MemoryProvider`. Kiểm:
- thêm bình luận ở hub gọi API tạo bình luận theo dòng với đúng `path`, `line`, `side`, `commit_id`;
- webhook bình luận mới tạo luồng ở hub; webhook giao lại 3 lần vẫn chỉ một bình luận;
- bình luận do hub đẩy, khi webhook về, không tạo bản sao và không đẩy lại;
- lỗi 429/403 hết hạn mức thì job chờ đúng `retryAfterMs`, không mất bình luận.

**Acceptance Scenarios**:

1. **Given** dự án có kết nối GitHub đủ quyền ghi PR và `features.prCommentSync` bật, **When** thêm bình luận ở dòng 42
   bên mới, **Then** trong ≤ 2 phút PR có bình luận theo dòng ở cùng file và dòng (GitHub `side: RIGHT`, GitLab
   `position.new_line`), đứng tên tài khoản kết nối, mở đầu "**<tên>** (qua xDev Hive):". Hub lưu id phía nhà cung cấp.
2. **Given** dòng không nằm trong diff (GitHub trả 422), **Then** hub đăng bình luận chung lên PR kèm
   `` `path:line` @ sha ngắn ``. Luồng trong Hive vẫn ở đúng dòng, ghi "Đồng bộ dạng bình luận chung".
3. **When** ai đó trả lời trên GitHub (hoặc GitLab), **Then** sau webhook câu trả lời hiện trong luồng ở Hive, tác giả là
   login nhà cung cấp kèm nhãn "GitHub" hoặc "GitLab". Hộp thư báo như bình luận Hive. Bình luận mới có vị trí trên PR
   tạo luồng mới ở Hive.
4. **When** sửa hoặc xoá ở một bên, **Then** bên kia đổi theo. Hai bên cùng sửa thì bản sửa sau cùng thắng. Xoá thắng sửa.
5. **When** đánh dấu đã xử lý (resolve) hoặc mở lại ở một bên, **Then** bên kia đổi theo (GitHub `resolveReviewThread`
   qua GraphQL, GitLab `resolved` của discussion).
6. **Given** kết nối thiếu quyền ghi PR, **Then** bình luận vẫn lưu ở hub với trạng thái "Không đồng bộ: kết nối thiếu
   quyền ghi PR". Trang cài đặt dự án hiện quyền còn thiếu. Không thử lại liên tục.
7. **Given** hết hạn mức API, **Then** bình luận ở trạng thái "Chờ đồng bộ" và tự đẩy lại khi hạn mức đặt lại.
8. **Given** webhook bị mất, **Then** job đối chiếu (reconcile) của phiên review đang mở kéo bình luận còn thiếu trong ≤ 10
   phút.

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
- Chưa cấu hình hub (người dùng tải từ Marketplace, tổ chức chưa có hub): view hub hiện "Chưa cấu hình hub xDev Hive"
  kèm nút "Nhập URL hub" và link hướng dẫn. Không gọi mạng, không báo lỗi. `@hive` trả lời bằng cùng lời nhắn.
- Đồng bộ PR:
  - PR có commit mới: bình luận cũ trên PR thành outdated phía nhà cung cấp. Hub giữ luồng, gắn "Đã cũ" như US3-4.
  - Phiên review sang vòng mới (`superseded`): bình luận mới từ PR gắn vào vòng đang mở của cùng PR.
  - PR đã đóng hoặc merge: vẫn đồng bộ bình luận, vì GitHub và GitLab vẫn cho bình luận.
  - Kết nối Git bị gỡ hoặc đổi: dừng đồng bộ, giữ id đã liên kết. Nối lại cùng repo thì đồng bộ tiếp.
  - Bình luận phía nhà cung cấp không có vị trí (bình luận chung trên PR): không đồng bộ về, trừ bình luận do hub đăng ở
    US11-2.

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
  - cột `deleted_at` (xoá mềm, giữ cấu trúc luồng), `origin` (`hive` | `github` | `gitlab`), `external_author` (login
    phía nhà cung cấp, rỗng khi `origin = hive`);
  - API `codeReviews.comments.list|add|reply|edit|delete|resolve|reopen`. Sửa và xoá chỉ cho tác giả;
  - audit mọi thao tác ghi;
  - hộp thư báo cho người giao việc khi có luồng mới.
- **FR-019**: Web và desktop hiện và thêm được cùng bình luận trong `FileDiff` của `@xdev-hive/code-review` (props và
  callback mới), để đồng bộ hai chiều. Bình luận có nhãn nguồn ("GitHub", "GitLab") và trạng thái đồng bộ (FR-045).
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
  - `vsce package`, rồi kiểm nội dung VSIX (FR-049);
  - khi có tag `vscode-v*`: `vsce publish` và `ovsx publish` từ bản đầu (Q1), và đính VSIX vào GitHub Release. Thiếu
    secret thì job phát hành **lỗi**, không bỏ qua im lặng.
- **FR-032**: Một VSIX chung cho mọi nền tảng (không có binary bên trong, theo Q3). `.vscodeignore` loại source map và
  test.
- **FR-033**: Không có kênh VSIX nội bộ (Q1). Extension không tự tải hay cài VSIX. Cập nhật do editor làm qua
  Marketplace hoặc Open VSX.
- **FR-034**: Binary `hive`, `hive-worker` tải về được kiểm chữ ký ECDSA (cùng khoá phát hành worker, ADR 0011) và
  sha256. Khoá công khai gói trong extension.
- **FR-035**: Không có telemetry. Không gọi mạng ngoài hub đã cấu hình. Tải binary chỉ từ URL phát hành do hub trả hoặc
  GitHub Release của repo.

**Đồng bộ bình luận với PR (Q5, US11)**

- **FR-038**: `GitProvider` của module `scm` thêm thao tác bình luận PR theo dòng, cho GitHub, GitLab và `MemoryProvider`:
  - liệt kê bình luận và luồng của PR (GitHub review comments và review threads; GitLab discussions của MR);
  - tạo bình luận theo dòng, trả lời trong luồng, sửa, xoá;
  - đánh dấu đã xử lý và mở lại luồng.

  Provider `local` báo "không hỗ trợ". Lỗi dùng `GitProviderError` có sẵn (`rate_limited`, `forbidden`…).
- **FR-039**: Webhook nhận thêm sự kiện bình luận PR:
  - GitHub `pull_request_review_comment` (tạo, sửa, xoá) và `pull_request_review_thread` (resolve, unresolve);
  - GitLab `note` có `position` trên merge request (đã đăng ký `noteEvents`).

  Webhook của kết nối sẵn có được cập nhật danh sách sự kiện bằng một job chạy một lần (`addWebhook` đã cập nhật webhook
  cùng URL).
- **FR-040**: Ánh xạ vị trí:
  - Hive `{path, line, side, headSha}` → GitHub `{path, line, side: LEFT|RIGHT, commit_id}`, GitLab
    `position {base_sha, start_sha, head_sha, old_path, new_path, old_line|new_line}`. `diff_refs` lấy từ phiên bản MR khớp
    `headSha`;
  - ngược lại khi nhận về. Bình luận outdated phía nhà cung cấp dùng `original_line`, `original_commit_id`;
  - dòng không đặt được (ngoài hunk, không có phiên bản diff) thì đăng bình luận chung lên PR, ghi `path:line@sha`, đánh
    dấu `mode = 'fallback'`.
- **FR-041**: Chống lặp vòng:
  - bảng `code_review_comment_links` ánh xạ bình luận Hive ↔ id phía nhà cung cấp (id bình luận, id luồng hoặc
    discussion), khoá duy nhất theo `(connection, provider_comment_id)`;
  - thân bình luận do hub đẩy có dấu ẩn `<!-- xdev-hive:c=<id> -->`. Webhook về trước khi API trả lời vẫn được nhận ra;
  - bình luận có `origin` khác `hive` không bao giờ được đẩy ra;
  - sự kiện nhận về chỉ ghi khi nội dung hoặc trạng thái khác bản đang có (so hash thân và `updated_at` phía nhà cung
    cấp). Webhook giao lại không đổi gì.
- **FR-042**: Xung đột: bản sửa có `updated_at` muộn nhất thắng. Xoá thắng sửa. Bình luận xoá trên PR thì Hive xoá mềm.
- **FR-043**: Quyền:
  - người dùng Hive bình luận được khi xem được review (như FR-018). Đẩy lên PR dùng quyền của kết nối Git, không dùng
    quyền của người đó;
  - kết nối phải có quyền ghi PR: GitHub App `pull_requests: write`, PAT cổ điển `repo` hoặc fine-grained "Pull requests:
    Read and write"; GitLab scope `api`, vai trò Reporter trở lên **[Chưa kiểm vai trò tối thiểu của GitLab]**;
  - `checkAccess` báo thiếu quyền ghi PR. Thiếu thì không đồng bộ, trang cài đặt dự án hiện lý do.
- **FR-044**: Giới hạn tốc độ:
  - đẩy và kéo chạy bằng job pg-boss, một queue `codereview.comment-sync`, gom theo PR;
  - mỗi kết nối tối đa 30 lời gọi ghi mỗi phút **[Giả định]** (GitHub giới hạn riêng việc tạo nội dung);
  - gặp `rate_limited` thì hoãn tới `retryAfterMs`. Lỗi khác thử lại có backoff tối đa 5 lần, rồi `failed` kèm lỗi tiếng Việt;
  - job đối chiếu mỗi 10 phút cho phiên review đang mở, bù webhook bị mất.
- **FR-045**: Mỗi bình luận có trạng thái đồng bộ: `pending` | `synced` | `fallback` | `failed` | `disabled`, kèm link
  tới bình luận trên PR. Web, desktop và VS Code hiện nhãn "Chờ đồng bộ", "Lỗi đồng bộ" và nút "Thử lại" cho tác giả.
- **FR-046**: Cài đặt dự án `features.prCommentSync` (mặc định bật khi kết nối đủ quyền). Đổi cài đặt ghi audit. Audit
  thêm `code_review.comment.sync_out|sync_in|sync_failed`.

**Phát hành công khai (Q1)**

- **FR-047**: Publisher `xdev` trên VS Code Marketplace và namespace `xdev` trên Open VSX, giữ trước khi làm phần khác
  (T036). ID extension `xdev.xdev-hive`, tên hiển thị "xDev Hive".
- **FR-048**: PAT đăng bài:
  - `VSCE_PAT` (Azure DevOps, chỉ scope Marketplace "Manage") và `OVSX_PAT`, chỉ nằm trong GitHub secret của environment
    `vscode-publish`;
  - environment có người duyệt bắt buộc và chỉ cho tag `vscode-v*`;
  - hạn PAT ≤ 90 ngày, có lịch xoay vòng trong `docs/releasing.md`;
  - không commit token, không in token ra log.
- **FR-049**: Gói đăng có:
  - `README.md` (giới thiệu, ảnh màn, bảng tính năng: cần hub / chạy tại máy, cách đăng nhập, quyền riêng tư);
  - `CHANGELOG.md`; icon PNG 128×128 (`media/icon.png`); `LICENSE`; `PRIVACY.md`;
  - trường manifest `publisher`, `license`, `homepage`, `bugs`, `categories`, `keywords`, `galleryBanner`.

  CI chạy `vsce ls` và chặn VSIX có source map, test, `.env*` hoặc chuỗi khớp `hive_pat_`.
- **FR-050**: `PRIVACY.md` (tiếng Việt, có bản tiếng Anh) ghi rõ:
  - không telemetry;
  - dữ liệu chỉ gửi tới hub do người dùng cấu hình;
  - nội dung gửi model ngôn ngữ của editor chỉ khi người dùng gõ lệnh `@hive`, đã che bí mật;
  - file cấu hình MCP extension ghi (chỉ có lệnh, không token) và cách gỡ;
  - token lưu ở keychain hoặc `SecretStorage`.
- **FR-051**: Extension chạy được khi chưa có hub (Edge Cases). Có `contributes.walkthroughs` "Bắt đầu với xDev Hive":
  nhập URL hub, đăng nhập, bật MCP, cài worker. Bảng trong README và walkthrough ghi tính năng nào cần hub.
- **FR-052**: Giấy phép: **[Giả định]** giấy phép riêng (proprietary), miễn phí khi dùng với hub xDev Hive, không mở mã
  nguồn extension. `package.json` ghi `"license": "SEE LICENSE IN LICENSE"`. Chủ dự án duyệt văn bản `LICENSE` ở T037.
- **FR-036**: Quyền theo vai trò hub (`hive_whoami`): ẩn nút người dùng không có quyền. Hub vẫn kiểm lại mọi quyền.
- **FR-037**: Chữ giao diện tiếng Việt, có từ điển vi/en (mẫu `Dict` của desktop). `package.nls.json` (tiếng Việt) và
  `package.nls.en.json` cho chữ trong manifest **[Giả định: chưa kiểm VS Code có nạp `package.nls.en.json` khi gốc là
  tiếng Việt]**.

### Key Entities

- **Phiên Hive** (`AuthenticationSession`): `id`, `accessToken` (`hive_pat_…`), `account { id: userId, label: email }`,
  `scopes: []`. Tổ chức lấy từ token.
- **Bình luận review** (mới ở hub): như FR-018. Thuộc một phiên review và một luồng.
- **Liên kết đồng bộ** (mới ở hub, `code_review_comment_links`): `org_id`, `comment_id`, `connection_id`, `provider`,
  `pr_number`, `provider_comment_id`, `provider_thread_id`, `provider_url`, `mode` (`inline` | `fallback`), `state`
  (FR-045), `body_hash`, `provider_updated_at`, `attempts`, `last_error`, `next_attempt_at`. RLS bật và ép.
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
- **SC-009**: Bình luận thêm ở Hive hiện trên PR GitHub/GitLab ≤ 2 phút khi chưa hết hạn mức API. Bình luận thêm trên PR
  hiện ở Hive ≤ 1 phút sau webhook, ≤ 10 phút khi webhook bị mất.
- **SC-010**: Test giao lại cùng webhook 100 lần và để webhook về trước phản hồi API: mỗi bình luận chỉ có một bản ở
  mỗi bên.
- **SC-011**: Bản đầu có trên VS Code Marketplace và Open VSX. Cài được bằng `code --install-extension xdev.xdev-hive`
  và từ Cursor. Trang Marketplace có README, icon, giấy phép, link chính sách quyền riêng tư.

## Ngoài phạm vi

- vscode.dev, github.dev, Codespaces; JetBrains.
- Kênh VSIX nội bộ do hub phát (Q1).
- Đồng bộ phê duyệt PR (Approve, Request changes) và bình luận chung không có vị trí trên PR.
- Đăng bình luận lên PR theo tên từng người dùng (cần OAuth từng người với GitHub/GitLab).
- Bitbucket và nhà cung cấp Git khác ngoài GitHub, GitLab.
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
- Module `scm` đã có: `GitProvider` cho GitHub (App hoặc token) và GitLab, `commentOnIssue` (bình luận chung trên PR),
  webhook `pull_request`, `push`, `issues`, `issue_comment` (GitLab `note`), lỗi `rate_limited` có `retryAfterMs` từ
  `Retry-After`/`x-ratelimit-reset`, và `mock-http.ts`, `fixtures/` cho test. **Chưa có** API bình luận theo dòng trên
  PR (đọc `apps/hub/src/modules/scm/types.ts`, `events.ts`, `errors.ts` ngày 2026-10-15).
- Module `codereview` đã đăng ký handler webhook qua `registerCodeReviewScm` (`codereview/scm.ts`) và chạy job bằng
  pg-boss (`jobs.ts`). Đồng bộ bình luận đi theo cùng mẫu.
