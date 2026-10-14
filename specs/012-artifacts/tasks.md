# Tasks: Artifacts

**Input**: [spec.md](spec.md), [plan.md](plan.md), [ADR 0023](../../docs/adr/0023-artifacts.md)

**Tests**: bắt buộc (feature-checklist mục 5). Mỗi task tự viết test của phần mình và để `pnpm check` xanh.

## Cách đọc

- Dạng: `- [ ] T### [P?] [US?] Mô tả` rồi các dòng **Scope** (file được sửa/tạo, chỉ task đó đụng), **Phụ thuộc**,
  **Mức** (`nặng` → Opus 5.5 `--effort high`; `vừa` → Sonnet 5.5 `--effort high`; `nhẹ` → Sonnet 5.5 `--effort medium`,
  theo CLAUDE.md).
- `[P]`: chạy song song được với các task `[P]` khác **khi phụ thuộc đã xong** (khác file, không chờ nhau).
- Hai task cùng một **làn** (bảng cuối) sửa chung file nên phải làm nối tiếp trong cùng worktree hoặc sau khi task trước
  đã merge.
- `packages/contracts/openapi.json` và `packages/contracts/src/index.ts` chỉ T001 sửa. Task khác cần đổi contract thì báo
  người điều phối thêm vào T001 hoặc mở task contract mới, không tự sửa.
- Migration chỉ T003 sinh (số kế tiếp lúc làm, hiện dự kiến `0060`). Task sau cần đổi bảng (T062) sinh số kế tiếp.
- **MVP** (🎯): loại `markdown`, `code`, `html`, `mermaid`, `react`; khung bên cạnh trong Leader chat web + app (màn Leader
  tối thiểu trong app); tool MCP cho agent; phiên bản (lịch sử, so sánh, khôi phục); phạm vi `private` và `project`; thư
  viện tối thiểu; app đọc offline; quét bí mật (chặn); giới hạn mặc định; link công khai; "Nhờ Leader sửa". Chi tiết ở
  "Implementation Strategy".
- PO đã chốt mọi câu hỏi ngày 2026-10-14 (spec.md "Clarifications"). Task đã theo quyết định đó: khung cùng host, chặn mạng,
  không CDN, quét bí mật chỉ chặn, `react` + link công khai + "Nhờ Leader sửa" trong MVP.
- Phụ thuộc ngoài: **LEADTERM** (Terminal Leader trên web, đang làm) cho T064; **Tiptap #204** (editor Tiptap trong
  `@xdev-hive/doc-editor`) cho T068; spec 011 (`sdlc` có màn hạng mục) cho phần hạng mục của T065.

---

## Phase 1: Nền (chặn mọi story)

- [x] T001 🎯 Contract artifacts
  - `artifacts.ts` mới: schema, input, route `artifactsContract` đủ như plan.md "Contracts" (kể cả `publicLinks.*`,
    `askLeaderFix`, và route sau MVP `toDoc`, `toRepo`, `usage` để `openapi.json` ổn định), input bốn tool MCP (kể cả
    `duplicateOf`), lỗi `ARTIFACT_*` (kể cả `ARTIFACT_LINK_OWNER_ONLY`, `ARTIFACT_LINK_LIMIT`,
    `ARTIFACT_PUBLIC_LINKS_DISABLED`, `ARTIFACT_LINK_EXPIRY_INVALID`, `ARTIFACT_IMPORT_NOT_ALLOWED`).
  - `policies.ts`: `orgArtifactPolicy` (mọi trường `.default()`, có `publicLinks { enabled, maxDays }`, **không**
    `cdnAllow`, không chế độ quét), thêm vào `agentPolicyInput`.
  - `leader.ts`: `chatMessage.artifact`, `chatMessage.pageErrors` (nullable, default null).
  - Loại thông báo `artifact.quota`, `artifact.public_link.revoked` (`notify.ts`).
  - Khung rỗng cho T002: `secret-scan.ts` (kiểu `SecretFinding`, chữ ký `scanSecrets`, thân `throw`).
  - `index.ts` export; `pnpm openapi`; test parse (policy cũ không có `artifacts` vẫn parse; `maxDays` ngoài 1…30 bị từ
    chối; `askLeaderFix` > 20 lỗi hoặc lỗi > 2 000 ký tự bị từ chối).
  - **Scope**: `packages/contracts/src/{artifacts.ts,artifacts.test.ts,secret-scan.ts,policies.ts,leader.ts,notify.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: không · **Mức**: vừa

- [x] T002 🎯 [P] Bộ quét bí mật dùng chung
  - Thân `scanSecrets` theo plan.md D12; trả `{ line, kind }`, không trả chuỗi. Không có hàm che (PO chốt chặn).
  - Fixture `fixtures/secret-scan.json` ≥ 15 mẫu dương (mỗi loại) + mẫu âm (SHA git, UUID, base64 ảnh nhỏ, `password:` rỗng).
  - Test Go đọc cùng fixture, ghi nhận mẫu worker chưa bắt (`t.Skip` kèm tên mẫu, không sửa `checks.go`).
  - **Scope**: `packages/contracts/src/{secret-scan.ts,secret-scan.test.ts}`, `packages/contracts/fixtures/secret-scan.json`,
    `worker/internal/runner/secret_fixture_test.go`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T003 🎯 Bảng và migration
  - `artifacts/schema.ts` mới (`artifacts` có `duplicated_from_*`, `artifact_versions`, `artifact_links`,
    `artifact_previews`, `artifact_public_links`, enum; `orgScoped`); `leader/schema.ts` (`chat_messages.artifact_id`,
    `artifact_version`, `page_errors`).
  - `pnpm --filter @xdev-hive/hub db:generate`; thêm tay: `FORCE ROW LEVEL SECURITY`, FK `on delete set null
    (artifact_id)`, thu hồi `UPDATE/DELETE` của `hive_app` trên `artifact_versions`, hàm `hive.artifact_tombstone`,
    `hive.artifact_version_rename`, `hive.artifact_public_link_resolve(token_sha256)` (SECURITY DEFINER, chỉ trả `org_id`,
    `link_id` của link còn hiệu lực), hàm purge của `hive_owner`.
  - `artifacts/rls.db.test.ts` (0 dòng khác tổ chức; `hive_app` không `UPDATE` được phiên bản; hàm resolve không trả link
    hết hạn/thu hồi và không trả cột nào khác); ca nâng cấp trong `migrations-upgrade.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{schema.ts,rls.db.test.ts}`, `apps/hub/src/modules/leader/schema.ts`,
    `apps/hub/db/migrations/00NN_artifacts.sql`, `apps/hub/db/migrations/meta/*`, `apps/hub/src/migrations-upgrade.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T004 🎯 [P] Package `@xdev-hive/artifacts-runtime`
  - `scripts/build-lib.ts`: dựng `dist/lib/<tên>@<ver>/…` (ESM) cho `react`, `react/jsx-runtime`, `react-dom`,
    `react-dom/client`, `recharts` (gộp phụ thuộc của nó vào một file, để `react` là import ngoài), `lucide-react`,
    `@tailwindcss/browser`, `mermaid`, `markdown-it`; và `lib-manifest.json` (tên → đường dẫn, SRI sha384); script chạy
    trong `pnpm build` của package và trước test của hub. Ghi cỡ từng thư viện vào ghi chú bàn giao.
  - `csp.ts` `buildCsp({ libBase })` (US3-3; chỉ host hub, luôn `connect-src 'none'`, không tham số CDN);
    `frame-document.ts` `buildFrameDocument({ type, content, compiled?, compileError?, theme, manifest, libBase })` cho
    `html`, `mermaid`, `svg`, `react` (import map + Tailwind + module nội tuyến + mount, `compileError` → trang lỗi),
    `markdown` và `code` (cho trang công khai); (`pdf`, `csv-chart` để T061–T062 thêm nhánh); `bootstrap.ts`
    (ready/resize/error/console, bản thay `localStorage`/`sessionStorage` trong bộ nhớ); `messages.ts` (schema zod tin
    `postMessage`, kể cả `console`); `public-page.ts` `buildPublicPage({ title, type, version, expiresAt, frameUrl })` và
    `PUBLIC_PAGE_CSP` (FR-143, không script, tiêu đề escape).
  - Test: snapshot tài liệu khung từng loại; HTML không có `<head>`; nội dung chứa `</script>` trong mermaid/react không
    thoát khỏi khối; CSP không có nguồn ngoài host hub; trang công khai không có `<script>`, tiêu đề `<img onerror>` bị
    escape; bootstrap gửi `console` khi gọi `console.error`.
  - **Scope**: `packages/artifacts-runtime/**` (package mới), `pnpm-lock.yaml`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [x] T005 🎯 [P] Thiết kế màn MVP bằng skill `ui-ux-pro-max`, design system v2, shadcn/ui; mỗi màn có trạng thái rỗng /
  đang tải / lỗi / offline, 360 px, sáng/tối, chữ vi/en (xem "Màn cần thiết kế", các dòng MVP).
  - **Scope**: `docs/design-system/screens/{ArtifactPanel,ArtifactLibrary,ArtifactDetail,ArtifactVersions,ArtifactShare,ArtifactPublicLink,PublicArtifactPage,ArtifactFixRequest,AdminPublicLinks,AppLeader,AppArtifacts}.dc.html`
    (mới), `docs/design-system/screens/{Leader,AppNav}.dc.html` (biến thể), `docs/design-system/screens/README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

- [x] T006 [P] Thiết kế màn sau MVP: soạn tay, Terminal Leader, chính sách, dung lượng, mục Artifact ở task/run/dự án/hạng
  mục, chuyển thành tài liệu, lưu vào repo.
  - **Scope**: `docs/design-system/screens/{ArtifactEditor,ArtifactUsage}.dc.html` (mới),
    `docs/design-system/screens/{Policies,Plan,Projects,AppSdlcItem,DocEditor}.dc.html` (biến thể),
    `docs/design-system/screens/TerminalLeader.dc.html` (biến thể nếu LEADTERM đã tạo, không thì mới); ghi chú bàn giao
    cho T005 để gộp `README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

**Checkpoint**: contract, bộ quét, bảng, runtime khung, thiết kế MVP sẵn sàng.

---

## Phase 2: Lõi hub (US1, US2, US4, US5) 🎯

- [x] T010 🎯 Module `artifacts`: dịch vụ, quyền, giới hạn, router
  - `access.ts` (`readerFor`, `visibleArtifactsWhere`, `assertCan(action)` theo bảng quyền plan.md), `service.ts` (tạo,
    phiên bản mới với khoá lạc quan, đổi tên, phạm vi, chủ, nhân bản, xoá mềm, khôi phục, tombstone, liệt kê/tìm với con
    trỏ), `limits.ts` (trần env + chính sách tổ chức, khoá tư vấn theo tổ chức, giới hạn run), quét bí mật (chỉ chặn,
    audit `artifact.secret.blocked`), cập nhật `search`, audit (plan.md "Audit"), `purge.ts` (job pg-boss: thùng rác 30
    ngày, bản xem trước, liên kết mồ côi, link công khai hết hạn > 90 ngày), `hooks.ts` (`provideThreadHost` có
    `assertRunThread`, `postArtifactCard`, `postFixRequest`; `provideTerminalHost`, `provideLinkTarget`), điểm gọi
    `compileReact` (giao diện, thân ở T014; trước T014 loại `react` bị `ARTIFACT_TYPE_DISABLED`), đặt `revoked_at` cho link
    công khai khi xoá/chuyển chủ/tombstone/chủ rời tổ chức (bảng có từ T003, phần còn lại của link ở T015), `router.ts` (mọi
    route của T001 trừ `frameUrl`, `preview`, `frameDocument` → T012; `publicLinks.*` → T015; `askLeaderFix` → T016;
    `toDoc`, `toRepo` → T066; `usage` trả số thật).
  - Test: `artifacts.db.test.ts` (phiên bản, xung đột, thiếu `baseVersion`, giới hạn 200, cỡ, dung lượng với hai lần lưu
    đồng thời, bí mật bị chặn và không vào audit, thùng rác, purge, tombstone, nhân bản ghi `duplicated_from_*`, xoá/chuyển
    chủ thu hồi link), `access.db.test.ts` (ma trận ba người × bốn phạm vi × route, SC-002; quản trị tổ chức không đọc
    `private`), `access.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{access.ts,service.ts,versions.ts,limits.ts,hooks.ts,purge.ts,router.ts,index.ts}`
    + test tương ứng
  - **Phụ thuộc**: T001, T002, T003 · **Mức**: nặng

- [x] T011 🎯 Tool MCP `artifact_*`
  - `artifacts/mcp-tools.ts`: bốn tool (plan.md "MCP"), quyền run theo FR-032, liên kết tự động `run`/`task`/
    `chat_thread`/`terminal_session`, từ chối `doccheck`/`docassist`/`brief` (`ARTIFACT_RUN_KIND`), lỗi xung đột kèm bản
    mới nhất, `duplicateOf` (đọc được bản gốc → `private` của người mở cuộc trò chuyện), `compileError` trong kết quả.
  - `mcp/registry.ts`: cờ `forLeader` trên `McpTool`; `list()` cho run `leader` trả thêm tool có `forLeader`; thêm bốn tool
    vào `RUN_TOOLS`. Kiểm cách MCP-03 ("read-only kinds get no write tools") đang thực thi và ghi lại trong ghi chú bàn giao
    nếu cần sửa chữ MCP-03 (T050 sửa srs).
  - Test: `mcp-artifacts.db.test.ts` (run `leader`/`code`/`plan`/`doccheck`, người dùng PAT; giới hạn run; tool tắt bởi
    MCP-04 không hiện), cập nhật `mcp/registry.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{mcp-tools.ts,mcp-artifacts.db.test.ts}`, `apps/hub/src/modules/mcp/{registry.ts,registry.test.ts}`
  - **Phụ thuộc**: T010 · **Mức**: vừa

- [x] T012 🎯 Route khung cách ly, vé, thư viện tĩnh
  - `ticket.ts` (HMAC, khoá HKDF từ khoá chủ, hạn ≤ 5 phút, phiên bản hoặc bản xem trước; trường `s` cho link công khai
    để T015 dùng), `frame-routes.ts` (`/_artifact/frame/:ticket`, `/_artifact/lib/*` từ `artifacts-runtime/dist/lib` với
    `Access-Control-Allow-Origin: *` và cache `immutable`; header ở FR-071; 410 khi xoá/tombstone; không đọc cookie hay
    `Authorization`, FR-073), route oRPC `frameUrl`, `preview` (quét bí mật, biên dịch `react` qua `compileReact`),
    `frameDocument`. Không có `HIVE_ARTIFACT_ORIGIN` (PO chốt cùng host).
  - Đăng ký route trong `app.ts` **trước** SPA (như `/mcp`); `Dockerfile` chép `artifacts-runtime/dist/lib` nếu image chưa
    có.
  - Test: `ticket.test.ts` (sửa payload, hết hạn, sai tổ chức), `frame-routes.db.test.ts` (header, CSP chỉ host hub, CORS
    của thư viện, có cookie phiên vẫn không dùng, bản xem trước có bí mật bị chặn).
  - **Scope**: `apps/hub/src/modules/artifacts/{ticket.ts,frame-routes.ts}` + test, `apps/hub/src/app.ts`,
    `apps/hub/.env.example`, `Dockerfile` (nếu cần)
  - **Phụ thuộc**: T004, T010 · **Mức**: nặng

- [x] T013 🎯 Leader: thẻ artifact trong chat
  - `leader` cung cấp `ThreadHost` (`assertRunThread` dùng lại kiểm của `leader_reply`; `postArtifactCard` thêm tin nhắn thẻ,
    cập nhật `updated_at`); router trả `chatMessage.artifact`; xoá cuộc trò chuyện xoá liên kết `chat_thread`.
  - `leader/prompt.ts`: đoạn hướng dẫn artifact (US5-7); `prompt.test.ts`.
  - Test `leader.db.test.ts`: run leader tạo artifact → thẻ đúng thứ tự, `artifact` trong `threads.get`; thread của run khác
    → `ARTIFACT_LINK_FORBIDDEN`; artifact bị xoá hẳn → thẻ còn, `artifact` null.
  - **Scope**: `apps/hub/src/modules/leader/{mcp-tools.ts,prompt.ts,prompt.test.ts,router.ts,index.ts}`,
    `apps/hub/src/leader.db.test.ts`
  - **Phụ thuộc**: T011 · **Mức**: vừa

- [x] T014 🎯 Biên dịch `react` trên hub
  - `compile.ts` `compileReact(source, manifest) → { compiled } | { compileError } | ImportNotAllowed` theo plan.md D8
    (`sucrase` JSX + TS, `es-module-lexer`, chỉ tên trong manifest, `import()` động bị từ chối, giới hạn 2 s); nối vào
    điểm gọi của T010 (lưu phiên bản) và T012 (`preview`); bật `react` trong `MVP_TYPES` mặc định nếu T001 chưa bật.
  - Test `compile.test.ts` (JSX, TSX, `export default` thiếu, import lạ, `import()`, `</script>` trong chuỗi, 1 MiB đo
    thời gian cho SC-013), ca `react` trong `artifacts.db.test.ts` (lỗi cú pháp lưu `compile_error`; import lạ không lưu).
  - **Scope**: `apps/hub/src/modules/artifacts/{compile.ts,compile.test.ts}`, `apps/hub/src/modules/artifacts/service.ts`
    (chỉ chỗ gọi), `apps/hub/package.json`, `pnpm-lock.yaml`
  - **Phụ thuộc**: T004 (manifest), T010, T012 · **Mức**: nặng

- [x] T015 🎯 Link công khai trên hub
  - `public-links.ts`: route `publicLinks.create/list/revoke/orgList` (FR-140, FR-141, FR-147; quét bí mật lại; chính
    sách `publicLinks`; trần `HIVE_ARTIFACT_LINK_MAX_DAYS`), `GET /_artifact/s/:token` (plan.md D21: băm → hàm resolve →
    `withTenant` → `buildPublicPage` + vé `s:`; 404 đồng nhất), kiểm link ở route khung khi vé có `s`, cập nhật
    `view_count`/`last_viewed_at`, audit gộp theo giờ (FR-146), thông báo `artifact.public_link.revoked` cho chủ.
  - `rate-limit.ts` (plan.md D22: IP 60/phút, link 600/phút, `HIVE_TRUSTED_PROXIES`, 429 + `Retry-After`).
  - Test `public-links.db.test.ts` (SC-012: chỉ chủ, mã chỉ lưu băm, mọi lý do hết hiệu lực → cùng 404, tắt/bật chính
    sách, ≤ 10 link, bí mật, audit không có mã), `rate-limit.test.ts`, ca trang công khai trong `frame-routes.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{public-links.ts,rate-limit.ts}` + test, `apps/hub/src/modules/artifacts/frame-routes.ts`
    (nhánh vé `s:`, route `/s/`), `apps/hub/src/modules/artifacts/router.ts` (gắn route `publicLinks.*`), `apps/hub/.env.example`
  - **Phụ thuộc**: T010, T012 · **Mức**: nặng

- [x] T016 🎯 "Nhờ Leader sửa" trên hub
  - `artifacts/fix-request.ts`: route `askLeaderFix` (FR-151); `leader` cung cấp `ThreadHost.postFixRequest` (kiểm/tạo
    cuộc trò chuyện của người gọi, tin nhắn người dùng có `artifact_*` và `page_errors`, khởi động run `leader` như
    `threads.send`); router leader trả `pageErrors`; `leader/prompt.ts` dựng khối `<page-errors>` (FR-152) và quyền
    `canWrite` của người gửi.
  - Test: ca trong `leader.db.test.ts` (thread của người khác → `ARTIFACT_LINK_FORBIDDEN`; không `threadId` → thread mới đúng
    dự án; liên kết `chat_thread`; audit `artifact.fix.request` không chứa chữ lỗi), `prompt.test.ts` (lỗi có `</page-errors>`
    hay câu dạng chỉ dẫn vẫn nằm trong khối, bị escape và cắt).
  - **Scope**: `apps/hub/src/modules/artifacts/{fix-request.ts,router.ts}` + test, `apps/hub/src/modules/leader/{mcp-tools.ts,prompt.ts,prompt.test.ts,router.ts,index.ts}`,
    `apps/hub/src/leader.db.test.ts`
  - **Phụ thuộc**: T013, T015 (cùng làn `router.ts`) · **Mức**: vừa

**Checkpoint**: agent tạo/sửa/đọc artifact qua MCP; thẻ trong chat; khung phục vụ được, `react` biên dịch được, link
công khai và "Nhờ Leader sửa" chạy qua API (chưa có UI).

---

## Phase 3: Package giao diện dùng chung (US1–US4, US7) 🎯

- [x] T020 🎯 `@xdev-hive/artifacts-ui` — khung, thẻ, trình xem, khung cách ly
  - `env.tsx` (`ArtifactsEnv`), `text.ts` (vi/en), `card.tsx`, `panel.tsx` (tab, thanh công cụ, tự mở artifact mới trừ khi
    đang sửa, trạng thái: tải, lỗi, bản mới hơn, offline, đã xoá), `sandbox-frame.tsx` (plan.md D16, nút Dừng trang, nhãn
    "Nội dung do agent tạo", gom ≤ 20 tin `error`/`console`), `viewer/{markdown,code,html,mermaid,react}.tsx` (markdown qua
    doc-editor chỉ đọc, không HTML thô, ảnh ngoài chờ bấm; code bằng `shiki` tải ngôn ngữ lười, render token thành `span`;
    react hiện `compileError` hoặc khung), nút "Nhờ Leader sửa" trên panel (gọi `env.onAskLeaderFix`, chỉ khi
    `env.canAskLeader`) và mục "Link công khai" trong thanh công cụ (gọi `env.onPublicLinks`); `index.ts` export sẵn tên của
    T021–T023.
  - Test component (Vitest + Testing Library): `SandboxFrame` bỏ tin từ nguồn khác và tin sai schema, giữ ≤ 20 lỗi;
    markdown không render `<script>`/`<img onerror>`; panel tự mở/không tự mở; nút "Nhờ Leader sửa" chỉ hiện khi có lỗi.
  - **Scope**: `packages/artifacts-ui/**` (package mới: `package.json`, `src/{index.ts,env.tsx,text.ts,card.tsx,panel.tsx,sandbox-frame.tsx,viewer/*}` + test),
    `pnpm-lock.yaml`
  - **Phụ thuộc**: T001, T004, T005 · **Mức**: nặng

- [x] T021 🎯 `@xdev-hive/artifacts-ui` — phiên bản, so sánh, chia sẻ, sửa tay tối thiểu
  - `versions.tsx` (danh sách, đặt tên, khôi phục), `compare.tsx` (diff dòng bằng `line-diff`, cạnh nhau), `share-dialog.tsx`
    (phạm vi `private`/`project`, cảnh báo phiên bản cũ), `editor.tsx` tối thiểu (ô soạn chữ cho `markdown`/`code`/`html`/
    `mermaid`, xem trước qua `preview`, xung đột "Xem khác biệt rồi gộp", dòng bí mật được đánh dấu).
  - **Scope**: `packages/artifacts-ui/src/{versions.tsx,compare.tsx,share-dialog.tsx,editor.tsx}` + test
  - **Phụ thuộc**: T020 · **Mức**: vừa

- [x] T022 🎯 [P] `@xdev-hive/artifacts-ui` — thư viện và chi tiết
  - `library.tsx` (lọc phạm vi/loại/nguồn/dự án, tìm, con trỏ, thùng rác, dạng thẻ ở 360 px), `detail.tsx` (vùng xem + tab
    Phiên bản, Liên kết, Hoạt động).
  - **Scope**: `packages/artifacts-ui/src/{library.tsx,detail.tsx}` + test
  - **Phụ thuộc**: T020 (song song với T021: khác file; `index.ts` của package do T020 export sẵn tên, T021/T022 chỉ điền
    file) · **Mức**: vừa

- [x] T023 🎯 [P] `@xdev-hive/artifacts-ui` — link công khai và "Nhờ Leader sửa"
  - `public-link-dialog.tsx` (chỉ chủ: chọn phiên bản, hạn 1…`maxDays`, cảnh báo "Người ngoài tổ chức sẽ xem được bản
    này." / lỗi biên dịch, hiện link một lần + Sao chép, danh sách link: phiên bản, hạn, lượt xem, Thu hồi),
    `fix-request-dialog.tsx` (danh sách lỗi sửa/xoá được, lời nhắn, chọn đích "Cuộc trò chuyện này"/"Cuộc trò chuyện mới",
    gửi `askLeaderFix`), `public-links-table.tsx` (bảng cho màn quản trị, dùng ở T031 và app nếu cần).
  - Test component: link chỉ hiện một lần, đóng hộp thì mất; người không phải chủ không thấy nút tạo; hộp lỗi cắt 20 mục.
  - **Scope**: `packages/artifacts-ui/src/{public-link-dialog.tsx,fix-request-dialog.tsx,public-links-table.tsx}` + test
  - **Phụ thuộc**: T020 · **Mức**: vừa

---

## Phase 4: Web (US1–US4, US7) 🎯

- [x] T030 🎯 Web: khung bên cạnh trong Leader, thư viện, chi tiết
  - `leader-page.tsx`: thẻ thay chữ khi `message.artifact`, lưới chat | vạch chia | khung (≥ 1024 px), `Sheet` (< 1024 px),
    nhớ độ rộng; trang `pages/artifacts/{library-page,detail-page}.tsx`; `router.tsx` (`/artifacts`, `/artifacts/:id`,
    `/artifacts/:id/v/:n`); `nav.ts` (mục Artifact); `ArtifactsEnv` của web (`onAskLeaderFix` mở `fix-request-dialog`,
    sau khi gửi thì chuyển tới cuộc trò chuyện; `onPublicLinks` mở `public-link-dialog`).
  - `e2e/fake-hub.ts`: route artifacts + `/_artifact/frame|lib` (dùng `buildFrameDocument`, `buildCsp` thật) + ghi request.
  - Playwright: `artifacts.spec.ts` (kịch bản MVP SC-008, 360 px, tối), `artifact-sandbox.spec.ts` (bộ ca thoát SC-001),
    đo SC-003.
  - **Scope**: `apps/web/src/pages/leader-page.tsx`, `apps/web/src/pages/artifacts/**`, `apps/web/src/router.tsx`,
    `apps/web/src/lib/nav.ts`, `apps/web/e2e/{fake-hub.ts,artifacts.spec.ts,artifact-sandbox.spec.ts}`, `apps/web/package.json`
  - **Phụ thuộc**: T012, T013, T021, T022, T023 · **Mức**: nặng

- [ ] T031 🎯 Web: màn quản trị Link công khai, e2e link công khai và "Nhờ Leader sửa"
  - `pages/admin/public-links-page.tsx` (bật/tắt `publicLinks`, `maxDays`, bảng link của tổ chức từ `public-links-table`,
    Thu hồi); `router.tsx`, `nav.ts` (mục trong Quản trị).
  - `e2e/fake-hub.ts`: route `publicLinks.*`, `askLeaderFix`, `/_artifact/s/*` (dùng `buildPublicPage` thật).
  - Playwright: `artifact-public-link.spec.ts` (ngữ cảnh không cookie: trang, khung `react`, ca thoát SC-001, thu hồi → 404,
    429), `artifact-fix.spec.ts` (trang lỗi → hộp → tin nhắn trong cuộc trò chuyện), phần còn lại của SC-008.
  - **Scope**: `apps/web/src/pages/admin/public-links-page.tsx`, `apps/web/src/router.tsx`, `apps/web/src/lib/nav.ts`,
    `apps/web/e2e/{fake-hub.ts,artifact-public-link.spec.ts,artifact-fix.spec.ts}`
  - **Phụ thuộc**: T015, T016, T023, T030 (cùng làn web) · **Mức**: vừa

---

## Phase 5: App desktop (US6) 🎯

- [ ] T040 🎯 Desktop Rust: bộ đệm, giao thức `hive-artifact://`, CSP
  - `artifacts.rs`: lệnh IPC `artifact_cache_put/get/list/clear` (LRU 200 MiB theo hồ sơ + tổ chức), giao thức
    `hive-artifact` (`frame/<id>/<version>` từ bộ đệm kể cả bản biên dịch `react`, `lib/*` từ resource kèm
    `Access-Control-Allow-Origin: *`, CSP như hub); xoá bộ đệm khi đăng xuất/đổi tổ
    chức (gọi từ luồng đăng xuất sẵn có); `tauri.conf.json` (`frame-src`, resource `artifacts-runtime/dist/lib`).
  - `cargo test`: LRU, xoá theo hồ sơ, 404 khi thiếu, header CSP.
  - **Scope**: `apps/desktop/src-tauri/src/{artifacts.rs,lib.rs}`, `apps/desktop/src-tauri/tauri.conf.json`,
    `apps/desktop/src-tauri/Cargo.toml` (nếu cần), `apps/desktop/src/lib/artifact-cache.ts` + test
  - **Phụ thuộc**: T004, T012 · **Mức**: nặng

- [ ] T041 🎯 Desktop: màn Leader tối thiểu và màn Artifact
  - `screens/leader-screen.tsx` (C13, plan.md D18: cuộc trò chuyện, tin nhắn, gửi, thẻ đề xuất duyệt/từ chối, thẻ artifact,
    khung bên cạnh, "Nhờ Leader sửa"), `screens/artifacts-screen.tsx` (thư viện + chi tiết từ package, tạo/thu hồi link
    công khai; mở link bằng trình duyệt hệ thống), `ArtifactsEnv` của app (offline từ bộ đệm; offline thì tắt "Nhờ Leader
    sửa" và link công khai), `nav.ts`, `screens/index.ts`, từ điển; ẩn menu khi hub không có `artifacts` (hỏi khả năng hub).
  - Test desktop: thẻ, khung, `react` offline (hub giả tắt sau khi tải, SC-009), "Nhờ Leader sửa", tạo link, 360 px.
  - **Scope**: `apps/desktop/src/screens/{leader-screen.tsx,leader-screen.test.tsx,artifacts-screen.tsx,artifacts-screen.test.tsx,index.ts}`,
    `apps/desktop/src/lib/{nav.ts,i18n.ts}`, `apps/desktop/package.json`
  - **Phụ thuộc**: T013, T016, T021, T022, T023, T040 · **Mức**: vừa

---

## Phase 6: Nối hub và tài liệu 🎯

- [ ] T050 🎯 Nối và tài liệu
  - `main.ts`: đăng ký module, tool, job purge, `provideThreadHost` của leader; khả năng hub `artifacts: true` trong
    `system` (cho app); rollout bước 1 (tool tắt mặc định tới khi bật trên máy chủ 34).
  - Tài liệu: `docs/architecture.md` (module `artifacts`, khung cách ly cùng host, trang link công khai), `docs/add.md`,
    `docs/srs.md` (trạng thái ART-*, chữ MCP-03 nếu T011 báo), `docs/self-hosting.md` (`HIVE_TRUSTED_PROXIES`,
    `HIVE_ARTIFACT_LINK_MAX_DAYS`, trần dung lượng, che mã link trong log Caddy), `docs/feature-checklist.md` nếu cần;
    ADR 0023 đã Accepted (PO chốt 2026-10-14), chỉ cập nhật nếu thiết kế đổi khi làm.
  - **Scope**: `apps/hub/src/main.ts`, `apps/hub/src/modules/system/**`, `docs/{architecture.md,add.md,srs.md,self-hosting.md}`,
    `docs/adr/{0023-artifacts.md,README.md}`, `deploy/caddy/**` (che log)
  - **Phụ thuộc**: T030, T031, T041 · **Mức**: nhẹ

**Checkpoint MVP**: SC-001…SC-005, SC-008…SC-011 đạt trên web và app.

---

## Phase 7: Sau MVP

- T060 (loại `react`) **đã chuyển vào MVP** theo quyết định PO 2026-10-14: thư viện và khung ở T004, biên dịch ở T014,
  trình xem ở T020. Giữ số để tham chiếu cũ không gãy.

- [ ] T061 [P] [US3] Loại `svg`, `json`, `csv` (bảng + biểu đồ trong khung)
  - **Scope**: `packages/artifacts-ui/src/viewer/{svg,json,csv}.tsx`, `packages/artifacts-runtime/src/frame-document.ts`
    (nhánh `csv-chart`)
  - **Phụ thuộc**: MVP (Recharts đã có trong bộ đóng gói từ T004) · **Mức**: vừa

- [ ] T062 [US3] Ảnh và PDF: `BlobStore`, tải lên, trình xem
  - `blob-store.ts` (giao diện + bản PostgreSQL `bytea` chia đoạn 512 KiB), bảng `artifact_blobs`, `artifact_blob_chunks`
    (migration số kế tiếp), route tải lên (multipart, kiểm magic bytes, ≤ `maxBlobBytes`), `/_artifact/blob/:ticket`, pdf.js
    trong bộ đóng gói, `viewer/{image,pdf}.tsx`; bộ đệm app cho blob.
  - **Scope**: `apps/hub/src/modules/artifacts/{blob-store.ts,schema.ts}`, migration mới, `frame-routes.ts`,
    `packages/artifacts-runtime/**`, `packages/artifacts-ui/src/viewer/{image,pdf}.tsx`, `apps/desktop/src-tauri/src/artifacts.rs`
  - **Phụ thuộc**: MVP · **Mức**: nặng

- [ ] T063 [US4] Phạm vi `team` và `org`
  - **Scope**: `apps/hub/src/modules/artifacts/access.ts` + test, `packages/artifacts-ui/src/share-dialog.tsx`
  - **Phụ thuộc**: MVP · **Mức**: vừa

- [ ] T064 [US8] Terminal Leader: khung bên cạnh
  - Module LEADTERM cung cấp `TerminalHost`; hướng dẫn/MCP của phiên có `terminalSessionId`; màn Terminal Leader đặt
    `ArtifactPanel`.
  - **Scope**: file của LEADTERM (theo nhánh LEADTERM khi đã merge), `apps/hub/src/main.ts` (đăng ký hook)
  - **Phụ thuộc**: LEADTERM, MVP · **Mức**: vừa

- [ ] T065 [US10] Liên kết task, run, hạng mục AI SDLC, tài liệu
  - `LinkTarget` của `tasks`, `runs`, `sdlc`, `knowledge`; mục Artifact ở trang task, run, dự án, hạng mục (`sdlc-ui`), tài
    liệu; prompt run có task liệt kê artifact liên kết (`runs/engine.ts` dựng prompt).
  - **Scope**: `apps/hub/src/modules/{tasks,runs,sdlc,knowledge}/index.ts` (đăng ký), `apps/hub/src/modules/runs/engine.ts`
    (prompt), `apps/web/src/pages/{tasks-page,run-page,project-settings-page}.tsx`, `packages/sdlc-ui/src/item-detail.tsx`
  - **Phụ thuộc**: MVP; spec 011 T051 (màn hạng mục) cho phần `sdlc` · **Mức**: vừa

- [ ] T066 [US11] Chuyển thành tài liệu, Lưu vào repo
  - Route `toDoc` (hook `createProposal` từ `knowledge`), `toRepo` (`GitProvider.commitFiles` + `openPR`, nhánh
    `hive/artifact/<id>-v<n>`, kiểm đường dẫn như spec 011 FR-003); nút trong panel/chi tiết.
  - **Scope**: `apps/hub/src/modules/artifacts/convert.ts` + test, `packages/artifacts-ui/src/convert-dialog.tsx`
  - **Phụ thuộc**: MVP · **Mức**: vừa

- [ ] T067 [US12] Chính sách và dung lượng trên web
  - Mục Artifacts trong trang Chính sách agent (loại, phạm vi, giới hạn; bật/tắt link công khai đã có ở T031 — trang chính
    sách dẫn tới đó); màn Dung lượng artifact (`usage`); thông báo `artifact.quota`.
  - **Scope**: `apps/web/src/pages/admin/policies-page.tsx`, `apps/web/src/pages/admin/artifact-usage-page.tsx`,
    `apps/hub/src/modules/artifacts/limits.ts` (thông báo; loại thông báo đã có từ T001)
  - **Phụ thuộc**: MVP · **Mức**: vừa

- [ ] T068 [US9] Soạn tay đầy đủ
  - Markdown bằng doc-editor Tiptap (ẩn R-n, đề xuất, gửi duyệt); ô soạn code có tô màu; nút "Artifact mới" ở thư viện và
    khung.
  - **Scope**: `packages/artifacts-ui/src/editor.tsx`, `packages/doc-editor/src/**` (chỉ cờ chế độ artifact, phối hợp làn
    doc-editor)
  - **Phụ thuộc**: Tiptap #204, MVP · **Mức**: vừa

- T069 ("Nhờ Leader sửa") **đã chuyển vào MVP** theo quyết định PO 2026-10-14: hub ở T016, giao diện ở T020/T023, web ở
  T030/T031, app ở T041.

---

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┐
      ├─ T003 ─┼─ T010 ─┬─ T011 ─ T013 ─────────────┐
      │        │        └─ T012 ─┬─ T014            │
      │        │                 └─ T015 ─ T016 (T013)┼─ T030 ─ T031 ─┐
      ├─ T004 ─┼─────────────────┘                  │                ├─ T050
      │        └─ T020 (T005) ─┬─ T021 ─────────────┤                │
      │                        ├─ T022 ─────────────┤                │
      │                        └─ T023 ─────────────┘                │
      │                     T040 (T004, T012) ─ T041 (T013, T016, T021, T022, T023) ┘
T005, T006 (không phụ thuộc)
Sau MVP: T061; T062; T063; T064 (LEADTERM); T065 (spec 011); T066; T067; T068 (#204)
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T005, T006 |
| 2 | T002, T003, T004 |
| 3 | T010, T020 |
| 4 | T011, T012, T021, T022, T023 |
| 5 | T013, T014, T040 |
| 6 | T015 (sau T014 vì cùng làn artifacts-core), T030 |
| 7 | T016, T041 (sau T016) |
| 8 | T031 |
| 9 | T050 |
| 10 (sau MVP) | T061, T062, T063, T066, T067 |
| 11 (sau MVP) | T064, T065, T068 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002 (file riêng, sau T001) | `packages/contracts/src/index.ts`, `notify.ts`, `openapi.json` (chỉ T001) |
| db | T003 → T062 (migration sau) | `migrations/**`, `artifacts/schema.ts`, `leader/schema.ts` |
| artifacts-core | T010 → T011 → T012 → T014 → T015 → T016 (phần `fix-request.ts`, `router.ts`) → T062 (phần hub) → T063 → T066 → T067 (phần hub) | `artifacts/index.ts`, `artifacts/service.ts`, `artifacts/access.ts`, `artifacts/router.ts`, `artifacts/frame-routes.ts` |
| mcp | T011 | `mcp/registry.ts` |
| leader | T013 → T016 (phần leader) | `leader/**` (trừ `schema.ts` của T003) |
| runtime | T004 → T061 (phần khung) → T062 (phần runtime) | `packages/artifacts-runtime/**` |
| ui-pkg | T020 → T021, T022, T023 (khác file) → T061 → T068 | `packages/artifacts-ui/src/index.ts` (T020), `panel.tsx` |
| web | T030 → T031 → T065 (phần web) → T067 | `apps/web/src/router.tsx`, `lib/nav.ts`, `pages/leader-page.tsx`, `e2e/fake-hub.ts` |
| desktop | T040 → T041 → T062 (phần Rust) | `apps/desktop/src/lib/nav.ts`, `screens/index.ts`, `src-tauri/src/lib.rs`, `artifacts.rs` |
| wiring-docs | T050 → T064 (phần `main.ts`) | `apps/hub/src/main.ts`, `app.ts` (T012 sửa `app.ts` trước T050), `docs/**` |
| design | T005, T006 | `docs/design-system/screens/README.md` (T005 sửa; T006 ghi chú bàn giao) |

`artifacts/index.ts` thuộc làn artifacts-core; task ngoài làn cần export thêm thì ghi vào ghi chú bàn giao để T050 gộp.

## Màn cần thiết kế (T005, T006)

| File | Màn | Story | MVP |
|---|---|---|---|
| `Leader.dc.html` (biến thể) | Leader chat web có thẻ artifact; chia đôi chat · khung ≥ 1024 px; ngăn kéo toàn màn 360 px; danh sách artifact của cuộc trò chuyện | US1 | 🎯 |
| `ArtifactPanel.dc.html` | Khung bên cạnh: tab, thanh công cụ, trình xem markdown/code/html/mermaid/react (kể cả lỗi biên dịch), khung cách ly có nhãn "Nội dung do agent tạo", trạng thái tải/lỗi/trang báo lỗi/bản mới hơn/offline/đã xoá, Dừng trang | US1, US3, US6 | 🎯 |
| `ArtifactVersions.dc.html` | Lịch sử phiên bản (tác giả người/run, nguồn, tên bản), So sánh: Khác biệt + Cạnh nhau, Khôi phục | US2 | 🎯 |
| `ArtifactShare.dc.html` | Hộp chia sẻ (cá nhân/dự án; sau MVP đội/tổ chức), cảnh báo phiên bản cũ, chuyển chủ, lối vào Link công khai | US4 | 🎯 |
| `ArtifactPublicLink.dc.html` | Hộp link công khai: chọn phiên bản, hạn, cảnh báo, link hiện một lần, danh sách link, Thu hồi | US13 | 🎯 |
| `PublicArtifactPage.dc.html` | Trang công khai (không script): tiêu đề, loại, phiên bản, hạn, nhãn cảnh báo, khung; trang 404 chung; 429 | US13 | 🎯 |
| `AdminPublicLinks.dc.html` | Quản trị: bật/tắt link công khai, hạn tối đa, bảng link của tổ chức, Thu hồi | US13 | 🎯 |
| `ArtifactFixRequest.dc.html` | Trạng thái "Trang báo lỗi" + nút "Nhờ Leader sửa"; hộp xem trước lỗi, lời nhắn, chọn đích | US14 | 🎯 |
| `ArtifactLibrary.dc.html` | Thư viện: lọc, tìm, dạng bảng/thẻ (360 px), Thùng rác | US7 | 🎯 |
| `ArtifactDetail.dc.html` | Trang toàn màn: vùng xem + tab Phiên bản, Liên kết, Hoạt động | US7 | 🎯 |
| `AppLeader.dc.html` | Leader chat tối thiểu trong app (C13) + khung bên cạnh + "Nhờ Leader sửa" | US6, US14 | 🎯 |
| `AppArtifacts.dc.html` | Thư viện trong app, nhãn "Bản đã tải", trạng thái offline | US6 | 🎯 |
| `AppNav.dc.html` (biến thể) | Menu Leader, Artifact cho mọi hồ sơ | US6 | 🎯 |
| `ArtifactEditor.dc.html` | Tạo/sửa tay: chọn loại, Markdown (Tiptap), code + Xem trước, xung đột, dòng bí mật | US9 | |
| `TerminalLeader.dc.html` (biến thể/mới) | Khung bên cạnh terminal xterm | US8 | |
| `Policies.dc.html` (biến thể) | Mục Artifacts của chính sách tổ chức (không có CDN, không chế độ che) | US12 | |
| `ArtifactUsage.dc.html` | Dung lượng theo dự án/người, ngưỡng 80% | US12 | |
| `Plan.dc.html`, `Projects.dc.html`, `AppSdlcItem.dc.html`, `DocEditor.dc.html` (biến thể) | Mục "Artifact" ở task/run, dự án, hạng mục AI SDLC, tài liệu; "Chuyển thành tài liệu", "Lưu vào repo" | US10, US11 | |

## Implementation Strategy

- **MVP** 🎯 (theo quyết định PO 2026-10-14): T001–T005, T010–T016, T020–T023, T030, T031, T040, T041, T050.
  - Có: loại `markdown`, `code`, `html`, `mermaid`, `react` (biên dịch trên hub, bộ thư viện đóng gói); khung bên cạnh trong
    Leader chat web và app (màn Leader tối thiểu trong app); thẻ tham chiếu; tool MCP cho Leader, run, client người dùng;
    phiên bản (lịch sử, so sánh, khôi phục, đặt tên); phạm vi `private`, `project`; thư viện và trang chi tiết tối thiểu;
    sửa tay bằng ô soạn chữ; app đọc offline; quét bí mật (chặn); giới hạn và dung lượng mặc định (chỉnh bằng API chính
    sách, chưa có màn); thùng rác; khung cách ly cùng host, chặn mạng, không CDN; link công khai (tạo, thu hồi, trang
    công khai, giới hạn tốc độ, audit, màn quản trị); "Nhờ Leader sửa".
  - Chưa: `svg`, `json`, `csv`, ảnh/PDF, phạm vi `team`/`org`, Terminal Leader, liên kết task/run/hạng mục/tài liệu ngoài
    liên kết tự động, chuyển đổi, màn chính sách/dung lượng, editor Tiptap.
  - Lý do chọn ranh giới: phần MVP là phần đổi mô hình dữ liệu, quyền và đường bảo mật (khung cách ly, vé, CSP, bộ đệm app,
    link công khai) — để sau thì phải đổi dữ liệu và route đã dùng. PO thêm `react`, link công khai và "Nhờ Leader sửa"
    vào MVP; ba phần này dùng chung đường khung cách ly nên làm cùng lúc rẻ hơn làm lại. Phần sau MVP thêm loại hiển thị,
    đích liên kết và màn quản trị trên mô hình đã có.
  - MVP lớn hơn đề xuất ban đầu khoảng 6 task (T014, T015, T016, T023, T031, phần `react` của T004) [Suy luận: ước theo số
    task, chưa ước công].
- **Tăng dần**: T061 → T063 → T065 → T066 → T067 → T062 (ảnh/PDF, cần quyết lưu blob) → T064 khi LEADTERM xong → T068 khi
  #204 merge.
- Mỗi PR không đổi hành vi hiện có khi tool artifact còn tắt (rollout bước 1 trong plan.md); màn Leader web chỉ đổi khi
  tin nhắn có `artifact`.
