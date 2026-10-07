# 69h1: contract của gate job

Trạng thái: **contract để review**, chưa triển khai. Task `R-69h1`, 2026-10-07, nền `c6e1d52aae` (0.145.2). Sửa ngày 2026-10-08 theo review R-16d609: manifest gắn hash (§3), đường tự duyệt (§5), bàn giao khoá giữa lô và gate kèm luồng thành công (§7). Thuộc [69-remote-terminal.md](69-remote-terminal.md) §13, phương án (d) ở §3. Executor là `R-69h2`; tài liệu này chỉ chốt giao diện, quyền và tiêu chí để 69h2 làm và review đối chiếu.

## 1. Mục đích và phạm vi

Gate job chạy **một lệnh cố định do máy khai báo** trên một commit chính xác của một project, trên máy có session GUI thật và ngoài sandbox của coding run. Đầu ra là receipt có cấu trúc: exit code, `result.json`, ảnh/log đã lọc, gắn với SHA. Mục đích: kiểm e2e/GUI (desktop smoke, web e2e, e2e:mobile) mà không phải cấp cho agent shell đầy quyền hay mở terminal.

Gate job **không** phải:

- shell từ xa: không nhận chuỗi lệnh, tham số tự do hay env từ hub, task, chat hoặc run;
- quyền phát hành: kết quả xanh không tạo `autoRelease.green` và không mở push/deploy. 60c giữ nguyên đường riêng của nó;
- cách tự sửa sandbox: run không được dùng gate để chạy lại một lệnh bị sandbox chặn với quyền rộng hơn (§6).

## 2. Hiện trạng (đã rà trên nền)

| Chỗ | Hiện có | Hệ quả cho contract |
|---|---|---|
| `packages/core/src/merge-queue.ts` `mergeQueueConfigSchema.commands` | Chuỗi lệnh ≤2000 ký tự, lưu ở hub; `mergeQueue.configure` chỉ cần `projectSettings` và `assertNoSecret` | Ai có quyền cài đặt project là đổi được lệnh chạy trên máy cổng kiểm, kể cả khi không phải chủ máy. Gate job không đi theo mẫu này (§3); xem đề xuất R-69h3 ở §9 |
| `apps/desktop/src/main/runner/merge-queue.ts` `runGate` | `/bin/sh -c <command>` với `{...process.env, ...host.env()}`, timeout 30 phút, log lọc bằng `redactLines`, kiểm HEAD và tracked files sau gate | Mẫu kiểm `HEAD == checkedSha` và cây sạch dùng lại được; shell string và env đầy đủ của app thì không |
| Cùng file, `MergeQueueRunner.poll` | Một lockfile `<dataDir>/merge-queue/lock` chứa pid cho cả máy. Lô chạy đồng bộ trong `poll` và giữ lockfile tới sau `mergeQueue.finish`. `AutoReleaseWorker` chỉ chạy khi `!mergeQueue.busy` | Lô giữ khoá suốt từ ghép nhánh tới publish. Gate job bắt buộc của lô phải chạy *dưới* khoá đó, không xin khoá riêng (§7) |
| `apps/desktop/src/main/runner/auto-release.ts` | argv lưu local ở máy, `spawn` không qua shell, clone riêng theo SHA, receipt 0600 ghi trước RPC rồi gửi lại, `killTree`, không tự chạy lại sau restart | Gate job dùng lại cách này: argv local, clone sạch, receipt bền vững, không retry side effect |
| `machines.heartbeat`: `toolStates`, `toolApprovals`, `worktreeResults` | Phê duyệt tool gắn với hash; máy chỉ áp khi hash của entry còn khớp. Kết quả worktree được gửi lại tới khi hub ACK | Mẫu cho manifest gate: hub giữ nội dung gắn hash, máy kiểm lại hash trước khi làm; manifest gửi tới khi có ACK (§3) |
| `packages/core/src/sqlite.ts` `call()` + `AGENT_METHODS` | Credential run/MCP chỉ gọi được method trong allowlist; run chỉ sửa task của mình | Mọi method ghi của gate nằm ngoài `AGENT_METHODS` |
| Memory #869 (60c) | Báo kết quả của máy cổng kiểm dùng `taskWork` + ID máy đã pin, không qua `runDispatch` | Gate `take/progress/result` dùng cùng mô hình, ràng buộc thêm `leaseToken` |
| Memory #1011 | PTY không giữ được lệnh dài hoặc lệnh tự ảnh hưởng hub | Việc dài đi qua gate/60c có receipt, không qua terminal |

## 3. Template tin cậy, manifest và hash

Template là **thiết lập local của máy**, do chủ máy cấu hình trong app desktop (Cài đặt → service → Gate job), giống argv của 60c. Hub không tạo, sửa hay gửi argv xuống máy. Máy công bố **manifest** (template trừ nhãn) gắn với hash, để hub hiển thị cho người duyệt, quyết định tự duyệt và giới hạn lease. Máy chỉ chạy template local của chính nó.

```ts
interface GateManifest {   // đúng phần được hash và công bố
  id: string;              // /^[a-z0-9][a-z0-9-]{0,39}$/, duy nhất trong một project của máy
  version: number;         // chủ máy tăng khi sửa; hash vẫn là thứ ràng buộc
  argv: string[];          // 1–64 phần tử, mỗi phần tử ≤1000 ký tự; argv[0] là đường dẫn tuyệt đối hoặc tên trong PATH đã chốt
  env: string[];           // TÊN biến lấy từ env local, /^[A-Z_][A-Z0-9_]{0,63}$/; giá trị không bao giờ rời máy
  timeoutMinutes: number;  // 1–120
  gui: boolean;            // cần session GUI; khoá GUI của cả máy (§7)
  resultFile: string | null;   // đường dẫn tương đối trong {artifactDir}, ví dụ "result.json"
  artifacts: { glob: string; required: boolean }[]; // tương đối trong {artifactDir}, ≤8 mục
  autoApprove: boolean;    // template cho phép tự duyệt; còn cần đủ điều kiện ở §5
}
interface GateTemplate extends GateManifest {
  label: string;           // ≤80 ký tự, hiển thị; không đưa vào argv, không nằm trong hash
}
```

**Placeholder đóng.** Một phần tử argv chỉ có thể là chữ thường, hoặc chứa đúng một trong `{sha}`, `{jobId}`, `{artifactDir}`. Giá trị do máy sinh (`{artifactDir}` là thư mục 0700 của job, `{jobId}` từ hub đã kiểm `/^gj_[a-z0-9]{20}$/`) hoặc đã kiểm định dạng (`{sha}` là hex 40/64). Không có placeholder cho text người dùng, nhánh, tên task hay prompt. Cần biến thể khác thì tạo template khác. v1 không có tham số tuỳ biến.

**Hash.** `templateHash = sha256(canonicalJson(manifest))` dạng hex, với `canonicalJson` sắp xếp khoá theo thứ tự byte và không có khoảng trắng. Nhãn không nằm trong hash, nên đổi nhãn không làm mất phê duyệt. `autoApprove` nằm trong hash, nên bật nó là đổi hash, và các job đã duyệt theo hash cũ đều mất hiệu lực. Vì argv sẽ được công bố, app từ chối lưu template có argv chứa known secret (cùng bộ lọc `assertNoSecret` với hub). Secret thì đưa qua `env`.

**Công bố.** Đi trong heartbeat, gồm mục lục và manifest:

```ts
// heartbeat, máy → hub
gate?: {
  protocol: 1; enabled: boolean; guiReady: boolean; busy: boolean;
  projects: {
    name: string;
    autoApprove: boolean;  // gateJobs.autoApprove local bật cho project và máy không cấu hình autoRelease cho project (§5)
    templates: { id: string; version: number; hash: string; label: string }[];
  }[];
  manifests: { hash: string; manifest: GateManifest }[]; // chỉ các hash hub chưa ACK; ≤8 mục, ≤64 KiB mỗi heartbeat
}
// phản hồi heartbeat, hub → máy
gate?: { ack: string[]; want: string[] }
```

- Mục lục gửi ở mọi heartbeat, hub giữ bản cuối của từng máy. Máy cũ thiếu `gate` thì hub coi như không hỗ trợ.
- Manifest được gửi lại tới khi có ACK, giống `worktreeResults`. Hub tính lại `sha256(canonicalJson(manifest))`, kiểm schema (cùng zod với app) và `assertNoSecret`, và yêu cầu hash có trong mục lục của chính máy đó ở cùng heartbeat. Đạt thì lưu bất biến theo `(machineId, hash)` rồi ACK. Không đạt thì không lưu, không ACK, ghi audit. `want` là các hash có trong mục lục mà hub chưa có manifest (hub mới, DB khôi phục); máy gửi lại chúng ở heartbeat sau.
- Template chỉ **sẵn sàng** khi hub có cả dòng trong mục lục lẫn manifest đúng hash. `gate.create` và `mergeQueue.gates` (§9) chỉ nhận template sẵn sàng.
- Quan hệ máy↔account lấy từ token đã xác thực, không lấy label hay `x-hive-source` (memory #989/#990).

**Hub dùng manifest vào ba việc.** (1) Màn duyệt hiển thị argv đã thay `{sha}` và `{jobId}` (giữ nguyên chữ `{artifactDir}` vì đó là đường dẫn local), tên env, timeout, `gui`, `resultFile` và artifact required (§5). (2) Tự duyệt đọc `manifest.autoApprove` (§5). (3) Lease bị chặn trên theo `manifest.timeoutMinutes` (§4). Manifest chỉ là thông tin máy tự khai. Máy vẫn là bên quyết định chạy gì, vì nó chỉ chạy template local có hash khớp job.

**Kiểm hai đầu.** `gate.create` chỉ nhận `templateId + templateHash` sẵn sàng của đúng máy và project. Khi `take`, máy tính lại hash từ template local. Khác hash (template bị sửa hoặc xoá sau khi duyệt) thì job thành `error` với reason `templateChanged` và **không chạy gì**. Vì vậy argv người duyệt thấy (manifest theo hash) và argv máy chạy (template local cùng hash) là một.

**Cái template không bảo vệ.** argv cố định nhưng `npm test` vẫn chạy code của repo tại SHA đó: script, config và test do agent viết. Hash chỉ chốt *hình dạng* lệnh; còn *code được chạy* thì do SHA và phê duyệt chốt (§5–§6).

## 4. Job, vòng đời và hạn

```ts
interface GateJob {
  id: string;                 // gj_ + 20 ký tự base32 ngẫu nhiên
  project: string;
  machineId: string;          // ID trong machines.list, bất biến
  templateId: string; templateHash: string;
  timeoutMinutes: number;     // chép từ manifest theo hash lúc create, bất biến
  sha: string;                // hex 40/64, bất biến
  ref: string;                // validMergeRef; nhánh mà máy phải tìm thấy sha trên đó (§5)
  purpose: "mergeQueue" | "manual" | "evidence";
  batchId: number | null;     // chỉ có khi purpose = mergeQueue: lô sở hữu job (§7)
  requestedBy: string;        // account của người, hoặc "mergeQueue:<batchId>"
  idempotencyKey: string;     // ≤80; (project, templateHash, sha, idempotencyKey) là duy nhất
  state: GateState; reason: GateReason | null; version: number; // CAS
  approval: { mode: "human" | "auto"; by: string; at: string } | null; // by: account, hoặc "machine:<machineId>" khi tự duyệt
  expiresAt: string;          // UTC
  leaseUntil: string | null;  // UTC, chỉ khi claimed/running
  receipt: GateReceipt | null;
}
type GateState = "requested" | "approved" | "claimed" | "running" | "passed" | "failed" | "error" | "rejected" | "expired" | "cancelled" | "uncertain";
```

```
requested ──approve | tự duyệt (§5)──▶ approved ──take──▶ claimed ──progress──▶ running ──result──▶ passed | failed | error
    │ reject/expire/batchEnded             │ expire/cancel     │ lease hết, chưa có receipt ─▶ uncertain ──reconcile──▶ failed | error
    ▼                                      ▼                   ▼
 rejected | expired | cancelled         expired | cancelled  cancelled (máy kill rồi gửi receipt)
```

- Mọi transition đi qua CAS theo `version`, có reason enum và dòng audit trong cùng giao dịch.
- `expiresAt`: mặc định 24 giờ kể từ create, tối đa 72 giờ. Job `mergeQueue` dùng `gateWaitMinutes` của project (mặc định 30, 1–240), vì lô giữ khoá trong lúc chờ (§7). Job chưa được `take` trước hạn thì thành `expired`. Hạn không bao giờ được kéo dài: muốn chạy lại thì tạo job mới.
- `take` cấp `leaseToken` 256-bit (hub chỉ lưu hash) và `leaseUntil = now + 2 phút`. `progress` gia hạn thêm 2 phút, không vượt `claimedAt + job.timeoutMinutes + 10 phút`. Timeout lấy từ manifest lúc create, máy không gửi được giá trị khác lúc `progress`. Hết lease mà chưa có receipt thì job thành `uncertain`. Hub **không bao giờ** trả lại job đó cho `take`.
- `cancel` khi job đang chạy: `progress` kế tiếp trả `cancelled`, máy `killTree` (SIGTERM, 5 giây sau SIGKILL) rồi gửi receipt `outcome: "cancelled"`.
- Lô kết thúc (finish, recovery, huỷ) thì trong cùng giao dịch hub chuyển mọi job chưa kết thúc của lô sang `cancelled` với reason `batchEnded`. Job đang chạy nhận `cancelled` ở `progress` kế tiếp.
- Kết thúc là trạng thái cuối. `passed` không bị ghi đè; receipt gửi lặp cùng nội dung thì trả cùng record, khác nội dung thì `conflict` và được audit.

**Ngữ nghĩa xanh/đỏ** (AC09: test lỗi phải làm gate đỏ, không chỉ kiểm có ảnh). `passed` chỉ khi đủ tất cả các điều sau:

1. process thoát với `exitCode === 0`, không do signal, không quá timeout;
2. nếu có `resultFile`: file tồn tại, ≤64 KiB, khớp schema `{ ok: boolean; checks?: { name: string; ok: boolean }[]; summary?: string }`, `ok === true`, và không mục `checks` nào `ok === false`;
3. mọi artifact `required` có ít nhất một file khớp và qua được allowlist (§8);
4. sau lệnh, `HEAD === sha` và `git status --porcelain --untracked-files=no` rỗng (giống `runGate` hiện có).

Lệnh tự báo thất bại (exit ≠ 0, `ok: false`) thì là `failed`. Lỗi hạ tầng (clone, template đổi, không có GUI, không lấy được khoá đến hết hạn, upload artifact) là `error`. Cả hai đều không xanh.

## 5. Phê duyệt và SHA

**Ai tạo job.**

| Đường | Điều kiện |
|---|---|
| `manual` / `evidence` | Human cookie (không phải bearer, không tin `x-hive-source`) có `projectSettings` của project; template sẵn sàng (§3) và `gate.enabled`; máy có project trong danh sách |
| `mergeQueue` | Hub tạo trong `mergeQueue.gates` (§7, §9) theo `requiredGates` đã chụp vào cấu hình của lô lúc `take`. Máy của lô chỉ báo `checkedSha` và nhánh lô; không chọn template, máy hay purpose. `requestedBy = mergeQueue:<batchId>`, `batchId` được gán, `ref` phải có dạng `review/hive-<batchId>-…` |

Credential run, MCP, chat leader và machine bearer không tạo được job `manual`/`evidence`. Chat leader chỉ đưa link tới form.

**Phê duyệt.** Một job mới luôn ở `requested`. Sang `approved` bằng một trong hai đường dưới đây. Cả hai đều ghi `approval` và audit trong cùng giao dịch.

- **Người duyệt**: `gate.approve({id, version, pass, reason})` từ human cookie + CSRF, có `projectSettings`, account đang hoạt động. Màn duyệt hiển thị máy, OS user, template label + hash, và lấy từ manifest theo hash (§3): argv đã thay placeholder, tên env, timeout, `gui`, artifact required. Kèm theo là SHA, ref và danh sách file đổi giữa merge-base của `ref` và target branch với SHA. Các đường dẫn rủi ro (`package.json`, lockfile, `scripts/`, `e2e/`, config test/build, `.github/`, `deploy/`) được đánh dấu riêng. Khi 69c xong, job có SHA không nằm trên target branch cần thêm step-up còn hạn. Người tạo được tự duyệt job của mình, vì tạo cũng chỉ người làm được.
- **Tự duyệt**: không có RPC. Hub thực hiện transition `requested → approved`, với `approval = {mode: "auto", by: "machine:<machineId>"}`, ngay trong giao dịch `mergeQueue.gates` vừa tạo job, khi đủ bốn điều:
  1. `purpose = mergeQueue` và job thuộc lô đang `running` của chính máy được giao job (`batchId`);
  2. mục lục gần nhất của máy có `projects[p].autoApprove = true`, và máy online, không duplicate, không update drain (cùng điều kiện với `mergeQueue.take`). Máy chỉ báo `true` khi `gateJobs.autoApprove` local bật cho project và máy không cấu hình `autoRelease` cho project đó. App từ chối lưu tổ hợp này, vì code của agent chạy bằng OS user đang giữ credential phát hành. Hub không bật thay được;
  3. manifest theo `templateHash` có `autoApprove: true`;
  4. trần của hub cho phép: `gateAutoApprove` của project và của hub không phải `false`, và máy không phải `releaseMachine` của project. Điều sau là phần hub tự kiểm thêm cho điều 2.

  Thiếu một điều thì job ở `requested`, vào hàng chờ duyệt của người như job thường, và lô chờ trong hạn `gateWaitMinutes`.

**Máy kiểm lại tự duyệt trước khi spawn.** Hub có thể đã quyết theo mục lục cũ, ví dụ chủ máy vừa tắt tự duyệt hoặc vừa cấu hình `autoRelease`. Với job `approval.mode = "auto"`, máy kiểm lại cả bốn điều bằng state local: setting `gateJobs.autoApprove`, template theo hash, cấu hình `autoRelease`, và lô mà chính process đang giữ khoá. Không đạt thì `error/autoApproveRevoked`, không spawn. Phê duyệt của người thì máy không kiểm lại được, nên máy tin hub như với `mergeQueue.take`.

Phê duyệt gắn với `(project, machineId, templateId, templateHash, sha, ref)`. Đổi bất kỳ trường nào cũng phải tạo job mới và duyệt lại.

**SHA phải có thật trên ref.** Khi `take`, máy fetch `ref` từ remote `origin` của project (repo local không có remote thì dùng ref local, như fixture 60c) và kiểm `git merge-base --is-ancestor <sha> <ref-tip>`. Không thoả thì `error/shaNotOnRef`. Như vậy hub không đẩy được một commit tuỳ ý (hay commit chỉ có trên máy khác) vào executor. Với `mergeQueue`, job luôn được giao cho chính máy đang giữ lô, ref là nhánh lô local mà máy đó vừa tạo, nên kiểm trên ref local thay vì `origin`.

## 6. Run không tự nâng quyền

Các bất biến này 69h2 phải có test:

1. `gate.create/approve/reject/cancel/reconcile/take/progress/result` và `mergeQueue.gates` **không** nằm trong `AGENT_METHODS`. `gate.get/list` thì có, để agent đọc kết quả của project mình; filter vẫn kiểm project. Tự duyệt không có RPC nào để gọi; nó chỉ xảy ra trong `mergeQueue.gates` theo §5.
2. Không có trường nào của job lấy từ text của task, note, chat, prompt hay output của run. Run không chọn được template, argv, env, cwd, timeout hay máy.
3. Kết quả gate không đổi autonomy, sandbox, policy (27a) hay credential của bất kỳ run nào. Runner không bao giờ chạy lại một lệnh bị sandbox chặn bằng gate. Gate đỏ không tự tạo job với quyền rộng hơn.
4. Env của process gate được dựng từ đầu, không kế thừa `process.env` của app: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM=dumb`, các biến GUI cần cho session (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` trên Linux), các tên trong `template.env`, và `HIVE_GATE_JOB`, `HIVE_GATE_SHA`, `HIVE_GATE_ARTIFACTS`. Không có token máy, `hiverun_`/`hivemcp_`, cấu hình MCP, env của profile agent hay biến `autoRelease`. App từ chối lưu template mà `env` chứa tên trùng biến secret đã biết của profile/hub.
5. Clone của job bỏ remote sau khi fetch (`git remote remove origin`) và đặt `GIT_TERMINAL_PROMPT=0`, để test không `push` theo đường quen thuộc. Đây chỉ là phòng thủ thêm. **Cùng OS user nghĩa là không có cách ly**: code ở SHA đọc được mọi thứ OS user đọc được (`~/.ssh`, keychain đã mở khoá, credential helper). Muốn cách ly thì máy GUI chạy app bằng OS account riêng, không có credential phát hành hay production. Màn duyệt và cài đặt local phải ghi rõ điều này.
6. Gate xanh không phải quyền phát hành. 60c chỉ nhận receipt gate làm bằng chứng cho một check qua ánh xạ `requiredGates` mà người cấu hình. Hub so `templateHash` và `sha` của receipt với ánh xạ đó và với SHA của lô; lệch thì check coi như thiếu.

## 7. Khoá tài nguyên

Khoá ở máy, cùng một registry với merge queue, auto-release và terminal 69e. Spec 69 §11 gọi đây là "resource lock chung". Mỗi khoá là một lockfile 0600 `{pid, holder, delegate}` theo mẫu `merge-queue.ts`. `holder` là `mergeBatch:<id>`, `autoRelease:<id>` hoặc `gate:<jobId>`. `delegate` là `gate:<jobId>` khi lô đang chạy job con của nó, ngược lại là `null`.

| Khoá | Ai giữ | Gate job cần |
|---|---|---|
| `project:<machine>/<project>` | lô merge queue, lô auto-release, gate job tự do | Job `manual`/`evidence`: có, chỉ khi khoá trống. Job của lô: không xin, chạy dưới khoá của lô (bàn giao bên dưới) |
| `gui:<machine>` | gate job `gui: true`; GUI smoke/release cần cửa sổ | Có, nếu `manifest.gui`. Chỉ một job GUI trên máy. `mergeQueue.commands` hiện có không xin khoá này; R-69h3 đưa chúng về template |
| `checkout:<realpath>` | run, terminal, merge | Không. Gate dùng clone riêng của job trong `<dataDir>/gate/<hash(jobId)>`, không đụng checkout của người dùng hay run |

**Bàn giao khoá cho job của lô.** Lô giữ `project:` từ `take` tới sau `mergeQueue.finish`, và phải chờ các job bắt buộc trước khi publish. Nếu job con cũng phải xin `project:` như job tự do thì lô và job chờ nhau mãi. Quy tắc:

1. Poller gate chung không bao giờ lấy được job có `batchId`: `gate.take({project})` không kèm `batchId` chỉ trả job `manual`/`evidence`. Job của lô chỉ lấy được bằng `gate.take({project, batchId, instance})`, và hub chỉ trả khi lô đang `running`, `batch.machineId` là máy gọi và `batch.instance === instance`.
2. Lời gọi đó đến từ chính `runMergeBatch` đang giữ `project:`. Process ghi `delegate = gate:<jobId>` vào lockfile, chạy job bằng cùng executor của gate job (clone riêng, env dựng từ đầu, receipt), rồi đặt lại `delegate = null`. Khoá không bị nhả hay đổi chủ trong lúc này, nên auto-release, lô khác hay job tự do không chen vào được giữa `checkedSha` và publish.
3. Executor từ chối job có `batchId = N` (`error/batchEnded`, không spawn) nếu lockfile `project:` không có `holder = mergeBatch:N` với đúng pid của process đang chạy.
4. Thứ tự khoá cố định: `project:` trước `gui:`. Không ai chờ `project:` trong khi giữ `gui:`. Job GUI của lô xin `gui:` trước khi `take`. Nếu `gui:` bận (job GUI tự do của project khác) thì lô chưa `take` và chờ tiếp trong hạn của job. Job tự do giữ `gui:` không bao giờ chờ khoá mà lô đang giữ, nên không có vòng chờ.
5. Mọi chờ đợi của lô đều có hạn. Job `mergeQueue` quá `expiresAt` (`gateWaitMinutes`) mà chưa được `take` thì `expired`; lô `failed` và nhả khoá. Trong lúc chờ, lô vẫn gửi `mergeQueue.progress` với step `gate <check>: chờ duyệt | chờ GUI | đang chạy`, để người xem biết vì sao máy bận.

**Luồng thành công** (một mục `requiredGates` là `desktop-smoke`, tự duyệt bật):

1. `mergeQueue.take` trả lô 42 `running`, với `requiredGates` đã chụp vào `batch.config`. Máy lấy `project:M/xdev-hive` với `holder = mergeBatch:42`.
2. Máy ghép nhánh, chạy `mergeQueue.commands`, có `checkedSha`, ghi journal phase `gates`.
3. `mergeQueue.gates({id: 42, instance, checkedSha, ref: "review/hive-42-…"})`: hub tạo `gj_…` (`purpose: mergeQueue`, `batchId: 42`, `idempotencyKey: mq:42:desktop-smoke`), tự duyệt theo §5, rồi trả danh sách job.
4. Máy lấy `gui:M`, gọi `gate.take({project, batchId: 42, instance})` và nhận `leaseToken`. Máy ghi `delegate = gate:gj_…`, kiểm hash, kiểm lại tự duyệt, kiểm SHA trên ref, clone, chạy, ghi receipt, rồi gọi `gate.result` và job thành `passed`. Máy nhả `gui:M` và đặt `delegate = null`.
5. Máy gọi lại `mergeQueue.gates` (idempotent) và nhận `state: "passed"`: mọi job đã `passed` trên `checkedSha`. Máy kiểm HEAD và cây sạch như hiện nay, rồi publish.
6. `mergeQueue.finish({status: "landed" | "awaiting", sha: checkedSha})`: hub kiểm mọi gate bắt buộc của lô đã `passed` với đúng `sha` và `templateHash`, rồi nhận kết quả. Máy nhả `project:`.

Job ở `requested` (không đủ điều kiện tự duyệt) thì bước 4 chờ người duyệt, trong hạn `gateWaitMinutes`. Job đỏ, lỗi hay hết hạn thì lô `failed` ở bước gate đó; hub huỷ các job còn lại của lô (`batchEnded`) và máy nhả khoá. Nhiều mục `requiredGates` thì chạy lần lượt theo thứ tự cấu hình, dừng ở mục đỏ đầu tiên.

Các quy tắc khác:

- Lấy khoá trước khi clone, nhả sau khi receipt đã ghi đĩa. Job tự do thiếu khoá thì không `take`: job giữ `approved` tới khi hết hạn, và không dừng run hay lô của người khác.
- Gate job đang chạy, kể cả job của lô, làm `gate.busy = true`. Update drain chờ nó như chờ `autoRelease.busy`/merge queue, không tự cài bản mới giữa lúc job chạy.
- App restart mà lockfile còn pid đã chết: không chạy lại job. Job trên hub sẽ thành `uncertain` khi hết lease. Lô đang ở phase `gates` lúc restart được xử lý như lô bị gián đoạn hiện nay: `failed` ở bước `recovery`, và hub huỷ các job còn lại của lô. Clone được giữ lại để đối soát, xoá sau `reconcile`.

## 8. Receipt, artifact và audit

```ts
interface GateReceipt {
  jobId: string; project: string; machineId: string;
  templateId: string; templateHash: string; sha: string;
  checkedSha: string; treeClean: boolean;
  startedAt: string; finishedAt: string;
  exitCode: number | null; signal: string | null; timedOut: boolean;
  result: { ok: boolean; checks?: { name: string; ok: boolean }[]; summary?: string } | null; // đã lọc secret
  artifacts: { name: string; type: string; bytes: number; sha256: string; required: boolean }[];
  logSha256: string;          // log ở máy, 0600; không upload
  app: string; os: { platform: string; release: string }; gui: "aqua" | "x11" | "wayland" | "none";
  outcome: "passed" | "failed" | "error" | "cancelled";
  reason: GateReason | null;
}
type GateReason = "templateChanged" | "shaNotOnRef" | "cloneFailed" | "noGui" | "lockTimeout" | "timeout" | "exitNonZero" | "resultNotOk" | "resultInvalid" | "artifactMissing" | "treeChanged" | "uploadFailed" | "cancelled" | "leaseLost" | "autoApproveRevoked" | "batchEnded";
```

- Máy ghi receipt vào `<dataDir>/gate/receipts/<hash>.json` (0600, ghi file tạm rồi rename) **trước** khi gọi `gate.result`, và gửi lại ở các heartbeat sau tới khi nhận ACK. Mất phản hồi chỉ dẫn tới gửi lại receipt, không chạy lại lệnh. Đây là mẫu 60c.
- Artifact: lấy theo `manifest.artifacts` trong `{artifactDir}`, bỏ symlink và đường dẫn có realpath ra ngoài thư mục. Loại và giới hạn theo artifact 41: png/jpg/webp/pdf/md/txt/json/log, ≤5 MB mỗi file, ≤20 file. Text được lọc known secret (`redactLines` + prefix Hive + giá trị env đã khai trong template) trước khi upload; ảnh được upload nguyên. Mỗi artifact gắn `jobId` và `sha`. Hub chỉ chấp nhận `passed` sau khi đã có đủ artifact `required` với đúng `sha256` trong receipt; thiếu thì `error/uploadFailed`.
- stdout/stderr ở lại máy (0600), giống 60c, vì có thể chứa secret chưa nhận diện. Hub chỉ có `logSha256`, `summary` đã lọc và 4 KiB cuối log đã `redactLines` để chẩn đoán.
- Audit trên hub cho mỗi transition: actor, máy, template ID + hash, SHA, reason. Tự duyệt ghi thêm thời điểm của mục lục mà hub đã dựa vào. Không lưu argv đã thay giá trị env, không lưu giá trị env và không lưu nội dung log.

## 9. RPC đề xuất (v1, chưa tồn tại) và phần nối 60b/60c

| Method | Input → output | Ai |
|---|---|---|
| `machines.heartbeat` (thêm trường) | `gate` như §3 → phản hồi thêm `gate: {ack, want}` | Machine credential, như hiện nay |
| `gate.templates` | `{project}` → mục lục theo máy; kèm manifest theo hash khi caller có `projectSettings` hoặc là chủ máy | `view` của project |
| `gate.create` | `{project, machineId, templateId, templateHash, sha, ref, purpose, idempotencyKey, expiresInMinutes?}` → `GateJob`; `purpose` chỉ nhận `manual`/`evidence` | Human cookie + `projectSettings`; template sẵn sàng (§3) |
| `gate.approve` | `{id, version, pass, reason}` → `GateJob` | Human cookie + CSRF + `projectSettings` (+ step-up khi có 69c, §5). Không phải đường tự duyệt |
| `mergeQueue.gates` | `{id, instance, checkedSha, ref}` → `{state: "waiting" \| "passed" \| "failed", jobs: GateJob[], missing: string[]}` | Machine credential của lô, cùng điều kiện với `mergeQueue.progress`. Tạo và tự duyệt job theo §5, idempotent theo `mq:<batchId>:<check>`. `checkedSha` khác lần gọi trước thì `conflict` |
| `gate.take` | `{project, batchId?, instance?}` → `{job, leaseToken} \| null` | Machine credential có `taskWork`, đúng `job.machineId`. Có `batchId` thì thêm điều kiện §7.1 |
| `gate.progress` | `{id, leaseToken, step}` → `{state, leaseUntil}` | Như `take`, khớp hash `leaseToken` |
| `gate.result` | `{id, leaseToken, receipt}` → `GateJob` | Như `take`; idempotent |
| `gate.cancel` | `{id, reason}` → `GateJob` | Human: người tạo, `projectSettings` hoặc chủ máy. Không cần step-up |
| `gate.reconcile` | `{id, outcome: "failed" \| "error", note}` → `GateJob` | Human `projectSettings`, chỉ từ `uncertain`, sau khi đã kiểm máy |
| `gate.list` / `gate.get` | `{project, ...}` → jobs, không log | `view`; agent đọc được |

Migration kế tiếp theo HEAD lúc build (không chốt số ở đây): bảng `gate_jobs` (có `batch_id`), index `(machine_id, state)`, `(project, sha)`, `(batch_id)`, unique `(project, template_hash, sha, idempotency_key)`; `gate_capabilities(machine_id, json, at)` cho mục lục; `gate_manifests(machine_id, hash, manifest, first_seen)` với khoá chính `(machine_id, hash)`, ghi một lần. Capability và setting local đều additive: app cũ bỏ qua, hub cũ không nhận `gate` thì máy không bật. Feature flag hub mặc định tắt.

**Nối hàng chờ (60b).** Thêm vào cấu hình project `requiredGates: { check: string; templateId: string; templateHash: string }[]` và `gateWaitMinutes` (mặc định 30, 1–240). Chỉ người có `projectSettings` sửa được, và hub chỉ nhận template sẵn sàng trên `mergeQueue.machineId` lúc lưu. `mergeQueue.take` chụp chúng vào `batch.config`, nên sửa giữa chừng không đổi lô đang chạy. Luồng chạy theo §7.

- Template của một check không còn sẵn sàng lúc `mergeQueue.gates` (chủ máy sửa template nên hash đổi) thì hub không tạo job cho check đó, trả nó trong `missing`, và lô `failed`. Lô sau tiếp tục fail cho tới khi người có `projectSettings` cập nhật `requiredGates` theo hash mới; màn cài đặt hiện hash mới cùng chỗ khác nhau giữa hai manifest. Sửa template là phải đồng ý lại.
- `mergeQueue.finish` với `landed`/`awaiting` bị từ chối (`conflict`) nếu một check thiếu job `passed`, hoặc job đó lệch `sha` với `result.sha` hay lệch `templateHash` với bản chụp.
- `checks` gửi cho `autoRelease.green` gồm cả tên các gate này, nên 60c không cần đổi.

**R-69h3 (đề xuất, chưa có trên board).** Chuyển `mergeQueue.commands` từ chuỗi shell lưu ở hub sang template local theo §3, kèm env dựng từ đầu như §6.4. Hiện người có `projectSettings` (không nhất thiết là chủ máy) đặt được lệnh chạy bằng `/bin/sh` trên máy cổng kiểm với env đầy đủ của app. Lỗ này có sẵn trước 69 và không thuộc phạm vi 69h1, nhưng cũng là đường nâng quyền mà §6 chặn cho gate job. Đề xuất: dependsOn `R-69h1`, kind feature, size m, risk high.

## 10. Tiêu chí cho 69h2 (AC09 và phần gate của AC10)

| ID | Phải chứng minh bằng test hoặc bằng chứng thật |
|---|---|
| G01 | Credential run/MCP/chat và machine bearer không gọi được create/approve/cancel/reconcile; credential run/MCP không gọi được `mergeQueue.gates`; machine khác (hoặc cùng máy, sai `leaseToken`) không take/result được job |
| G02 | Hash lệch giữa công bố và local thì `templateChanged`, không spawn; sửa `autoApprove` làm job đã duyệt mất hiệu lực. Manifest sai hash, sai schema, chứa secret, hoặc không có trong mục lục cùng heartbeat thì hub không lưu và không ACK; hash trong `want` được gửi lại |
| G03 | SHA không thuộc ref thì `shaNotOnRef`; hết hạn thì `expired`; job `passed` không ghi đè được; receipt gửi lặp thì idempotent |
| G04 | Test đỏ thật (exit ≠ 0, và `ok: false` khi exit 0) cho ra `failed` dù đủ ảnh; thiếu artifact required thì không xanh; gate sửa file tracked thì `treeChanged` |
| G05 | Env của process không có token Hive, credential run/MCP hay env profile (canary synthetic); clone không có remote |
| G06 | Khoá: lô merge/release cùng project, hoặc job GUI khác, đang chạy thì `take` không kèm `batchId` trả null; update drain chờ `gate.busy`; restart giữa lúc chạy thì `uncertain`, không chạy lại; restart ở phase `gates` thì lô `failed/recovery` và job còn lại `cancelled/batchEnded` |
| G07 | Tự duyệt chỉ xảy ra trong `mergeQueue.gates`. Hub không tự duyệt khi mục lục báo `autoApprove: false`, manifest `autoApprove: false`, hub hạ trần, máy là `releaseMachine`, hoặc purpose khác `mergeQueue`. Máy tắt tự duyệt hoặc cấu hình `autoRelease` sau khi hub đã duyệt thì `autoApproveRevoked`, không spawn |
| G08 | Chạy thật trên macmini ngoài sandbox: `npm run smoke -w @xdev-hive/desktop` và `e2e`/`e2e:mobile` của web, cho ra ảnh + `result.json` gắn đúng SHA; một nhánh cố ý làm hỏng một bước e2e cho ra gate đỏ |
| G09 | Luồng thành công §7 với fixture local: lô → job bắt buộc (một lần tự duyệt, một lần người duyệt trong lúc lô chờ) → `passed` → publish → `finish` được nhận, không lời gọi nào chờ quá hạn. Cùng fixture: job đỏ hoặc hết hạn làm lô `failed` và nhả khoá; `finish` xanh bị từ chối khi job thiếu, đỏ, lệch `sha` hay lệch hash; job có `batchId` không lấy được bằng `take` không kèm `batchId`, từ instance khác, hay khi process không giữ khoá của lô; job GUI tự do đang giữ `gui:` chỉ làm lô chờ, không gây deadlock |
| G10 | Lease không vượt `claimedAt + manifest.timeoutMinutes + 10 phút` dù máy gửi `progress` liên tục; màn duyệt hiển thị argv, tên env và timeout lấy từ manifest đúng hash của job |

## 11. Rủi ro còn lại

- Code ở SHA có quyền của OS user trên máy GUI. Phê duyệt và kiểm ref chỉ giảm khả năng chạy code lạ, không cách ly. Cách ly thật cần OS account riêng (§6.5). Đây là điều kiện review phải chấp nhận trước khi bật tự duyệt.
- Lô giữ khoá project trong lúc chờ người duyệt, tối đa `gateWaitMinutes`. Lockfile merge queue hiện là của cả máy, nên trong thời gian đó máy cổng kiểm không chạy lô hay release nào khác. Vì vậy hạn mặc định ngắn (30 phút), và tự duyệt là đường bình thường cho merge queue.
- Manifest cho người có `projectSettings` thấy argv, đường dẫn local và tên env. Giá trị env không rời máy và argv qua `assertNoSecret` ở cả hai đầu, nhưng secret chưa nhận diện mà chủ máy đặt thẳng vào argv vẫn lộ.
- GUI/TCC trên macOS phụ thuộc session đang đăng nhập. `guiReady` chỉ là tự khai của máy; 69h2 phải kiểm session thật trước khi chạy, và báo `noGui` thay vì treo.
- Lọc secret theo known secret không bắt được secret chưa biết trong ảnh/log. Vì vậy log ở lại máy và chỉ upload artifact theo allowlist.
- `mergeQueue.commands` hiện có vẫn là đường chạy lệnh từ hub cho tới khi R-69h3 xong.
