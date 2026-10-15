# Research: tài liệu trên hub, nhập từ repo, đồng bộ hai chiều

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md)

Quy ước nhãn:
- Dòng có đường dẫn `file:dòng` là đã đọc code ngày 2026-10-15 trên `main` tại `9d45128c`.
- **[Chưa kiểm]**: lấy từ hiểu biết về API của provider, chưa gọi thử. T002 (spike) kiểm từng dòng.
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
  - `readFile` dùng Contents API, giải base64 thành UTF-8;
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

Mọi dòng mục này là **[Chưa kiểm]**. T002 gọi thử trên repo thật (GitHub.com, GitLab.com, GitLab tự host của tổ chức)
và ghi kết quả.

### 2.1 GitHub

| Việc | API | Ghi chú |
|---|---|---|
| Cây file | `GET /repos/{o}/{r}/git/trees/{sha}?recursive=1` | Trả `truncated: true` khi quá giới hạn (khoảng 100.000 mục hoặc 7 MB). Khi đó duyệt từng cây con không đệ quy |
| Tải cả repo | `GET /repos/{o}/{r}/tarball/{ref}` | Trả 302 tới `codeload.github.com`. Không lọc theo thư mục. Repo lớn (nhiều code) thì tải nhiều hơn cần. Ngưỡng chọn: dùng tarball khi số file cần đọc > 100 và kích thước repo (`size` trong `getRepo`, KB) < 500 MB |
| Đọc file nhỏ | Contents API | Nội dung base64 chỉ có khi file ≤ 1 MB. 1–100 MB thì `content` rỗng, `encoding: "none"`. **Hệ quả**: `readFile` hiện tại trả `""` cho file > 1 MB **[Suy luận]**, có thể ghi đè tài liệu bằng chuỗi rỗng. T004 sửa |
| Đọc nhị phân | `GET /repos/{o}/{r}/git/blobs/{sha}` | Tới 100 MB. Dùng `sha` từ cây file |
| So sánh | `GET /repos/{o}/{r}/compare/{base}...{head}` | `files[]` có `status` (`added`, `modified`, `removed`, `renamed`, `copied`) và `previous_filename`. Tối đa 300 file trong phản hồi; nhiều hơn thì có phân trang `?page=` **[Chưa kiểm cách phân trang mới]**. Không đủ thì so cây hai commit |
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
| So sánh | `GET /projects/:id/repository/compare?from=&to=` | `diffs[]` có `new_path`, `old_path`, `new_file`, `renamed_file`, `deleted_file`. Có thể bị cắt khi quá lớn (`overflow`) |
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
- Gom: 60 giây từ lần lưu cuối, tối đa 10 phút (Q5). Dùng `singletonKey` của pg-boss theo nhà, như debounce của SDLC
  sync.

### 3.5 Trích nội dung

| Định dạng | Thư viện | Giấy phép | Ghi chú |
|---|---|---|---|
| `.docx` | `mammoth` | BSD-2 | Ra HTML, chuyển sang markdown bằng `turndown` (MIT). Ảnh nhúng bỏ qua trong bản đầu |
| `.pdf` | `unpdf` (bản dựng pdf.js cho server) | MIT, pdf.js Apache-2.0 | Chỉ lớp chữ. Trang không có chữ thì báo "Không có chữ để trích" |
| `.xlsx` | `exceljs` | MIT | Đọc dạng stream. Giới hạn 2.000 dòng mỗi sheet, 20 sheet |
| `.csv` | Tự đọc | — | Bảng markdown |
| `.pptx` | `jszip` + đọc XML `ppt/slides/*.xml` | MIT hoặc GPLv3 (chọn MIT) | Chữ theo slide, ghi chú người nói |
| Ảnh | Không trích | — | Lấy alt text và chú thích từ markdown trỏ tới ảnh |

- Giấy phép trên là **[Chưa kiểm]** theo bản mới nhất; T002 kiểm lại trước khi thêm.
- Trích chạy trong `worker_threads` có `resourceLimits` (bộ nhớ 512 MB) và hết giờ 60 giây. Lý do: file độc (zip bomb,
  PDF lặp) không làm treo tiến trình hub.
- Kiểm magic bytes trước khi trích, không tin đuôi file.

### 3.6 Front-matter và CRLF

- Dùng `yaml` (ISC) để đọc front-matter: an toàn, không chạy tag tuỳ ý theo mặc định **[Chưa kiểm]**.
- Không ghi lại front-matter từ đối tượng đã parse, để giữ nguyên văn.
- Lưu kiểu xuống dòng (`lf`/`crlf`) và BOM trong `doc_repo_files`. Nội dung trên hub chuẩn hoá về LF để editor và
  `mergeBlocks` chạy đúng. Khi ghi vào repo thì đổi lại kiểu gốc. Hash so với repo tính trên byte đã đổi lại.

### 3.7 Đọc tarball

- Dùng `tar` (ISC) dạng stream, lọc mục theo mẫu lấy/bỏ, không giải ra đĩa.
- Bỏ symlink, hardlink và đường dẫn có `..` để chống path traversal.
- Giới hạn tổng byte đã đọc bằng `HIVE_DOC_IMPORT_MAX_BYTES` (mặc định 2 GiB).

### 3.8 Chia đoạn và tìm kiếm

- Chia theo tiêu đề `#`–`###`. Đoạn dài hơn 1.500 ký tự thì cắt ở ranh giới khối. Mỗi đoạn kèm đường tiêu đề
  ("Cài đặt › Linux") để kết quả dễ đọc.
- tsvector `simple` như memory (tiếng Việt không có từ điển trong PostgreSQL), dùng `unaccent` nếu có **[Chưa kiểm
  extension có sẵn trong image]**.
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

Kích thước cài đặt và lỗ hổng đã biết: T002 kiểm bằng `pnpm audit` trước khi thêm. **[Suy luận]** `unpdf` và `exceljs`
nặng nhất; nếu ảnh Docker của hub tăng quá 30 MB thì cân nhắc tải lười (import động khi có job trích).

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
