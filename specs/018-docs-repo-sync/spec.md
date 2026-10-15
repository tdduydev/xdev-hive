# Feature Specification: Tài liệu trên hub, nhập từ repo, đồng bộ hai chiều với repo

**Feature Branch**: `018-docs-repo-sync`

**Created**: 2026-10-15

**Status**: Draft. Chờ chủ dự án chốt Q1–Q12.

**Input**: Người dùng chốt ngày 2026-10-15:
- Nguồn tài liệu cũ nằm trong các repo dự án trên GitLab/GitHub đã kết nối với hub: `docs/`, `specs/`, ADR,
  README… dạng markdown.
- Hub là **nơi chính** để soạn, tìm, phân quyền:
  - tài liệu lưu trên hub (PostgreSQL + kho file), có phiên bản;
  - quyền theo tổ chức, dự án, đội;
  - tìm theo nghĩa;
  - sửa trên web và app desktop bằng editor Tiptap (`packages/doc-editor`).
- Tài liệu gắn repo đồng bộ **hai chiều** với repo:
  - sửa trên hub thì mở PR vào repo;
  - repo đổi thì cập nhật hub;
  - xung đột thì hỏi người.
- File không phải markdown (Word, PDF, Excel, ảnh), chủ yếu là ảnh và đính kèm trong repo:
  - giữ file gốc trong kho file;
  - trích nội dung sang markdown, có bước duyệt, để tìm kiếm và cho agent đọc.

**Bổ sung của chủ dự án (2026-10-15)**: tài liệu **cũng phải lưu trong thư mục repo** GitLab/GitHub, kể cả tài liệu tạo
mới trên hub. Mỗi tài liệu có "nhà" là một repo + thư mục:
- Tài liệu của dự án: repo của dự án, thư mục cấu hình được (mặc định `docs/`).
- Tài liệu chung của tổ chức hoặc đội (không gắn dự án): một repo tài liệu riêng do tổ chức chọn (ví dụ `org-docs`).

Hub vẫn là nơi soạn, tìm, phân quyền chính. Git là bản lưu bền và lịch sử:
- mỗi lần lưu trên hub thì commit hoặc mở PR vào đúng thư mục;
- thay đổi được gom lại; chọn PR hay commit thẳng theo cài đặt;
- file đính kèm và ảnh lưu cạnh tài liệu trong repo (ví dụ `docs/assets/`);
- file lớn dùng Git LFS nếu repo đã bật.

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md) · **Task**: [tasks.md](tasks.md)

## Câu hỏi mở cho chủ dự án

Mỗi câu có khuyến nghị. Chưa chốt thì task làm theo khuyến nghị và ghi **[Giả định]**.

| # | Câu hỏi | Khuyến nghị | Ảnh hưởng nếu đổi |
|---|---|---|---|
| Q1 | Lưu trên hub thì **mở PR** hay **commit thẳng** vào nhánh mặc định? | Theo từng nhà, đổi được trong cài đặt. Repo dự án mặc định `pr`: một PR "Đồng bộ tài liệu" cuốn chiếu cho mỗi nhà, hub tự merge khi nhánh cho phép (như SDLC sync, spec 011). Repo tài liệu tổ chức mặc định `direct`: commit thẳng. Lý do: repo code thường bảo vệ nhánh mặc định, repo tài liệu thì không, và tài liệu đã qua quy trình duyệt trên hub | Chỉ `pr` thì repo tài liệu tổ chức đầy PR. Chỉ `direct` thì hỏng ở repo có bảo vệ nhánh |
| Q2 | Thư mục mặc định trong repo? | Dự án: `docs/`. Repo tổ chức: `org/` cho tài liệu tổ chức, `teams/<slug đội>/` cho tài liệu đội (cùng cách chia như kho skill, SKILL-01). Ảnh và đính kèm của tài liệu mới: `<thư mục nhà>/assets/` | Đổi bố cục sau khi đã đồng bộ cần một PR di chuyển file (FR-024) |
| Q3 | Repo tài liệu tổ chức: hub **tạo mới** hay **chọn repo có sẵn**? Một repo cho cả tổ chức hay mỗi đội một repo? | Cả hai: chọn repo có sẵn, hoặc hub tạo repo riêng tư `org-docs` qua kết nối Git (saga tạo repo đã có). Bản đầu một repo cho mỗi tổ chức; đội dùng thư mục `teams/<slug>/`. Mỗi đội một repo riêng để P3 | Mỗi đội một repo thì bảng `doc_homes` thêm phạm vi đội, màn cài đặt đội thêm mục |
| Q4 | Repo đổi mà hub **không** đổi (không xung đột): cập nhật hub thẳng, hay đi qua quy trình duyệt tài liệu? | Cập nhật thẳng, tạo phiên bản mới có nguồn "repo" kèm commit và tác giả. Thay đổi đã qua review của repo (PR hoặc quyền push). Dự án bật được "Thay đổi từ repo phải qua duyệt" | Qua duyệt mặc định thì mỗi lần push sinh đề xuất, người duyệt chịu tải lớn |
| Q5 | Gom thay đổi trong bao lâu trước khi commit hoặc cập nhật PR? | Gom 60 giây từ lần lưu cuối, tối đa 10 phút. Chế độ `pr` có một nhánh `hive/docs-sync-<nhà>` cho mỗi nhà, mỗi lô thêm một commit vào PR đang mở | Gom ngắn thì nhiều commit nhỏ. Gom dài thì repo trễ so với hub |
| Q6 | Bản trích markdown của file Word/PDF/Excel có ghi vào repo không? | **Không.** Bản trích chỉ ở hub: là dữ liệu suy ra, tạo lại được, dùng để tìm kiếm và cho agent đọc. File gốc vẫn ở repo | Ghi vào repo thì thêm file `<tên>.extract.md` cạnh file gốc, phải đồng bộ hai chiều cả bản trích |
| Q7 | Ảnh: có OCR hay nhờ AI mô tả ảnh không? | Bản đầu không. Ảnh được tìm theo alt text, chú thích và tên file. "Nhờ AI mô tả ảnh" (run `docassist` trên máy người bấm) để P3 | OCR trên hub cần thư viện nặng (Tesseract) và CPU |
| Q8 | File lớn và Git LFS? | Hub chỉ dùng LFS khi repo **đã** có quy tắc LFS trong `.gitattributes` khớp file đó; hub không tự bật LFS. Trần một file đính kèm `HIVE_DOC_ASSET_MAX_BYTES`, mặc định 50 MiB. Repo không bật LFS thì từ chối file trên 50 MiB và gợi ý bật LFS | Hub tự bật LFS thì phải sửa `.gitattributes` của repo, ảnh hưởng mọi người clone repo |
| Q9 | File có dấu hiệu bí mật lúc nhập: chặn hay nhập kèm xác nhận? | Chặn file đó. Danh sách chỉ hiện loại bí mật và số dòng, không hiện giá trị. Quản trị dự án bấm "Không phải bí mật, vẫn nhập" từng file (ghi audit). Báo rằng bí mật đã nằm trong lịch sử git, cần thu hồi | Nhập kèm che thì nội dung hub khác repo, lần đồng bộ sau sẽ ghi đè hoặc xung đột |
| Q10 | Tài liệu đã có trên hub nhưng chưa có nhà (tạo trước spec này, nhập từ hệ cũ bằng `import:legacy`): xử lý thế nào khi bật nhà? | Không tự đẩy. Quản trị bấm "Đưa tài liệu hub vào repo", xem trước danh sách đường dẫn rồi mới đẩy, qua một PR riêng | Tự đẩy thì có thể ghi nhầm vào repo khi đường dẫn trùng file có sẵn |
| Q11 | Mẫu file mặc định khi quét nhập? | Lấy: `docs/**`, `doc/**`, `specs/**`, `adr/**`, `**/adr/**`, `**/README.md`, `*.md` ở gốc. Bỏ: `node_modules/**`, `vendor/**`, `.git/**`, `.github/**`, `.claude/**`, `.hive/**`, `**/CHANGELOG.md`, `**/LICENSE*`, đường dẫn do SDLC sync quản lý và kho skill. Sửa được trước khi nhập | Lấy rộng hơn thì nhập nhầm file sinh tự động |
| Q12 | Tìm theo nghĩa dùng nhà cung cấp embedding nào? | Dùng chung cấu hình của memory (`HIVE_EMBEDDINGS_URL`, model, số chiều). Chưa cấu hình thì chỉ tìm theo từ. Tài liệu có dấu hiệu bí mật hoặc gắn nhãn `confidential` trong front-matter không gửi đi embedding | Nhà cung cấp riêng cho tài liệu thì thêm biến môi trường và bảng cột riêng |

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code ngày 2026-10-15 trên `main` tại `9d45128c`. Chi tiết và đường dẫn ở [research.md](research.md) mục 1.

| Phần | Đã có | Dùng thế nào trong spec này |
|---|---|---|
| Bảng `docs`, `doc_versions` (knowledge) | Key theo phạm vi `org/…`, `team/<slug>/…`, `project/<key>/…`. Phiên bản append-only. `VERSION_CONFLICT` khi `current_version` khác `baseVersion` (`docs.ts` `applyDocSave`) | **Dùng lại.** Mở rộng `doc_versions` thêm `content_hash`, `source` (`hub`/`repo`/`import`), `repo_commit`. Thêm `docs.archived_at` cho thao tác "Lưu trữ" (FR-024) |
| Quyền tài liệu (`knowledge/access.ts`) | `canRead`, `authorize` với `propose`/`manage`, phạm vi theo tiền tố key | **Dùng lại** cho đọc và sửa. Thêm quyền cấu hình nhà (quản trị dự án hoặc tổ chức) |
| Editor (`packages/doc-editor`, `knowledge/editor.ts`) | Markdown là định dạng lưu. Khối không sửa ghi lại nguyên văn. Front-matter giữ nguyên dạng khối thô. Bản nháp chung, gợi ý, bình luận, snapshot, gửi duyệt. **Chưa có** ảnh, tải file, link tương đối | **Dùng lại.** Mở rộng: nút ảnh, tải lên, phân giải link tương đối qua `env`, nhãn trạng thái đồng bộ |
| Hợp ba bên `mergeBlocks` (`contracts/src/doc-text.ts`) | Hợp theo khối khi bản nháp đổi | **Dùng lại** để tự hợp thay đổi hub và repo không chồng nhau |
| Quy trình duyệt tài liệu (`reviews.ts`) | Đề xuất, cổng AI/người/quy tắc, `no-secrets` | **Dùng lại**: sửa trên hub vẫn qua duyệt như cũ. Bản trích file đính kèm cũng qua duyệt |
| SDLC sync (spec 011 T040, `sdlc/sync.ts`) | Đẩy tài liệu hạng mục SDLC vào repo theo `pr`/`direct`/`off`, PR cuốn chiếu, commit status, merge queue, kéo về khi push và cron 15 phút, so hash, bỏ commit của hub. Bảng `sdlc_artifact_syncs`. Repo đổi thì thành đề xuất | **Dùng lại cách làm**, không dùng lại code trực tiếp (gắn chặt với hạng mục). Tài liệu SDLC (`project/<key>/sdlc/…`) và đường dẫn trong `sdlc_artifact_syncs` **không** thuộc spec này để không đồng bộ hai lần |
| Kho skill (spec 006, `skill-repo.ts`) | Repo riêng mỗi tổ chức, webhook `/hooks/skills/:repoId`, đồng bộ hai chiều, git thắng khi trùng | **Dùng lại cách làm** cho repo tài liệu tổ chức (webhook riêng, bảng repo của tổ chức). Chính sách xung đột **khác**: hỏi người |
| `GitProvider` (scm) | `branchHead`, `listFiles`, `readFile` (chỉ chuỗi UTF-8), `commitFiles` (chỉ thêm/sửa file chữ), `openPR`, `mergePR`, `setCommitStatus`, `addWebhook`, `canPush`. Webhook `push` chỉ có `{branch, sha}` | **Mở rộng**: đọc file nhị phân, xoá và đổi tên trong commit, ghi nhị phân, so sánh hai commit, tải archive, Git LFS |
| BlobStore (spec 012 T062) | **Chưa làm.** Chỉ có cột `artifact_versions.blob_id` và giới hạn `maxBlobBytes` | **Làm mới** ở `platform` (bytea chia đoạn, theo đúng thiết kế T062) để artifact dùng chung |
| Bộ quét bí mật | `scanSecrets` (`contracts/src/secret-scan.ts`), quy tắc `no-secrets` của review | **Dùng lại** khi nhập, khi lưu, khi kéo từ repo, trước khi gửi embedding |
| Tìm kiếm | Memory: tsvector + pgvector + RRF (`memory.ts`), job `knowledge-embed`. Tài liệu: chỉ lọc tiêu đề và key ở client | **Làm mới** chỉ mục đoạn cho tài liệu theo cách của memory |
| Nhập từ hệ cũ (`legacy-import.ts`) | Đọc SQLite hệ cũ, bảng `legacy_imports`, `legacy_doc_assets` | Không dùng lại. Tài liệu đã nhập theo cách này là "chưa có nhà" (Q10) |
| Màn desktop "Soạn tài liệu" | Dùng `DocEditor` chung, đọc tài liệu hub | Tự có tính năng mới qua package chung. Thêm nhãn đồng bộ |
| Màn desktop "Tài liệu từ code" | Chat CLI tại máy, nháp localStorage, gửi đề xuất lên hub, sửa file trong thư mục dự án | Không đổi luồng. File sửa tại máy đi vào repo bằng git của người dùng, rồi về hub qua đồng bộ (US3) |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Nhập tài liệu cũ từ repo dự án (Priority: P1)

Quản trị dự án mở **Tài liệu → Nhập từ repo**. Hub quét repo của dự án ở nhánh mặc định, hiện danh sách file theo thư
mục với số lượng, dung lượng và cảnh báo. Người dùng chỉnh mẫu lấy/bỏ, bỏ chọn file không cần rồi bấm **Nhập**. Hub nhập
nền, hiện tiến độ, cuối cùng hiện báo cáo. Tài liệu nhập xong đọc được trên hub và có nhà là repo dự án.

**Why this priority**: không có tài liệu cũ thì hub không thay được repo làm nơi soạn chính.

**Independent Test**: dự án nối repo giả (provider `memory`) có 2.000 file markdown, 50 ảnh, 3 file PDF, 1 file có token
giả, 1 file 300.000 ký tự. Quét, nhập, kiểm báo cáo và dữ liệu trên hub.

**Acceptance Scenarios**:

1. **Given** dự án đã nối repo, **When** quản trị bấm "Quét", **Then** hub hiện cây file khớp mẫu mặc định (Q11):
   tổng số file, dung lượng, số file markdown, ảnh, file khác, và từng cảnh báo ("có dấu hiệu bí mật", "quá lớn",
   "trùng key có sẵn", "do SDLC quản lý, bỏ qua").
2. **Given** bản xem trước, **When** quản trị bấm "Nhập", **Then** mỗi file markdown thành một tài liệu hub:
   - key suy từ đường dẫn;
   - tiêu đề lấy theo thứ tự: front-matter `title`, rồi tiêu đề `#` đầu tiên, rồi tên file;
   - phiên bản 1 có nguồn `import`, commit nguồn và hash.
3. **Given** đang nhập, **When** hub khởi động lại hoặc hết hạn mức API, **Then** lần chạy tiếp tục từ file chưa xong,
   không nhập trùng.
4. **Given** file markdown có ảnh `![](./img/a.png)`, **When** nhập xong, **Then** ảnh nằm trong kho file, editor hiện
   được ảnh, nội dung markdown giữ nguyên đường dẫn tương đối.
5. **Given** file có dấu hiệu bí mật, **When** nhập, **Then** file đó không được nhập. Báo cáo ghi loại bí mật và số
   dòng (không ghi giá trị), kèm nút "Không phải bí mật, vẫn nhập" (Q9).
6. **Given** nhập lại sau khi repo đã đổi, **When** quét, **Then** file đã nhập và chưa đổi hiện "đã có". File đổi đi
   theo luồng đồng bộ (US3), không nhập thành tài liệu thứ hai.

---

### User Story 2 - Soạn trên hub, ghi vào repo (Priority: P1)

Người soạn sửa hoặc tạo tài liệu trên web hay desktop. Khi lưu thành phiên bản (lưu thẳng hoặc đề xuất được duyệt), hub
gom thay đổi rồi ghi vào đúng thư mục nhà trong repo, theo chế độ của nhà: `pr` (PR cuốn chiếu) hoặc `direct` (commit
thẳng). Tài liệu hiện trạng thái đồng bộ và link tới PR hoặc commit.

**Why this priority**: chủ dự án yêu cầu git là bản lưu bền của mọi tài liệu, kể cả tài liệu tạo trên hub.

**Independent Test**: dự án chế độ `pr`. Lưu 3 tài liệu trong 30 giây, được một PR có 1 commit chứa 3 file. Lưu thêm 1
tài liệu khi PR còn mở, PR có thêm 1 commit. Merge PR, mọi tài liệu chuyển "Đã đồng bộ".

**Acceptance Scenarios**:

1. **Given** tài liệu `project/shop/huong-dan/cai-dat` mới tạo trên hub, **When** lưu, **Then** sau thời gian gom (Q5)
   repo có file `docs/huong-dan/cai-dat.md`. Commit có trailer `Hive-Doc-Sync: <lô>` và `Co-authored-by` của người
   soạn.
2. **Given** chế độ `pr`, **When** có lô mới, **Then** hub đẩy commit lên nhánh `hive/docs-sync-<nhà>` và mở hoặc cập nhật một
   PR. PR có commit status `xdev-hive/docs` = success. Hub đưa PR vào hàng merge nếu cài đặt merge của dự án cho phép.
   Không cho thì chờ người merge.
3. **Given** chế độ `direct`, **When** có lô mới, **Then** hub commit thẳng vào nhánh mặc định. Nhánh có bảo vệ (lỗi
   403/422) thì lô thất bại với lỗi rõ ràng và gợi ý chuyển sang `pr`.
4. **Given** người dùng lưu trữ hoặc di chuyển tài liệu trên hub (FR-024), **When** đồng bộ, **Then** commit xoá file
   hoặc đổi tên file (giữ lịch sử git khi provider hỗ trợ "move").
5. **Given** tài liệu có ảnh mới tải lên, **When** đồng bộ, **Then** ảnh nằm ở `<thư mục nhà>/assets/` cùng commit với
   tài liệu, markdown trỏ tới ảnh bằng đường dẫn tương đối.
6. **Given** đồng bộ lỗi (mạng, hết hạn mức, mất quyền), **When** hub thử lại theo lịch rồi vẫn lỗi, **Then** tài liệu
   hiện "Lỗi đồng bộ". Quản trị nhận thông báo và có nút "Thử lại". Nội dung trên hub không mất.

---

### User Story 3 - Repo đổi thì hub cập nhật, xung đột thì hỏi người (Priority: P1)

Ai đó sửa file tài liệu trong repo (PR merge, push, sửa tại máy qua "Tài liệu từ code"). Hub nhận webhook push hoặc tự
quét định kỳ, rồi cập nhật tài liệu tương ứng. Cả hub và repo cùng sửa một tài liệu thì hub thử hợp theo khối. Không hợp
được thì tạo **xung đột** và hỏi người.

**Why this priority**: không có chiều này thì hub và repo lệch nhau, mất lý do lưu ở git.

**Independent Test**: provider `memory`. Push sửa file đã đồng bộ, hub có phiên bản mới nguồn `repo`. Sửa cùng một khối
trên hub (chưa đẩy) và trong repo, hub tạo xung đột. Giải quyết bằng "Giữ bản repo", "Giữ bản hub" và "Sửa tay".

**Acceptance Scenarios**:

1. **Given** file đã đồng bộ, hub không đổi từ lần đồng bộ cuối, **When** repo đổi file, **Then** hub tạo phiên bản mới
   nguồn `repo`, ghi commit và tác giả commit (Q4).
2. **Given** hub và repo cùng đổi nhưng khác khối, **When** kéo về, **Then** hub hợp bằng `mergeBlocks`, tạo phiên bản
   hợp và đưa vào lô đẩy kế tiếp.
3. **Given** hub và repo cùng đổi một khối, **When** kéo về, **Then** tài liệu chuyển "Xung đột":
   - người có quyền `manage` nhận thông báo;
   - màn xung đột hiện ba bản (gốc chung, hub, repo) và chỗ khác nhau;
   - người dùng chọn giữ bản hub, giữ bản repo, hoặc sửa tay rồi lưu;
   - kết quả thành phiên bản mới và được đẩy lại vào repo.
4. **Given** đang có xung đột, **When** có thêm thay đổi ở repo, **Then** xung đột cập nhật bản repo mới nhất, không tạo
   xung đột thứ hai.
5. **Given** commit do chính hub tạo (trailer `Hive-Doc-Sync`, hoặc hash trùng một phiên bản hub), **When** kéo về,
   **Then** hub bỏ qua, không tạo phiên bản lặp.
6. **Given** file bị xoá trong repo, **When** kéo về, **Then** tài liệu chuyển "Đã xoá trên repo" và chưa bị xoá trên
   hub. Người có quyền chọn "Lưu trữ tài liệu" hoặc "Ghi lại vào repo".
7. **Given** file markdown mới xuất hiện trong thư mục nhà hoặc khớp mẫu đã nhập, **When** kéo về, **Then** hub tạo tài
   liệu mới nguồn `repo`.

---

### User Story 4 - Repo tài liệu của tổ chức và đội (Priority: P2)

Quản trị tổ chức chọn một repo tài liệu (có sẵn, hoặc hub tạo `org-docs`). Tài liệu `org/…` nằm ở `org/`, tài liệu
`team/<slug>/…` nằm ở `teams/<slug>/` (Q2, Q3). Đồng bộ chạy như US2 và US3, mặc định `direct` (Q1).

**Why this priority**: tài liệu chung (quy trình, quy ước) cũng phải có bản lưu git, nhưng ít hơn tài liệu dự án.

**Independent Test**: tổ chức chọn repo giả, nhập tài liệu có sẵn trong repo, tạo một tài liệu đội trên hub, kiểm file
`teams/<slug>/…` xuất hiện. Thành viên đội khác không đọc được tài liệu đội đó trên hub.

**Acceptance Scenarios**:

1. **Given** tổ chức chưa có repo tài liệu, **When** quản trị chọn "Tạo repo mới", **Then** hub tạo repo riêng tư qua
   kết nối Git, thêm webhook, commit `README.md` mô tả bố cục.
2. **Given** chọn repo có sẵn, **When** lưu, **Then** hub kiểm quyền đọc và ghi của kết nối. Thiếu quyền thì báo lỗi
   trước khi lưu.
3. **Given** repo tài liệu tổ chức trùng repo kho skill, **When** chọn, **Then** hub chỉ cho phép khi hai bên không
   dùng chung thư mục.
4. **Given** file trong `teams/<slug>/` mà slug không khớp đội nào, **When** kéo về, **Then** file không được nhập. Màn
   trạng thái ghi "Đội không tồn tại".

---

### User Story 5 - Ảnh và đính kèm (Priority: P2)

Editor hiện ảnh trong tài liệu (đường dẫn tương đối trong repo, hoặc ảnh tải lên). Người soạn kéo thả hoặc dán ảnh, chọn
file đính kèm. Hub lưu file gốc trong kho file và ghi vào repo cạnh tài liệu. File lớn dùng Git LFS khi repo đã bật
(Q8).

**Why this priority**: tài liệu cũ chủ yếu có ảnh và đính kèm. Không hiện được thì tài liệu nhập về không đọc được.

**Independent Test**: tài liệu có `![](../assets/so-do.png)` và `[Biên bản](files/bien-ban.pdf)`. Editor hiện ảnh, link
PDF mở được. Dán ảnh mới, lưu, kiểm file trong `docs/assets/` và markdown trỏ đúng.

**Acceptance Scenarios**:

1. **Given** markdown có ảnh hoặc link tương đối, **When** mở trong editor, **Then** hub phân giải theo đường dẫn file
   tài liệu trong repo và trả file từ kho file. Nội dung markdown giữ nguyên.
2. **Given** link tương đối tới một file `.md` khác đã nhập, **When** bấm, **Then** mở tài liệu hub tương ứng.
3. **Given** dán ảnh 2 MB, **When** lưu, **Then** markdown thêm `![](assets/<tên>.png)` (đường dẫn tương đối từ file
   tài liệu). Ảnh vào kho file và vào lô đồng bộ kế tiếp.
4. **Given** repo có `.gitattributes` với `*.psd filter=lfs`, **When** tải file `.psd` 80 MB, **Then** hub đẩy đối tượng
   LFS rồi commit con trỏ LFS.
5. **Given** repo không bật LFS và file vượt `HIVE_DOC_ASSET_MAX_BYTES`, **When** tải lên, **Then** hub từ chối với lỗi
   tiếng Việt, gợi ý bật LFS.
6. **Given** file trong repo là con trỏ LFS, **When** nhập hoặc kéo về, **Then** hub tải đối tượng thật qua LFS. Không
   tải được thì ghi "Thiếu đối tượng LFS" và vẫn giữ con trỏ.

---

### User Story 6 - Trích nội dung file không phải markdown, có duyệt (Priority: P2)

File Word, PDF, Excel, PowerPoint trong repo (hoặc tải lên) được giữ nguyên trong kho file. Hub trích nội dung sang
markdown. Người có quyền xem bản trích, sửa nếu cần, rồi duyệt. Chỉ bản trích đã duyệt mới được đưa vào tìm kiếm và cho
agent đọc.

**Why this priority**: có tài liệu chỉ nằm trong Word/PDF. Không trích được thì agent không đọc được.

**Independent Test**: nhập repo có `.docx`, `.pdf` có lớp chữ, `.pdf` chỉ là ảnh quét, `.xlsx` 3 sheet. Kiểm ba file
đầu có bản trích chờ duyệt, PDF quét báo "Không có chữ để trích". Duyệt một bản trích, tìm thấy nó, agent đọc được qua
MCP.

**Acceptance Scenarios**:

1. **Given** file `.docx`, `.pdf`, `.xlsx`, `.pptx` trong phạm vi nhập, **When** nhập, **Then** file gốc vào kho file.
   Một job trích chạy nền, cho ra bản trích trạng thái "Chờ duyệt".
2. **Given** bản trích chờ duyệt, **When** người có quyền `manage` duyệt (có thể sửa trước), **Then** bản trích được
   đưa vào chỉ mục và đọc được qua MCP. Từ chối thì không dùng.
3. **Given** file gốc đổi trong repo, **When** kéo về, **Then** hub trích lại. Bản trích cũ đã duyệt vẫn dùng tới khi
   bản mới được duyệt. Bản mới hiện khác biệt so với bản cũ.
4. **Given** bản trích có dấu hiệu bí mật, **When** trích xong, **Then** bản trích bị chặn duyệt tới khi người dùng
   xác nhận (như Q9).
5. **Given** file hỏng, có mật khẩu, hoặc vượt giới hạn trích, **When** trích, **Then** bản trích "Lỗi" kèm lý do.
   Nhập tài liệu khác vẫn tiếp tục.

---

### User Story 7 - Tìm theo nghĩa trên hub và cho agent (Priority: P2)

Người dùng gõ câu hỏi trong ô tìm tài liệu (web, desktop). Hub trả các đoạn liên quan theo nghĩa và theo từ, chỉ trong
tài liệu người đó được đọc. Agent trong run dùng tool MCP `doc_search`.

**Why this priority**: tìm theo nghĩa là một lý do chính để đưa tài liệu lên hub.

**Independent Test**: 500 tài liệu đã nhập. Tìm "cách triển khai lên máy chủ" ra đoạn trong `docs/deploy.md` dù không
trùng từ. Người ngoài đội không thấy kết quả từ tài liệu đội.

**Acceptance Scenarios**:

1. **Given** đã cấu hình embedding (Q12), **When** tìm, **Then** kết quả là các đoạn kèm tiêu đề tài liệu, đường dẫn
   tiêu đề mục, đường dẫn repo. Thứ hạng hợp từ hai cách (từ và nghĩa).
2. **Given** chưa cấu hình embedding, **When** tìm, **Then** chỉ tìm theo từ, giao diện ghi "Đang tìm theo từ".
3. **Given** agent trong run, **When** gọi `doc_search`, **Then** chỉ trả tài liệu thuộc phạm vi run được đọc
   (`canRead` cho run).
4. **Given** tài liệu vừa lưu hoặc vừa kéo về, **When** chờ job chỉ mục, **Then** kết quả tìm dùng nội dung mới.

---

### User Story 8 - Quản trị đồng bộ (Priority: P3)

Quản trị dự án và tổ chức xem trạng thái của từng nhà:
- commit đã đồng bộ cuối;
- PR đang mở;
- số tài liệu theo từng trạng thái;
- lỗi gần nhất.

Quản trị có thể tạm dừng hoặc bật lại, bấm "Đồng bộ ngay", xử lý khi nhánh mặc định đổi.

**Why this priority**: vận hành. Thiếu màn này vẫn dùng được nhưng khó gỡ lỗi.

**Independent Test**: đổi nhánh mặc định của repo giả. Hub tạm dừng nhà, báo quản trị. Quản trị xác nhận nhánh mới,
đồng bộ chạy tiếp.

**Acceptance Scenarios**:

1. **Given** nhánh mặc định đổi, **When** hub phát hiện (webhook hoặc quét), **Then** nhà chuyển "Tạm dừng: nhánh mặc
   định đổi". Quản trị chọn "Dùng nhánh mới" thì hub so lại toàn bộ với nhánh mới, rồi chạy tiếp.
2. **Given** kết nối Git mất quyền hoặc repo bị lưu trữ (archived), **When** đồng bộ, **Then** nhà chuyển "Lỗi quyền".
   Sửa trên hub vẫn lưu được, các lô chờ tới khi có quyền lại.
3. **Given** nhà đang tạm dừng, **When** người dùng lưu tài liệu, **Then** tài liệu hiện "Chờ đồng bộ (đang tạm dừng)".

### Edge Cases

- **Nhập lần đầu hàng nghìn file**:
  - Hub tải một archive của repo (giới hạn theo thư mục khi provider hỗ trợ) thay cho đọc từng file, để không hết hạn
    mức API.
  - Job chia theo lô 200 file, chạy tiếp được sau lỗi, theo `retryAfterMs`.
  - Cây file quá lớn (GitHub `truncated`) thì duyệt theo thư mục.
  - Mục tiêu: 5.000 file markdown trong 15 phút (SC-001).
- **Đổi tên hoặc di chuyển file trong repo**:
  - Hub dùng API so sánh commit của provider (trạng thái `renamed`). Không có thông tin đó thì ghép file mất và file mới
    theo hash nội dung, rồi theo độ giống (≥ 0,8).
  - Đổi tên thì giữ nguyên tài liệu (id, key, lịch sử), chỉ đổi đường dẫn repo.
  - Không ghép được thì xử lý như một file bị xoá và một file mới.
- **Đổi tên trên hub**: đổi đường dẫn repo, commit "move". Key giữ nguyên để link `doc_get` và `![[key]]` không gãy.
- **Link tương đối và ảnh**:
  - Nội dung lưu nguyên văn. Phân giải lúc hiển thị theo đường dẫn repo của tài liệu.
  - Link ra ngoài thư mục nhà vẫn phân giải nếu file đó đã được nhập. Không thì hiện link tới file trên GitHub/GitLab.
  - Đổi tên file ảnh trong repo thì link trong tài liệu khác gãy như trong repo. Hub báo "link gãy" ở màn trạng thái,
    không tự sửa nội dung.
- **Front-matter YAML**:
  - Giữ nguyên văn và ghi lại không đổi.
  - Hub đọc `title`, `tags`, `confidential`, `hive.key` (ghim key khi nhập).
  - Front-matter sai cú pháp thì vẫn nhập, ghi cảnh báo, tiêu đề lấy theo cách khác.
- **Key suy từ đường dẫn**:
  - Key chỉ nhận chữ thường không dấu (`docKey`). `Thiết kế/API.md` thành `thiet-ke/api`.
  - Trùng key thì thêm hậu tố `-2`, `-3`.
  - Dài quá 200 ký tự thì cắt và thêm 8 ký tự hash.
  - Bảng ánh xạ giữ đường dẫn thật.
- **Trùng với tài liệu hub đã có** (cùng key, chưa có nhà): bản xem trước nhập hiện "trùng". Quản trị chọn: gắn tài
  liệu hub vào file (ghi bản nào làm phiên bản mới), đổi key, hoặc bỏ qua.
- **Nhánh mặc định đổi**: xem US8. Không tự đổi để không ghi nhầm nhánh.
- **Repo đổi tên hoặc chuyển chủ**: hub cập nhật owner/name từ `getRepo` khi provider chuyển hướng. Mất dấu repo thì
  xử lý như "Lỗi quyền".
- **Quyền repo**:
  - Hub đọc và ghi bằng kết nối Git của dự án hoặc tổ chức (GitHub App hoặc token), không bằng tài khoản từng người.
  - Người sửa trên hub chỉ cần quyền hub. Commit ghi `Co-authored-by` của họ.
  - Repo riêng tư nhập vào hub thì tài liệu theo quyền hub. Màn cấu hình cảnh báo khi phạm vi đọc trên hub rộng hơn trên
    repo (ví dụ tài liệu tổ chức đọc được bởi mọi thành viên tổ chức).
- **File lớn**:
  - Markdown trên `DOC_MAX_CHARS` (200.000 ký tự) thì không mở được trong editor. Hub lưu như đính kèm chỉ đọc, ghi "Quá
    lớn để soạn trên hub", vẫn chia đoạn để tìm.
  - Đính kèm vượt `HIVE_DOC_ASSET_MAX_BYTES` thì chỉ ghi đường dẫn và kích thước, link sang repo.
  - GitHub Contents API không trả nội dung file trên 1 MB, nên đọc nhị phân qua Git Blobs API ([research.md](research.md)
    mục 2).
- **Bí mật trong tài liệu**:
  - Dùng `scanSecrets` khi nhập, khi kéo từ repo, khi lưu trên hub và trước khi gửi embedding.
  - Kéo từ repo mà có bí mật: phiên bản vẫn tạo để không lệch repo, nhưng tài liệu gắn cờ "Có dấu hiệu bí mật". Tài liệu
    bị loại khỏi embedding và khỏi `doc_get`/`doc_search` của agent tới khi người xác nhận hoặc sửa.
  - Lưu trên hub mà có bí mật thì từ chối lưu (lỗi kèm loại và số dòng), trừ khi người có quyền `manage` xác nhận.
  - Hub không bao giờ đẩy một phiên bản đang bị chặn vì bí mật vào repo.
- **CRLF, BOM, dòng cuối**: giữ kiểu xuống dòng và BOM của file gốc khi ghi lại. File mới dùng LF, có dòng trống cuối.
- **Mã hoá không phải UTF-8**: file không đọc được bằng UTF-8 thì coi là file nhị phân, không nhập thành tài liệu.
- **Đường dẫn do hệ khác quản lý**: thư mục SDLC (`sdlc_artifact_syncs`, `docsRoot` của SDLC), kho skill,
  `.hive/`, `.claude/`, `AGENTS.md`, `CLAUDE.md` không thuộc đồng bộ tài liệu.
- **PR cuốn chiếu bị xung đột merge** (repo đổi cùng file khi PR còn mở): hub kéo về và xử lý theo US3. Sau đó hub dựng
  lại nhánh `hive/docs-sync-<nhà>` từ đầu nhánh mặc định mới: đóng PR cũ, mở PR mới, ghi link PR cũ.
- **PR cuốn chiếu bị đóng tay không merge**: hub coi các phiên bản trong đó "Chưa đồng bộ", báo quản trị, không tự mở
  lại ngay mà chờ lô kế tiếp hoặc nút "Đồng bộ ngay".
- **Hai nhà trỏ cùng repo và thư mục chồng nhau** (dự án A và dự án B dùng chung repo): chặn lúc cấu hình.
- **Xoá dự án hoặc gỡ nhà**: tài liệu ở lại hub ("chưa có nhà"). Hub không xoá file trong repo.
- **Webhook về trước phản hồi API commit**: nhận ra commit của hub bằng trailer và hash, không tạo phiên bản lặp.

## Requirements *(mandatory)*

### Functional Requirements

**Nhà của tài liệu và cấu hình**

- **FR-001**: Mỗi tài liệu có một nhà gồm: kết nối Git, repo, nhánh, thư mục gốc, chế độ (`pr` | `direct` | `off`).
  Tài liệu dự án dùng repo của dự án. Tài liệu tổ chức và đội dùng repo tài liệu của tổ chức (Q2, Q3).
- **FR-002**: Cài đặt nhà dự án nằm trong `projects.settings.docs`:
  - `root` (mặc định `docs/`), `repoSync` (mặc định `pr`);
  - `include`, `exclude` (mặc định Q11), `assetsDir` (mặc định `assets`);
  - `repoChangesNeedReview` (mặc định `false`, Q4).
  Trường mới có `.default()` để dòng cũ vẫn parse.
- **FR-003**: Quản trị tổ chức chọn hoặc tạo repo tài liệu tổ chức (kết nối, owner, tên, nhánh, chế độ mặc định
  `direct`). Hub kiểm quyền đọc và ghi, thêm webhook push. Mỗi tổ chức một repo ở bản đầu.
- **FR-004**: Hub chặn cấu hình khi hai nhà dùng chung repo với thư mục chồng nhau, hoặc chồng lên thư mục của SDLC
  sync hay kho skill.
- **FR-005**: Chỉ quản trị dự án (nhà dự án) và quản trị tổ chức (nhà tổ chức) sửa được cấu hình nhà. Mọi thay đổi ghi
  audit.

**Nhập**

- **FR-006**: Hub quét repo ở commit đầu nhánh, trả bản xem trước theo mẫu lấy/bỏ:
  - cây thư mục;
  - loại file (markdown, ảnh, tài liệu văn phòng, khác), kích thước;
  - cảnh báo: bí mật, quá lớn, trùng key, do hệ khác quản lý, LFS, không phải UTF-8.
- **FR-007**: Nhập chạy nền trên pg-boss, theo lô, idempotent theo `(nhà, đường dẫn, blob sha)`, chạy tiếp được. Tiến
  độ và báo cáo lưu trong bảng nhập, xem được trên web.
- **FR-008**: Nhập lần đầu dùng archive của repo khi số file cần đọc vượt ngưỡng (mặc định 100). Dưới ngưỡng thì đọc
  từng file.
- **FR-009**: Mỗi file markdown thành một tài liệu:
  - key suy từ đường dẫn so với gốc của phạm vi (FR-001), theo quy tắc ở Edge Cases;
  - tiêu đề theo thứ tự front-matter `title`, `#` đầu, tên file;
  - phiên bản 1 nguồn `import`.
  File ngoài thư mục nhà (ví dụ `specs/…`, `README.md`) giữ nguyên đường dẫn của chúng.
- **FR-010**: File bị chặn vì bí mật không được nhập. Quản trị xác nhận từng file mới nhập được. Xác nhận ghi audit
  (Q9).
- **FR-011**: Tài liệu hub đã có, chưa có nhà, được đưa vào repo bằng thao tác "Đưa tài liệu hub vào repo". Thao tác có
  xem trước đường dẫn và đi qua một PR riêng (Q10).

**Hub → repo**

- **FR-012**: Mỗi phiên bản mới trên hub (lưu thẳng, đề xuất được duyệt, giải quyết xung đột, hợp tự động) của tài liệu
  có nhà và chế độ khác `off` được đưa vào hàng đẩy của nhà đó. Phiên bản có nguồn `repo` thì không.
- **FR-013**: Hub gom các phiên bản theo nhà (Q5) thành một lô, ghi một commit gồm: thêm, sửa, xoá, đổi tên file
  markdown, và đính kèm mới (nhị phân hoặc con trỏ LFS). Commit message tiếng Anh, có trailer
  `Hive-Doc-Sync: <lô>` và `Co-authored-by` của từng người soạn có email.
- **FR-014**: Chế độ `pr`:
  - đẩy lên nhánh `hive/docs-sync-<nhà>`, mở hoặc cập nhật một PR. Mỗi nhà một nhánh; `<nhà>` là key dự án hoặc `org`,
    để hai nhà chung một repo không đụng nhánh;
  - đặt commit status `xdev-hive/docs` = success;
  - đưa vào hàng merge khi cài đặt merge của dự án cho phép, không thì chờ người merge.
  Chế độ `direct`: commit thẳng vào nhánh.
- **FR-015**: Lô lỗi được thử lại theo lịch 1, 2, 5, 10, 20, 30 phút (như SDLC sync), theo `retryAfterMs` khi bị giới
  hạn. Hết lượt thì báo người có quyền cấu hình nhà. Nút "Thử lại" chạy lại ngay.
- **FR-016**: Hub không đẩy phiên bản bị chặn vì bí mật. Hub không ghi đè file repo đã đổi kể từ lần đồng bộ cuối mà
  chưa kéo về (kiểm hash file ở đầu nhánh trước khi commit).

**Repo → hub**

- **FR-017**: Hub nhận webhook push trên nhánh của nhà:
  - nhà dự án: handler `push` qua `onScmEvent`;
  - nhà tổ chức: route webhook riêng `/hooks/docs/:homeId`, kiểm chữ ký như kho skill.
  Hub gom các push trong 30 giây. Ngoài ra có cron 15 phút cho nhà không có webhook hoặc lỡ sự kiện.
- **FR-018**: Hub so sánh commit đã đồng bộ cuối với commit mới bằng API so sánh của provider: thêm, sửa, xoá, đổi tên.
  Khi API báo kết quả không đầy đủ thì so hash toàn bộ thư mục.
- **FR-019**: Với mỗi file đổi:
  - hub không đổi kể từ lần đồng bộ cuối: tạo phiên bản nguồn `repo`, hoặc đề xuất nếu bật `repoChangesNeedReview`;
  - hub đổi khác khối: hợp tự động bằng `mergeBlocks`;
  - đụng cùng khối: tạo xung đột.
- **FR-020**: Xung đột lưu ba bản (gốc chung, hub, repo), mỗi tài liệu tối đa một xung đột đang mở. Trong lúc xung đột,
  tài liệu vẫn sửa được trên hub nhưng lô đẩy bỏ qua tài liệu này. Giải quyết (giữ hub, giữ repo, sửa tay) tạo phiên
  bản mới và đẩy vào repo.
- **FR-021**: File bị xoá trong repo thì tài liệu chuyển "Đã xoá trên repo". Người có quyền chọn lưu trữ trên hub hoặc
  ghi lại vào repo.
- **FR-022**: Hub bỏ qua commit của chính nó (trailer, hoặc hash trùng một phiên bản hub đã đẩy).

**Đổi tên, link, front-matter**

- **FR-023**: Đổi tên hoặc di chuyển file trong repo giữ nguyên tài liệu (id, key, lịch sử), chỉ đổi đường dẫn.
- **FR-024**: Đổi đường dẫn trên hub (thao tác "Di chuyển") ghi commit đổi tên. Key không đổi. Hub hiện chưa có thao tác
  xoá tài liệu (`docsContract` chỉ có `list`, `get`, `save`, `history`). Spec này thêm "Lưu trữ tài liệu" (cần quyền
  `manage`): tài liệu ẩn khỏi danh sách, tìm kiếm và MCP, lịch sử còn nguyên; lô đồng bộ xoá file trong repo. "Khôi
  phục" ghi lại file.
- **FR-025**: Link và ảnh tương đối được lưu nguyên văn và phân giải lúc hiển thị:
  - link tới file `.md` đã nhập → mở tài liệu hub;
  - link tới file trong kho file → hiện hoặc tải file;
  - còn lại → link tới file trên GitHub/GitLab.
  Màn trạng thái liệt kê link gãy.
- **FR-026**: Front-matter giữ nguyên văn. Hub đọc `title`, `tags`, `confidential`, `hive.key`. Sai cú pháp thì cảnh báo,
  không chặn.
- **FR-027**: Ghi lại vào repo giữ kiểu xuống dòng và BOM của file gốc.

**Kho file, đính kèm, LFS**

- **FR-028**: Kho file (BlobStore) dùng chung trong `platform`:
  - lưu bytea chia đoạn 512 KiB trong PostgreSQL, khoá theo sha256 để không lưu trùng trong một tổ chức;
  - bảng có `org_id`, bật và ép RLS;
  - giao diện cho phép thêm bản S3 sau mà không đổi nơi gọi (đúng thiết kế T062 của spec 012).
- **FR-029**: Đính kèm của tài liệu là một dòng gồm: nhà, đường dẫn repo, blob, loại MIME (kiểm magic bytes), kích
  thước, sha256, cờ LFS, trạng thái.
- **FR-030**: Tải lên qua editor (kéo thả, dán, chọn file). Ảnh mới lưu ở `<root>/<assetsDir>/`, tên file chuẩn hoá,
  trùng tên thì thêm hậu tố hash ngắn. Markdown chèn đường dẫn tương đối.
- **FR-031**: Hub đọc `.gitattributes` ở đầu nhánh. File khớp quy tắc `filter=lfs` được đẩy và tải qua Git LFS Batch
  API. Repo không bật LFS thì từ chối file vượt `HIVE_DOC_ASSET_MAX_BYTES` (Q8). Hạn mức kho file của tổ chức theo
  biến môi trường, mặc định 5 GiB.
- **FR-032**: Tải file từ kho file đi qua kiểm `canRead` của tài liệu chủ. File SVG và HTML luôn trả kèm
  `Content-Disposition: attachment` hoặc CSP chặn script.

**Trích nội dung**

- **FR-033**: Hub trích markdown từ `.docx`, `.pdf` có lớp chữ, `.xlsx`/`.csv` (mỗi sheet một bảng, tối đa 2.000 dòng
  mỗi sheet) và `.pptx` (chữ theo từng slide). Trích chạy trong job pg-boss, trong `worker_threads`, có giới hạn thời
  gian và bộ nhớ.
- **FR-034**: Bản trích có trạng thái `pending`, `review`, `approved`, `rejected`, `failed`. Chỉ `approved` vào chỉ mục
  tìm kiếm và trả cho agent. Người có quyền `manage` duyệt, sửa trước khi duyệt được.
- **FR-035**: Bản trích chỉ lưu ở hub, không ghi vào repo (Q6). File gốc đổi thì trích lại, giữ bản đã duyệt tới khi bản
  mới được duyệt.

**Tìm kiếm và agent**

- **FR-036**: Hub chia tài liệu và bản trích đã duyệt thành đoạn theo tiêu đề mục, khoảng 1.500 ký tự mỗi đoạn. Mỗi đoạn
  có tsvector, và embedding khi đã cấu hình (Q12). Chỉ mục cập nhật bằng job sau mỗi phiên bản.
- **FR-037**: API `docs.search` và tool MCP `doc_search` trả các đoạn theo thứ hạng hợp RRF của tìm theo từ và theo
  nghĩa, lọc bằng `canRead`.
- **FR-038**: Tài liệu bị cờ bí mật hoặc `confidential: true` không gửi đi embedding. Tài liệu bị cờ bí mật không trả cho
  agent tới khi được xác nhận.
- **FR-039**: Tool MCP `doc_asset_get` trả bản trích đã duyệt của một đính kèm theo đường dẫn.

**Giao diện**

- **FR-040**: Trang Tài liệu (web, desktop "Soạn tài liệu") có:
  - cây theo thư mục repo;
  - nhãn trạng thái đồng bộ: Đã đồng bộ, Chờ đồng bộ, PR #n đang mở, Xung đột, Lỗi, Đã xoá trên repo, Chưa có nhà;
  - link tới file và commit trên GitHub/GitLab.
- **FR-041**: Có các màn:
  - Nhập từ repo: quét, xem trước, chọn, tiến độ, báo cáo;
  - Xung đột: ba bản và chọn cách giải quyết;
  - Bản trích chờ duyệt;
  - Trạng thái nhà, trong cài đặt dự án và cài đặt tổ chức.
  Màn xung đột và nhãn trạng thái nằm trong `packages/doc-editor` để web và desktop dùng chung.
- **FR-042**: Editor hiện ảnh, tải lên ảnh và đính kèm, phân giải link tương đối qua `DocEditorEnv`.
- **FR-043**: Chữ giao diện và lỗi bằng tiếng Việt. Desktop có từ điển vi/en.

**Bảo mật, vận hành**

- **FR-044**: Mọi bảng mới có `org_id`, bật và ép RLS, đi qua `withTenant()`. Có test trong `rls.db.test.ts`.
- **FR-045**: Ghi audit cho: cấu hình nhà, nhập, xác nhận bí mật, giải quyết xung đột, duyệt bản trích, đồng bộ thủ
  công.
- **FR-046**: Thông báo (`notify`) cho: lô đồng bộ hỏng hết lượt, xung đột mới, nhà tạm dừng, nhập xong, file bị xoá
  trên repo, bản trích chờ duyệt.

### Key Entities

- **Nhà tài liệu (`doc_homes`)**:
  - phạm vi: `project` hoặc `org`;
  - kết nối, owner/name, nhánh, gốc, chế độ;
  - commit đã đồng bộ cuối, trạng thái (`active`, `paused`, `error`), lỗi;
  - webhook (nhà tổ chức).
- **Liên kết tài liệu–file (`doc_repo_files`)**:
  - tài liệu, nhà, đường dẫn repo;
  - phiên bản và commit và hash đã đồng bộ cuối, hash repo;
  - trạng thái (`synced`, `pending`, `conflict`, `failed`, `deleted_in_repo`, `blocked_secret`), kiểu xuống dòng, BOM.
- **Lô đồng bộ (`doc_sync_batches`)**: nhà, chế độ, nhánh, PR, các phiên bản, commit, số lần thử, lỗi, trạng thái.
- **Xung đột (`doc_conflicts`)**: tài liệu, phiên bản gốc, phiên bản hub, commit và nội dung repo, trạng thái, cách giải
  quyết, người giải quyết.
- **Lần nhập (`doc_imports`)**: nhà, commit, mẫu lấy/bỏ, bản xem trước, tiến độ, báo cáo, người bấm.
- **File của lần nhập (`doc_import_files`)**: lần nhập, đường dẫn repo, blob sha, loại, kích thước, cảnh báo, trạng
  thái, tài liệu hoặc đính kèm tạo ra, người xác nhận bí mật. Giúp nhập chạy tiếp được theo từng file.
- **Đính kèm (`doc_assets`)**: nhà, đường dẫn repo, blob, MIME, kích thước, sha256, LFS, trạng thái.
- **Bản trích (`doc_extracts`)**: đính kèm, nội dung markdown, trạng thái, người duyệt, blob sha nguồn.
- **Blob (`blobs`, `blob_chunks`)**: sha256, kích thước, MIME, các đoạn bytea. Dùng chung với artifact (spec 012).
- **Đoạn tìm kiếm (`doc_chunks`)**: tài liệu hoặc bản trích, phiên bản, đường dẫn tiêu đề mục, nội dung, tsvector,
  embedding.
- Mở rộng **`doc_versions`**: `content_hash`, `source`, `repo_commit`, `secret_flag`. Mở rộng **`docs`**:
  `archived_at`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Nhập 5.000 file markdown (tổng 100 MB) và 500 ảnh từ một repo giả trong ≤ 15 phút trên máy chủ dev. Số
  lời gọi API provider ≤ 50 ngoài phần tải archive.
- **SC-002**: Sau khi lưu trên hub, file xuất hiện trong repo (commit `direct` hoặc PR được cập nhật) trong ≤ 2 phút ở
  95% lần, khi provider không lỗi.
- **SC-003**: Sau một push vào nhánh mặc định có webhook, hub có phiên bản mới trong ≤ 1 phút ở 95% lần.
- **SC-004**: Đồng bộ một vòng (hub → repo → webhook → hub) không sinh phiên bản lặp: số phiên bản tăng đúng 1 cho mỗi
  lần lưu.
- **SC-005**: Mọi file markdown nhập vào rồi ghi lại không sửa đều giống từng byte với bản trong repo (round-trip). Test
  trên bộ mẫu ≥ 200 file thật lấy từ repo của dự án (đã bỏ bí mật).
- **SC-006**: Không có trường hợp hub ghi đè thay đổi của repo khi chưa kéo về. Test tranh chấp có kiểm.
- **SC-007**: Không file nào có dấu hiệu bí mật được nhập, đẩy vào repo hay gửi đi embedding mà không có xác nhận đã ghi
  audit.
- **SC-008**: Tìm theo nghĩa: trên bộ 50 câu hỏi mẫu, đoạn đúng nằm trong top 5 ở ≥ 80% câu khi đã cấu hình embedding.
- **SC-009**: Người dùng không có quyền đọc một tài liệu không thấy nó trong danh sách, tìm kiếm, MCP, file đính kèm
  hay báo cáo nhập.

## Assumptions

- Kết nối Git của tổ chức (GitHub App hoặc token, GitLab token) có quyền đọc và ghi nội dung repo, quyền webhook. Thiếu
  quyền thì cấu hình nhà báo lỗi.
- PostgreSQL vẫn là kho dữ liệu duy nhất (constitution VII). Kho file dùng bytea. S3 cần ADR riêng và để sau.
- Worker Go không đổi. Mọi thao tác với repo chạy ở hub qua API của provider.
- Không soạn cộng tác thời gian thực (Yjs vẫn chưa làm). Bản nháp chung và `DRAFT_CHANGED` như hiện nay.
- Tài liệu SDLC tiếp tục dùng SDLC sync (spec 011). Spec này không đổi hành vi đó.

## Out of Scope

- OCR ảnh và PDF quét. AI mô tả ảnh để P3 (Q7).
- Mỗi đội một repo tài liệu riêng (P3, Q3).
- Đồng bộ nhánh khác ngoài nhánh mặc định của nhà.
- Đồng bộ wiki của GitHub/GitLab, Confluence, Google Drive.
- Sửa file Word/Excel trên hub. Chỉ sửa bản trích (bản trích không quay ngược về file gốc).
- Commit đứng tên từng người trên provider (cần OAuth từng người). Commit đứng tên kết nối, kèm `Co-authored-by`.
