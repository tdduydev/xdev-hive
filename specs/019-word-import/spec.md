# Feature Specification: Nhập Word thành tài liệu hub

**Feature Branch**: `019-word-import`

**Created**: 2026-10-16

**Status**: Draft. Chủ dự án đã chốt Q1–Q15 ngày 2026-10-17.

**Input**: Chủ dự án chốt ngày 2026-10-16:
- BA tải file `.docx` lên hub. Hub tạo tài liệu Markdown kèm ảnh, bảng sửa được trong editor.
- Viết spec và kế hoạch trước, chưa code.

Bối cảnh:
- Tài liệu SRS của acme nằm trên SharePoint: 270 file Word, cùng một mẫu của FIS.
- Script `tools/srs2md` (Python + pandoc) trong repo `acme-ai/docs` đã chuyển thử cả 261 tài liệu, nhưng cần máy có
  Python và pandoc.
- BA có thể còn viết Word một thời gian. Spec này đưa việc chuyển vào hub để BA tự làm trên trình duyệt.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md)

## Câu hỏi đã chốt

Chủ dự án trả lời ngày 2026-10-17. Cột "Khác khuyến nghị" đánh dấu chỗ chọn khác đề xuất ban đầu.

| # | Câu hỏi | Đã chốt | Khác khuyến nghị |
|---|---|---|---|
| Q1 | Bộ chuyển | **pandoc** trên hub, chạy có giới hạn (thời gian, bộ nhớ, `--sandbox`), binary ghim phiên bản trong image | |
| Q2 | Ai được nhập | Người `manage` tạo tài liệu ngay; người chỉ có `propose` (BA) tạo đề xuất, duyệt xong mới thành tài liệu (P2, US4) | |
| Q3 | Tài liệu chưa có nhà | Bản đầu **chỉ nhập vào nhà đã gắn repo** | |
| Q4 | Tên file, key, tiêu đề | Từ tên file Word: bỏ đuôi phiên bản, bỏ phần đầu chung của lượt, bỏ dấu; sửa được ở xem trước. Quy tắc riêng từng nhà để P3 | |
| Q5 | Phần trước tiêu đề cấp 1 | Bỏ mặc định, có ô "Giữ phần trước tiêu đề đầu tiên" | |
| Q6 | File Word gốc | Kho file hub, gắn với lần nhập; **không** ghi vào repo | |
| Q7 | Cập nhật từ bản Word mới | Hợp ba bên với gốc là Markdown lần nhập trước; chồng nhau thì mở màn xung đột (P2, US3) | |
| Q8 | Nhập nhiều file | Có: nhiều file hoặc cả thư mục, tối đa 100 file và 500 MB một lượt, chạy nền | |
| Q9 | Định dạng | `.docx`, `.odt` và **`.doc` (Word 97–2003)**. `.doc` đổi sang `.docx` bằng **LibreOffice** chạy không giao diện trên hub, rồi qua pandoc như `.docx` | Có: thêm `.doc`, image hub thêm LibreOffice |
| Q10 | Ảnh EMF/WMF, đối tượng nhúng | Giữ file gốc làm đính kèm, chèn link tải, cảnh báo. Không đổi sang PNG ở bản đầu (dù image đã có LibreOffice sau Q9) | |
| Q11 | Theo dõi thay đổi, bình luận | Chấp nhận mọi thay đổi, bỏ bình luận; xem trước báo số lượng | |
| Q12 | App desktop | **Làm cả trên desktop**: chọn file hoặc thư mục trên máy (vd. thư mục SharePoint đã đồng bộ OneDrive), tải lên hub, xem trạng thái lượt nhập (US7) | Có: khuyến nghị cũ là chỉ web |
| Q13 | Đợt chuyển đầu của 261 SRS | Đi đường `srs2md`: push nhánh, "Nhập từ repo" lên hub; P1 thêm **"Gắn với file Word"** (US6) | |
| Q14 | BA nhập cả lượt bằng quyền `propose` | Mỗi file một đề xuất; trang lượt nhập có "Duyệt các file đã chọn" | |
| Q15 | Nhãn mật | Ô "Tài liệu mật" trong hộp thoại, mặc định theo cài đặt mới của nhà `wordImportConfidential` (mặc định tắt; nhà acme nên bật) | |

**Cách hiểu Q9:** lựa chọn "Thêm .doc cũ" được hiểu là nhận cả ba định dạng `.docx`, `.odt`, `.doc`.

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code ngày 2026-10-16 trên `main` tại `de81b0df`. Spike trên file thật ở [research.md](research.md).

| Phần | Đã có | Dùng thế nào |
|---|---|---|
| Tài liệu (`knowledge`) | `docs.save` (`POST /v1/docs`, cần `manage`), `baseVersion: 0` là tạo mới. `applyDocSave` ghi `doc_versions` với `source` thuộc `hub`/`repo`/`import`/`merge` (ràng buộc DB). `DOC_MAX_CHARS` 200.000. Người chỉ có `propose` ghi bản nháp rồi `docEditor.submit` thành đề xuất: dòng `docs` chỉ có khi bản đầu được duyệt | **Dùng lại** `applyDocSave`. Thêm `source = "word"`. Lưu với `source = "import"` thì `onDocSaved` không đẩy vào repo (`docsync/push.ts`), nên phải dùng giá trị mới |
| Đường dẫn trong repo (`docsync/paths.ts`, `push.ts`) | Key luôn chữ thường. Tài liệu chưa có dòng `doc_repo_files` thì lô đẩy lấy đường dẫn từ key (`pathFromKey`), nên `docs/srs/OPD/OPD02.md` sẽ thành `docs/srs/opd/opd02.md`. Có dòng `doc_repo_files` (như khi nhập từ repo) thì giữ đúng đường dẫn đó. `keyFromPath` suy key từ đường dẫn | **Dùng lại**: khi tạo, ghi `doc_repo_files` với đúng đường dẫn người nhập đã chọn |
| Đính kèm (`docsync/assets.ts`) | Ảnh lưu ở thư mục ảnh của nhà: `<gốc nhà>/<assetsDir>/` (vd. `docs/assets/`), chung cho cả nhà, link tương đối từ tài liệu (`relativeFrom`). `POST /api/v1/docs/assets` (multipart `docKey`, `file`) cần tài liệu **đã có** và **có nhà**. BlobStore (`platform/blob-store.ts`): chia đoạn 512 KiB, khử trùng theo SHA-256, hạn mức tổ chức. `inspectFileType` kiểm loại theo byte. Dòng đính kèm `pending_push` rồi `queuePush` gom lô 60 giây | **Dùng lại** BlobStore, `inspectFileType`, `queuePush`. Không đi qua route upload: job nhập ghi tài liệu và ảnh trong cùng một giao dịch |
| Trích file (`docsync/extract`) | `runExtract`: mỗi file một `worker_threads`, 60 giây, heap 512 MB. `readZip` đếm byte giải nén thật, chặn zip bomb. `extractDocx` dùng mammoth + turndown, bỏ ảnh, chỉ để tìm kiếm | **Dùng lại** `readZip` để kiểm file trước khi chạy pandoc. Bản trích để tìm kiếm giữ nguyên |
| Bí mật | `assertDocSecrets` ném `DOC_SECRET_FOUND`, người `manage` xác nhận được (ghi audit). Nhập từ repo đánh dấu `blocked_secret` | **Dùng lại** cùng chính sách |
| Job | `platform/jobs.ts` (pg-boss): `enqueue` trong giao dịch, `work`, `schedule`. Hàng đợi docsync ở `docsync/queues.ts` | **Thêm** hàng đợi `docsync-word-import` |
| Editor (`packages/doc-editor`) | Pipe table sửa được. Khối không khớp khi xuất lại thì giữ dạng chữ (`rawMarkdown`). Ảnh là node trong dòng, phân giải link tương đối qua `resolveLink` | **Mở rộng**: `<br>` trong ô bảng (26% bảng SRS đang thành khối thô). **Sửa lỗi**: mục danh sách rỗng làm codec ném lỗi |
| Web | `/knowledge/docs/import`: nhập Markdown từ repo, không có tải file. `NewDoc` trong `docs-page.tsx`. Upload duy nhất là `uploadAsset` viết thẳng trong `doc-editor-page.tsx` | **Làm mới** hộp thoại "Nhập Word" cạnh `NewDoc` và một link ở cài đặt tài liệu dự án, cạnh "Nhập từ repo" |
| Kiểm sức khoẻ | `/api/v1/health` báo `clis`, `artifacts` | **Thêm** `wordImport` (có pandoc) và `wordImportDoc` (có LibreOffice cho `.doc`) |
| App desktop | Gọi hub qua lệnh Rust `hub_rpc` bằng token cá nhân (`hive_pat_…`) trong keychain; giao diện không thấy token. Màn soạn tài liệu (`docs-screen.tsx`) không tải file lên, không hiện được ảnh của tài liệu (chưa có cầu nối tải nhị phân). Có `tauri-plugin-dialog`, `reqwest` | **Mở rộng**: lệnh Rust tải file lên route nhập Word bằng token cá nhân; lệnh Rust tải nhị phân (ảnh) để xem trước; màn "Nhập Word" (US7) |
| Route tải file của hub | `POST /api/v1/docs/assets` chỉ nhận phiên đăng nhập web (better-auth) | Route nhập Word nhận **cả** phiên web lẫn token cá nhân, như RPC đang nhận cho desktop |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nhập một file Word vào thư mục tài liệu (Priority: P1)

Người quản lý tài liệu dự án mở **Tài liệu → Nhập Word**, chọn thư mục đích (vd. `docs/srs/OPD/`) và một file `.docx`.
Hub chuyển nền, rồi hiện bản xem trước:
- đường dẫn, tiêu đề đề xuất;
- số tiêu đề, bảng, ảnh;
- các cảnh báo;
- nội dung hiển thị bằng editor ở chế độ chỉ đọc.

Người nhập sửa tên hoặc tiêu đề nếu cần rồi bấm **Tạo tài liệu**. Tài liệu mở trong editor: bảng sửa được, ảnh hiện
đúng. Repo nhận file qua đồng bộ của nhà (PR hoặc commit thẳng theo cài đặt).

**Why this priority**: không có bước này thì BA vẫn phải nhờ dev chạy script.

**Independent Test**:
- Bộ file `.docx` mẫu sinh trong test, có ô gộp, cột STT đánh số tự động, tiêu đề dùng style riêng, ảnh kèm chú thích,
  trang bìa, mục lục, chữ gạch chân, mục danh sách rỗng.
- Provider `memory` của `scm`.
- Nhập, mở tài liệu, kiểm Markdown, ảnh trong kho file, lô đẩy vào repo.

**Acceptance Scenarios**:

1. **Given** dự án đã bật tài liệu gắn repo, **When** người có quyền `manage` chọn file và thư mục đích, **Then** xem
   trước hiện trong ≤ 20 giây với file 3 MB, kèm cảnh báo nếu có.
2. **Given** bản xem trước, **When** bấm "Tạo tài liệu", **Then**:
   - có tài liệu phiên bản 1, nguồn `word`;
   - bảng là pipe table và mở được trong editor dưới dạng bảng sửa được;
   - ảnh nằm trong thư mục ảnh của nhà (`<gốc nhà>/assets/`), link tương đối từ tài liệu;
   - file Word gốc nằm trong kho file, gắn với lần nhập.
3. **Given** tài liệu vừa tạo, **When** lô đồng bộ chạy, **Then** repo có file Markdown và ảnh trong cùng một commit hoặc
   PR. File Word gốc không có trong repo (Q6).
4. **Given** file Word có cột STT đánh số tự động, **When** nhập, **Then** cột STT ra đúng 1, 2, 3… như trong Word.
5. **Given** file có dấu hiệu bí mật, **When** xem trước, **Then** nút "Tạo tài liệu" bị chặn, hiện loại bí mật và số
   dòng, không hiện giá trị. Người `manage` bấm "Không phải bí mật, vẫn nhập" được (ghi audit).
6. **Given** đường dẫn đích đã có tài liệu, **When** xem trước, **Then** hiện "đã có" kèm hai lựa chọn: đổi tên, hoặc
   cập nhật tài liệu đó từ Word (US3).

---

### User Story 2 - Nhập nhiều file một lần (Priority: P1)

BA chọn cả thư mục SRS của một module (vd. 21 file OPD), hoặc thư mục `SRS` có nhiều thư mục con: thư mục con được giữ
nguyên dưới thư mục đích. Hub tự bỏ phần đầu chung của tên file và đuôi phiên bản, đề xuất `OPD02.md`, `OPD17.md`… Cùng một mã có nhiều phiên bản thì chỉ lấy bản cao nhất và ghi lý do. Người nhập bỏ chọn file
không cần, bấm **Nhập**, theo dõi tiến độ, cuối cùng xem báo cáo.

**Why this priority**: SRS acme có 270 file. Nhập từng file là không dùng được.

**Independent Test**: 30 file mẫu trong một lượt, gồm 2 mã có hai phiên bản, 1 file hỏng, 1 file có mật khẩu, 1 file có
token giả.

**Acceptance Scenarios**:

1. **Given** chọn 30 file, **When** xem trước, **Then** có bảng: tên file gốc, đường dẫn đề xuất, phiên bản, trạng thái
   ("sẵn sàng", "bỏ: có bản mới hơn", "đã có", "lỗi", "bí mật"), số cảnh báo.
2. **Given** đang nhập, **When** hub khởi động lại, **Then** lượt nhập chạy tiếp từ file chưa xong, không tạo trùng.
3. **Given** lượt nhập xong, **When** xem báo cáo, **Then** mỗi file có kết quả và link tới tài liệu. File lỗi có lý do
   bằng tiếng Việt ("File có mật khẩu", "File hỏng hoặc không phải Word", "Quá 200.000 ký tự").
4. **Given** các file cùng mẫu Word, **When** nhập, **Then** logo và ký hiệu lặp lại chỉ lưu một lần trong thư mục ảnh
   của nhà.

---

### User Story 3 - Cập nhật tài liệu từ bản Word mới (Priority: P2)

BA sửa file Word trên SharePoint và lên phiên bản v1.1. Trên tài liệu đã nhập, BA bấm **Cập nhật từ Word** và chọn file
mới. Hub chuyển, so với Markdown của lần nhập trước, rồi:
- hợp thay đổi vào bản hiện tại nếu không chồng lên phần đã sửa trên hub;
- chồng nhau thì mở màn xung đột ba bản.

**Why this priority**: còn viết Word thì phải cập nhật được. Nhưng có thể đợi sau khi chuyển đợt đầu.

**Independent Test**: nhập v1.0, sửa một bảng trên hub, cập nhật bằng v1.1 có đổi ở bảng khác rồi ở cùng bảng.

**Acceptance Scenarios**:

1. **Given** tài liệu chưa sửa trên hub, **When** cập nhật từ v1.1, **Then** có phiên bản mới nguồn `word`, ảnh mới được
   thêm, ảnh không còn tài liệu nào dùng được dọn (FR-026).
2. **Given** đã sửa trên hub ở phần khác, **When** cập nhật, **Then** hai thay đổi được hợp, không mất phần nào.
3. **Given** sửa cùng một khối, **When** cập nhật, **Then** mở màn xung đột hiện có, không ghi đè.
4. **Given** tải lại đúng file đã nhập (cùng SHA-256), **When** cập nhật, **Then** báo "không có gì thay đổi", không tạo
   phiên bản.

---

### User Story 4 - BA không có quyền quản lý gửi bản nhập để duyệt (Priority: P2)

BA chỉ có quyền `propose` nhập Word như US1. Thay vì tạo tài liệu, hub tạo **đề xuất**: người duyệt xem Markdown và ảnh
như một tài liệu. Duyệt xong thì tài liệu và ảnh mới được tạo và đẩy vào repo (Q2).

**Why this priority**: BA thường không phải quản trị đội. P1 vẫn dùng được nhờ quản trị nhập hộ.

**Independent Test**: thành viên đội nhập 1 file; quản trị duyệt; kiểm tài liệu, ảnh, lô đẩy. Từ chối thì không còn
tài liệu hay ảnh nào trong nhà.

**Acceptance Scenarios**:

1. **Given** người `propose`, **When** bấm "Gửi duyệt", **Then** có đề xuất hiện trong danh sách duyệt, ảnh xem được trong
   bản xem của đề xuất.
2. **Given** đề xuất được duyệt, **Then** tài liệu và ảnh được tạo như US1 bước 2.
3. **Given** đề xuất bị từ chối, **Then** ảnh và Markdown giữ tạm bị xoá theo hạn giữ (mặc định 30 ngày).

---

### User Story 5 - Xem lại lần nhập và tải file gốc (Priority: P3)

Trên tài liệu nhập từ Word có nhãn "Nhập từ Word" kèm tên file, ngày, người nhập và nút **Tải file Word gốc**. Quản trị
xem danh sách các lượt nhập của nhà, trạng thái và báo cáo.

**Acceptance Scenarios**:

1. **Given** người đọc được tài liệu, **When** bấm "Tải file Word gốc", **Then** tải đúng file đã nhập.
2. **Given** người không đọc được tài liệu, **Then** không thấy lượt nhập trong danh sách, không tải được file gốc.

---

### User Story 6 - Gắn tài liệu có sẵn với file Word (Priority: P1, theo khuyến nghị Q13)

Tài liệu đã lên hub qua "Nhập từ repo" (do `srs2md` chuyển) chưa có bản ghi lần nhập Word. Trên tài liệu đó, người quản lý
bấm **Gắn với file Word** và chọn đúng file Word đã dùng để chuyển. Từ đó tài liệu cập nhật được từ Word như US3.

**Why this priority**: không có bước này thì 261 SRS đi đường `srs2md` không bao giờ cập nhật được từ Word.

**Independent Test**: chuyển một file mẫu bằng bộ lọc, lưu làm tài liệu nguồn `import`; gắn với đúng file đó, rồi với
một file khác.

**Acceptance Scenarios**:

1. **Given** kết quả chuyển lại khớp nội dung hiện tại (bỏ qua front matter), **When** gắn, **Then** có bản ghi lần nhập
   làm gốc, không tạo phiên bản mới.
2. **Given** không khớp (tài liệu đã sửa trên hub, hoặc bộ lọc đã đổi), **When** gắn, **Then** hiện khác biệt. Người gắn
   chọn lấy kết quả chuyển làm gốc, hoặc huỷ.

---

### User Story 7 - Nhập Word từ app desktop (Priority: P2, Q12)

Trên app desktop, BA mở **Nhập Word**, chọn file hoặc cả thư mục trên máy, vd. thư mục `60.BA/SRS` đã đồng bộ OneDrive.
App đọc file từ ổ đĩa và tải lên hub bằng token cá nhân, rồi hiện cùng trang lượt nhập như web:
- bảng file, trạng thái, cảnh báo;
- xem trước có ảnh;
- tạo tài liệu hoặc gửi duyệt theo quyền.

**Why this priority**: BA làm việc với thư mục OneDrive trên máy; desktop chọn thẳng thư mục, không phải kéo thả qua
trình duyệt. Làm sau web vì dùng chung route và màn hình của hub.

**Independent Test**: thư mục mẫu trên máy gồm 5 file `.docx`, 1 `.doc`, 1 file có mật khẩu. Kiểm token không lộ ra giao
diện, tiến độ tải lên, kết quả trùng với lượt nhập qua web.

**Acceptance Scenarios**:

1. **Given** desktop đã đăng nhập hub bằng token cá nhân, **When** chọn thư mục 21 file OPD, **Then** app tải lên theo
   luồng (không đọc cả lượt vào bộ nhớ giao diện), hiện tiến độ từng file, rồi mở trang lượt nhập.
2. **Given** bản xem trước có ảnh, **Then** ảnh hiện được trong desktop (qua lệnh Rust tải nhị phân), không lộ token.
3. **Given** token cá nhân hết hạn, **Then** báo như các màn desktop khác ("Token không còn dùng được…").

### Edge Cases

- File có mật khẩu: `.docx` mã hoá là file OLE, không phải ZIP, cùng chữ ký đầu với `.doc` (`D0 CF 11 E0`). Hub đọc
  thư mục của file OLE để phân biệt: có luồng `EncryptedPackage` là file có mật khẩu ("File có mật khẩu, mở khoá rồi tải
  lại"), có luồng `WordDocument` là `.doc`.
- `.doc` có macro: LibreOffice đổi định dạng ở chế độ không giao diện, không chạy macro. LibreOffice treo hoặc quá thời
  gian thì dừng tiến trình, báo lỗi file đó.
- Hub có pandoc nhưng không có LibreOffice: nhận `.docx`, `.odt`; `.doc` báo "Hub chưa bật nhận .doc".
- File hỏng hoặc đổi đuôi: `inspectFileType` không khớp thì báo "Không phải file Word".
- Zip bomb, quá nhiều entry: `readZip` chặn trước khi chạy pandoc.
- pandoc chạy quá thời gian hoặc quá bộ nhớ: dừng tiến trình, báo lỗi file đó, không ảnh hưởng file khác.
- Hub không có pandoc: ẩn nút nhập, `/api/v1/health` báo `wordImport: false`, trang quản trị nói cách bật.
- Kết quả quá `DOC_MAX_CHARS`: chặn, gợi ý tách file Word.
- Một ảnh quá `HIVE_DOC_ASSET_MAX_BYTES`, hoặc hết hạn mức kho file tổ chức: chặn file đó, báo dung lượng.
- Bảng lồng trong bảng: pipe table không chứa được. Bảng trong được dàn thành chữ trong ô, có cảnh báo.
- Công thức toán (OMML): pandoc ra `$…$`; editor giữ dạng chữ thô. Cảnh báo.
- Chú thích cuối trang: ra chú thích GFM `[^1]`; editor giữ dạng chữ thô. Cảnh báo.
- Header, footer, text box, hình vẽ của Word: pandoc bỏ. Cảnh báo khi phát hiện.
- Hai file trong cùng lượt đề xuất cùng một đường dẫn: lượt bị chặn ở bước xem trước cho tới khi đổi tên.
- Tên file tiếng Việt có dấu, dấu cách, ký tự lạ: bỏ dấu, thay bằng `-`, kiểm theo `docKey`.
- Hai người nhập cùng đường dẫn cùng lúc: một người thắng, người sau nhận "đã có" (khoá lạc quan như `applyDocSave`).

## Requirements *(mandatory)*

### Functional Requirements

**Nhập và xem trước**

- **FR-001**: Có nút "Nhập Word" ở danh sách tài liệu (cạnh "Tài liệu mới") và ở cài đặt tài liệu dự án (cạnh "Nhập từ
  repo"). Người nhập chọn nhà và thư mục đích trong nhà (Q3).
- **FR-002**: Hub nhận file qua route multipart `POST /api/v1/docs/word-imports`. Xác thực bằng phiên web (better-auth)
  **hoặc** token cá nhân của desktop (`Authorization: Bearer hive_pat_…`), tổ chức từ `x-hive-org` (Q12):
  - mỗi file ≤ `HIVE_DOC_WORD_MAX_BYTES` (mặc định 50 MiB);
  - mỗi lượt ≤ 100 file và ≤ 500 MiB (Q8);
  - chỉ nhận `.docx`, `.odt`, `.doc` (Q9), kiểm theo byte bằng `inspectFileType`. `inspectFileType` hiện chưa biết `.odt`
    và `.doc` (`platform/magic.ts`), phải bổ sung, gồm phân biệt `.doc` với `.docx` có mật khẩu (Edge Cases).
- **FR-003**: File gốc vào BlobStore ngay khi nhận. Việc chuyển chạy nền trên hàng đợi `docsync-word-import`:
  - `.doc` trước hết đổi sang `.docx` bằng LibreOffice không giao diện (`soffice --headless --convert-to docx`), hồ sơ
    người dùng riêng cho mỗi lần chạy, tối đa 120 giây; kết quả đi tiếp như `.docx`;
  - mỗi file một tiến trình pandoc;
  - tối đa 120 giây và 512 MiB;
  - chạy với `--sandbox` trong thư mục tạm riêng;
  - tối đa 2 file chạy cùng lúc trên một tiến trình hub.
- **FR-004**: Trước khi chạy pandoc, hub kiểm `.docx`/`.odt` bằng `readZip` với cùng giới hạn của bản trích
  (`EXTRACT_LIMITS`). `.doc` kiểm cấu trúc OLE và kích thước trước khi đưa cho LibreOffice; `.docx` LibreOffice sinh ra
  cũng qua `readZip`.
- **FR-005**: Xem trước từng file hiện:
  - tên file gốc, đường dẫn và tiêu đề đề xuất (sửa được);
  - phiên bản đọc từ tên file;
  - số tiêu đề, bảng, ảnh;
  - cảnh báo;
  - nội dung bằng editor chỉ đọc.
  Lượt nhiều file có thêm bảng tổng hợp (US2).
- **FR-006**: Tên file và key theo Q4. Thư mục con của thư mục được kéo vào giữ nguyên dưới thư mục đích; phần đầu chung
  tính riêng trong từng thư mục con. Cùng thư mục cuối mà cùng tên sau khi chuẩn hoá thì chỉ giữ bản có phiên bản cao
  nhất; bản bị bỏ có lý do trong xem trước. Thứ tự chọn giống `srs2md`: phiên bản → số bản sao `_n` → tên chuẩn → ngày
  sửa → tên file. Không phụ thuộc thứ tự sắp xếp của hệ điều hành.

**Quy tắc chuyển**

- **FR-007**: Tiêu đề lấy theo style Word, kể cả style riêng kế thừa `Heading N`.
- **FR-008**: Bỏ phần trước tiêu đề cấp 1 đầu tiên (Q5), trừ khi người nhập chọn giữ. Bỏ đoạn mục lục (chỉ có link
  `#_Toc…`), bookmark (`<span id>`), link nội bộ thành chữ thường.
- **FR-009**: Bảng ra pipe table:
  - ô gộp được trải ra, ô bị che để trống;
  - đúng một hàng tiêu đề (hàng đầu);
  - ô nhiều đoạn nối bằng `<br>`;
  - danh sách trong ô thành `1.`/`•` theo số bắt đầu của Word;
  - chú thích bảng thành đoạn văn ngay trước bảng;
  - bảng lồng được dàn thành chữ, có cảnh báo.
- **FR-010**: Ảnh:
  - đặt tên bằng 12 ký tự đầu của SHA-256 nội dung, lưu ở thư mục ảnh của nhà `<gốc nhà>/<assetsDir>/`, như ảnh tải lên
    từ editor;
  - khử trùng trong cả nhà: logo của mẫu SRS chỉ có một file;
  - link tương đối từ tài liệu (vd. `![](../../assets/<tên>)` cho `docs/srs/OPD/OPD17.md`), không thuộc tính. Khác
    `srs2md`, script này để ảnh trong `assets/` của từng module;
  - hình có chú thích thành ảnh và một đoạn chữ nghiêng ngay sau;
  - EMF/WMF và đối tượng nhúng theo Q10.
- **FR-011**: Định dạng trong dòng:
  - giữ đậm, nghiêng, link ngoài;
  - bỏ gạch chân, màu, tô nền, nhưng giữ chữ;
  - bỏ đoạn và mục danh sách rỗng;
  - theo dõi thay đổi và bình luận theo Q11.
- **FR-012**: Front matter của tài liệu sinh ra:
  ```yaml
  title: "<tiêu đề>"
  word:
    file: "<tên file gốc>"
    sha256: "<hash file gốc>"
  ```
  Không ghi thời điểm nhập vào file, để kết quả không đổi giữa các lần chuyển.
- **FR-013**: Cùng file và cùng phiên bản bộ lọc thì ra đúng từng byte (Markdown và tên ảnh).
- **FR-014**: Bộ lọc Lua của hub và `tools/srs2md` dùng cùng một bản quy tắc. Bản của hub là bản chuẩn; `srs2md` chép lại
  và ghi phiên bản đã chép.

**Editor**

- **FR-015**: Editor hiểu `<br>` trong ô pipe table là xuống dòng trong ô (`hardBreak`) và xuất lại thành `<br>`. Bảng có
  `<br>` sửa được như bảng thường. Khối không đổi vẫn ghi lại nguyên văn.
- **FR-016**: Codec không ném lỗi với mục danh sách rỗng (`6. `). Sửa lỗi này độc lập với Word, vì Markdown từ repo cũng
  gặp.

**Lưu, quyền, an toàn**

- **FR-017**: Người `manage` ở phạm vi đích tạo tài liệu thẳng. Trong cùng một giao dịch:
  - ghi `doc_repo_files` với đúng đường dẫn đã chọn, giữ hoa thường; key suy bằng `keyFromPath`;
  - `applyDocSave` với `source = "word"`;
  - ghi ảnh vào BlobStore và bảng đính kèm, trạng thái `pending_push`;
  - ghi bản ghi lần nhập;
  - `queuePush`.
  Người `propose` theo US4 (P2).
- **FR-018**: Markdown sau khi chuyển đi qua `assertDocSecrets`. Có bí mật thì file bị chặn. Người `manage` xác nhận được
  như khi lưu tài liệu (ghi audit gắn hash nội dung).
- **FR-019**: Đường dẫn đích đã có tài liệu thì không tạo mới. Xem trước cho đổi tên hoặc cập nhật (US3).
- **FR-020**: File Word gốc chỉ tải được bởi người đọc được tài liệu tạo ra từ nó, và không ghi vào repo (Q6).
- **FR-021**: `recordAudit()` cho: tạo lượt nhập, tạo hoặc cập nhật tài liệu từ Word, xác nhận "không phải bí mật", tải
  file gốc.
- **FR-022**: Lỗi và cảnh báo viết tiếng Việt, có cách sửa (bảng trong Edge Cases).
- **FR-023**: Hub tìm pandoc theo `HIVE_PANDOC_PATH` (mặc định `pandoc` trên `PATH`) và LibreOffice theo
  `HIVE_SOFFICE_PATH` (mặc định `soffice`), kiểm phiên bản lúc khởi động:
  - không có pandoc hoặc quá cũ: tắt tính năng, `/api/v1/health` báo `wordImport: false`, giao diện ẩn nút nhập;
  - có pandoc, không có LibreOffice: `wordImportDoc: false`, chỉ nhận `.docx` và `.odt`.

**Cập nhật từ Word (P2)**

- **FR-024**: Bản ghi lần nhập giữ Markdown đã chuyển làm gốc cho lần cập nhật sau. "Cập nhật từ Word" hợp ba bên bằng
  `mergeBlocks` (`contracts/src/doc-text.ts`): gốc là Markdown lần nhập trước, bên kia là bản hiện tại trên hub. Chồng
  nhau thì mở màn xung đột ba bản của docsync.
- **FR-025**: File có cùng SHA-256 với lần nhập trước thì không tạo phiên bản.
- **FR-026**: Sau khi cập nhật, ảnh đặt tên kiểu hash trong thư mục ảnh của nhà mà không còn tài liệu nào trỏ tới thì
  được xoá khỏi nhà và khỏi repo ở lô đẩy kế tiếp. Ảnh người dùng tải lên (`image-<thời điểm>.<đuôi>`) không bị đụng tới.
  Hiện lô đẩy chỉ xoá được file tài liệu (`push.ts`); `doc_assets.state` chưa có trạng thái chờ xoá. Plan bổ sung.

**Đề xuất (P2)**

- **FR-027**: Người chỉ có `propose`:
  - Markdown và ảnh được giữ tạm, gắn với lượt nhập, chưa nằm trong nhà;
  - đề xuất trỏ tới lượt nhập, bản xem của đề xuất hiện được ảnh;
  - duyệt thì chạy FR-017, từ chối hoặc quá hạn giữ (`HIVE_DOC_WORD_STAGING_DAYS`, mặc định 30) thì xoá phần giữ tạm.

**Gắn tài liệu có sẵn với file Word (P1, Q13)**

- **FR-028**: "Gắn với file Word" chạy chuyển như FR-003 nhưng không tạo phiên bản. So kết quả với nội dung hiện tại sau
  khi bỏ front matter:
  - khớp thì ghi bản ghi lần nhập (`mode = link`) làm gốc cho FR-024;
  - không khớp thì hiện khác biệt và chỉ ghi khi người gắn xác nhận.

**App desktop (P2, Q12)**

- **FR-029**: Desktop có màn "Nhập Word": chọn file hoặc thư mục bằng hộp thoại hệ điều hành, lọc `.docx`, `.odt`, `.doc`,
  hiện tổng số file và dung lượng, chặn sớm khi quá giới hạn của lượt.
- **FR-030**: Lệnh Rust `hub_upload_word` đọc file từ ổ đĩa và gửi multipart theo luồng tới route FR-002 bằng token cá nhân
  trong keychain, báo tiến độ từng file cho giao diện. Token không đi qua giao diện (như `hub_rpc`).
- **FR-031**: Lệnh Rust tải nhị phân của hub (ảnh xem trước, ảnh tài liệu) bằng token cá nhân, trả về cho giao diện dưới dạng
  dữ liệu để hiện. Chỉ cho đường dẫn của hub thuộc nhóm ảnh và file gốc, kiểm như `safe_rpc_path`. Màn soạn tài liệu của
  desktop dùng lại lệnh này để hiện ảnh.
- **FR-032**: Trang lượt nhập trên desktop dùng cùng API oRPC (`wordImports.*`) với web, cùng trạng thái và thao tác.

### Key Entities

- **Lượt nhập Word** (`doc_word_imports`):
  - tổ chức, nhà, thư mục đích, chế độ (tạo, cập nhật, gắn);
  - người nhập;
  - trạng thái (`uploading`, `converting`, `ready`, `committing`, `done`, `failed`);
  - số file theo trạng thái;
  - thời điểm.
- **File trong lượt** (`doc_word_import_files`):
  - lượt nhập;
  - thư mục con tương đối (khi kéo cả thư mục);
  - tên file gốc, SHA-256, `blob_id` file gốc, phiên bản đọc từ tên;
  - đường dẫn và tiêu đề đề xuất, chỉnh sửa của người nhập;
  - trạng thái (`queued`, `converting`, `ready`, `skipped`, `blocked_secret`, `failed`, `done`);
  - Markdown đã chuyển, danh sách ảnh (`blob_id`, tên hash);
  - cảnh báo, lỗi;
  - tài liệu và phiên bản tạo ra.
- Cả hai bảng có `org_id`, bật và ép RLS, truy cập qua `withTenant()`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Trên bộ 261 SRS acme (chỉ chạy tại máy có dữ liệu, không đưa vào repo):
  - 100% file chuyển không lỗi;
  - 0 tài liệu làm editor ném lỗi;
  - ≥ 99% bảng mở được dưới dạng bảng sửa được (hiện 74%, research mục 3);
  - không còn thẻ HTML nào ngoài `<br>` trong ô bảng.
- **SC-002**: Bộ file mẫu sinh trong test (ô gộp, STT tự động, style tiêu đề riêng, chú thích, trang bìa, mục lục, gạch
  chân, mục danh sách rỗng, bảng lồng, ảnh EMF, theo dõi thay đổi, file có mật khẩu, file hỏng, một `.doc` và một `.odt`
  cùng nội dung với một `.docx`) ra đúng Markdown đã duyệt, so từng byte. Riêng `.doc` so với Markdown của `.docx` cùng
  nội dung, chấp nhận khác biệt đã liệt kê trong file vàng.
- **SC-003**: Xem trước file SRS 3 MB ≤ 20 giây; lượt 50 file ≤ 10 phút trên máy chủ dev.
- **SC-004**: Nhập lại đúng file đã nhập thì không có phiên bản mới, không có commit mới vào repo.
- **SC-005**: File có mật khẩu, zip bomb, file quá lớn, pandoc treo, LibreOffice treo đều bị từ chối hoặc dừng mà không
  làm hub dừng hay chậm các yêu cầu khác. Có test cho từng trường hợp.
- **SC-006**: Không file nào có dấu hiệu bí mật được tạo thành tài liệu mà không có xác nhận đã ghi audit.
- **SC-007**: Người không có quyền `propose` ở phạm vi đích không nhập được. Người không đọc được tài liệu không thấy lượt
  nhập và không tải được file gốc.

## Assumptions

- Nhà tài liệu (spec 018) đã cấu hình và hub đã chạy bản có PR #413. Hub `hive.example.com` đã lên `9947aeb1` (có #413,
  #416) ngày 2026-10-17.
- PostgreSQL vẫn là kho dữ liệu duy nhất. pandoc và LibreOffice là chương trình trong image hub, chạy như tiến trình con
  khi cần, không phải dịch vụ mới.
- Người dùng có file Word trên máy (tải về hoặc đồng bộ OneDrive). Hub không đọc thẳng SharePoint.
- Bản trích để tìm kiếm của file Word đính kèm (spec 018 US6) không đổi.

## Out of Scope

- Xuất tài liệu hub ra Word.
- Đọc thẳng từ SharePoint, OneDrive, Google Drive.
- `.rtf`, `.pdf` sang Markdown; OCR.
- Quy tắc đặt tên riêng từng nhà (lấy mã bằng regex, tra tên chức năng từ RMS): P3 (Q4).
- Sinh mục lục, bảng tổng hợp yêu cầu từ nhiều tài liệu.
