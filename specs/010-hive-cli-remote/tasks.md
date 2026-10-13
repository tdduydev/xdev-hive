# Tasks: CLI `hive` và điều khiển agent từ xa qua web trên điện thoại

**Input**: [spec.md](spec.md), [plan.md](plan.md), [ADR 0019](../../docs/adr/0019-hive-cli-and-remote-sessions.md)

**Tests**: bắt buộc (feature-checklist mục 5). Mỗi task tự viết test của phần mình và để `pnpm check` xanh; task Go
chạy `gofmt -l .`, `go vet ./...`, `go test ./...` trong `worker/`.

## Cách đọc

- Dạng: `- [ ] T### [P?] [US?] Mô tả` rồi các dòng **Scope** (file được sửa/tạo, chỉ task đó đụng), **Phụ thuộc**,
  **Mức** (`nặng` → Opus 5.5 `--effort high`; `vừa` → Sonnet 5.5 `--effort high`; `nhẹ` → Sonnet 5.5 `--effort medium`,
  theo CLAUDE.md). Mọi task trong `internal/remoteauth`, kiểm quyền ở hub và `/ws/terminal` là `nặng` vì là phần bảo mật.
- `[P]`: chạy song song được với các task `[P]` khác **khi phụ thuộc đã xong** (khác file, không chờ nhau).
- Hai task cùng một **làn** (bảng cuối) sửa chung file nên phải làm nối tiếp trong cùng worktree hoặc sau khi task trước
  đã merge.
- `packages/contracts/openapi.json` chỉ T002 sinh lại. Task khác cần đổi contract thì báo người điều phối thêm vào T002
  hoặc mở task contract mới, không tự sửa.
- Migration chỉ T007 sinh (số kế tiếp lúc làm, sau migration của spec 009). Task khác cần đổi bảng thì làm sau T007 và
  sinh migration số kế tiếp.
- Gói `term_*` trong Go: T010 viết kiểu và chuyển gói tới interface `terminal.Handler`; các task sau chỉ hiện thực
  method trong `internal/terminal`, không sửa `internal/channel`.

---

## Phase 1: Nền (chặn mọi story)

- [ ] T001 Contract giao thức worker và xác thực từ xa
  - `worker-protocol.ts`: mọi gói `term_*` theo bảng ở plan.md; `welcome.features?`, `welcome.owner?`; enum
    `termEventKind`, `termDenyCode`; thêm vào `workerToHub`/`hubToWorker`. Không đổi `PROTOCOL_VERSION`.
  - `terminal-auth.ts`: `canonicalChallenge(input)` (khoá theo thứ tự, NFC), kiểu `RemoteAuth`, `pairTag` input,
    `inputMacPayload(connId, seq, data)`.
  - Fixture: thêm mẫu mọi gói vào `worker-protocol.json`; `terminal-auth.json` mới với vector sinh bằng WebCrypto trong test
    (khoá ES256, authenticatorData, clientDataJSON, chữ ký đúng/sai origin/thiếu UV/phát lại; ECDH + HKDF + HMAC; tag
    ghép).
  - Test: `worker-protocol.test.ts` (gói cũ vẫn parse; gói mới parse; hub cũ không có `features` vẫn hợp lệ),
    `terminal-auth.test.ts` (chuẩn hoá ổn định, vector khớp).
  - **Scope**: `packages/contracts/src/{worker-protocol.ts,worker-protocol.test.ts,terminal-auth.ts,terminal-auth.test.ts}`,
    `packages/contracts/fixtures/{worker-protocol.json,terminal-auth.json}`, `packages/contracts/scripts/*` nếu cần sinh
    vector
  - **Phụ thuộc**: không · **Mức**: nặng

- [ ] T002 Contract API `terminal.*` và đăng nhập CLI
  - `terminal.ts`: kiểu phiên, máy (trạng thái từ xa), thiết bị, route ở plan.md (`machines`, `list`, `get`, `chunks`,
    `ticket`, `start`, `close`, `setVisibility`, `disableRemote`, `pairOptions`, `pairComplete`, `devices`,
    `revokeDevice`, `pushKey`, `pushSubscribe`, `pushUnsubscribe`); khung WS trình duyệt (`resume`, `control`, `in`,
    `resize`, `granted`, `revoked`, `state`, `sync`) với giới hạn cỡ; mã lỗi và thông báo tiếng Việt.
  - `desktop-connect.ts`: `purpose: "desktop" | "cli"` (mặc định `desktop`), output cho `cli` không có mã đăng ký máy.
  - `notify.ts`: loại sự kiện `terminal.remote_session`, `terminal.attention`, `terminal.exit` cho hộp thư và đẩy.
  - `index.ts` gắn contract; `pnpm openapi`.
  - **Scope**: `packages/contracts/src/{terminal.ts,terminal.test.ts,desktop-connect.ts,notify.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T003 [P] Worker: gói PTY
  - `internal/pty`: bọc `aymanbagabas/go-pty` (Unix + ConPTY): `Start(cmd, env, dir, cols, rows)`, `Resize`, `Read`,
    `Write`, `Signal(hup|int|kill)`, `Wait`; nhóm tiến trình để kill cả cây.
  - Test với CLI giả (Go test binary): echo, output 10 MB, resize, thoát mã khác 0, kill cây; CI Windows chạy test ConPTY.
  - **Scope**: `worker/internal/pty/**`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: không · **Mức**: nặng

- [ ] T004 [P] Worker: socket nội bộ
  - `internal/localipc`: server/client; Unix socket 0600 trong thư mục 0700, kiểm UID bằng `SO_PEERCRED`
    (Linux) / `LOCAL_PEERCRED` (macOS); Windows named pipe với DACL chỉ SID hiện tại và kiểm SID client; bắt tay phiên
    bản; yêu cầu JSON một dòng; chuyển sang khung nhị phân `[loại u8][độ dài u32][dữ liệu]` sau `attach`.
  - Test: bắt tay, lệch phiên bản, quyền file, UID khác bị từ chối (qua interface kiểm peer giả), khung lớn, đóng đột ngột.
  - **Scope**: `worker/internal/localipc/**`
  - **Phụ thuộc**: không · **Mức**: nặng

- [ ] T005 [P] Worker: `internal/remoteauth`
  - `remote.json` (đọc/ghi nguyên tử, 0600): `enabled`, `roots`, `devices`, `confirmOnMachine`, `idleMinutes`,
    `detachedHours`, `maxHours`, `allowFullAccess`, `ownerUserId`.
  - Kiểm assertion WebAuthn ES256 chỉ bằng thư viện chuẩn (SPKI, `authenticatorData`, `clientDataJSON`): `type`,
    `challenge` = chuẩn hoá như contracts, `origin` = URL hub, `rpIdHash`, cờ UP+UV, `signCount`, `ts` ±120 s, bộ nhớ
    `nonce` 10 phút, `userId` của thiết bị.
  - Ghép: mã ghép (pairId, bí mật 128 bit, 10 phút, dùng một lần), kiểm tag HMAC.
  - ECDH P-256 + HKDF-SHA256 → khoá; kiểm HMAC 16 byte và `seq` tăng nghiêm ngặt.
  - Test đọc `packages/contracts/fixtures/terminal-auth.json` (mọi ca đúng/sai).
  - **Scope**: `worker/internal/remoteauth/**`
  - **Phụ thuộc**: T001 · **Mức**: nặng

- [ ] T006 [P] Thiết kế UI bằng skill `ui-ux-pro-max`, theo design system và shadcn/ui: web điện thoại (danh sách máy và
  phiên, terminal với thanh phím và ô soạn, mở phiên mới, ghép, thiết bị, hướng dẫn cài PWA) và màn app desktop Điều khiển
  từ xa (công tắc, thư mục, thiết bị + QR, phiên, hộp xác nhận); 360 px, sáng/tối.
  - **Scope**: `docs/design-system/screens/{Remote.dc.html,AppRemote.dc.html}` (mới), `docs/design-system/screens/README.md`
  - **Phụ thuộc**: không · **Mức**: vừa

- [ ] T007 Bảng và migration module `terminal`
  - `terminal/schema.ts`: `terminal_sessions`, `terminal_chunks`, `terminal_events`, `remote_devices`,
    `push_subscriptions`, `machine_remote_state` đúng plan.md; `orgScoped`; chỉ số theo máy, chủ, task.
  - `db:generate` → `00NN_terminal.sql`; thêm tay `FORCE ROW LEVEL SECURITY` và `hive.purge_terminal_chunks()` (như
    `purge_run_logs`, cùng số ngày của chính sách agent).
  - `terminal/rls.db.test.ts`; thêm ca nâng cấp vào `migrations-upgrade.db.test.ts` nếu có `ALTER TYPE`.
  - **Scope**: `apps/hub/src/modules/terminal/{schema.ts,rls.db.test.ts}`, `apps/hub/db/migrations/00NN_*.sql`,
    `apps/hub/db/migrations/meta/*`, `apps/hub/src/migrations-upgrade.db.test.ts`
  - **Phụ thuộc**: T001 · **Mức**: vừa

**Checkpoint**: giao thức, contract, bảng, PTY, socket nội bộ, xác thực sẵn sàng.

---

## Phase 2: User Story 1 — Phiên tương tác tại máy, ghi lên hub (P1) 🎯 MVP

- [ ] T010 [US1] Worker: kiểu gói `term_*` và chuyển gói
  - `protocol.go`: kiểu Go cho mọi gói mới; test đọc fixture dùng chung.
  - `channel.go`: khai `terminal` trong `hello.capabilities`; đọc `welcome.features`/`owner`; chỉ gửi `term_*` khi hub
    khai; chuyển gói H→W `term_*` tới `terminal.Handler` (interface mới trong `internal/terminal/handler.go`); hàm gửi
    `term_*` cho handler dùng.
  - Test: hub giả không có `features` → không có gói `term_*` (SC-010); `worker_e2e_test.go` cũ xanh không sửa.
  - **Scope**: `worker/internal/channel/{protocol.go,protocol_test.go,channel.go,channel_test.go}`,
    `worker/internal/terminal/handler.go`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [ ] T011 [US1] Worker: session host
  - `internal/terminal`: `Host` tạo/gắn/liệt kê/ngắt phiên qua `localipc`; một người điều khiển (terminal tại máy hoặc
    kết nối từ xa); env theo danh sách cho phép như run (không `HIVE_*`, không token); che bí mật đã biết trong output;
    ghi: gom 8 ms/32 KiB → `term_output`, đệm đĩa `terminal/<id>/pending` (32 MB, quá thì `gap`), xoá khi `term_ack`;
    `term_opened`, `term_exit`; máy dùng chung/host → không ghi.
  - `accounts.go`: vai trò `interactive` (bỏ ngưỡng dừng, cooldown chỉ khi `force`, tính đang dùng).
  - `cmd/hive-worker/main.go`: mở socket nội bộ khi `run`, nối `Host` vào channel; dọn socket cũ khi khởi động.
  - Test: tạo phiên với CLI giả, tách/gắn lại, hai client (một gõ một xem), mất kết nối hub rồi gửi bù, che token,
    chọn tài khoản `interactive`.
  - **Scope**: `worker/internal/terminal/{host.go,session.go,record.go,mask.go,host_test.go,record_test.go}`,
    `worker/internal/accounts/{accounts.go,accounts_test.go}`, `worker/cmd/hive-worker/{main.go,main_test.go}`
  - **Phụ thuộc**: T003, T004, T010 · **Mức**: nặng

- [ ] T012 [US1] CLI `hive`: đăng nhập, chat/run, ls, kill
  - `cmd/hive`: `login` (loopback PKCE `purpose: cli`, `--with-token`), keychain (`dev.xdev.hive`/URL hub; không có thì
    file 0600 + cảnh báo), `logout`, `whoami`; `chat`/`run` (raw mode bằng `x/term`, SIGWINCH/console resize, phím tách
    và giành quyền, khôi phục terminal), `--task`/`--project` tra hub bằng token cá nhân; `ls`, `kill`, `version`;
    `__hook` (gửi tới worker qua socket); mã thoát theo plan.md; mọi thông báo tiếng Việt.
  - Test: phân tích cờ, mã thoát, worker vắng, lệch phiên bản, luồng login với hub giả, raw mode qua pty giả.
  - **Scope**: `worker/cmd/hive/**`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: T002, T004, T011 · **Mức**: nặng

- [ ] T013 [US1] Hub: module `terminal` lõi
  - `gateway.ts` (handler `term_opened|output|event|exit|state`), `record.ts` (gộp 64 KiB/1 s, loại trùng offset, ack sau
    ghi, purge cùng cron `retention.ts`), `queries.ts`, `router.ts` (`machines`, `list`, `get`, `chunks`,
    `setVisibility`), `index.ts`; kiểm chủ máy, máy cá nhân, task thuộc dự án của đội máy (FR-030); audit `terminal.open`,
    `terminal.exit`, `terminal.visibility`.
  - `fleet/gateway.ts`: `welcome.features`/`owner` khi hub bật module; chuyển gói `term_*` qua deps; chỉ gửi `term_*` tới
    máy có `terminal`.
  - `fleet/desktop-connect.ts`: `purpose: cli` → chỉ token cá nhân, audit `cli.connect.exchange`.
  - `main.ts`, `app.ts`: nối deps, router, cờ `HIVE_REMOTE_TERMINAL` (chỉ chặn phần từ xa; ghi phiên luôn bật).
  - Test DB: ghi và đọc bản ghi, loại trùng, máy dùng chung bị bỏ, task sai đội bị bỏ liên kết, worker cũ không nhận gói
    lạ, `desktop-connect` cli.
  - **Scope**: `apps/hub/src/modules/terminal/{gateway.ts,record.ts,queries.ts,router.ts,index.ts,terminal.db.test.ts}`,
    `apps/hub/src/modules/fleet/{gateway.ts,desktop-connect.ts,desktop-connect.db.test.ts,index.ts}`,
    `apps/hub/src/modules/runs/retention.ts`, `apps/hub/src/{main.ts,app.ts,fleet.db.test.ts}`
  - **Phụ thuộc**: T002, T007 · **Mức**: nặng

- [ ] T014 [P] [US1] Web: danh sách phiên và phát lại bản ghi
  - `components/terminal-view.tsx` (xterm.js + fit, chỉ đọc, tải lười, tắt OSC 52, link cần xác nhận), `pages/remote/`
    `remote-page.tsx` (máy của tôi, phiên), `session-page.tsx` chế độ phát lại (đọc `chunks` theo trang), mục "Phiên
    tương tác" trên trang task; mục menu "Điều khiển từ xa".
  - Playwright với hub giả: danh sách, phát lại, 360 px, tối.
  - **Scope**: `apps/web/src/components/terminal-view.tsx`, `apps/web/src/pages/remote/{remote-page.tsx,session-page.tsx}`,
    `apps/web/src/lib/terminal/{sessions.ts,sessions.test.ts}`, `apps/web/src/pages/tasks-page.tsx`,
    `apps/web/src/router.tsx`, `apps/web/src/lib/nav.ts`, `apps/web/package.json`, `pnpm-lock.yaml`,
    `apps/web/e2e/{remote.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T002, T006 · **Mức**: vừa

- [ ] T015 [US1] Phát hành và đóng gói `hive`
  - `.goreleaser.yaml`: build thứ hai `hive` cùng archive và `checksums.txt`; `release.yml` kiểm `hive version`;
    `install.sh`/`install.ps1` cài cả hai; `internal/update` thay cả hai nguyên tử (thiếu `hive` trong gói cũ thì chỉ thay
    worker).
  - Desktop: `build-sidecar.ts` dựng `hive`, `tauri.conf.json` thêm `binaries/hive`, `verify-bundle.ts`; lệnh Rust "Cài
    lệnh hive vào PATH".
  - **Scope**: `worker/.goreleaser.yaml`, `.github/workflows/{release.yml,desktop.yml}`, `scripts/{install.sh,install.ps1}`,
    `worker/internal/update/{update.go,update_test.go,scripts_test.go}`,
    `apps/desktop/scripts/{build-sidecar.ts,verify-bundle.ts}`, `apps/desktop/src-tauri/{tauri.conf.json,src/lib.rs}`
  - **Phụ thuộc**: T012 · **Mức**: vừa

**Checkpoint**: `hive chat` chạy tại máy, phiên ghi lên hub, xem lại trên web; chưa có gì từ xa.

---

## Phase 3: User Story 2 — Bật từ xa và ghép điện thoại (P1) 🎯 MVP

- [ ] T020 [US2] Worker: bật/tắt, thư mục, ghép, thiết bị
  - Thao tác socket nội bộ `remote.*`, `watch`; `term_state` sau `welcome` và khi đổi; nhận `term_pair` (kiểm tag, hỏi
    xác nhận qua `watch`, lưu, `term_pair_result`), `term_disable`, `term_device_revoke`; từ chối bật ở chế độ `host` và
    máy dùng chung; `owner` trong `welcome` khác `ownerUserId` → xoá thiết bị; `remote-audit.log` (JSON dòng, xoay 10 MB ×
    5).
  - Test: bật/tắt, root trùng/không tồn tại, ghép đủ ca (tag sai, hết hạn, người khác, từ chối), không có đường bật từ hub.
  - **Scope**: `worker/internal/terminal/{remote.go,pairing.go,audit.go,watch.go,remote_test.go,pairing_test.go}`
  - **Phụ thuộc**: T005, T011 · **Mức**: nặng

- [ ] T021 [US2] Hub: ghép, thiết bị, trạng thái từ xa
  - `pairing.ts` (`pairOptions`: tuỳ chọn WebAuthn, `pairComplete`: kiểm chủ máy/máy cá nhân/online → `term_pair`, chờ
    `term_pair_result`), `devices.ts` (`devices`, `revokeDevice` → `term_device_revoke`), `machine_remote_state` từ
    `term_state`, `disableRemote`; audit `terminal.pair|pair_denied|device_revoke|remote_enable|remote_disable|root_*`.
  - Test DB: người không phải chủ (`MACHINE_NOT_YOURS`), máy dùng chung, máy offline, audit; không có route bật.
  - **Scope**: `apps/hub/src/modules/terminal/{pairing.ts,devices.ts,state.ts,router.ts,index.ts,pairing.db.test.ts}`
  - **Phụ thuộc**: T013 · **Mức**: nặng

- [ ] T022 [US2] Web: ghép và thiết bị
  - `lib/terminal/webauthn.ts` (tạo passkey UV bắt buộc, `getPublicKey()`, đọc bí mật từ fragment rồi xoá khỏi URL, tính
    tag; lấy assertion với challenge chuẩn hoá từ contracts), `pair-page.tsx`, `devices-page.tsx`; trang báo "Cần hub chạy
    HTTPS" khi không phải secure context; trạng thái từ xa của máy trên `remote-page.tsx`.
  - Playwright với virtual authenticator: ghép thành công, mã hết hạn, người khác, HTTP.
  - **Scope**: `apps/web/src/lib/terminal/{webauthn.ts,webauthn.test.ts}`,
    `apps/web/src/pages/remote/{pair-page.tsx,devices-page.tsx,remote-page.tsx}`, `apps/web/src/router.tsx`,
    `apps/web/e2e/{remote-pair.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T014, T021 (hoặc hub giả), T006 · **Mức**: nặng

- [ ] T024 [US2] CLI `hive remote …`
  - `on` (hỏi xác nhận), `off`, `status`, `roots add|rm`, `devices [rm]`, `pair` (in QR trong terminal, chờ và hỏi
    Cho phép), `set`, `watch --json` (cho app; trả lời hộp xác nhận qua stdin JSON).
  - **Scope**: `worker/cmd/hive/{remote.go,remote_test.go,qr.go}`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: T012, T020 · **Mức**: vừa

- [ ] T023 [US2] [US5] Desktop: màn Điều khiển từ xa
  - `remote.rs`: sidecar `hive remote watch --json`, lệnh `remote_*` gọi `hive remote … --json`; cửa sổ xác nhận ghép và
    "Hỏi trên máy"; thông báo hệ điều hành; khay "Tắt điều khiển từ xa ngay" và chấm khi có người điều khiển từ xa.
  - `remote-screen.tsx`: công tắc (xác nhận lần hai), thư mục (chọn bằng hộp thoại thư mục), thiết bị + QR, tuỳ chọn,
    danh sách phiên + Ngắt + Ngắt tất cả; từ điển vi/en; capability chỉ cho cửa sổ cục bộ.
  - **Scope**: `apps/desktop/src/screens/{remote-screen.tsx,remote-screen.test.tsx,index.ts}`,
    `apps/desktop/src/shell/*` (mục AppNav), `apps/desktop/src-tauri/src/{remote.rs,tray_icon.rs,lib.rs}`,
    `apps/desktop/src-tauri/capabilities/*.json`, `apps/desktop/src-tauri/src/capabilities_audit.rs`
  - **Phụ thuộc**: T015 (cùng `lib.rs`, `tauri.conf.json`), T024 · **Mức**: vừa

**Checkpoint**: chủ máy bật từ xa và ghép được điện thoại; chưa điều khiển được.

---

## Phase 4: User Story 3 — Xem và điều khiển từ điện thoại (P1) 🎯 MVP

- [ ] T030 [US3] Hub: `/ws/terminal`
  - `ws.ts` (vé một lần 60 s qua route `ticket`, `Origin` bằng `HIVE_PUBLIC_URL`, mã đóng 4401/4403/4404/4429),
    `live.ts` (vòng đệm 512 KiB, người xem, chuyển `control`/`in`/`resize` tới worker chỉ cho kết nối của chủ máy, chuyển
    `term_granted`/`term_revoked`, nối lại theo offset, 512 KiB/s mỗi người xem, 2 MiB/s mỗi máy, đồng bộ lại khi đệm
    > 1 MiB, ping 20 s); gắn upgrade vào server ở `main.ts`; audit `attach|detach|control_*`.
  - Test DB/WS: vé dùng lại, sai Origin, người xem gửi nhập → 4403, nối lại không mất byte, client chậm, hub khởi động
    lại đọc từ DB.
  - **Scope**: `apps/hub/src/modules/terminal/{ws.ts,live.ts,ticket.ts,router.ts,index.ts,ws.db.test.ts,live.test.ts}`,
    `apps/hub/src/main.ts`
  - **Phụ thuộc**: T021 (cùng làn) · **Mức**: nặng

- [ ] T031 [US3] Worker: cấp quyền điều khiển
  - `term_control`: kiểm assertion (T005), ECDH, cấp quyền (thu của người cũ), resize theo người điều khiển; `term_input`
    và `term_resize` kiểm `seq` + HMAC (3 lỗi → thu quyền, `input_rejected`); `resumeToken` 2 phút; hết 15 phút không gõ
    → thu; terminal tại máy giành lại; dòng báo trên terminal tại máy.
  - Test: đủ ca của US3 kịch bản 2–6 với vector cố định.
  - **Scope**: `worker/internal/terminal/{control.go,control_test.go,session.go}`
  - **Phụ thuộc**: T020 (cùng làn), T005 · **Mức**: nặng

- [ ] T032 [US3] Web: màn terminal điều khiển trên điện thoại
  - `lib/terminal/ws-client.ts` (vé, `resume`, hàng đợi nhập, `visibilitychange`), `input-mac.ts` (ECDH, HKDF, HMAC bằng
    WebCrypto; khoá không xuất được, chỉ trong bộ nhớ), `keys.ts` (thanh phím, Ctrl giữ), ô soạn dòng (IME tiếng Việt),
    nút Điều khiển → passkey; cỡ chữ; tối thiểu 40 cột ở 360 px.
  - Playwright 360×740 với hub giả: điều khiển, Ctrl-C, ô soạn có dấu, mất mạng 10 s rồi nối lại không hỏi passkey, bị
    giành quyền.
  - **Scope**: `apps/web/src/lib/terminal/{ws-client.ts,ws-client.test.ts,input-mac.ts,input-mac.test.ts,keys.ts}`,
    `apps/web/src/components/{terminal-view.tsx,terminal-keys.tsx}`, `apps/web/src/pages/remote/session-page.tsx`,
    `apps/web/e2e/{remote-control.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T022 (cùng làn, `webauthn.ts`), T030 · **Mức**: nặng

---

## Phase 5: User Story 5 — Ngắt, giới hạn, audit (P1) 🎯 MVP

- [ ] T040 [US5] Worker: tắt khẩn cấp và giới hạn thời gian
  - Tắt từ xa: thu quyền, đóng người xem từ xa, kết thúc phiên mở từ xa (SIGHUP, 10 s, kill), giữ phiên tại máy, trong
    ≤ 2 s; `term_close`; phiên không client + không output 2 giờ; phiên từ xa quá 12 giờ; ghi `remote-audit.log` đủ mục.
  - **Scope**: `worker/internal/terminal/{limits.go,limits_test.go,remote.go,host.go}`
  - **Phụ thuộc**: T031 · **Mức**: vừa

- [ ] T041 [US5] Hub: ngắt, audit đủ, thông báo trong app
  - Route `close`, `disableRemote` tới mọi người xem; tắt từ xa → đóng WS của máy trong ≤ 2 s; hộp thư trong app có mục
    "Phiên … đang được điều khiển từ xa" (OPS-02); test đủ audit (SC-006).
  - **Scope**: `apps/hub/src/modules/terminal/{close.ts,router.ts,audit.db.test.ts}`
  - **Phụ thuộc**: T030 · **Mức**: vừa

**Checkpoint MVP**: US1 + US2 + US3 + US5 chạy sau cờ `HIVE_REMOTE_TERMINAL=1`; T091 (test tấn công) phải xanh trước khi
bật cờ trên hub thật.

---

## Phase 6: User Story 4 — Mở phiên mới từ điện thoại (P2)

- [ ] T050 [US4] Worker: `term_start`
  - Kiểm assertion; `rootId` + `subdir` (giải symlink, `ROOT_ESCAPE`, `ROOT_MISSING`); CLI có trên máy; tài khoản; model
    và mức quyền theo chính sách do hub gửi, không toàn quyền trừ khi `allowFullAccess` tại máy; "Hỏi trên máy" qua
    `watch` (60 s); `term_opened`/`term_denied`.
  - **Scope**: `worker/internal/terminal/{start.go,start_test.go}`
  - **Phụ thuộc**: T040 (cùng làn) · **Mức**: nặng

- [ ] T051 [US4] Hub: route `start`
  - Kiểm chủ máy, máy online có `terminal` và bật từ xa; gắn chính sách agent của tổ chức (model, mức quyền) vào
    `term_start`; theo dõi `requestId`, đổi `term_denied` thành lỗi tiếng Việt; audit `terminal.open|deny`.
  - **Scope**: `apps/hub/src/modules/terminal/{start.ts,router.ts,start.db.test.ts}`
  - **Phụ thuộc**: T041 (cùng làn) · **Mức**: vừa

- [ ] T052 [US4] Web: "Mở phiên mới"
  - `new-session-sheet.tsx`: CLI, tài khoản (Tự chọn), thư mục được phép + thư mục con, task, lời nhắc; passkey; vào phiên
    với quyền điều khiển; nút tắt khi chưa có thư mục.
  - **Scope**: `apps/web/src/pages/remote/{new-session-sheet.tsx,remote-page.tsx}`,
    `apps/web/e2e/{remote-start.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T032 (cùng làn), T051 · **Mức**: vừa

---

## Phase 7: User Story 6 — `hive attach` (P2)

- [ ] T060 [US6] CLI `hive attach`
  - Run: SSE `/api/v1/runs/:id/stream` với token cá nhân, nối lại theo `Last-Event-ID`, dòng nhập → `runs.steer`, in
    `steer_result`; phiên trên máy này: socket nội bộ; phiên máy khác: vé `view` + `/ws/terminal`, chỉ xem.
  - **Scope**: `worker/cmd/hive/{attach.go,attach_test.go,sse.go,hubws.go}`
  - **Phụ thuộc**: T024 (cùng làn), T030 · **Mức**: vừa

---

## Phase 8: User Story 7 — PWA và thông báo đẩy (P2)

- [ ] T070 [US7] Web: PWA
  - `vite-plugin-pwa` (`injectManifest`), manifest, icon 192/512/maskable, `sw.ts` (chỉ đệm vỏ ứng dụng; `push`,
    `notificationclick`), nút cài và hướng dẫn iOS, bật/tắt thông báo (`lib/terminal/push.ts`).
  - Playwright: manifest hợp lệ, service worker đăng ký, push giả mở đúng URL.
  - **Scope**: `apps/web/vite.config.ts`, `apps/web/src/sw.ts`, `apps/web/public/icons/**`, `apps/web/index.html`,
    `apps/web/src/lib/terminal/push.ts`, `apps/web/src/pages/remote/remote-page.tsx`, `apps/web/package.json`,
    `pnpm-lock.yaml`, `apps/web/e2e/pwa.spec.ts`
  - **Phụ thuộc**: T052 (cùng làn) · **Mức**: vừa

- [ ] T071 [US7] Hub: Web Push
  - `push.ts`: khoá VAPID sinh lần đầu, mã hoá bằng khoá chủ; route `pushKey|pushSubscribe|pushUnsubscribe`; gửi khi
    `term_event{attention|idle}`, `term_exit`, phiên mở từ xa; xoá subscription hết hạn (404/410); nội dung không có
    output.
  - **Scope**: `apps/hub/src/modules/terminal/{push.ts,push.db.test.ts,gateway.ts,router.ts}`, `apps/hub/package.json`,
    `pnpm-lock.yaml`
  - **Phụ thuộc**: T051 (cùng làn) · **Mức**: vừa

- [ ] T072 [US7] Worker: tín hiệu "agent cần bạn"
  - Claude tương tác: file settings tạm với hook `Notification` (+ `Stop`) gọi `hive __hook attention`, ghép với hook
    quản lý của tổ chức như `runner/hooks.go`; CLI khác: im 60 s sau output → `idle`; gửi `term_event`.
  - **Scope**: `worker/internal/terminal/{attention.go,attention_test.go}`
  - **Phụ thuộc**: T050 (cùng làn) · **Mức**: vừa

---

## Phase 9: User Story 8 — Xem cùng (P3)

- [ ] T080 [US8] Hub: chế độ xem `team`
  - Quyền xem cho thành viên đội / người xem run của dự án; đóng người xem khác khi tắt; giới hạn số người xem; danh sách
    người đang xem cho chủ.
  - **Scope**: `apps/hub/src/modules/terminal/{queries.ts,live.ts,visibility.db.test.ts}`
  - **Phụ thuộc**: T071 (cùng làn) · **Mức**: vừa

- [ ] T081 [US8] Web: nút "Cho đội xem" và danh sách người xem
  - **Scope**: `apps/web/src/pages/remote/session-page.tsx`, `apps/web/e2e/{remote-share.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T070 (cùng làn), T080 · **Mức**: nhẹ

---

## Phase 10: Kiểm và tài liệu

- [ ] T090 e2e và hiệu năng
  - `scripts/e2e-remote.ts`: hub thật + worker thật + CLI giả + Chromium (virtual authenticator, mạng trễ 50 ms mỗi
    chặng); đo SC-002, SC-003, SC-004, SC-005; test hiệu năng SC-008 (50 phiên × 3 người xem).
  - **Scope**: `scripts/e2e-remote.ts`, `apps/hub/src/terminal-perf.db.test.ts`, `.github/workflows/ci.yml` (job tuỳ chọn)
  - **Phụ thuộc**: T041, T032, T040 · **Mức**: nặng

- [ ] T091 Bộ test tấn công (SC-001) và review bảo mật
  - Worker: assertion giả/phát lại/lệch giờ/sai origin/thiếu UV/khoá lạ, tag ghép sai, gói nhập không HMAC hoặc `seq`
    lùi, `term_start` khi tắt, `subdir` thoát, gói bật/ghép giả từ hub. Hub: người khác, máy dùng chung, vé dùng lại, sai
    Origin, người xem gửi nhập. Chạy `/security-review`; ghi kết quả vào PR.
  - **Scope**: `worker/internal/terminal/attack_test.go`, `apps/hub/src/terminal-attack.db.test.ts`
  - **Phụ thuộc**: T040, T041 cho MVP; thêm các ca `term_start` khi T050, T051 xong (cùng agent hoặc lượt hai) ·
    **Mức**: nặng

- [ ] T092 [P] Tài liệu
  - `docs/architecture.md` (module `terminal`, bảng gói ở mục 5, token, rủi ro), `docs/add.md`, `docs/sdd.md`, trạng thái
    RMT-xx/IF-07/NFR-17 trong `docs/srs.md`; hướng dẫn người dùng `docs/hive-cli.md` (cài, đăng nhập, chat, attach, bật
    từ xa, ghép, tắt khẩn cấp).
  - **Scope**: `docs/{architecture.md,add.md,sdd.md,srs.md,hive-cli.md}`
  - **Phụ thuộc**: T090 · **Mức**: nhẹ

- [ ] T093 `/speckit-analyze` trên spec, plan, tasks; xử lý mâu thuẫn; chụp màn mới (sáng, tối, 360 px).
  - **Scope**: `specs/010-hive-cli-remote/*`, `apps/web/e2e/screenshots/**`
  - **Phụ thuộc**: T081, T023 · **Mức**: nhẹ

---

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┬─ T013 ─ T021 ─ T030 ─ T041 ─ T051 ─ T071 ─ T080      (hub)
      │        ├─ T014 ─ T022 ─ T032 ─ T052 ─ T070 ─ T081             (web; T022 cần T021, T032 cần T030, T052 cần T051)
      │        └─ T012 ─ T024 ─ T060                                 (cli; T012 cần T011, T024 cần T020, T060 cần T030)
      ├─ T005 ─────────────┐
      ├─ T007 ─ (T013)     │
      └─ T010 ─ T011 ─ T020 ─ T031 ─ T040 ─ T050 ─ T072              (worker)
T003, T004 ─ T011
T006 ─ T014, T022
T012 ─ T015 ─ T023 (cần T024)                                        (phát hành, desktop)
T040, T041, T032 ─ T090 ─ T092
T040, T041 ─ T091 (lượt hai sau T050, T051)
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T003, T004, T006 |
| 2 | T002, T005, T007, T010 |
| 3 | T011, T013, T014 |
| 4 | T012, T020, T021 |
| 5 | T015, T022, T024, T030, T031 |
| 6 | T023, T032, T040, T041 |
| 7 | T050, T051, T060, T091 (lượt MVP) |
| 8 | T052, T071, T072, T091 (lượt `term_start`) |
| 9 | T070, T080, T090 |
| 10 | T081, T092, T093 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002 | `packages/contracts/**`, `openapi.json` |
| db | T007 | `migrations/**`, `terminal/schema.ts` |
| worker-pty | T003 | `worker/internal/pty/**`, `go.mod` |
| worker-ipc | T004 | `worker/internal/localipc/**` |
| worker-auth | T005 | `worker/internal/remoteauth/**` |
| worker-channel | T010 | `worker/internal/channel/**`, `terminal/handler.go` |
| worker-terminal | T011 → T020 → T031 → T040 → T050 → T072 | `worker/internal/terminal/**`, `accounts.go`, `cmd/hive-worker/main.go` |
| cli | T012 → T024 → T060 | `worker/cmd/hive/**`, `go.mod` |
| release-desktop | T015 → T023 | `.goreleaser.yaml`, `release.yml`, `install.*`, `internal/update/**`, `apps/desktop/**` |
| hub-terminal | T013 → T021 → T030 → T041 → T051 → T071 → T080 | `modules/terminal/{router.ts,index.ts,gateway.ts,live.ts}`, `fleet/gateway.ts`, `main.ts`, `app.ts` |
| web | T014 → T022 → T032 → T052 → T070 → T081 | `apps/web/e2e/fake-hub.ts`, `router.tsx`, `pages/remote/**`, `package.json` |
| design | T006 | `docs/design-system/screens/**` |
| verify | T090 | `scripts/e2e-remote.ts`, `ci.yml` |
| security | T091 | `attack_test.go`, `terminal-attack.db.test.ts` (file mới, không chung với làn khác) |
| docs | T092 → T093 | `docs/**`, `specs/010-hive-cli-remote/*` |

`go.mod`/`go.sum` bị T003, T012, T024 sửa (thêm thư viện): T003 thêm `go-pty`; T012 thêm `go-keyring`, `x/term`; T024
thêm thư viện QR. Ba task ở ba đợt khác nhau; nếu chạy chồng thì người điều phối gộp `go.mod` lúc merge (xung đột chỉ ở
khối `require`).

## Implementation Strategy

- **MVP** (US1 + US2 + US3 + US5, sau cờ `HIVE_REMOTE_TERMINAL`): T001–T007, T010–T015, T020–T024, T030–T032, T040,
  T041, T091. Đủ để: `hive chat` tại máy, xem lại trên web, bật từ xa và ghép điện thoại tại máy, mở phiên đang chạy trên
  điện thoại và gõ trả lời, tắt khẩn cấp, audit hai nơi. Chưa có PWA/đẩy: dev mở web trên trình duyệt điện thoại.
- **Tăng dần**: T050–T052 (mở phiên từ điện thoại) → T060 (`hive attach`) → T070–T072 (PWA, thông báo) → T080–T081 (xem
  cùng) → T090, T092, T093.
- Phần US1 (ghi phiên) phát hành được trước mà không có gì từ xa; mọi gói mới được bảo vệ bằng thoả thuận khả năng, nên
  merge từng phần không ảnh hưởng run đang chạy (SC-010).
