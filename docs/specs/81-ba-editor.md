# 81. ba-editor: trình soạn tài liệu cho BA/SA

Hỏi 11/10: "về phần editor ở máy, có cách nào soạn 1 editor chuyên cho anh em BA, SA vào soạn tài liệu không? hiện tại đang hơi khó". Khó ở: không có mẫu tài liệu; vẽ sơ đồ khó; cùng soạn, góp ý, duyệt; nhập/xuất Word, PDF. Người dùng chọn: nghiên cứu trước rồi quyết.

**Trạng thái: bản nháp, chờ người dùng chọn hướng (mục 3).** Chỉ tài liệu, chưa sửa code.

Đọc code nhánh `ai/RES-ba-editor` (base `4cc64a8f`) ngày 11/10. Không có truy cập web trong lượt này, nên mọi nhận định về Confluence, Notion, Google Docs, Outline, Docmost và giấy phép thư viện ngoài đều là [Chưa kiểm]: viết từ kiến thức có sẵn, cần đối chiếu trang chính thức trước khi chọn thư viện.

## 1. Hiện trạng trong repo

| Phần | Có gì | Nơi |
|---|---|---|
| Trình soạn | Tiptap 3 (StarterKit, bảng, task list, ảnh, link trang), thanh công cụ, bubble menu, kéo thả khối, menu `/` | `packages/ui/src/components/RichEditor.tsx` |
| Sơ đồ | Khối code ngôn ngữ `mermaid` (mẫu có sẵn, xem trước trực tiếp bằng `mermaid` 12). Không có kéo thả | `RichEditor.tsx` (slash `mermaid`, node view của code block) |
| Mô hình tài liệu | Tiptap đọc và ghi cùng Markdown mà agent đọc; `richSafe` kiểm vòng đi-về không mất chữ, trang có frontmatter hoặc HTML thô chỉ sửa ở chế độ Markdown | `packages/ui/src/lib/editor/markdown.ts` |
| Trang Tài liệu | Chế độ xem / soạn / Markdown / trợ lý; bản nháp lưu ở máy; quản lý lưu phiên bản mới, người đóng góp gửi đề xuất; so sánh phiên bản; cảnh báo nháp cũ (`baseVersion`) | `packages/ui/src/pages/Docs.tsx` |
| Đề xuất / duyệt | `proposals.create/approve/reject`, kiểm `baseVersion`, duyệt hàng loạt mỗi trang một đề xuất. Chưa có *Yêu cầu sửa*, *Rút*, người duyệt theo đường dẫn, nhật ký duyệt (76e chưa xong) | `packages/core/src/methods.ts`, `DocTable.tsx` |
| Ảnh đính kèm | `docs.assets`, `docs.assetPut/Get/Remove`, trần `DOC_ASSET_MAX_BYTES` | `DocAssets.tsx` |
| Lịch sử | `docs.history`, `docs.restore` | `methods.ts` |
| Xuất / nhập | **Không có** Word, PDF, `.docx`. Không có `mammoth`, `docx`, `printToPDF` trong repo | grep |
| Cùng soạn thời gian thực | `package.json` của `packages/ui` khai `yjs`, `@tiptap/y-tiptap`, `@tiptap/extension-collaboration` nhưng **không file nào import** (đã grep). Chưa có máy chủ đồng bộ | `packages/ui/package.json` |
| Góp ý theo đoạn | Không có | |
| Mẫu tài liệu | Không có (trang mới trống, hoặc nhờ trợ lý) | |

Kết luận hiện trạng: nền (Tiptap + Markdown + phiên bản + đề xuất) đủ để thêm tính năng không phải đập đi. Thiếu bốn thứ người dùng nêu: mẫu, vẽ sơ đồ trực quan, góp ý/duyệt theo mục, nhập/xuất Word và PDF.

## 2. So sánh cách các công cụ phục vụ BA/SA

Toàn bộ bảng này là [Chưa kiểm]: từ kiến thức có sẵn, chưa đối chiếu trang chính thức lượt này. Cột "Mức" là đánh giá của người viết [Suy luận], không phải số đo.

| Nhu cầu | Confluence | Notion | Google Docs | Outline | Docmost |
|---|---|---|---|---|---|
| Mẫu (SRS, BRD, use case, user story, đặc tả API, ADR) | Thư viện mẫu, mẫu của site, macro; có mẫu yêu cầu sản phẩm | Mẫu trang và database mẫu | Thư viện mẫu hạn chế, chủ yếu mẫu hành chính | Mẫu trang, [Chưa kiểm] mức độ | [Chưa kiểm] |
| Sơ đồ | draw.io tích hợp (Atlassian), Mermaid qua app | Khối Mermaid, nhúng Figma/Miro | Google Drawings, add-on | Mermaid, nhúng | draw.io và Excalidraw nhúng [Chưa kiểm], Mermaid |
| Góp ý theo đoạn | Có, giải quyết/mở lại | Có | Có, mạnh nhất, kèm gợi ý sửa | Có | Có [Chưa kiểm] |
| Giao sửa, chế độ gợi ý | Không có chế độ tracked change gốc [Chưa kiểm] | Không | **Suggesting mode** | Không | Không [Chưa kiểm] |
| Duyệt | Quy trình duyệt trang (gói trả phí / app) | Xác minh trang (gói trả phí) | Phê duyệt tài liệu (gói Workspace) | Không có quy trình duyệt gốc [Chưa kiểm] | Không [Chưa kiểm] |
| Lịch sử | Có, so sánh | Có | Có, mạnh | Có | Có |
| Nhập/xuất Word | Xuất Word, PDF; nhập Word | Xuất PDF, Markdown; nhập Word hạn chế | Gốc | Xuất Markdown/PDF/Word qua [Chưa kiểm] | Xuất Markdown/HTML, [Chưa kiểm] |
| Cùng soạn | Có | Có | Có | Có | Có |

Điều rút ra [Suy luận]:

- Không công cụ nào trong nhóm vừa có *mẫu BA sẵn*, vừa có *duyệt theo mục*, vừa *giữ tài liệu là văn bản thuần agent đọc được*. Điểm khác của Hive: tài liệu là Markdown cho agent đọc và đã có đề xuất/duyệt. Đừng bắt chước Google Docs (tài liệu nhị phân/cấu trúc riêng).
- Góp ý theo đoạn và chế độ gợi ý là chỗ BA/SA quen nhất ở Google Docs/Confluence. Hive làm được tương đương bằng *đề xuất theo mục* (đã có hạ tầng) cộng bảng góp ý riêng.
- Sơ đồ: BA quen draw.io/Visio; SA quen Mermaid/PlantUML. Hive đã có Mermaid, nên bước kế là soạn Mermaid dễ hơn (mẫu, xem trước tách đôi) chứ chưa cần bảng vẽ tự do.

### 2.1 Thư viện mã nguồn mở và giấy phép

Mọi dòng giấy phép là [Chưa kiểm] (từ trí nhớ; kiểm lại `LICENSE` của đúng phiên bản trước khi thêm vào `package.json`). Repo này là public.

| Việc | Ứng viên | Giấy phép [Chưa kiểm] | Ghi chú |
|---|---|---|---|
| Nhập .docx | `mammoth` | BSD-2-Clause | .docx → HTML sạch (đề mục, bảng, ảnh, danh sách); bỏ định dạng phức tạp. Chạy trong trình duyệt được |
| Xuất .docx | `docx` (dolanmiu) | MIT | Dựng .docx từ JSON Tiptap tự viết bộ chuyển; chạy trình duyệt và Node |
| Xuất .docx (cách khác) | `html-to-docx` | MIT [Chưa kiểm] | Từ HTML; kém kiểm soát kiểu hơn |
| Xuất PDF desktop | `webContents.printToPDF` của Electron | MIT (Electron) | Không thêm thư viện; dùng stylesheet in |
| Xuất PDF web | `window.print()` + `@media print` | n/a | Không giữ được mọi thứ; chấp nhận cho bản đầu |
| Xuất PDF phía hub | Puppeteer/Playwright | Apache-2.0 | Nặng; hub chạy Docker, thêm Chromium vào image: không đề xuất |
| Sơ đồ chữ | `mermaid` (đã dùng) | MIT | Đổi SVG → PNG để nhúng vào .docx/PDF |
| Bảng vẽ tự do | Excalidraw (`@excalidraw/excalidraw`) | MIT | Kết quả JSON + SVG; hợp để vẽ phác |
| Bảng vẽ tự do (khác) | tldraw | giấy phép riêng, có điều khoản thương mại/hình mờ | [Chưa kiểm] kỹ; tránh nếu chưa đọc kỹ giấy phép |
| draw.io | diagrams.net / `drawio` embed | Apache-2.0 (mã nguồn); bản nhúng thường gọi dịch vụ ngoài | Hub chỉ nằm trong LAN: bản nhúng cần máy chủ tự dựng, nặng. Không chọn ở bản đầu |
| Góp ý theo đoạn | Tiptap Comments | extension thương mại (gói trả phí) [Chưa kiểm] | Không dùng; tự làm bằng mark + bảng riêng |
| Cùng soạn | `yjs` + Hocuspocus (máy chủ) | MIT [Chưa kiểm] | `yjs` đã khai trong `package.json` nhưng chưa dùng |
| Trình soạn có sẵn | BlockNote | MPL-2.0, gói `xl-*` GPL/thương mại [Chưa kiểm] | Không đổi trình soạn: Tiptap đã chạy với Markdown |
| Wiki nguyên khối để tham khảo | Outline, Docmost | BSL 1.1 / AGPL-3.0 [Chưa kiểm] | Chỉ đọc ý tưởng, **không chép mã** (giấy phép không tương thích repo) |

## 3. Hai hướng

### Hướng A: Khu soạn riêng toàn màn hình cho BA/SA ("Studio")

Một route riêng (`/studio/<key>`) mở trình soạn toàn màn hình: cột trái là đề cương (đề mục) + danh sách mục bắt buộc của mẫu, giữa là trang, phải là góp ý/đề xuất/lịch sử.

```
+--------------------------------------------------------------------------------+
| ← Tài liệu  SRS – Cổng thanh toán   v7 · nháp   [Mẫu ▾] [Xuất ▾] [Gửi duyệt]  |
+--------------+--------------------------------------------+--------------------+
| ĐỀ CƯƠNG     |  # 1. Mục tiêu                             | GÓP Ý (3)          |
| ✔ 1 Mục tiêu |  Hệ thống cho phép...                      | ▸ Lan: "Thiếu SLA" |
| ✔ 2 Phạm vi  |  [💬 2]                                    |   [Trả lời][Xong]  |
| ◻ 3 Use case |                                            |--------------------|
| ◻ 4 NFR      |  ## 3. Use case UC-01                      | ĐỀ XUẤT (1)        |
| ◻ 5 Rủi ro   |  ```mermaid  sequenceDiagram ...           | ▸ Mục 3 · Minh     |
|              |  ┌───────── xem trước ─────────┐           |   [Duyệt][Yêu cầu  |
| MẪU          |  │  A ──► B ──► C              │           |   sửa]             |
| + Use case   |  └─────────────────────────────┘           | LỊCH SỬ  v6 v5 ... |
+--------------+--------------------------------------------+--------------------+
```

- Ưu: bố cục đúng việc của BA (đề cương, mục bắt buộc, góp ý bên cạnh), không phải chen vào trang Tài liệu vốn đã dày (1500+ dòng `Docs.tsx`).
- Nhược: hai chỗ sửa một tài liệu (Tài liệu và Studio), dễ lệch tính năng; thêm route, thêm bước e2e (web, mobile, desktop smoke); người dùng phải học chỗ mới.

### Hướng B: Nâng cấp trang Tài liệu (khuyến nghị)

Giữ một trình soạn. Thêm vào trang hiện có: *Tạo từ mẫu* khi tạo trang, menu `/` thêm khối BA (use case, yêu cầu, bảng truy vết, sơ đồ mẫu), ngăn góp ý bên phải (mở/đóng), nhãn đề xuất theo mục, nút *Xuất* và *Nhập .docx*. Chế độ *toàn màn hình* (ẩn thanh bên) là một công tắc, không phải một route.

```
+---------------------------------------------------------------------+
| Tài liệu / spec / SRS-thanh-toan     v7  [Xem|Soạn|Markdown] [⤢] [⋯]|
+----------+------------------------------------------+---------------+
| CÂY TRANG|  [B I H1 H2 ▦ ⬚ 🖼 ◇ sơ đồ] [Mẫu ▾]      | Góp ý | Đề xuất|
| spec/    |  # 1. Mục tiêu                       💬2 | ▸ Lan ...      |
|  SRS-... |  ...                                     |               |
|  ADR-01  |  ## 3. Use case                          |               |
+----------+------------------------------------------+---------------+
| [⤓ Xuất ▾ Word | PDF | Markdown]    [⤒ Nhập .docx]                   |
+---------------------------------------------------------------------+
```

- Ưu: một nơi, không nhân đôi mã; dùng ngay phân quyền, phiên bản, đề xuất, tìm kiếm, liên kết trang đã có; tách được từng bước nhỏ (81a…81i) mỗi bước phát hành được.
- Nhược: `Docs.tsx` đã lớn, cần tách file trước (xem rủi ro); ít "cảm giác công cụ riêng cho BA" hơn.

### 3.1 Khuyến nghị

[Suy luận] Chọn **Hướng B**, làm theo thứ tự 81a→81i. Nếu sau 81a–81e người dùng vẫn thấy chật, thêm **81h (toàn màn hình + đề cương)** là vỏ của Hướng A trên cùng trình soạn, không viết trình soạn thứ hai. Đây là chỗ người dùng cần quyết: *B từ đầu, hay A ngay*.

### 3.2 Ảnh hưởng tới lưu Markdown và đề xuất/duyệt

Nguyên tắc: **tài liệu vẫn là Markdown thuần**; agent đọc không cần biết có Studio.

- **Mẫu:** nội dung mẫu là Markdown. Metadata mẫu (tên, loại, mục bắt buộc) **không** nằm trong frontmatter vì trang có frontmatter bị `richEditable` ép sang chế độ Markdown. Lưu mẫu của hệ thống trong mã (`packages/core`), mẫu riêng dự án là trang dưới thư mục `templates/` của dự án; mục bắt buộc suy ra từ đề mục `##` của mẫu.
- **Sơ đồ:** Mermaid giữ là khối code (agent đọc được chữ). Bản vẽ Excalidraw lưu `.excalidraw.json` + `.svg` bằng `docs.assetPut`, trong Markdown là `![mô tả](asset)`; **bắt buộc có mô tả** để agent hiểu. Lõi `richSafe` không đổi.
- **Góp ý:** không ghi vào Markdown. Bảng riêng `doc_comments` (id, docKey, version, neo, trạng thái, người, nội dung, trả lời). Neo = đường đề mục + đoạn trích (quote) + vị trí tương đối, tránh dùng mark trong nội dung. Khi trang đổi, neo khớp lại bằng đoạn trích; không khớp thì chuyển *mồ côi* (vẫn hiện, gắn với phiên bản cũ).
- **Đề xuất theo mục:** đề xuất vẫn là *một bản nội dung đầy đủ* + `baseVersion` như hiện nay. Mục chỉ là cách hiển thị: so sánh theo đề mục, nhóm khác biệt theo `##`, cho duyệt/yêu cầu sửa từng nhóm. Duyệt từng nhóm = hub áp các nhóm được chọn lên bản gốc rồi lưu một phiên bản (không đụng `baseVersion`). Phụ thuộc 76e (*Yêu cầu sửa*, *Rút*, người duyệt theo đường dẫn, nhật ký); không làm lại ở đây.
- **Cùng soạn thời gian thực:** nếu làm (81i), trạng thái Yjs chỉ là bộ đệm; lưu vẫn là Markdown qua `docs.save`/đề xuất để lịch sử, agent và `baseVersion` không đổi.
- **Hai người cùng sửa khác nhau:** giữ nguyên cách hiện tại (nháp ở máy, cảnh báo nháp cũ, đề xuất kiểm `baseVersion`).

### 3.3 Chạy cả desktop và web

Mọi tính năng ở `packages/ui` (dùng chung hai vỏ). Chỗ khác nhau:

- PDF: desktop dùng `printToPDF` qua IPC; web dùng `window.print()`; có hợp đồng một hàm `exportDoc(format)` để giao diện không biết khác biệt.
- Nhập/xuất .docx và Excalidraw chạy trong renderer, không cần hub; chỉ lưu tài nguyên qua `docs.assetPut` như ảnh hiện có.
- Góp ý lưu ở hub (phương thức mới trong `methods.ts`, cần vai trò xem/ghi tương ứng, đi qua bảng quyền 76b).
- Mobile (<768px): ngăn góp ý thành tờ trượt (sheet), không cố hỗ trợ vẽ Excalidraw (chỉ xem ảnh SVG).

## 4. Lộ trình (81a… theo ưu tiên)

Quy ước tiêu chí "xong": có test (vitest ở package tương ứng), `npm run typecheck` + `npm test` xanh, đổi giao diện thì chạy e2e web, e2e mobile, smoke desktop (`AGENTS.md`), chữ thêm vào `packages/ui-kit/src/i18n/locales/vi.ts` và `en.ts`.

### 81a. templates (P0)
Mẫu SRS, BRD, use case, user story, đặc tả API, ADR (tiếng Việt, mỗi mẫu có đề mục và câu hướng dẫn), chọn khi tạo trang và chèn bằng `/mẫu`; mẫu riêng dự án trong `templates/`.
**Xong khi:** (1) tạo trang mới có nút *Từ mẫu*, 6 mẫu có sẵn; (2) trang tạo từ mẫu qua `richSafe` (vào-ra Markdown không mất chữ) với cả 6 mẫu, có test; (3) trang dưới `templates/` của dự án hiện trong danh sách mẫu; (4) vi và en đủ.

### 81b. export-pdf-md (P0)
Xuất PDF và Markdown với stylesheet in (đề mục, bảng, mã, Mermaid đã vẽ, ảnh), ngắt trang trước đề mục cấp 1.
**Xong khi:** (1) desktop xuất PDF bằng `printToPDF`, web in bằng `window.print()`; (2) khối Mermaid và ảnh có trong PDF; (3) bảng không bị cắt ngang chữ; (4) e2e web kiểm nút *Xuất* mở hộp in (có thể giả `window.print`).

### 81c. export-docx (P0)
Xuất .docx từ JSON Tiptap bằng thư viện `docx`: đề mục, đoạn, danh sách, bảng, mã, ảnh, Mermaid → PNG; kiểu đề mục Word thật (Heading 1–3) để mục lục Word chạy.
**Xong khi:** (1) bản .docx mở được bằng Word hoặc LibreOffice [Chưa kiểm trên Word: cần người mở thử]; (2) đề mục là kiểu Heading của Word; (3) test đọc lại .docx bằng `mammoth` và so cấu trúc (đề mục, số hàng bảng) khớp bản gốc; (4) giấy phép `docx` đã đối chiếu `LICENSE`.

### 81d. import-docx (P1)
Nhập .docx bằng `mammoth` → HTML → Tiptap → Markdown; ảnh trong .docx lưu bằng `docs.assetPut`; báo phần không giữ được (hộp văn bản, theo dõi thay đổi).
**Xong khi:** (1) kéo thả hoặc chọn .docx thành trang mới hoặc nội dung nháp của trang đang mở (không ghi đè khi chưa xác nhận); (2) đề mục, danh sách, bảng, ảnh giữ được trên 3 tệp mẫu (một tệp tiếng Việt có dấu); (3) có danh sách cảnh báo hiện cho người dùng; (4) kết quả qua `richSafe`.

### 81e. comments (P1)
Góp ý theo đoạn: chọn chữ → *Góp ý*, trả lời, *Xong/Mở lại*, ngăn bên phải; bảng `doc_comments`, phương thức mới, quyền; neo khớp lại khi trang đổi.
**Xong khi:** (1) tạo/trả lời/xong/mở lại, lưu ở hub; (2) trang sửa thì neo vẫn đúng hoặc chuyển *mồ côi* có nhãn, có test cho 4 ca (chèn trước, sửa trong đoạn, xoá đoạn, đổi tên đề mục); (3) Markdown của trang **không** đổi khi thêm góp ý; (4) người chỉ xem không thêm được góp ý nếu vai trò không cho (test quyền); (5) mobile: sheet.

### 81f. section-review (P1, sau 76e)
Đề xuất hiển thị theo đề mục, duyệt hoặc yêu cầu sửa từng mục, áp một phần.
**Xong khi:** (1) trang đề xuất nhóm khác biệt theo `##`; (2) duyệt một phần lưu đúng một phiên bản mới có nhật ký nói mục nào được áp; (3) vẫn kiểm `baseVersion`; (4) test: 2 mục, duyệt 1, từ chối 1.

### 81g. diagram-assist (P1)
Sơ đồ Mermaid dễ soạn: thư viện mẫu (flowchart, sequence, ERD, state, C4, use case), chế độ tách đôi mã | xem trước, báo lỗi cú pháp dòng nào, xuất SVG/PNG, nút *Nhờ trợ lý vẽ* (dùng `docs.assist`).
**Xong khi:** (1) `/sơ đồ` có ≥ 6 mẫu; (2) lỗi cú pháp hiện số dòng, không làm trắng trang; (3) nút sao chép PNG/SVG; (4) kiểm nơi `mermaid` đã nạp lười (không tăng chunk đầu, xem 77h).

### 81h. ba-fullscreen (P2, vỏ của Hướng A)
Chế độ toàn màn hình: ẩn thanh bên, đề cương trái (đề mục + mục bắt buộc của mẫu đã đủ chưa), ngăn góp ý/đề xuất phải.
**Xong khi:** (1) công tắc ⤢ không đổi dữ liệu; (2) đề cương cuộn tới đề mục; (3) mục bắt buộc thiếu có dấu ◻ (không chặn lưu); (4) e2e web, mobile, smoke desktop có bước mới.

### 81i. excalidraw (P2)
Khối bản vẽ Excalidraw: sửa trong hộp thoại, lưu JSON + SVG bằng `docs.assetPut`, trong Markdown là ảnh có mô tả bắt buộc.
**Xong khi:** (1) tạo, sửa lại, xoá bản vẽ; (2) Markdown chỉ chứa `![mô tả](asset)`; (3) nạp lười, không vào chunk đầu; (4) mobile chỉ xem.

### 81j. realtime (P3, cần quyết riêng)
Cùng soạn thời gian thực bằng Yjs + Hocuspocus trên hub. Hub chạy Docker trong LAN, phải đi qua tunnel hiện có [Chưa kiểm] WebSocket qua tunnel. Chưa làm cho tới khi 81a–81f dùng thật và người dùng còn cần.
**Xong khi:** thử nghiệm 2 người cùng một trang, lưu vẫn ra Markdown + phiên bản; quyết định ghi lại bằng `doc_propose` vào `docs/decisions.md`.

## 5. Rủi ro và việc cần quyết

1. **Chọn hướng** (A hay B): khuyến nghị B (mục 3.1).
2. **Kích thước `Docs.tsx`** (hơn 1500 dòng): tách trước 81e/81f; nếu không, thêm tính năng sẽ khó kiểm.
3. **Giấy phép**: mọi dòng ở mục 2.1 là [Chưa kiểm]; đọc `LICENSE` thật trước khi thêm phụ thuộc. Tránh mã nguồn Outline/Docmost (BSL/AGPL).
4. **Bó chặt vào Markdown**: bảng lồng, ô gộp, màu chữ, số trang, chú thích cuối trang của Word không có trong Markdown; nhập .docx sẽ mất, xuất .docx không phục hồi được. Cần nói rõ với BA, 81d có danh sách cảnh báo.
5. **Đáng tin cậy của xuất .docx**: chưa mở thử trên Word thật; cần người thử trước khi đánh dấu xong 81c.
6. **Hiệu năng**: `mermaid`, `mammoth`, `docx`, Excalidraw đều lớn; nạp lười theo mục 77h, không vào chunk đầu.
7. **Góp ý và quyền**: phương thức mới phải vào bảng quyền (76b) và hạn chế người chỉ xem; không lộ góp ý của tài liệu mà người dùng không đọc được.
8. **Cùng soạn**: `yjs` đã nằm trong `package.json` mà chưa dùng; cân nhắc gỡ nếu 81j không làm (để dọn phụ thuộc).
