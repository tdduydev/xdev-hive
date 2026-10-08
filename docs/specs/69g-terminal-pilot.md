# 69g — Hồ sơ pilot terminal và quyết định bật feature

**NO-GO — chưa bật remote terminal.** Ngày 2026-10-08, task R-69g, run R-9a07d2.
Đối chiếu [spec 69](69-remote-terminal.md) §12–13 (AC01–08). AC09–10 thuộc gate/release,
không được coi là đã đạt từ các phép thử này.

Nền kiểm: `eca2043f51ca5e4d5f0f37543306448c7c205b43`, desktop 0.146.3,
macOS arm64, Node 26.10.0, Electron 44.6.0 (Node 24.21.0 trong PTY smoke).
Probe là phần bổ sung của R-69g; receipt ghi riêng `probeSha256` và SHA nền implementation.
Không triển khai hub, không đổi local opt-in của app cài sẵn, không push/release.
Không tăng version hay đánh dấu roadmap xong vì điều kiện bật feature chưa đạt.

## 1. Bằng chứng và giới hạn

Artifacts của run nằm trong `.xdev-hive/artifacts/` và được Hive giữ cùng R-69g khi run kết thúc:

| File | Kết quả / phạm vi |
|---|---|
| `typecheck.log` | `npm run typecheck`: exit 0 |
| `tests.log` | `npm test`: 1.776 tests, 1.771 pass, 5 skipped, 0 fail; khoảng 190 s |
| `desktop-build.log` | Desktop build exit 0; không chứng minh packaging/native runtime |
| `security-probes.json` | 5 phép thử với HTTP/WS thật, identity production, agent và encrypted recorder thật; PTY tổng hợp; 3 fail, 2 pass |
| `pty-smoke.log` | Electron-as-Node spawn/resize/no-echo chạy tới bước local opt-out; timeout chờ shell exit, exit 1 |
| `desktop-smoke.log` | `start-new` SIGABRT, không có screenshot/result |
| `web-e2e.log`, `mobile-e2e.log` | Đã gọi full suite, build/seed xong nhưng browser thoát trước result/screenshot, exit 1 |

Worktree ban đầu chưa có dependencies. Sau `npm ci`, chạy lại typecheck/test/build.
Electron download từng xung đột khi khởi động hai harness song song; đã thử lại tuần tự sau
khi binary có mặt. `npm run rebuild:pty -w @xdev-hive/desktop` thành công; PTY smoke sau
rebuild vẫn thất bại ở stop. Các lỗi bootstrap trước đó không được dùng làm kết quả gate cuối.

`/bin/ps -axo pid=,ppid=,pgid=,lstart=` trong run trả `operation not permitted`.
Supervisor cần snapshot này để TERM/KILL descendants theo identity. Vì vậy không thể dùng
run sandbox này để nghiệm thu native cleanup; fallback TERM không chứng minh shell đã chết.
GUI bị abort trước khi có result; chưa xác định độc lập toàn bộ nguyên nhân GUI.
Không suy từ build xanh hoặc PTY spawn thành công ra GUI host đã đạt.

Endpoint pilot Cloudflare/TLS LAN và người kiểm bàn phím thật chưa được cung cấp.
Không có kết quả Linux native/packaged, physical iOS Safari/Android Chrome, RTT WAN,
memory benchmark hay recording growth. Mọi kết quả unit/fixture dưới đây chỉ có phạm vi tương ứng.
Artifacts đã loại password bootstrap fixture/credential khỏi log; không giữ raw terminal I/O.

## 2. Findings chặn rollout

| ID | Bằng chứng tái hiện | Vị trí / điều cần sửa trước pilot |
|---|---|---|
| B1 — AC06 | Canary known-secret chia hai chunk xuất hiện nguyên văn ở **live và replay**, nhưng transcript đọc local không chứa canary | `MachineTerminalAgent.#output` gọi recorder rồi đưa **bytes gốc** vào `OutputRing`/WS. Cần redaction stateful ở đường live/replay trước hub/display; kiểm split/ANSI/UTF-8 và không làm hỏng backpressure |
| B2 — AC04 | Browser detach rồi bỏ grant project: sau 2.100 ms PTY tổng hợp vẫn chạy, session `detached` | `TerminalRelayHub.#deadline` chỉ kiểm `terminalDecision` khi `l.browser` còn tồn tại. Phải kiểm principal/quyền đã gắn phiên cả khi detach/reconnect/hub restart; bao gồm account disabled và project archive |
| B3 — AC04 | Revoke credential cha được pin cho máy: socket máy đóng, nhưng sau 2.100 ms PTY vẫn chạy, session `active` | Sweep đóng socket trước khi gửi kill; lease fallback không đáp ứng revoke online ≤2 s. Cần đường revoke dừng máy đang online, cùng kiểm partition ≤30 s và reconnect không respawn |
| B4 — AC06 | Đường production chưa upload recording/anchor; `terminal.recording` chỉ trả chỉ mục metadata | `remote-terminal.ts`, `relay-agent.ts` (`auditSeq: 0`), `TerminalHub.rpc`. Cần nối upload, transcript ACL/step-up, action timeline, quota/fault handling và lịch purge thực tế; unit store xanh chưa đủ |

Identity máy **đã nối** trong `apps/web/src/server.ts` bằng `hive.isMachineActor` /
`hive.machinePinnedOwner`. Các ghi chú 69e/69f trước đó nói identity chưa nối là thông tin nền cũ.
Không dùng điều đó để giải thích các lỗi B1–B3. Worktree checkout vẫn bị agent từ chối;
không quảng bá hỗ trợ `worktree:<task>` chỉ vì form hiển thị lựa chọn.

## 3. Ma trận AC01–08

“Partial” nghĩa là có kiểm tự động xanh trong phạm vi ghi ở cột bằng chứng,
không phải AC đã nghiệm thu trên pilot thật.

| AC | Trạng thái | Bằng chứng hiện có | Còn cần trước bật |
|---|---|---|---|
| AC01 | Partial | `core/test/terminal.test.ts`: owner/admin/project/local opt-out matrix. `web/test/terminal-security.test.ts`, `terminal-stepup.test.ts`: principal từ middleware thật, source giả, credential MCP/máy và bearer không thành human | Chạy ma trận cookie/member/lead/owner/admin + run/MCP/chat/machine trên topology pilot, không tự giả owner từ label |
| AC02 | Partial | `terminal-proofs.test.ts`, `terminal-stepup.test.ts`: proof sai/hết hạn/replay/context khác; ticket replay/cookie/Origin/first frame/revoke; flag off từ chối proof/upgrade | Password và OIDC thật qua proxy; kiểm access log/telemetry không có ticket/password/frame. Không suy từ DB hash-only ra proxy log sạch |
| AC03 | Partial / native stop fail | Supervisor unit tests policy/audit/dimensions; native smoke tới spawn/minimal env/history/resize/no-echo trước stop timeout; capability old/Windows có unit test | Host macOS ngoài sandbox + Linux native và app packaged: shell/TUI, Ctrl-C, exitCode, symlink/outside cwd refusal, stop descendants. Packaging build + smoke đúng Electron ABI |
| AC04 | **Fail** | Relay một writer/new epoch, grant/logout attached/local off; agent lease 30 s bằng clock fixture. Pilot stop qua hub <500 ms với PTY tổng hợp (thời gian từng lần trong receipt); input sau stop không write, lock được nhả | Sửa B2/B3. Native process tree/local stop, orphan report, online revoke ≤2 s, partition/input rejection ≤30 s; không dùng report `revoked` làm bằng chứng process chết |
| AC05 | Partial | Relay/client tests input mất ACK không resend, epoch, output ordered/dedup, replay gap, slow consumer/window cap; idle/detached clocks có fixture | Real PTY/browser/network fault + đo RTT/reconnect/RSS/recording size, idle/absolute TTL và hub restart với deadline persisted; không OOM dưới sustained output |
| AC06 | **Fail** | Recorder/store tests encryption/redaction/chunk/ANSI/no-echo markers/quota/disk-full/tamper/ACL/purge xanh; canary production-agent probe fail trên live/replay | Sửa B1/B4; kiểm toàn pipeline, crypto/disk failure trước thực thi input, sequence/resize/action/anchor, retention trên replica/backup; raw archive vẫn có thể chứa secret chưa biết |
| AC07 | Unverified pilot | 69f có selectors/NEEDS cho Máy/Run/Chat, vi/en, focus/keys/paste/composition/360–390px; terminal-client UTF-8/dedup tests xanh | GUI e2e full cần result và ảnh; focus/screen reader/contrast, actual keyboard/safe area, 390×844 và 360px. IME Telex/VNI thật trên iOS Safari + Android Chrome chưa chạy |
| AC08 | Partial / topology unverified | MachineSocket outbound và từ chối HTTP remote; browser WSS URL unit test; relay reconnect/restart fixture. Probe logout giữa attach và redeem chặn stale reconnect và stop máy | WSS Cloudflare, TLS LAN chứng chỉ hợp lệ, edge restart/Access expiry, hub+machine restart, revoke trong reconnect, xác nhận máy không mở inbound port |

UI review áp skill `ui-ux-pro-max`, query `focus not obscured --domain ux`:
AA yêu cầu focus ít nhất còn thấy một phần, enhanced AAA yêu cầu thấy toàn bộ.
Checklist bổ sung touch target ≥44×44, input ≥16px, không overflow 360/390px,
toolbar/stop ngoài vùng TUI, Tab thoát, focus trả lại trigger, status aria-live.
Đây là tiêu chí kiểm tiếp; không ghi “pass accessibility” khi browser chưa chạy được.

## 4. Chạy lại probes và stop test

Từ root của worktree:

```sh
npm ci
node apps/web/e2e/terminal-pilot.mjs .xdev-hive/artifacts/security-probes.json
```

Exit **1 với `NO_GO` là kết quả hiện tại dự kiến**, không phải green gate.
Harness dùng SQLite memory, users/tokens/password/key/canary tạm, server loopback ngẫu nhiên,
production pinned identity và encrypted recorder. Nó kiểm canary live/replay, revoke khi detach,
parent credential revoke, logout giữa cấp ticket và reconnect, emergency stop và input sau stop.
Nó không đọc config/token app cài sẵn, không bật feature ở hub thật, không giữ canary hoặc I/O
trong receipt. Mỗi fixture đóng agent/relay/socket/server và xoá spool/key tạm.
PTY tổng hợp cho phép đo delivery/logic stop; không chứng minh SIGTERM/SIGKILL hay native ABI.

Trong GUI session của host ngoài coding sandbox, với checkout cô lập của đúng SHA:

```sh
npm run typecheck
npm test
npm run rebuild:pty -w @xdev-hive/desktop
npm run build -w @xdev-hive/desktop
npm run smoke:pty -w @xdev-hive/desktop
npm run dist:dir -w @xdev-hive/desktop
# npm workspace cwd là apps/desktop; dùng đường dẫn app vừa build đúng platform
npm run smoke:pty -w @xdev-hive/desktop -- 'release/mac-arm64/xDev Hive.app'
npm run smoke -w @xdev-hive/desktop -- /private/tmp/69g-desktop
npm run e2e -w @xdev-hive/web -- /private/tmp/69g-web
npm run e2e:mobile -w @xdev-hive/web -- /private/tmp/69g-mobile
```

Full e2e là gate cuối. Có thể dùng `--only terminal-entry,terminal-io --repeat 3` để phát triển;
không thay full suite bằng hai bước ấy. Linux phải build/runtime native trên host Linux,
không dùng macOS cross-build làm bằng chứng Linux. Không publish artifact từ `dist:dir` này.

Stop test trên host thật/topology pilot, chỉ chạy command vô hại trong project fixture:

1. Mở shell sau cookie step-up; pin machine/project/checkout/OS user và session ID.
   Ghi SHA/version, capability, TTL, auditReady và clock monotonic bắt đầu; không in credential.
2. Chạy foreground wait/TUI, resize và Ctrl-C: foreground dừng, shell tiếp tục nhận input;
   exit với code đã chọn phải khớp report. Không coi Ctrl-C là đóng phiên.
3. Mở fixture child/grandchild chịu TERM giống `pty-smoke.mjs`. Bấm **Kết thúc phiên**;
   ghi thời gian hub stop/input lockout, shell exit, escalation và từng process identity biến mất.
   Spec online ≤2 s áp revoke/input lockout; supervisor có grace KILL 5 s, ghi riêng cleanup latency.
4. Lặp logout, mất grant, account disable, project archive, parent revoke, local opt-out
   cả attached/detached/reconnect; không còn input sau revoke. Một tab cũ không viết sau takeover.
5. Partition máy–hub **trong fixture**, có local operator sẵn sàng stop. Không còn input sau
   lease 30 s kể từ lần renew cuối; snapshot process/exit/cleanupUncertain. Sau nối lại không respawn.
6. Logout/revoke giữa ticket issuance và WS auth; restart hub và supervisor theo lượt.
   Ticket/epoch cũ bị từ chối, orphan được kill/report; deadline không được âm thầm kéo dài.
7. Xác nhận lock checkout/update drain chỉ nhả sau cleanup, không có daemon fixture sót.
   `cleanupUncertain=true` phải được ghi, không đổi thành false chỉ vì shell chính đã exit.

Nếu input vẫn hoạt động sau revoke, audit không bền vững, canary lộ, process chưa dừng,
không có bằng chứng cleanup, hoặc deadline bị kéo dài: **dừng test và giữ NO-GO**.
Local operator dừng fixture tại OS host theo process identity đã ghi; không kill theo label/PID cũ,
không chạy lại shell/release để “thử”. Không thử production side effects trong pilot bảo mật.

## 5. Checklist bật feature — hiện chưa đủ điều kiện

- [ ] B1–B4 được sửa và review; receipt probes không còn lỗi AC, kiểm native/packaged stop đạt.
- [ ] Mỗi AC01–08 có evidence đúng SHA/version/topology, reviewer ký trạng thái; không còn “Partial/Unverified”.
- [ ] Host macOS GUI + Linux ở platform matrix đã nâng bản đúng; Windows báo unsupported;
      worktree chưa hỗ trợ không được đưa vào phạm vi pilot.
- [ ] Human-purpose cookie + CSRF/Origin + password/OIDC step-up thật; machine credential-ID pin,
      owner và project grants lấy từ server. Không dùng bearer/run/MCP/chat thay cookie người dùng.
- [ ] Local operator tự cấu hình `remote-terminal.json` 0600 của đúng OS user, project fixture,
      expiry hạn chế, max một session; key/spool readiness và emergency stop hoạt động.
- [ ] Reviewer chấp nhận quyền OS user rộng, project không filesystem isolation,
      raw encrypted archive có thể chứa secret chưa biết, cleanup daemon ngoài cây có thể không chắc chắn.
- [ ] HTTPS/WSS same-origin qua Cloudflare và TLS LAN; proxy Upgrade/Connection đúng,
      trusted-forwarded-headers cấu hình đúng; Access chỉ là lớp bổ sung, không thay identity Hive.
- [ ] Không ticket trong URL/access log, không raw recording/chat/artifact/telemetry;
      storage ACL, encryption, quota, upload anchor, purge/backup retention đã kiểm end-to-end.
- [ ] Phép thử phone thật có OS/browser/keyboard/version, 390×844/360px,
      Telex/VNI composed/combining text đúng một lần; status/stop còn thấy khi mở bàn phím.
- [ ] Có owner vận hành, khoảng thời gian pilot, metric RTT/reconnect/RSS/size, stop thresholds,
      đường local stop không phụ thuộc hub, kế hoạch thu hồi và giữ audit.
- [ ] Chỉ sau các mục trên: bật `HIVE_REMOTE_TERMINAL=1` cho topology pilot đã thống nhất,
      local opt-in đúng máy/project; mở một phiên fixture, kiểm lại capability/identity thực tế.

Không bật trên HTTP LAN plaintext; chỉ loopback development được ngoại lệ. Không mở PTY inbound
port ở máy. Không chạy release/deploy/push để xác minh terminal. Bản bootstrap phải được người
vận hành cài trước; terminal chưa nghiệm thu không được tự triển khai chính nó.

## 6. Checklist dừng / rollback pilot

- [ ] Ghi session IDs và reason enums; dừng cấp proof/ticket/upgrade mới bằng tắt hub flag.
      Với server hiện tại flag được đọc lúc startup; đổi env cần restart đúng instance.
- [ ] Khi hub còn chạy: dùng human terminate/emergencyStop cho mọi session và chờ machine report.
      Khi không còn hub: local opt-out/stop từ OS host; không dựa vào browser detach để kill.
- [ ] Recheck sockets/input, lease partition ≤30 s, descendants/locks/update drain;
      log shell-stop và process-cleanup time riêng. Process chưa chết phải được điều tra ở host.
- [ ] Sau restart/kill switch: proof/create/attach/socket bị chặn; terminate/list/get/audit vẫn
      truy cập theo ACL khi feature off. Không drop bảng hay xoá audit để rollback.
- [ ] Giữ encrypted audit theo retention; xuất duy nhất transcript đã redact khi ACL/step-up hợp lệ;
      không đem key/cookie/token/raw bytes vào hồ sơ. Kiểm purge/backup sau thời hạn.
- [ ] Ghi pass/fail từng AC, orphan/cleanupUncertain và phần cần sửa; dừng rollout đến khi review lại.

Kết luận của hồ sơ này là **giữ feature disabled**. Regression xanh xác nhận nền có kiểm tự động;
các probe fail và phần host/network/phone chưa kiểm ngăn nghiệm thu rollout R-69g.
