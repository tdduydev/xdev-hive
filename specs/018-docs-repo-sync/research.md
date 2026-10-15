# Research: tài liệu trên hub, nhập từ repo, đồng bộ hai chiều

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Quy ước nhãn:
- Dòng có đường dẫn `file:dòng` là đã đọc code ngày 2026-10-15 trên `main` tại `9d45128c`.
- **[Đã thử]**: chạy trực tiếp ngày 2026-10-15; môi trường, dữ liệu và giới hạn ở mục 6.
- **[Đối chiếu]**: đọc tài liệu chính thức, chưa chứng minh bằng repo thử có xác thực.
- **[Chưa kiểm]**: chưa đủ môi trường hoặc dữ liệu; mục 6 ghi kết quả **chưa rõ**, không coi là đã xác nhận.
- **[Suy luận]**: rút ra từ code hoặc từ tài liệu, chưa đo.

## 1. Hiện trạng trong repo

### 1.1 Tài liệu (module `knowledge`)

- **Bảng `docs`** (`apps/hub/src/modules/knowledge/schema.ts:98-120`):
  - cột `org_id`, `team_id`, `project_id`, `key`, `title`, `current_version`, người sửa cuối (người hoặc run), thời
    điểm;
  - unique `(org_id, key)`.
  - Không có cột nội dung, hash, embedding hay repo.
- **Bảng `doc_versions`** (`schema.ts:123-146`):
  - append-only: `version`, `title`, `content` (markdown), `message`, `proposal_id`, tác giả;
  - không có hash, không ghi nguồn.
- **Key** (`packages/contracts/src/knowledge.ts:118-131`):
  - regex `^(?:org|team\/[a-z0-9-]+|project\/[a-z0-9-]+)(?:\/[a-z0-9][a-z0-9._-]*)+$`, tối đa 200 ký tự;
  - `DOC_MAX_CHARS = 200_000`.
  - Key chỉ nhận chữ thường ASCII, nên đường dẫn repo (`Thiết kế/API.md`, `README.md`) không ánh xạ một-một được.
    **Kết luận**: cần bảng riêng giữ đường dẫn thật (`doc_repo_files.repo_path`). Key suy từ đường dẫn và không đổi
    khi file đổi tên.
- **Lưu và tranh chấp**:
  - `applyDocSave` (`knowledge/docs.ts:93-145`) cập nhật `WHERE current_version = baseVersion`, lệch thì
    `versionConflict()` (`knowledge/access.ts:213`) trả `VERSION_CONFLICT`.
  - Bản nháp dùng `revision` và lỗi `DRAFT_CHANGED` (`knowledge/editor.ts:71`).
- **Quyền** (`knowledge/access.ts`):
  - `canRead` (L77), `authorize(action: propose|manage)` (L160-179), `scopeOfDocKey` (L136);
  - hook `provideDocAccess` (L67) để module khác cấp quyền mà không tạo vòng import;
  - run không bao giờ có `manage`.
- **Duyệt** (`knowledge/reviews.ts`):
  - quy trình khớp theo `doc_prefixes` (`matchWorkflow` L389);
  - `proposeWithReview` L489, `startReview` L510, `finish` L823 gọi `applyDocSave`;
  - hook `provideReviewHooks` (L182);
  - queue `knowledge-review`.
- **Editor phía hub** (`knowledge/editor.ts`): `saveDraft`, `rebaseDraft`, `submitDraft` (L773, tạo đề xuất và duyệt),
  `saveRunDraft` (L244). Bảng nháp, gợi ý, bình luận, snapshot, presence ở migration `0052`.
- **Tìm kiếm**:
  - Chỉ memory có tìm theo nghĩa: cột `memories.embedding`, bật bằng `hive.enable_memory_vectors()`.
  - Embedder: `createOpenAIEmbedder` (`knowledge/embedder.ts:20`), biến `HIVE_EMBEDDINGS_URL`,
    `HIVE_EMBEDDINGS_DIMENSIONS`, `HIVE_EMBEDDINGS_API_KEY` (`platform/config.ts:82-92`). Queue `knowledge-embed`
    (`memory.ts:44`).
  - `searchMemory` hợp tsvector `simple` và cosine bằng RRF (`memory.ts:314-372`).
  - Tài liệu chỉ có lọc tiêu đề và key phía client (`packages/contracts/src/knowledge-search.ts` `matchKnowledge`).
- **Nhập từ hệ cũ** (`knowledge/legacy-import.ts`, `legacy-source.ts`):
  - đọc file SQLite của hub cũ, không đọc repo;
  - bảng `legacy_imports`, `legacy_doc_assets` (sha256, `storage_locator`, trạng thái `missing|available`, migration
    `0039`) chỉ lưu đường dẫn, không lưu file.
- **MCP** (`knowledge/mcp-tools.ts`): `doc_list`, `doc_get`, `doc_propose`; `doc_draft_get`, `doc_suggest`,
  `doc_comment` (chỉ run `docassist`). Chưa có `doc_search`.
- **Migration mới nhất**: `apps/hub/db/migrations/0072_third_wasp.sql`. Drizzle lấy schema theo
  `src/modules/*/schema.ts` (`apps/hub/drizzle.config.ts`). Module `platform` chưa có `schema.ts`.

### 1.2 Editor dùng chung (`packages/doc-editor`)

- Tiptap 3.31.3, `@tiptap/markdown`, marked. Markdown là định dạng lưu.
- `MarkdownCodec` (`markdown.ts:203-305`):
  - khối không sửa được ghi lại nguyên văn;
  - khối lạ thành `rawMarkdown`;
  - ảnh, HTML, chú thích cuối trang rơi về dạng thô (`markdown.ts:113-116`).
- Front-matter được giữ thành một khối thô ở đầu (regex `markdown.ts:18`), không phân tích.
- **Chưa có**: chèn ảnh, tải file, phân giải link tương đối. `env.link` chỉ biết `docs`, `doc`, `run`.
- Hợp ba bên theo khối: `mergeBlocks(base, mine, theirs)` trả `{content, conflicts}`
  (`packages/contracts/src/doc-text.ts:220`). Cùng file có `splitBlocks`, `joinBlocks`, `normalizeDoc`, `wordDiff`.
- Hub **không** gọi `normalizeDoc` khi lưu, nên nội dung giữ nguyên byte. **[Suy luận]** Nhập rồi ghi lại không sửa
  sẽ ra đúng byte cũ (SC-005), trừ khi editor ghi lại khối đã chạm. T003 đo trên bộ mẫu.

### 1.3 Hai cách đồng bộ repo đã có

| | Kho skill (spec 006) | SDLC sync (spec 011 T040) |
|---|---|---|
| Code | `knowledge/skill-repo.ts` (612 dòng) | `sdlc/sync.ts` (858 dòng) |
| Repo | Repo riêng mỗi tổ chức (`skill_repos`) | Repo của dự án |
| Bố cục | `org/`, `teams/<team>/`, `projects/<key>/` | `docsRoot` của dự án |
| Hub → repo | `pushHubChanges` (L415) commit thẳng | `planSync` (L291), `pushFiles` (L389): `pr` hoặc `direct`, PR cuốn chiếu, commit status `xdev-hive/sdlc`, `enqueueMerge` |
| Repo → hub | `syncSkillRepo` (L264), `applyPull` (L353): **git thắng**, xoá skill khi file bị xoá | `onSdlcPush` (L569), `pullProject` (L634): repo đổi thành **đề xuất** qua duyệt |
| Kích hoạt | Webhook riêng `/hooks/skills/:repoId` (`app.ts:327`), `handleSkillWebhook` (L588) | `onScmEvent("push")` (L782), cron `*/15` cho dự án không có webhook (`scanProjects` L739) |
| Chống lặp | So `repo_version` | `hubVersionHashes` (L590), trailer `Hive-Sdlc-Item` |
| Thử lại | Queue `knowledge-skill-git` | Lịch `[1,2,5,10,20,30]` phút, `recordFailure` (L485), thông báo |
| Bảng trạng thái | Cột `skills.repo_path`, `repo_version` | `sdlc_artifact_syncs` (`sdlc/schema.ts:236-270`): `repo_path`, `synced_version/commit/hash`, `repo_hash`, `sync_state`, `pr_number/url` |
| Giới hạn | | `PULL_MAX_FILES = 200` |

**Kết luận**:
- Spec này theo **SDLC sync** về cách đẩy: PR cuốn chiếu, commit status, merge queue, lịch thử lại, so hash.
- Repo tài liệu tổ chức theo **kho skill** về cách nối: webhook riêng, bảng repo của tổ chức.
- Chính sách xung đột khác cả hai:
  - repo đổi mà hub không đổi thì áp thẳng;
  - cả hai cùng đổi thì hợp theo khối;
  - hợp không được thì hỏi người.
- Không dùng chung code trực tiếp vì `sync.ts` gắn với hạng mục SDLC. Plan tách phần dùng chung được (tính hash, trailer,
  lịch thử lại) thành hàm nhỏ trong module mới, không sửa `sdlc`.
- Tài liệu SDLC (`project/<key>/sdlc/…`, `parseSdlcDocKey` ở `packages/doc-editor/src/sdlc-panel.tsx:24`) và đường dẫn
  trong `sdlc_artifact_syncs` bị loại khỏi đồng bộ tài liệu, để một file không bị hai hệ cùng ghi.

### 1.4 Cài đặt dự án

- `projects.settings.sdlc` (`packages/contracts/src/projects.ts:301-325`) đã có:
  - `repoSync: z.enum(["pr","direct","off"]).default("pr")`;
  - `docsRoot` (regex đường dẫn tương đối, không `..`).
- Các khoá khác của settings: `runPermissions`, `models`, `merge`, `outcome`, `features`, `issueIntake`,
  `tokenSaving`, `routing`, `defaultCli`, `budget`, `sdlc`, `brief`. Khoá mới cần `.default()` để dòng cũ vẫn parse.
- **Kết luận**: thêm khoá `docs` riêng, không dùng lại `sdlc.docsRoot`, vì SDLC có thể tắt mà đồng bộ tài liệu vẫn bật.

### 1.5 Module `scm`

- **`GitProvider`** (`scm/types.ts:136-192`):
  - `checkAccess`, `getRepo` (có `defaultBranch`), `createRepo`;
  - `commitFiles`, `branchHead`, `listFiles(ref, sha)`, `readFile(ref, path, sha)` (trả chuỗi UTF-8 hoặc `null`);
  - `openPR` (idempotent), `getPR`, `updatePRBranch`, `mergePR`, `closePR`, `prFiles`;
  - `canPush(ref, user)`, `setCommitStatus`, `checksFor`, `addWebhook`, `removeWebhook`, `protectBranch`,
    `commentOnIssue`.
- **`CommitFilesInput`**: `{ branch, fromBranch?, message, files: {path, content: string}[] }`. Không xoá, không đổi
  tên, không nhị phân, không LFS.
- **GitHub** (`scm/github.ts`):
  - `listFiles` dùng `git/trees?recursive=1` và ném lỗi khi `truncated` (`github.ts:642-650`);
  - `readFile` dùng Contents API, giải base64 thành UTF-8; **[Đã thử]** API trả nội dung rỗng cho file > 1 MB
    ở chế độ object (mục 6.2), nên không được dùng kết quả rỗng này làm nội dung tài liệu;
  - `commitFiles` ghi mode `100644`.
- **GitLab** (`scm/gitlab.ts`): tree có phân trang, `files/raw`, Commits API với `actions`.
- **Provider `memory`** cho test.
- **Webhook**:
  - `POST /hooks/git/:projectId` (`scm/webhooks.ts:53`): kiểm chữ ký, chống lặp bằng `webhook_deliveries`, queue
    `scm.event`, giới hạn 25 MB.
  - Sự kiện push chuẩn hoá chỉ có `{branch, sha}`, không có danh sách file.
  - Handler đăng ký qua `onScmEvent(kind, fn)`. Hiện chỉ `sdlc` nghe `push` (`sdlc/sync.ts:782`). `main.ts:251` nghe
    `*` để ghi audit.
- **Hạn mức**: `GitProviderError` có `retryAfterMs`, `retryable`.
- **Git LFS**: chưa có ở đâu trong repo.

### 1.6 Kho file

- BlobStore là T062 của spec 012, **chưa làm**:
  - thiết kế: `artifacts/blob-store.ts` (giao diện + bytea chia đoạn 512 KiB), bảng `artifact_blobs`,
    `artifact_blob_chunks`, tải lên multipart, kiểm magic bytes;
  - hiện chỉ có cột `artifact_versions.blob_id` (không FK) và giới hạn `HIVE_ARTIFACT_MAX_BLOB_BYTES` (mặc định
    20 MiB, trần 512 MiB), hạn mức tổ chức 2048 MiB (`artifacts/limits.ts`).
- **Kết luận**: làm BlobStore một lần, đặt ở `platform`, bảng `blobs`/`blob_chunks` dùng chung. T062 của spec 012 dùng
  lại thay vì tạo bảng `artifact_blobs` riêng. Cần báo nhóm spec 012 (rủi ro R4 trong plan).

### 1.7 Bộ quét bí mật

- `scanSecrets(text): SecretFinding[]` (`packages/contracts/src/secret-scan.ts:87`). Mỗi kết quả chỉ có loại và số
  dòng, không có giá trị: hợp yêu cầu "không hiện bí mật trên giao diện".
- Đang dùng ở `artifacts/versions.ts`, quy tắc `no-secrets` (`knowledge/review-rules.ts:150,312`),
  `codereview/gates.ts:58`. `redactSecrets` ở `chat/sanitize.ts:26` và worker Go.

### 1.8 Giao diện

- **Web**:
  - `/knowledge/docs` (`docs-page.tsx`): danh sách, tìm, tạo, lịch sử;
  - `/knowledge/docs/$key/edit` (`doc-editor-page.tsx`).
  - Chưa có màn nhập.
- **Desktop**:
  - "Soạn tài liệu" (`#/write`, `apps/desktop/src/screens/write-screen.tsx`) dùng `DocEditor` chung.
  - "Tài liệu từ code" (`#/docs`, `docs-screen.tsx`): chat CLI tại máy, nháp localStorage, `proposeDoc` gửi đề xuất,
    `write_local_file`.
  - Nhãn menu ở `apps/desktop/src/lib/nav.ts:245,254`.

### 1.9 Phụ thuộc của hub

- `apps/hub/package.json` chưa có `yaml`, `gray-matter`, `tar`, `picomatch`, `mammoth`, `unpdf`, `exceljs`, `jszip`
  (đã grep). Đề xuất thêm ở mục 4.
- Đã có `matchGlob` (`packages/contracts/src/glob.ts`), glob kiểu gitignore rút gọn, dùng ở `runs` và `codereview`. Dùng
  lại cho mẫu lấy/bỏ và `.gitattributes`, không thêm thư viện glob.
- Đã có `skill-repo-card.tsx` (`apps/web/src/pages/knowledge/`): thẻ cấu hình kho skill của tổ chức. Thẻ repo tài
  liệu tổ chức làm theo mẫu này.

## 2. API của provider cần dùng

Các dòng dưới là thiết kế API, đã cập nhật theo T002. Mục 6 phân biệt **[Đã thử]**, **[Đối chiếu]** và những phép
thử còn **chưa rõ**. Chưa có repo thử/token của tổ chức cho thao tác ghi, LFS và GitLab tự host.

### 2.1 GitHub

| Việc | API | Ghi chú |
|---|---|---|
| Cây file | `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` | Trả `truncated: true` khi quá giới hạn (khoảng 100.000 mục hoặc 7 MB). Khi đó duyệt từng cây con không đệ quy |
| Tải cả repo | `GET /repos/{o}/{r}/tarball/{ref}` | Trả 302 tới `codeload.github.com`. Không lọc theo thư mục. Repo lớn (nhiều code) thì tải nhiều hơn cần. Ngưỡng chọn: dùng tarball khi số file cần đọc > 100 và kích thước repo (`size` trong `getRepo`, KB) < 500 MB |
| Đọc file nhỏ | Contents API | **[Đã thử]** File 1–100 MB với media type object: `content` rỗng, `encoding: "none"`. Không được coi là file rỗng; dùng raw hoặc blob. T006 sửa |
| Đọc nhị phân | `GET /repos/{o}/{r}/git/blobs/{sha}` | Tới 100 MB. Dùng `sha` từ cây file |
| So sánh | `GET /repos/{o}/{r}/compare/{base}...{head}` | **[Đã thử]** Phân trang commit không phân trang file: chỉ trang đầu có tối đa 300 file. **[Đối chiếu]** Rename có `previous_filename`. Đủ 300 file thì coi là có thể thiếu và so cây hai commit |
| Ghi nhiều file | Git Data API: tạo blob (base64), tạo tree (có `sha: null` để xoá), tạo commit, cập nhật ref | `commitFiles` hiện dùng cách này. Thêm xoá và nhị phân. Đổi tên = xoá + thêm, git tự nhận ra rename |
| LFS | `POST https://github.com/{o}/{r}.git/info/lfs/objects/batch` | Xác thực bằng token có quyền ghi repo. GitHub App installation token qua Basic `x-access-token:<token>` **[Chưa kiểm]** |
| Đổi nhánh mặc định | Webhook `repository` (action `edited`, `changes.default_branch`) | Webhook hiện chỉ đăng ký `push`, `pull_request`, `issues`, `issue_comment`. Hub dò bằng `getRepo` mỗi lần đồng bộ, không cần thêm sự kiện |
| Hạn mức | 5.000 request/giờ (token), 15.000 (App ở Enterprise Cloud) | Theo `retryAfterMs` đã có |

### 2.2 GitLab

| Việc | API | Ghi chú |
|---|---|---|
| Cây file | `GET /projects/:id/repository/tree?recursive=true&per_page=100` | Phân trang theo keyset (`pagination=keyset`) với repo lớn |
| Tải archive | `GET /projects/:id/repository/archive.tar.gz?sha=&path=` | Có tham số `path` để chỉ lấy một thư mục (GitLab 14.4+) |
| Đọc file | `GET /projects/:id/repository/files/:path/raw?ref=` | Trả byte gốc, dùng được cho nhị phân |
| So sánh | `GET /projects/:id/repository/compare?from=&to=` | **[Đối chiếu]** Có `renamed_file`; kiểm `compare_timeout` để nhận biết danh sách có thể thiếu, không chỉ chờ `overflow`. Từ 18.4 có `collapsed`/`too_large` cho phần diff |
| Ghi nhiều file | `POST /projects/:id/repository/commits` với `actions[]` | `action`: `create`, `update`, `delete`, `move` (có `previous_path`). `encoding: "base64"` cho nhị phân |
| LFS | `POST {repo}.git/info/lfs/objects/batch` | Token cần quyền `write_repository` **[Chưa kiểm]** với project access token |
| Hạn mức | Tuỳ instance tự host | Như GitHub |

### 2.3 Git LFS

- Con trỏ LFS là file chữ ba dòng: `version https://git-lfs.github.com/spec/v1`, `oid sha256:<hex>`, `size <n>`.
- Hub nhận ra con trỏ khi file nhỏ hơn 200 byte và bắt đầu bằng dòng `version`.
- Đẩy:
  1. gọi Batch API `operation: upload` với `oid` và `size`;
  2. `PUT` lên `href` trả về (có thể là S3 của provider);
  3. gọi `verify` nếu có;
  4. commit con trỏ.
- Tải: Batch API `operation: download`, rồi `GET href`.
- Chỉ dùng khi `.gitattributes` có dòng khớp với `filter=lfs`. Hub không sửa `.gitattributes`.
- Khớp mẫu `.gitattributes` bằng `matchGlob` có sẵn (`packages/contracts/src/glob.ts`, glob kiểu gitignore rút gọn,
  `**`, `*`, `?`). Thêm một bước: mẫu không có `/` thì khớp ở mọi cấp (thêm `**/` phía trước), đúng ý nghĩa của
  `.gitattributes`. **[Suy luận]** Đủ cho mẫu thường gặp (`*.psd`, `assets/**/*.mp4`). Không hỗ trợ macro, `!` phủ
  định và lớp ký tự `[...]` trong bản đầu.

## 3. Phương án và lựa chọn

### 3.1 Nơi lưu file nhị phân

| Phương án | Ưu | Nhược | Chọn |
|---|---|---|---|
| bytea chia đoạn 512 KiB trong PostgreSQL | Đúng constitution VII. Sao lưu cùng DB. RLS. Đúng thiết kế T062 | DB to lên, `pg_dump` lâu. **[Suy luận]** Ổn tới vài chục GB | **Có**, bản đầu |
| Large Object của PostgreSQL | Có sẵn | Không có RLS trên `pg_largeobject`, khó dọn | Không |
| S3/MinIO | Rẻ khi lớn | Thêm dịch vụ, cần ADR | Để sau, giao diện `BlobStore` cho phép thêm |
| Chỉ để trong repo, đọc lúc cần | Không tốn chỗ | Hiển thị phụ thuộc provider, chậm, hết hạn mức. Không tìm được khi repo mất quyền | Không |

### 3.2 Phát hiện đổi tên

1. Dùng `renamed` từ API so sánh (mục 2).
2. Nếu thiếu: ghép file mất và file mới cùng `blob sha`.
3. Nếu vẫn thiếu: so độ giống theo khối (`splitBlocks`, Jaccard trên tập khối) ≥ 0,8.
4. Không ghép được: xoá + thêm.

### 3.3 Xung đột

- Dùng `mergeBlocks` có sẵn. Đơn vị là khối markdown (đoạn, danh sách, bảng, khối code).
- Hai bên sửa hai khối khác nhau thì hợp được. Sửa cùng khối thì xung đột.
- Front-matter là một khối, nên hai bên cùng sửa front-matter thì xung đột. **[Suy luận]** Hiếm, chấp nhận.

### 3.4 Gom lô và PR

- PR cuốn chiếu một nhánh mỗi nhà, như SDLC (`syncBranch`). Ít PR, người duyệt thấy mọi thay đổi tài liệu một chỗ.
- Mỗi tài liệu một PR thì nhiều PR, merge queue nặng. Không chọn.
- Gom: 60 giây từ lần lưu cuối, tối đa 10 phút (Q5 đã chốt). **[Đã thử]** `singletonKey` + `startAfter` của
  pg-boss 12.37.1 với queue `stately` chỉ bỏ job trùng, không dời hạn chạy. Cần lưu mốc lần đầu/lần cuối và tính lại
  hạn; không thể dùng riêng lời gọi `send` hiện tại để thực hiện Q5 (mục 6.4).

### 3.5 Trích nội dung

| Định dạng | Thư viện | Giấy phép | Ghi chú |
|---|---|---|---|
| `.docx` | `mammoth` | BSD-2 | Ra HTML, chuyển sang markdown bằng `turndown` (MIT). Ảnh nhúng bỏ qua trong bản đầu |
| `.pdf` | `unpdf` (bản dựng pdf.js cho server) | MIT, pdf.js Apache-2.0 | Chỉ lớp chữ. Trang không có chữ thì báo "Không có chữ để trích" |
| `.xlsx` | `exceljs` | MIT | Đọc dạng stream. Giới hạn 2.000 dòng mỗi sheet, 20 sheet |
| `.csv` | Tự đọc | — | Bảng markdown |
| `.pptx` | `jszip` + đọc XML `ppt/slides/*.xml` | MIT hoặc GPLv3 (chọn MIT) | Chữ theo slide, ghi chú người nói |
| Ảnh | Không trích | — | Lấy alt text và chú thích từ markdown trỏ tới ảnh |

- **[Đã thử]** Giấy phép từ manifest và LICENSE của bản npm mới nhất, kích thước, chạy worker và audit ở mục 6.5–6.6.
  `exceljs` đọc stream chưa ổn định trong phép thử; không coi bảng lựa chọn này là đã đạt mọi điều kiện triển khai.
- Trích chạy trong `worker_threads` có `resourceLimits` (bộ nhớ 512 MB) và hết giờ 60 giây. Lý do: file độc (zip bomb,
  PDF lặp) không làm treo tiến trình hub.
- Kiểm magic bytes trước khi trích, không tin đuôi file.

### 3.6 Front-matter và CRLF

- Dùng `yaml` (ISC) để đọc front-matter: **[Đã thử]** 2.9.1 không thực thi tag `!!js/function` mặc định, báo
  `TAG_RESOLVE_FAILED` và giữ thành chuỗi. Không đăng ký custom tag; giữ giới hạn alias (mục 6.5).
- Không ghi lại front-matter từ đối tượng đã parse, để giữ nguyên văn.
- Lưu kiểu xuống dòng (`lf`/`crlf`) và BOM trong `doc_repo_files`. Nội dung trên hub chuẩn hoá về LF để editor và
  `mergeBlocks` chạy đúng. Khi ghi vào repo thì đổi lại kiểu gốc. Hash so với repo tính trên byte đã đổi lại.

### 3.7 Đọc tarball

- Dùng `tar` dạng stream, lọc mục theo mẫu lấy/bỏ, không giải ra đĩa. **[Đã thử]** Bản 7.5.22 dùng BlueOak-1.0.0,
  không phải ISC (mục 6.5).
- Bỏ symlink, hardlink và đường dẫn có `..` để chống path traversal.
- Giới hạn tổng byte đã đọc bằng `HIVE_DOC_IMPORT_MAX_BYTES` (mặc định 2 GiB).

### 3.8 Chia đoạn và tìm kiếm

- Chia theo tiêu đề `#`–`###`. Đoạn dài hơn 1.500 ký tự thì cắt ở ranh giới khối. Mỗi đoạn kèm đường tiêu đề
  ("Cài đặt › Linux") để kết quả dễ đọc.
- tsvector `simple` như memory (tiếng Việt không có từ điển trong PostgreSQL). **[Đã thử]** Image dev
  `pgvector/pgvector:0.8.7-pg18-trixie` có `unaccent` 1.1, tạo extension và bỏ dấu tiếng Việt thành công (mục 6.4).
- Vector bật bằng hàm `hive.enable_doc_vectors()` như `enable_memory_vectors()`, để bản tự host không có pgvector vẫn
  chạy.
- Hợp RRF (k = 60) như `searchMemory`.

## 4. Phụ thuộc mới đề xuất

| Package | Dùng ở | Lý do |
|---|---|---|
| `yaml` | hub | Đọc front-matter |
| `tar` | hub | Đọc tarball nhập lần đầu |
| `mammoth`, `turndown` | hub | Trích `.docx` |
| `unpdf` | hub | Trích `.pdf` |
| `exceljs` | hub | Trích `.xlsx` |
| `jszip` | hub | Trích `.pptx` |

Kích thước cài đặt và lỗ hổng đã biết: **[Đã thử]** mục 6.5–6.6. Bộ độc lập có khoảng 48,88 MiB nội dung package;
chưa đo phần tăng của image Linux. Import động giảm phần nạp lúc chạy, không giảm dung lượng image đã cài package.

## 5. Quyết định rút ra

1. Module hub mới `docsync`. Lý do: `knowledge` đã lớn, và đồng bộ cần `scm`, `catalog` (dự án, merge queue).
   `knowledge` không import `docsync`; `docsync` nhận sự kiện lưu tài liệu qua hook `provideDocSaved`.
2. Key tài liệu không đổi khi file đổi tên. Đường dẫn thật ở `doc_repo_files`.
3. BlobStore chung ở `platform`, bytea chia đoạn.
4. Mở rộng `GitProvider`: `readBlob`, `compare`, `archive`, `commitFiles` có xoá, đổi tên và nhị phân, `lfsBatch`.
   Provider `memory` làm đủ để test.
5. Chính sách: repo đổi mà hub không đổi thì áp thẳng; hai bên đổi thì hợp theo khối; không hợp được thì hỏi người.
6. Bản trích chỉ ở hub, phải duyệt.
7. Tìm kiếm: bảng `doc_chunks` trong `knowledge`, theo cách của memory.
8. ADR 0028 ghi các quyết định 1, 3, 5. SRS thêm mục 3.23 `DSYNC-01…`. ADR 0027 và SRS 3.22 đã dành cho spec 017.

## 6. Kết quả spike

### 6.1 Phạm vi và cách ghi nhận

- Ngày thử/đối chiếu: **2026-10-15** cho mọi dòng trong mục 6. Node **26.10.0**, pnpm **12.11.2**, macOS arm64;
  PostgreSQL thật chạy qua Testcontainers trên Docker/Colima. Không suy rộng kết quả sang Node 24 hay GitLab tự host.
- Q1–Q12 đã được chủ dự án chốt theo khuyến nghị ngày 2026-10-15. T002 không sửa `spec.md`/`plan.md` ngoài phạm vi.
- **Có**: quan sát được hoặc tài liệu chính thức xác nhận (ghi riêng loại bằng chứng). **Không**: phản ví dụ đã
  quan sát. **Chưa rõ**: thiếu token/repo thử, không có mẫu phù hợp hoặc HTTP không đủ kết luận về tính năng.
- Chỉ đọc repo công khai qua HTTP; chưa được cấp repo thử riêng tư, installation token, project access token hay
  địa chỉ GitLab tự host. Không kiểm LFS bằng token giả rồi coi lỗi xác thực là tính năng không hỗ trợ.
- Theo giới hạn chỉ ghi trong worktree, script/package thử nằm ở `.e2e/t002/` (đã bị gitignore), không commit script,
  file mẫu, archive hay dependency. Chỉ commit kết quả và dấu hoàn thành T002.

### 6.2 GitHub.com — REST 2022-11-28

Mọi dòng: GitHub.com, ngày 2026-10-15; phiên bản REST gửi trong `X-GitHub-Api-Version` là `2022-11-28`.

| Phép kiểm | Kết quả | Bằng chứng / hệ quả |
|---|---|---|
| Contents API, file > 1 MB | **Có — đã thử** | `torvalds/linux`, cây `0fcb05b72344f40806cbe810de8872f1698bf053`, `crypto/testmgr.h` dài 1.446.569 byte. Media type `application/vnd.github.object+json` trả `encoding=none`, `content.length=0`; blob API trả base64 giải ra đúng số byte |
| Giới hạn Contents 100 MB, blob 100 MB | **Có — đối chiếu** | [Contents](https://docs.github.com/en/rest/repos/contents#get-repository-content), [blobs](https://docs.github.com/en/rest/git/blobs#get-a-blob); chưa tải mẫu > 100 MB. T006 không được trả chuỗi rỗng thay lỗi/đọc blob |
| Cây đệ quy bị cắt | **Có — đã thử** | Cây Linux trên trả 71.638 mục, `truncated=true`. Duyệt không đệ quy cùng SHA trả 41 mục gốc, cây `crypto` trả 139 mục, đều `truncated=false`. Chỉ thử hai cây, chưa quét lại toàn repo |
| Tarball và redirect | **Có — đã thử** | `octocat/Hello-World`, `master` tại `7fd1a60`: HTTP 302 tới `codeload.github.com`, giải gzip/tar stream đọc được thư mục gốc và `README`. Chưa thử archive riêng tư hay ngưỡng repo 500 MB |
| Compare phân trang file > 300 | **Không — đã thử** | Linux `v6.18...v6.19`, `per_page=1`: trang 1 có 1 commit và 300 file; có link trang tiếp; trang 2 không có `files`. Không thể lấy file 301 bằng tăng `page` |
| Compare rename có `previous_filename` | **Có — đối chiếu; chưa rõ khi thử** | [Compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits). Mẫu Linux trên và `git-lfs/git-lfs` `v3.6.0...v3.7.0` (127 file) không trả rename trong tập file nhận được; chưa có fixture repo thật được cấp |
| Git Data API xoá bằng `sha:null` | **Có — đối chiếu; chưa rõ khi thử** | [Create tree](https://docs.github.com/en/rest/git/trees#create-a-tree) hỗ trợ xoá. Chưa có repo ghi; không gửi POST lên repo công khai |
| Tạo blob base64 nhị phân | **Có — đối chiếu; chưa rõ khi thử** | [Create blob](https://docs.github.com/en/rest/git/blobs#create-a-blob). Chỉ kiểm giải mã blob có sẵn; chưa kiểm vòng ghi/đọc với installation token |
| LFS Batch với installation token | **Chưa rõ — chưa kiểm** | Thiếu installation token và repo có LFS. Basic `x-access-token` vẫn là giả thuyết với Batch; không suy từ quyền Git HTTP sang LFS. T027 cần upload → verify nếu có → download và so SHA-256 |
| Dò đổi nhánh mặc định bằng `getRepo` | **Có — đối chiếu; chưa rõ khi thử đổi nhánh** | [Get repository](https://docs.github.com/en/rest/repos/repos#get-a-repository) có `default_branch`. Chưa thử webhook `repository.edited`; cách dò lại không cần phụ thuộc webhook đó |
| Hạn mức 5.000/15.000 mỗi giờ | **Có — đối chiếu; chưa rõ với App thực tế** | [Rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Không phải hằng số cho mọi token: chưa xác thực là 60/giờ, installation thường tối thiểu 5.000 và có quy tắc tăng; cần đọc header, xử lý cả secondary limit |

### 6.3 GitLab.com / GitLab tự host — API v4

Mọi dòng: ngày 2026-10-15, API v4. **Bản GitLab.com và bản tự host chưa xác định**; chưa có địa chỉ/token tự host.
Tài liệu GitLab là bản hiện hành tại ngày đối chiếu, không phải xác nhận cho mọi phiên bản tự host.

| Phép kiểm | Kết quả | Bằng chứng / hệ quả |
|---|---|---|
| Tree keyset và phân trang | **Có — đã thử GitLab.com** | `gitlab-org/cli`, `ref=main`, `recursive=true&pagination=keyset&per_page=2`: HTTP 200, 2 mục và link trang tiếp. Chưa thử toàn cây lớn hay tự host |
| Archive lọc `path` | **Có — đối chiếu; chưa rõ khi thử** | [Archive](https://docs.gitlab.com/api/repositories/#retrieve-file-archive-from-a-repository) có `path`. Gọi `gitlab-org/cli` với `sha=main&path=docs&include_lfs_blobs=false` nhận HTTP 406 `Not Acceptable`, chưa xác định nguyên nhân; không kết luận API không hỗ trợ |
| Archive có tự kèm LFS blob | **Có — đối chiếu; chưa rõ khi thử** | Tài liệu archive mặc định `include_lfs_blobs=true`; T006 phải đặt `false` để chủ động xử lý pointer/hạn mức. Chưa xác nhận trên instance tổ chức |
| Đọc file raw nhị phân | **Có — đối chiếu; chưa rõ với file nhị phân thật** | [Repository files raw](https://docs.gitlab.com/api/repository_files/#get-raw-file-from-repository); cần test byte 0/0xff, không qua chuyển UTF-8 khi triển khai T006 |
| Compare có rename | **Có — đối chiếu; chưa rõ khi thử** | `gitlab-org/cli` `v1.80.0...v1.81.0` trả HTTP 200, 205 diff, không có `renamed_file=true`; chưa có mẫu rename do dự án cấp |
| Compare bị cắt có `overflow` | **Chưa rõ với `overflow`; có — đối chiếu `compare_timeout`** | [Compare](https://docs.gitlab.com/api/repositories/#compare-branches-tags-or-commits) ghi `compare_timeout`, và từ 18.4 có `collapsed`/`too_large`. Mẫu trên `compare_timeout=false`, không có `overflow`; không được coi thiếu `overflow` là danh sách đầy đủ |
| Compare lớn để ép thiếu dữ liệu | **Chưa rõ — đã gọi nhưng chưa đủ mẫu** | `gitlab-org/gitlab` với `v18.0.0...v18.1.0` trả HTTP 404; không kiểm được trường hợp bị cắt. T027 cần SHA hợp lệ trong repo thử đủ lớn |
| Commit `move` / `delete` / `encoding=base64` | **Có — đối chiếu; chưa rõ khi thử** | [Commits](https://docs.gitlab.com/api/commits/#create-a-commit-with-multiple-files-and-actions) có ba khả năng, move dùng `previous_path`. Chưa có repo/token ghi để kiểm byte và commit thực |
| LFS Batch, project access token | **Chưa rõ — chưa kiểm** | Thiếu token/repo. [Phạm vi token](https://docs.gitlab.com/security/tokens/access_token_scopes/) phân biệt `api` với `write_repository`; chỉ `write_repository` không thay scope `api` cần cho Commits API. Phải thử riêng LFS upload/download trên GitLab.com và bản tự host |
| Hạn mức từng instance | **Chưa rõ — chưa đo** | Không gây tải để ép 429. Chưa biết cấu hình self-host; giữ xử lý `Retry-After`/backoff và giới hạn đồng thời |

Giao thức LFS chung: **có — đối chiếu** [Batch API](https://github.com/git-lfs/git-lfs/blob/main/docs/api/batch.md):
upload/download qua action URL và header trả về, verify khi có. **Chưa rõ** với thông tin truy cập hai provider;
chưa kiểm expiry, object lỗi, redirect hay object storage. Nhận dạng pointer và `.gitattributes` là test thuần T004,
không được coi phép đọc tài liệu giao thức là một lần truyền LFS thành công.

### 6.4 pg-boss và PostgreSQL thật

Mọi dòng: ngày 2026-10-15, **pg-boss 12.37.1** lấy từ lockfile; image dev
`pgvector/pgvector:0.8.7-pg18-trixie` đang chứa **PostgreSQL 18.6**, Linux aarch64. Container thử riêng được dọn sau
phép thử; không tác động database dev. Dùng `send` như wrapper `platform/jobs.ts`, không giả pg-boss.

| Phép kiểm | Kết quả | Quan sát |
|---|---|---|
| Chỉ `singletonKey`, queue mặc định `standard`, gửi hai lần | **Không** gom | Cả hai lần có job id; khoá không tự bật policy chống trùng |
| `stately`, cùng key, job đầu chờ 60 s, gửi tiếp với hạn 120 s | **Có** bỏ trùng | Lần hai trả `null`; chỉ còn job đầu |
| Dời thời điểm theo lần lưu cuối | **Không** | `startAfter` của job đầu không đổi, payload vẫn revision 1. Đây là gom từ lần đầu, không phải debounce Q5 |
| Fetch trước `startAfter` | **Không** lấy job | `fetch` trả rỗng. Đưa hạn vào quá khứ trong DB thử rồi fetch thì nhận đúng job đầu; không cần ngủ 60 s |
| Một job active và một pending cùng key | **Có** với `stately` | Khi job đầu active, gửi được job kế tiếp; gửi thêm một pending cùng key trả `null` |
| `unaccent` có sẵn trong image dev | **Có** | `pg_available_extensions` có bản 1.1; `CREATE EXTENSION unaccent` thành công; `unaccent('Tài liệu tiếng Việt')` trả `Tai lieu tieng Viet` |

**Bàn giao T005/T013/T014 — plan mục 5, 13 cần điều chỉnh:** đăng ký `docsync-push`/`docsync-pull` với policy `stately`.
Để đúng Q5, cần trạng thái bền cho lần đầu và lần lưu cuối, hạn `min(lastSavedAt + 60 s, firstQueuedAt + 10 min)`;
khi job đến sớm thì hẹn lại, khi chạy đọc bản pending mới nhất trong DB, không tin payload job bị bỏ trùng.
Không reset mốc đầu khi liên tục lưu. Bộ cột ở plan mục 1 chưa liệt kê hai mốc này; người phụ trách schema phải giải
quyết trước migration. Đây là đề xuất triển khai, **chưa phải test debounce hoàn chỉnh**. `PgBoss.upsert` có trong bản
cài nhưng wrapper `Jobs` chưa công khai, và spike chưa thử đường này; không tự sửa platform ngoài phạm vi T002.
Quyền tạo extension của môi trường triển khai vẫn phải do migration/bootstrap đảm nhận, không chạy bằng `hive_app`.

### 6.5 Thư viện: bản mới nhất, giấy phép, kích thước, worker

Ngày 2026-10-15: lấy từng `/latest` từ npm registry, cài đúng phiên bản trong package thử độc lập bằng
`pnpm install --ignore-workspace --ignore-scripts`. Giấy phép **có — đã kiểm** cả metadata và file LICENSE phân phối.
Kích thước bên trái là `dist.unpackedSize` của package; bên phải gồm dependency bắc cầu, cộng byte file thật theo
realpath, mỗi package tính một lần. Các hàng có thể trùng dependency, **không cộng các hàng**.

| Package / bản | Giấy phép | Riêng / gồm dependency (MiB) | Chạy trong worker trên Node 26.10.0 |
|---|---|---|---|
| `yaml` 2.9.1 | ISC | 0,65 / 0,65 | **Có**: đọc tiếng Việt; `!!js/function` thành chuỗi + cảnh báo, không chạy code; `maxAliasCount=2` chặn mẫu alias lồng |
| `tar` 7.5.22 | **BlueOak-1.0.0** | 2,19 / 2,85 | **Có**: Pack → Buffer → Parser stream, đọc tên entry, không giải file ra đĩa |
| `mammoth` 1.13.0 | BSD-2-Clause | 1,59 / 4,69 | **Có**: DOCX tối thiểu dựng từ OOXML, trích đoạn tiếng Việt ra HTML |
| `turndown` 7.2.4 | MIT | 0,18 / 7,56 | **Có**: HTML từ mammoth → markdown đúng `Tài liệu thử` |
| `unpdf` 1.8.1 | MIT; PDF.js Apache-2.0 | 2,04 / 2,04 | **Có**: PDF một trang tự dựng, lấy đúng `T002 PDF text`; trang không chữ cho chuỗi rỗng. PDF.js nhúng báo bản 6.1.200 |
| `exceljs` 4.4.0 | MIT | 20,81 / 30,93 | **Có** import/đọc buffer; **không** ổn định với stream: lỗi 8/10 lần, chi tiết dưới |
| `jszip` 3.10.2 | MIT OR GPL-3.0-or-later; **chọn MIT** | 0,66 / 1,64 | **Có**: ZIP mẫu có `ppt/slides/slide1.xml` và `ppt/notesSlides/notesSlide1.xml`, đọc lại được cả hai XML; chưa phải parser PowerPoint hoàn chỉnh |

Tổng bộ cài: **197 dependency**, **51.254.285 byte ≈ 48,88 MiB** nội dung file; `du -sk node_modules/.pnpm` báo
72.352 KiB (≈ 70,66 MiB, dung lượng cấp phát khác kích thước nội dung). Chưa đo tăng image Linux hoặc mức dùng lại
dependency có sẵn của hub. Không thể coi import động là cách làm image nhỏ hơn; nó chỉ giảm việc nạp lúc khởi động.

Worker dùng `resourceLimits.maxOldGenerationSizeMb=512`, timeout 60 s. Toàn bộ mẫu nhỏ hoàn thành trong khoảng
0,47 s; RSS **cả tiến trình** khoảng 133 MiB, không phải peak hay RSS riêng thread. Không phải benchmark file 50 MiB,
zip bomb hay test cô lập lỗi. Theo [Node worker options](https://nodejs.org/api/worker_threads.html#new-workerfilename-options),
giới hạn heap không bao gồm ArrayBuffer/Buffer và không bảo đảm hub sống khi OOM toàn tiến trình. T017 vẫn cần giới
hạn byte sau giải nén, số entry/trang/dòng, và kiểm hủy worker; không ghi rằng chỉ đặt 512 MB đã chống zip bomb.

**Excel stream — không đạt giả định research 3.5:** `Workbook.xlsx.writeBuffer()` tạo workbook một sheet/một dòng
tiếng Việt; đọc bằng `stream.xlsx.WorkbookReader(Readable.from([buffer]))` 10 lần trong cùng worker: 8 lần
`Cannot read properties of undefined (reading 'sheets')`, 2 lần đúng. `Workbook.xlsx.load(buffer)` đọc đúng mẫu đó.
Lỗi tương ứng [upstream #3064](https://github.com/exceljs/exceljs/issues/3064). T017 cần lựa chọn đọc có giới hạn khác
hoặc sửa có test hồi quy trước khi dựa vào stream; không tự đổi sang fork trong spike. Giới hạn 2.000 dòng/20 sheet
chưa được chứng minh là giới hạn bộ nhớ khi dùng cách đọc cả buffer.

**YAML — có kiểm mặc định an toàn với tag đã thử:** `parseDocument` báo `TAG_RESOLVE_FAILED`, chuỗi chức năng không
được gọi. Tag không bị từ chối tuyệt đối mà rơi về scalar; T004 phải đưa cảnh báo vào kết quả parse, không thêm
`customTags` có thực thi. [YAML options](https://eemeli.org/yaml/#tojs-options) mặc định `maxAliasCount=100`; không tắt
giới hạn này. Giữ nguyên byte front-matter khi ghi, không stringify đối tượng đã parse.

### 6.6 Audit phụ thuộc

Ngày 2026-10-15, **pnpm 12.11.2**, chạy `pnpm --dir .e2e/t002 audit --json` trên lockfile bộ cài độc lập ở mục 6.5:
**không sạch** — 2 moderate, 0 high, 0 critical; audit trả mã 1 (kết quả phát hiện của spike, không phải test pass).

| Dependency / đường dẫn | Cảnh báo | Bản sửa theo audit |
|---|---|---|
| `exceljs@4.4.0 > uuid@8.3.2` | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq), thiếu kiểm tra biên buffer ở v3/v5/v6 khi truyền `buf` | `uuid >=11.1.1`; chưa xác minh nâng major tương thích ExcelJS, không ép override |
| `mammoth@1.13.0 > argparse > sprintf-js@1.0.3` | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), DoS qua precision không giới hạn | Audit không liệt kê bản vá |

Chưa chứng minh khả năng khai thác trong luồng trích của hub. T005/T017 phải đánh giá đường gọi/thay thế/bản sửa
trước khi chốt dependency; không coi không có high là không có lỗ hổng. Không đổi lockfile repo hay nhận thay quyết
định chấp nhận rủi ro trong task chỉ nghiên cứu này.

### 6.7 Kiểm tra repo và phần bàn giao còn lại

- **Có — test repo xanh**, ngày 2026-10-15, sau `git fetch && git merge origin/main`:
  `pnpm --filter @xdev-hive/hub typecheck`; Vitest
  `src/modules/scm/{github.test.ts,gitlab.test.ts,memory.test.ts,connections.db.test.ts}`: **4 file, 181 test**.
  GitHub/GitLab dùng HTTP giả; connections chạy PostgreSQL thật với migration và `withTenant`, có kiểm RLS.
  Không dùng các test giả này làm bằng chứng cho API thật chưa thử. Biome và deps ghi kết quả trong tóm tắt bàn giao.
- Script thử PostgreSQL kiểm trực tiếp các kết quả mục 6.4 bằng assert; script worker kiểm nội dung mẫu và ghi
  riêng số lần Excel stream thất bại. Không commit script theo phạm vi T002. Các thử nghiệm âm không được đổi tên
  thành mọi thư viện đều đạt.
- **Chưa rõ — cần T027 hoặc lượt spike có repo/token**: mọi thao tác ghi, rename có kiểm soát, LFS Batch có xác
  thực trên GitHub.com/GitLab.com, archive GitLab thành công, compare bị cắt, bản GitLab tự host và các giới hạn thực
  tế. Khi có môi trường, ghi bản server, SHA trước/sau, HTTP status, độ dài và SHA-256 file thử; không ghi token.
- **Bàn giao T006**: không phân trang file compare GitHub; nhận biết GitLab thiếu diff bằng `compare_timeout`, so cây
  khi chưa chắc đầy đủ; archive GitLab đặt `include_lfs_blobs=false`; phân biệt file rỗng với Contents không có nội dung.
- **Bàn giao T005/T013/T014/T017**: sửa giả định debounce và trạng thái bền trước migration; ghi giấy phép tar đúng bản;
  xử lý kết quả audit, lỗi Excel stream, dung lượng cài và giới hạn worker trước triển khai. T002 không sửa schema,
  migration, API hay cấu hình chung.
