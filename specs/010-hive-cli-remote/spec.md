# Feature Specification: CLI `hive` và điều khiển agent từ xa qua web trên điện thoại

**Feature Branch**: `010-hive-cli-remote`

**Created**: 2026-10-13

**Status**: Draft (đã ghi quyết định của product owner ngày 2026-10-13, xem Clarifications)

**Input**: Yêu cầu của product owner (nguyên văn): "có thể tự viết cli hem, sau này có thể làm remote cli trên app luôn,
trên dt ấy". Đã chốt: (1) CLI của Hive bọc agent có sẵn (Claude Code, Codex, Gemini CLI, Antigravity), không tự viết
agent; (2) điều khiển từ xa qua web của hub chạy trên điện thoại (PWA), không làm app mobile riêng.

**Requirements added**: RMT-01 … RMT-13, IF-07, NFR-17 trong [docs/srs.md](../../docs/srs.md#319-hive-cli-and-remote-sessions-rmt).
**Decision record**: [ADR 0019](../../docs/adr/0019-hive-cli-and-remote-sessions.md).

## Bối cảnh

Hôm nay:

- Worker chạy agent **không tương tác** qua pipe (`claude -p --input-format stream-json`). Không có PTY, không có
  socket nội bộ; app desktop điều khiển worker qua stdio của sidecar và lệnh `hive-worker accounts … --json`.
- Web xem log run qua SSE (`/api/v1/runs/:id/stream`) và gửi chỉ dẫn qua `runs.steer`; chỉ Claude nhận chỉ dẫn giữa
  chừng.
- Token cá nhân `hive_pat_…` (90 ngày, gắn một tổ chức) gọi được mọi route `/rpc`, `/api` và SSE như phiên đăng nhập.
- Máy cá nhân chỉ chạy việc của chủ ([ADR 0017](../../docs/adr/0017-admin-web-client-app-and-machine-ownership.md));
  một máy có nhiều tài khoản CLI trong `accounts.json` (spec 008 US13, US14).

Dev muốn làm việc với agent theo kiểu tương tác (như gõ `claude` trong terminal) nhưng vẫn để Hive chọn gói, ghi lại
phiên và gắn với task; và khi rời máy thì xem và trả lời agent trên điện thoại.

Thuật ngữ:

- **Phiên** (terminal session): một tiến trình agent CLI chạy tương tác trong PTY trên máy dev, do worker giữ.
- **Chủ máy**: người đã đăng ký máy (`machines.registered_by`), máy cá nhân (`shared = false`).
- **Thiết bị đã ghép**: trình duyệt trên điện thoại có passkey đã được chủ máy xác nhận tại máy.
- **Người điều khiển**: client duy nhất được gõ vào phiên (terminal tại máy hoặc một thiết bị đã ghép). Mọi client khác
  chỉ xem.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mở phiên agent tương tác bằng `hive` trên máy, có ghi lại trên hub (Priority: P1)

Dev mở terminal trong thư mục dự án, gõ `hive chat` (hoặc `hive run "sửa test thanh toán"`). Hive chọn tài khoản CLI
theo `accounts.json`, mở Claude Code tương tác ngay trong terminal đó. Phiên được ghi lên hub; dev xem lại trên web.
Dev gắn phiên với task bằng `--task PAY-12` nếu muốn.

**Why this priority**: Đây là phần "tự viết CLI" và là nền cho điều khiển từ xa (cùng một đường PTY). Dùng được ngay cả
khi chưa bật từ xa.

**Independent Test**: Máy đã đăng ký, worker đang chạy, có hai tài khoản Claude. Chạy `hive chat --cli claude` trong
repo mẫu với CLI giả (in dấu nhắc, nhận dòng, in lại). Gõ "xin chào", thấy CLI in lại; đóng terminal; `hive ls` vẫn
thấy phiên `running`; `hive attach <id>` thấy lại màn hình; gõ `/exit`, phiên `exited`. Trên web, trang phiên phát lại
đúng các byte đã ghi, có tài khoản, thư mục, thời gian.

**Acceptance Scenarios**:

1. **Given** worker đang chạy và máy là máy cá nhân, **When** chủ máy chạy `hive chat` trong `~/code/payment-api`,
   **Then** worker chọn tài khoản theo thứ tự ưu tiên (bỏ tài khoản chưa đăng nhập; **không** áp ngưỡng dừng
   `stopAtSession`/`stopAtWeek` vì đó là phần để dành cho chủ), mở CLI trong PTY với đúng biến thư mục cấu hình
   (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), và terminal hiện giao diện của CLI như chạy trực tiếp.
2. **Given** `hive chat --account claude-2`, **When** tài khoản đó đang nghỉ (cooldown), **Then** CLI báo "Tài khoản
   claude-2 đang nghỉ tới 15:40. Dùng --force để vẫn mở." và không mở.
3. **Given** `hive run --task PAY-12 "viết test hoàn tiền"`, **When** đã `hive login` và task thuộc dự án của đội máy,
   **Then** phiên mở với câu đầu là lời nhắc đó, gắn task, và trang task trên web có mục "Phiên tương tác" trỏ tới phiên.
4. **Given** phiên đang chạy, **When** người dùng nhấn phím tách (mặc định `Ctrl-]` rồi `d`) hoặc đóng cửa sổ terminal,
   **Then** phiên vẫn chạy trong worker; `hive ls` liệt kê nó; `hive attach <id>` gắn lại và vẽ lại màn hình.
5. **Given** worker không chạy, **When** gõ `hive chat`, **Then** CLI báo "Worker chưa chạy. Mở app xDev Hive hoặc chạy
   `hive-worker service install`." và thoát mã 2.
6. **Given** máy dùng chung hoặc runner host, **When** gõ `hive chat`, **Then** phiên chạy tại máy nhưng không ghi lên
   hub và không điều khiển từ xa được, kèm dòng báo lý do.
7. **Given** `hive chat --no-record`, **Then** không byte nào của phiên được gửi lên hub; hub chỉ không biết phiên này.

---

### User Story 2 - Bật điều khiển từ xa trên máy và ghép điện thoại (Priority: P1)

Chủ máy mở app desktop, vào **Điều khiển từ xa**, bật "Cho điều khiển từ xa" (mặc định tắt), chọn thư mục được phép, rồi
bấm "Ghép điện thoại". App hiện mã QR. Chủ máy quét bằng điện thoại (đã đăng nhập web của hub), xác thực bằng Face ID
hoặc vân tay để tạo passkey, rồi bấm **Cho phép** trên máy. Máy không có app thì làm cùng việc bằng `hive remote on` và
`hive remote pair` (QR in trong terminal).

**Why this priority**: Không bật và không ghép thì không có điều khiển từ xa. Bước ghép tại máy là chốt bảo mật chính.

**Independent Test**: Máy mới: `hive remote status` báo "Tắt". Gọi `terminal.start` từ web → bị từ chối
`REMOTE_DISABLED`. Bật trên app, ghép một trình duyệt có passkey ảo (Playwright virtual authenticator), xác nhận trên
app → `remote.json` có một thiết bị; trang Thiết bị trên web hiện thiết bị đó. Gọi lại `terminal.start` có assertion
hợp lệ → được nhận.

**Acceptance Scenarios**:

1. **Given** máy chưa từng bật, **When** xem màn Điều khiển từ xa, **Then** công tắc tắt, có giải thích rủi ro ngắn và
   nút bật cần xác nhận lần hai ("Agent có thể chạy lệnh trên máy này khi bạn điều khiển từ điện thoại").
2. **Given** chủ máy bấm "Ghép điện thoại", **When** quét QR và tạo passkey, **Then** app hiện "Ghép 'iPhone của An'
   (đăng nhập: an@…)?" với nút Cho phép/Từ chối; chỉ sau khi Cho phép thì thiết bị mới được lưu.
3. **Given** mã ghép đã quá 10 phút hoặc đã dùng, **When** điện thoại gửi kết quả ghép, **Then** bị từ chối "Mã ghép đã
   hết hạn. Tạo mã mới trên máy.".
4. **Given** người quét QR đăng nhập hub bằng tài khoản khác chủ máy, **When** gửi kết quả ghép, **Then** hub từ chối
   `MACHINE_NOT_YOURS`, máy không hiện hộp xác nhận.
5. **Given** hub (hoặc người giữa) đổi khoá công khai của passkey trên đường đi, **When** worker nhận, **Then** HMAC theo
   bí mật ghép không khớp, worker từ chối và ghi audit tại máy.
6. **Given** máy dùng chung hoặc runner host, **When** bật điều khiển từ xa, **Then** bị từ chối "Máy dùng chung không
   cho điều khiển từ xa.".
7. **Given** có gọi API nào từ hub nhằm bật điều khiển từ xa hay thêm thiết bị, **Then** không tồn tại gói tin hay route
   nào làm được việc đó (chỉ tắt, gỡ thiết bị, ngắt phiên).
8. **Given** hub chạy HTTP (không có passkey) và chính sách tổ chức cho phép đường lui TOTP, **When** chủ máy bấm "Bật mã
   Authenticator" trên app hoặc chạy `hive remote totp enroll`, **Then** máy hiện QR `otpauth://` và chờ chủ nhập một mã
   đúng từ app Authenticator; chỉ khi mã đúng thì khoá TOTP mới được lưu tại máy. Trước khi bật, app hiện cảnh báo rõ
   rằng trên HTTP nội dung phiên và phím gõ đi qua mạng không mã hoá, chỉ nên dùng trong mạng nội bộ.
9. **Given** TOTP đã bật, **When** mở phiên hay xin quyền gõ từ web (hub HTTP), **Then** web hỏi mã 6 số; worker tự kiểm mã
   và từ chối mã đã dùng (`TOTP_REPLAY`), mã sai (`TOTP_INVALID`) hoặc khi đang bị khoá tạm (`TOTP_LOCKED`); hub không
   kiểm được thay.

---

### User Story 3 - Xem và điều khiển phiên đang chạy từ điện thoại (Priority: P1)

Dev để Claude Code chạy trên máy rồi ra ngoài. Trên điện thoại, mở **Điều khiển từ xa** của hub, thấy máy và phiên đang
chạy, mở phiên: thấy màn hình terminal trực tiếp. Bấm **Điều khiển**, xác thực Face ID, gõ trả lời ("y", một câu chỉ
dẫn), dùng thanh phím Esc/Tab/Ctrl/mũi tên. Mất sóng vài giây thì tự nối lại mà không phải xác thực lại.

**Why this priority**: Đây là yêu cầu "remote cli trên điện thoại".

**Independent Test**: Phiên đang chạy với CLI giả. Trên Playwright mô phỏng điện thoại 360×740 có passkey ảo: mở phiên,
thấy dấu nhắc; bấm Điều khiển → assertion; gõ "y" → CLI giả in "đã nhận y"; cắt mạng 10 giây rồi nối → màn hình đầy
đủ, gõ tiếp được, không hỏi passkey; terminal tại máy hiện dòng "Đang điều khiển từ xa bởi iPhone của An".

**Acceptance Scenarios**:

1. **Given** chủ máy mở phiên trên điện thoại, **When** trang tải, **Then** thấy màn hình hiện tại (phát lại phần đuôi đã
   đệm) trong ≤ 2 giây và các byte mới xuất hiện trực tiếp; chưa gõ được cho tới khi bấm Điều khiển.
2. **Given** bấm Điều khiển, **When** passkey xác thực thành công, **Then** worker cấp quyền điều khiển cho kết nối đó,
   PTY đổi kích thước theo màn điện thoại, terminal tại máy chuyển sang chỉ xem kèm dòng báo.
3. **Given** đang điều khiển từ điện thoại, **When** người tại máy nhấn phím giành lại (`Ctrl-]` rồi `t`), **Then** quyền
   về terminal tại máy ngay, điện thoại chuyển chỉ xem với thông báo "Máy đã lấy lại quyền điều khiển".
4. **Given** gói nhập không có HMAC đúng hoặc `seq` không tăng, **When** tới worker, **Then** worker bỏ gói, đếm lỗi, quá
   3 lỗi thì thu quyền điều khiển và ghi audit `terminal.input_rejected`.
5. **Given** mất mạng ≤ 2 phút, **When** điện thoại nối lại, **Then** dùng lại quyền cũ (khoá phiên giữ trên thiết bị),
   nhận phần output bị lỡ theo offset, không hỏi passkey. Quá 2 phút thì phải xác thực lại.
6. **Given** điện thoại không gõ gì 15 phút (mặc định), **Then** worker thu quyền điều khiển; xem vẫn tiếp tục.
7. **Given** người dùng gõ tiếng Việt có dấu, **When** dùng ô soạn (compose) phía dưới terminal, **Then** cả dòng gửi đi
   đúng UTF-8 khi bấm Gửi, không lỗi bộ gõ.

---

### User Story 4 - Mở phiên mới từ điện thoại (Priority: P2)

Trên điện thoại, chủ máy bấm **Mở phiên mới** cho một máy đang online đã bật từ xa: chọn CLI, tài khoản (hoặc "Tự
chọn"), thư mục trong danh sách được phép (và thư mục con), tuỳ chọn task và câu mở đầu, rồi xác thực Face ID. Phiên
mở trên máy và điện thoại vào thẳng màn terminal với quyền điều khiển.

**Why this priority**: Hữu ích nhưng có thể sống bằng US3 (mở phiên tại máy trước khi đi). Rủi ro cao hơn nên làm sau.

**Independent Test**: Máy có thư mục được phép `~/code`. Từ điện thoại mở phiên `claude` trong `~/code/payment-api` →
nhận được. Thử `subdir = "../.ssh"` → `ROOT_ESCAPE`. Thử thư mục là symlink trỏ ra ngoài `~/code` → `ROOT_ESCAPE`.
Bật "Hỏi trên máy" → app hiện hộp Cho phép; không ai bấm trong 60 giây → `CONFIRM_TIMEOUT`.

**Acceptance Scenarios**:

1. **Given** máy bật từ xa với ít nhất một thư mục được phép, **When** gửi yêu cầu kèm assertion hợp lệ, **Then** worker
   mở CLI trong thư mục đã giải symlink nằm trong thư mục được phép, gửi `term_opened`, điện thoại vào phiên.
2. **Given** chưa có thư mục được phép nào, **Then** nút Mở phiên mới bị tắt với chú thích "Chưa có thư mục được phép
   trên máy".
3. **Given** yêu cầu có CLI ngoài danh sách (`bash`, `sh`, đường dẫn bất kỳ) hay đối số tự do, **Then** không gửi được
   (contract chỉ nhận enum CLI và vài tuỳ chọn có kiểu); worker cũng kiểm lại.
4. **Given** chính sách agent của tổ chức cấm model hay cấm toàn quyền, **Then** phiên mở theo chính sách đó; phiên từ
   xa không bao giờ thêm cờ bỏ hỏi quyền trừ khi chủ máy bật riêng (xem Q3).
5. **Given** chủ máy đã bật "Hỏi trên máy mỗi lần", **When** có yêu cầu, **Then** app (hoặc `hive remote watch`) hiện hộp
   xác nhận; Từ chối hoặc hết 60 giây thì trả `CONFIRM_DENIED`/`CONFIRM_TIMEOUT`.

---

### User Story 5 - Ngắt ngay, giới hạn thời gian và audit (Priority: P1)

Chủ máy luôn dừng được mọi thứ: tắt điều khiển từ xa bằng một nút trên app (cả trong menu khay), trên web hoặc
`hive remote off`; ngắt từng phiên. Hive tự thu quyền khi không hoạt động và có giới hạn thời gian. Mọi thao tác được
ghi audit trên hub và nhật ký tại máy.

**Why this priority**: Không có nút tắt và audit thì không được bật tính năng này.

**Independent Test**: Hai phiên từ xa đang mở, một điện thoại đang điều khiển. Bấm "Tắt điều khiển từ xa" trên khay →
trong ≤ 2 giây điện thoại mất quyền và bị đóng kết nối, phiên mở từ xa bị kết thúc, phiên mở tại máy vẫn chạy tại máy;
`remote.json` có `enabled: false`; audit hub có `terminal.remote_disable`, nhật ký máy có dòng tương ứng.

**Acceptance Scenarios**:

1. **Given** từ xa đang bật, **When** bấm tắt trên app/khay/`hive remote off`, **Then** worker đặt `enabled = false`,
   thu mọi quyền điều khiển từ xa, đóng người xem, kết thúc phiên mở từ xa (SIGHUP, 10 giây rồi kill), giữ phiên mở tại
   máy, gửi `term_state` cho hub.
2. **Given** chủ máy hoặc quản trị đội bấm "Tắt từ xa cho máy này" trên web, **Then** hub gửi `term_disable`, kết quả như
   trên; muốn bật lại phải làm tại máy.
3. **Given** bấm "Ngắt" một phiên trên web hoặc app, **Then** phiên kết thúc trong ≤ 10 giây, sự kiện `exit` ghi lý do
   và người ngắt.
4. **Given** phiên mở từ xa không có client nào gắn và không có output trong 2 giờ, hoặc đã chạy quá 12 giờ (mặc định,
   chỉnh tại máy), **Then** worker kết thúc phiên và gửi thông báo đẩy.
5. **Given** bất kỳ thao tác nào trong: bật/tắt, thêm/gỡ thư mục, ghép/gỡ thiết bị, mở/từ chối phiên, gắn/tách người
   xem, cấp/thu/giành quyền điều khiển, đổi kích thước, gói nhập bị từ chối, ngắt, phiên kết thúc, **Then** hub ghi
   `audit_log` (`terminal.*`) và worker ghi một dòng JSON vào `remote-audit.log` tại máy. Nội dung phím gõ không được ghi
   vào audit, chỉ số byte.
6. **Given** điện thoại bị mất, **When** chủ máy gỡ thiết bị trên app hoặc web, **Then** worker xoá thiết bị khỏi
   `remote.json`, thu mọi quyền đang cấp cho thiết bị đó; assertion sau đó của passkey ấy bị từ chối.

---

### User Story 6 - `hive attach`: xem trực tiếp và gửi chỉ dẫn từ terminal (Priority: P2)

Dev gõ `hive attach <id>` trong terminal: với run agent bình thường (giao từ bảng việc) thì xem log trực tiếp và gõ chỉ
dẫn như ô Steer trên web; với phiên tương tác trên máy này thì gắn vào PTY; với phiên trên máy khác của mình thì xem
(chỉ xem).

**Why this priority**: Tiện cho dev quen terminal; dùng lại API có sẵn.

**Independent Test**: Run code đang chạy với worker giả: `hive attach <runId>` in log mới; gõ "thêm test" rồi Enter →
hub có sự kiện `steer` và CLI in "Đã gửi chỉ dẫn (đã nhận)" khi có `steer_result.applied = true`. Với phiên ở máy khác:
`hive attach <sessionId>` hiện màn hình, phím gõ bị bỏ kèm dòng "Chỉ xem: phiên ở máy khác".

**Acceptance Scenarios**:

1. **Given** chưa `hive login`, **When** `hive attach <runId>`, **Then** báo "Chưa đăng nhập. Chạy `hive login`." mã 2.
2. **Given** run kết thúc trong lúc đang xem, **Then** in trạng thái cuối và thoát mã 0.
3. **Given** run là Codex hoặc Gemini, **When** gõ chỉ dẫn, **Then** in lý do từ `steer_result` ("CLI không nhận chỉ dẫn
   giữa chừng").
4. **Given** id không thuộc người dùng hoặc không đủ quyền xem, **Then** báo "Không tìm thấy run hoặc phiên." (không lộ
   sự tồn tại).

---

### User Story 7 - Cài web lên màn hình chính và nhận thông báo đẩy (Priority: P2)

Trên điện thoại, dev cài web của hub lên màn hình chính (PWA). Khi agent trong phiên của mình cần trả lời (Claude hỏi
quyền chạy lệnh, chờ câu tiếp), phiên kết thúc, hay có phiên mới mở từ xa, điện thoại nhận thông báo đẩy; chạm vào thì
mở thẳng màn terminal của phiên.

**Why this priority**: Không có thông báo thì dev phải mở web liên tục để biết agent đang chờ.

**Independent Test**: Chrome Android giả lập (Playwright, service worker bật): trang có manifest hợp lệ, cài được; bật
thông báo → hub lưu subscription; CLI giả gọi hook "attention" → hub gửi Web Push (kiểm bằng push service giả) với tiêu
đề "Claude đang chờ bạn" và URL `/remote/sessions/<id>`.

**Acceptance Scenarios**:

1. **Given** hub chạy HTTPS, **When** mở web trên điện thoại, **Then** có manifest (tên, icon 192/512, `display:
   standalone`, `start_url: /remote`), service worker chỉ đệm vỏ ứng dụng, không đệm dữ liệu API.
2. **Given** bật thông báo trong trang Điều khiển từ xa, **Then** trình duyệt hỏi quyền; cho phép thì hub lưu
   subscription gắn người dùng và thiết bị; tắt hoặc gỡ thiết bị thì xoá.
3. **Given** Claude Code trong phiên phát hook `Notification`, **Then** worker gửi `term_event{attention}` và hub gửi
   thông báo cho chủ phiên trong ≤ 5 giây; nội dung thông báo không chứa output terminal (chỉ tên phiên, máy, loại).
4. **Given** iOS chưa cài PWA lên màn hình chính, **Then** trang giải thích cách cài để nhận thông báo, không báo lỗi.

---

### User Story 8 - Người khác xem cùng phiên (chỉ xem) (Priority: P3)

Chủ phiên bật "Cho đội xem" để người review hay lead xem trực tiếp (ví dụ khi pair). Người xem không gõ được, không lấy
được quyền điều khiển.

**Why this priority**: Có ích khi làm cùng, không cần cho cá nhân dùng.

**Independent Test**: Chủ bật "Cho đội xem" trên phiên gắn task của dự án X. Bob (thành viên đội, có quyền xem run của
X) mở phiên: thấy trực tiếp, không có nút Điều khiển; gửi gói nhập giả qua WS → hub đóng kết nối 4403. Carol (ngoài đội)
mở → "Không tìm thấy phiên".

**Acceptance Scenarios**:

1. **Given** phiên ở chế độ riêng tư (mặc định), **Then** chỉ chủ phiên xem trực tiếp và xem bản ghi.
2. **Given** "Cho đội xem", **Then** thành viên đội của máy (với phiên gắn dự án: người có quyền xem run của dự án) xem
   trực tiếp và bản ghi; danh sách người đang xem hiện cho chủ phiên.
3. **Given** chủ tắt "Cho đội xem", **Then** người xem khác bị ngắt trong ≤ 2 giây.

---

### Edge Cases

- **Hub cũ, worker mới**: hub không gửi `welcome.features` → worker không gửi gói `term_*`; `hive chat` vẫn chạy tại máy,
  báo "Hub chưa hỗ trợ ghi phiên".
- **Hub mới, worker cũ**: `hello.capabilities` không có `terminal` → hub không gửi gói `term_*`; web hiện "Máy cần cập
  nhật worker để điều khiển từ xa".
- **Hub chạy HTTP** (không phải secure context): web không tạo/dùng passkey, không có service worker, không cài PWA/đẩy.
  Điều khiển từ xa chỉ dùng được qua đường lui TOTP (FR-033…FR-037) khi chủ máy đã bật TOTP tại máy và chính sách tổ chức
  cho phép; không thì trang Điều khiển từ xa báo "Cần hub chạy HTTPS hoặc bật mã Authenticator tại máy". Web và app hiện
  cảnh báo "Hub chạy HTTP: nội dung phiên và phím gõ không được mã hoá trên đường truyền". Ghi phiên và `hive attach` vẫn
  dùng được.
- **Hub HTTP đổi sang HTTPS** (hoặc ngược lại): passkey đã ghép gắn với origin nên không dùng được ở origin khác; TOTP
  vẫn dùng được. Worker đọc origin từ `worker.json`, không tin origin do hub báo.
- **Nhập sai mã TOTP nhiều lần**: 5 lần sai liên tiếp thì worker khoá tạm 5 phút (lần khoá sau gấp đôi, tối đa 1 giờ), từ
  chối cả mã đúng trong lúc khoá, ghi audit; chủ máy mở khoá sớm được tại máy.
- **Mã TOTP vừa dùng**: mỗi lần mở phiên hay xin quyền gõ cần một mã mới hơn mã đã nhận lần trước, nên hai thao tác liên
  tiếp trong cùng cửa sổ 30 giây phải chờ mã kế tiếp; web báo "Chờ mã mới".
- **Chính sách tổ chức tắt đường lui TOTP**: hub từ chối request kiểu TOTP (`TOTP_NOT_ALLOWED`), web không hiện ô nhập mã,
  khoá TOTP đã lưu tại máy không bị xoá nhưng không dùng được cho tới khi chính sách bật lại.
- **Mất điện thoại có app Authenticator** (khoá TOTP nằm trong app): chủ máy tắt TOTP và tạo khoá mới tại máy; khoá cũ hết
  hiệu lực ngay.
- **Worker mất kết nối hub**: PTY chạy tiếp; output vào bộ đệm đĩa (tối đa 32 MB mỗi phiên, quá thì bỏ phần cũ nhất và
  ghi sự kiện `gap`); quyền điều khiển từ xa bị thu; nối lại thì gửi bù.
- **Hub khởi động lại**: bộ đệm vòng trong bộ nhớ mất; client nối lại được phát lại từ `terminal_chunks`.
- **Output dồn dập** (`cat` file lớn, build log): hub cắt luồng trực tiếp quá 512 KB/s mỗi người xem; client chậm (đệm WS
  > 1 MB) bị bỏ khung và nhận "đồng bộ lại" (reset + đuôi 256 KB). Bản ghi vẫn đủ.
- **Hai thiết bị cùng xin điều khiển**: thiết bị sau được (đều của chủ máy), thiết bị trước chuyển chỉ xem với thông báo.
- **Assertion bị phát lại**: nonce đã thấy hoặc lệch giờ quá 120 giây → từ chối `ASSERTION_REPLAY`/`ASSERTION_STALE`.
- **Đồng hồ máy lệch**: worker so `ts` với giờ của chính nó; lệch quá 120 giây thì báo "Đồng hồ máy lệch" cho chủ.
- **Passkey đồng bộ** (iCloud Keychain, Google Password Manager): một passkey dùng được trên các thiết bị cùng tài khoản
  nền tảng; danh sách thiết bị ghi rõ "passkey đồng bộ" khi trình duyệt báo `backupEligible`.
- **Tài khoản CLI hết lượt giữa phiên**: CLI tự báo trong terminal; worker đánh dấu cooldown như run (FR-033 spec 008)
  nhưng không giết phiên.
- **Máy bị thu hồi** (FLEET-03): worker mất kết nối; phiên tại máy chạy tiếp, mọi đường từ xa đóng.
- **Chủ máy bị khoá hoặc rời tổ chức**: hub từ chối mọi route `terminal.*` của người đó; phiên đang xem bị đóng.
- **Đổi chủ máy** (đăng ký lại bởi người khác): `remote.json` bị xoá thiết bị khi `registered_by` đổi (worker so người
  dùng trong `welcome`), phải ghép lại.
- **Windows**: PTY qua ConPTY; socket nội bộ là named pipe; phím tách giống nhau.
- **Thư mục được phép bị xoá hoặc đổi tên**: yêu cầu mở phiên trong đó trả `ROOT_MISSING`.
- **Phiên có output là chuỗi điều khiển độc** (OSC 52 ghi clipboard, OSC 8 link): web tắt OSC 52; link chỉ mở khi người
  dùng chạm và xác nhận.

## Requirements *(mandatory)*

### Functional Requirements

CLI `hive` (US1, US6)

- **FR-001 (RMT-01)**: Bản phát hành MUST có binary `hive` (từ `worker/cmd/hive`, cùng module Go với worker) trong cùng
  gói đã ký với `hive-worker`; `hive-worker update` MUST thay cả hai; app desktop MUST kèm `hive` làm sidecar và có mục
  "Cài lệnh hive vào PATH".
- **FR-002 (RMT-01)**: `hive login` MUST đăng nhập bằng trình duyệt (loopback RFC 8252 + PKCE như app, mục đích `cli`,
  chỉ cấp token cá nhân, không cấp mã đăng ký máy) hoặc `--with-token` đọc từ stdin; token MUST lưu trong keychain của
  hệ điều hành (cùng mục `dev.xdev.hive`/URL hub với app khi định dạng tương thích), không có keychain thì file 0600 kèm
  cảnh báo. Có `hive logout`, `hive whoami`.
- **FR-003 (RMT-02)**: `hive run [lời nhắc]` và `hive chat` (không lời nhắc) MUST nhờ worker mở phiên tương tác trong thư
  mục hiện tại với `--cli`, `--account`, `--model`, `--task`, `--project`, `--no-record`, `--no-remote`, `--force`; CLI
  MUST đưa terminal vào raw mode, chuyển kích thước cửa sổ (SIGWINCH / sự kiện console) và khôi phục terminal khi thoát.
- **FR-004 (RMT-02)**: Worker MUST chọn tài khoản cho phiên bằng bộ chọn của `accounts.json` với vai trò `interactive`:
  bỏ tài khoản tắt hoặc chưa đăng nhập; tài khoản đang nghỉ chỉ dùng khi `--force`; **không** áp ngưỡng dừng; phiên tính
  vào số đang dùng của tài khoản trong suốt thời gian sống.
- **FR-005 (RMT-02)**: `hive ls`, `hive attach <id>`, `hive kill <id>` MUST làm việc với phiên trên máy qua socket nội
  bộ; phím tách mặc định `Ctrl-]` `d`, giành quyền `Ctrl-]` `t`, đổi được bằng `--escape`.
- **FR-006 (RMT-08)**: `hive attach <runId>` MUST in log trực tiếp qua SSE có sẵn (nối lại theo `Last-Event-ID`) và gửi
  mỗi dòng nhập thành `runs.steer`, in kết quả `steer_result`; với phiên ở máy khác MUST chỉ xem.

Worker giữ phiên (US1, US3)

- **FR-007 (RMT-02)**: Worker MUST mở socket nội bộ (Unix socket 0600 trong thư mục 0700 của worker, kiểm UID của tiến
  trình kết nối; Windows: named pipe chỉ cho người dùng hiện tại) với bắt tay phiên bản; khác phiên bản thì báo cập nhật.
- **FR-008 (RMT-02)**: Worker MUST chạy CLI trong PTY (ConPTY trên Windows) với biến môi trường theo danh sách cho phép
  như run (không có machine token, token cá nhân, biến `HIVE_*`), giữ PTY khi mọi client tách, và chỉ có **một** người
  điều khiển tại một thời điểm.
- **FR-009 (RMT-03)**: Worker MUST gửi output của phiên được ghi lên hub bằng `term_output{sessionId, offset, bytes}` gom
  tối đa 8 ms hoặc 32 KiB, giữ phần chưa ack trên đĩa (tối đa 32 MB mỗi phiên) và gửi lại khi nối lại; hub loại trùng theo
  `(session_id, offset)`.
- **FR-010 (RMT-03)**: Worker MUST che giá trị bí mật đã biết (machine token, token cá nhân, run token) trong output trước
  khi gửi lên hub.

Giao thức (US1–US5)

- **FR-011 (IF-07, RMT-03)**: `worker-protocol.ts` MUST thêm các gói `term_*` (bảng trong [plan.md](plan.md#giao-thức))
  mà không tăng `PROTOCOL_VERSION`; worker khai `terminal` trong `hello.capabilities`, hub khai `features: ["terminal"]`
  trong trường tuỳ chọn mới của `welcome`; mỗi bên chỉ gửi gói `term_*` khi bên kia đã khai. Fixture dùng chung
  `worker-protocol.json` MUST có mẫu cho mọi gói mới.

Bật từ xa và ghép thiết bị (US2)

- **FR-012 (RMT-04)**: Điều khiển từ xa MUST mặc định tắt; chỉ bật được qua socket nội bộ (app desktop hoặc
  `hive remote on`), lưu trong `remote.json` (0600). Hub MUST không có gói hay route bật từ xa, thêm thư mục được phép
  hay thêm thiết bị.
- **FR-013 (RMT-04)**: Worker MUST từ chối bật từ xa khi chạy chế độ `host` hoặc khi hub báo máy là máy dùng chung; hub
  MUST từ chối mọi route điều khiển từ xa với máy dùng chung, runner host, và người không phải chủ máy
  (`MACHINE_NOT_YOURS`).
- **FR-014 (RMT-05)**: Ghép thiết bị MUST đi theo: worker tạo mã ghép một lần (10 phút) gồm `pairId` và bí mật 128 bit
  đặt trong phần fragment của URL QR; điện thoại tạo passkey (WebAuthn, `userVerification: required`, rpId là host của
  hub) và gửi khoá công khai SPKI, `credentialId`, nhãn và HMAC-SHA256(bí mật, SPKI‖credentialId‖userId); worker kiểm
  HMAC, hiện hộp xác nhận tại máy, chỉ lưu thiết bị khi chủ máy bấm Cho phép.
- **FR-015 (RMT-05)**: Gỡ thiết bị MUST làm được tại máy và trên web (hub gửi `term_device_revoke`); worker thu mọi quyền
  của thiết bị ngay.

Mở phiên và điều khiển từ xa (US3, US4)

- **FR-016 (RMT-06)**: Mọi yêu cầu mở phiên từ xa và xin quyền điều khiển MUST kèm assertion WebAuthn có cờ UP và UV, với
  `challenge = SHA-256(JSON chuẩn hoá {machineId, action, params, ephPub, ts, nonce})`; worker MUST kiểm chữ ký ES256 bằng
  khoá của thiết bị đã ghép, `origin` bằng URL hub trong `worker.json`, `rpIdHash`, `ts` trong ±120 giây, `nonce` chưa
  dùng (bộ nhớ 10 phút), `signCount` không lùi (khi khác 0), và người dùng trong yêu cầu bằng người đã ghép thiết bị.
  Khi hub chạy HTTP, yêu cầu có thể mang mã TOTP thay cho assertion theo FR-033…FR-037; hub MUST không bao giờ chấp nhận
  mã TOTP thay cho assertion trên origin HTTPS khi thiết bị đã ghép passkey, trừ khi chủ máy bật riêng tại máy.
- **FR-017 (RMT-06)**: Khi cấp quyền điều khiển, điện thoại và worker MUST suy ra khoá phiên bằng ECDH P-256 (khoá tạm
  của điện thoại nằm trong `params` đã ký) và HKDF-SHA256; mọi `term_input` và `term_resize` từ điện thoại MUST mang
  `seq` tăng nghiêm ngặt và HMAC-SHA256 (cắt 16 byte) trên `connId‖seq‖data`; worker bỏ gói sai.
- **FR-018 (RMT-06)**: Mở phiên từ xa MUST chỉ nhận CLI trong enum `cli` mà máy có, tài khoản trong `accounts.json`,
  `rootId` trong danh sách thư mục được phép và `subdir` tương đối; worker MUST giải symlink và từ chối đường dẫn ra ngoài
  thư mục được phép (`ROOT_ESCAPE`); không nhận lệnh, đối số tự do hay biến môi trường từ xa.
- **FR-019 (RMT-06)**: Phiên mở từ xa MUST áp chính sách agent của tổ chức như run (model, mức quyền) và MUST NOT chạy chế
  độ bỏ hỏi quyền trừ khi chủ máy bật riêng "Cho phiên từ xa chạy toàn quyền" tại máy và chính sách cho phép.
- **FR-020 (RMT-06)**: Chủ máy MUST chọn được "Hỏi trên máy mỗi lần" (mặc định tắt); khi bật, worker chờ xác nhận tại máy
  tối đa 60 giây.
- **FR-021 (RMT-07)**: Quyền điều khiển MUST hết khi không có phím 15 phút (mặc định, 1–120); mất kết nối ≤ 2 phút thì nối
  lại dùng tiếp khoá cũ, quá thì xin lại. Terminal tại máy MUST luôn giành lại được quyền.

Ngắt và giới hạn (US5)

- **FR-022 (RMT-07)**: Tắt từ xa (app, khay, `hive remote off`, web) MUST trong ≤ 2 giây thu mọi quyền từ xa, đóng người xem
  từ xa, kết thúc phiên mở từ xa và giữ phiên mở tại máy.
- **FR-023 (RMT-07)**: Worker MUST kết thúc phiên không có client và không có output 2 giờ, và phiên mở từ xa chạy quá 12 giờ
  (mặc định, chỉnh tại máy).
- **FR-024 (RMT-07)**: Chủ phiên và quản trị đội MUST ngắt được phiên trên web; chủ máy ngắt được trên app và `hive kill`.

Hub, web, ghi lại (US1, US3, US7, US8)

- **FR-025 (RMT-03)**: Module hub `terminal` MUST lưu phiên (`terminal_sessions`), output (`terminal_chunks`, gộp tới
  64 KiB hoặc 1 giây), sự kiện (`terminal_events`), bản sao danh sách thiết bị (`remote_devices`) và subscription đẩy
  (`push_subscriptions`); RLS bật và ép; bản ghi xoá theo số ngày lưu log của chính sách agent.
- **FR-026 (IF-07)**: Hub MUST mở `/ws/terminal` nhận vé dùng một lần 60 giây từ `terminal.ticket`, kiểm `Origin`, phát
  output trực tiếp từ bộ đệm vòng 512 KiB mỗi phiên và nối lại theo offset; người xem chỉ nhận output và trạng thái; gói
  nhập từ kết nối không phải người điều khiển bị đóng 4403.
- **FR-027 (RMT-09)**: Web MUST có các màn: danh sách máy và phiên (`/remote`), terminal (`/remote/sessions/:id`, xterm.js,
  thanh phím Esc, Tab, Ctrl giữ, mũi tên, Ctrl-C, ô soạn dòng cho bộ gõ tiếng Việt, cỡ chữ), mở phiên mới, ghép thiết bị
  (`/remote/pair`), thiết bị; dùng được ở 360 px, sáng và tối.
- **FR-028 (RMT-10)**: Web MUST là PWA (manifest, icon, service worker chỉ đệm vỏ ứng dụng) và gửi Web Push (VAPID) khi
  agent cần trả lời (hook `Notification` của Claude Code; với CLI khác: không có output 60 giây sau khi có dấu nhắc — xem
  plan), khi phiên kết thúc và khi có phiên mở từ xa; thông báo không chứa output.
- **FR-029 (RMT-11)**: Phiên mặc định riêng tư (chỉ chủ xem); chủ bật "Cho đội xem" thì thành viên đội (phiên gắn dự án:
  người có quyền xem run của dự án) xem trực tiếp và bản ghi, không bao giờ điều khiển.
- **FR-030 (RMT-03)**: Phiên gắn task MUST hiện trong trang task (mục "Phiên tương tác"); hub kiểm task thuộc dự án của đội
  máy và chủ máy có quyền giao run, không thì bỏ liên kết và ghi sự kiện.

App desktop (US2, US5)

- **FR-031 (RMT-12)**: App MUST có màn **Điều khiển từ xa**: công tắc (xác nhận khi bật), thư mục được phép, thiết bị đã
  ghép (ghép bằng QR, gỡ), tuỳ chọn "Hỏi trên máy", thời gian chờ, danh sách phiên (nguồn tại máy/từ xa, ai điều khiển,
  thiết bị, thời gian) với nút Ngắt và "Ngắt tất cả"; khay có "Tắt điều khiển từ xa ngay" khi đang bật; thông báo hệ điều
  hành khi có phiên mở từ xa hoặc thiết bị giành quyền; mục "Mã Authenticator (TOTP)" (bật, QR, tắt, mở khoá) và cảnh
  báo khi hub chạy HTTP. Chữ theo từ điển vi/en.

Đường lui TOTP khi hub chạy HTTP (US2, US3, US4)

- **FR-033 (RMT-13)**: Worker MUST hỗ trợ TOTP (RFC 6238: HMAC-SHA1, 6 số, bước 30 giây, cho lệch ±1 bước) làm đường lui khi
  origin hub trong `worker.json` là HTTP. Khoá 160 bit MUST do worker tạo tại máy (qua socket nội bộ: app hoặc
  `hive remote totp enroll`), lưu cạnh `remote.json` (0600, hoặc keychain khi có), hiện bằng QR `otpauth://` để quét vào
  app Authenticator và chỉ được lưu sau khi chủ máy nhập một mã đúng. Hub MUST không bao giờ nhận hay lưu khoá. Khoá chỉ
  bật, đổi hay tắt được tại máy.
- **FR-034 (RMT-13)**: Worker MUST tự kiểm mã TOTP cho mỗi lần mở phiên (`term_start`) và mỗi lần xin quyền gõ
  (`term_control`) (hub chỉ chuyển tiếp mã, không có quyền quyết định); mỗi thao tác cần mã mới, MUST từ chối mã có bước
  thời gian không lớn hơn bước của mã đã nhận gần nhất (`TOTP_REPLAY`), kể cả sau khi worker khởi động lại (lưu bước cuối
  ra đĩa). Nối lại bằng `resumeToken` (FR-021) không cần mã mới.
- **FR-035 (RMT-13)**: Worker MUST giới hạn mã sai: 5 lần sai liên tiếp thì khoá mọi yêu cầu TOTP 5 phút, mỗi lần khoá liền
  sau gấp đôi (tối đa 1 giờ); trong lúc khoá từ chối cả mã đúng (`TOTP_LOCKED`); bộ đếm tính theo máy (không theo
  kết nối hay người dùng), lưu ra đĩa; chủ máy MUST mở khoá được tại máy.
- **FR-036 (RMT-13)**: Mọi thao tác TOTP MUST có dòng `audit_log` (`terminal.totp_enroll|totp_disable|totp_ok|totp_fail|
  totp_locked`) và dòng trong `remote-audit.log`; không ghi mã hay khoá.
- **FR-037 (RMT-13)**: Chính sách tổ chức MUST có tuỳ chọn tắt đường lui TOTP; hub MUST từ chối request kiểu TOTP khi tắt
  (`TOTP_NOT_ALLOWED`) và báo trạng thái cho worker trong `welcome.policy`. App desktop và web MUST hiện cảnh báo khi bật
  điều khiển từ xa hay mở phiên trên hub HTTP: "Hub chạy HTTP: nội dung phiên và phím gõ đi qua mạng không mã hoá, chỉ
  dùng trong mạng nội bộ". Passkey vẫn là cách chính; trên hub HTTPS web MUST dùng passkey và không hiện ô nhập mã TOTP.

Audit (US5)

- **FR-032 (RMT-07)**: Mọi thao tác ở US5 kịch bản 5 MUST có dòng `audit_log` (`terminal.<động từ>`, kèm máy, phiên, thiết
  bị, người) và dòng trong `remote-audit.log` tại máy (xoay vòng 10 MB × 5); không ghi nội dung phím.

### Key Entities

- **Phiên** (`terminal_sessions`): máy, chủ, nguồn (`local`/`remote`), CLI, nhãn tài khoản, thư mục (nhãn đường dẫn),
  dự án/task tuỳ chọn, chế độ xem (`private`/`team`), trạng thái (`running`, `exited`, `killed`, `lost`), kích thước,
  mã thoát, thời gian.
- **Đoạn output** (`terminal_chunks`): byte output theo offset của một phiên.
- **Sự kiện phiên** (`terminal_events`): mở, gắn/tách, cấp/thu quyền, đổi kích thước, cần trả lời, gap, kết thúc.
- **Thiết bị đã ghép**: nguồn thật ở `remote.json` của máy (khoá công khai, credentialId, người dùng, nhãn, thời điểm);
  hub giữ bản sao `remote_devices` để hiển thị và gỡ.
- **Cấu hình từ xa của máy** (`remote.json`): bật/tắt, thư mục được phép (`id`, đường dẫn, nhãn), thiết bị, hỏi trên máy,
  thời gian chờ, cho toàn quyền.
- **Khoá TOTP của máy** (`totp.json` 0600 hoặc keychain): khoá 160 bit, bước mã nhận gần nhất, số lần sai liên tiếp, thời
  điểm hết khoá tạm. Chỉ nằm ở máy; hub chỉ biết "TOTP đã bật" qua `term_state`.
- **Subscription đẩy** (`push_subscriptions`): endpoint và khoá Web Push của một trình duyệt của người dùng.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 0 cách mở phiên hay đưa phím vào phiên khi chỉ có quyền trên hub (phiên web bị đánh cắp, quyền quản trị hub,
  ghi thẳng database): bộ test tấn công trong `worker` và `hub` (gói giả mạo assertion, phát lại, đổi khoá ghép, gói nhập
  không HMAC, gửi `term_start` khi tắt) đều bị từ chối.
- **SC-002**: Độ trễ phím → thấy chữ trên điện thoại ≤ RTT(điện thoại↔hub) + RTT(hub↔máy) + 60 ms ở p95, đo bằng test e2e
  với CLI giả và mạng giả lập (độ trễ 50 ms mỗi chặng).
- **SC-003**: Mở phiên đang chạy trên điện thoại tới khi thấy màn hình hiện tại ≤ 2 giây (p95) với đuôi 512 KiB.
- **SC-004**: Mất mạng ≤ 2 phút thì nối lại không mất byte output (so offset với bản ghi) và không hỏi passkey, 100% trong
  test e2e.
- **SC-005**: Tắt từ xa có hiệu lực (điện thoại mất quyền và kết nối) ≤ 2 giây sau khi bấm, đo trong test e2e.
- **SC-006**: 100% thao tác liệt kê ở US5 kịch bản 5 có dòng audit trên hub và tại máy (test DB và test Go).
- **SC-007**: Màn danh sách và màn terminal dùng được ở 360 px không cuộn ngang trang (terminal tự co cỡ chữ hoặc cuộn
  riêng trong khung), sáng và tối (NFR-11, Playwright).
- **SC-008**: Một hub với 50 phiên trực tiếp, mỗi phiên 3 người xem và 20 KB/s output: CPU tiến trình `api` tăng ≤ 15%
  và không mất khung với người xem nhanh (test hiệu năng).
- **SC-009**: Từ lúc cài app tới khi điều khiển được phiên đầu tiên trên điện thoại ≤ 3 phút cho người dùng mới theo
  hướng dẫn trên màn (đo thủ công trước khi phát hành).
- **SC-010**: Worker và hub ở mọi tổ hợp cũ/mới vẫn chạy run như trước; test `worker_e2e_test.go` và `fleet.db.test.ts`
  hiện có xanh không sửa.
- **SC-011**: Với hub HTTP: chỉ có quyền trên hub (phiên web đánh cắp, token cá nhân, ghi DB) mà không có mã TOTP thì 0
  cách mở phiên hay xin quyền gõ; mã sai, mã dùng lại, mã khi đang khoá, request khi chính sách tắt TOTP đều bị từ
  chối (test tấn công, mở rộng SC-001). Spec nêu rõ giới hạn còn lại: trên HTTP kẻ nghe được đường truyền hoặc hub bị chiếm
  thấy được mã và output, nên mức chống hub bị chiếm của passkey (SC-001) không áp cho đường lui TOTP.
- **SC-012**: 5 lần nhập sai liên tiếp thì lần thứ 6, dù mã đúng, bị `TOTP_LOCKED`; bộ đếm và bước mã cuối còn nguyên sau
  khi worker khởi động lại (test Go).
- **SC-013**: 100% thao tác TOTP (bật, tắt, đúng, sai, khoá) có dòng audit trên hub và tại máy (như SC-006).

## Out of Scope

- App mobile riêng (iOS/Android native).
- Shell tuỳ ý từ xa: chỉ mở được agent CLI trong danh sách; không có `hive shell`.
- Điều khiển (gõ) từ một terminal ở máy khác (`hive attach` từ xa chỉ xem); ghép "thiết bị" là CLI để sau.
- Mã hoá đầu-cuối output (hub không đọc được); để sau như tuỳ chọn "không ghi lại".
- Mã hoá đường truyền cho hub HTTP (làm bằng HTTPS ở tầng hạ tầng); TOTP không thay được việc đó.
- Điều khiển từ xa trên máy dùng chung và runner host (container sandbox).
- Chuyển phiên tương tác thành run (giao lại cho agent không tương tác) và ngược lại.
- Gắn MCP của hub tự động vào phiên tương tác (dev đã cài token MCP qua AppSetup, DESK-08).
- Tách số liệu token/chi phí của phiên tương tác vào báo cáo chi phí (OPS-03); có thể đọc transcript sau.
- Nhiều tiến trình `api` chia nhau kết nối terminal (theo NFR-15).
- Truyền file, xem diff hay trình soạn thảo trên điện thoại ngoài terminal.

## Assumptions

- Hub dùng thật chạy HTTPS (Caddy profile `https` hoặc proxy công ty). Hub HTTP (như hub nội bộ
  `http://10.86.224.34:3000`) có ghi phiên, `hive attach` và điều khiển từ xa qua đường lui TOTP, không có passkey, PWA và
  thông báo đẩy.
- Điện thoại dùng iOS 16.4+ (Safari, Web Push khi đã cài lên màn hình chính) hoặc Android với Chrome/Edge mới; trình
  duyệt hỗ trợ passkey với xác thực sinh trắc hoặc mã máy.
- Worker trên máy dev chạy dưới tài khoản hệ điều hành của chủ máy (sidecar của app hoặc user service, FLEET-02).
- Claude Code hỗ trợ hook `Notification` khi chạy tương tác; CLI khác dùng cách đoán theo thời gian im lặng.
- Một tiến trình `api` giữ mọi kết nối worker như hiện nay; terminal đi cùng tiến trình đó.

## Clarifications

Product owner chốt ngày 2026-10-13.

- **Q1, ai xem được phiên**: Mặc định riêng tư, chỉ chủ xem trực tiếp và bản ghi; chủ bật "Cho đội xem" cho từng phiên
  (US8, FR-029). Phiên gắn task không tự cho đội xem.
- **Q2, hub chạy HTTP**: **Khác đề xuất ban đầu.** Cho mã TOTP làm đường lui khi hub chạy HTTP (ví dụ hub nội bộ
  `http://10.86.224.34:3000`). Passkey vẫn là cách chính khi có HTTPS. TOTP: khoá do worker giữ (tạo và ghép tại máy,
  quét QR bằng app Authenticator), worker tự kiểm mã (hub không kiểm được thay), mỗi lần mở phiên hay xin quyền gõ cần
  mã mới, chống dùng lại mã, giới hạn số lần sai rồi khoá tạm, có audit (FR-033…FR-037). Rủi ro đã chấp nhận: trên HTTP
  nội dung phiên và phím gõ đi qua mạng không mã hoá, và mã TOTP đi qua hub nên kẻ nghe đường truyền hoặc hub bị chiếm
  có thể dùng mã đó trong cửa sổ 30 giây trước khi người dùng dùng, nên đường lui này chỉ nên dùng trong mạng nội bộ.
  Giảm thiểu: app desktop và web hiện cảnh báo khi bật điều khiển từ xa trên hub HTTP; tổ chức tắt được đường lui bằng
  chính sách; TOTP vẫn chặn phiên web hay token bị đánh cắp đơn thuần.
- **Q3, toàn quyền cho phiên từ xa**: Phiên mở từ xa không chạy toàn quyền, trừ khi chủ máy bật riêng tại máy **và**
  chính sách tổ chức cho phép (FR-019).
- **Q4, lát đầu: Terminal Leader trên máy dùng chung (2026-10-13)**: Làm trước phần máy **dùng chung** trên web máy tính
  (chưa PWA điện thoại, chưa passkey/TOTP): "AI SDLC trên web dùng xterm.js làm Leader và mở Claude CLI vào đó để nói
  chuyện". Máy dùng chung không có "chủ máy" để giữ passkey, nên xác thực bằng **phiên web + vai trò + audit**: chỉ quản
  trị đội và BA/PO (quyền `leader.terminal`) của đội sở hữu dự án mở phiên; phiên riêng tư, chủ phiên bật "Cho đội xem"
  (chỉ xem, như Q1). Claude có hai chế độ thao tác hub: Đề xuất (mặc định) và Bypass (chọn khi mở, có xác nhận, audit
  từng lần gọi tool). Quyền trên máy theo ADR 0020: toàn quyền khi máy bật cho dự án và tổ chức cho `allowFullPermission`,
  không thì Accept edits trong worktree tạm của phiên; không đẩy. **Máy cá nhân vẫn chưa mở được từ xa**: hub và worker
  đều từ chối `term_open` cho máy không dùng chung tới khi có passkey của US2–US4. Xem plan.md mục "Lát đầu" và tasks
  T100–T107.
