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
- **MVP** (🎯): loại `markdown`, `code`, `html`, `mermaid`; khung bên cạnh trong Leader chat web + app; tool MCP cho agent;
  phiên bản (lịch sử, so sánh, khôi phục); phạm vi `private` và `project`; thư viện tối thiểu; app đọc offline; quét bí
  mật; giới hạn mặc định. Chi tiết ở "Implementation Strategy".
- Mọi mặc định trong spec "Clarifications" còn **chờ PO xác nhận**; đổi mặc định nào thì sửa task liên quan trước khi giao.
- Phụ thuộc ngoài: **LEADTERM** (Terminal Leader trên web, đang làm) cho T064; **Tiptap #204** (editor Tiptap trong
  `@xdev-hive/doc-editor`) cho T068; spec 011 (`sdlc` có màn hạng mục) cho phần hạng mục của T065.

---

## Phase 1: Nền (chặn mọi story)

- [ ] T001 🎯 Contract artifacts
  - `artifacts.ts` mới: schema, input, route `artifactsContract` đủ như plan.md "Contracts" (kể cả route sau MVP `toDoc`,
    `toRepo`, `usage` để `openapi.json` ổn định), input bốn tool MCP, lỗi `ARTIFACT_*`.
  - `policies.ts`: `orgArtifactPolicy` (mọi trường `.default()`), thêm vào `agentPolicyInput`.
  - `leader.ts`: `chatMessage.artifact` (nullable, default null).
  - Khung rỗng cho T002: `secret-scan.ts` (kiểu `SecretFinding`, chữ ký `scanSecrets`, `redactSecrets`, thân `throw`).
  - `index.ts` export; `pnpm openapi`; test parse (policy cũ không có `artifacts` vẫn parse; `cdnAllow` từ chối
    `http://`, đường dẫn, `*` trần).
  - **Scope**: `packages/contracts/src/{artifacts.ts,artifacts.test.ts,secret-scan.ts,policies.ts,leader.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: không · **Mức**: vừa

- [ ] T002 🎯 [P] Bộ quét bí mật dùng chung
  - Thân `scanSecrets`/`redactSecrets` theo plan.md D12; trả `{ line, kind }`, không trả chuỗi.
  - Fixture `fixtures/secret-scan.json` ≥ 15 mẫu dương (mỗi loại) + mẫu âm (SHA git, UUID, base64 ảnh nhỏ, `password:` rỗng).
  - Test Go đọc cùng fixture, ghi nhận mẫu worker chưa bắt (`t.Skip` kèm tên mẫu, không sửa `checks.go`).
  - **Scope**: `packages/contracts/src/{secret-scan.ts,secret-scan.test.ts}`, `packages/contracts/fixtures/secret-scan.json`,
    `worker/internal/runner/secret_fixture_test.go`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T003 🎯 Bảng và migration
  - `artifacts/schema.ts` mới (`artifacts`, `artifact_versions`, `artifact_links`, `artifact_previews`, enum; `orgScoped`);
    `leader/schema.ts` (`chat_messages.artifact_id`, `artifact_version`).
  - `pnpm --filter @xdev-hive/hub db:generate`; thêm tay: `FORCE ROW LEVEL SECURITY`, FK `on delete set null
    (artifact_id)`, thu hồi `UPDATE/DELETE` của `hive_app` trên `artifact_versions`, hàm `hive.artifact_tombstone`,
    `hive.artifact_version_rename`, hàm purge của `hive_owner`.
  - `artifacts/rls.db.test.ts` (0 dòng khác tổ chức; `hive_app` không `UPDATE` được phiên bản); ca nâng cấp trong
    `migrations-upgrade.db.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{schema.ts,rls.db.test.ts}`, `apps/hub/src/modules/leader/schema.ts`,
    `apps/hub/db/migrations/00NN_artifacts.sql`, `apps/hub/db/migrations/meta/*`, `apps/hub/src/migrations-upgrade.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T004 🎯 [P] Package `@xdev-hive/artifacts-runtime`
  - `scripts/build-lib.ts`: dựng `dist/lib/mermaid@<ver>/…` (ESM) và `lib-manifest.json` (đường dẫn, SRI sha384); script
    chạy trong `pnpm build` của package và trước test của hub.
  - `csp.ts` `buildCsp({ libBase, cdnAllow })` (US3-3; không bao giờ thêm CDN vào `connect-src`);
    `frame-document.ts` `buildFrameDocument({ type, content, compiled?, theme, manifest, libBase })` cho `html`,
    `mermaid`, `svg` (MVP; `react`, `pdf`, `csv-chart` để T060–T062 thêm nhánh); `bootstrap.ts` (ready/resize/error);
    `messages.ts` (schema zod tin `postMessage`).
  - Test: snapshot tài liệu khung từng loại; HTML không có `<head>`; nội dung chứa `</script>` trong mermaid không thoát
    khỏi khối `text/plain`; CSP đúng với/không CDN.
  - **Scope**: `packages/artifacts-runtime/**` (package mới), `pnpm-lock.yaml`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T005 🎯 [P] Thiết kế màn MVP bằng skill `ui-ux-pro-max`, design system v2, shadcn/ui; mỗi màn có trạng thái rỗng /
  đang tải / lỗi / offline, 360 px, sáng/tối, chữ vi/en (xem "Màn cần thiết kế", các dòng MVP).
  - **Scope**: `docs/design-system/screens/{ArtifactPanel,ArtifactLibrary,ArtifactDetail,ArtifactVersions,ArtifactShare,AppLeader,AppArtifacts}.dc.html`
    (mới), `docs/design-system/screens/{Leader,AppNav}.dc.html` (biến thể), `docs/design-system/screens/README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

- [ ] T006 [P] Thiết kế màn sau MVP: soạn tay, Terminal Leader, chính sách, dung lượng, mục Artifact ở task/run/dự án/hạng
  mục, chuyển thành tài liệu, lưu vào repo.
  - **Scope**: `docs/design-system/screens/{ArtifactEditor,ArtifactUsage}.dc.html` (mới),
    `docs/design-system/screens/{Policies,Plan,Projects,AppSdlcItem,DocEditor}.dc.html` (biến thể),
    `docs/design-system/screens/TerminalLeader.dc.html` (biến thể nếu LEADTERM đã tạo, không thì mới); ghi chú bàn giao
    cho T005 để gộp `README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

**Checkpoint**: contract, bộ quét, bảng, runtime khung, thiết kế MVP sẵn sàng.

---

## Phase 2: Lõi hub (US1, US2, US4, US5) 🎯

- [ ] T010 🎯 Module `artifacts`: dịch vụ, quyền, giới hạn, router
  - `access.ts` (`readerFor`, `visibleArtifactsWhere`, `assertCan(action)` theo bảng quyền plan.md), `service.ts` (tạo,
    phiên bản mới với khoá lạc quan, đổi tên, phạm vi, chủ, nhân bản, xoá mềm, khôi phục, tombstone, liệt kê/tìm với con
    trỏ), `limits.ts` (trần env + chính sách tổ chức, khoá tư vấn theo tổ chức, giới hạn run), quét bí mật (`block`/
    `redact`), cập nhật `search`, audit (plan.md "Audit"), `purge.ts` (job pg-boss: thùng rác 30 ngày, bản xem trước, liên
    kết mồ côi), `hooks.ts` (`provideThreadHost`, `provideTerminalHost`, `provideLinkTarget`), `router.ts` (mọi route của
    T001 trừ `frameUrl`, `preview`, `frameDocument` → T012; `toDoc`, `toRepo` → T066; `usage` trả số thật).
  - Test: `artifacts.db.test.ts` (phiên bản, xung đột, thiếu `baseVersion`, giới hạn 200, cỡ, dung lượng với hai lần lưu
    đồng thời, bí mật block/redact, thùng rác, purge, tombstone), `access.db.test.ts` (ma trận ba người × bốn phạm vi ×
    route, SC-002), `access.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{access.ts,service.ts,versions.ts,limits.ts,hooks.ts,purge.ts,router.ts,index.ts}`
    + test tương ứng
  - **Phụ thuộc**: T001, T002, T003 · **Mức**: nặng

- [ ] T011 🎯 Tool MCP `artifact_*`
  - `artifacts/mcp-tools.ts`: bốn tool (plan.md "MCP"), quyền run theo FR-032, liên kết tự động `run`/`task`/
    `chat_thread`/`terminal_session`, từ chối `doccheck`/`docassist`/`brief` (`ARTIFACT_RUN_KIND`), lỗi xung đột kèm bản
    mới nhất.
  - `mcp/registry.ts`: cờ `forLeader` trên `McpTool`; `list()` cho run `leader` trả thêm tool có `forLeader`; thêm bốn tool
    vào `RUN_TOOLS`. Kiểm cách MCP-03 ("read-only kinds get no write tools") đang thực thi và ghi lại trong ghi chú bàn giao
    nếu cần sửa chữ MCP-03 (T050 sửa srs).
  - Test: `mcp-artifacts.db.test.ts` (run `leader`/`code`/`plan`/`doccheck`, người dùng PAT; giới hạn run; tool tắt bởi
    MCP-04 không hiện), cập nhật `mcp/registry.test.ts`.
  - **Scope**: `apps/hub/src/modules/artifacts/{mcp-tools.ts,mcp-artifacts.db.test.ts}`, `apps/hub/src/modules/mcp/{registry.ts,registry.test.ts}`
  - **Phụ thuộc**: T010 · **Mức**: vừa

- [ ] T012 🎯 Route khung cách ly, vé, thư viện tĩnh
  - `ticket.ts` (HMAC, khoá HKDF từ khoá chủ, hạn ≤ 5 phút, phiên bản hoặc bản xem trước), `frame-routes.ts`
    (`/_artifact/frame/:ticket`, `/_artifact/lib/*` từ `artifacts-runtime/dist/lib` cache `immutable`; header ở FR-071;
    410 khi xoá/tombstone; `HIVE_ARTIFACT_ORIGIN`: chỉ trả khi `Host` khớp), route oRPC `frameUrl`, `preview`,
    `frameDocument`.
  - Đăng ký route trong `app.ts` **trước** SPA (như `/mcp`); `Dockerfile` chép `artifacts-runtime/dist/lib` nếu image chưa
    có.
  - Test: `ticket.test.ts` (sửa payload, hết hạn, sai tổ chức), `frame-routes.db.test.ts` (header, CSP, 404 trên host hub
    khi có origin riêng, không đọc cookie).
  - **Scope**: `apps/hub/src/modules/artifacts/{ticket.ts,frame-routes.ts}` + test, `apps/hub/src/app.ts`,
    `apps/hub/.env.example`, `Dockerfile` (nếu cần)
  - **Phụ thuộc**: T004, T010 · **Mức**: nặng

- [ ] T013 🎯 Leader: thẻ artifact trong chat
  - `leader` cung cấp `ThreadHost` (`assertRunThread` dùng lại kiểm của `leader_reply`; `postArtifactCard` thêm tin nhắn thẻ,
    cập nhật `updated_at`); router trả `chatMessage.artifact`; xoá cuộc trò chuyện xoá liên kết `chat_thread`.
  - `leader/prompt.ts`: đoạn hướng dẫn artifact (US5-7); `prompt.test.ts`.
  - Test `leader.db.test.ts`: run leader tạo artifact → thẻ đúng thứ tự, `artifact` trong `threads.get`; thread của run khác
    → `ARTIFACT_LINK_FORBIDDEN`; artifact bị xoá hẳn → thẻ còn, `artifact` null.
  - **Scope**: `apps/hub/src/modules/leader/{mcp-tools.ts,prompt.ts,prompt.test.ts,router.ts,index.ts}`,
    `apps/hub/src/leader.db.test.ts`
  - **Phụ thuộc**: T011 · **Mức**: vừa

**Checkpoint**: agent tạo/sửa/đọc artifact qua MCP; thẻ trong chat; khung phục vụ được (chưa có UI).

---

## Phase 3: Package giao diện dùng chung (US1–US4, US7) 🎯

- [ ] T020 🎯 `@xdev-hive/artifacts-ui` — khung, thẻ, trình xem, khung cách ly
  - `env.tsx` (`ArtifactsEnv`), `text.ts` (vi/en), `card.tsx`, `panel.tsx` (tab, thanh công cụ, tự mở artifact mới trừ khi
    đang sửa, trạng thái: tải, lỗi, bản mới hơn, offline, đã xoá), `sandbox-frame.tsx` (plan.md D16, nút Dừng trang, nhãn
    "Nội dung do agent tạo"), `viewer/{markdown,code,html,mermaid}.tsx` (markdown qua doc-editor chỉ đọc, không HTML thô,
    ảnh ngoài chờ bấm; code bằng `shiki` tải ngôn ngữ lười, render token thành `span`).
  - Test component (Vitest + Testing Library): `SandboxFrame` bỏ tin từ nguồn khác và tin sai schema; markdown không render
    `<script>`/`<img onerror>`; panel tự mở/không tự mở.
  - **Scope**: `packages/artifacts-ui/**` (package mới: `package.json`, `src/{index.ts,env.tsx,text.ts,card.tsx,panel.tsx,sandbox-frame.tsx,viewer/*}` + test),
    `pnpm-lock.yaml`
  - **Phụ thuộc**: T001, T004, T005 · **Mức**: nặng

- [ ] T021 🎯 `@xdev-hive/artifacts-ui` — phiên bản, so sánh, chia sẻ, sửa tay tối thiểu
  - `versions.tsx` (danh sách, đặt tên, khôi phục), `compare.tsx` (diff dòng bằng `line-diff`, cạnh nhau), `share-dialog.tsx`
    (phạm vi `private`/`project`, cảnh báo phiên bản cũ), `editor.tsx` tối thiểu (ô soạn chữ cho `markdown`/`code`/`html`/
    `mermaid`, xem trước qua `preview`, xung đột "Xem khác biệt rồi gộp", dòng bí mật được đánh dấu).
  - **Scope**: `packages/artifacts-ui/src/{versions.tsx,compare.tsx,share-dialog.tsx,editor.tsx}` + test
  - **Phụ thuộc**: T020 · **Mức**: vừa

- [ ] T022 🎯 [P] `@xdev-hive/artifacts-ui` — thư viện và chi tiết
  - `library.tsx` (lọc phạm vi/loại/nguồn/dự án, tìm, con trỏ, thùng rác, dạng thẻ ở 360 px), `detail.tsx` (vùng xem + tab
    Phiên bản, Liên kết, Hoạt động).
  - **Scope**: `packages/artifacts-ui/src/{library.tsx,detail.tsx}` + test
  - **Phụ thuộc**: T020 (song song với T021: khác file; `index.ts` của package do T020 export sẵn tên, T021/T022 chỉ điền
    file) · **Mức**: vừa

---

## Phase 4: Web (US1–US4, US7) 🎯

- [ ] T030 🎯 Web: khung bên cạnh trong Leader, thư viện, chi tiết
  - `leader-page.tsx`: thẻ thay chữ khi `message.artifact`, lưới chat | vạch chia | khung (≥ 1024 px), `Sheet` (< 1024 px),
    nhớ độ rộng; trang `pages/artifacts/{library-page,detail-page}.tsx`; `router.tsx` (`/artifacts`, `/artifacts/:id`,
    `/artifacts/:id/v/:n`); `nav.ts` (mục Artifact); `ArtifactsEnv` của web.
  - `e2e/fake-hub.ts`: route artifacts + `/_artifact/frame|lib` (dùng `buildFrameDocument`, `buildCsp` thật) + ghi request.
  - Playwright: `artifacts.spec.ts` (kịch bản MVP SC-008, 360 px, tối), `artifact-sandbox.spec.ts` (bộ ca thoát SC-001),
    đo SC-003.
  - **Scope**: `apps/web/src/pages/leader-page.tsx`, `apps/web/src/pages/artifacts/**`, `apps/web/src/router.tsx`,
    `apps/web/src/lib/nav.ts`, `apps/web/e2e/{fake-hub.ts,artifacts.spec.ts,artifact-sandbox.spec.ts}`, `apps/web/package.json`
  - **Phụ thuộc**: T012, T013, T021, T022 · **Mức**: nặng

---

## Phase 5: App desktop (US6) 🎯

- [ ] T040 🎯 Desktop Rust: bộ đệm, giao thức `hive-artifact://`, CSP
  - `artifacts.rs`: lệnh IPC `artifact_cache_put/get/list/clear` (LRU 200 MiB theo hồ sơ + tổ chức), giao thức
    `hive-artifact` (`frame/<id>/<version>` từ bộ đệm, `lib/*` từ resource, CSP như hub); xoá bộ đệm khi đăng xuất/đổi tổ
    chức (gọi từ luồng đăng xuất sẵn có); `tauri.conf.json` (`frame-src`, resource `artifacts-runtime/dist/lib`).
  - `cargo test`: LRU, xoá theo hồ sơ, 404 khi thiếu, header CSP.
  - **Scope**: `apps/desktop/src-tauri/src/{artifacts.rs,lib.rs}`, `apps/desktop/src-tauri/tauri.conf.json`,
    `apps/desktop/src-tauri/Cargo.toml` (nếu cần), `apps/desktop/src/lib/artifact-cache.ts` + test
  - **Phụ thuộc**: T004, T012 · **Mức**: nặng

- [ ] T041 🎯 Desktop: màn Leader tối thiểu và màn Artifact
  - `screens/leader-screen.tsx` (C13, plan.md D18: cuộc trò chuyện, tin nhắn, gửi, thẻ đề xuất duyệt/từ chối, thẻ artifact,
    khung bên cạnh), `screens/artifacts-screen.tsx` (thư viện + chi tiết từ package), `ArtifactsEnv` của app (offline từ
    bộ đệm), `nav.ts`, `screens/index.ts`, từ điển; ẩn menu khi hub không có `artifacts` (hỏi khả năng hub).
  - Test desktop: thẻ, khung, offline (hub giả tắt sau khi tải, SC-009), 360 px.
  - **Scope**: `apps/desktop/src/screens/{leader-screen.tsx,leader-screen.test.tsx,artifacts-screen.tsx,artifacts-screen.test.tsx,index.ts}`,
    `apps/desktop/src/lib/{nav.ts,i18n.ts}`, `apps/desktop/package.json`
  - **Phụ thuộc**: T013, T021, T022, T040 · **Mức**: vừa

---

## Phase 6: Nối hub và tài liệu 🎯

- [ ] T050 🎯 Nối và tài liệu
  - `main.ts`: đăng ký module, tool, job purge, `provideThreadHost` của leader; khả năng hub `artifacts: true` trong
    `system` (cho app); rollout bước 1 (tool tắt mặc định tới khi bật trên máy chủ 34).
  - Tài liệu: `docs/architecture.md` (module `artifacts`, khung cách ly), `docs/add.md`, `docs/srs.md` (trạng thái ART-*,
    chữ MCP-03 nếu T011 báo), `docs/self-hosting.md` (`HIVE_ARTIFACT_ORIGIN`, khối Caddy, trần dung lượng),
    `docs/feature-checklist.md` nếu cần; ADR 0023 → Accepted khi PO xác nhận.
  - **Scope**: `apps/hub/src/main.ts`, `apps/hub/src/modules/system/**`, `docs/{architecture.md,add.md,srs.md,self-hosting.md}`,
    `docs/adr/{0023-artifacts.md,README.md}`, `deploy/caddy/**` (khối mẫu)
  - **Phụ thuộc**: T030, T041 · **Mức**: nhẹ

**Checkpoint MVP**: SC-001…SC-005, SC-008…SC-011 đạt trên web và app.

---

## Phase 7: Sau MVP

- [ ] T060 [US3] Loại `react`: biên dịch và thư viện
  - `artifacts-runtime`: thêm React 19, ReactDOM, Recharts, d3, lucide-react, Tailwind bản trình duyệt vào bộ đóng gói,
    nhánh `react` của `buildFrameDocument`; hub `compile.ts` (`sucrase`, `es-module-lexer`, chỉ import trong manifest) gọi
    trong `prepare` của tool và trong route; `viewer/react.tsx`; bật `react` trong chính sách mặc định.
  - **Scope**: `packages/artifacts-runtime/**`, `apps/hub/src/modules/artifacts/{compile.ts,compile.test.ts}`,
    `apps/hub/src/modules/artifacts/service.ts` (gọi compile), `packages/artifacts-ui/src/viewer/react.tsx`
  - **Phụ thuộc**: MVP · **Mức**: nặng

- [ ] T061 [P] [US3] Loại `svg`, `json`, `csv` (bảng + biểu đồ trong khung)
  - **Scope**: `packages/artifacts-ui/src/viewer/{svg,json,csv}.tsx`, `packages/artifacts-runtime/src/frame-document.ts`
    (nhánh `csv-chart`)
  - **Phụ thuộc**: T060 (thư viện biểu đồ) · **Mức**: vừa

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
  - Mục Artifacts trong trang Chính sách agent; màn Dung lượng artifact (`usage`); thông báo `artifact.quota`.
  - **Scope**: `apps/web/src/pages/admin/policies-page.tsx`, `apps/web/src/pages/admin/artifact-usage-page.tsx`,
    `apps/hub/src/modules/artifacts/limits.ts` (thông báo), `packages/contracts/src/notify.ts` (qua làn contracts)
  - **Phụ thuộc**: MVP · **Mức**: vừa

- [ ] T068 [US9] Soạn tay đầy đủ
  - Markdown bằng doc-editor Tiptap (ẩn R-n, đề xuất, gửi duyệt); ô soạn code có tô màu; nút "Artifact mới" ở thư viện và
    khung.
  - **Scope**: `packages/artifacts-ui/src/editor.tsx`, `packages/doc-editor/src/**` (chỉ cờ chế độ artifact, phối hợp làn
    doc-editor)
  - **Phụ thuộc**: Tiptap #204, MVP · **Mức**: vừa

- [ ] T069 [US3] "Nhờ Leader sửa": gửi lỗi trang về cuộc trò chuyện
  - **Scope**: `packages/artifacts-ui/src/panel.tsx`, `apps/web/src/pages/leader-page.tsx`,
    `apps/desktop/src/screens/leader-screen.tsx`
  - **Phụ thuộc**: MVP · **Mức**: nhẹ

---

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┐
      ├─ T003 ─┼─ T010 ─ T011 ─ T013 ─┐
      │        │    └─────── T012 ────┼─ T030 ─┐
      ├─ T004 ─┼──────────────┘       │        ├─ T050
      │        └─ T020 (T005) ─┬─ T021 ┤        │
      │                        └─ T022 ┘        │
      │                     T040 (T004, T012) ─ T041 (T013, T021, T022) ┘
T005, T006 (không phụ thuộc)
Sau MVP: T060 → T061; T062; T063; T064 (LEADTERM); T065 (spec 011); T066; T067; T068 (#204); T069
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T005, T006 |
| 2 | T002, T003, T004 |
| 3 | T010, T020 |
| 4 | T011, T012, T021, T022 |
| 5 | T013, T040 |
| 6 | T030, T041 |
| 7 | T050 |
| 8 (sau MVP) | T060, T062, T063, T066, T067 |
| 9 (sau MVP) | T061, T064, T065, T068, T069 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002 (file riêng, sau T001) → T067 (phần `notify.ts`) | `packages/contracts/src/index.ts`, `openapi.json` (chỉ T001) |
| db | T003 → T062 (migration sau) | `migrations/**`, `artifacts/schema.ts`, `leader/schema.ts` |
| artifacts-core | T010 → T011 → T012 → T060 (phần hub) → T062 (phần hub) → T063 → T066 → T067 (phần hub) | `artifacts/index.ts`, `artifacts/service.ts`, `artifacts/access.ts` |
| mcp | T011 | `mcp/registry.ts` |
| leader | T013 | `leader/**` (trừ `schema.ts` của T003) |
| runtime | T004 → T060 → T061 (phần khung) → T062 (phần runtime) | `packages/artifacts-runtime/**` |
| ui-pkg | T020 → T021, T022 (khác file) → T061 → T068 → T069 | `packages/artifacts-ui/src/index.ts` (T020), `panel.tsx` |
| web | T030 → T065 (phần web) → T067 → T069 (phần web) | `apps/web/src/router.tsx`, `lib/nav.ts`, `pages/leader-page.tsx`, `e2e/fake-hub.ts` |
| desktop | T040 → T041 → T062 (phần Rust) → T069 (phần app) | `apps/desktop/src/lib/nav.ts`, `screens/index.ts`, `src-tauri/src/lib.rs`, `artifacts.rs` |
| wiring-docs | T050 → T064 (phần `main.ts`) | `apps/hub/src/main.ts`, `app.ts` (T012 sửa `app.ts` trước T050), `docs/**` |
| design | T005, T006 | `docs/design-system/screens/README.md` (T005 sửa; T006 ghi chú bàn giao) |

`artifacts/index.ts` thuộc làn artifacts-core; task ngoài làn cần export thêm thì ghi vào ghi chú bàn giao để T050 gộp.

## Màn cần thiết kế (T005, T006)

| File | Màn | Story | MVP |
|---|---|---|---|
| `Leader.dc.html` (biến thể) | Leader chat web có thẻ artifact; chia đôi chat · khung ≥ 1024 px; ngăn kéo toàn màn 360 px; danh sách artifact của cuộc trò chuyện | US1 | 🎯 |
| `ArtifactPanel.dc.html` | Khung bên cạnh: tab, thanh công cụ, trình xem markdown/code/html/mermaid, khung cách ly có nhãn "Nội dung do agent tạo", trạng thái tải/lỗi/trang báo lỗi/bản mới hơn/offline/đã xoá, Dừng trang | US1, US3, US6 | 🎯 |
| `ArtifactVersions.dc.html` | Lịch sử phiên bản (tác giả người/run, nguồn, tên bản), So sánh: Khác biệt + Cạnh nhau, Khôi phục | US2 | 🎯 |
| `ArtifactShare.dc.html` | Hộp chia sẻ (cá nhân/dự án; sau MVP đội/tổ chức), cảnh báo phiên bản cũ, chuyển chủ | US4 | 🎯 |
| `ArtifactLibrary.dc.html` | Thư viện: lọc, tìm, dạng bảng/thẻ (360 px), Thùng rác | US7 | 🎯 |
| `ArtifactDetail.dc.html` | Trang toàn màn: vùng xem + tab Phiên bản, Liên kết, Hoạt động | US7 | 🎯 |
| `AppLeader.dc.html` | Leader chat tối thiểu trong app (C13) + khung bên cạnh | US6 | 🎯 |
| `AppArtifacts.dc.html` | Thư viện trong app, nhãn "Bản đã tải", trạng thái offline | US6 | 🎯 |
| `AppNav.dc.html` (biến thể) | Menu Leader, Artifact cho mọi hồ sơ | US6 | 🎯 |
| `ArtifactEditor.dc.html` | Tạo/sửa tay: chọn loại, Markdown (Tiptap), code + Xem trước, xung đột, dòng bí mật | US9 | |
| `TerminalLeader.dc.html` (biến thể/mới) | Khung bên cạnh terminal xterm | US8 | |
| `Policies.dc.html` (biến thể) | Mục Artifacts của chính sách tổ chức | US12 | |
| `ArtifactUsage.dc.html` | Dung lượng theo dự án/người, ngưỡng 80% | US12 | |
| `Plan.dc.html`, `Projects.dc.html`, `AppSdlcItem.dc.html`, `DocEditor.dc.html` (biến thể) | Mục "Artifact" ở task/run, dự án, hạng mục AI SDLC, tài liệu; "Chuyển thành tài liệu", "Lưu vào repo" | US10, US11 | |

## Implementation Strategy

- **MVP** 🎯: T001–T005, T010–T013, T020–T022, T030, T040, T041, T050.
  - Có: loại `markdown`, `code`, `html`, `mermaid`; khung bên cạnh trong Leader chat web và app (màn Leader tối thiểu trong
    app); thẻ tham chiếu; tool MCP cho Leader, run, client người dùng; phiên bản (lịch sử, so sánh, khôi phục, đặt tên);
    phạm vi `private`, `project`; thư viện và trang chi tiết tối thiểu; sửa tay bằng ô soạn chữ; app đọc offline; quét bí
    mật; giới hạn và dung lượng mặc định (chỉnh bằng API chính sách, chưa có màn); thùng rác.
  - Chưa: `react`, `svg`, `json`, `csv`, ảnh/PDF, phạm vi `team`/`org`, Terminal Leader, liên kết task/run/hạng mục/tài
    liệu ngoài liên kết tự động, chuyển đổi, màn chính sách/dung lượng, editor Tiptap, "Nhờ Leader sửa".
  - Lý do chọn ranh giới: phần MVP là phần đổi mô hình dữ liệu, quyền và đường bảo mật (khung cách ly, vé, CSP, bộ đệm app) —
    để sau thì phải đổi dữ liệu và route đã dùng. Phần sau MVP thêm loại hiển thị, đích liên kết và màn quản trị trên mô
    hình đã có. `html` vào MVP thay `react` vì cùng đường khung cách ly nhưng không cần bước biên dịch và bộ thư viện lớn.
- **Tăng dần**: T060 (`react`) → T061 → T063 → T065 → T066 → T067 → T062 (ảnh/PDF, cần quyết lưu blob) → T064 khi
  LEADTERM xong → T068 khi #204 merge → T069.
- Mỗi PR không đổi hành vi hiện có khi tool artifact còn tắt (rollout bước 1 trong plan.md); màn Leader web chỉ đổi khi
  tin nhắn có `artifact`.
