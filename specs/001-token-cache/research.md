# Research: Cache để agent đỡ tốn token (Phase 0)

**Feature**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Ngày**: 2026-10-11

Đọc code ở `4cc64a8f` (main) ngày 11/10. Dòng code ghi theo `file:line` ở commit đó. Chỗ nào chưa thử trên máy thật thì ghi [Chưa kiểm]; điều về hành vi của nhà cung cấp model hay của CLI agent mà chưa đọc được tài liệu gốc thì ghi [Unverified].

Run này không mở được tài liệu của nhà cung cấp (WebFetch không được cấp quyền), nên mọi con số về prompt cache của Claude, Codex, Gemini dưới đây là [Unverified] và có task kiểm riêng (T0 trong plan).

---

## R1. Vì sao mỗi run vẫn ghi 20–77k token vào cache

**Hiện trạng (đã đọc code)**:

- Run không dùng system prompt riêng. Cả ngữ cảnh của Hive là **một tin nhắn người dùng** do `buildPrompt` dựng (`apps/desktop/src/main/runner/command.ts:79-145`, gọi ở `runner.ts:2470-2494`).
- Dòng đầu của tin nhắn đó là `frameLines` (`packages/core/src/prompt-layers.ts:47-97`): id task, tiêu đề, worktree, branch, `baseSha`. Những giá trị này **đổi mỗi run** và nằm **trước** phần ổn định (danh sách skill, step prompt, `STEER_PROMPT`). Spec 80 mục 1.2 ghi "giá trị riêng của run nằm ở tin nhắn người dùng, không ở phần đầu". Câu đó đúng với system prompt, nhưng trong tin nhắn người dùng thì phần riêng vẫn đứng đầu.
- AGENTS.md / CLAUDE.md / skill được `renderContext` ghi vào worktree trước mỗi run (`apps/desktop/src/main/sync.ts:278-301`). Claude Code tự nạp CLAUDE.md.
- Claude chạy với `--add-dir <worktree>`, `--settings <json>`, `--setting-sources user`, `--strict-mcp-config --mcp-config <json>` (`command.ts:515-575`). Không đặt biến môi trường nào về prompt cache (tìm `PROMPT_CACHING` không thấy).
- Danh sách tool MCP đăng ký theo thứ tự cố định trong mã nguồn (`packages/mcp/src/server.ts:257-842`). Tool ghi chỉ có khi `writes` đúng (`:172`), và lời dặn của server khác nhau giữa run chỉ đọc, leader và run thường (`:189-193`).

**[Unverified] Giả thuyết cần đo** (dựa trên cách prompt cache của Anthropic so khớp theo tiền tố tools → system → messages, và trên cách Claude Code dựng system prompt):

1. System prompt của Claude Code có phần môi trường (thư mục làm việc, có thể cả ngày giờ và trạng thái git). Worktree mỗi task một đường dẫn (`worktrees/<project>/<task-id>`), nên system prompt khác nhau giữa các task. Khi đó chỉ phần tool định nghĩa (nếu có breakpoint sau tool) được dùng lại.
2. CLAUDE.md của worktree (do Hive ghi) chứa project key và nội dung tài liệu. Hai run cùng dự án thì giống nhau, khác dự án thì khác.
3. Thời gian sống của prompt cache ngắn (mặc định 5 phút theo tài liệu Anthropic mà người viết nhớ, chưa đọc lại). Run cách nhau lâu hơn thì mất cache dù tiền tố giống hệt.
   - [Unverified, theo những gì thấy trong phiên này] Chính phiên Claude Code này báo "1-hour prompt-cache TTL". Có thể gói thuê bao dùng TTL 1 giờ, nhưng chưa kiểm cho gói API key hay cho Codex/Gemini.

**Decision**: Làm đo trước, sửa sau. Task đầu (T0/T1 trong plan) dựng một kịch bản đo: hai run giống nhau cùng dự án, đổi từng biến một (cùng đường dẫn worktree hay khác, cách nhau 1 phút hay 10 phút, cùng hay khác task), rồi ghi `cache_write_tokens` / `cache_read_tokens` của run thứ hai. Thiết kế FR-001 → FR-004 bên dưới chọn sẵn hướng làm, nhưng chỉ chốt sau số đo này.

**Rationale**: Số nền 20–77k của spec 80 là ước lượng trên 19 run của một máy. Chưa biết cache vỡ ở system prompt (do Claude Code dựng) hay ở tin nhắn người dùng (do Hive dựng), và hai chỗ đó cần hai cách sửa khác nhau.

**Alternatives considered**:

- Sửa thứ tự `buildPrompt` ngay, không đo. Bị loại vì nếu cache vỡ ở system prompt thì sửa thứ tự tin nhắn người dùng gần như không lợi gì.
- Tự gọi API Anthropic với `cache_control` thay vì qua CLI. Bị loại: Hive chạy agent qua CLI của người dùng (Claude Code, Codex, Gemini…), không giữ khoá API.

## R2. Phần đầu ngữ cảnh ổn định (FR-001 → FR-004)

**Decision**: Ba thay đổi, chọn hoặc bỏ tuỳ số đo R1:

1. **Đảo thứ tự `buildPrompt`**. Phần ổn định đứng trước theo thứ tự ít đổi trước (giao thức chung → skill/rule → step prompt → `STEER_PROMPT`). Phần riêng của run (`frameLines` task/worktree/SHA, note, attempt, candidate, ciFix, lời dặn admin) đứng sau một dòng phân cách cố định. Hàm mới `stablePrefixLines(c)` và `runLines(c)` trong `prompt-layers.ts`. `buildPrompt` = `stable + SEP + run`.
2. **Đường dẫn làm việc ổn định** [Chưa kiểm]. Nếu R1 cho thấy đường dẫn worktree làm vỡ system prompt: chạy agent trong một "khe" cố định theo (máy, dự án, vai trò), ví dụ `worktrees/<project>/slot-<n>`, và gắn worktree của task vào khe đó trước khi chạy (đổi tên thư mục hoặc symlink). Đây là thay đổi lớn về runner, nên để task riêng và chỉ làm khi số đo cho thấy lợi.
3. **Dấu vân tay**. `prefixFingerprint = sha256(stable prompt text + danh sách tool MCP đã chuẩn hoá + {docKey: version} của các file context đã ghi vào worktree + kind + role)`. `prefixParts` là danh sách `{kind: "doc"|"skill"|"tools"|"protocol"|"step", key, version|hash}`. Runner tính và gửi theo báo cáo cost của run (`runner.ts:1467-1482`).

**Rationale**: Thứ tự ít đổi trước là đúng với mọi nhà cung cấp so khớp theo tiền tố (Anthropic, OpenAI) [Unverified với Gemini implicit cache]. Dấu vân tay cho trang chi phí chỉ ra **vì sao** cache vỡ (FR-003, FR-021) mà không cần lưu nguyên văn prompt.

**Alternatives considered**:

- Đưa phần ổn định vào `--append-system-prompt`. Có thể được với Claude, nhưng Codex, Gemini, OpenCode không có cờ tương đương giống nhau (`command.ts:242-388`), và 80e đang bỏ giao thức lặp. Để ngỏ: T1 đo thử với Claude.
- Lưu nguyên văn prompt để so. Bị loại vì to và có thể chứa note/lời dặn có dữ liệu nhạy cảm (FR-018).

## R3. Đọc có điều kiện (FR-005 → FR-010)

**Hiện trạng**:

- `docs` có `version INTEGER`, không có cột hash (`packages/core/src/sqlite.ts:201-206`). Skill cũng là dòng trong `docs` (`skills.ts:32`).
- Đã gỡ (38g): cột `removed_at/by/note/op` và `doc_redirects` (`sqlite.ts:630-640`).
- `doc_get` gọi `docs.get` hai lần: lần đầu để kiểm `removedAt`, lần sau để trả (`server.ts:268-283`). `skill_get` không kiểm `removedAt` (`server.ts:386-405`).
- Hub biết run nào gọi khi agent dùng token run `hiverun_…`: `tokenActor` gán `actor.run` và `actor.runCredential` (`apps/web/src/app.ts:352-420`, `tokens.ts:108`).
- `/mcp` dựng server mới cho mỗi request (`app.ts:1472`, `sessionIdGenerator: undefined`), nên không giữ được trạng thái trong bộ nhớ của server MCP.
- Không có logic ETag/`ifVersion` nào. Tiền lệ gần nhất là `baseVersion` của `proposals.create` (`server.ts:364`).

**Decision**:

- `docs.get` nhận thêm `have?: number` (phiên bản agent đang có) và `full?: boolean`. Hub **luôn** kiểm quyền (`#check` / `sees()`) và `removed_at` trước, rồi mới so phiên bản. Nếu `have === version` và không `full` thì trả `{key, version, unchanged: true}`.
- **Biên nhận đọc** lưu ở bảng SQLite `run_reads` của `SqliteHive` (core) theo `actor.runCredential.run`, không lưu trong bộ nhớ. Lý do: server MCP không có phiên, hub có thể khởi động lại, và nhiều request song song. `run_credentials` nằm ở DB token riêng của `apps/web/src/tokens.ts`, nên không nối khoá ngoại được. Thay vào đó, dòng `run_reads` cũ hơn 48 giờ bị xoá trong `cleanupRound` (`apps/web/src/server.ts:116`, chạy mỗi 60 giây).
- Không có `have` nhưng có biên nhận cùng `(run, key, version)` thì cũng trả `unchanged` (FR-006). Câu trả lời ghi rõ cách lấy bản đầy đủ: `full:true`.
- `memory_search`: hash = sha256 của danh sách `(id, updatedAt, review, stale, supersededBy, conflictsWith)` theo thứ tự trả. Biên nhận lưu theo `(run, sha256(query+project+limit))`. Hash trùng thì trả `{same: true, ids}`. Lưu ý `memory.search` **ghi khi đọc** (`use_count`, `sqlite.ts:8200`): lần trả "giống" vẫn phải tăng `use_count` như cũ để không đổi hành vi xếp hạng.
- Gộp hai lần gọi `docs.get` trong `doc_get` thành một (hub trả `removedAt` trong cùng câu trả lời).
- Ngoài run (token `hivemcp_…` của leader/chat, không có `run`): chỉ dùng `have` tường minh, không có biên nhận.

**Rationale**: Phiên bản đã tăng đơn điệu theo mỗi lần sửa, nên không cần hash nội dung. Kiểm quyền trước khi so đáp ứng FR-008 và SC-005.

**Alternatives considered**:

- HTTP ETag / `If-None-Match` ở `/api/rpc`. Bị loại: agent gọi qua MCP, không thấy header HTTP.
- Cache trong bộ nhớ (Map/LRU) theo run. Bị loại vì không sống qua lần khởi động lại hay deploy tự động (edge case "hub khởi động lại"), và vì `/mcp` không có phiên.

## R4. Mục lục và tóm tắt tài liệu (FR-011 → FR-014)

**Hiện trạng**: `doc_get` chưa có `section`/`maxChars` (80c chưa làm).

**Decision**:

- Phụ thuộc 80c: đọc theo mục (`section`) và cờ báo đã cắt.
- Bảng `doc_digests(key, version, toc_json, summary, chars, created_at)`, PK `(key, version)`. Mục lục dựng **tất định** từ tiêu đề Markdown (`#`…`###`), mỗi mục có `{id, title, level, chars}`. Làm lười ở lần đọc đầu của mỗi phiên bản rồi giữ lại. Khi tài liệu lên phiên bản mới thì dòng cũ không còn được đọc (khoá theo `version`), và job dọn xoá dòng cũ.
- Ngưỡng: `chars/4 > 4000` (cùng cách ước của 80).
- Tóm tắt (FR-012): đề xuất tạm theo hướng **(b)+(c)**. Tóm tắt là đoạn mở đầu do tác giả viết (phần trước tiêu đề `##` đầu tiên, cắt ở ~800 ký tự). Không có đoạn đó thì chỉ có mục lục. **Không dùng model.** Chờ người quản trị chốt (xem "Câu hỏi còn mở").

**Rationale**: Tất định nghĩa là không bao giờ trả tóm tắt sai phiên bản, không tốn token để làm, và test được. Tóm tắt bằng model tốn token một lần mỗi phiên bản, có thể sai, và cần chọn máy/gói để chạy.

**Alternatives considered**: (a) model tự tóm tắt mỗi phiên bản. Để dành cho sau nếu (b) không đủ.

## R5. Bản sao tài liệu/skill trên máy (FR-015 → FR-018)

**Hiện trạng**: `loadDocs` (`sync.ts:70-73`) gọi `docs.list` rồi `docs.get` **từng tài liệu** trước mỗi run (timeout 30 giây). `renderContext` bỏ qua file đã giống. Không có bản sao nào trong appData.

**Decision** (đề xuất tạm theo hướng (b), chờ chốt FR-016):

- Method hub mới `docs.manifest({project}) → [{key, version, removed}]`, áp quyền như `docs.list`.
- Máy giữ `<appData>/doc-cache/<hubId>/<accountId>/<project>/<sha256(key)>.json` = `{key, version, content}`. Run mới: gọi `docs.manifest`, chỉ `docs.get` những key có phiên bản khác bản sao.
- Xoá thư mục `<hubId>/<accountId>` khi đăng xuất. Xoá thư mục dự án khi hub gỡ dự án khỏi máy (`machine-projects.ts`), hoặc khi `docs.manifest` trả lỗi quyền.
- FR-018: tài liệu trên hub đã qua kiểm secret khi ghi. Bản sao chỉ chứa đúng nội dung `docs.get` trả. Không ghi token/credential vào thư mục cache. [Chưa kiểm] quyền file trên Windows; đặt quyền 0700 trên macOS/Linux.

**Rationale**: Bớt N lần `docs.get` mỗi run (88 doc theo số của 80). Lợi về token là gián tiếp: không có token model nào được tiết kiệm trực tiếp, chỉ bớt lưu lượng và thời gian khởi động run. Vì vậy US5 là P3.

**Alternatives considered**: (a) chỉ trong worktree. Hiện trạng gần như thế này rồi: không lợi gì thêm.

## R6. Đo và báo cáo (FR-019 → FR-022)

**Hiện trạng**:

- `RunUsage` (`runner/usage.ts:8-19`) có `cacheWriteTokens` và `cacheReadTokens`. Claude có đủ hai số. Codex có `cacheWriteTokens = 0` (`usage.ts:55-79`). Gemini có cache write là `null` (`gemini.ts:70`). Kilo/OpenCode lấy theo step.
- Báo cáo lên hub ở `runner.ts:1467-1482`, vào bảng `run_costs` (`sqlite.ts:268`, cột cache ở `:456-457`). `costs.summary` ở `sqlite.ts:10224`. Giao diện chi phí là `OpsCosts` (`packages/ui/src/pages/admin/Ops.tsx:526`).

**Decision**:

- Thêm cột vào `run_costs`: `prefix_fp TEXT`, `prefix_parts TEXT` (JSON), `unchanged_hits INTEGER`, `avoided_tokens_est INTEGER`.
- `unchanged_hits` và `avoided_tokens_est` do **hub** đếm từ `run_reads`, vì hub là nơi trả "không đổi". Máy không cần báo.
- `costs.summary` trả thêm `cache: {writePerRun, readRatio, unchangedHits, avoidedTokensEst, unknownRuns}` theo dự án và gói, cho 24h / 7d / 30d.
- Codex: báo `cacheWriteTokens = 0` không có nghĩa là "không ghi". Hiện là "chưa rõ" (FR-022). Cờ `cacheWriteKnown` theo loại agent.
- Cảnh báo (FR-021): thêm một luật vào `alerts.check()` (`apps/web/src/alerts.ts`, chạy mỗi 60 giây ở `apps/web/src/server.ts:193`), kiểu `AlertRule` mới `cache_write_spike`. Nếu `writePerRun(24h) > 2 × writePerRun(7 ngày trước đó)` và có ít nhất 5 run, thì cảnh báo kèm các `prefixParts` khác nhau giữa run gần nhất và run thường gặp nhất của 7 ngày trước.
- Tách "hết hạn" khỏi "vỡ" (edge case): cùng `prefix_fp` với run trước nhưng `cache_write` lớn thì tính là hết hạn, không tính là vỡ.

**Alternatives considered**: bảng `run_cache_metrics` riêng. Bị loại vì `run_costs` đã là nơi gộp theo run, và `RUN_TOKEN_COLUMNS` (`sqlite.ts:1082`) đã nối nó vào run.

## R7. Prompt cache của từng nhà cung cấp [Unverified, cả mục]

Những điều dưới đây là người viết nhớ, chưa đọc lại tài liệu gốc trong run này. T0 phải kiểm trước khi chốt SC-001 cho từng loại agent.

| Loại | Cache tự động? | Thời gian sống | Số token báo về Hive |
|---|---|---|---|
| Claude (Claude Code) | Có, CLI tự đặt breakpoint | 5 phút mặc định. Có tuỳ chọn 1 giờ (phiên này tự báo 1 giờ) | ghi + đọc (`usage.ts:25-48`) |
| Codex | Có, theo tiền tố, từ một độ dài tối thiểu | vài phút tới ~1 giờ khi rảnh | chỉ đọc (`cached`), ghi = 0 |
| Gemini CLI | Implicit cache trên model 2.5+ | không công bố cố định | chỉ đọc, ghi = null |

**Decision**: SC-001 (giảm ghi cache ≥50%) chỉ đo được với Claude và Kilo/OpenCode (có số ghi). Codex và Gemini đo theo SC-002 (tỉ lệ đọc).

## R8. Phạm vi so với 80c / 80e / 80g (FR-023)

**Decision** (đề xuất tạm, chờ chốt): **(a)**. 81 chỉ làm phần mới.

- 80c (đọc theo mục) và 80e (bỏ giao thức lặp) là **điều kiện trước** của US3 và US1, và làm trước.
- 80g vẫn là task riêng.
- Plan ghi phụ thuộc thay vì gộp.

**Rationale**: 80c/80e là task nhỏ đã có tên và tiêu chí trên roadmap (`docs/roadmap.md:427-431`). Gộp vào thì 81 to ra mà không thêm gì.

---

## Câu hỏi còn mở (cần người quản trị chốt qua `/speckit-clarify`)

Ba dấu [NEEDS CLARIFICATION] trong spec **chưa được trả lời**. Plan chọn tạm một hướng cho mỗi câu để thiết kế được. Đổi hướng thì sửa các phần ghi bên dưới:

| Câu | Hướng tạm | Đổi thì ảnh hưởng |
|---|---|---|
| FR-012 tóm tắt | (b)+(c): đoạn mở đầu của tác giả + mục lục tự động, không model | `doc_digests.summary`, R4, hợp đồng `doc_get` |
| FR-016 bản sao máy | (b): appData theo tài khoản, xoá khi đăng xuất/mất quyền | R5, T-client, data-model "Machine copy" |
| FR-023 phạm vi | (a): 80c, 80e làm trước như task riêng; 80g ngoài phạm vi | Thứ tự task, mục Phụ thuộc trong plan |
