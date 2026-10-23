# Research: Kho bí mật tại máy cho agent AI

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Date**: 2026-10-23

Mỗi mục ghi theo dạng Quyết định / Lý do / Phương án đã loại. Nhãn **[Unverified]**, **[Inference]** đánh dấu điều chưa
kiểm trên máy thật; task T001 (Setup) kiểm các điểm này trước khi viết code phụ thuộc vào chúng.

## Hiện trạng đã đọc trong code

| Chỗ | Điều đã thấy | Dùng cho |
|---|---|---|
| `apps/desktop/src-tauri/src/ssh_keys.rs` | Mật khẩu chỉ đi qua stdin của sidecar (`sidecar.spawn()` rồi `child.write`), `wipe`/`wipe_bytes` xoá bộ nhớ, timeout 60 giây, đọc JSON từ stdout | Mẫu cho `secrets.rs` (FR-009) |
| `apps/desktop/src-tauri/src/account.rs` | `keyring` crate 4.2, dịch vụ `dev.xdev.hive`; `git_groups.rs` dùng `dev.xdev.hive.git` | Đặt dịch vụ riêng `dev.xdev.hive.secrets` (A9) |
| `apps/desktop/src-tauri/src/profiles.rs` | `open_terminal` ghi script tạm (`write_script`, 0700, tự xoá) với dòng `export KEY='v'` / `set "KEY=v"`, rồi mở Terminal.app, `cmd /C start`, hoặc terminal Linux | Không được ghi giá trị vào script (FR-015) |
| `apps/desktop/src-tauri/src/agents.rs` | Đọc env tiến trình khác bằng `sysinfo`, chỉ giữ `ENV_KEYS = [CLAUDE_CONFIG_DIR, CODEX_HOME, HIVE_PROJECT]` | Bí mật trong env của agent không lọt qua màn Agent; không cần sửa |
| `worker/go.mod` | `github.com/zalando/go-keyring v0.2.8`, dùng ở `cmd/hive/login.go` (`keyringService = "dev.xdev.hive"`) | Worker đọc kho được, không thêm phụ thuộc |
| `worker/internal/projects/projects.go` | `Project{ProjectID, Name, Folder, FullPermission}`; `ProjectID` là id hub, rỗng khi repo chưa liên kết; file `projects.json` cạnh cấu hình worker | Thiếu định danh tại máy ổn định → thêm `localId` (FR-010) |
| `worker/internal/channel/channel.go` `localProject` | `projects.Find(list, job.ProjectID)` rồi đặt `job.LocalRepo`; job sandbox bỏ qua | Chỗ gắn dự án tại máy cho run |
| `worker/internal/channel/jobs.go` `durableSink.Emit` | Event → `log_chunk`, `run_result`, `run_event`; ghi file chờ gửi (0600) trước khi gửi | Che phải xảy ra trước Sink này |
| `worker/internal/runner/runner.go` | `process.Env = mergeEnv(os.Environ(), mergeMap(job.savingEnv, job.Env))` (~dòng 530); `logWriter` chia khối 16 KiB; gói ngữ cảnh qua `--append-system-prompt-file` (claude) hoặc ghép vào đầu `job.Prompt`; push ở ~dòng 233 | Điểm đưa biến, che, chặn commit |
| `worker/internal/runner/checks.go` | `checkEnv` (danh sách cho phép biến máy + `hookEnv`), `redactSecrets(s, exact)`, `const redacted = "[đã che]"`, `secretValues(env)` | Lệnh kiểm nhận bí mật qua `job.Env`-tương đương; giữ `checkEnvAllowed` (FR-017) |
| `worker/internal/terminal/{local.go,redact.go}` | Phiên PTY tại máy qua localipc (`hive chat`), `runner.LocalEnv` lọc biến bí mật, `newRedactor` che luồng (tối thiểu 8 ký tự, mặt nạ `***`, giữ đuôi giữa hai khối) | Gom thành gói che chung |
| `worker/internal/ctxsync/secrets.go` | `looksSecret(s)` (mẫu mạnh, URL có mật khẩu, entropy) | Quét mô tả (FR-021) |
| `packages/contracts/src/policies.ts` | `agentPolicyInput`, `DEFAULT_AGENT_POLICY`, `jobPolicy = {hooks, managedHooksOnly}` | Thêm `secretInjection` |
| `apps/hub/src/modules/governance/policies.ts` | `savePolicy` parse bằng `agentPolicyInput` rồi `recordAudit`; `jobPolicyOf(policy)` | Lưu, audit, đưa xuống job |
| `apps/hub/src/modules/runs/engine.ts:634` | Chỉ gửi `policy` khi có hook hoặc `managedHooksOnly` (để worker cũ nhận spec như cũ) | Thêm điều kiện `secretInjection !== "allow"` |
| `apps/hub/src/modules/terminal/record.ts:187` | `welcome.policy = { totpFallback }` | Thêm `secretInjection` cho phiên desktop (worker nhớ lần cuối) |
| `packages/contracts/src/worker-protocol.ts` | `runEventKind` là enum; hub cũ đóng kết nối khi gặp loại lạ; `jobOffer.spec` dùng `catchall` | Số lượng bí mật đi trong `run_result.report`, không thêm loại sự kiện |

## D1. Ai giữ kho: sidecar Go `hive-worker`, desktop chỉ là lớp gọi

- **Quyết định**: worker Go (gói mới `worker/internal/secretstore`) là chủ duy nhất của:
  - đọc/ghi kho hệ điều hành qua `go-keyring`;
  - danh mục `secrets.json`;
  - nhật ký cấp `secret-grants.jsonl`;
  - hàng chờ duyệt.

  Desktop Rust (`secrets.rs`) gọi `hive-worker secrets …`. Giá trị đi qua stdin, theo đúng mẫu `ssh_keys.rs`.
- **Lý do**:
  - Worker phải đọc kho khi chạy run lúc desktop đóng.
  - Một chỗ ghi tránh hai thư viện (Rust `keyring` và Go `go-keyring`) mã hoá mục khác nhau trên cùng hệ điều hành
    **[Inference]**.
  - Dịch vụ worker chạy trong phiên người dùng: Windows dùng `schtasks ONLOGON /RL LIMITED`, macOS dùng LaunchAgent.
    Vì vậy kho của người dùng đọc được. Linux cần D-Bus phiên **[Unverified]** (T001).
- **Đã loại**:
  - Desktop Rust giữ kho, worker đọc bằng `go-keyring`: hai cách ghi, dễ lệch định dạng chia khối (D2).
  - Một daemon riêng: trái nguyên tắc VII.

## D2. Kích thước giá trị và chia khối trong kho

- **Quyết định**:
  - Mỗi bí mật lưu thành một hay nhiều mục trong dịch vụ `dev.xdev.hive.secrets`.
  - Tên tài khoản của mục đầu là `<NAME>`. Giá trị là `v1:<n>:<base64 khối 0>`, trong đó `n` là số khối.
  - Các khối sau là `<NAME>#1` … `<NAME>#n-1`. Mỗi khối chứa tối đa 1800 byte giá trị gốc trước base64.
  - Ghi theo thứ tự: khối cuối trước, khối đầu sau cùng. Vì vậy mục đầu chỉ trỏ tới khối đã ghi xong.
  - Xoá khối thừa khi giá trị ngắn đi.
- **Lý do**:
  - Windows Credential Manager giới hạn blob đúng 2560 byte (đã kiểm, xem "Kết quả kiểm").
  - **[Unverified]** `go-keyring` trên macOS gửi lệnh vào stdin của `/usr/bin/security -i` và chặn dòng dài hơn
    4096 byte (đọc mã, chưa chạy thật).
  - Giá trị 8 KiB (FR-005) không vừa một mục. Base64 giữ được xuống dòng và mọi byte (FR-013).
- **Kiểm**: T001 ghi và đọc giá trị 8 KiB nhiều dòng trên Windows và macOS. Linux kiểm khi có Secret Service.
  - Không vượt được → hạ giới hạn trong spec và ghi lại (A10 cho phép).
  - Không dùng file thay thế (FR-062).
- **Đã loại**:
  - Mã hoá giá trị bằng khoá trong kho rồi để bản mã trên đĩa: trái FR-001 ("không file thường").

## D3. Định danh dự án tại máy

- **Quyết định**:
  - Thêm `LocalID string \`json:"localId"\`` vào `projects.Project`.
  - Giá trị là chuỗi ngẫu nhiên 16 hex, sinh khi `AddFolder`/`Bind`. Dòng cũ thiếu thì sinh một lần lúc `Load` dưới
    `WithLock` rồi ghi lại.
  - Gán bí mật trỏ tới `localId`.
  - Run tìm dự án qua `localProject` (đã có). Phiên `hive chat` và terminal desktop tìm theo `localId` mà desktop truyền
    vào. Nếu không có `localId` thì tìm theo thư mục của cwd.
  - `projects unbind` (`worker/cmd/hive-worker/projects.go`) gọi `secretstore.DropProject(localId)` (FR-063).
    Gói `projects` không import `secretstore`, để tránh vòng import. Desktop gỡ dự án qua lệnh này
    (`local_projects.rs:61`).
- **Lý do**:
  - `ProjectID` rỗng với repo chưa liên kết.
  - Đường dẫn đổi khi người dùng dời thư mục (FR-010).
- **Đã loại**:
  - Dùng băm đường dẫn: vỡ khi đổi thư mục.
  - Dùng id hub: không có cho repo chưa liên kết.

## D4. Đưa biến vào run của worker

- **Quyết định**: gói `secretstore` có `Grant(ctx, GrantRequest) (Grant, error)` chạy trong `runner` ngay trước khi tạo
  tiến trình agent. Thứ tự:
  1. Xác định chính sách: `job.Policy.SecretInjection`; nếu thiếu thì dùng giá trị theo D9.
  2. Đọc danh mục, lấy tên gán cho `localId`.
  3. Đọc mọi giá trị trong một lần (một hộp thoại mở khoá, FR-061).
  4. Ghi dòng nhật ký.
  5. Trả `map[string]string` cùng danh sách giá trị để che.
- **Ghép env**:
  - Thứ tự ghép: `mergeEnv(os.Environ(), mergeMap(savingEnv, job.Env, granted))`.
  - Biến gán đè biến của máy và của run (FR-014).
  - `Grant` lọc lại tên dành riêng, phòng khi danh mục bị sửa tay.
  - Biến tài khoản CLI ghép sau như hiện nay, vì toàn là tên dành riêng.
- **Lệnh kiểm**: `runChecks` cộng `granted` vào env, còn `checkEnvAllowed` giữ nguyên (FR-017). `exact` gồm giá trị
  bí mật.
- **Setup script**: `runSetup` **không** nhận bí mật. Setup do tổ chức viết, và FR-011 chỉ nói "agent và các lệnh con".
  **[Inference]** Cần hỏi lại nếu người dùng muốn khác.
- **Agent con (spec 028)**: thừa kế env của tiến trình agent. Không cần làm gì thêm ngoài che (D7).
- **Không nhận bí mật**: job sandbox và runner-host, vì không có dự án tại máy. Run chuyển sang máy khác cũng không nhận
  (FR-018).
- **Lỗi kho** (`ErrLocked`, `ErrUnavailable`, `ErrMissing{Names}`): run dừng trước spawn với `Result.Error` tiếng Việt,
  chỉ có tên (FR-060). Worker chạy nền không có phiên người dùng thì không gọi API có thể bật hộp thoại (FR-061).
  - **[Unverified]** Windows wincred không có hộp thoại.
  - **[Unverified]** macOS: `security find-generic-password` có thể bật hộp thoại khi keychain khoá. Worker đặt giới hạn
    thời gian 5 giây và coi hết giờ là `ErrLocked`.
- **Lý do**: một điểm vào cho cả run, lệnh kiểm và agent con. Nhật ký cấp ghi cùng chỗ với lúc đọc giá trị.
- **Đã loại**:
  - Đưa bí mật qua `job.Env` từ hub: trái A12 và FR-001.

## D5. Terminal và phiên agent mở từ desktop

- **Quyết định**: script tạm của `profiles.rs` không chứa giá trị. Khi dự án có bí mật gán, dòng chạy CLI đổi thành:

  ```
  "<đường dẫn hive-worker>" secrets exec --project=<localId> --kind=terminal -- <argv cũ>
  ```

  - `secrets exec` gọi `Grant` (đọc kho, áp chính sách, ghi nhật ký), ghép env, rồi chạy `argv`:
    - Unix: `syscall.Exec`, thay tiến trình, giữ TTY và tín hiệu;
    - Windows: tạo tiến trình con dùng chung console, chờ, trả mã thoát.
  - Chính sách `approve` hỏi ngay trong terminal: `Đưa 3 bí mật (A, B, C) vào phiên này? [c/K]`. Đây là "hỏi người dùng
    tại máy" (FR-051) mà không cần IPC.
  - Terminal "shell" của thư mục (`git_groups::open_folder_terminal`) đổi cùng cách: `argv` là shell mặc định.
- **Lý do**:
  - **[Inference]** Terminal.app và gnome-terminal không chắc thừa kế env của tiến trình gọi `open`/`gnome-terminal`,
    vì tiến trình terminal có sẵn có thể nhận lệnh. Script lại nằm trên đĩa.
  - Đọc kho trong chính tiến trình con giữ giá trị khỏi đĩa và argv (FR-015). Cách này cũng giống hệt trên ba hệ điều
    hành (FR-012, FR-013).
- **Đã loại**:
  - Ghi `export` vào script: trái FR-015.
  - Truyền env qua `Command::env` cho `open -a Terminal`: không đáng tin **[Inference]**.
  - Desktop tự đọc kho bằng `keyring` crate: thêm lối ghi thứ hai (D1).

## D6. Phiên PTY của worker (`hive chat`, điều khiển từ xa)

- **Quyết định**:
  - Phiên `origin=local` (`terminal/local.go`, `CreateParams.ProjectID` hoặc cwd khớp dự án) gọi `Grant` với
    `kind=terminal`. Phiên này thêm biến vào `cmd.Env` sau `runner.LocalEnv` và thêm giá trị vào danh sách che của
    `pump`.
  - Phiên `term_start` từ xa (điện thoại) **không** nhận bí mật ở bản này.
- **Lý do**:
  - Phiên từ xa được ghi lại và điều khiển từ thiết bị khác, nên rủi ro lộ cao hơn.
  - Spec chỉ yêu cầu "desktop mở" (FR-012).
  - Quyết định thận trọng, có thể mở sau.
- **Đã loại**: cho cả phiên từ xa nhận bí mật, vì phải thêm chính sách riêng.

## D7. Che giá trị

- **Quyết định**: gói mới `worker/internal/secretmask`:
  - `New(values []string) *Masker` tạo bộ mẫu. Với mỗi giá trị ≥8 byte, bộ mẫu gồm:
    - giá trị gốc;
    - `base64.StdEncoding`, `base64.RawStdEncoding`, `base64.URLEncoding`, `base64.RawURLEncoding`;
    - `url.QueryEscape` và `url.PathEscape`;
    - JSON escape (`json.Marshal` bỏ dấu nháy hai đầu);
    - shell-quote: `'…'` và `'\''`, `"…"` với `\"`, `\$`, `` \` ``.
  - Giá trị nhiều dòng thêm hai dạng: cả khối với `\n` và `\r\n`, và từng dòng ≥8 byte (FR-033).
  - Mẫu dài trước, mẫu ngắn sau. Dùng `strings.Replacer` với mặt nạ `[đã che]` (FR-030).
  - **[Inference]** base64 của chuỗi con lệch vị trí (giá trị nằm giữa đoạn base64 dài) không bắt được. Ghi là rủi ro
    dư, kèm A6.
  - `Masker.Writer(w io.Writer)` che luồng, giữ đuôi `maxPatternLen-1` byte giữa hai lần ghi (FR-032), như
    `terminal/redact.go`.
  - `Masker.String(s) (string, bool)` trả cờ "đã che" cho FR-037.
- **Áp dụng**:
  - `runner` bọc `Sink` bằng `secretSink`: mọi `Event` được che trước khi `durableSink` ghi file chờ hay gửi hub
    (FR-035). Các trường được che: `Data` log, `Result.Error`, đuôi `Commands`, `Artifacts`, `Subagent.Description`,
    `Steer`, báo cáo agent.
  - Có che → `secretstore.MarkLeaked(grantID, names)` (FR-037) và log tại máy một dòng "đã che bí mật" (chỉ tên).
  - `checks.go` `redactSecrets` giữ nguyên, thêm `Masker` cho đuôi output.
  - `terminal/redact.go` chuyển sang dùng `secretmask` để có các dạng mã hoá. Mặt nạ terminal giữ `***`, vì hub và web
    đã hiển thị dạng này.
  - Artifact (FR-034): file text được che rồi mới gửi. File nhị phân chứa giá trị gốc bị giữ lại, kèm sự kiện cảnh báo.
- **Lý do**: một bộ mẫu cho run, lệnh kiểm, terminal. Che ở Sink thì không đường ra nào bị sót.
- **Đã loại**:
  - Che ở hub: giá trị đã rời máy, trái FR-035.
  - Mở rộng `packages/contracts/src/redact.ts` (TS): worker không dùng.

## D8. Cho agent biết tên biến

- **Quyết định**:
  - `secretstore.ContextBlock(names, descs)` sinh khối Markdown tiếng Việt (định dạng ở
    [contracts/agent-context.md](contracts/agent-context.md)).
  - Run claude có `packInSystemPrompt` → nối khối vào file gói ngữ cảnh truyền bằng `--append-system-prompt-file`.
  - Các CLI khác → ghép vào đầu `job.Prompt` cùng chỗ với gói ngữ cảnh hiện tại.
  - Phiên `hive chat` → nối vào `InteractiveSpec.SystemPrompt`.
  - Terminal desktop → `secrets exec` thêm cờ của CLI. Claude dùng `--append-system-prompt "<khối>"`.
    **[Inference]** Codex và Gemini chưa có cờ tương đương, nên terminal của hai CLI này không có khối. Đây là chỗ hụt
    đã biết; T001 kiểm lại.
  - `deny` → khối ghi "Phiên này không có bí mật nào được cấp" (FR-051).
  - Không ghi file trong repo (FR-022).
- **Lý do**:
  - Tên và mô tả đi tới nhà cung cấp model (FR-021). Với claude, đi qua system prompt thì không bị phát lại vào log.
- **Rủi ro**: khi prompt có khối ở đầu, tên có thể xuất hiện trong log run gửi hub, trái A1 một phần **[Inference]**.
  - Prompt không gửi qua `log_chunk`, nhưng agent có thể in tên trong lệnh shell.
  - Cho tới khi spec 027 FR-051 bỏ `log_chunk`, ghi đây là rủi ro đã biết, không chặn.
- **Đã loại**:
  - Ghi vào `CLAUDE.local.md` qua `ctxsync`: trái FR-022 tinh thần "không ghi tên vào file repo", vì file nằm trong cây
    repo.

## D8b. Hub chỉ nhận số lượng

- **Quyết định**:
  - Thêm trường tuỳ chọn `secretsInjected: number` (0–64) vào đối tượng báo cáo của `run_result.report`.
  - `report` là `z.record(z.string(), z.unknown())` nên hub cũ chấp nhận.
  - Hub mới đọc trường này để hiển thị "Run có dùng N bí mật tại máy" (FR-043).
  - Không thêm loại `run_event`: hub cũ đóng kết nối khi gặp loại lạ (`worker-protocol.ts:809`).
- **Đã loại**: thêm `runEventKind` mới, vì phá tương thích ngược (nguyên tắc I).

## D9. Chính sách `secretInjection`

- **Quyết định**:
  - **Contracts**: `agentPolicyInput.secretInjection: z.enum(["allow","approve","deny"]).default("allow")`, và
    `jobPolicy.secretInjection` tuỳ chọn. `DEFAULT_AGENT_POLICY` có `allow`.
  - **Hub**:
    - `jobPolicyOf` thêm trường.
    - `engine.ts:634` gửi `policy` khi trường khác `allow`.
    - `savePolicy` đã audit cả object, nên đổi trường được ghi trong `recordAudit` có sẵn.
    - Ảnh chụp chính sách của run (`policy_snapshot`) lấy cả object nên tự có.
    - Welcome (`terminal/record.ts:187`) thêm `policy.secretInjection` để worker biết chính sách cho phiên desktop.
  - **Worker**:
    - Nhớ chính sách lần cuối theo hub trong `secrets-policy.json` (không bí mật).
    - Run: lấy `job.Policy.SecretInjection`. Thiếu trường có nghĩa là hub không gửi, tức `allow` (hub chỉ bỏ trường khi
      `allow`).
    - Phiên desktop:
      - dự án liên kết → lấy chính sách đã nhớ;
      - chưa từng nhận chính sách → `deny` (FR-053);
      - dự án chưa liên kết → `allow`.
  - **`approve` cho run nền**:
    - Worker ghi yêu cầu (`secret-approvals/<id>.json`: tên, dự án, mã run, hạn 120 giây; không giá trị).
    - Desktop hỏi `hive-worker secrets approvals` mỗi 2 giây khi đang mở, rồi hiện hộp thoại và thông báo hệ điều hành.
    - Desktop trả lời bằng `secrets approve --id --allow|--deny`.
    - Hết hạn hoặc desktop đóng → chạy không bí mật, kèm sự kiện chính sách (FR-051).
- **Lý do**:
  - Desktop không nói chuyện với worker qua localipc. Đã có mẫu desktop gọi sidecar định kỳ.
  - **[Inference]** Hỏi mỗi 2 giây là đủ cho hạn 120 giây.
- **Đã loại**:
  - Thêm kênh IPC desktop ↔ worker mới: nhiều việc, không cần cho bản này.

## D10. Hiện, sao chép và xác thực lại (US8)

- **Quyết định**:
  - **Bản này**: xác nhận rõ ràng trong app trên cả ba hệ điều hành. Đó là hộp thoại "Hiện giá trị của X?" có nút
    mặc định là Huỷ.
  - **Xác thực của hệ điều hành** là task riêng, có thể làm sau trong cùng spec:
    - Windows: `UserConsentVerifier`, cần crate `windows` (WinRT), phụ thuộc mới;
    - macOS: `LocalAuthentication`, cần `objc2-local-authentication`, phụ thuộc mới.
    - **[Unverified]** cả hai crate chạy được trong bản build hiện tại.
  - **Hiện giá trị**:
    - `secrets.rs` gọi `secrets reveal --name`, đọc giá trị từ stdout và trả cho UI;
    - UI tự ẩn sau 10 giây;
    - sidecar ghi dòng `reveal`.
  - **Sao chép**:
    - Rust đặt clipboard bằng `tauri-plugin-clipboard-manager`. Đây là phụ thuộc mới, chưa có trong `Cargo.toml`.
      **[Unverified]** đọc lại clipboard được trên cả ba hệ điều hành; T001 kiểm.
    - Sau 30 giây, nếu clipboard còn đúng giá trị (so trong bộ nhớ) thì xoá (FR-052).
    - UI không nhận giá trị.
- **Lý do**: FR-052 cho phép "nếu không thì xác nhận rõ ràng". Làm xác nhận trước giữ MVP nhỏ.
- **Đã loại**: bắt buộc sinh trắc học ngay bản đầu, vì thêm hai phụ thuộc nền tảng vào đường chính.

## D11. Chặn commit và push chứa giá trị (FR-038)

- **Quyết định**: trong `runner`, trước bước commit của worker và trước `gitRetryLocked(…"push"…)`, chạy:
  - `git diff --cached -z` (sau `git add`);
  - `git log -p <base>..HEAD` cho commit do agent tự tạo.

  Quét bằng `Masker` (chỉ giá trị gốc và các dạng mã hoá). Thấy giá trị thì dừng với `Result.Error`
  "Thay đổi chứa giá trị của bí mật X; đã chặn commit/đẩy." và đánh dấu `leakedInOutput`.
- **Lý do**: bước cuối trước khi giá trị rời máy qua git.
- **Đã loại**:
  - Hook git `pre-commit` trong repo: trái FR-022.

## D12. Định dạng file tại máy và quyền

- **Quyết định**:
  - `secrets.json`, `secrets-policy.json`, `secret-grants.jsonl` và thư mục `secret-approvals/` nằm cạnh `projects.json`.
  - Quyền 0600 (Windows: ACL mặc định của thư mục người dùng).
  - Ghi nguyên tử bằng `projects.WriteJSON`-tương đương.
  - Nhật ký cấp: JSONL, mỗi lần ghi bỏ dòng cũ hơn 90 ngày (A7), tối đa 10 000 dòng.
- Chi tiết ở [data-model.md](data-model.md).

## Kết quả kiểm (T001)

### Windows 11 Pro 10.0.26300, Go 1.27.2, `go-keyring v0.2.8` — 2026-10-23

Chương trình thử tạm ngoài repo, dịch vụ riêng `dev.xdev.hive.secrets.probe-sec031`, xoá hết mục sau khi thử
(`cmdkey /list` không còn mục nào).

| Kiểm | Kết quả |
|---|---|
| `keyring.Set` giá trị 1800, 2405, 2560 byte | đạt, đọc lại khớp |
| `keyring.Set` 2561 byte | `ErrSetDataTooBig`. `go-keyring` tự chặn ở `len(password) > 2560` (`keyring_windows.go`) |
| `wincred` ghi thẳng, bỏ qua `go-keyring`: 2560 / 2561 / 4096 / 5120 byte | 2560 đạt; từ 2561 trở lên Windows trả "The stub received bad data." Giới hạn thật của Credential Manager là **2560 byte** blob |
| Giá trị có `\r\n`, `\n`, nháy đơn/kép, `$`, Unicode, byte `0x01` | đọc lại khớp từng byte |
| Tên tài khoản 66 / 300 byte | đạt. 600 byte lỗi "The array bounds are invalid." Tên ≤64 cộng `#k` an toàn |
| 50 lần `Set` mục 2405 byte | ~780 ms (~16 ms mỗi mục) |
| 50 lần `Get` mục 2405 byte | ~41 ms (<1 ms mỗi mục). 10 bí mật × 5 khối đọc tuần tự ≈ 40 ms, xa dưới SC-008 (500 ms) |

Kết luận cho D2:

- Khối 1800 byte giá trị gốc → base64 2400 ký tự, cộng tiền tố `v1:5:` → mục đầu 2405 byte ≤ 2560. **Giữ thiết kế**:
  khối 1800 byte, tối đa 5 khối cho 8 KiB.
- Khối lớn nhất về lý thuyết là 1914 byte (2552 + 5 = 2557). 1800 chừa biên cho tiền tố.

### macOS — chưa kiểm

Người điều phối kiểm sau trên máy Mac. Đọc mã `go-keyring v0.2.8` (`keyring_darwin.go`), chưa chạy thật:

- `Set` mã hoá giá trị lần nữa bằng base64 (tiền tố `go-keyring-base64:`), rồi gửi một dòng
  `add-generic-password -U -s … -a … -w …` vào stdin của `security -i`. Dòng dài hơn 4096 byte → `ErrSetDataTooBig`.
- Mục đầu 2405 byte → base64 3208 ký tự + 18 tiền tố + ~80 phần còn lại ≈ 3310 byte < 4096. **[Inference]** khối 1800
  byte vừa trên macOS; còn chờ kiểm thật.
- Các điểm khác của T001 (keychain khoá có bật hộp thoại không, clipboard, cờ của codex/gemini, Linux không có Secret
  Service) chưa kiểm.

## D13. Kiểm trên ba hệ điều hành

- **Quyết định**:
  - Test Go của `secretstore` dùng `keyring.MockInit()` (`go-keyring` có sẵn) cho logic.
  - Thêm test tích hợp có tag `keyringit`, chạy trên CI Windows và macOS, ghi và đọc giá trị 8 KiB nhiều dòng.
  - Rust test `secrets.rs` bằng sidecar giả, như test hiện có của `ssh_keys.rs` **[Inference]**.
  - Màn Bí mật kiểm bằng Vitest + Testing Library với mock `invoke`. Desktop chưa có Playwright, như các màn khác.
- **Lý do**: nguyên tắc IV, test Go trên Linux, macOS, Windows.
