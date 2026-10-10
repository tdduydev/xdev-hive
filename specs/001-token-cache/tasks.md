---

description: "Task list: Cache để agent đỡ tốn token (client, server, tài liệu)"
---

# Tasks: Cache để agent đỡ tốn token (client, server, tài liệu)

**Input**: Design documents from `specs/001-token-cache/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md), [contracts/](./contracts/), [quickstart.md](./quickstart.md)

**Tests**: Có. Plan và quickstart đã đặt tên các file test (`prompt-prefix.test.ts`, `doc-conditional.test.ts`, `doc-digest.test.ts`, `mcp.test.ts`, `costs.test.ts`, `alerts.test.ts`), và CI chạy `npm test`. Test của mỗi story viết trước, phải FAIL trước khi làm phần code.

**Organization**: Task nhóm theo user story để làm và kiểm từng story riêng.

**Ghi chú dựng**: File này dựng bằng tay theo `.specify/templates/tasks-template.md`. Máy chạy không cho chạy `setup-tasks.ps1` (không có `pwsh`, và không được phép chạy script PowerShell). Dòng code ghi theo commit `4cc64a8f`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Làm song song được (file khác nhau, không chờ task chưa xong)
- **[Story]**: User story của task (US1…US5)
- Đường dẫn tính từ gốc repo

## Path Conventions

Monorepo (xem plan "Project Structure"): `packages/core/src`, `packages/core/test`, `packages/mcp/src`, `packages/mcp/test`, `apps/desktop/src/main`, `apps/desktop/test`, `apps/web/src`, `apps/web/test`, `packages/ui/src`, `packages/ui-kit/src`. Import khác thư mục dùng alias (`#core/`, `#mcp/`, `#desktop/`, `#web/`, `#ui/`, `#kit/`), không dùng `../`.

---

## Phase 1: Setup (đo trước, sửa sau)

**Purpose**: Kiểm giả thuyết của research R1/R7 trước khi đổi code. Kết quả phase này quyết định có làm T017 (khe đường dẫn cố định) không.

- [ ] T001 [P] Kiểm tài liệu gốc về prompt cache của Claude (Claude Code), Codex, Gemini CLI: cache tự động hay không, thời gian sống, giá ghi/đọc, độ dài tối thiểu, CLI có đưa đường dẫn làm việc / ngày giờ / git status vào system prompt không. Ghi nguồn (URL, ngày đọc) và sửa bảng R7 trong `specs/001-token-cache/research.md`. Bỏ nhãn [Unverified] chỉ ở dòng đã có nguồn.
- [ ] T002 Đo nền theo `specs/001-token-cache/quickstart.md` Kịch bản 1: hai task giống nhau cùng dự án, cùng gói Claude, vai trò `implement`, (a) cách nhau < 1 phút, (b) cách ~10 phút, (c) cùng một task chạy lại (cùng worktree). Ghi `cache write` / `cache read` từng run vào `.xdev-hive/artifacts/cache-baseline.md`. (phụ thuộc T001)
- [ ] T003 Từ số đo T002, chốt hướng R2 (đảo thứ tự prompt / khe đường dẫn cố định / chỉ TTL) và sửa dòng **Trạng thái** trong `specs/001-token-cache/contracts/run-prompt-layout.md`. Ghi quyết định bằng `memory_write`. (phụ thuộc T002)
- [ ] T004 [P] Kiểm trạng thái 80c (doc-lean) và 80e (prompt-dedupe) trên Hive (`task_get`) và `docs/roadmap.md` (khoảng dòng 427-431). Ghi kết quả vào mục "Phụ thuộc" của `specs/001-token-cache/plan.md`. US3 không bắt đầu khi 80c chưa xong; T011 phải ghép với 80e nếu 80e đang làm.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Kiểu dữ liệu và cột `run_costs` mà US1 và US4 cùng dùng.

**⚠️ CRITICAL**: US1 và US4 chưa làm được khi phase này chưa xong. US2 chỉ cần T005.

- [ ] T005 [P] Thêm vào `packages/core/src/types.ts` các kiểu theo nguyên văn data-model: `PrefixPart` (§1: `{ kind: "protocol"; hash } | { kind: "tools"; hash; count } | { kind: "doc"; key; version } | { kind: "skill"; key; version } | { kind: "step"; hash }`), `DigestSection` (§3: `{ id: string; title: string; level: 1 | 2 | 3; chars: number }`), `CacheSummary` (§5: `writePerRun: number | null`, `readRatio: number | null`, `unchangedHits`, `avoidedTokensEst`, `unknownRuns`, `prefixChanges`, `expiredRuns`).
- [ ] T006 Nối **vào cuối** `MIGRATIONS` trong `packages/core/src/sqlite.ts` (không chèn giữa, xem chú thích quanh `sqlite.ts:900`) một migration thêm vào `run_costs`: `prefix_fp TEXT NULL`, `prefix_parts TEXT NULL` (JSON `PrefixPart[]`), `prefix_chars INTEGER NULL`, `unchanged_hits INTEGER NULL`, `avoided_tokens_est INTEGER NULL`. Hai cột cuối lấy từ research R6 (xem "Điểm lệch giữa các tài liệu" ở cuối file). (phụ thuộc T005)
- [ ] T007 Mở rộng schema `runCost` (`packages/core/src/methods.ts:208`, dùng trong `machines.heartbeat.costs`) với trường tuỳ chọn, mặc định `null`: `prefixFp` (sha256 hex, `/^[0-9a-f]{64}$/`), `prefixParts` (`PrefixPart[]`, giới hạn độ dài mảng), `prefixChars` (int ≥ 0). Ghi ba trường vào câu `INSERT OR IGNORE INTO run_costs` ở `packages/core/src/sqlite.ts:8961`. App cũ không gửi thì cột là NULL. (phụ thuộc T006)
- [ ] T008 [P] Test trong `packages/core/test/costs.test.ts`: heartbeat có `prefixFp/prefixParts/prefixChars` thì `run_costs` lưu đúng; heartbeat kiểu cũ (không có trường) vẫn nhận và cột là NULL; `prefixFp` sai định dạng bị từ chối. (phụ thuộc T007)

**Checkpoint**: Hub nhận và lưu được dấu vân tay prefix. US1, US2, US4 bắt đầu được.

---

## Phase 3: User Story 1 - Run sau dùng lại phần đầu ngữ cảnh của run trước (Priority: P1) 🎯 MVP

**Goal**: Phần đầu tin nhắn của run (giao thức, skill/rule, step prompt, steer) giống hệt từng byte giữa các run cùng dự án / loại agent / vai trò. Phần riêng của run đứng sau một dòng phân cách. Mỗi run gửi `prefixFp` + `prefixParts` lên hub (FR-001 → FR-004, FR-019 phần prefix).

**Independent Test**: `node --test apps/desktop/test/prompt-prefix.test.ts` xanh. Chạy lại quickstart Kịch bản 1: run 2 ghi cache ít hơn run 1 ≥ 50% (SC-001, chỉ với Claude/Kilo/OpenCode).

### Tests for User Story 1 ⚠️

- [ ] T009 [P] [US1] Viết `apps/desktop/test/prompt-prefix.test.ts`: (1) dựng prompt cho hai task khác nhau cùng dự án/vai trò, phần trước SEPARATOR bằng nhau từng byte và `prefixFp` bằng nhau; (2) đổi phiên bản một skill, `prefixFp` đổi và `prefixParts` chỉ khác ở mục skill đó; (3) phần trước SEPARATOR không chứa id task/run, tiêu đề task, đường dẫn tuyệt đối, branch, SHA, ngày giờ, tên máy, id profile; (4) `prefixParts` theo thứ tự `protocol → tools → doc → skill → step`; (5) prompt judge (`c.judge`) không đổi so với hôm nay.

### Implementation for User Story 1

- [ ] T010 [US1] Trong `packages/core/src/prompt-layers.ts`: thêm hằng `SEPARATOR` (một dòng cố định, ví dụ `--- This run ---`), `stablePrefixLines(c)` (phần 1–6 của `contracts/run-prompt-layout.md`) và `runLines(c)` (phần 7–11). Tách các giá trị riêng của run ra khỏi `frameLines` (dòng 47-97). Danh sách skill/rule sắp theo tên, đường dẫn tương đối với worktree. (phụ thuộc T003, T004)
- [ ] T011 [US1] Sửa `buildPrompt` trong `apps/desktop/src/main/runner/command.ts` (dòng 79-145) thành `stablePrefixLines + SEPARATOR + runLines`. Biến của step prompt (taskId, taskTitle, service, branch) chỉ chèn ở phần run. Judge giữ bố cục cũ. Nếu 80e đang làm, ghép cùng thay đổi `frameLines`. (phụ thuộc T010)
- [ ] T012 [US1] Thêm `prefixFingerprint(...)` trong `apps/desktop/src/main/runner/command.ts`: trả `{ prefixFp, prefixParts, prefixChars }` với `prefixFp = sha256(text(1–6) + "\n" + toolsHash + "\n" + JSON(docVersions))`, `prefixParts` theo data-model §1. (phụ thuộc T005, T011)
- [ ] T013 [US1] Tính `toolsHash` = sha256 của danh sách `{name, description, inputSchema}` mà server MCP xdev-hive đăng ký cho vai trò của run (`packages/mcp/src/server.ts`, tool ghi chỉ có khi `writes`, lời dặn khác nhau theo loại run ở `:172`, `:189-193`). Giữ kết quả theo (phiên bản app, phiên bản hub, vai trò), không gọi `tools/list` mỗi run. Đặt trong `apps/desktop/src/main/runner/command.ts` hoặc file mới cạnh nó. (phụ thuộc T012)
- [ ] T014 [US1] Trong `apps/desktop/src/main/runner/runner.ts` (khoảng dòng 2470-2494 nơi gọi `buildPrompt`, và 1467-1482 nơi dựng báo cáo cost): giữ `prefixFp/prefixParts/prefixChars` của run trong `runs.db` (`apps/desktop/src/main/runner/store.ts`, cột mới nối đuôi migration của store) và gửi theo `costs[]` của heartbeat. (phụ thuộc T007, T012)
- [ ] T015 [US1] Tăng `version` trong `apps/desktop/package.json` và thêm mục 81 (phần US1) vào `docs/roadmap.md`.
- [ ] T016 [US1] Chạy lại quickstart Kịch bản 1 sau khi sửa, thêm bảng "sau" vào `.xdev-hive/artifacts/cache-baseline.md`. Ghi run 2 giảm ghi cache bao nhiêu % so với run 1. (phụ thuộc T014)
- [ ] T017 [US1] **Chỉ làm khi T003 chốt cần**: chạy agent trong khe cố định `worktrees/<project>/slot-<n>` theo (dự án, vai trò), gắn worktree của task vào khe trước khi chạy và trả lại sau khi xong, trong `apps/desktop/src/main/runner/runner.ts` (và phần quản lý worktree). Điều kiện làm: T002 cho thấy cùng đường dẫn giúp run 2 giảm ghi cache ≥ 30%. Cần xét khoá và run song song. (phụ thuộc T003, T014)

**Checkpoint**: US1 chạy và kiểm được riêng. `run_costs.prefix_*` có dữ liệu cho run mới.

---

## Phase 4: User Story 2 - Agent không tải lại tài liệu, skill, bộ nhớ đã có (Priority: P1)

**Goal**: `doc_get`, `skill_get`, `memory_search` trả câu ngắn "không đổi" / "giống lần trước" khi agent đã có bản mới nhất, theo `have` hoặc theo biên nhận đọc của run. Luôn kiểm quyền và trạng thái gỡ trước (FR-005 → FR-010).

**Independent Test**: `node --test packages/core/test/doc-conditional.test.ts packages/mcp/test/mcp.test.ts` xanh, đủ các dòng của bảng quickstart Kịch bản 3.

### Tests for User Story 2 ⚠️

- [ ] T018 [P] [US2] Viết `packages/core/test/doc-conditional.test.ts` trên `SqliteHive(":memory:")`, actor có `runCredential.run = "R-1"`, đủ các dòng bảng quickstart Kịch bản 3: đọc lần 1 đầy đủ và có dòng `run_reads (R-1, doc, key, v1)`; lần 2 `{unchanged:true, version:1}`; `full:true` đầy đủ; sửa thì nhận v2; gỡ rồi `have:2` thì lỗi `removed`; thu quyền rồi `have:2` thì lỗi quyền; `memory.search` cùng câu 2 lần thì lần 2 `{same:true}`; đánh dấu `stale` một mục thì nhận danh sách đầy đủ; actor không có `runCredential` thì luôn đầy đủ. Thêm: `use_count` của mục bộ nhớ vẫn tăng ở lần trả `same`; `skill_get` một skill đã gỡ trả lỗi.
- [ ] T019 [P] [US2] Mở rộng `packages/mcp/test/mcp.test.ts`: dạng trả lời `unchanged` của `doc_get` / `skill_get` và `same` của `memory_search` dài < 400 ký tự (SC-003); `doc_get` chỉ gọi `docs.get` một lần; cỡ `tools/list` tăng ≤ 1200 ký tự so với hằng số đo trước khi sửa (FR-010).

### Implementation for User Story 2

- [ ] T020 [US2] Nối vào cuối `MIGRATIONS` (`packages/core/src/sqlite.ts`) bảng `run_reads` đúng như data-model §2: `run TEXT NOT NULL`, `kind TEXT NOT NULL` (`'doc' | 'skill' | 'digest' | 'memory'`), `key TEXT NOT NULL`, `version INTEGER` (memory: NULL), `hash TEXT` (doc: NULL), `chars INTEGER NOT NULL`, `hits INTEGER NOT NULL DEFAULT 0`, `at TEXT NOT NULL`, `PRIMARY KEY(run, kind, key)`, và `CREATE INDEX run_reads_at ON run_reads(at)`. (phụ thuộc T006 nếu cùng chuỗi migration)
- [ ] T021 [US2] Mở rộng input `docs.get` trong `packages/core/src/methods.ts` (dòng 323): `have?: number` (int ≥ 1), `full?: boolean`. Output thêm `version`, `removedAt?` và dạng `{ key, version, unchanged: true }`. Gọi từ web/desktop không truyền trường mới thì nhận `Doc` như cũ.
- [ ] T022 [US2] Cài `docs.get` trong `packages/core/src/sqlite.ts` theo thứ tự của `contracts/mcp-tools.md`: (1) kiểm quyền (`#check`/`sees()`) và `removed_at`, có lỗi thì trả lỗi; (2) `full` thì đầy đủ; (3) `have === version` hoặc có biên nhận `(run, doc, key, version)` thì `unchanged` và `hits + 1`; (4) còn lại đầy đủ và UPSERT biên nhận. Chỉ ghi biên nhận khi actor có `runCredential`. Trả `removedAt` trong cùng câu trả lời. Kiểm thêm ≤ 1 truy vấn theo khoá chính. (phụ thuộc T020, T021)
- [ ] T023 [US2] Sửa `doc_get` trong `packages/mcp/src/server.ts` (dòng 268-283): truyền `have`/`full`, gộp hai lần gọi `docs.get` thành một (dùng `removedAt` của câu trả lời), định dạng `unchanged` như `contracts/mcp-tools.md` dạng 1 (`hint: "full:true for the content"`). Giữ nguyên chữ lỗi `not_found: <key> was removed on <date>`. (phụ thuộc T022)
- [ ] T024 [US2] `skill_get` trong `packages/mcp/src/server.ts` (dòng 386-405) và đường đọc skill của hub (`packages/core/src/skills.ts`, skill là dòng trong `docs`): nhận `have?`/`full?`, áp quy tắc 1, 2, 4, 6 của `doc_get` (không digest), và **thêm** kiểm `removed_at` (hôm nay chưa có). Biên nhận dùng `kind = 'skill'`. (phụ thuộc T022)
- [ ] T025 [US2] `memory.search` trong `packages/core/src/sqlite.ts` (khoảng dòng 8200) và schema trong `packages/core/src/methods.ts`: nhận `full?: boolean`; biên nhận `kind='memory'`, `key = sha256(project|query|limit)`, `hash = sha256(JSON [(id, updatedAt, review, stale, supersededBy, conflictsWith)…])` theo thứ tự trả; hash trùng và không `full` thì trả `{ same: true, ids }`. **Vẫn cập nhật `use_count` / `last_used_at`** như khi trả đầy đủ. (phụ thuộc T020)
- [ ] T026 [US2] `memory_search` trong `packages/mcp/src/server.ts`: truyền `full`, định dạng `same` như `contracts/mcp-tools.md` (`hint: "same results and flags as your last identical search; full:true to list them"`). (phụ thuộc T025)
- [ ] T027 [US2] Sửa mô tả tool `doc_get`, `skill_get`, `memory_search` trong `packages/mcp/src/server.ts` theo câu gợi ý ở cuối `contracts/mcp-tools.md`. Tổng thêm ≤ 300 token (T019 đo). (phụ thuộc T023, T024, T026)
- [ ] T028 [US2] Thêm method dọn của `SqliteHive` (`packages/core/src/sqlite.ts`) xoá `run_reads` có `at` cũ hơn 48 giờ, gọi trong `cleanupRound` (`apps/web/src/server.ts:107`). (phụ thuộc T020)
- [ ] T029 [US2] Ghi gotcha bằng `memory_write`: `memory.search` ghi khi đọc (`use_count`), nhánh `same` phải giữ; `/mcp` không có phiên nên biên nhận nằm ở hub. Thêm mục 81 (US2) vào `docs/roadmap.md`.

**Checkpoint**: US1 và US2 đều chạy được riêng. Đây là MVP đầy đủ của 81 (hai story P1).

---

## Phase 5: User Story 3 - Agent đọc mục lục và tóm tắt trước, rồi chỉ phần cần (Priority: P2)

**⛔ Chặn bởi**: 80c (đọc theo `section`) và câu hỏi **FR-012** (ai làm tóm tắt). Task dưới viết theo hướng tạm (b)+(c): đoạn mở đầu của tác giả + mục lục tự động, không dùng model. Người quản trị chọn khác thì sửa T030, T031 trước khi làm.

**Goal**: Tài liệu dài (> 4k token ước tính) đọc mặc định trả mục lục + tóm tắt < 2k token, làm sẵn một lần cho mỗi phiên bản; từng mục là nguyên văn (FR-011 → FR-014).

**Independent Test**: `node --test packages/core/test/doc-digest.test.ts` xanh; quickstart Kịch bản 4.

### Tests for User Story 3 ⚠️

- [ ] T030 [P] [US3] Viết `packages/core/test/doc-digest.test.ts`: `buildDigest` tất định (cùng nội dung ra cùng `toc`); tiêu đề trùng có hậu tố `-2`, `-3`; `summary` là đoạn trước `##` đầu tiên, bỏ tiêu đề `#`, cắt ~800 ký tự ở ranh giới câu, NULL khi không có đoạn mở đầu; tài liệu dài trả digest < 8 000 ký tự (SC-004); `section:<id>` trả đúng nguyên văn mục; sửa tài liệu thì digest khớp `version` mới; tài liệu ngắn (`chars / 4 ≤ 4000`) trả cả nội dung.

### Implementation for User Story 3

- [ ] T031 [P] [US3] Tạo `packages/core/src/doc-digest.ts`: `buildDigest(content) → { toc: DigestSection[]; summary: string | null; chars: number }`, tất định, dựng từ tiêu đề Markdown `#`…`###`; `id` là slug của tiêu đề (cùng cách slug với `section` của 80c). (phụ thuộc T005)
- [ ] T032 [US3] Nối vào cuối `MIGRATIONS` (`packages/core/src/sqlite.ts`) bảng `doc_digests` đúng data-model §3: `key TEXT NOT NULL`, `version INTEGER NOT NULL`, `toc TEXT NOT NULL` (JSON `DigestSection[]`), `summary TEXT` (NULL nếu không có đoạn mở đầu), `chars INTEGER NOT NULL`, `created_at TEXT NOT NULL`, `PRIMARY KEY(key, version)`.
- [ ] T033 [US3] `docs.get` trong `packages/core/src/methods.ts` và `packages/core/src/sqlite.ts`: nhận `digest?: boolean` và `section?: string` (từ 80c). Khi `digest` và tài liệu có `chars / 4 > 4000`: làm lười digest cho `(key, version hiện tại)` nếu chưa có, trả `{ key, version, digest: true, chars, summary, toc }`; biên nhận `kind='digest'`; đã trả digest cùng version trong run thì trả `unchanged`. Luôn đọc digest theo `version` hiện tại của `docs`. (phụ thuộc T022, T031, T032, 80c)
- [ ] T034 [US3] `doc_get` trong `packages/mcp/src/server.ts`: đặt `digest:true` khi không `full` và không `section`; định dạng dạng 2 (`hint: "section:<id> for one section, full:true for everything"`) và dạng 4 của `contracts/mcp-tools.md`. Cập nhật mô tả tool, vẫn trong giới hạn của T019. (phụ thuộc T033)
- [ ] T035 [US3] Trong method dọn của T028: xoá `doc_digests` có `version <` `docs.version` của cùng key. (phụ thuộc T028, T032)
- [ ] T036 [US3] Thêm mục 81 (US3) vào `docs/roadmap.md`.

**Checkpoint**: Tài liệu dài trả digest; US1, US2 không đổi hành vi.

---

## Phase 6: User Story 4 - Người quản trị thấy cache tiết kiệm được bao nhiêu (Priority: P2)

**Goal**: Trang chi phí hiện theo dự án và gói, 24h / 7d / 30d: ghi cache trung bình mỗi run, tỉ lệ đọc cache, số lần "không đổi", token tránh được (ghi rõ là ước tính), "chưa rõ" cho loại agent không báo cache write; cảnh báo khi ghi cache tăng vọt (FR-019 → FR-022).

**Independent Test**: `node --test packages/core/test/costs.test.ts apps/web/test/alerts.test.ts` xanh; quickstart Kịch bản 5 trên giao diện và e2e.

**Phụ thuộc**: Phase 2. Số "không đổi" cần US2 (T020–T022); nếu làm US4 trước US2 thì các số đó là 0.

### Tests for User Story 4 ⚠️

- [ ] T037 [P] [US4] Mở rộng `packages/core/test/costs.test.ts`: `costs.summary.cache` (tổng, `byProject`, `byProfile`) đúng `writePerRun`, `readRatio = cache_read / (input + cache_read + cache_write)`, `unchangedHits`, `avoidedTokensEst = SUM(hits * chars / 4)`; run có cache write không rõ không tính vào `writePerRun` và tăng `unknownRuns`; hai run cùng `prefix_fp` nhưng run sau ghi cache lớn thì tính `expiredRuns`, không tính `prefixChanges`; số "không đổi" của run cũ hơn 48 giờ vẫn còn trong khoảng 7d/30d.
- [ ] T038 [P] [US4] Mở rộng `apps/web/test/alerts.test.ts`: 5 run trong 24h với `cache_write` gấp 3 lần kỳ trước và `prefix_parts` khác ở một doc thì `alerts.check()` tạo `cache_write_spike` (mức `warn`) với `changedParts` nêu đúng doc đó; < 5 run thì không cảnh báo.

### Implementation for User Story 4

- [ ] T039 [US4] Lúc nhận `costs[]` trong heartbeat (`packages/core/src/sqlite.ts:8961`): điền `unchanged_hits = SUM(hits)` và `avoided_tokens_est = SUM(hits * chars / 4)` từ `run_reads WHERE run = runId`, để số không mất khi T028 xoá biên nhận sau 48 giờ. Kiểm trước: `actor.runCredential.run` (biên nhận) và `runCost.runId` (báo cáo cost) là cùng một id. Nếu khác, ghi gotcha và nối hai id. (phụ thuộc T007, T020)
- [ ] T040 [US4] Làm rõ "cache write chưa rõ" (FR-022): `run_costs` không có cột loại agent. Hướng đề xuất: máy gửi `cacheWriteTokens = null` cho Codex (hôm nay gửi `0`, `apps/desktop/src/main/runner/usage.ts:55-79`) giống Gemini (`null`, `gemini.ts:70`), để hub tính "chưa rõ" theo `cache_write_tokens IS NULL`. Kiểm chỗ khác đọc số 0 của Codex (28c, trang *Lượt chạy*) trước khi đổi. Chọn hướng khác (thêm loại agent vào `runCost`) thì sửa data-model §5. (phụ thuộc T001)
- [ ] T041 [US4] Mở rộng `costs.summary` trong `packages/core/src/sqlite.ts` (dòng 10224) và schema output trong `packages/core/src/methods.ts`: thêm `cache: CacheSummary` cho tổng, `byProject`, `byProfile`, theo 24h / 7d / 30d. `prefixChanges` / `expiredRuns` so với run trước cùng (dự án, gói, vai trò), lấy vai trò bằng cách join `runs` như truy vấn ở `sqlite.ts:4096`. Vẫn lọc `sees(actor, project)`. (phụ thuộc T039, T040)
- [ ] T042 [US4] Thêm `AlertRule` `cache_write_spike` vào `apps/web/src/alerts.ts`: `writePerRun(24h) > 2 × writePerRun(8 ngày trước → 1 ngày trước)` và ≥ 5 run trong 24h; payload `{ project, writePerRun24h, writePerRunPrev, changedParts: PrefixPart[] }`, với `changedParts` là các `PrefixPart` khác nhau giữa run gần nhất và `prefix_parts` thường gặp nhất của kỳ trước. (phụ thuộc T041)
- [ ] T043 [P] [US4] Thêm chữ mới vào `packages/ui-kit/src/i18n/locales/vi.ts` (bản gốc) và `packages/ui-kit/src/i18n/locales/en.ts`: tiêu đề khối cache, "ghi cache trung bình/run", "tỉ lệ đọc cache", "lần trả không đổi", "token tránh được (ước tính, ký tự ÷ 4)", "chưa rõ", chữ cảnh báo `cache_write_spike`. Không sửa `packages/ui/src/i18n/locales/`.
- [ ] T044 [US4] Thêm khối số đo cache vào `OpsCosts` (`packages/ui/src/pages/admin/Ops.tsx:526`) theo dự án và gói, chọn 24h / 7d / 30d, dùng thẻ số liệu sẵn có và token của `packages/ui-kit/src/tokens/` (không màu mới). Số tránh được ghi rõ là ước tính và cách ước. (phụ thuộc T041, T043)
- [ ] T045 [US4] Chạy `npm run e2e -w @xdev-hive/web -- <thư mục ảnh>` và `npm run e2e:mobile -w @xdev-hive/web -- <thư mục ảnh>`; thêm bước kiểm khối cache vào `apps/web/e2e/browser.mjs` nếu cần (khai `NEEDS` nếu dùng tab của bước khác). Lưu ảnh vào `.xdev-hive/artifacts/`. (phụ thuộc T044)
- [ ] T046 [US4] Thêm mục 81 (US4) vào `docs/roadmap.md`; nếu T040 đổi app thì tăng `version` trong `apps/desktop/package.json`.

**Checkpoint**: Người quản trị trả lời được "tuần này cache tiết kiệm bao nhiêu, dự án nào bị phá cache" từ trang chi phí (SC-006).

---

## Phase 7: User Story 5 - Máy dùng lại bản sao tài liệu và skill giữa các run (Priority: P3)

**⛔ Chặn bởi**: câu hỏi **FR-016** (phạm vi lưu trên máy). Task dưới viết theo hướng tạm (b): thư mục theo tài khoản trong appData, dùng lại giữa các run, xoá khi đăng xuất hoặc mất quyền. Người quản trị chọn (a) thì bỏ phase này; chọn (c) thì thêm T053.

**Goal**: Run mới chỉ hỏi phiên bản và chỉ tải tài liệu/skill đã đổi (FR-015 → FR-018).

**Independent Test**: quickstart Kịch bản 6: run 2 log `doc-cache: 0 fetched, N reused`; sửa một tài liệu thì run 3 log `1 fetched`; đăng xuất thì thư mục bản sao không còn.

### Tests for User Story 5 ⚠️

- [ ] T047 [P] [US5] Test hub cho `docs.manifest` trong `packages/core/test/doc-conditional.test.ts`: quyền như `docs.list` (lọc `sees()`), trả cả mục đã gỡ với `removed:true`, actor không có quyền dự án thì lỗi quyền.
- [ ] T048 [P] [US5] Viết `apps/desktop/test/doc-cache.test.ts`: chỉ tải key có phiên bản lệch `manifest.json`; mục `removed:true` bị xoá khỏi bản sao; lỗi quyền từ `docs.manifest` xoá thư mục dự án; xoá `<hubId>/<accountId>/` khi đăng xuất; không có token/credential nào trong file đã ghi.

### Implementation for User Story 5

- [ ] T049 [US5] Thêm method `docs.manifest` (`input { project: string }`, `output { key: string; version: number; removed: boolean }[]`) vào `packages/core/src/methods.ts` (schema + bảng min-role, khoảng dòng 1617+) và `packages/core/src/sqlite.ts`; thêm vào `AGENT_METHODS` (`sqlite.ts:2043`) nếu run cần gọi.
- [ ] T050 [US5] Tạo `apps/desktop/src/main/doc-cache.ts`: bản sao ở `<appData>/doc-cache/<hubId>/<accountId>/<project>/`, gồm `manifest.json` (`{ [key]: version }`) và `<sha256(key)>.json` (`{ key, version, content }`). Quyền thư mục 0700 trên macOS/Linux; ghi rõ Windows chưa kiểm. Không ghi token/credential. (phụ thuộc T049)
- [ ] T051 [US5] Sửa `loadDocs` (`apps/desktop/src/main/sync.ts:70-73`) và `renderContext` (`sync.ts:278-301`): gọi `docs.manifest`, chỉ `docs.get` key lệch, đọc phần còn lại từ bản sao; log `doc-cache: <n> fetched, <m> reused`. (phụ thuộc T050)
- [ ] T052 [US5] Xoá bản sao khi mất quyền và khi đăng xuất: xoá `<project>/` khi hub gỡ dự án khỏi máy (`apps/desktop/src/main/machine-projects.ts`) hoặc `docs.manifest` trả lỗi quyền; xoá `<hubId>/<accountId>/` khi đổi hub/token của máy. Repo chưa có hàm "đăng xuất" riêng ở `apps/desktop/src/main`: tìm chỗ lưu cấu hình hub (gần `apps/desktop/src/main/index.ts:322`, nơi đổi token/URL) và gắn việc xoá vào đó. (phụ thuộc T050)
- [ ] T053 [US5] **Chỉ khi FR-016 chọn (c)**: thêm công tắc theo dự án tắt bản sao trên máy (cài đặt dự án + chữ ở `packages/ui-kit/src/i18n/locales/{vi,en}.ts`).
- [ ] T054 [US5] `npm run build -w @xdev-hive/desktop` rồi `npm run smoke -w @xdev-hive/desktop -- <thư mục ảnh>`; tăng `version` trong `apps/desktop/package.json`; thêm mục 81 (US5) vào `docs/roadmap.md`. (phụ thuộc T051, T052)

**Checkpoint**: Mọi user story chạy được riêng.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [ ] T055 Đo lại sau khi làm (SC-001, SC-002, SC-007): 7 ngày số liệu từ trang chi phí và *Lượt chạy*, so với số của spec 80; ghi `.xdev-hive/artifacts/cache-after.md`. Đo thêm số lần agent gọi `full:true` ngay sau `unchanged` (rủi ro "trả không đổi sai" trong plan). (phụ thuộc T016, T029, T046)
- [ ] T056 [P] Rà FR-018 trên mọi lớp cache (`run_reads`, `doc_digests`, `run_costs.prefix_parts`, bản sao trên máy): không có secret, token, nguyên văn prompt, note hay lời dặn admin.
- [ ] T057 [P] Cập nhật `docs/specs/80-tokens-plugins-path.md` hoặc tạo `docs/specs/81-token-cache.md` (qua `doc_propose` nếu là tài liệu của Hive) để ghi những gì 81 đã làm và chỗ nối với 80c/80e/80g.
- [ ] T058 Chạy `npm ci`, `npm run typecheck`, `npm test` tại máy trước khi đẩy, và chạy hết các kịch bản trong `specs/001-token-cache/quickstart.md`.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: T001 → T002 → T003. T004 song song. T003 chặn T010 và quyết định T017.
- **Foundational (Phase 2)**: T005 → T006 → T007 → T008. Chặn US1 và US4.
- **US1 (Phase 3)**: sau Phase 2, T003, T004 (và 80e nếu đang làm).
- **US2 (Phase 4)**: chỉ cần T005 (nếu dùng kiểu chung) và chuỗi migration; làm song song với US1 được.
- **US3 (Phase 5)**: sau US2 (T022, T028), **80c**, và câu trả lời FR-012.
- **US4 (Phase 6)**: sau Phase 2; số "không đổi" cần US2; `prefixChanges` cần US1 (T014).
- **US5 (Phase 7)**: sau câu trả lời FR-016; độc lập với US1–US4 về code.
- **Polish (Phase 8)**: sau các story đã chọn làm.

### User Story Dependencies

- **US1 (P1)**: không phụ thuộc story khác.
- **US2 (P1)**: không phụ thuộc story khác.
- **US3 (P2)**: dùng `run_reads` và nhánh `docs.get` của US2.
- **US4 (P2)**: đọc dữ liệu của US1 (`prefix_*`) và US2 (`run_reads`); vẫn hiện được ghi/đọc cache khi chỉ có Phase 2.
- **US5 (P3)**: độc lập.

### Migration

T006, T020, T032 cùng nối vào cuối `MIGRATIONS` trong `packages/core/src/sqlite.ts`. Làm lần lượt, không song song, và không chèn vào giữa.

### Within Each User Story

- Test viết trước và FAIL trước khi làm code.
- Schema/migration → logic hub (`sqlite.ts`) → MCP (`server.ts`) → giao diện.

### Parallel Opportunities

- T001 ∥ T004.
- T009 (test US1) ∥ T018, T019 (test US2) ∥ T037, T038 (test US4).
- US1 (desktop + `prompt-layers.ts`) ∥ US2 (`sqlite.ts` docs/memory + `server.ts`), trừ T020 phải theo sau T006 trong chuỗi migration.
- T031 (`doc-digest.ts`) ∥ T030.
- T043 (chữ i18n) ∥ T041, T042.
- T047 ∥ T048.

---

## Parallel Example: User Story 2

```bash
# Viết test cùng lúc:
Task: "T018 doc-conditional.test.ts theo bảng quickstart Kịch bản 3"
Task: "T019 mcp.test.ts: dạng unchanged/same < 400 ký tự, tools/list tăng ≤ 1200 ký tự"

# Sau T022, làm song song phần MCP và memory:
Task: "T023 doc_get trong packages/mcp/src/server.ts"
Task: "T025 memory.search có điều kiện trong packages/core/src/sqlite.ts"
```

## Parallel Example: User Story 1

```bash
Task: "T009 apps/desktop/test/prompt-prefix.test.ts"
Task: "T010 stablePrefixLines / runLines trong packages/core/src/prompt-layers.ts"
```

---

## Implementation Strategy

### MVP First (US1 + US2)

1. Phase 1: đo trước (T001–T004). Dừng nếu số đo cho thấy cache vỡ ở chỗ plan chưa tính.
2. Phase 2: kiểu và cột `run_costs`.
3. Phase 3 (US1) **và** Phase 4 (US2): hai story P1, làm song song được.
4. **Dừng và kiểm**: quickstart Kịch bản 1–3; so số với `cache-baseline.md`.

### Incremental Delivery

1. Setup + Foundational.
2. US1 → kiểm SC-001 → merge.
3. US2 → kiểm SC-003, SC-005 → merge.
4. US4 → kiểm SC-006 → merge (làm trước US3 nếu 80c chưa xong).
5. US3 → kiểm SC-004 (sau 80c và FR-012).
6. US5 (sau FR-016).
7. Polish: SC-002, SC-007.

---

## Còn mở

- **[NEEDS CLARIFICATION] FR-012** (tóm tắt tài liệu): chặn Phase 5. Hướng tạm (b)+(c).
- **[NEEDS CLARIFICATION] FR-016** (phạm vi bản sao trên máy): chặn Phase 7. Hướng tạm (b).
- **[NEEDS CLARIFICATION] FR-023** (phạm vi so với 80c/80e/80g): hướng tạm (a); thứ tự task ở trên theo hướng này.
- [Unverified] Thời gian sống và giá prompt cache của từng nhà cung cấp: T001 kiểm.

### Điểm lệch giữa các tài liệu (thấy khi dựng tasks)

1. **Số "không đổi" sau 48 giờ**: data-model §5 gộp `unchangedHits` từ `run_reads`, nhưng §2 xoá `run_reads` sau 48 giờ, nên số 7d/30d sẽ sai. Tasks theo research R6: thêm cột `unchanged_hits`, `avoided_tokens_est` vào `run_costs` (T006) và điền lúc nhận báo cáo cost (T039). Cần sửa data-model §1/§5 cho khớp.
2. **Loại agent trong `run_costs`**: data-model §5 dùng `cacheWriteKnown(kind)`, nhưng `run_costs` không có cột loại agent, còn Codex gửi `cacheWriteTokens = 0` (không phải null). T040 đề xuất cho Codex gửi `null`. Cần chốt trước T041.
3. **Báo cáo cost**: contract `hub-methods.md` ghi payload ở `runner.ts:1467-1482`. Phía hub, payload đó là `machines.heartbeat.costs[]` (schema `runCost`, `methods.ts:208`; ghi ở `sqlite.ts:8961`). T007 sửa ở đó.
4. **Đăng xuất trên máy**: data-model §4 nói "xoá khi đăng xuất", nhưng `apps/desktop/src/main` chưa có hàm đăng xuất riêng. T052 phải tìm chỗ đổi hub/token.

---

## Notes

- [P] = file khác nhau, không phụ thuộc task chưa xong.
- [USn] nối task với user story để truy vết.
- Commit sau mỗi task hoặc nhóm task.
- Không sửa trực tiếp `AGENTS.md`, `CLAUDE.md`, `docs/decisions.md`.
