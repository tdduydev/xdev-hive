# Research: Ngữ cảnh dùng chung, đồng bộ dự án và nút "Tối ưu"

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-22

Khảo sát code trên `origin/main` tại `9b484526` và tài liệu chính thức của từng CLI. Máy kiểm: Windows dev, `claude`
2.1.308, `codex-cli` 0.142.5, `gemini` 0.62.0; `agy` chưa có trên PATH.

## 1. File ngữ cảnh cục bộ của từng CLI (D5)

Không CLI nào tự cho file ngữ cảnh cục bộ vào git ignore. App luôn thêm file đích vào `.git/info/exclude` (file riêng của
bản clone, không bao giờ commit) và kiểm lại bằng `git check-ignore`.

| CLI | File đọc ở dự án | Bản cục bộ | Ghi chú quan trọng | Nguồn |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` ở thư mục làm việc và mọi thư mục cha, nối từ gốc xuống | **`CLAUDE.local.md`** (còn hỗ trợ, nối sau `CLAUDE.md` cùng thư mục) | Chú thích `<!-- -->` cấp khối bị bỏ trước khi tới model (dấu khối không tốn token). Import `@path` tối đa 4 tầng. **`AGENTS.md` chỉ được đọc khi không có `CLAUDE.md`/`CLAUDE.local.md`**: tạo `CLAUDE.local.md` ở repo chỉ có `AGENTS.md` sẽ làm Claude bỏ `AGENTS.md` | code.claude.com/docs/en/memory |
| Codex | `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`, **một file mỗi thư mục**, từ gốc git xuống | `AGENTS.override.md` | Bản override **thay** `AGENTS.md` cùng thư mục, không cộng thêm. Trần tổng `project_doc_max_bytes` mặc định 32 KiB. Import, chú thích: chưa có tài liệu [Unverified] | learn.chatgpt.com/docs/agent-configuration/agents-md |
| Gemini CLI | `GEMINI.md` ở workspace và thư mục cha; `~/.gemini/GEMINI.md` | Không có. Gần nhất: `context.fileName: ["GEMINI.md","GEMINI.local.md"]` trong `.gemini/settings.json` | `.gemini/settings.json` có thể đang được theo dõi bằng git | geminicli.com/docs/cli/gemini-md |
| Antigravity | `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md` (cũ: `.agent/rules`) | File rule mới **`.agents/rules/xdev-hive.md`** | Rule **phải** có frontmatter `trigger: always_on`, thiếu thì bị bỏ **im lặng**. Rule > 24.000 byte bị cắt; rule chung và `always_on` chung ngân sách 20.000 token | antigravity.google/docs/rules |

**Decision** (file đích mỗi CLI):

| CLI | File đích | Cách ghi |
|---|---|---|
| Claude Code | `<dự án>/CLAUDE.local.md` | Khối đánh dấu. Nếu thư mục không có `CLAUDE.md` mà có `AGENTS.md`, khối có thêm dòng `@AGENTS.md` để Claude vẫn đọc `AGENTS.md` |
| Codex | `<dự án>/AGENTS.override.md` | **Bản gương**: nội dung `AGENTS.md` của repo (nếu có) + khối. Lưu băm `AGENTS.md`; `AGENTS.md` đổi thì trạng thái "lệch" và lần đồng bộ sau dựng lại. Phần ngoài khối là của app, không phải chữ người dùng; nếu người dùng đã có `AGENTS.override.md` do họ viết thì **bỏ qua** Codex, ghi lý do |
| Gemini CLI | `<dự án>/GEMINI.local.md` + thêm tên vào `context.fileName` của `.gemini/settings.json` | Chỉ khi `.gemini/settings.json` chưa có hoặc không bị git theo dõi; bị theo dõi thì bỏ qua Gemini, ghi lý do |
| Antigravity | `<dự án>/.agents/rules/xdev-hive.md` | Cả file do app sở hữu, frontmatter `trigger: always_on` rồi khối |

**Rationale**: mỗi CLI có đúng một chỗ cục bộ đọc được tự động, không đổi file trong repo.

**Alternatives**: import `@~/.xdev-hive/...` từ file trong repo (Claude hỏi duyệt mỗi dự án, phải sửa file theo dõi);
ghi vào file toàn cục `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md` (không theo dự án, nhiều dự án đè nhau).

**Cần kiểm tay trước khi chốt T0xx** (task kiểm ở P1): Codex có giữ chú thích HTML không; `agy` có đọc `.agents/rules` khi
chạy CLI không; Gemini đọc `GEMINI.local.md` qua `context.fileName` ở settings dự án.

## 2. Dấu khối

**Decision**: dòng mở `<!-- xdev-hive:context v1 sha=<12 hex> -->`, dòng đóng `<!-- /xdev-hive:context -->`. `sha` là băm
nội dung giữa hai dòng lúc app ghi; app so băm để phát hiện sửa tay (FR-005). Trong khối có hai mục `## Tại máy` và
`## Từ hub` (FR-004).

**Rationale**: Claude bỏ chú thích cấp khối nên dấu không tốn token; các CLI khác thấy chú thích như chữ thường (vài
chục byte). Băm ngay trong dấu nên không cần đọc trạng thái để biết khối bị sửa.

**Alternatives**: dấu bằng tiêu đề Markdown (tốn token, dễ bị người dùng sửa); chỉ lưu băm trong `state.json` (mất trạng
thái thì không phân biệt được sửa tay).

## 3. Code dùng lại

| Phần | Ở đâu | Dùng thế nào |
|---|---|---|
| Sao lưu, thùng rác, khôi phục | `worker/internal/memstore/ops.go` `Store.begin/save/commit`, `Restore(id)`, `Entries()` | **Xuất ra** (đổi tên public) để gói mới ghi khối có sao lưu và hoàn tác |
| Thêm/gỡ git exclude | `memstore/shared.go:573 gitExclude`, `:600 removeGitExclude` (kiểm bằng `git check-ignore`) | **Tách** sang gói `worker/internal/gitexclude`; `runner.go:1243 appendExclude` và Rust `token_score.rs:570 add_exclude` giữ nguyên ở spec này |
| Khoá dự án | `memstore.ProjectKey(folder)` | Khoá thư mục nguồn khi dự án chưa gắn hub |
| Gắn dự án hub | `worker/internal/projects` (`projects.json`), desktop `local_projects` | Nguồn gắn theo `ProjectID` khi có |
| Bộ tối ưu | `optimizer.Enable/Disable/Status/Restore`, sao lưu theo gói | Bước "bật tối ưu" của nút; hoàn tác bằng `Restore(p, backup)` theo đường sao lưu đã ghi |
| Sửa nhanh | `score/criteria.go` id sửa, `optimizeFixPreview`, ngăn xếp hoàn tác `score-fixes.json`, Rust `token_score.rs FIXES` | Bước "sửa nhanh an toàn"; chỉ id trong `FIXES` |
| Chia sẻ memory Claude cũ | `memstore.Share/Unshare`, `memory-shared.json` | Đọc để đề nghị chuyển sang nguồn mới (FR-007), rồi `Unshare` |
| Memory hub | `memoryContract.list` (`GET /v1/memories`), `listMemories` lọc theo dự án + đội/tổ chức thấy được, `status` approved, phân trang ≤ 200 | Desktop gọi bằng PAT; không có `updatedSince` nên mỗi lần lấy cả danh sách và **thay cả** mục "Từ hub" (≤ 200 mục, đủ cho ngân sách) |
| Cài đặt dự án | `projects.settings` jsonb, `updateProjectSettings` (quyền admin đội/tổ chức, audit `project.settings.update`), mục `SETTINGS_SECTIONS` trên web | Thêm trường `devOptimizer` **tách** khỏi `tokenSaving` (D6); không cần bảng mới |
| Sự kiện máy | `POST /v1/client-events`, `withClientEvent` chống trùng theo `idempotency_key`, `hubclient.PostClientEvent` (token máy) | Thêm kiểu `memory.propose` và `project.token_usage` |
| Outbox | Thiết kế ở `specs/027-hub-client-model/data-model.md` (thư mục `outbox/<identity>/<ulid>.json`, trạng thái, backoff 5 s→5 phút, hết hạn 14 ngày). **Chưa làm** | Làm phần tối thiểu: kho + bộ gửi cho kênh `worker` (sự kiện máy). Không làm kênh `rpc` |

## 4. Kéo memory: thứ tự và ngân sách

`memories` không có `pinned`, không có `updated_at`; bản bị thay giữ dòng và có `superseded_by`; bản bị từ chối bị xoá.

**Decision**: thêm cột `pinned boolean not null default false` (migration 0084) và nút ghim trên web (quyền như duyệt
memory). Thứ tự lấy: ghim trước, rồi `created_at` mới trước; chỉ `approved`, bỏ bản có `superseded_by`. Mỗi lần đồng bộ
thay cả mục "Từ hub", nên bản bị thay/gỡ tự biến mất (FR-023) mà không cần con trỏ.

**Alternatives**: thứ tự theo `kind` (không cho người dùng chọn cái quan trọng); con trỏ `updatedSince` (cần thêm
`updated_at` và bia mộ cho bản xoá, phức tạp hơn mà số mục nhỏ).

## 5. Gửi memory lên hub qua outbox

`memory.write` là RPC của người dùng (PAT), worker không gọi được bằng token máy; kênh `rpc` của outbox 027 chưa có và
hub chưa chống trùng `/rpc`.

**Decision**: thêm kiểu sự kiện máy `memory.propose` vào `POST /v1/client-events`. Hub ghi memory `pending` thay chủ máy
(`registeredBy`), kiểm như `writeMemory` (chính sách memory của tổ chức, quyền vào dự án, ≤ 2.000 ký tự). Chống trùng có
sẵn nhờ `withClientEvent`. Desktop xếp việc qua sidecar `hive-worker outbox submit`.

**Rationale**: dùng đúng một đường đã có chống trùng, ghi máy nguồn và người, có mã từ chối (`ClientEventRejected`).

**Alternatives**: làm kênh `rpc` của 027 (cần chống trùng trên `/rpc`, rộng hơn spec này); gửi thẳng như hiện nay (mất
khi ngoại tuyến).

## 6. Báo cáo token theo dự án

`machine_token_scores` không có `project_id`, `user_id`; tokenreport đã có `cwd` từng phiên (spec 025).

**Decision**: kiểu sự kiện `project.token_usage`: `{projectId, periodStart, periodEnd, tokensByCli, sessions, score?,
policyDrift[]}` — chỉ số, id và tên mục chính sách, không chuỗi tự do. Bảng mới `project_token_usage` (một dòng mỗi máy ×
dự án × kỳ 7 ngày), ép RLS, giữ 90 ngày, giới hạn 1 lần/10 phút mỗi máy × dự án như điểm máy. Phiên được gán dự án khi
`cwd` nằm trong thư mục đã gắn dự án trong `projects.json`.

**Alternatives**: thêm cột vào `machine_token_scores` (điểm là của máy, không của dự án; trộn hai khái niệm).

## 7. Chính sách gói CLI khi nhiều dự án đòi khác nhau (FR-033)

Biến môi trường, hook nằm ở cấp gói CLI, không theo dự án. **Decision**: lấy mức cao nhất theo thứ tự
`off < balanced < aggressive`; `rtk`, `codegraph` là hoặc; trần nén lấy giá trị nhỏ nhất. `aggressive` vẫn cần xác nhận
riêng (FR-015). Xem trước ghi dự án nào đòi mức đó.

## 8. Đồng thời và khoá

Nút "Tối ưu" và đồng bộ ngữ cảnh đều ghi file của nhiều CLI. **Decision**: một khoá file `~/.xdev-hive/optimizer/optimize.lock`
(dùng cơ chế `score.LockHistory` sẵn có làm mẫu); lần thứ hai trả lỗi "Đang tối ưu ở cửa sổ khác" (FR-016). Đồng bộ định
kỳ bỏ lượt khi khoá bận.
