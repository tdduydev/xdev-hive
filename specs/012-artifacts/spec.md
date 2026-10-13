# Feature Specification: Artifacts — không gian làm việc ở khung bên cạnh chat

**Feature Branch**: `012-artifacts`

**Created**: 2026-10-14

**Status**: Draft (các mặc định trong [Clarifications](#clarifications) chờ product owner xác nhận)

**Input**: Yêu cầu của product owner (nguyên văn, 2026-10-14): "hệ thống này phải lưu trữ Claude Artifacts — dedicated,
interactive workspaces that open in a side panel next to your chat rather than staying buried inside the text stream".

**Requirements added**: ART-01 … ART-14, NFR-18, IF-08 trong [docs/srs.md](../../docs/srs.md#321-artifacts-art).
**Decision record**: [ADR 0023](../../docs/adr/0023-artifacts.md) (Proposed).

## Bối cảnh

Hôm nay mọi thứ agent làm ra trong cuộc trò chuyện nằm lẫn trong dòng chữ:

- **Leader chat** (`apps/hub/src/modules/leader`, LEAD-01/02): `chat_messages.content` là chữ thuần, web hiện bằng
  `whitespace-pre-wrap` (`apps/web/src/pages/leader-page.tsx`). Leader chỉ có hai tool MCP `leader_reply`,
  `leader_propose` (`mcp/registry.ts` lọc cứng cho run `leader`). Một bảng so sánh, một sơ đồ, một trang HTML demo hay
  một bản nháp tài liệu dài đều thành một khối chữ, không mở riêng, không sửa tiếp, không có phiên bản.
- **App desktop** chưa có màn Leader chat (`apps/desktop/src/screens/` không có màn leader).
- **Terminal Leader** trên web (việc LEADTERM, đang làm): Claude CLI tương tác trong xterm; kết quả CLI tạo ra (file
  HTML, sơ đồ) nằm trên máy chạy CLI, người xem trên web không thấy.
- **Run của agent**: kết quả là PR, báo cáo `run_result.report` (tự do); không có chỗ cho sản phẩm phụ (bảng đo, trang
  báo cáo, sơ đồ kiến trúc).
- **Tài liệu tri thức** (`knowledge`: `docs`, `doc_versions`, editor spec 005): có phiên bản và duyệt, nhưng là tài liệu
  chính thức (qua quy trình duyệt), không phải bản làm việc nhanh. Phạm vi chỉ có tổ chức / đội / dự án, không có cá nhân.
- **Lưu file**: hub chỉ có PostgreSQL ([ADR 0003](../../docs/adr/0003-postgresql-only-state.md)); kho blob S3 "chưa
  làm" (`docs/architecture.md`, `docs/add.md` mục giới hạn). Không có bảng nào giữ file người dùng tải lên.
- **Bảo mật web**: hub phục vụ SPA cùng origin với `/rpc`, `/mcp`; hub chưa đặt Content-Security-Policy. App desktop
  đặt CSP `default-src 'self'` (`apps/desktop/src-tauri/tauri.conf.json`), gọi hub qua IPC của Rust.

Spec này thêm **artifact**: một đối tượng riêng của hub, có phiên bản, chủ sở hữu và phạm vi, do agent hoặc người tạo,
mở ở **khung bên cạnh** cuộc trò chuyện (Leader chat, Terminal Leader) thay vì nằm trong dòng chữ; có trên web và app
desktop; nội dung tương tác (HTML, React, sơ đồ) chạy trong khung cách ly.

### Thuật ngữ

| Từ | Nghĩa |
|---|---|
| **Artifact** | Một bản làm việc độc lập do agent hoặc người tạo: tài liệu Markdown, đoạn code, trang HTML/React tương tác, SVG, sơ đồ Mermaid, bảng CSV, JSON, ảnh, PDF. Có id, tiêu đề, loại, chủ, phạm vi và chuỗi phiên bản. **Khác** "tài liệu giai đoạn" của spec 011 (bảng `sdlc_artifacts`) và `report.artifacts` của run `sdlc`: hai thứ đó là tài liệu AI SDLC, không phải artifact của spec này. |
| **Phiên bản** (version) | Một lần lưu nội dung, không sửa không xoá (trừ khi xoá cả artifact). Số tăng dần từ 1. Ghi tác giả (người hoặc run), lời nhắn, nguồn. |
| **Phạm vi** (scope) | Ai thấy artifact: `private` (cá nhân, chỉ chủ), `project` (thành viên đội sở hữu dự án), `team` (thành viên đội), `org` (mọi thành viên tổ chức). Không có phạm vi công khai ra ngoài tổ chức. |
| **Chủ** (owner) | Người chịu trách nhiệm artifact: người tạo, hoặc người đã mở chat/run khi agent tạo. Chủ đổi phạm vi, xoá, chuyển chủ. |
| **Nguồn** (origin) | Nơi sinh ra artifact: `leader` (Leader chat, kèm cuộc trò chuyện), `terminal` (Terminal Leader, kèm phiên), `run` (run của agent, kèm run và task), `mcp` (client MCP của người dùng, vd. Claude Code trên máy dev), `manual` (người tạo tay). |
| **Khung bên cạnh** (side panel) | Vùng bên phải cuộc trò chuyện (dưới 1024 px là ngăn kéo/toàn màn) hiện artifact đang mở, có tab artifact của cuộc trò chuyện, nút phiên bản, toàn màn, sao chép, tải về. |
| **Thẻ tham chiếu** | Một dòng trong cuộc trò chuyện trỏ tới artifact (tiêu đề, loại, phiên bản, "Mở"), thay cho nội dung. |
| **Khung cách ly** (sandbox frame) | `iframe` có `sandbox="allow-scripts"` (không `allow-same-origin`), tải từ origin riêng với CSP chặt, chạy HTML/React/SVG/Mermaid. Không đọc được cookie, phiên, DOM của hub; không gọi mạng ra ngoài trừ thư viện cho phép. |
| **Thư viện artifact** | Màn liệt kê mọi artifact người dùng thấy được, lọc theo loại, phạm vi, nguồn, dự án. |
| **Liên kết** (link) | Quan hệ artifact ↔ đối tượng khác: cuộc trò chuyện, phiên terminal, run, task, hạng mục AI SDLC, tài liệu tri thức. |

### Nơi dùng

- **Web** và **app desktop** có cùng màn (khung bên cạnh, xem artifact, lịch sử và so sánh phiên bản, thư viện) từ package
  dùng chung `@xdev-hive/artifacts-ui`, như cách `@xdev-hive/doc-editor` và `@xdev-hive/sdlc-ui` dùng chung (ADR 0017,
  FR-027 spec 008).
- **App desktop** đọc lại offline các phiên bản đã tải.
- **Agent** tạo và sửa artifact qua MCP của hub (Leader chat, Terminal Leader, run, client MCP của người dùng).

## Clarifications

### Session 2026-10-14 (mặc định, chờ PO xác nhận)

Người soạn đặt mặc định cho mọi câu hỏi mở để spec không bị chặn. Mỗi mục ghi **mặc định, chờ PO xác nhận**; PO đổi
mục nào thì cập nhật FR và tasks tương ứng. Danh sách câu hỏi để hỏi PO ở cuối mục.

- **C1. Artifact là đối tượng riêng hay là tài liệu tri thức?** → *Mặc định, chờ PO xác nhận*: **đối tượng riêng** của
  hub (module mới `artifacts`), không đi quy trình duyệt. Muốn thành tài liệu chính thức thì dùng "Chuyển thành tài liệu"
  (tạo đề xuất trong `knowledge`, qua quy trình duyệt). Lý do: artifact là bản làm việc nhanh, sửa liên tục; tài liệu tri
  thức là bản đã duyệt.
- **C2. Phạm vi** → *Mặc định, chờ PO xác nhận*: `private`, `project`, `team`, `org` giống phạm vi tài liệu cộng thêm cá
  nhân. Không public ra ngoài tổ chức ở bản này. MVP: `private` và `project`; `team`, `org` sau MVP.
- **C3. Mặc định phạm vi khi agent tạo** → *Mặc định, chờ PO xác nhận*: Leader chat, Terminal Leader, client MCP của
  người dùng → `private` của người mở chat/phiên/token. Run của task → `project` của dự án run (run đội không có người
  chủ nên không có "cá nhân" hợp lý). Chủ đổi phạm vi sau.
- **C4. Ai sửa được artifact `project`/`team`/`org`?** → *Mặc định, chờ PO xác nhận*: thành viên (vai trò `member` trở
  lên) của phạm vi được tạo phiên bản mới; chỉ chủ và quản trị đội/tổ chức của phạm vi đổi phạm vi, chuyển chủ, xoá.
  Người chỉ xem (`viewer`, `ba`) nhân bản được thành artifact riêng của mình.
- **C5. Quản trị tổ chức có xem artifact `private` của người khác không?** → *Mặc định, chờ PO xác nhận*: **không** xem
  nội dung; chỉ thấy tổng dung lượng theo người trong màn quản trị dung lượng, và xoá được khi người dùng rời tổ chức.
- **C6. Loại artifact** → *Mặc định, chờ PO xác nhận*: `markdown`, `code` (kèm ngôn ngữ), `html`, `react`, `svg`,
  `mermaid`, `csv`, `json`, `image`, `pdf`. MVP: `markdown`, `code`, `html`, `mermaid`. Sau MVP lần lượt: `react`, `svg`,
  `json`, `csv` (bảng + biểu đồ), rồi `image`, `pdf`.
- **C7. Chạy HTML/React ở đâu?** → *Mặc định, chờ PO xác nhận*: khung cách ly `sandbox="allow-scripts"` (không
  `allow-same-origin`), tải từ route `/_artifact/frame/{ticket}` của hub với CSP riêng có chỉ thị `sandbox`, hoặc từ
  **origin riêng** `HIVE_ARTIFACT_ORIGIN` nếu người vận hành cấu hình (khuyến nghị cho bản production: tên miền riêng,
  khác registrable domain của hub). App desktop dùng giao thức riêng `hive-artifact://` của Tauri. Không dùng `srcdoc`
  vì tài liệu `srcdoc` thừa hưởng CSP của trang cha (xem plan.md D4).
- **C8. Thư viện JS cho trang tương tác** → *Mặc định, chờ PO xác nhận*: hub **đóng gói sẵn** một bộ thư viện có ghim
  phiên bản (React 19, ReactDOM, Recharts, d3, lucide-react, Mermaid, Tailwind bản trình duyệt) và phục vụ từ origin của
  khung; mặc định **không** cho gọi CDN ngoài (`connect-src 'none'`). Quản trị tổ chức thêm được danh sách CDN cho phép
  (chỉ `script-src`/`style-src`, vẫn không `connect-src`). Lý do: hub tự host, có tổ chức không ra Internet; app desktop
  cần đọc offline; giảm đường rò dữ liệu.
- **C9. Lưu ở đâu?** → *Mặc định, chờ PO xác nhận*: nội dung chữ trong PostgreSQL (`artifact_versions.content`); ảnh/PDF
  (sau MVP) trong PostgreSQL (`artifact_blobs`, `bytea` chia đoạn) sau một giao diện `BlobStore` để chuyển sang kho S3 khi
  hub có (ADR 0003 hoãn S3). Hub hiện không có kho file nào khác.
- **C10. Giới hạn** → *Mặc định, chờ PO xác nhận*: mỗi phiên bản chữ ≤ 1 MiB (UTF-8); ≤ 200 phiên bản mỗi artifact (tới
  giới hạn thì từ chối, gợi ý "Nhân bản thành artifact mới"); một run tạo ≤ 20 artifact và ≤ 100 phiên bản; ảnh/PDF ≤ 20
  MiB; dung lượng mỗi tổ chức 2 GiB (tính cả phiên bản cũ). Quản trị tổ chức chỉnh trong Chính sách agent (mục
  Artifacts), không vượt trần của người vận hành (biến môi trường).
- **C11. Quét bí mật** → *Mặc định, chờ PO xác nhận*: mọi lần lưu (người và agent) chạy bộ quét bí mật (mẫu token
  GitHub/GitLab/AWS/Slack/OpenAI/Anthropic, khoá riêng PEM, dạng `password=…` như `worker/internal/runner/checks.go`).
  Có phát hiện thì **từ chối** lưu, trả số dòng và loại (không trả chuỗi bí mật). Người dùng thấy dòng bị đánh dấu và sửa;
  agent nhận lỗi để tự sửa. Chính sách tổ chức chọn được `redact` (thay bằng `[đã che]` rồi lưu) thay cho `block`.
- **C12. Thẻ tham chiếu trong chat** → *Mặc định, chờ PO xác nhận*: khi agent tạo/sửa artifact trong một cuộc trò chuyện,
  hub thêm một tin nhắn loại thẻ (không phải chữ của agent) vào cuộc trò chuyện; khung bên cạnh tự mở artifact mới nhất
  nếu người dùng đang xem cuộc trò chuyện đó. Leader viết chữ trả lời riêng bằng `leader_reply`.
- **C13. App desktop chưa có màn Leader chat** → *Mặc định, chờ PO xác nhận*: spec này thêm màn Leader chat **tối thiểu**
  cho app (danh sách cuộc trò chuyện, tin nhắn, gửi, thẻ đề xuất, khung bên cạnh) dùng component chung; phần duyệt đề xuất
  hành động giữ như web.
- **C14. Thùng rác và giữ dữ liệu** → *Mặc định, chờ PO xác nhận*: xoá là xoá mềm; khôi phục trong 30 ngày; job xoá hẳn
  sau 30 ngày. Xoá cuộc trò chuyện không xoá artifact (artifact còn trong thư viện, mất liên kết).
- **C15. Tên trên giao diện** → *Mặc định, chờ PO xác nhận*: giữ chữ **"Artifact"** (thuật ngữ quen với người dùng Claude),
  các chữ khác tiếng Việt ("Phiên bản", "So sánh", "Khôi phục bản này", "Mở toàn màn").
- **C16. "Chuyển thành tài liệu", "Lưu vào repo"** → *Mặc định, chờ PO xác nhận*: sau MVP. "Chuyển thành tài liệu" tạo
  đề xuất `knowledge` (qua quy trình duyệt); "Lưu vào repo" mở PR như đồng bộ tài liệu của spec 011 (D11).

**Câu hỏi cần PO trả lời** (thứ tự theo mức ảnh hưởng tới MVP):

1. Đồng ý MVP: `markdown`, `code`, `html`, `mermaid`; khung bên cạnh trong Leader chat web + app; MCP cho agent; phiên
   bản; phạm vi cá nhân/dự án? Có cần `react` ngay MVP (thêm bước biên dịch JSX và bộ thư viện)?
2. Máy chủ production có tên miền riêng cho khung cách ly (vd. `hive-usercontent.<công ty>`) không? Không có thì dùng route
   cùng host (an toàn nhờ sandbox + CSP, nhưng kém cách ly hơn tên miền riêng).
3. Cho trang tương tác gọi CDN ngoài không, hay chỉ bộ thư viện đóng gói sẵn (C8)? Có cho trang gọi mạng (API ngoài) không
   — mặc định **không**.
4. Quản trị tổ chức có được xem artifact cá nhân của người khác (C5)?
5. Giới hạn dung lượng (C10) có hợp với máy chủ 34 không?
6. Quét bí mật chặn hay che (C11)?
7. Làm màn Leader chat tối thiểu trong app desktop trong spec này (C13) hay chờ một spec Leader app riêng?
8. Ai trong dự án sửa được artifact dự án (C4)?
9. Có cần chia sẻ ra ngoài tổ chức (link công khai) ở bản sau không?
10. Có cần "Sửa lỗi" — gửi lỗi chạy của trang tương tác về Leader để agent sửa — trong MVP không (mặc định: sau MVP)?

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent trong Leader chat tạo artifact, mở ở khung bên cạnh (Priority: P1)

Tech lead hỏi Leader của dự án `payment-api`: "Vẽ sơ đồ luồng hoàn tiền và viết bản nháp checklist release". Leader gọi
`artifact_create` hai lần: một artifact `mermaid` "Luồng hoàn tiền", một artifact `markdown` "Checklist release 1.4", rồi
trả lời bằng `leader_reply`. Trong cuộc trò chuyện hiện hai **thẻ tham chiếu**; khung bên cạnh mở artifact mới nhất, có tab
cho cả hai. Tech lead bấm "Mở toàn màn" để xem sơ đồ lớn, quay lại chat vẫn ở chỗ cũ.

**Why this priority**: Đây là yêu cầu gốc của PO: artifact mở ở khung riêng, không chôn trong dòng chữ.

**Independent Test**: Hub giả lập run `leader` gọi `artifact_create` (mermaid, markdown) với `threadId`. Kiểm: hai dòng
`artifacts` phạm vi `private` của người tạo cuộc trò chuyện, hai liên kết `chat_thread`, hai tin nhắn thẻ trong
`chat_messages`; web (Playwright, hub giả) thấy hai thẻ, khung bên cạnh mở artifact thứ hai, tab có cả hai; 360 px thì
khung thành ngăn kéo toàn màn.

**Acceptance Scenarios**:

1. **Given** run `leader` của cuộc trò chuyện T, **When** agent gọi `artifact_create { threadId: T, type, title, content }`,
   **Then** hub kiểm run thuộc T (như `leader_reply`), lưu artifact phiên bản 1, gắn liên kết với T, thêm tin nhắn thẻ, trả
   `{ id, version, url }`.
2. **Given** người dùng đang mở cuộc trò chuyện T, **When** thẻ mới xuất hiện (thăm dò như tin nhắn leader, ≤ 3 giây khi
   đang chờ leader), **Then** khung bên cạnh tự mở artifact đó, trừ khi người dùng đang sửa một artifact khác (khi đó chỉ
   hiện chấm báo trên tab).
3. **Given** thẻ trong chat, **When** bấm "Mở", **Then** khung bên cạnh mở đúng phiên bản của thẻ, có nhãn "Có bản mới
   hơn (v3)" nếu đã có bản sau.
4. **Given** cuộc trò chuyện có artifact, **When** mở danh sách "Artifact của cuộc trò chuyện", **Then** thấy mọi artifact
   liên kết với cuộc trò chuyện, mới nhất trước, kèm loại, phiên bản, người sửa gần nhất.
5. **Given** màn rộng ≥ 1024 px, **Then** chat và khung bên cạnh chia đôi, kéo được vạch chia (nhớ theo người dùng); hẹp
   hơn thì khung là ngăn kéo phủ toàn màn có nút "Về cuộc trò chuyện".
6. **Given** artifact `markdown`, `code`, `mermaid`, `html`, **When** mở, **Then** hiện bằng trình xem của loại (US3), có
   nút Sao chép, Tải về (đuôi theo loại), Phiên bản, Mở toàn màn, Mở trong thư viện.

---

### User Story 2 - Phiên bản: sửa tạo bản mới, xem lịch sử, so sánh, quay lại (Priority: P1)

Tech lead nói "thêm bước hoàn tiền thủ công vào sơ đồ". Leader gọi `artifact_update` với `baseVersion: 1`: hub lưu phiên bản
2, thẻ mới "Luồng hoàn tiền · v2" hiện trong chat, khung bên cạnh chuyển sang v2. Tech lead mở **Phiên bản**, chọn v1 và v2,
bấm **So sánh**: thấy khác biệt dòng (nguồn) và hai bản hiển thị cạnh nhau. Không ưng, bấm "Khôi phục v1": hub tạo v3 có nội
dung của v1.

**Why this priority**: PO yêu cầu "mỗi lần agent hay người sửa là một bản". Không có phiên bản thì agent ghi đè mất bản
người đã ưng.

**Independent Test**: DB test: tạo → cập nhật hai lần (một bởi run, một bởi người) → `versions.list` trả 3 bản đúng tác giả;
cập nhật với `baseVersion` cũ → `ARTIFACT_VERSION_CONFLICT`; khôi phục v1 → v4 có `restoredFrom: 1`, nội dung bằng v1;
phiên bản cũ không sửa được qua mọi route.

**Acceptance Scenarios**:

1. **Given** artifact ở v2, **When** gọi `artifact_update { baseVersion: 1 }`, **Then** từ chối `ARTIFACT_VERSION_CONFLICT`
   "Artifact đã có bản mới hơn (v2). Đọc lại rồi sửa." kèm nội dung v2 để agent gộp; không mất bản nào.
2. **Given** `artifact_update` không có `baseVersion` (agent cũ), **Then** hub nhận nếu người gọi là tác giả bản mới nhất
   (cùng run hoặc cùng người), ngược lại từ chối như trên.
3. **Given** chọn hai phiên bản, **When** So sánh, **Then** loại chữ (markdown, code, html, mermaid, svg, json, csv) có
   diff dòng (thuật toán `line-diff` sẵn có trong contracts); loại hiển thị (markdown, mermaid, html, svg) có thêm chế độ
   "Cạnh nhau" (hai khung xem); ảnh/PDF chỉ cạnh nhau.
4. **Given** "Khôi phục bản này" ở v1, **When** xác nhận, **Then** tạo phiên bản mới (không xoá bản giữa), lời nhắn
   "Khôi phục từ v1", ghi audit.
5. **Given** mỗi phiên bản, **Then** có: số, tác giả (người hoặc run + CLI/model), nguồn (leader/terminal/run/mcp/manual),
   lời nhắn (tuỳ chọn, ≤ 500 ký tự), cỡ, lúc tạo. Đặt tên được cho một bản ("Bản gửi khách").
6. **Given** artifact có 200 phiên bản, **When** cập nhật, **Then** từ chối `ARTIFACT_VERSION_LIMIT` "Artifact đã đủ 200
   phiên bản. Nhân bản thành artifact mới để sửa tiếp.".

---

### User Story 3 - Xem đúng theo loại; trang tương tác chạy cách ly (Priority: P1)

Leader làm một trang HTML "Máy tính phí hoàn tiền" có ô nhập và nút tính. Trang chạy trong khung cách ly: bấm được, tính
được, nhưng không đọc được phiên đăng nhập, không gọi được `/rpc` của hub, không gửi dữ liệu ra ngoài.

**Why this priority**: Trang tương tác là giá trị lớn nhất của artifact và cũng là rủi ro lớn nhất (XSS vào hub).

**Independent Test**: Playwright với hub giả: artifact `html` chạy script đọc `document.cookie`, gọi
`fetch("/rpc/...")`, `fetch("https://example.com")`, `top.location = …`, `window.parent.document`, tạo `<img src=https://…>`,
`<form action=…>`; ghi kết quả vào DOM của chính nó. Kiểm: mọi thao tác bị chặn (lỗi hoặc rỗng), trang cha không đổi, hub
giả không nhận request nào từ khung ngoài route khung và thư viện.

**Acceptance Scenarios**:

1. **Given** artifact `markdown`, **Then** hiện bằng trình đọc của `@xdev-hive/doc-editor` (Tiptap sau #204) ở chế độ chỉ
   đọc; HTML thô trong Markdown bị bỏ (không chạy); khối Mermaid trong Markdown hiện như artifact `mermaid` (trong khung
   cách ly).
2. **Given** artifact `code` (`language` ∈ danh sách ngôn ngữ hỗ trợ), **Then** tô màu cú pháp, số dòng, ngắt dòng bật/tắt,
   sao chép; ngôn ngữ lạ thì hiện chữ thuần.
3. **Given** artifact `html`, `react`, `svg`, `mermaid`, **Then** hiện trong khung cách ly: `iframe sandbox="allow-scripts"`
   (không có `allow-popups`, `allow-forms`, `allow-modals`), nguồn là URL khung có vé ngắn hạn
   (≤ 5 phút, một artifact một phiên bản), CSP: `default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'
   <origin khung>/lib/ <CDN cho phép>; style-src 'unsafe-inline' <origin khung>/lib/ <CDN cho phép>; img-src data: blob:;
   font-src data: <origin khung>/lib/; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none';
   sandbox allow-scripts`.
4. **Given** trang trong khung, **Then** trang không đọc được cookie hub (origin mờ), không gọi được mạng (`connect-src
   'none'`), không điều hướng trang cha (không `allow-top-navigation`), không mở cửa sổ mới; mở URL khung trực tiếp trên
   tab mới vẫn bị sandbox nhờ chỉ thị CSP `sandbox`.
5. **Given** artifact `react`, **Then** hub biên dịch JSX/TSX khi lưu phiên bản (D6 plan), lỗi biên dịch lưu cùng phiên
   bản và trả cho người gọi (agent sửa được); khung nạp bản đã biên dịch với import map trỏ tới thư viện đóng gói sẵn. Mặc
   định export là component gốc.
6. **Given** khung cách ly báo lỗi chạy (qua `postMessage` có kiểm nguồn là chính `iframe` đó), **Then** khung bên cạnh hiện
   "Trang báo lỗi: …" (≤ 3 lỗi đầu); sau MVP có nút "Nhờ Leader sửa" gửi lỗi vào cuộc trò chuyện.
7. **Given** chiều cao nội dung khung thay đổi, **Then** khung báo chiều cao qua `postMessage`; trang cha chỉ nhận số và
   giới hạn trong khung bên cạnh (không nhận HTML, không thực thi gì từ khung).
8. **Given** chủ đề sáng/tối của hub, **Then** khung nhận `theme` qua tham số URL; trang tự quyết dùng hay không.
9. **Given** artifact `json`, **Then** cây gập/mở, tìm khoá; JSON lỗi thì hiện chữ thuần kèm vị trí lỗi. Artifact `csv`:
   bảng có sắp xếp, lọc, phân trang (≤ 10 000 dòng), nút "Biểu đồ" chọn cột (cột, đường, tròn) vẽ trong khung cách ly.
10. **Given** artifact `image` (PNG, JPEG, WebP, GIF; SVG đi đường `svg`), `pdf`, **Then** xem trong trang (PDF bằng trình xem
    trong khung cách ly, không bằng plugin trình duyệt cùng origin hub), tải về.

---

### User Story 4 - Phạm vi và chia sẻ trong tổ chức (Priority: P1)

Tech lead thấy "Checklist release 1.4" hữu ích cho cả đội, bấm **Chia sẻ** → chọn "Dự án payment-api". Thành viên đội của
dự án thấy artifact trong thư viện và trong tab Artifact của dự án; người ngoài đội không thấy. Một thành viên sửa thêm hai
mục: thành v3, tác giả là người đó.

**Why this priority**: PO yêu cầu artifact "có phạm vi … chia sẻ được trong tổ chức". Phạm vi sai là lộ dữ liệu.

**Independent Test**: DB test ba người (chủ, thành viên đội dự án, thành viên đội khác) × bốn phạm vi × mọi route đọc/ghi và
tool MCP: đúng bảng quyền ở FR-020…FR-024; tổ chức khác thấy 0 dòng (RLS).

**Acceptance Scenarios**:

1. **Given** artifact `private`, **Then** chỉ chủ thấy (route, thư viện, MCP, tìm kiếm, thẻ trong chat chung nếu có);
   người khác mở link nhận "Không tìm thấy artifact." (không lộ là có tồn tại).
2. **Given** chủ đổi sang `project` P, **Then** thành viên đội sở hữu P (mọi vai trò) đọc được; vai trò `member` trở lên tạo
   được phiên bản mới; `viewer`/`ba` chỉ đọc và nhân bản.
3. **Given** đổi phạm vi rộng hơn (`private` → `project`/`team`/`org`), **Then** hiện xác nhận "Mọi thành viên … sẽ thấy cả
   các phiên bản cũ." và ghi audit `artifact.scope.change` (cũ, mới).
4. **Given** artifact trong cuộc trò chuyện của dự án, **When** chủ chia sẻ, **Then** gợi ý mặc định là dự án của cuộc
   trò chuyện.
5. **Given** không có lựa chọn công khai ra ngoài tổ chức, **Then** mọi URL artifact và URL khung đòi phiên đăng nhập hoặc vé
   ngắn hạn do phiên đó cấp; vé không dùng lại được cho artifact khác.
6. **Given** chủ rời tổ chức, **Then** artifact `private` của người đó bị xoá mềm; artifact phạm vi khác chuyển chủ sang quản
   trị của phạm vi (đội) hoặc người quản trị tổ chức thực hiện gỡ thành viên; ghi audit.

---

### User Story 5 - Agent dùng tool MCP artifact ở mọi nơi có MCP của hub (Priority: P1)

Agent của run code (task "Tối ưu truy vấn báo cáo") đo trước/sau và gọi `artifact_create` một bảng `csv` kết quả đo và một
trang `html` biểu đồ; artifact gắn với run và task, hiện ở trang run và trang task. Trên máy dev, người dùng chạy Claude
Code với token cá nhân `hive_pat_`, nói "đưa sơ đồ này lên Hive": artifact `private` của người đó.

**Why this priority**: Artifact chỉ có ích khi agent tự tạo được; MCP là đường chung của mọi agent trong Hive.

**Independent Test**: DB test `mcp-artifacts.db.test.ts`: run `leader`, run `code`, run `plan` (chỉ đọc repo nhưng được ghi
artifact), người dùng OAuth/PAT; mỗi principal: tạo, sửa, đọc, liệt kê đúng phạm vi; vượt giới hạn cỡ/số lượng bị từ chối
với mã lỗi; tool tắt ở trang MCP tools (MCP-04) thì không hiện.

**Acceptance Scenarios**:

1. **Given** cổng MCP, **Then** có bốn tool: `artifact_create { type, title, content, language?, threadId?,
   terminalSessionId?, scope?, message? }`, `artifact_update { id, content, baseVersion?, title?, message? }`,
   `artifact_get { id, version? }`, `artifact_list { threadId?, runId?, taskId?, projectKey?, type?, query?, limit? }`.
   `artifact_get`/`artifact_list` là `readOnly`.
2. **Given** run `leader`, **Then** danh sách tool của nó có thêm bốn tool artifact (ngoài `leader_reply`,
   `leader_propose`); tạo trong cuộc trò chuyện của run; đọc được artifact của cuộc trò chuyện và artifact phạm vi dự án
   của dự án cuộc trò chuyện.
3. **Given** run có task (code, plan, review, sdlc, …), **Then** tạo với phạm vi mặc định `project` của dự án run, liên kết
   run và task; sửa được artifact mà run đó tạo, hoặc artifact đã liên kết với task của run; đọc được artifact phạm vi dự
   án của dự án run.
4. **Given** người dùng qua OAuth/PAT, **Then** quyền như trên web (US4); mặc định `private`.
5. **Given** nội dung > giới hạn (C10), **Then** từ chối `ARTIFACT_TOO_LARGE` "Artifact quá lớn (1,4 MiB > 1 MiB)."; run
   đã tạo 20 artifact → `ARTIFACT_RUN_LIMIT`; tổ chức hết dung lượng → `ARTIFACT_QUOTA_EXCEEDED`; có bí mật →
   `ARTIFACT_SECRET_FOUND` kèm dòng và loại.
6. **Given** mọi lời gọi tool ghi, **Then** có dòng audit `mcp.artifact_create`/`mcp.artifact_update` (như mọi tool MCP)
   và audit nghiệp vụ `artifact.create`/`artifact.version` với nguồn và principal.
7. **Given** prompt của Leader (`leader/prompt.ts`) và prompt run, **Then** có hướng dẫn ngắn: nội dung dài (> 30 dòng),
   sơ đồ, trang tương tác, bảng → tạo artifact thay vì dán vào chữ trả lời; sửa thì `artifact_update`, không tạo bản trùng.

---

### User Story 6 - App desktop: khung bên cạnh, thư viện, đọc offline (Priority: P1)

Developer dùng app desktop, mở **Leader** (màn mới tối thiểu, C13), hỏi Leader như trên web: thẻ artifact và khung bên cạnh
giống web. Trên tàu không có mạng, developer mở **Artifact** trong app: các artifact đã mở trước đó vẫn đọc được (nhãn
"Bản đã tải · v2 · 10:42"), trang HTML vẫn chạy với thư viện đóng gói trong app.

**Why this priority**: PO yêu cầu có trên cả web và app; app là nơi người dùng làm việc hằng ngày (ADR 0017).

**Independent Test**: Test desktop (Vitest + Testing Library, hub giả): màn Leader hiện thẻ, khung bên cạnh mở; Rust test
cho bộ đệm: ghi phiên bản đã mở, đọc lại khi hub lỗi mạng, xoá hết khi đăng xuất; giao thức `hive-artifact://` trả CSP như
khung web.

**Acceptance Scenarios**:

1. **Given** app đăng nhập, **Then** menu có **Artifact** (thư viện) cho mọi hồ sơ (`dev`, `writer`, `lead`), và **Leader**
   (C13).
2. **Given** mở một phiên bản, **Then** app lưu nội dung phiên bản (và bản biên dịch của `react`) vào thư mục dữ liệu app
   theo hồ sơ và tổ chức; tối đa 200 MiB, bỏ bản ít mở nhất khi đầy.
3. **Given** mất kết nối hub, **When** mở artifact đã tải, **Then** hiện bản đã tải mới nhất với nhãn "Đang offline — bản
   đã tải lúc …"; nút sửa, chia sẻ, phiên bản tắt; artifact chưa tải hiện "Cần kết nối hub để mở.".
4. **Given** artifact `html`/`react`/`mermaid`/`svg` trong app, **Then** chạy trong `iframe` có `sandbox="allow-scripts"`
   nạp từ `hive-artifact://` (Rust phục vụ từ bộ đệm và thư viện đóng gói trong app, cùng CSP như web); CSP của app chỉ thêm
   `frame-src hive-artifact:` (Windows: `http://hive-artifact.localhost`).
5. **Given** đăng xuất hoặc đổi tổ chức, **Then** bộ đệm của hồ sơ/tổ chức cũ bị xoá.
6. **Given** artifact bị thu hẹp phạm vi hoặc xoá trên hub, **When** app có mạng lại và mở danh sách, **Then** bản đệm của
   artifact không còn quyền bị xoá.

---

### User Story 7 - Thư viện artifact (Priority: P2)

PO mở **Artifact** trên web: thấy mọi artifact mình xem được, lọc "Của tôi / Dự án / Đội / Tổ chức", theo loại, theo nguồn
(Leader, Terminal, Run, MCP, Tay), theo dự án; tìm theo tiêu đề và nội dung; mở một artifact toàn màn; đổi tên, chia sẻ, nhân
bản, xoá; khôi phục trong **Thùng rác**.

**Why this priority**: Sau MVP khung bên cạnh, người dùng cần tìm lại artifact không còn trong cuộc trò chuyện đang mở.
Bản tối thiểu (danh sách, mở) thuộc MVP vì app offline và link cần một trang chi tiết.

**Independent Test**: DB test tìm kiếm (tiêu đề + nội dung bản mới nhất, cấu hình `simple` như memory) trả đúng phạm vi;
Playwright: lọc, mở, đổi tên, xoá, khôi phục; 10 000 artifact của tổ chức, trang đầu ≤ 300 ms (p95).

**Acceptance Scenarios**:

1. **Given** thư viện, **Then** mỗi dòng: tiêu đề, loại (biểu tượng), phạm vi, dự án, chủ, nguồn, phiên bản mới nhất, lần sửa
   cuối; sắp xếp theo lần sửa cuối; phân trang theo con trỏ.
2. **Given** trang chi tiết `/artifacts/:id` (và `/artifacts/:id/v/:n`), **Then** giống khung bên cạnh nhưng toàn màn, có tab
   Phiên bản, Liên kết (cuộc trò chuyện, run, task…), Hoạt động (audit của artifact).
3. **Given** Nhân bản, **Then** tạo artifact mới `private` của người bấm với nội dung bản đang xem, ghi "Nhân bản từ …".
4. **Given** Xoá, **Then** artifact vào Thùng rác 30 ngày (C14); thẻ trong chat hiện "Artifact đã bị xoá"; khôi phục đưa về
   như cũ.
5. **Given** trang dự án và trang task/run, **Then** có tab hoặc mục "Artifact" liệt kê artifact liên kết.

---

### User Story 8 - Terminal Leader: artifact ở khung bên cạnh terminal (Priority: P2)

Trên web, người dùng mở **Terminal Leader** (LEADTERM), Claude CLI tương tác chạy trong xterm. CLI có MCP của hub (token của
phiên), gọi `artifact_create` với `terminalSessionId`: khung bên cạnh terminal mở artifact, giống Leader chat.

**Why this priority**: PO nêu Terminal Leader là nơi agent làm việc trên web; CLI không có cách hiện sản phẩm cho người xem
ngoài máy. Phụ thuộc LEADTERM xong.

**Independent Test**: Phiên terminal giả (hub giả) gọi tool với `terminalSessionId`: liên kết `terminal_session`; màn
Terminal Leader (Playwright) hiện khung bên cạnh; phiên của người khác không gắn được (`ARTIFACT_LINK_FORBIDDEN`).

**Acceptance Scenarios**:

1. **Given** phiên Terminal Leader S của người U, **When** CLI gọi `artifact_create { terminalSessionId: S }` bằng
   principal của U (token phiên hoặc PAT), **Then** artifact `private` của U, liên kết `terminal_session` S, khung bên cạnh
   của S mở nó (thăm dò ≤ 3 giây khi phiên đang chạy).
2. **Given** S không phải của principal, **Then** từ chối `ARTIFACT_LINK_FORBIDDEN` "Không gắn được artifact vào phiên của
   người khác.".
3. **Given** cấu hình MCP mà LEADTERM ghi cho CLI, **Then** có hướng dẫn (system prompt hoặc `CLAUDE.md` của phiên) nêu
   `terminalSessionId` và khi nào tạo artifact.

---

### User Story 9 - Người tạo và sửa artifact bằng tay (Priority: P2)

Người dùng bấm "Artifact mới" (trong thư viện hoặc khung bên cạnh), chọn loại, gõ tiêu đề, soạn: Markdown bằng editor Tiptap
(#204), code/HTML/Mermaid/SVG/JSON/CSV bằng ô soạn code có tô màu và nút "Xem trước". Lưu tạo phiên bản. Với artifact agent
tạo, bấm "Sửa" để sửa tay; lưu thành bản mới với tác giả là người.

**Why this priority**: Người cần chỉnh nhanh mà không phải nhờ agent. MVP có sửa tay `markdown` và `code` tối thiểu (ô soạn
chữ) để có phiên bản người; editor đầy đủ sau.

**Independent Test**: Playwright: tạo `markdown` bằng editor, lưu v1; sửa, lưu v2; mở hai tab cùng sửa → tab sau nhận
`ARTIFACT_VERSION_CONFLICT` và nút "Xem khác biệt rồi gộp".

**Acceptance Scenarios**:

1. **Given** "Artifact mới", **Then** chọn loại (chỉ loại đã bật), tiêu đề (1–200 ký tự), phạm vi (mặc định `private`, hoặc
   dự án đang xem).
2. **Given** loại `markdown`, **Then** dùng `@xdev-hive/doc-editor` (Tiptap) không có tính năng duyệt (khối R-n, đề xuất,
   gửi duyệt ẩn).
3. **Given** loại có xem trước, **Then** "Xem trước" chạy trong khung cách ly với nội dung chưa lưu (vé cho bản nháp, không
   lưu DB, ≤ 1 MiB).
4. **Given** đang sửa có thay đổi chưa lưu, **When** rời khung/trang, **Then** hỏi "Bỏ thay đổi chưa lưu?"; bản nháp giữ trong
   bộ nhớ trình duyệt của phiên (không lưu hub).
5. **Given** quét bí mật phát hiện (C11), **Then** dòng bị đánh dấu, lưu bị chặn với "Có chuỗi giống bí mật ở dòng 12 (GitHub
   token). Xoá rồi lưu lại." (hoặc che nếu chính sách `redact`).

---

### User Story 10 - Gắn artifact vào task, run, hạng mục AI SDLC, tài liệu (Priority: P2)

Tech lead gắn "Luồng hoàn tiền" vào task "Hoàn tiền một phần" và vào hạng mục AI SDLC `012-hoan-tien-mot-phan`. Agent của run
code task đó đọc được artifact qua `artifact_get` (prompt run có danh sách artifact gắn với task).

**Why this priority**: Artifact là đầu vào tốt cho việc kế tiếp (sơ đồ, quyết định). Sau MVP vì cần màn của task/AI SDLC.

**Independent Test**: DB test: gắn/bỏ gắn đúng quyền (người gắn phải đọc được artifact và sửa được đích); run của task có
`artifacts` trong prompt (id, tiêu đề, loại); `artifact_get` của run đọc được artifact gắn với task. Gắn artifact `private`
vào task bị từ chối `ARTIFACT_SCOPE_TOO_NARROW`: gắn vào task đòi phạm vi ≥ `project` của dự án task (giao diện hỏi chia
sẻ trước khi gắn).

**Acceptance Scenarios**:

1. **Given** artifact `private`, **When** gắn vào task của dự án P, **Then** hỏi "Chia sẻ cho dự án P để agent và đội đọc
   được?"; không đồng ý thì không gắn.
2. **Given** gắn vào hạng mục AI SDLC (spec 011), **Then** hạng mục có mục "Artifact" (trong `@xdev-hive/sdlc-ui`), run `sdlc`
   của hạng mục nhận danh sách artifact trong prompt.
3. **Given** gắn vào tài liệu tri thức, **Then** trang tài liệu có mục "Artifact liên quan" (không đổi nội dung tài liệu).
4. **Given** run tạo artifact, **Then** liên kết `run` và `task` tự có; trang run và trang task hiện chúng.

---

### User Story 11 - Chuyển thành tài liệu và Lưu vào repo (Priority: P3)

Checklist release đã ổn, tech lead bấm **Chuyển thành tài liệu**: chọn key `project/payment-api/release-checklist`, hub tạo đề
xuất tài liệu (`knowledge`) với nội dung bản đang xem, đi quy trình duyệt như mọi đề xuất. Với sơ đồ, bấm **Lưu vào repo**:
chọn đường dẫn `docs/diagrams/refund.mmd`, hub mở PR trên repo của dự án.

**Why this priority**: Đưa bản làm việc thành tài sản chính thức. Sau MVP (PO đề xuất).

**Independent Test**: DB test: chuyển tạo `proposals` đúng scope, liên kết `doc`; lưu vào repo gọi `GitProvider.commitFiles` +
`openPR` (provider giả) với nhánh `hive/artifact/<id>-v<n>`, đường dẫn bị kiểm như FR-003 spec 011.

**Acceptance Scenarios**:

1. **Given** artifact `markdown`, **When** Chuyển thành tài liệu, **Then** đề xuất mới (tác giả là người bấm, ghi "Từ
   artifact … v3"), artifact có liên kết `doc`; chỉ loại `markdown`.
2. **Given** Lưu vào repo, **Then** người bấm cần quyền ghi dự án; đường dẫn tương đối, không `..`, không `.git/`,
   `.github/workflows/`, `.gitlab-ci.yml`; một PR một artifact một phiên bản; PR đi chính sách kết quả của dự án (ADR 0009).

---

### User Story 12 - Quản trị: bật tắt, giới hạn, CDN, quét bí mật, dung lượng (Priority: P2)

Quản trị tổ chức mở **Chính sách agent → Artifacts**: bật/tắt artifact cho tổ chức, loại được phép, giới hạn cỡ và số phiên
bản (không vượt trần người vận hành), danh sách CDN cho phép, quét bí mật chặn/che, dung lượng tổ chức. Màn **Dung lượng
artifact** hiện tổng, theo dự án, theo người (số, không nội dung `private`).

**Why this priority**: Hub tự host trên một máy; artifact (nhất là ảnh, nhiều phiên bản) có thể làm đầy database.

**Independent Test**: DB test: chính sách tắt loại `html` → tool và route tạo `html` bị từ chối `ARTIFACT_TYPE_DISABLED`;
dung lượng đếm đúng sau tạo/xoá hẳn; CSP của khung có đúng danh sách CDN của tổ chức.

**Acceptance Scenarios**:

1. **Given** chính sách tổ chức (jsonb `agent_policies.policy.artifacts`, mọi trường có `.default()`), **Then** đọc ở mọi lần
   tạo/sửa; đổi có hiệu lực ngay.
2. **Given** CDN cho phép, **Then** chỉ nhận origin `https://` không đường dẫn, không ký tự đại diện ngoài `*.` ở đầu; không
   bao giờ vào `connect-src`.
3. **Given** dung lượng tổ chức vượt 80%, **Then** quản trị tổ chức nhận thông báo `artifact.quota` một lần mỗi ngày.

### Edge Cases

- **Agent tạo artifact rồi không gọi `leader_reply`**: thẻ vẫn hiện; tin nhắn leader trống không sinh ra.
- **Agent gọi `artifact_create` liên tục trong vòng lặp**: giới hạn mỗi run (20 artifact, 100 phiên bản) chặn; run vẫn chạy
  tiếp, agent nhận lỗi.
- **Hai agent (hai run) sửa cùng artifact**: khoá lạc quan theo `baseVersion`; người thua nhận nội dung mới để gộp.
- **Người sửa tay trong khi agent đang sửa**: như trên; khung bên cạnh hiện "Leader vừa lưu v4" và nút so sánh với bản đang
  sửa.
- **Artifact gắn với cuộc trò chuyện của dự án, chủ rời đội**: artifact `private` vẫn của chủ (chủ không còn thấy cuộc trò
  chuyện dự án nhưng vẫn thấy artifact trong thư viện); artifact `project` giữ nguyên.
- **Cuộc trò chuyện bị xoá**: liên kết bị xoá theo; tin nhắn thẻ mất cùng cuộc trò chuyện; artifact còn.
- **Run bị huỷ hoặc thất bại**: artifact đã tạo vẫn giữ (có thể có ích); thẻ ghi "Từ run đã huỷ".
- **Nội dung có ký tự điều khiển, BOM, CRLF**: lưu nguyên; diff chuẩn hoá xuống dòng khi so.
- **HTML cố thoát khung** (`window.top`, `opener`, `document.domain`, service worker, `<meta http-equiv=refresh>` tới URL
  ngoài): bị sandbox + CSP chặn; test Playwright giữ danh sách ca thoát.
- **HTML rất nặng (vòng lặp vô hạn)**: chỉ treo tiến trình của khung; khung bên cạnh có nút "Dừng trang" (gỡ `iframe`).
  Trình duyệt có thể chạy khung cùng tiến trình với trang cha nếu cùng site [Suy luận: theo cách trình duyệt chia tiến trình
  theo site]; origin riêng (C7) giảm rủi ro này.
- **Vé khung hết hạn khi trang đang mở**: trang đang chạy không bị ảnh hưởng; tải lại khung xin vé mới.
- **Mermaid lỗi cú pháp**: hiện lỗi của Mermaid và nguồn; vẫn lưu được (agent sửa sau).
- **React import thư viện không có trong bộ đóng gói**: biên dịch báo `ARTIFACT_IMPORT_NOT_ALLOWED` "Thư viện x không có
  trong danh sách cho phép." (vẫn lưu phiên bản, đánh dấu lỗi).
- **Artifact `markdown` có ảnh `![](https://…)`**: trình đọc Markdown không tải ảnh ngoài (tránh rò IP/đọc trộm); hiện chữ
  thay thế và nút "Tải ảnh" một lần.
- **Bí mật nằm ở phiên bản cũ** (trước khi bật quét): chủ hoặc quản trị dùng "Xoá phiên bản" (chỉ khi phiên bản có cảnh báo
  bí mật hoặc theo yêu cầu quản trị tổ chức) — phiên bản bị thay bằng bia "Đã xoá vì chứa bí mật", số phiên bản giữ nguyên;
  ghi audit.
- **Tổ chức tắt artifact khi đã có dữ liệu**: không tạo/sửa mới; đọc vẫn được; tool MCP không hiện.
- **Khôi phục từ Thùng rác khi tổ chức đã hết dung lượng**: vẫn khôi phục (dung lượng tính cả thùng rác nên không tăng).
- **App desktop offline sửa artifact**: không hỗ trợ; nút sửa tắt (tránh xung đột không giải được).
- **Hub cũ, app mới**: app hỏi khả năng của hub (`system.info` có `artifacts: true`); không có thì ẩn menu Artifact.

## Requirements *(mandatory)*

### Functional Requirements

Đối tượng và lưu trữ (ART-01)

- **FR-001 (ART-01)**: Hub MUST lưu artifact là đối tượng riêng (module `artifacts`): id, tổ chức, tiêu đề (1–200 ký tự),
  loại (`markdown`, `code`, `html`, `react`, `svg`, `mermaid`, `csv`, `json`, `image`, `pdf`), ngôn ngữ (cho `code`), chủ,
  phạm vi (`private`, `project`, `team`, `org`, kèm đội/dự án), nguồn, phiên bản mới nhất, lúc tạo/sửa, xoá mềm.
- **FR-002 (ART-01)**: Nội dung chữ MUST nằm trong PostgreSQL; ảnh/PDF MUST nằm sau giao diện `BlobStore` (bản đầu: bảng
  `bytea` chia đoạn trong PostgreSQL) để đổi sang kho S3 không đổi API.
- **FR-003 (ART-01)**: Hub MUST áp giới hạn: cỡ mỗi phiên bản chữ, cỡ ảnh/PDF, số phiên bản mỗi artifact, số artifact và
  phiên bản mỗi run, dung lượng tổ chức — mặc định ở C10, chỉnh bằng chính sách tổ chức trong trần của biến môi trường.

Phiên bản (ART-02)

- **FR-004 (ART-02)**: Mỗi lần lưu nội dung MUST tạo một phiên bản bất biến, số tăng liên tục, ghi tác giả (người hoặc run,
  không bao giờ cả hai), nguồn, lời nhắn, cỡ, `sha256`; đổi tiêu đề/phạm vi không tạo phiên bản.
- **FR-005 (ART-02)**: Cập nhật MUST dùng khoá lạc quan `baseVersion`; lệch thì trả `ARTIFACT_VERSION_CONFLICT` kèm bản
  mới nhất. Thiếu `baseVersion` chỉ nhận khi người gọi là tác giả của bản mới nhất.
- **FR-006 (ART-02)**: Hub MUST cho xem danh sách phiên bản, đọc một phiên bản, so sánh hai phiên bản (diff dòng phía client
  bằng `line-diff` của contracts), đặt tên phiên bản, khôi phục (tạo phiên bản mới có `restoredFrom`).
- **FR-007 (ART-02)**: Chỉ có hai cách làm mất nội dung một phiên bản: xoá hẳn cả artifact (sau thùng rác) và "Xoá phiên
  bản" vì bí mật (thay bằng bia, có audit). Không route nào sửa phiên bản cũ.

Phạm vi và quyền (ART-03)

- **FR-020 (ART-03)**: Đọc MUST theo bảng: `private` — chỉ chủ; `project` — thành viên đội sở hữu dự án (mọi vai trò);
  `team` — thành viên đội; `org` — thành viên tổ chức. Quản trị tổ chức không đọc nội dung `private` của người khác (C5).
- **FR-021 (ART-03)**: Tạo phiên bản MUST cần: chủ, hoặc vai trò `member` trở lên trong phạm vi. Đổi tiêu đề như tạo phiên
  bản. Đổi phạm vi, chuyển chủ, xoá, khôi phục từ thùng rác, xoá phiên bản MUST cần chủ hoặc quản trị đội (phạm vi
  `project`/`team`) / quản trị tổ chức (phạm vi `org`).
- **FR-022 (ART-03)**: Không có phạm vi, link hay vé nào cho người ngoài tổ chức xem artifact.
- **FR-023 (ART-03)**: Mọi truy vấn MUST qua `withTenant()` (RLS theo tổ chức) và một bộ lọc quyền chung
  `artifacts/access.ts` (`visibleArtifactsWhere(reader)`) dùng ở mọi route, tool MCP, tìm kiếm, liên kết, thông báo.
- **FR-024 (ART-03)**: Phạm vi `team`/`org` (sau MVP) MUST có thể tắt bằng chính sách tổ chức.

MCP cho agent (ART-04)

- **FR-030 (ART-04)**: Cổng MCP MUST có `artifact_create`, `artifact_update`, `artifact_get`, `artifact_list` (US5-1), bật/tắt
  được từ trang MCP tools (MCP-04), ghi audit như mọi tool.
- **FR-031 (ART-04)**: Run `leader` MUST thấy bốn tool artifact cạnh `leader_reply`, `leader_propose`; run có task thấy chúng
  qua `RUN_TOOLS`; client người dùng (OAuth/PAT) thấy chúng.
- **FR-032 (ART-04)**: Quyền của run: tạo trong phạm vi `project` của dự án run (hoặc `private` của người mở cuộc trò chuyện
  với run `leader`, của người bấm với run có người chủ); sửa artifact run đó tạo, artifact liên kết với task/cuộc trò chuyện
  của run mà run đọc được; đọc artifact phạm vi dự án của dự án run và artifact liên kết với task/cuộc trò chuyện của run.
  Run không bao giờ đọc `private` của người không phải người mở cuộc trò chuyện/người bấm.
- **FR-033 (ART-04)**: `threadId` MUST thuộc run `leader` đang gọi (như `leader_reply`); `terminalSessionId` MUST thuộc
  principal (US8-2). Sai → `ARTIFACT_LINK_FORBIDDEN`.
- **FR-034 (ART-04)**: Prompt Leader và prompt run MUST có đoạn hướng dẫn dùng artifact (US5-7); prompt run có task MUST liệt
  kê artifact liên kết với task (id, tiêu đề, loại, phiên bản).

Leader chat (ART-05)

- **FR-040 (ART-05)**: Tạo/sửa artifact có `threadId` MUST thêm tin nhắn thẻ vào cuộc trò chuyện (tin nhắn có
  `artifact_id`, `artifact_version`), cập nhật `chat_threads.updated_at`, và liên kết `chat_thread`.
- **FR-041 (ART-05)**: Màn Leader (web và app) MUST hiện thẻ tham chiếu thay cho nội dung, khung bên cạnh có tab các artifact
  của cuộc trò chuyện, tự mở artifact mới (US1-2), mở toàn màn, danh sách artifact của cuộc trò chuyện.
- **FR-042 (ART-05)**: Khung bên cạnh MUST dùng được ở 360 px (ngăn kéo toàn màn) và ≥ 1024 px (chia đôi, kéo vạch chia),
  sáng/tối (NFR-11).
- **FR-043 (ART-05)**: App desktop MUST có màn Leader chat tối thiểu (C13) dùng component chung với web cho phần tin nhắn và
  khung bên cạnh.

Terminal Leader (ART-06)

- **FR-050 (ART-06)**: Màn Terminal Leader (LEADTERM) MUST có khung bên cạnh như Leader chat, hiện artifact liên kết với phiên.
- **FR-051 (ART-06)**: Cấu hình MCP và hướng dẫn mà LEADTERM cấp cho CLI MUST cho CLI biết `terminalSessionId` của phiên.

Hiển thị (ART-07)

- **FR-060 (ART-07)**: Mỗi loại MUST có trình xem: `markdown` (doc-editor chỉ đọc, bỏ HTML thô, không tải ảnh ngoài khi chưa
  bấm), `code` (tô màu, số dòng), `json` (cây), `csv` (bảng + biểu đồ), `html`/`react`/`svg`/`mermaid` (khung cách ly),
  `image` (thẻ `img` từ URL blob có vé), `pdf` (trong khung cách ly).
- **FR-061 (ART-07)**: Artifact `react` MUST được biên dịch trên hub khi lưu phiên bản (JSX/TSX → ESM), chỉ import thư viện
  trong bộ đóng gói; lỗi biên dịch lưu cùng phiên bản và trả cho người gọi.

Khung cách ly (ART-08)

- **FR-070 (ART-08)**: Nội dung chạy được (HTML, React, SVG, Mermaid, PDF, biểu đồ CSV) MUST chỉ chạy trong `iframe`
  `sandbox="allow-scripts"` không có `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms`,
  `allow-modals`, nạp từ route khung với CSP ở US3-3 (có chỉ thị `sandbox`), không bao giờ bằng `srcdoc` hay
  `dangerouslySetInnerHTML` trong origin của hub/app.
- **FR-071 (ART-08)**: Route khung MUST nhận vé ngắn hạn (≤ 5 phút, HMAC bằng khoá của hub, gắn tổ chức, artifact, phiên bản
  hoặc bản xem trước), không đọc cookie phiên, trả `Cache-Control: private, no-store` cho bản xem trước và
  `private, max-age=300` cho phiên bản, `Cross-Origin-Resource-Policy: same-site`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`.
- **FR-072 (ART-08)**: Hub MUST phục vụ bộ thư viện đóng gói (có ghim phiên bản, có SRI trong import map) từ origin của khung;
  CDN ngoài chỉ khi chính sách tổ chức cho (C8).
- **FR-073 (ART-08)**: Khi có `HIVE_ARTIFACT_ORIGIN`, hub MUST tạo URL khung trên origin đó và từ chối phục vụ khung trên origin
  của hub.
- **FR-074 (ART-08)**: Trang cha MUST chỉ nhận `postMessage` từ `contentWindow` của chính khung đó, chỉ các loại tin `resize`
  (số), `error` (chữ ≤ 2 000 ký tự, hiện bằng text), `ready`; bỏ mọi tin khác.

Thư viện (ART-09)

- **FR-080 (ART-09)**: Web và app MUST có thư viện artifact (US7) có lọc, tìm (tiêu đề và nội dung bản mới nhất, `tsvector`
  cấu hình `simple`), phân trang con trỏ, trang chi tiết, nhân bản, đổi tên, chia sẻ, xoá mềm, thùng rác 30 ngày.
- **FR-081 (ART-09)**: Job pg-boss MUST xoá hẳn artifact quá 30 ngày trong thùng rác (cả phiên bản, blob, liên kết).

App desktop (ART-10)

- **FR-090 (ART-10)**: App MUST dùng `@xdev-hive/artifacts-ui` cho khung bên cạnh, trình xem, phiên bản, thư viện; từ điển
  vi/en.
- **FR-091 (ART-10)**: App MUST đệm phiên bản đã mở (giới hạn 200 MiB, LRU) theo hồ sơ và tổ chức, đọc offline, xoá khi đăng
  xuất/đổi tổ chức, bỏ bản mất quyền khi có mạng lại.
- **FR-092 (ART-10)**: App MUST phục vụ khung cách ly qua giao thức `hive-artifact://` với cùng CSP và bộ thư viện đóng gói
  trong app.

Liên kết (ART-11)

- **FR-100 (ART-11)**: Hub MUST lưu liên kết artifact ↔ `chat_thread`, `terminal_session`, `run`, `task`, `sdlc_item`, `doc`;
  gắn/bỏ gắn cần đọc được artifact và quyền sửa đích; gắn vào đích dùng chung đòi phạm vi đủ rộng (US10-1).
- **FR-101 (ART-11)**: Trang task, run, dự án, hạng mục AI SDLC, tài liệu MUST hiện artifact liên kết (người xem chỉ thấy
  artifact mình đọc được).

Chuyển đổi (ART-12)

- **FR-110 (ART-12)**: "Chuyển thành tài liệu" MUST tạo đề xuất `knowledge` (chỉ `markdown`), không tạo tài liệu trực tiếp.
- **FR-111 (ART-12)**: "Lưu vào repo" MUST mở PR qua `GitProvider` với kiểm đường dẫn như spec 011 FR-003.

Bảo mật, audit, chính sách (ART-13)

- **FR-120 (ART-13)**: Mọi lần lưu nội dung chữ MUST qua bộ quét bí mật dùng chung (`packages/contracts/src/secret-scan.ts`,
  cùng mẫu với worker); `block` (mặc định) hoặc `redact` theo chính sách.
- **FR-121 (ART-13)**: Audit MUST ghi: tạo, phiên bản mới (tác giả, nguồn, cỡ — không ghi nội dung), đổi tiêu đề, đổi phạm vi,
  chuyển chủ, xoá, khôi phục, xoá phiên bản, gắn/bỏ gắn, chuyển thành tài liệu, lưu vào repo.
- **FR-122 (ART-13)**: Chính sách tổ chức `agent_policies.policy.artifacts` MUST có: `enabled`, `types`, `maxVersionBytes`,
  `maxBlobBytes`, `maxVersions`, `runLimits`, `orgQuotaBytes`, `cdnAllow`, `secretScan` (`block`|`redact`), `scopes`; mọi
  trường có `.default()`.
- **FR-123 (ART-13)**: Hub MUST báo quản trị tổ chức khi dung lượng vượt 80% (thông báo `artifact.quota`, tối đa một lần mỗi
  ngày) và từ chối tạo/sửa khi vượt 100%.

Tạo và sửa tay (ART-14)

- **FR-130 (ART-14)**: Người dùng MUST tạo và sửa artifact trên web và app: `markdown` bằng doc-editor (Tiptap, ẩn tính năng
  duyệt), loại chữ khác bằng ô soạn code có tô màu và xem trước trong khung cách ly; ảnh/PDF bằng tải lên (sau MVP).

### Key Entities

- **Artifact** (`artifacts`): `org_id`, `team_id`, `project_id`, `scope`, `owner_user_id`, `title`, `type`, `language`,
  `origin`, `latest_version`, `size_bytes` (tổng các phiên bản, để tính dung lượng), `search` (tsvector của tiêu đề + nội
  dung bản mới nhất), `deleted_at`, `deleted_by`, lúc tạo/sửa.
- **Phiên bản** (`artifact_versions`): `artifact_id`, `version`, `content` (chữ, null với blob), `blob_id`, `compiled` (bản
  biên dịch của `react`), `compile_error`, `sha256`, `size_bytes`, `author_user_id` | `author_run_id`, `origin`,
  `message`, `name`, `restored_from`, `tombstoned_at` (xoá vì bí mật), lúc tạo.
- **Liên kết** (`artifact_links`): `artifact_id`, `target_kind` (`chat_thread`, `terminal_session`, `run`, `task`,
  `sdlc_item`, `doc`), `target_id`, `created_by` người | run, lúc tạo.
- **Tin nhắn thẻ**: `chat_messages` thêm `artifact_id`, `artifact_version` (module `leader`).
- **Blob** (`artifact_blobs`, sau MVP): `id`, `media_type`, `size_bytes`, `sha256`, các đoạn `bytea` (`artifact_blob_chunks`).
- **Chính sách**: mục `artifacts` trong `agent_policies.policy` (governance, jsonb).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 lần nội dung artifact chạy script trong origin của hub hoặc của app: test Playwright và test desktop với bộ
  ca thoát (đọc cookie, `fetch` hub, `fetch` ngoài, `top.location`, `parent.document`, `window.open`, form, ảnh beacon,
  `<meta refresh>`, service worker) đều bị chặn.
- **SC-002**: 0 lần lộ artifact ra ngoài phạm vi: test DB ba người × bốn phạm vi × mọi route `artifacts.*`, tool MCP, tìm
  kiếm, liên kết; tổ chức khác thấy 0 dòng (RLS, `rls.db.test.ts`).
- **SC-003**: Agent trong Leader chat tạo artifact → thẻ hiện và khung bên cạnh mở trên web trong ≤ 3 giây sau khi tool trả
  kết quả (p95, Playwright với hub giả đo thời gian thăm dò).
- **SC-004**: Mở artifact chữ 1 MiB trong khung bên cạnh ≤ 1 giây (p95) từ khi bấm thẻ, trên máy chủ 34 với mạng nội bộ.
- **SC-005**: Thư viện 10 000 artifact của tổ chức: trang đầu ≤ 300 ms, tìm kiếm ≤ 500 ms (p95, test DB dữ liệu mẫu).
- **SC-006**: 100% lần lưu có chuỗi bí mật mẫu (bộ fixture ≥ 15 mẫu) bị chặn hoặc che theo chính sách; 0 bí mật trong audit
  hoặc thông báo lỗi.
- **SC-007**: 100% lần tạo/sửa có dòng audit; không dòng audit nào chứa nội dung artifact.
- **SC-008**: Kịch bản MVP (Leader tạo markdown + mermaid + html → sửa → so sánh → khôi phục → chia sẻ dự án → đồng nghiệp
  mở) làm được hoàn toàn trên web và hoàn toàn trong app desktop (Playwright + test desktop).
- **SC-009**: App desktop mở được ≥ 1 artifact `html` đã tải khi hub tắt (test desktop với hub giả tắt sau khi tải).
- **SC-010**: Các test hiện có của leader, MCP, knowledge xanh không sửa ngoài phần đã nêu trong tasks (danh sách tool của run
  `leader`, tin nhắn có thẻ).
- **SC-011**: Mọi màn mới dùng được ở 360 px không cuộn ngang, sáng và tối (NFR-11).

## Out of Scope

- Chia sẻ công khai ra ngoài tổ chức (link công khai, nhúng vào trang khác).
- Sửa đồng thời thời gian thực (CRDT) một artifact; giữ khoá lạc quan.
- Trang tương tác gọi mạng (API ngoài, API hub) hay lưu dữ liệu bền (kiểu "persistent storage" của Claude); trang gọi AI
  (Claude trong artifact).
- Bình luận trên artifact (dùng cuộc trò chuyện); duyệt artifact (dùng "Chuyển thành tài liệu").
- Chạy code Python/Node phía hub hay worker để sinh artifact (agent tự chạy trên máy của run rồi gửi kết quả).
- Kho blob S3 (chỉ giao diện `BlobStore` sẵn sàng); chuyển log run sang blob.
- Đồng bộ artifact hai chiều với file trong repo (chỉ "Lưu vào repo" một chiều qua PR).
- Nhập artifact từ claude.ai (tải lên thủ công thì được qua "Artifact mới").
- Sửa artifact khi app desktop offline.

## Assumptions

- LEADTERM (Terminal Leader trên web) có khái niệm **phiên** có id, chủ là một người, và cấp MCP của hub cho CLI bằng một
  principal của chủ; nếu khác, US8 cập nhật theo thiết kế LEADTERM.
- Tiptap vào `@xdev-hive/doc-editor` qua PR #204; trước khi có, trình xem/soạn Markdown dùng editor Markdown hiện có của
  doc-editor.
- `knowledge` giữ API đề xuất (`createProposal`) cho "Chuyển thành tài liệu"; `GitProvider.commitFiles`/`openPR` như spec
  006/011 cho "Lưu vào repo".
- Hub chạy một container + PostgreSQL (NFR-14); artifact không thêm dịch vụ. Dung lượng mặc định (C10) giả định máy chủ có
  ≥ 20 GiB đĩa cho database [Suy luận: chưa đo máy chủ 34].
- Bộ thư viện đóng gói thêm khoảng vài MiB vào image hub và app [Suy luận: chưa đo; React, Recharts, d3, Mermaid bản ESM].
- Trình duyệt hỗ trợ import map và `iframe sandbox` (Chrome, Edge, Firefox, Safari bản hiện hành).
