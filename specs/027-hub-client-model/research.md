# Research: Hub giữ dữ liệu và tiến độ, client làm việc qua công cụ trên máy

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-21

Kiểm trong code `main` tại `2881aad2`. Đường dẫn tính từ gốc repo; `hub/` là `apps/hub/src/modules/`.

## 1. Hiện trạng đã kiểm

### 1.1 Đường ghi lên hub

| Đường | Ở đâu | Chống trùng hôm nay |
|---|---|---|
| Gói của run (`run_event`, `log_chunk`, `run_result`) | `worker/internal/channel/jobs.go:602-636` ghi `DataDir/pending/<run>-<attempt>-<seq>.json` rồi gửi; hub `hub/runs/engine.ts:1158,1224,1246` | `UNIQUE(run_id, attempt, seq)` ở `run_events` (`hub/runs/schema.ts:211`); `run_logs` theo `offset` (`:237`) |
| Tool MCP có ghi | `hub/runs/mcp.ts`, `hub/knowledge/mcp-tools.ts`, `hub/sdlc/mcp-tools.ts`, `hub/leader/mcp-tools.ts`, `hub/artifacts/mcp-tools.ts` | Không có. Vài tool có `baseVersion` (`doc_propose`, `skill_propose`, `artifact_update`), `sdlc_report` ghi đè nên tự lặp được |
| Desktop qua oRPC | `apps/desktop/src-tauri/src/hub.rs:171-225` (`hub_rpc`) | Không có. Lệnh ghi duy nhất: `memory.write` (`apps/desktop/src/components/memory-hub-sync.tsx:153`) |
| Desktop gọi tool MCP ghi | `propose_doc` (`src-tauri/src/cli.rs:1247`), `propose_skill` (`src-tauri/src/skills.rs:~345`) | Không có |
| `hive mcp` | `worker/cmd/hive/mcp.go:148-199`: chuyển thẳng stdio → `POST {hub}/mcp` kèm PAT | Không có, không xếp hàng, không phân biệt đọc/ghi |

- `runTool` (`hub/mcp/server.ts:40-117`) là điểm chung của mọi tool MCP: mở transaction tenant, gọi handler, ghi
  `recordAudit("mcp.<tên>")` trong cùng transaction (`:91`); lỗi thì ghi audit `outcome: "error"` ở transaction riêng
  (`:107`).
- Cờ `readOnly` của tool **không** cho biết tool có ghi hay không: nhiều tool ghi đặt `readOnly: true` để Claude gọi
  được trong plan mode (`review_submit`, `plan_submit`, `doc_comment`, `sdlc_report`, `artifact_create`…).
- Principal của `/mcp` (`hub/mcp/principal.ts:5-26`): `user` (PAT `hive_pat_*` hoặc OAuth) hay `run` (run token).
  Không có danh tính máy; bảng PAT `mcp_user_tokens` không có `machine_id` (`hub/mcp/schema.ts:41-50`).
- Tiền lệ khoá chống trùng: `projects.idempotencyKey` (`hub/catalog/projects.ts:409-501`), `deliveryId` của webhook SCM.

### 1.2 Trạng thái task và run

- Không có máy trạng thái cho task. Enum ở `hub/tasks/schema.ts:26`. Luật rải rác: `updateTask`
  (`hub/tasks/tasks.ts:244-270`), `setTaskStatus` (`:89`), `cancelTask` (`:327`); engine đổi task qua `setTaskStatus`.
- `transition()` của run (`hub/runs/state.ts:116`) không kiểm cặp from→to.
- Không có bảng lịch sử task. `run_events` và `audit_log` không có cột nguồn, máy, thời điểm tạo trên máy.

### 1.3 Socket cục bộ và hộp chờ của worker

- Socket ADR 0019 (`worker/internal/localipc`): JSON một dòng (≤ 64 KiB), bắt tay `hello`; Unix kiểm UID, Windows
  kiểm SID và DACL pipe `\\.\pipe\xdev-hive-<SID>` (`listen_windows.go:25-50`). Op hiện có: `session.*`, `watch`,
  `remote.*`, `remote.totp.*`, `worker.status`.
- Client: `hive` CLI (`localipc.Dial`), VS Code extension (`apps/vscode/src/worker/ipc.ts`). Desktop **không** mở socket,
  mà chạy sidecar `hive … --json` (`src-tauri/src/remote.rs:72,390`).
- `DataDir` = `os.UserCacheDir()/xdev-hive/worker` (`worker/internal/repolock/repolock.go:29`). Ghi tạm rồi đổi tên,
  quyền 0600 (`jobs.go:662,673`).

### 1.4 Log run và terminal

- Worker cắt output thành `log_chunk` 16 KiB (`worker/internal/runner/runner.go:1152-1172`). **Không giữ bản nào trên
  máy** sau khi hub ack.
- Hub lưu `hive.run_logs` (bytea), xoá theo `policy.limits.runLogRetentionDays` (`0050_agent_policies.sql:19-33`,
  `hub/runs/retention.ts`).
- Web đọc qua SSE `GET /api/v1/runs/:id/stream` (`hub/runs/stream.ts:110-190`); desktop poll `hub.runs.logs`
  (`apps/desktop/src/screens/home-screen.tsx:570`).
- PTY: `term_output` lên hub, hub chạy `maskSecrets` (`hub/terminal/mask.ts:21`) rồi lưu `terminal_chunks`.
- Che secret: worker có `terminal/redact.go` (chỉ PTY) và `runner/checks.go:113` (chỉ lệnh kiểm tra); contracts có
  `redactSecrets` (`packages/contracts/src/secret-scan.ts:148`) dùng chung fixture với `checks.go`. **`log_chunk` và
  `agent_report` không qua bước che nào.**
- Chính sách giữ log **không** gửi xuống worker: `welcome` chỉ có `sessionId`, `heartbeatSec`, `accessTokenExp`,
  `features`, `owner`, `policy.totpFallback` (`packages/contracts/src/worker-protocol.ts:323-341`).

### 1.5 Token

- Machine token `hwm_` sống tới khi thu hồi, băm SHA-256 (`hub/fleet/tokens.ts`); nằm dạng chữ trong `worker.json` 0600
  (`worker/internal/config/config.go:53-82`).
- Có sẵn chỗ trống chưa dùng: cột `machines.public_key` (`hub/fleet/schema.ts:65`), `RegisterInput.publicKey`
  (`packages/contracts/src/fleet.ts:171`), `welcome.accessTokenExp` (`worker-protocol.ts:328`).
- Run token: HS256 tự viết, khoá HKDF từ `HIVE_AUTH_SECRET`, `aud=<publicUrl>/mcp`, hạn bằng `timeoutSec` của run
  (`hub/runs/token.ts`).
- Git trong run: clone và push bằng thông tin git sẵn có trên máy (`runner.go:723,811`). `gitexec` đã có askpass với
  token theo host (`worker/internal/gitexec/askpass.go`) nhưng chỉ dùng cho nhóm Git của desktop.
- Hub giữ kết nối SCM mã hoá bằng khoá chủ: GitHub App (`installation_id`), PAT GitHub, token GitLab
  (`hub/scm/schema.ts:30-38`, `hub/scm/github.ts:227-246`).
- PAT desktop và CLI: `hive_pat_…`, 90 ngày. Desktop giữ trong keychain (`src-tauri/src/account.rs`); CLI dùng
  go-keyring, **rơi về `hive.json`** khi không có keychain (`worker/cmd/hive/login.go:53,262-264`).
- MCP OAuth: Better Auth `jwt()` + `mcp()` + `cimd()`, token có `aud=/mcp` (`hub/identity/auth.ts:391-405`).

### 1.6 Vận hành

- `HIVE_ROLES` (`hub/platform/config.ts:118-125`), mặc định `api,jobs`. **Không tách được ngay**: socket của máy nằm
  trong bộ nhớ (`hub/fleet/connections.ts:17`), timer giao run (`offer`, `lease`, `dispatch`, `verify`) phải chạy cùng
  tiến trình với gateway (`hub/runs/engine.ts:744,2515-2523,3276`, `main.ts:194-195`).
- `/api/v1/health` (`hub/system/router.ts:17-25`) không có thông tin database.
- Backup: `deploy/backup.sh` (`pg_dump`), `restore.sh`, `remote-backup.sh`. PITR chỉ có ở `docs/architecture.md:480`
  dưới dạng **[Chưa làm]**.
- Không có trang hay tài liệu liệt kê dữ liệu hub giữ.
- ADR mới nhất là 0031; số trống kế tiếp là **0032**.

## 2. Quyết định

### R1. Khoá chống trùng đi bằng header, lưu ở một bảng chung

- **Decision**: client gửi `Idempotency-Key`, `X-Hive-Source`, `X-Hive-Machine`, `X-Hive-Created-At` cho mọi lần ghi
  qua `/mcp` và `/rpc`. Hub ghi bảng `hive.client_events` với `UNIQUE (org_id, idempotency_key)`, trong **cùng
  transaction** với lần ghi nghiệp vụ, ở hai chỗ chung: `runTool` (MCP) và một middleware oRPC cho thủ tục có cờ
  `clientEvent`. Lần gửi trùng trả kết quả đã lưu với `outcome: "duplicate"`.
- **Rationale**: mọi đường ghi ngoài run đều đi qua hai chỗ này, nên không phải sửa từng tool. Header không đổi schema
  tham số của tool (agent không phải biết khoá). Lưu `response` để lần gửi lại nhận đúng kết quả cũ, cần cho proxy MCP
  trả lời agent.
- **Alternatives**: `_meta` trong `tools/call` của MCP: chỉ có ở MCP, không có ở oRPC; vẫn đọc `_meta` làm đường phụ.
  Khoá theo từng bảng nghiệp vụ: phải sửa hơn 15 tool và bảng. Redis/bộ nhớ: trái constitution VII, mất khi khởi động lại.

### R2. Bị từ chối là kết quả, không phải lỗi mạng

- **Decision**: lỗi nghiệp vụ của handler (ForbiddenError, ConflictError, NotFoundError, BadRequestError và lỗi oRPC
  4xx) thành `outcome: "rejected"` kèm `code` và `reason` tiếng Việt, ghi ở transaction riêng sau khi transaction chính
  rollback. Lỗi 5xx, mất mạng, 429 là lỗi tạm: client giữ mục và thử lại.
- **Rationale**: FR-003 và US2 cảnh 4 cần phân biệt "hub không nhận" với "hub chưa trả lời". Ghi lại lần từ chối để gửi
  lại cùng khoá nhận đúng lần từ chối đó, không chạy lại handler với trạng thái đã khác.
- **Alternatives**: không lưu lần từ chối: gửi lại có thể được nhận ở trạng thái mới, làm thứ tự sự kiện sai.

### R3. Hộp thư đi nằm trong `hive-worker`, mọi client vào qua socket cục bộ

- **Decision**: gói mới `worker/internal/outbox`. Mỗi mục là một file JSON trong
  `DataDir/outbox/<khoá danh tính>/<ulid>.json` (0600, thư mục 0700; Windows dùng DACL như `localipc`). Op mới trên
  socket: `outbox.submit`, `outbox.list`, `outbox.drop`, `outbox.export`, `outbox.status`, và sự kiện qua `watch`.
  `hive` CLI có lệnh `hive outbox …`; desktop gọi qua sidecar `hive outbox … --json` như `remote.rs` đang làm.
- **Rationale**: worker đã có mẫu ghi tạm rồi đổi tên, đã sống qua khởi động lại, đã là tiến trình chạy nền của người
  dùng (ADR 0019). Một hàng duy nhất cho mỗi người dùng hệ điều hành giữ được thứ tự giữa desktop, CLI và proxy MCP.
- **Alternatives**: SQLite trong worker: thêm phụ thuộc CGO hoặc driver thuần Go, khó đọc khi hỏng; file thì đủ cho
  200 MB. Mỗi client tự có hàng: mất thứ tự giữa các client, ba chỗ cài giới hạn dung lượng.

### R4. `submit` luôn đi qua hộp thư đi, gửi ngay khi hub có

- **Decision**: `outbox.submit` ghi mục xuống đĩa trước, rồi thử gửi ngay và chờ tối đa 10 giây. Trả `accepted`,
  `duplicate`, `rejected` nếu hub kịp trả lời; trả `queued` nếu không.
- **Rationale**: một đường ghi cho cả lúc có và vắng hub; không có lần ghi nào nằm ngoài hộp thư đi để bị mất giữa
  chừng. 10 giây đủ cho một lần ghi bình thường mà không treo agent.
- **Alternatives**: chỉ xếp hàng khi lần gọi thẳng thất bại: lần gọi thẳng hết giờ mà hub vẫn xử lý thì client không
  biết; vẫn cần khoá chống trùng và vẫn có hai đường.

### R5. Phân nhóm tool theo bảng trong contracts

- **Decision**: `packages/contracts/src/client-events.ts` khai `CLIENT_WRITE_TOOLS: Record<tên, "progress" | "proposal"
  | "immediate">`. Fixture `packages/contracts/fixtures/client-write-tools.json` sinh từ đó; Go có bản sao
  `worker/internal/outbox/tools.go` và test so với fixture (như `worker-protocol.json`). Test hub kiểm mọi tool có ghi
  trong registry đều có mặt trong bảng.
- **Rationale**: proxy phải phân loại khi hub vắng, nên không thể hỏi hub. Test ở cả hai phía bắt được tool mới chưa
  phân loại (FR-012 "thêm tool ghi mới thì phải ghi rõ nhóm").
- **Alternatives**: dựa vào cờ `readOnly`: sai với hơn mười tool (mục 1.1). Hub công bố nhóm qua `tools/list` và proxy
  lưu cache: lần đầu chạy khi hub vắng thì không có cache.

### R6. Danh tính của mục và token để gửi

- **Decision**: mục ghi `hubUrl`, `orgId`, `userId` của PAT tại lúc tạo (lấy từ `GET /api/v1/me` lần gần nhất, có
  cache). Worker đọc PAT từ keychain dịch vụ `dev.xdev.hive`, tài khoản `hubUrl` (cùng chỗ desktop và CLI ghi) lúc gửi.
  PAT hiện tại thuộc người khác thì giữ mục ở trạng thái `held` với lý do "Cần đăng nhập lại bằng <email>".
- **Rationale**: FR-018 cấm gửi mục của A bằng token của B. Worker chạy cùng người dùng hệ điều hành nên đọc được
  keychain đó.
- **Alternatives**: chép PAT vào mục: PAT nằm ra file, trái FR-025.

### R7. Mã đời database

- **Decision**: bảng một dòng `hive.db_epoch (epoch uuid, restored_to timestamptz)`. Migration tạo dòng đầu;
  `deploy/restore.sh` và quy trình PITR đặt epoch mới và `restored_to`. `/api/v1/health` trả `dbEpoch`. Worker giữ sổ
  mục đã được nhận 14 ngày (`DataDir/outbox/<khoá>/sent.jsonl`); thấy epoch đổi thì đưa lại mọi mục có `receivedAt`
  sau `restored_to` vào hàng.
- **Rationale**: khoá chống trùng làm việc gửi lại an toàn; máy chỉ cần biết từ thời điểm nào.
- **Alternatives**: số thứ tự toàn cục: hub phải cấp số cho mọi máy, nặng hơn nhiều.

### R8. Khoá máy Ed25519, access token 15 phút

- **Decision**:
  - Máy tạo cặp khoá Ed25519 lúc đăng ký, hoặc lần chạy đầu sau khi nâng cấp. Khoá riêng nằm trong keychain qua
    go-keyring (dịch vụ `dev.xdev.hive.machine`, tài khoản là id máy). Máy không có keychain (runner host Linux không
    màn hình) dùng file `worker-key` 0600 cạnh `worker.json`, và app báo rõ mức này.
  - `GET /api/v1/worker/challenge?machine=<id>` trả nonce không trạng thái: HMAC của `id|exp`, hạn 60 giây.
  - `POST /api/v1/worker/token` nhận `{machineId, nonce, signature}`, kiểm chữ ký bằng `machines.public_key` và máy chưa
    bị thu hồi, trả JWT HS256 (khoá HKDF nhãn `xdev-hive machine token v1`), `sub=machine:<id>`, hạn 15 phút.
  - Gateway nhận access token khi nâng cấp WSS và đặt `welcome.accessTokenExp`. Worker đổi token trước hạn 2 phút và gửi
    gói mới `reauth {token}`. Hub đóng kết nối với mã `4401` khi token hết hạn mà chưa `reauth`.
  - Máy cũ: `hwm_` còn dùng được cho tới khi máy gửi khoá công khai lần đầu (`POST /api/v1/worker/key`, xác thực bằng
    `hwm_`); sau đó hub ghi `machine_tokens.superseded_at` và từ chối `hwm_` đó.
- **Rationale**: dùng lại chỗ trống đã có trong schema và giao thức; không cần mTLS (`docs/architecture.md:409`). Ed25519
  có sẵn trong thư viện chuẩn của Go (`crypto/ed25519`) và Node (`crypto.verify`).
- **Alternatives**: OAuth device flow cho máy: cần người bấm lại mỗi lần token hết hạn. Refresh token dài hạn: vẫn là
  token dài hạn nằm trên đĩa, trái US3.

### R9. Token git theo run

- **Decision**: lúc cấp lease, hub xin token từ kết nối SCM của dự án:
  - GitHub App: installation token giới hạn đúng repo, quyền `contents: write`, `pull_requests: read`; GitHub cố định
    hạn 1 giờ, nên run dài thì worker xin lại qua gói `git_token_request` (hub kiểm run còn chạy).
  - GitLab: project access token quyền `write_repository`, hạn sớm nhất GitLab cho phép (theo ngày); hub thu hồi qua API
    khi run kết thúc, và ghi vào `run_git_tokens` để job dọn thu hồi những token sót.
  - Kết nối SCM dạng PAT: không cấp được token hẹp. Hub gửi `git: null`, worker dùng thông tin git trên máy như hiện
    nay, ghi cảnh báo vào siêu dữ liệu run. Chính sách tổ chức `requireRunGitToken` (mặc định tắt) chặn run trong
    trường hợp này.
  - Worker đưa token vào `gitexec` (askpass có sẵn) cho clone, fetch, push của run; tắt `credential.helper`.
- **Rationale**: FR-023 và SC-004 cho GitHub App; GitLab không có token theo giờ, nên dùng thu hồi chủ động để đạt
  SC-004.
- **Alternatives**: deploy key theo repo: dài hạn, mỗi repo một khoá. Hub tự push thay máy: phải chở code lên hub, trái
  FR-050.

### R10. Log run ở lại máy

- **Decision**:
  - Worker ghi output run vào `DataDir/runs/<runId>/<attempt>.log` (0600) kèm `index.json` (offset, kích thước, thời
    điểm). Không gửi `log_chunk` khi `welcome.features` có `logs-local`. Hub mới luôn gửi cờ này; hub cũ không gửi nên
    worker mới vẫn gửi log như cũ.
  - Hub mới nhận `log_chunk` của worker cũ thì ack và bỏ, không ghi `run_logs`.
  - `welcome.policy.runLogRetentionDays` mang chính sách POL-05; worker xoá log quá hạn mỗi ngày và khi khởi động.
  - Op socket `runs.log.read {runId, attempt, offset, limit}` và lệnh `hive runs log`; desktop đọc qua sidecar, trang
    1 MiB, đủ cho SC-008.
- **Rationale**: Q3 chốt chỉ gửi siêu dữ liệu. Cờ trong `welcome` giữ tương thích hai chiều (constitution I).
- **Alternatives**: gửi log nén sau khi run xong: Q3 đã loại.

### R11. Output PTY

- **Decision**: ngừng ghi `terminal_chunks` (bản ghi phiên, RMT-03). Phần chuyển tiếp trực tiếp của điều khiển từ xa
  (spec 010 US3–US5) vẫn đi qua hub nhưng không lưu: hub chỉ chuyển gói từ worker sang trình duyệt đang xem.
- **Rationale**: FR-051 cấm hub nhận log terminal. Chuyển tiếp không lưu là đường duy nhất để điều khiển từ xa còn chạy
  khi trình duyệt và máy không nối thẳng được với nhau. Chủ dự án chốt ngày 2026-10-21 (plan, P1).
- **Alternatives**: tắt hẳn điều khiển từ xa: bỏ tính năng đã phát hành của spec 010. Nối thẳng trình duyệt với máy:
  phải mở cổng ở máy dev, trái FR-060.

### R12. Che secret trên máy và trên hub

- **Decision**: một hàm che chung theo fixture `secret-scan` (Go `runner/checks.go` → tách ra
  `worker/internal/redact`; TS `packages/contracts/src/secret-scan.ts`). Worker che mọi chuỗi chữ tự do trước khi gửi:
  `agent_report`, lỗi, tóm tắt, `payload` của sự kiện client có trường văn bản. Danh sách giá trị đã biết gồm biến môi
  trường nhạy cảm của run, secret của dự án worker nhận cho run, token MCP. Hub chạy lại `redactSecrets` khi nhận.
- **Rationale**: FR-052; dùng lại fixture có sẵn để hai phía che như nhau.

### R13. Tách vai trò `api` và `jobs`

- **Decision**: timer giao run (`RUNS_TIMER_QUEUE`) chuyển sang vai trò `api`, cùng tiến trình với gateway. Vai trò
  `jobs` giữ các worker pg-boss còn lại (provision, merge, review, notify, retention, docsync, embed…). Compose có hai
  service: `hub` (`HIVE_ROLES=api`) và `hub-jobs` (`HIVE_ROLES=jobs`). Không chạy nhiều bản `api` (out of scope).
- **Rationale**: phần phải chung tiến trình với socket của máy chỉ là timer giao run (mục 1.6). Chuyển nó sang `api` là
  đủ cho FR-043 mà không cần chuyển gói qua NOTIFY.
- **Alternatives**: chuyển gói giữa tiến trình bằng `pg_notify`: cần cho nhiều bản `api`, để sau.

### R14. Backup liên tục

- **Decision**: pgBackRest chạy trong image Postgres riêng của dự án (`deploy/postgres/Dockerfile`, dựa trên
  `pgvector/pgvector`), `archive_command` đẩy WAL, backup đầy đủ hằng tuần và tăng dần hằng ngày. Kho backup là S3
  tương thích hoặc SFTP trên máy khác (`HIVE_BACKUP_REPO`). Script `deploy/pitr-restore.sh <thời điểm>` khôi phục và
  đặt epoch mới; `deploy/drill.sh` khôi phục vào một container tạm, so khớp số dòng và checksum các bảng chính, rồi ghi
  biên bản `backups/drills/<ngày>.md`.
- **Rationale**: kiến trúc đã ghi tên pgBackRest (`docs/architecture.md:480`). Chạy trong container Postgres, không thêm
  dịch vụ chạy thường trực. Vẫn cần ADR theo constitution VII vì thêm image và kho ngoài.
- **Alternatives**: WAL-G: tương đương, ít người trong đội biết hơn. `pg_dump` mỗi giờ: không khôi phục về thời điểm bất
  kỳ.

### R15. Trang "Dữ liệu hub giữ"

- **Decision**: hằng `HUB_DATA_INVENTORY` trong contracts (loại dữ liệu, bảng, nguồn, thời gian giữ, có phải nội dung
  người dùng gửi chủ đích hay không). Web có trang admin đọc hằng đó; `docs/hub-data.md` sinh từ cùng nguồn. Test
  db kiểm mọi bảng trong schema `hive` và `auth` đều có trong danh sách.
- **Rationale**: FR-054 và SC-007 cần danh sách đúng với database; test bắt bảng mới chưa khai.

### R16. Điểm token của spec 025 đi qua hợp đồng này

- **Decision**: điểm token máy (spec 025 US6) là loại sự kiện client `machine.token_score`. Thêm nguồn gửi `worker`
  vào danh sách của spec cho việc nền của sidecar không thuộc run nào (`worker-run` chỉ dành cho gói của run). Loại
  này thuộc nhóm `progress` để hộp thư đi giữ khi hub vắng. Danh tính là máy (access token máy, R8), không phải người.
  Chi tiết trong ADR "máy gửi điểm token".
- **Rationale**: chính là lý do task T010 của spec 025 bị tạm giữ.

## 3. Không còn mục NEEDS CLARIFICATION

P1–P3 của plan đã được chủ dự án chốt theo mặc định ngày 2026-10-21.
