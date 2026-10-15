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

- [x] T001 Contract giao thức worker và xác thực từ xa
  - Đã làm (SPEC10NEXT): gói `term_*` mới nằm cạnh gói của lát đầu (T100): `term_input`/`term_resize` thêm `connId`,
    `seq`, `mac` tuỳ chọn thay vì gói riêng; `term_output` giữ `{seq, data}` của lát đầu (không `offset, bytes`);
    `term_opened` thêm `origin`, `requestId`, `cli`, `cwdLabel`, … tuỳ chọn. Tag ghép và HMAC gói nhập tính trên JSON chuẩn
    hoá (`pairTagPayload`, `inputMacPayload`, có `pairId`/`sessionId`/`kind`) thay cho nối thẳng byte, để ranh giới
    trường không mơ hồ. Vector sinh bằng WebCrypto (`pnpm --filter @xdev-hive/contracts vectors:terminal-auth`), chưa có
    assertion từ virtual authenticator thật (để T022).
  - `worker-protocol.ts`: mọi gói `term_*` theo bảng ở plan.md; `welcome.features?`, `welcome.owner?`; enum
    `termEventKind`, `termDenyCode`; thêm vào `workerToHub`/`hubToWorker`. Không đổi `PROTOCOL_VERSION`.
  - `terminal-auth.ts`: `canonicalChallenge(input)` (khoá theo thứ tự, NFC), kiểu `RemoteAuth`, `pairTag` input,
    `inputMacPayload(connId, seq, data)`; `auth` là union `passkey | totp` (`{kind: "totp", code, ephPub, ts, nonce}`);
    `welcome.policy?.totpFallback`, `term_state.totp`; mã từ chối `TOTP_*`.
  - Fixture: thêm mẫu mọi gói vào `worker-protocol.json`; `terminal-auth.json` mới với vector sinh bằng WebCrypto trong test
    (khoá ES256, authenticatorData, clientDataJSON, chữ ký đúng/sai origin/thiếu UV/phát lại; ECDH + HKDF + HMAC; tag
    ghép).
  - Test: `worker-protocol.test.ts` (gói cũ vẫn parse; gói mới parse; hub cũ không có `features` vẫn hợp lệ),
    `terminal-auth.test.ts` (chuẩn hoá ổn định, vector khớp).
  - **Scope**: `packages/contracts/src/{worker-protocol.ts,worker-protocol.test.ts,terminal-auth.ts,terminal-auth.test.ts}`,
    `packages/contracts/fixtures/{worker-protocol.json,terminal-auth.json}`, `packages/contracts/scripts/*` nếu cần sinh
    vector
  - **Phụ thuộc**: không · **Mức**: nặng

- [x] T002 Contract API `terminal.*` và đăng nhập CLI
  - Đã làm (SPEC10W3): route phiên máy cá nhân nằm ở contract `remote` (`/v1/remote/…`), không gộp vào `terminal` của
    phiên Leader để không nới quyền bên nào; khung WS `remoteClientFrame`/`remoteServerFrame`; `REMOTE_LIMITS`,
    `remoteErrors`, `REMOTE_AUDIT_ACTIONS`. `desktop-connect`: `purpose: "desktop" | "cli"`, output là union theo
    `purpose`. `notify`: ba sự kiện `terminal.*` chỉ cho hộp thư/đẩy của chủ máy (`notificationChannelEvent` loại chúng
    khỏi kênh tổ chức). Chính sách: `remote.totpFallback` (mặc định bật; lưu chính sách từ client cũ giữ giá trị cũ).
  - `terminal.ts`: kiểu phiên, máy (trạng thái từ xa), thiết bị, route ở plan.md (`machines`, `list`, `get`, `chunks`,
    `ticket`, `start`, `close`, `setVisibility`, `disableRemote`, `pairOptions`, `pairComplete`, `devices`,
    `revokeDevice`, `pushKey`, `pushSubscribe`, `pushUnsubscribe`); khung WS trình duyệt (`resume`, `control`, `in`,
    `resize`, `granted`, `revoked`, `state`, `sync`) với giới hạn cỡ; mã lỗi và thông báo tiếng Việt.
  - `desktop-connect.ts`: `purpose: "desktop" | "cli"` (mặc định `desktop`), output cho `cli` không có mã đăng ký máy.
  - TOTP: trạng thái `totp` của máy, lỗi `TOTP_*` (tiếng Việt), `totpFallback` trong chính sách agent của tổ chức (hub
    đọc qua `index.ts` của module chính sách), loại audit `terminal.totp_*`.
  - `notify.ts`: loại sự kiện `terminal.remote_session`, `terminal.attention`, `terminal.exit` cho hộp thư và đẩy.
  - `index.ts` gắn contract; `pnpm openapi`.
  - **Scope**: `packages/contracts/src/{terminal.ts,terminal.test.ts,desktop-connect.ts,notify.ts,index.ts}`,
    `packages/contracts/openapi.json`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T003 [P] Worker: gói PTY
  - Đã làm (SPEC10W5): ConPTY gọi thẳng `x/sys/windows` (không thêm `go-pty`: `creack/pty` đã chạy Unix từ T101).
    `Start` trả `pty.Terminal` (`Read`, `Write`, `Close`, `Resize`) trên mọi hệ điều hành; Windows: `CreateProcess` với
    pseudo console, stdio không kế thừa từ worker, job `KILL_ON_JOB_CLOSE` cho `KillGroup` cả cây, `HangupGroup` đóng
    console (CTRL_CLOSE_EVENT), tiến trình thoát thì đóng console để `Read` nhận EOF; `Supported` dò
    `CreatePseudoConsole`. Test Windows dùng chính file test làm CLI giả: echo, resize, mã thoát, 10 MB output, kill
    cây, hangup. Bên gọi (`accounts`, `terminal`) đổi sang `Terminal.Resize`.
  - `internal/pty`: bọc `aymanbagabas/go-pty` (Unix + ConPTY): `Start(cmd, env, dir, cols, rows)`, `Resize`, `Read`,
    `Write`, `Signal(hup|int|kill)`, `Wait`; nhóm tiến trình để kill cả cây.
  - Test với CLI giả (Go test binary): echo, output 10 MB, resize, thoát mã khác 0, kill cây; CI Windows chạy test ConPTY.
  - **Scope**: `worker/internal/pty/**`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: không · **Mức**: nặng

- [x] T004 [P] Worker: socket nội bộ
  - Một phần (SPEC10NEXT): Unix socket (`HIVE_SOCKET` ghi đè đường dẫn), kiểm UID bằng `SO_PEERCRED`/`LOCAL_PEERCRED`,
    dọn socket cũ, bắt tay, khung nhị phân, test đủ ca.
  - Đã làm (SPEC10W5): Windows named pipe `\\.\pipe\xdev-hive-<SID>` qua `go-winio` (đường dẫn file như `HIVE_SOCKET`
    được băm ra tên pipe), DACL được bảo vệ chỉ SID hiện tại, tạo lần đầu bằng `FILE_CREATE` nên pipe đã có thì
    `ErrInUse`; server kiểm SID client (`GetNamedPipeClientProcessId`), client kiểm SID tiến trình giữ pipe
    (`GetNamedPipeServerProcessId`) để chặn người khác giữ trước tên pipe. Test chung chạy cả Unix lẫn Windows
    (`server_test.go`), riêng Windows: tên pipe, SDDL, pipe đang dùng, mở lại sau khi đóng. Bỏ `ErrUnsupported`.
  - `internal/localipc`: server/client; Unix socket 0600 trong thư mục 0700, kiểm UID bằng `SO_PEERCRED`
    (Linux) / `LOCAL_PEERCRED` (macOS); Windows named pipe với DACL chỉ SID hiện tại và kiểm SID client; bắt tay phiên
    bản; yêu cầu JSON một dòng; chuyển sang khung nhị phân `[loại u8][độ dài u32][dữ liệu]` sau `attach`.
  - Test: bắt tay, lệch phiên bản, quyền file, UID khác bị từ chối (qua interface kiểm peer giả), khung lớn, đóng đột ngột.
  - **Scope**: `worker/internal/localipc/**`
  - **Phụ thuộc**: không · **Mức**: nặng

- [x] T005 [P] Worker: `internal/remoteauth`
  - Đã làm (SPEC10NEXT): `canonical.go` (NFC bằng `golang.org/x/text`, đã có trong go.sum), `webauthn.go`, `config.go`
    (`Store`, ghi nguyên tử có fsync), `pairing.go`, `inputkey.go`, `verify.go` (`Verifier.VerifyAuth`), test đọc
    `terminal-auth.json` (16 ca assertion, ghép, ECDH/HKDF/HMAC).
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

- [x] T006 [P] Thiết kế UI bằng skill `ui-ux-pro-max`, theo design system và shadcn/ui: web điện thoại (danh sách máy và
  phiên, terminal với thanh phím và ô soạn, mở phiên mới, ghép, thiết bị, hướng dẫn cài PWA) và màn app desktop Điều khiển
  từ xa (công tắc, thư mục, thiết bị + QR, phiên, hộp xác nhận); 360 px, sáng/tối.
  - **Scope**: `docs/design-system/screens/{Remote.dc.html,AppRemote.dc.html}` (mới), `docs/design-system/screens/README.md`
  - Đã làm (SPEC10W5): hai màn có trạng thái `view`, vi/en, sáng/tối, 360 px, chạm 44 px; bàn giao trong README (chưa
    đưa lên canvas).
  - **Phụ thuộc**: không · **Mức**: vừa

- [x] T007 Bảng và migration module `terminal`
  - Đã làm (SPEC10W3): migration `0071_remote_terminal.sql`. `terminal_sessions` (đã có từ T103) thêm `origin`
    (`hub|local|remote`), `task_id`, `cwd_label`, `remote`, `request_id`; `project_id`/`mode`/`model` thành nullable,
    ràng buộc `terminal_sessions_hub_fields` giữ chúng bắt buộc với phiên Leader. `terminal_chunks` giữ khoá `(session,
    seq)` của lát đầu (không `offset`). Bốn bảng mới ép RLS; `remote_devices` khoá `(machine_id, id)` vì id do worker sinh.
    `hive.purge_terminal_chunks()` chạy cùng job `runs-log-retention`. Không có `ALTER TYPE` nên không thêm ca nâng cấp.
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

- [x] T008 [US2] Worker: TOTP trong `remoteauth`
  - Đã làm (SPEC10NEXT): `TOTPStore.Enable|Disable|Unlock|Verify|Status`, `TOTPURI`; đường TOTP không có thiết bị ghép
    (trang HTTP không tạo được passkey) nên worker chỉ nhận `userId` = chủ máy (`Policy.OwnerUserID`); yêu cầu bị chính
    sách chặn không tăng bộ đếm sai. Khoá nằm trong `totp.json` 0600, chưa dùng keychain.
  - `totp.go`: RFC 6238 (SHA-1, 6 số, 30 giây, ±1 bước) bằng thư viện chuẩn; `totp.json` (0600, nguyên tử) giữ `secret`,
    `lastStep`, `failures`, `lockedUntil`, `lockLevel`; ghi ra đĩa trước khi trả kết quả; `VerifyAuth` chung cho
    `kind: passkey|totp` (từ chối `TOTP_LOCKED`, `TOTP_INVALID`, `TOTP_REPLAY`); khoá 5 lần sai → 5 phút gấp đôi tối đa
    1 giờ; chỉ nhận `totp` khi URL hub là `http://` (hoặc chủ máy bật riêng) và `policy.totpFallback != false`; HKDF trộn
    mã vào `info` cho khoá phiên.
  - Test: vector RFC 6238 (Phụ lục B), lệch ±1 bước, mã dùng lại, khởi động lại giữ `lastStep` và bộ đếm, khoá và gấp
    đôi, mở khoá, hub HTTPS từ chối TOTP, chính sách tắt, so sánh hằng thời gian.
  - **Scope**: `worker/internal/remoteauth/{totp.go,totp_test.go,verify.go,verify_test.go}`
  - **Phụ thuộc**: T001, T005 (cùng làn) · **Mức**: nặng

- [x] T010 [US1] Worker: kiểu gói `term_*` và chuyển gói
  - Đã làm (SPEC10NEXT, SPEC10W3): kiểu Go mọi gói mới trong `protocol.go` + test fixture; `channel.go` khai `terminal`
    khi có `Config.Terminal`, chuyển `welcome.features/owner/policy` và gói H→W (`term_input/resize` chỉ khi có
    `connId`) tới `terminal.Handler`; `Sender` gắn với ctx của phiên, hub không khai `terminal` thì trả
    `ErrHubNoTerminal` và không ghi gì. `cmd/hive-worker` chưa nối Handler (T011).
  - `protocol.go`: kiểu Go cho mọi gói mới; test đọc fixture dùng chung.
  - `channel.go`: khai `terminal` trong `hello.capabilities`; đọc `welcome.features`/`owner`; chỉ gửi `term_*` khi hub
    khai; chuyển gói H→W `term_*` tới `terminal.Handler` (interface mới trong `internal/terminal/handler.go`); hàm gửi
    `term_*` cho handler dùng.
  - Test: hub giả không có `features` → không có gói `term_*` (SC-010); `worker_e2e_test.go` cũ xanh không sửa.
  - **Scope**: `worker/internal/channel/{protocol.go,protocol_test.go,channel.go,channel_test.go}`,
    `worker/internal/terminal/handler.go`
  - **Phụ thuộc**: T001 · **Mức**: vừa

- [x] T011 [US1] Worker: session host
  - Một phần (SPEC10NEXT): `terminal/local.go` (phiên tại máy qua socket, một người điều khiển + người xem, tách/gắn lại
    phát đuôi 256 KiB, kill, che bí mật, tối đa 8 phiên), `runner/localenv.go`, `accounts.AcquireInteractiveForce`,
    `cmd/hive-worker/local.go`.
  - Đã làm (SPEC10W4): `terminal/record.go` — `Recorder` là Handler của kênh: gom 8 ms/32 KiB → `term_output`, đệm đĩa
    `terminal/<id>.pending` (một file mỗi phiên, 32 MB, quá thì `gap`; dời phần đã ack khi phiên in liên tục), xoá khi
    `term_ack`; `term_opened` (`origin: local`, nhãn thư mục hai cấp cuối, không đường dẫn tuyệt đối), `term_exit`,
    `term_state` (danh sách phiên); mất hub thì gửi bù sau welcome; máy dùng chung hoặc hub không khai `terminal` thì bỏ
    đệm và không ghi. Yêu cầu từ xa (start/control/pair) trả `REMOTE_DISABLED` tới khi có T020/T031/T050.
    `hive chat --no-record` truyền tới worker; `session.list` có `hubId`.
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

- [x] T012 [US1] CLI `hive`: đăng nhập, chat/run, ls, kill
  - Một phần (SPEC10NEXT): `chat`, `run`, `ls [--json]`, `attach [--view]`, `kill`, `version`, phím Ctrl-] d/t, raw
    mode, SIGWINCH, mã thoát.
  - Đã làm (SPEC10W4): `login` (loopback PKCE `purpose: cli`, `--with-token` đọc stdin, `--no-browser`, `--hub`/
    `HIVE_HUB_URL`/hub của worker), keychain `zalando/go-keyring` cùng mục với app desktop (`dev.xdev.hive`/URL hub;
    không có keychain thì `hive.json` 0600 + cảnh báo), `logout`, `whoami`; `--task`/`--project` tra hub bằng token cá
    nhân rồi gửi id cho worker; `ls --all` (phiên đang chạy trên mọi máy, từ `remote.list`); `--no-record`.
    **Còn**: `__hook` (làm cùng T072), `--escape`.
  - Đã làm (SPEC10W5): `--escape KEY` cho `chat`, `run`, `attach` (`ctrl-<phím>`, `^<phím>`, `none`; từ chối Esc/Tab/
    Enter/Backspace vì agent cần; dòng hướng dẫn in theo phím đang dùng). `__hook` chuyển sang T072 (cần tín hiệu của
    worker).
  - `cmd/hive`: `login` (loopback PKCE `purpose: cli`, `--with-token`), keychain (`dev.xdev.hive`/URL hub; không có thì
    file 0600 + cảnh báo), `logout`, `whoami`; `chat`/`run` (raw mode bằng `x/term`, SIGWINCH/console resize, phím tách
    và giành quyền, khôi phục terminal), `--task`/`--project` tra hub bằng token cá nhân; `ls`, `kill`, `version`;
    `__hook` (gửi tới worker qua socket); mã thoát theo plan.md; mọi thông báo tiếng Việt.
  - Test: phân tích cờ, mã thoát, worker vắng, lệch phiên bản, luồng login với hub giả, raw mode qua pty giả.
  - **Scope**: `worker/cmd/hive/**`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: T002, T004, T011 · **Mức**: nặng

- [x] T013 [US1] Hub: module `terminal` lõi
  - Đã làm (SPEC10W3): `record.ts` (worker mở phiên trước rồi báo `term_opened` có `origin`; hub chỉ ghi phiên của máy
    cá nhân, chủ phiên là người đăng ký máy, tối đa `REMOTE_LIMITS.recordedSessionsPerMachine`; task/dự án đội khác bị bỏ
    liên kết; `term_event` vào `terminal_events`; `term_ack` sau mỗi lần ghi, kể cả phiên hub không ghi, và không bao giờ
    `term_close` phiên máy cá nhân), `queries.ts` + `remoteRouter` (`remote.machines|list|get|chunks|setVisibility`).
    `fleet/gateway.ts`: hook `welcome` của module terminal → `features: ["terminal"]`, `owner`, `policy.totpFallback`
    cho máy cá nhân có capability `terminal`; máy dùng chung chỉ nhận `owner.shared`. Máy mất kết nối không kết thúc phiên
    máy cá nhân (worker gửi bù). `desktop-connect` `purpose: cli` + trang đồng ý trên web. Purge bản ghi cùng job
    `runs-log-retention`. **Khác plan**: chưa gộp chunk 64 KiB/1 s ở hub (ghi từng gói; worker đã gộp 8 ms/32 KiB) — đo ở
    T090 rồi mới làm nếu cần.
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

- [x] T014 [P] [US1] Web: danh sách phiên và phát lại bản ghi
  - Đã làm (SPEC10W5): `/remote` (máy của tôi với trạng thái từ xa, phiên đang chạy trước), `/remote/$id` phát lại qua
    `remote.chunks` bằng `TerminalView` sẵn có (`live={false}`, chỉ đọc; phiên đang chạy hỏi lại mỗi 5 giây), mục
    "Phiên tương tác" trên bảng việc (chỉ hiện khi có phiên), menu "Điều khiển từ xa". Thêm `pages/remote/session-row.tsx`
    dùng chung. Không thêm gói npm. Playwright `remote.spec.ts`: danh sách, phát lại, 360 px sáng/tối, tiếng Anh.
  - `components/terminal-view.tsx` (xterm.js + fit, chỉ đọc, tải lười, tắt OSC 52, link cần xác nhận), `pages/remote/`
    `remote-page.tsx` (máy của tôi, phiên), `session-page.tsx` chế độ phát lại (đọc `chunks` theo trang), mục "Phiên
    tương tác" trên trang task; mục menu "Điều khiển từ xa".
  - Playwright với hub giả: danh sách, phát lại, 360 px, tối.
  - **Scope**: `apps/web/src/components/terminal-view.tsx`, `apps/web/src/pages/remote/{remote-page.tsx,session-page.tsx}`,
    `apps/web/src/lib/terminal/{sessions.ts,sessions.test.ts}`, `apps/web/src/pages/tasks-page.tsx`,
    `apps/web/src/router.tsx`, `apps/web/src/lib/nav.ts`, `apps/web/package.json`, `pnpm-lock.yaml`,
    `apps/web/e2e/{remote.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T002, T006 · **Mức**: vừa

- [x] T015 [US1] Phát hành và đóng gói `hive`
  - `.goreleaser.yaml`: build thứ hai `hive` cùng archive và `checksums.txt`; `release.yml` kiểm `hive version`;
    `install.sh`/`install.ps1` cài cả hai; `internal/update` thay cả hai nguyên tử (thiếu `hive` trong gói cũ thì chỉ thay
    worker).
  - Desktop: `build-sidecar.ts` dựng `hive`, `tauri.conf.json` thêm `binaries/hive`, `verify-bundle.ts`; lệnh Rust "Cài
    lệnh hive vào PATH".
  - **Scope**: `worker/.goreleaser.yaml`, `.github/workflows/{release.yml,desktop.yml}`, `scripts/{install.sh,install.ps1}`,
    `worker/internal/update/{update.go,update_test.go,scripts_test.go}`,
    `apps/desktop/scripts/{build-sidecar.ts,verify-bundle.ts}`, `apps/desktop/src-tauri/{tauri.conf.json,src/lib.rs}`
  - **Phụ thuộc**: T012 · **Mức**: vừa
  - Đã làm (SPEC10W6): goreleaser build `hive` cùng archive; `release.yml` kiểm `hive version`; install.sh/install.ps1
    cài cả hai; `update.InstallAll` chạy thử `version` từng file, thay `hive` rồi worker, lỗi thì trả bản cũ (gói cũ
    không có `hive` thì chỉ thay worker). Desktop: sidecar `binaries/hive`, `verify-bundle.ts` kiểm, `hive_cli.rs`
    (`hive_cli_status`, `hive_cli_install`: symlink `~/.local/bin/hive`; Windows chép vào `%LOCALAPPDATA%\xdev-hive\bin`
    và thêm PATH người dùng). Chưa thử install.ps1 trên PowerShell thật và nhánh Windows của `hive_cli.rs`.

**Checkpoint**: `hive chat` chạy tại máy, phiên ghi lên hub, xem lại trên web; chưa có gì từ xa.

---

## Phase 3: User Story 2 — Bật từ xa và ghép điện thoại (P1) 🎯 MVP

- [x] T020 [US2] Worker: bật/tắt, thư mục, ghép, thiết bị
  - Đã làm (SPEC10W4): `terminal.Remote` (`remote.go`: `remote.status|enable|disable|roots.add|roots.remove|
    devices.remove|settings`; root phải là thư mục tuyệt đối có thật, lưu dạng đã giải symlink, trùng/cả ổ đĩa bị từ
    chối, tối đa 32; `term_state` chỉ có nhãn), `pairing.go` (`remote.pair.begin` trả `pairId`, bí mật và URL QR
    `…/remote/pair?m=<tên máy>&p=<pairId>#s=<bí mật>` — `m` là tên máy trong hello, web (T022) tra ra id; term_pair kiểm
    tag, chủ máy theo welcome, hỏi qua `watch`, chờ 50 s, `remote.pair.decide`; ghép lại cùng passkey thay bản cũ),
    `watch.go` (trạng thái rồi sự kiện `state|pair_request|pair_done`, nhận `remote.pair.decide` trên cùng kết nối, phát
    lại yêu cầu đang chờ), `audit.go` (`remote-audit.log` cạnh worker.json, 0600, xoay 10 MB × 5). `Recorder` chuyển
    `term_pair|term_disable|term_device_revoke` cho `Remote`, gửi `term_state` mỗi khi đổi. welcome máy dùng chung → tắt;
    đổi chủ → xoá thiết bị. Runner host không mở socket nội bộ nên không có đường bật. Kết thúc phiên từ xa khi tắt để T040.
  - Thao tác socket nội bộ `remote.*`, `watch`; `term_state` sau `welcome` và khi đổi; nhận `term_pair` (kiểm tag, hỏi
    xác nhận qua `watch`, lưu, `term_pair_result`), `term_disable`, `term_device_revoke`; từ chối bật ở chế độ `host` và
    máy dùng chung; `owner` trong `welcome` khác `ownerUserId` → xoá thiết bị; `remote-audit.log` (JSON dòng, xoay 10 MB ×
    5).
  - Test: bật/tắt, root trùng/không tồn tại, ghép đủ ca (tag sai, hết hạn, người khác, từ chối), không có đường bật từ hub.
  - **Scope**: `worker/internal/terminal/{remote.go,pairing.go,audit.go,watch.go,remote_test.go,pairing_test.go}`
  - **Phụ thuộc**: T005, T011 · **Mức**: nặng

- [x] T021 [US2] Hub: ghép, thiết bị, trạng thái từ xa
  - Đã làm (SPEC10W4): `state.ts` (`term_state` → `machine_remote_state` + `remote_devices`, audit nguồn máy cho bật/tắt,
    thư mục, thiết bị máy thôi báo; phiên hub còn "đang chạy" mà máy không còn giữ thì kết thúc), `pairing.ts`
    (`pairOptions` rp = host `HIVE_PUBLIC_URL`; `pairComplete` không giữ transaction trong lúc chờ máy, mã ghép đang chờ
    thì không nhận lần hai), `devices.ts` (`devices`, `revokeDevice` cần máy online vì quyền nằm ở máy, `disableRemote`
    cho chủ máy hoặc quản trị đội). Cờ `HIVE_REMOTE_TERMINAL` chỉ chặn ghép; gỡ và tắt khẩn cấp luôn chạy.
    `excludeCredentials` để trống vì hub không giữ id passkey. `fleet/gateway.ts` chuyển `term_state`/`term_pair_result`.
  - `pairing.ts` (`pairOptions`: tuỳ chọn WebAuthn, `pairComplete`: kiểm chủ máy/máy cá nhân/online → `term_pair`, chờ
    `term_pair_result`), `devices.ts` (`devices`, `revokeDevice` → `term_device_revoke`), `machine_remote_state` từ
    `term_state`, `disableRemote`; audit `terminal.pair|pair_denied|device_revoke|remote_enable|remote_disable|root_*`.
  - Test DB: người không phải chủ (`MACHINE_NOT_YOURS`), máy dùng chung, máy offline, audit; không có route bật.
  - **Scope**: `apps/hub/src/modules/terminal/{pairing.ts,devices.ts,state.ts,router.ts,index.ts,pairing.db.test.ts}`
  - **Phụ thuộc**: T013 · **Mức**: nặng

- [x] T022 [US2] Web: ghép và thiết bị
  - Đã làm (SPEC10W6): `webauthn.ts` (đọc bí mật `#s=` rồi xoá khỏi URL bằng `history.replaceState`, chưa đăng nhập thì
    `stashPairSecret` cất vào sessionStorage để `?redirect=` không mang bí mật; `createPasskey` bắt UV và đọc
    `getPublicKey()`, `pairProof` tính tag HMAC, `getAssertion` dùng challenge chuẩn hoá từ contracts; nhớ thiết bị đã
    ghép trong localStorage). `pair-page.tsx` (`/remote/pair?m=&p=#s=`: không phải secure context thì báo "Cần hub chạy
    HTTPS", máy không thuộc mình thì báo trước khi gọi ghép, hiện câu lỗi của hub, cho thử lại), `devices-page.tsx`
    (`/remote/devices`: theo máy, gỡ có hộp xác nhận, máy offline không gỡ được), `remote-page.tsx` thêm trạng thái từ
    xa của máy và cảnh báo HTTP. Playwright với virtual authenticator: ghép thành công, mã hết hạn, máy người khác (web và
    hub), HTTP, thiếu bí mật, chưa đăng nhập, gỡ thiết bị, tiếng Anh, 360 px sáng/tối. Chưa thử trên điện thoại thật.
  - `lib/terminal/webauthn.ts` (tạo passkey UV bắt buộc, `getPublicKey()`, đọc bí mật từ fragment rồi xoá khỏi URL, tính
    tag; lấy assertion với challenge chuẩn hoá từ contracts), `pair-page.tsx`, `devices-page.tsx`; trang báo "Cần hub chạy
    HTTPS" khi không phải secure context; trạng thái từ xa của máy trên `remote-page.tsx`.
  - Playwright với virtual authenticator: ghép thành công, mã hết hạn, người khác, HTTP.
  - **Scope**: `apps/web/src/lib/terminal/{webauthn.ts,webauthn.test.ts}`,
    `apps/web/src/pages/remote/{pair-page.tsx,devices-page.tsx,remote-page.tsx}`, `apps/web/src/router.tsx`,
    `apps/web/e2e/{remote-pair.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T014, T021 (hoặc hub giả), T006 · **Mức**: nặng

- [x] T024 [US2] CLI `hive remote …`
  - Đã làm (SPEC10W4): `remote.go` (`status|on|off|roots [add|rm]|devices [rm]|pair|set|watch`, mọi lệnh có `--json`;
    `on` và `set allow-full-access on` hỏi tại terminal, không có terminal thì cần `--yes`; `roots add` nhận thư mục
    tương đối theo nơi gõ; `pair` mở watch trước rồi tạo mã, in QR + link, hỏi Cho phép trên chính kết nối watch, stdin
    đóng thì từ chối ngay; `pair --json` chỉ trả mã cho app; `watch --json` chuyển nguyên từng dòng hai chiều, `watch`
    không cờ hỏi tại terminal). `qr.go` vẽ bằng nửa khối với `rsc.io/qr`, chữ trắng nền đen khi là terminal.
  - `on` (hỏi xác nhận), `off`, `status`, `roots add|rm`, `devices [rm]`, `pair` (in QR trong terminal, chờ và hỏi
    Cho phép), `set`, `watch --json` (cho app; trả lời hộp xác nhận qua stdin JSON).
  - **Scope**: `worker/cmd/hive/{remote.go,remote_test.go,qr.go}`, `worker/go.mod`, `worker/go.sum`
  - **Phụ thuộc**: T012, T020 · **Mức**: vừa

- [x] T025 [US2] Worker: tạo và quản lý khoá TOTP
  - Đã làm (SPEC10W4): `totp_enroll.go` (`remote.totp.begin` trả `uri`, `secret` base32, `expiresAt`; khoá chờ chỉ giữ
    trong bộ nhớ, `begin` lại thay khoá chờ cũ; `confirm` sai 5 lần thì bỏ khoá chờ; lưu bằng `TOTPStore.Enable` nên mã
    xác nhận không dùng lại được; `disable`/`unlock` tại máy; audit không có khoá hay mã). Chế độ `host` không mở socket
    nội bộ nên không có đường vào; máy dùng chung bị từ chối.
  - Thao tác socket nội bộ `remote.totp.begin|confirm|disable|unlock` (T020 đã có khung `remote.*`): sinh khoá, URI
    `otpauth://`, chỉ lưu sau khi `confirm` bằng mã đúng, hết hạn 10 phút; tắt/đổi khoá tại máy; `term_state.totp`; từ chối
    khi chế độ `host` hoặc máy dùng chung; ghi `remote-audit.log` (`totp_enroll|totp_disable|totp_unlock`), không ghi khoá
    hay mã. `term_start`/`term_control` ở T031/T050 gọi `remoteauth.VerifyAuth` nên không cần sửa file của T031.
  - Test: begin/confirm đúng và sai, hết hạn, tắt rồi bật khoá mới (khoá cũ hết hiệu lực), mở khoá, không có đường bật từ
    hub, audit.
  - **Scope**: `worker/internal/terminal/{totp_enroll.go,totp_enroll_test.go}`
  - **Phụ thuộc**: T008, T020 · **Mức**: nặng

- [x] T026 [US2] CLI `hive remote totp …`
  - Đã làm (SPEC10W4): `remote_totp.go` (`status`, `enroll` in QR + khoá nhóm 4 ký tự, hỏi mã tới khi đúng, sai quá 5 lần
    thì worker bỏ khoá chờ; hết stdin thì báo chưa lưu; hub `http://` cảnh báo trên stderr, hub HTTPS nhắc
    `totp-on-https`; `confirm <mã>` cho app; `disable` hỏi xác nhận hoặc `--yes`; `unlock`; `--json` mọi lệnh).
    `remote.totp.begin` trả thêm `hubUrl` để CLI và app cảnh báo HTTP.
  - `enroll` (in QR `otpauth://` và URI, hỏi nhập một mã để xác nhận, cảnh báo HTTP khi hub là `http://`), `status`,
    `disable` (hỏi xác nhận), `unlock`; có `--json` cho app.
  - **Scope**: `worker/cmd/hive/{remote_totp.go,remote_totp_test.go}`
  - **Phụ thuộc**: T024 (cùng làn), T025 · **Mức**: vừa

- [x] T023 [US2] [US5] Desktop: màn Điều khiển từ xa
  - `remote.rs`: sidecar `hive remote watch --json`, lệnh `remote_*` gọi `hive remote … --json`; cửa sổ xác nhận ghép và
    "Hỏi trên máy"; thông báo hệ điều hành; khay "Tắt điều khiển từ xa ngay" và chấm khi có người điều khiển từ xa.
  - `remote-screen.tsx`: công tắc (xác nhận lần hai), thư mục (chọn bằng hộp thoại thư mục), thiết bị + QR, tuỳ chọn,
    danh sách phiên + Ngắt + Ngắt tất cả; mục "Mã Authenticator (TOTP)" (bật + QR + nhập mã xác nhận, tắt, mở khoá, qua
    `hive remote totp … --json`) và cảnh báo "Hub chạy HTTP" khi bật từ xa hoặc bật TOTP trên hub HTTP; từ điển vi/en;
    capability chỉ cho cửa sổ cục bộ.
  - **Scope**: `apps/desktop/src/screens/{remote-screen.tsx,remote-screen.test.tsx,index.ts}`,
    `apps/desktop/src/shell/*` (mục AppNav), `apps/desktop/src-tauri/src/{remote.rs,tray_icon.rs,lib.rs}`,
    `apps/desktop/src-tauri/capabilities/*.json`, `apps/desktop/src-tauri/src/capabilities_audit.rs`
  - **Phụ thuộc**: T015 (cùng `lib.rs`, `tauri.conf.json`), T024, T026 · **Mức**: vừa
  - Đã làm (SPEC10W6): `remote.rs` (sidecar `hive remote watch --json`, 15 lệnh `remote_*`, cửa sổ xác nhận ghép,
    thông báo hệ điều hành, khay "Tắt điều khiển từ xa ngay", chấm xanh dương góc trên phải khi `hive ls --json` có
    phiên `origin`/`controller` = `remote`); `lib/remote.ts`, `remote-screen.tsx` (vi/en) + mục AppNav;
    `capabilities_audit.rs` chặn `remote_*` ngoài cửa sổ app. Chưa thử cửa sổ Tauri và khay thật.

**Checkpoint**: chủ máy bật từ xa và ghép được điện thoại; chưa điều khiển được.

---

## Phase 4: User Story 3 — Xem và điều khiển từ điện thoại (P1) 🎯 MVP

- [x] T030 [US3] Hub: `/ws/terminal`
  - Đã làm (SPEC10W6): `ticket.ts` (vé dùng một lần 60 s; vé từ xa có tiền tố `r.`, vé Leader và vé từ xa không thay
    nhau; vé bị đốt ngay lần dùng đầu, kể cả khi Origin sai sau đó), `remote.ticket` trong `router.ts`. `ws.ts`: Origin
    phải khớp `HIVE_PUBLIC_URL` hoặc Host (403); vé từ xa đã dùng/hết hạn đóng 4401, phiên không thấy 4404, quá người
    xem hoặc bỏ khung 4429, người xem gửi `control`/`in`/`resize` bị đóng 4403. `live.ts`: vòng đệm 512 KiB mỗi phiên,
    nối lại theo offset (vòng đệm trước, thiếu thì đọc DB từng trang 200), 512 KiB/s mỗi người xem và 2 MiB/s mỗi máy,
    chậm hay tồn quá 1 MiB thì `sync` + đuôi 128 KiB, ping 20 s. `withRemoteLive` chuyển `term_granted`/`term_revoked`
    đúng `connId`, `term_event controller` có `denied` thành `{t:"denied"}` cho riêng kết nối đó (worker từ chối qua
    sự kiện này vì `term_denied` cần `requestId` uuid), `term_detach` khi đóng WS hay `release`, nối lại bằng
    `resumeToken` (sai thì `AUTH_STALE`), `term_exit` → `{t:"state"}`; audit `terminal.attach|detach|control_grant|
    control_take|control_revoke|deny|input_rejected`. `fleet/gateway.ts` thêm `onRemote` tách riêng. Test
    `ws.db.test.ts` (vé dùng lại, Origin sai, người xem gửi phím, nối lại không mất byte, client chậm nhận `sync`, hub
    khởi động lại đọc DB) và `live.test.ts`. Còn: hub khởi động lại mất quyền đang cấp (phải xác thực lại); nhiều tiến
    trình hub thì mỗi tiến trình chỉ thấy máy nối vào nó; `controller` trong `remote.get|list` vẫn `null`.
  - `ws.ts` (vé một lần 60 s qua route `ticket`, `Origin` bằng `HIVE_PUBLIC_URL`, mã đóng 4401/4403/4404/4429),
    `live.ts` (vòng đệm 512 KiB, người xem, chuyển `control`/`in`/`resize` tới worker chỉ cho kết nối của chủ máy, chuyển
    `term_granted`/`term_revoked`, nối lại theo offset, 512 KiB/s mỗi người xem, 2 MiB/s mỗi máy, đồng bộ lại khi đệm
    > 1 MiB, ping 20 s); gắn upgrade vào server ở `main.ts`; audit `attach|detach|control_*`.
  - Test DB/WS: vé dùng lại, sai Origin, người xem gửi nhập → 4403, nối lại không mất byte, client chậm, hub khởi động
    lại đọc từ DB.
  - **Scope**: `apps/hub/src/modules/terminal/{ws.ts,live.ts,ticket.ts,router.ts,index.ts,ws.db.test.ts,live.test.ts}`,
    `apps/hub/src/main.ts`
  - **Phụ thuộc**: T021 (cùng làn) · **Mức**: nặng

- [x] T031 [US3] Worker: cấp quyền điều khiển
  - `term_control`: kiểm assertion (T005), ECDH, cấp quyền (thu của người cũ), resize theo người điều khiển; `term_input`
    và `term_resize` kiểm `seq` + HMAC (3 lỗi → thu quyền, `input_rejected`); `resumeToken` 2 phút; hết 15 phút không gõ
    → thu; terminal tại máy giành lại; dòng báo trên terminal tại máy.
  - Test: đủ ca của US3 kịch bản 2–6 với vector cố định.
  - **Scope**: `worker/internal/terminal/{control.go,control_test.go,session.go}`
  - Đã làm (SPEC10W6): `Controller` (control.go) nhận term_control/detach/input/resize qua `Recorder`; phiên tra theo mã
    hub (`Local.byHubID`, không có session.go riêng). `machineId` của challenge là tên máy trong hello. Từ chối quyền
    không dùng `term_denied` (cần `requestId`) mà gửi `term_event` `controller` `{connId, denied, reason}`; cấp quyền
    gửi `term_granted` rồi `controller {connId, controller: "remote", label}`; thu quyền gửi `term_revoked` rồi
    `controller {connId, controller: "local"|null, reason}`. Gói sai gửi `input_rejected {connId, count}`, đủ 3 (cộng
    dồn, gói đúng không xoá) thì thu `input_rejected`. `term_detach` hay mất hub giữ quyền 2 phút cho `resumeToken`
    (cùng userId, deviceId; khoá và seq cũ); quá hạn `expired`, nối lại báo `AUTH_STALE`. Terminal tại máy nhận
    `taken` "Đang điều khiển từ xa bởi <nhãn thiết bị>."; `Ctrl-] t` hay `hive attach` thu quyền từ xa (`taken`).
    Tắt từ xa, máy thành dùng chung → `disabled`; gỡ thiết bị → `device_revoked`; phiên kết thúc → `closed`.
    `term_state.sessions[].controller` theo người điều khiển. Audit tại máy: `control_grant`, `control_resume`,
    `control_revoke`, `control_denied`, `input_rejected`. Test `control_test.go` (Unix, CLI giả sh) theo TOTP vector cố định.
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

- [x] T040 [US5] Worker: tắt khẩn cấp và giới hạn thời gian
  - Đã làm (SPEC10W6): `limits.go`. Phiên tại máy có `origin` (`local` | `remote`; `CreateParams.origin` không đọc từ
    JSON nên client socket nội bộ không tự nhận là phiên từ xa, T050 đặt khi mở). Tắt từ xa (máy, `term_disable`, máy
    thành dùng chung) → `RevokeAll(disabled)` rồi `endRemote`: SIGHUP, chờ `RemoteKillGrace` 10 s, kill cả nhóm; phiên
    `hive chat` giữ nguyên. `term_close` kênh chuyển cho cả Host và `Handler.CloseSession` (mới); phiên trên máy cá nhân
    bị ngắt với `term_exit {reason: closed, by: userId}`. Mỗi phút kiểm phiên mở từ xa: không client (terminal tại máy
    hay quyền gõ từ xa) và không output quá `detachedHours` (2 giờ) → `term_exit idle`; chạy quá `maxHours` (12 giờ) →
    `closed`; giới hạn đọc lại `remote.json` mỗi lần. Audit mới: `session_close` (hive kill, term_close, tắt từ xa),
    `session_limit`, `session_end` (phiên có ghi lên hub hoặc mở từ xa). `hive ls --json` thêm `origin`, `controller`
    cho dấu trên khay của app. Chọn theo kịch bản US5-4: giới hạn 2 giờ chỉ áp cho phiên mở từ xa, phiên `hive chat`
    tách ra như tmux không tự ngắt (FR-023 viết chung, cần chủ dự án xác nhận). Người xem trên hub không được tính là
    client vì worker không biết họ; đóng người xem khi tắt là việc của hub (T041) theo `term_state`.
  - Tắt từ xa: thu quyền, đóng người xem từ xa, kết thúc phiên mở từ xa (SIGHUP, 10 s, kill), giữ phiên tại máy, trong
    ≤ 2 s; `term_close`; phiên không client + không output 2 giờ; phiên từ xa quá 12 giờ; ghi `remote-audit.log` đủ mục.
  - **Scope**: `worker/internal/terminal/{limits.go,limits_test.go,remote.go,host.go}`
  - **Phụ thuộc**: T031 · **Mức**: vừa

- [ ] T041 [US5] Hub: ngắt, audit đủ, thông báo trong app
  - Route `close`, `disableRemote` tới mọi người xem; tắt từ xa → đóng WS của máy trong ≤ 2 s; hộp thư trong app có mục
    "Phiên … đang được điều khiển từ xa" (OPS-02); test đủ audit (SC-006).
  - **Scope**: `apps/hub/src/modules/terminal/{close.ts,router.ts,audit.db.test.ts}`
  - **Phụ thuộc**: T030 · **Mức**: vừa

- [ ] T027 [US2] [US3] Hub: đường lui TOTP và chính sách
  - Chấp nhận `auth.kind = "totp"` ở `control` (và `start` khi T051 xong) chỉ khi chính sách tổ chức `totpFallback` bật
    (`TOTP_NOT_ALLOWED` nếu tắt), chuyển tiếp mã tới worker không đọc, không lưu mã; `welcome.policy` gửi khi nối và khi
    đổi chính sách; hiện `totp` của máy trong `machines`; audit `terminal.totp_ok|totp_fail|totp_locked|totp_enroll|
    totp_disable` theo `term_state`/`term_denied`; không có route nào nhận hay lưu khoá.
  - Test DB: chính sách tắt chặn, mã không bao giờ vào DB hay log, người khác chủ máy, audit đủ (SC-013), `welcome`
    cũ không có `policy` vẫn chạy.
  - **Scope**: `apps/hub/src/modules/terminal/{totp.ts,router.ts,index.ts,gateway.ts,totp.db.test.ts}`
  - **Phụ thuộc**: T030, T041 (cùng làn), T008 · **Mức**: nặng

**Checkpoint MVP**: US1 + US2 + US3 + US5 chạy sau cờ `HIVE_REMOTE_TERMINAL=1`; T091 (test tấn công, gồm ca TOTP) phải xanh
trước khi bật cờ trên hub thật. Hub chạy HTTP (như `http://192.0.2.10:3000`) chỉ dùng được sau T008, T025–T028.

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

- [ ] T028 [US2] [US3] Web: nhập mã TOTP và cảnh báo HTTP
  - Khi trang không phải secure context: `lib/terminal/totp-auth.ts` (gửi `auth{kind: "totp", code, ephPub, ts, nonce}`;
    trộn mã vào HKDF như worker), `totp-code-sheet.tsx` (ô 6 số, "Chờ mã mới" khi mã vừa dùng, báo `TOTP_INVALID`,
    `TOTP_REPLAY`, `TOTP_LOCKED` còn bao lâu, `TOTP_NOT_ALLOWED`), `http-warning.tsx` ("Hub chạy HTTP: nội dung phiên và
    phím gõ đi qua mạng không mã hoá, chỉ dùng trong mạng nội bộ") hiện trên màn danh sách và màn terminal. Hub HTTPS: không
    hiện ô mã. Chọn nhánh passkey/TOTP một chỗ trong `requestRemoteAuth` (gọi từ T032 và T052).
  - Playwright 360×740 với hub giả HTTP (không virtual authenticator): mở phiên và xin quyền bằng mã, mã sai, mã dùng lại,
    khoá, chính sách tắt, cảnh báo luôn hiện.
  - **Scope**: `apps/web/src/lib/terminal/{totp-auth.ts,totp-auth.test.ts}`,
    `apps/web/src/components/{totp-code-sheet.tsx,http-warning.tsx}`,
    `apps/web/src/pages/remote/{remote-page.tsx,session-page.tsx}`, `apps/web/e2e/{remote-totp.spec.ts,fake-hub.ts}`
  - **Phụ thuộc**: T032, T052 (cùng làn), T027 · **Mức**: vừa

## Phase 7: User Story 6 — `hive attach` (P2)

- [ ] T060 [US6] CLI `hive attach`
  - Run: SSE `/api/v1/runs/:id/stream` với token cá nhân, nối lại theo `Last-Event-ID`, dòng nhập → `runs.steer`, in
    `steer_result`; phiên trên máy này: socket nội bộ; phiên máy khác: vé `view` + `/ws/terminal`, chỉ xem.
  - **Scope**: `worker/cmd/hive/{attach.go,attach_test.go,sse.go,hubws.go}`
  - **Phụ thuộc**: T024 (cùng làn), T030 · **Mức**: vừa

---

## Phase 8: User Story 7 — PWA và thông báo đẩy (P2)

- [ ] T070 [US7] Web: PWA
  - Một phần (SPEC10NEXT): vite-plugin-pwa `injectManifest`, `sw.ts` chỉ đệm vỏ, manifest `manifest.json`, icon, nút
    cài + hướng dẫn iOS, thanh phím + ô soạn ở trang terminal Leader (phần của T032), e2e `pwa.spec.ts`,
    `leader-terminal-mobile.spec.ts`. `start_url` đang là `/` (chưa có `/remote`). **Còn**: `push.ts`, `push`/
    `notificationclick` (chờ T071).
  - `vite-plugin-pwa` (`injectManifest`), manifest, icon 192/512/maskable, `sw.ts` (chỉ đệm vỏ ứng dụng; `push`,
    `notificationclick`), nút cài và hướng dẫn iOS, bật/tắt thông báo (`lib/terminal/push.ts`).
  - Playwright: manifest hợp lệ, service worker đăng ký, push giả mở đúng URL.
  - **Scope**: `apps/web/vite.config.ts`, `apps/web/src/sw.ts`, `apps/web/public/icons/**`, `apps/web/index.html`,
    `apps/web/src/lib/terminal/push.ts`, `apps/web/src/pages/remote/remote-page.tsx`, `apps/web/package.json`,
    `pnpm-lock.yaml`, `apps/web/e2e/pwa.spec.ts`
  - **Phụ thuộc**: T028 (cùng làn) · **Mức**: vừa

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
  - Lệnh `hive __hook` (chuyển từ T012): gửi tín hiệu tới worker qua socket nội bộ.
  - **Scope**: `worker/internal/terminal/{attention.go,attention_test.go}`, `worker/cmd/hive/{main.go,hook.go,hook_test.go}`
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
    lùi, `term_start` khi tắt, `subdir` thoát, gói bật/ghép giả từ hub; TOTP: mã sai, dùng lại, khoá và gấp đôi, khởi động
    lại không đặt lại, hub HTTPS, chính sách tắt, `term_start`/`term_control` không mã (SC-011, SC-012). Hub: người khác, máy
    dùng chung, vé dùng lại, sai Origin, người xem gửi nhập, request TOTP khi chính sách tắt, mã không vào DB/log. Chạy `/security-review`; ghi kết quả vào PR.
  - **Scope**: `worker/internal/terminal/attack_test.go`, `apps/hub/src/terminal-attack.db.test.ts`
  - **Phụ thuộc**: T040, T041, T027 cho MVP; thêm các ca `term_start` khi T050, T051 xong (cùng agent hoặc lượt hai) ·
    **Mức**: nặng

- [ ] T092 [P] Tài liệu
  - `docs/architecture.md` (module `terminal`, bảng gói ở mục 5, token, rủi ro), `docs/add.md`, `docs/sdd.md`, trạng thái
    RMT-xx/IF-07/NFR-17 trong `docs/srs.md`; hướng dẫn người dùng `docs/hive-cli.md` (cài, đăng nhập, chat, attach, bật
    từ xa, ghép, tắt khẩn cấp, bật mã Authenticator cho hub HTTP và rủi ro của nó).
  - **Scope**: `docs/{architecture.md,add.md,sdd.md,srs.md,hive-cli.md}`
  - **Phụ thuộc**: T090 · **Mức**: nhẹ

- [ ] T093 `/speckit-analyze` trên spec, plan, tasks; xử lý mâu thuẫn; chụp màn mới (sáng, tối, 360 px).
  - **Scope**: `specs/010-hive-cli-remote/*`, `apps/web/e2e/screenshots/**`
  - **Phụ thuộc**: T081, T023, T028 · **Mức**: nhẹ

---

## Phase 0b: Lát đầu — Terminal Leader trên máy dùng chung (spec Q4, plan "Lát đầu") ✅

Làm trước các phase trên cho máy **dùng chung** trên web máy tính (Leader của AI SDLC, specs/011 FR-067). Không thay các
task passkey/TOTP/`hive`/PWA ở trên: những task đó vẫn mở cho máy cá nhân.

- [x] T100 Contract lát đầu: gói `term_open|term_input|term_resize|term_close` và `term_opened|term_output|term_exit`,
  `TERMINAL_CAPABILITY`, `TERMINAL_LIMITS`, fixture; route `terminal.*` và khung WS trình duyệt (`terminal.ts`); quyền
  `leader.terminal`; `tier`/`tierReason` của đề xuất Leader và `approvals.approve {tier}`; `pnpm openapi`.
  - **Scope**: `packages/contracts/src/{worker-protocol.ts,terminal.ts,terminal.test.ts,leader.ts,roles.ts,index.ts}`, fixtures, `openapi.json`
- [x] T101 Worker: gói `internal/pty` dùng chung (creack/pty, đăng nhập gói chuyển sang dùng; Windows báo chưa hỗ trợ —
  phần ConPTY của T003 vẫn mở).
- [x] T102 Worker: `runner.PrepareInteractive` (worktree tạm tách HEAD, quyền theo `projects.Effective`, MCP riêng,
  env bỏ bí mật, tiết kiệm token, effort, advisor có điều kiện phiên bản) và `internal/terminal.Host` (PTY, gom output
  40 ms/32 KiB, 256 KiB/s, che bí mật kể cả bị cắt giữa hai lần đọc, 4 phiên/máy, đóng sau 30 phút không hoạt động,
  `CloseAll` khi mất hub); gói `accounts.Pool.AcquireInteractive` (D10); kênh khai `terminal`, chỉ nhận `term_open` trên
  máy dùng chung. Test với `/bin/sh` (một phần của T010, T011).
- [x] T103 Hub: module `terminal` (bảng `terminal_sessions`, `terminal_chunks`, RLS ép, migration `0063`), mở phiên (cờ
  `HIVE_REMOTE_TERMINAL`, quyền, máy dùng chung, giới hạn số phiên, cuộc trò chuyện chứa đề xuất), chuyển gói worker, che
  bí mật trước khi lưu, đóng khi máy mất kết nối (một phần T013, T041).
- [x] T104 Hub: `/ws/terminal` (vé một lần, Origin, vòng đệm, nối lại theo seq, người xem chỉ xem, giới hạn nhập) (phần
  máy dùng chung của T030, T080).
- [x] T105 Hub: token MCP của phiên, tool `leader_action` (Đề xuất → đề xuất chờ duyệt; Bypass → làm ngay, audit
  `terminal.action`) và `leader_tiers`; đóng phiên khi người mở mất quyền; Leader chat cũng gắn cấp độ; người duyệt đổi
  cấp, task mang nhãn `tier:`, run dispatch mang `tier`.
- [x] T106 Web: "Mở terminal Leader" trên trang Leader, hộp thoại (dự án, máy, gói, Đề xuất/Bypass có xác nhận, model và
  chi phí ước tính), trang phiên xterm.js 6.0.0 + fit, khung đề xuất (sửa cấp độ trước khi duyệt) hoặc nhật ký Bypass,
  trạng thái kết nối, tự nối lại, Cho đội xem, đóng phiên; thiết kế `Leader.dc.html` biến thể terminal (phần máy dùng chung
  của T006, T032).
- [x] T107 Kiểm: Go (`go test ./...`), hub DB (`terminal.db.test.ts`: quyền thành viên/BA/quản trị, máy cá nhân, Bypass
  chưa xác nhận, che bí mật, Origin, vé dùng lại, người xem, MCP theo chế độ, đổi cấp khi duyệt, Bypass + run theo cấp, mất
  quyền, máy bận, mất kết nối; `terminal/rls.db.test.ts`), contracts, web Playwright với WS giả.

## Phụ thuộc và song song

```text
T001 ─┬─ T002 ─┬─ T013 ─ T021 ─ T030 ─ T041 ─ T027 ─ T051 ─ T071 ─ T080 (hub; T027 cần T008)
      │        ├─ T014 ─ T022 ─ T032 ─ T052 ─ T028 ─ T070 ─ T081        (web; T022 cần T021, T032 cần T030, T052 cần T051, T028 cần T027)
      │        └─ T012 ─ T024 ─ T060                                 (cli; T012 cần T011, T024 cần T020, T060 cần T030)
      ├─ T005 ─ T008 ─ T025 ─ T026 (T025 cần T020; T026 cần T024)
      ├─ T005 ─────────────┐
      ├─ T007 ─ (T013)     │
      └─ T010 ─ T011 ─ T020 ─ T031 ─ T040 ─ T050 ─ T072              (worker)
T003, T004 ─ T011
T006 ─ T014, T022
T012 ─ T015 ─ T023 (cần T024, T026)                                        (phát hành, desktop)
T040, T041, T032 ─ T090 ─ T092
T040, T041, T027 ─ T091 (lượt hai sau T050, T051)
```

Đợt chạy song song gợi ý (tối đa khoảng 6 agent có build/test cùng lúc trên Mac mini):

| Đợt | Task |
|---|---|
| 1 | T001, T003, T004, T006 |
| 2 | T002, T005, T007, T010 |
| 3 | T008, T011, T013, T014 |
| 4 | T012, T020, T021 |
| 5 | T015, T022, T024, T025, T030, T031 |
| 6 | T023, T026, T032, T040, T041 |
| 7 | T027, T050, T051, T060, T091 (lượt MVP) |
| 8 | T052, T071, T072, T091 (lượt `term_start`) |
| 9 | T028, T080, T090 |
| 10 | T070, T092 |
| 11 | T081, T093 |

## Làn (để không hai agent sửa cùng file)

| Làn | Task (theo thứ tự) | File chung |
|---|---|---|
| contracts | T001 → T002 | `packages/contracts/**`, `openapi.json` |
| db | T007 | `migrations/**`, `terminal/schema.ts` |
| worker-pty | T003 | `worker/internal/pty/**`, `go.mod` |
| worker-ipc | T004 | `worker/internal/localipc/**` |
| worker-auth | T005 → T008 | `worker/internal/remoteauth/**` |
| worker-totp | T025 | `worker/internal/terminal/totp_enroll*.go` (file riêng, song song được với T031) |
| worker-channel | T010 | `worker/internal/channel/**`, `terminal/handler.go` |
| worker-terminal | T011 → T020 → T031 → T040 → T050 → T072 | `worker/internal/terminal/**`, `accounts.go`, `cmd/hive-worker/main.go` |
| cli | T012 → T024 → T026 → T060 | `worker/cmd/hive/**`, `go.mod` |
| release-desktop | T015 → T023 | `.goreleaser.yaml`, `release.yml`, `install.*`, `internal/update/**`, `apps/desktop/**` |
| hub-terminal | T013 → T021 → T030 → T041 → T027 → T051 → T071 → T080 | `modules/terminal/{router.ts,index.ts,gateway.ts,live.ts}`, `fleet/gateway.ts`, `main.ts`, `app.ts` |
| web | T014 → T022 → T032 → T052 → T028 → T070 → T081 | `apps/web/e2e/fake-hub.ts`, `router.tsx`, `pages/remote/**`, `package.json` |
| design | T006 | `docs/design-system/screens/**` |
| verify | T090 | `scripts/e2e-remote.ts`, `ci.yml` |
| security | T091 | `attack_test.go`, `terminal-attack.db.test.ts` (file mới, không chung với làn khác) |
| docs | T092 → T093 | `docs/**`, `specs/010-hive-cli-remote/*` |

`go.mod`/`go.sum` bị T003, T012, T024 sửa (thêm thư viện): T003 thêm `go-pty`; T012 thêm `go-keyring`, `x/term`; T024
thêm thư viện QR. Ba task ở ba đợt khác nhau; nếu chạy chồng thì người điều phối gộp `go.mod` lúc merge (xung đột chỉ ở
khối `require`).

## Implementation Strategy

- **MVP** (US1 + US2 + US3 + US5, sau cờ `HIVE_REMOTE_TERMINAL`): T001–T008, T010–T015, T020–T028, T030–T032, T040,
  T041, T091. T008, T025–T028 là đường lui TOTP cho hub HTTP (Q2); chạy trên hub nội bộ HTTP cần đủ nhóm này, hub HTTPS chỉ
  cần passkey. Đủ để: `hive chat` tại máy, xem lại trên web, bật từ xa và ghép điện thoại tại máy, mở phiên đang chạy trên
  điện thoại và gõ trả lời, tắt khẩn cấp, audit hai nơi. Chưa có PWA/đẩy: dev mở web trên trình duyệt điện thoại.
- **Tăng dần**: T050–T052 (mở phiên từ điện thoại) → T060 (`hive attach`) → T070–T072 (PWA, thông báo) → T080–T081 (xem
  cùng) → T090, T092, T093.
- Phần US1 (ghi phiên) phát hành được trước mà không có gì từ xa; mọi gói mới được bảo vệ bằng thoả thuận khả năng, nên
  merge từng phần không ảnh hưởng run đang chạy (SC-010).
