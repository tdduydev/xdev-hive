# Feature Specification: Nhập Word thành tài liệu hub

**Feature Branch**: `019-word-import`

**Created**: 2026-10-16

**Status**: Draft. Chờ chủ dự án chốt Q1–Q15.

**Input**: Chủ dự án chốt ngày 2026-10-16:
- BA tải file `.docx` lên hub. Hub tạo tài liệu Markdown kèm ảnh, bảng sửa được trong editor.
- Viết spec và kế hoạch trước, chưa code.

Bối cảnh:
- Tài liệu SRS của acme nằm trên SharePoint: 270 file Word, cùng một mẫu của FIS.
- Script `tools/srs2md` (Python + pandoc) trong repo `acme-ai/docs` đã chuyển thử cả 261 tài liệu, nhưng cần máy có
  Python và pandoc.
- BA có thể còn viết Word một thời gian. Spec này đưa việc chuyển vào hub để BA tự làm trên trình duyệt.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md)

## Câu hỏi mở cho chủ dự án

Mỗi câu có khuyến nghị. Chưa chốt thì task làm theo khuyến nghị và ghi **[Giả định]**.

| # | Câu hỏi | Khuyến nghị | Ảnh hưởng nếu đổi |
|---|---|---|---|
| Q1 | Bộ chuyển Word sang Markdown? | **pandoc** chạy trên hub như tiến trình con có giới hạn (thời gian, bộ nhớ, `--sandbox`), kèm bộ lọc Lua của hub. Image hub thêm binary pandoc ghim phiên bản và SHA-256. Lý do: trên file SRS thật, mammoth mất số STT và tiêu đề dùng style riêng (research mục 2) | mammoth: không thêm binary, nhưng phải tự đọc `styles.xml`, `numbering.xml` để giữ tiêu đề và số thứ tự. Đó là viết lại phần khó nhất của bộ đọc docx |
| Q2 | Ai được nhập? | Người có quyền `manage` ở phạm vi đích tạo tài liệu ngay (như `docs.save`). Người chỉ có `propose`, thường là BA trong đội, tạo **đề xuất**: hub giữ tạm Markdown và ảnh, tạo tài liệu khi đề xuất được duyệt (P2, US4) | Chỉ cho `manage` thì bỏ được phần giữ tạm ảnh, nhưng BA phải nhờ quản trị đội nhập hộ |
| Q3 | Nhập vào tài liệu chưa có nhà (chưa gắn repo)? | Bản đầu **chỉ nhập vào nhà đã cấu hình**: dự án đã bật tài liệu gắn repo, hoặc repo tài liệu tổ chức. Ảnh hiện cần nhà (`DOCSYNC_NO_HOME`) | Cho cả tài liệu chỉ trên hub thì phải có chỗ lưu ảnh không gắn repo: sửa `docsync/assets.ts` và cách phân giải link |
| Q4 | Tên file, key, tiêu đề lấy từ đâu? | Thư mục đích do người nhập chọn, tên file lấy theo tên file Word: bỏ đuôi phiên bản (`_v1.0`, ` v1.1_1`), bỏ phần đầu chung của cả lượt (vd. `eHosV2i_SRS_OPD.`), bỏ dấu, chữ thường. Tiêu đề lấy theo tên file đã bỏ phiên bản. Sửa được từng file ở bước xem trước | Quy tắc riêng từng nhà (regex lấy mã, tra tên chức năng từ RMS như `srs2md`) để P3 |
| Q5 | Trang bìa, ghi nhận thay đổi, trang ký, mục lục (phần trước tiêu đề cấp 1 đầu tiên)? | Bỏ mặc định, như `srs2md`. Ô "Giữ phần trước tiêu đề đầu tiên" ở bước xem trước. Không có tiêu đề cấp 1 thì giữ hết và cảnh báo | Giữ mặc định thì tài liệu nào cũng mở đầu bằng trang bìa và mục lục kèm số trang sai |
| Q6 | File Word gốc lưu ở đâu? | Trong kho file hub, gắn với lần nhập: tải lại được, dùng để cập nhật lại. **Không** ghi vào repo. Lý do: repo chỉ cần Markdown, và SRS acme có 235 MB Word so với 84 MB Markdown + ảnh | Ghi vào repo thì repo nặng gấp ba, và mỗi lần BA sửa Word là một file nhị phân mới trong lịch sử git |
| Q7 | BA sửa Word rồi tải lại bản mới cho tài liệu đã nhập? | "Cập nhật từ Word" tạo phiên bản mới. Nếu tài liệu đã được sửa trên hub sau lần nhập trước: hợp ba bên với gốc là Markdown của lần nhập trước (`mergeBlocks`), chồng nhau thì mở màn xung đột sẵn có (P2, US3) | Ghi đè thẳng thì mất phần đã sửa trên hub |
| Q8 | Nhập nhiều file một lần? | Có. Chọn nhiều file hoặc kéo cả thư mục, tối đa 100 file và 500 MB một lượt. Chạy nền, có tiến độ và báo cáo | Một file mỗi lần thì 261 SRS phải bấm 261 lần |
| Q9 | Định dạng nhận? | `.docx`. Thêm `.odt` vì pandoc đọc được với cùng bộ lọc. **Không** nhận `.doc`, `.rtf`, `.pdf` | `.doc` cần LibreOffice trên hub: thêm vài trăm MB và một bộ đọc file nhị phân cũ |
| Q10 | Ảnh EMF/WMF và đối tượng nhúng (Visio, Excel trong Word)? | Giữ file gốc làm đính kèm, chèn link tải, cảnh báo trong báo cáo. Không đổi sang PNG trên hub. Chưa gặp EMF/WMF trong 261 SRS | Đổi sang PNG cần LibreOffice hoặc Inkscape trên hub |
| Q11 | Theo dõi thay đổi và bình luận trong Word? | Chấp nhận mọi thay đổi đang theo dõi, bỏ bình luận. Xem trước báo "còn N thay đổi chưa chấp nhận, M bình luận" | Giữ thay đổi theo dõi thì Markdown có đoạn chèn, xoá lẫn vào nhau, editor không có cách hiển thị |
| Q12 | App desktop? | Chỉ làm trên web. Desktop mở trang web như các việc của đội khác (PR #412) | Làm trên desktop cần cầu nối file nhị phân, hiện chưa có (màn soạn tài liệu `docs-screen.tsx` không có `uploadAsset`) |
| Q13 | 261 SRS đã chuyển bằng `tools/srs2md` (nhánh `duythq/docs/srs-opd` của repo docs, chưa push): đợt chuyển đầu đi đường nào? | Đi đường `srs2md`: push nhánh, rồi "Nhập từ repo" lên hub, để đội có tài liệu ngay mà không chờ tính năng này. P1 thêm **"Gắn với file Word"** cho tài liệu đã có: tải đúng file Word đã dùng để chuyển; hub chuyển lại bằng cùng bộ lọc; kết quả khớp nội dung hiện tại (bỏ qua front matter) thì ghi làm gốc cho lần cập nhật sau, không tạo phiên bản; không khớp thì hiện khác biệt để người gắn chọn | Bỏ kết quả `srs2md`, nhập lại cả 270 file qua hub: mọi tài liệu có sẵn bản ghi lần nhập, không cần "Gắn với file Word", nhưng phải đợi xong P1. Không làm "Gắn" thì tài liệu từ `srs2md` không cập nhật từ Word được (US3 không có gốc để hợp) |
| Q14 | (P2) BA chỉ có `propose` nhập cả lượt: mỗi file một đề xuất, hay duyệt cả lượt một lần? | Mỗi file một đề xuất, vì đề xuất và quy trình duyệt hiện gắn với một tài liệu. Trang lượt nhập có nút "Duyệt các file đã chọn" để người duyệt làm nhiều file một lần | Duyệt cả lượt cần mô hình đề xuất mới (một đề xuất nhiều tài liệu) và màn duyệt mới: tăng P2 thêm vài ngày |
| Q15 | Tài liệu nhập từ Word có gắn `confidential: true` không? Cờ này giữ nội dung không bị gửi tới nhà cung cấp embedding bên ngoài (`knowledge/doc-search.ts`) | Ô "Tài liệu mật" trong hộp thoại nhập, mặc định theo một cài đặt mới của nhà: `wordImportConfidential`, mặc định tắt. Với nhà acme nên bật, vì SRS là tài liệu của khách hàng | Luôn bật: tìm theo nghĩa không dùng được cho tài liệu từ Word. Luôn tắt: tài liệu khách hàng có thể bị gửi đi embedding khi tổ chức đã cấu hình nhà cung cấp |

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
| Kiểm sức khoẻ | `/api/v1/health` báo `clis`, `artifacts` | **Thêm** `wordImport: true/false` theo việc hub tìm thấy pandoc |

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

### Edge Cases

- File có mật khẩu: docx mã hoá là file OLE, không phải ZIP. Báo "File có mật khẩu, mở khoá rồi tải lại".
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
- **FR-002**: Hub nhận file qua route multipart `POST /api/v1/docs/word-imports`, giống `POST /api/v1/docs/assets` (phiên
  better-auth, tổ chức từ `x-hive-org`):
  - mỗi file ≤ `HIVE_DOC_WORD_MAX_BYTES` (mặc định 50 MiB);
  - mỗi lượt ≤ 100 file và ≤ 500 MiB (Q8);
  - chỉ nhận `.docx`, `.odt`, kiểm theo byte bằng `inspectFileType` (Q9). `inspectFileType` hiện chưa biết `.odt`
    (`platform/magic.ts`), phải bổ sung.
- **FR-003**: File gốc vào BlobStore ngay khi nhận. Việc chuyển chạy nền trên hàng đợi `docsync-word-import`:
  - mỗi file một tiến trình pandoc;
  - tối đa 120 giây và 512 MiB;
  - chạy với `--sandbox` trong thư mục tạm riêng;
  - tối đa 2 file chạy cùng lúc trên một tiến trình hub.
- **FR-004**: Trước khi chạy pandoc, hub kiểm file bằng `readZip` với cùng giới hạn của bản trích (`EXTRACT_LIMITS`).
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
- **FR-023**: Hub tìm pandoc theo `HIVE_PANDOC_PATH` (mặc định `pandoc` trên `PATH`) và kiểm phiên bản tối thiểu lúc khởi
  động. Không có hoặc quá cũ thì tắt tính năng: `/api/v1/health` báo `wordImport: false`, giao diện ẩn nút nhập.

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
  chân, mục danh sách rỗng, bảng lồng, ảnh EMF, theo dõi thay đổi, file có mật khẩu, file hỏng) ra đúng Markdown đã duyệt,
  so từng byte.
- **SC-003**: Xem trước file SRS 3 MB ≤ 20 giây; lượt 50 file ≤ 10 phút trên máy chủ dev.
- **SC-004**: Nhập lại đúng file đã nhập thì không có phiên bản mới, không có commit mới vào repo.
- **SC-005**: File có mật khẩu, zip bomb, file quá lớn, pandoc treo đều bị từ chối hoặc dừng mà không làm hub dừng hay
  chậm các yêu cầu khác. Có test cho từng trường hợp.
- **SC-006**: Không file nào có dấu hiệu bí mật được tạo thành tài liệu mà không có xác nhận đã ghi audit.
- **SC-007**: Người không có quyền `propose` ở phạm vi đích không nhập được. Người không đọc được tài liệu không thấy lượt
  nhập và không tải được file gốc.

## Assumptions

- Nhà tài liệu (spec 018) đã cấu hình và hub đã chạy bản có PR #413. Hub `hive.example.com` ngày 2026-10-16 chạy
  `3fa5aadf`, chưa có #413 (research mục 5).
- PostgreSQL vẫn là kho dữ liệu duy nhất. pandoc là binary trong image hub, không phải dịch vụ mới.
- Người dùng có file Word trên máy (tải về hoặc đồng bộ OneDrive). Hub không đọc thẳng SharePoint.
- Bản trích để tìm kiếm của file Word đính kèm (spec 018 US6) không đổi.

## Out of Scope

- Xuất tài liệu hub ra Word.
- Đọc thẳng từ SharePoint, OneDrive, Google Drive.
- `.doc`, `.rtf`, `.pdf` sang Markdown; OCR.
- Quy tắc đặt tên riêng từng nhà (lấy mã bằng regex, tra tên chức năng từ RMS): P3 (Q4).
- Nhập trên app desktop (Q12).
- Sinh mục lục, bảng tổng hợp yêu cầu từ nhiều tài liệu.
