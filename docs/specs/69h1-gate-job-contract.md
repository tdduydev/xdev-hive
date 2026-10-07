# 69h1: contract của gate job

Trạng thái: **contract để review**, chưa triển khai. Task `R-69h1`, 2026-10-07, nền `c6e1d52aae` (0.145.2). Thuộc [69-remote-terminal.md](69-remote-terminal.md) §13, phương án (d) ở §3. Executor là `R-69h2`; tài liệu này chỉ chốt giao diện, quyền và tiêu chí để 69h2 làm và review đối chiếu.

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
| `apps/desktop/src/main/runner/auto-release.ts` | argv lưu local ở máy, `spawn` không qua shell, clone riêng theo SHA, receipt 0600 ghi trước RPC rồi gửi lại, `killTree`, không tự chạy lại sau restart | Gate job dùng lại cách này: argv local, clone sạch, receipt bền vững, không retry side effect |
| `packages/core/src/sqlite.ts` `call()` + `AGENT_METHODS` | Credential run/MCP chỉ gọi được method trong allowlist; run chỉ sửa task của mình | Mọi method ghi của gate nằm ngoài `AGENT_METHODS` |
| Memory #869 (60c) | Báo kết quả của máy cổng kiểm dùng `taskWork` + ID máy đã pin, không qua `runDispatch` | Gate `take/progress/result` dùng cùng mô hình, ràng buộc thêm `leaseToken` |
| Memory #1011 | PTY không giữ được lệnh dài hoặc lệnh tự ảnh hưởng hub | Việc dài đi qua gate/60c có receipt, không qua terminal |

## 3. Template tin cậy và hash

Template là **thiết lập local của máy**, do chủ máy cấu hình trong app desktop (Cài đặt → service → Gate job), giống argv của 60c. Hub không tạo, sửa hay gửi argv. Hub chỉ biết ID, version, hash và nhãn mà máy công bố.

```ts
interface GateTemplate {
  id: string;              // /^[a-z0-9][a-z0-9-]{0,39}$/, duy nhất trong một project của máy
  version: number;         // chủ máy tăng khi sửa; hash vẫn là thứ ràng buộc
  label: string;           // ≤80 ký tự, hiển thị; không đưa vào argv
  argv: string[];          // 1–64 phần tử, mỗi phần tử ≤1000 ký tự; argv[0] là đường dẫn tuyệt đối hoặc tên trong PATH đã chốt
  env: string[];           // TÊN biến lấy từ env local, /^[A-Z_][A-Z0-9_]{0,63}$/; giá trị không bao giờ rời máy
  timeoutMinutes: number;  // 1–120
  gui: boolean;            // cần session GUI; khoá GUI của cả máy (§7)
  resultFile: string | null;   // đường dẫn tương đối trong {artifactDir}, ví dụ "result.json"
  artifacts: { glob: string; required: boolean }[]; // tương đối trong {artifactDir}, ≤8 mục
  autoApprove: boolean;    // chỉ có hiệu lực khi gateJobs.autoApprove của máy cũng bật (§5)
}
```

**Placeholder đóng.** Một phần tử argv chỉ có thể là chữ thường, hoặc chứa đúng một trong `{sha}`, `{jobId}`, `{artifactDir}`. Giá trị do máy sinh (`{artifactDir}` là thư mục 0700 của job, `{jobId}` từ hub đã kiểm `/^gj_[a-z0-9]{20}$/`) hoặc đã kiểm định dạng (`{sha}` là hex 40/64). Không có placeholder cho text người dùng, nhánh, tên task hay prompt. Cần biến thể khác thì tạo template khác. v1 không có tham số tuỳ biến.

**Hash.** `templateHash = sha256(canonicalJson(t))` dạng hex, với `canonicalJson` sắp xếp khoá theo thứ tự byte và không có khoảng trắng, áp cho mọi trường trừ `label`. `autoApprove` nằm trong hash, nên bật nó là đổi hash và các job đã duyệt theo hash cũ đều mất hiệu lực.

**Công bố.** Heartbeat thêm capability, máy cũ thiếu trường này thì hub coi như không hỗ trợ:

```ts
gate?: { protocol: 1; enabled: boolean; guiReady: boolean; projects: { name: string; templates: { id: string; version: number; hash: string; label: string; gui: boolean }[] }[] }
```

Hub lưu bản công bố cuối cùng của từng máy. Quan hệ máy↔account lấy từ token đã xác thực, không lấy label hay `x-hive-source` (memory #989/#990).

**Kiểm hai đầu.** `gate.create` chỉ nhận `templateId + templateHash` đang có trong bản công bố của đúng máy và project. Khi `take`, máy tính lại hash từ template local. Khác hash (template bị sửa hoặc xoá sau khi duyệt) thì job thành `error` với reason `templateChanged` và **không chạy gì**.

**Cái template không bảo vệ.** argv cố định nhưng `npm test` vẫn chạy code của repo tại SHA đó: script, config và test do agent viết. Hash chỉ chốt *hình dạng* lệnh; còn *code được chạy* thì do SHA và phê duyệt chốt (§5–§6).

## 4. Job, vòng đời và hạn

```ts
interface GateJob {
  id: string;                 // gj_ + 20 ký tự base32 ngẫu nhiên
  project: string;
  machineId: string;          // ID trong machines.list, bất biến
  templateId: string; templateHash: string;
  sha: string;                // hex 40/64, bất biến
  ref: string;                // validMergeRef; nhánh mà máy phải tìm thấy sha trên đó (§5)
  purpose: "mergeQueue" | "manual" | "evidence";
  requestedBy: string;        // account của người, hoặc "mergeQueue:<batchId>"
  idempotencyKey: string;     // ≤80; (project, templateHash, sha, idempotencyKey) là duy nhất
  state: GateState; reason: GateReason | null; version: number; // CAS
  approval: { mode: "human" | "auto"; by: string | null; at: string } | null;
  expiresAt: string;          // UTC
  leaseUntil: string | null;  // UTC, chỉ khi claimed/running
  receipt: GateReceipt | null;
}
type GateState = "requested" | "approved" | "claimed" | "running" | "passed" | "failed" | "error" | "rejected" | "expired" | "cancelled" | "uncertain";
```

```
requested ──approve──▶ approved ──take──▶ claimed ──progress──▶ running ──result──▶ passed | failed | error
    │ reject/expire        │ expire/cancel     │ lease hết, chưa có receipt ─▶ uncertain ──reconcile──▶ failed | error
    ▼                      ▼                   ▼
 rejected | expired     expired | cancelled  cancelled (máy kill rồi gửi receipt)
```

- Mọi transition đi qua CAS theo `version`, có reason enum và dòng audit trong cùng giao dịch.
- `expiresAt`: mặc định 24 giờ kể từ create, tối đa 72 giờ. Job chưa được `take` trước hạn thì thành `expired`. Hạn không bao giờ được kéo dài: muốn chạy lại thì tạo job mới.
- `take` cấp `leaseToken` 256-bit (hub chỉ lưu hash) và `leaseUntil = now + 2 phút`. `progress` gia hạn thêm 2 phút, không vượt `claimedAt + timeoutMinutes + 10 phút`. Hết lease mà chưa có receipt thì job thành `uncertain`. Hub **không bao giờ** trả lại job đó cho `take`.
- `cancel` khi job đang chạy: `progress` kế tiếp trả `cancelled`, máy `killTree` (SIGTERM, 5 giây sau SIGKILL) rồi gửi receipt `outcome: "cancelled"`.
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
| `manual` / `evidence` | Human cookie (không phải bearer, không tin `x-hive-source`) có `projectSettings` của project; máy đang công bố template đó và `gate.enabled`; máy có project trong danh sách |
| `mergeQueue` | Hub tự tạo từ `requiredGates` của project (§9) khi máy cổng kiểm báo `checkedSha` của lô; máy chỉ báo SHA, không chọn template; `requestedBy = mergeQueue:<batchId>` |

Credential run, MCP, chat leader và machine bearer không tạo được job. Chat leader chỉ đưa link tới form.

**Phê duyệt.** Một job mới luôn ở `requested`. Muốn sang `approved` thì cần một trong hai:

- **Người duyệt**: `gate.approve({id, version, pass, reason})` từ human cookie + CSRF, có `projectSettings`, account đang hoạt động. Màn duyệt hiển thị máy, OS user, template label + hash, argv đã thay placeholder, tên env, SHA, ref và danh sách file đổi giữa merge-base của `ref` và target branch với SHA. Các đường dẫn rủi ro (`package.json`, lockfile, `scripts/`, `e2e/`, config test/build, `.github/`, `deploy/`) được đánh dấu riêng. Khi 69c xong, job có SHA không nằm trên target branch cần thêm step-up còn hạn. Người tạo được tự duyệt job của mình, vì tạo cũng chỉ người làm được.
- **Tự duyệt**: cần đủ bốn điều: (1) `purpose = mergeQueue`; (2) máy bật local `gateJobs.autoApprove = true`, hub không bật thay được; (3) template có `autoApprove: true`; (4) máy **không** cấu hình `autoRelease` cho cùng project. App từ chối lưu tổ hợp này, vì code của agent chạy bằng OS user đang giữ credential phát hành. Hub hạ trần được (`gateAutoApprove: false` theo project/hub), không nâng trần được.

Phê duyệt gắn với `(project, machineId, templateId, templateHash, sha, ref)`. Đổi bất kỳ trường nào cũng phải tạo job mới và duyệt lại.

**SHA phải có thật trên ref.** Khi `take`, máy fetch `ref` từ remote `origin` của project (repo local không có remote thì dùng ref local, như fixture 60c) và kiểm `git merge-base --is-ancestor <sha> <ref-tip>`. Không thoả thì `error/shaNotOnRef`. Như vậy hub không đẩy được một commit tuỳ ý (hay commit chỉ có trên máy khác) vào executor. Với `mergeQueue`, job luôn được giao cho chính máy đang giữ lô, ref là nhánh lô local mà máy đó vừa tạo, nên kiểm trên ref local thay vì `origin`.

## 6. Run không tự nâng quyền

Các bất biến này 69h2 phải có test:

1. `gate.create/approve/reject/cancel/reconcile/take/progress/result` **không** nằm trong `AGENT_METHODS`. `gate.get/list` thì có, để agent đọc kết quả của project mình; filter vẫn kiểm project.
2. Không có trường nào của job lấy từ text của task, note, chat, prompt hay output của run. Run không chọn được template, argv, env, cwd, timeout hay máy.
3. Kết quả gate không đổi autonomy, sandbox, policy (27a) hay credential của bất kỳ run nào. Runner không bao giờ chạy lại một lệnh bị sandbox chặn bằng gate. Gate đỏ không tự tạo job với quyền rộng hơn.
4. Env của process gate được dựng từ đầu, không kế thừa `process.env` của app: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `TERM=dumb`, các biến GUI cần cho session (`DISPLAY`, `WAYLAND_DISPLAY`, `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` trên Linux), các tên trong `template.env`, và `HIVE_GATE_JOB`, `HIVE_GATE_SHA`, `HIVE_GATE_ARTIFACTS`. Không có token máy, `hiverun_`/`hivemcp_`, cấu hình MCP, env của profile agent hay biến `autoRelease`. App từ chối lưu template mà `env` chứa tên trùng biến secret đã biết của profile/hub.
5. Clone của job bỏ remote sau khi fetch (`git remote remove origin`) và đặt `GIT_TERMINAL_PROMPT=0`, để test không `push` theo đường quen thuộc. Đây chỉ là phòng thủ thêm. **Cùng OS user nghĩa là không có cách ly**: code ở SHA đọc được mọi thứ OS user đọc được (`~/.ssh`, keychain đã mở khoá, credential helper). Muốn cách ly thì máy GUI chạy app bằng OS account riêng, không có credential phát hành hay production. Màn duyệt và cài đặt local phải ghi rõ điều này.
6. Gate xanh không phải quyền phát hành. 60c chỉ nhận receipt gate làm bằng chứng cho một check qua ánh xạ `requiredGates` mà người cấu hình. Hub so `templateHash` và `sha` của receipt với ánh xạ đó và với SHA của lô; lệch thì check coi như thiếu.

## 7. Khoá tài nguyên

Khoá ở máy, cùng một registry với merge queue, auto-release và terminal 69e. Spec 69 §11 gọi đây là "resource lock chung". Lockfile chứa pid theo mẫu `merge-queue.ts`.

| Khoá | Ai giữ | Gate job cần |
|---|---|---|
| `project:<machine>/<project>` | lô merge queue, lô auto-release, gate job | Có. Một trong ba tại một thời điểm cho mỗi project trên máy |
| `gui:<machine>` | gate job `gui: true`; GUI smoke/release cần cửa sổ | Có, nếu `template.gui`. Chỉ một job GUI trên máy |
| `checkout:<realpath>` | run, terminal, merge | Không. Gate dùng clone riêng của job trong `<dataDir>/gate/<hash(jobId)>`, không đụng checkout của người dùng hay run |

- Lấy khoá trước khi clone, nhả sau khi receipt đã ghi đĩa. Thiếu khoá thì không `take`: job giữ `approved` tới khi hết hạn, và không dừng run hay lô của người khác.
- Gate job đang chạy làm `gate.busy = true`. Update drain chờ nó như chờ `autoRelease.busy`/merge queue, không tự cài bản mới giữa lúc job chạy.
- App restart mà lockfile còn pid đã chết: không chạy lại. Job trên hub sẽ thành `uncertain` khi hết lease. Clone được giữ lại để đối soát, xoá sau `reconcile`.

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
type GateReason = "templateChanged" | "shaNotOnRef" | "cloneFailed" | "noGui" | "lockTimeout" | "timeout" | "exitNonZero" | "resultNotOk" | "resultInvalid" | "artifactMissing" | "treeChanged" | "uploadFailed" | "cancelled" | "leaseLost";
```

- Máy ghi receipt vào `<dataDir>/gate/receipts/<hash>.json` (0600, ghi file tạm rồi rename) **trước** khi gọi `gate.result`, và gửi lại ở các heartbeat sau tới khi nhận ACK. Mất phản hồi chỉ dẫn tới gửi lại receipt, không chạy lại lệnh. Đây là mẫu 60c.
- Artifact: lấy theo `template.artifacts` trong `{artifactDir}`, bỏ symlink và đường dẫn có realpath ra ngoài thư mục. Loại và giới hạn theo artifact 41: png/jpg/webp/pdf/md/txt/json/log, ≤5 MB mỗi file, ≤20 file. Text được lọc known secret (`redactLines` + prefix Hive + giá trị env đã khai trong template) trước khi upload; ảnh được upload nguyên. Mỗi artifact gắn `jobId` và `sha`. Hub chỉ chấp nhận `passed` sau khi đã có đủ artifact `required` với đúng `sha256` trong receipt; thiếu thì `error/uploadFailed`.
- stdout/stderr ở lại máy (0600), giống 60c, vì có thể chứa secret chưa nhận diện. Hub chỉ có `logSha256`, `summary` đã lọc và 4 KiB cuối log đã `redactLines` để chẩn đoán.
- Audit trên hub cho mỗi transition: actor, máy, template ID + hash, SHA, reason. Không lưu argv đã thay giá trị env, không lưu giá trị env và không lưu nội dung log.

## 9. RPC đề xuất (v1, chưa tồn tại) và phần nối 60b/60c

| Method | Input → output | Ai |
|---|---|---|
| `gate.templates` | `{project}` → template theo máy (từ công bố) | `view` của project |
| `gate.create` | `{project, machineId, templateId, templateHash, sha, ref, purpose, idempotencyKey, expiresInMinutes?}` → `GateJob` | Human cookie + `projectSettings`; hub nội bộ cho `mergeQueue` |
| `gate.approve` | `{id, version, pass, reason}` → `GateJob` | Human cookie + CSRF + `projectSettings` (+ step-up khi có 69c, §5) |
| `gate.take` | `{project}` → `{job, leaseToken} \| null` | Machine credential có `taskWork`, đúng `job.machineId` |
| `gate.progress` | `{id, leaseToken, step}` → `{state, leaseUntil}` | Như `take`, khớp hash `leaseToken` |
| `gate.result` | `{id, leaseToken, receipt}` → `GateJob` | Như `take`; idempotent |
| `gate.cancel` | `{id, reason}` → `GateJob` | Human: người tạo, `projectSettings` hoặc chủ máy. Không cần step-up |
| `gate.reconcile` | `{id, outcome: "failed" \| "error", note}` → `GateJob` | Human `projectSettings`, chỉ từ `uncertain`, sau khi đã kiểm máy |
| `gate.list` / `gate.get` | `{project, ...}` → jobs, không log | `view`; agent đọc được |

Migration kế tiếp theo HEAD lúc build (không chốt số ở đây): bảng `gate_jobs`, index `(machine_id, state)`, `(project, sha)`, unique `(project, template_hash, sha, idempotency_key)`, và `gate_capabilities(machine_id, json, at)`. Capability và setting local đều additive: app cũ bỏ qua, hub cũ không nhận `gate` thì máy không bật. Feature flag hub mặc định tắt.

**Nối hàng chờ (60b).** Thêm `requiredGates: { check: string; templateId: string; templateHash: string }[]` vào cấu hình project, chỉ người có `projectSettings` sửa được. Khi lô đã qua các lệnh cấu hình và có `checkedSha`, máy cổng kiểm gọi `mergeQueue.gates({id, instance, checkedSha})` (cùng quyền với `mergeQueue.finish`), và hub tạo các gate job `mergeQueue` theo `requiredGates`, giao cho máy của lô. Lô chỉ được publish khi mọi job `passed` trên đúng `checkedSha`. Job đỏ, lỗi hay hết hạn thì lô `failed`, cùng đường lỗi như gate hiện có. `checks` gửi cho `autoRelease.green` gồm cả tên các gate này, nên 60c không cần đổi.

**R-69h3 (đề xuất, chưa có trên board).** Chuyển `mergeQueue.commands` từ chuỗi shell lưu ở hub sang template local theo §3, kèm env dựng từ đầu như §6.4. Hiện người có `projectSettings` (không nhất thiết là chủ máy) đặt được lệnh chạy bằng `/bin/sh` trên máy cổng kiểm với env đầy đủ của app. Lỗ này có sẵn trước 69 và không thuộc phạm vi 69h1, nhưng cũng là đường nâng quyền mà §6 chặn cho gate job. Đề xuất: dependsOn `R-69h1`, kind feature, size m, risk high.

## 10. Tiêu chí cho 69h2 (AC09 và phần gate của AC10)

| ID | Phải chứng minh bằng test hoặc bằng chứng thật |
|---|---|
| G01 | Credential run/MCP/chat và machine bearer không gọi được create/approve/cancel/reconcile; machine khác (hoặc cùng máy, sai `leaseToken`) không take/result được job |
| G02 | Hash lệch giữa công bố và local thì `templateChanged`, không spawn; sửa `autoApprove` làm job đã duyệt mất hiệu lực |
| G03 | SHA không thuộc ref thì `shaNotOnRef`; hết hạn thì `expired`; job `passed` không ghi đè được; receipt gửi lặp thì idempotent |
| G04 | Test đỏ thật (exit ≠ 0, và `ok: false` khi exit 0) cho ra `failed` dù đủ ảnh; thiếu artifact required thì không xanh; gate sửa file tracked thì `treeChanged` |
| G05 | Env của process không có token Hive, credential run/MCP hay env profile (canary synthetic); clone không có remote |
| G06 | Khoá: lô merge/release cùng project, hoặc job GUI khác, đang chạy thì `take` trả null; update drain chờ `gate.busy`; restart giữa lúc chạy thì `uncertain`, không chạy lại |
| G07 | Tự duyệt bị từ chối khi máy có `autoRelease` cho project, khi hub hạ trần, hoặc khi purpose khác `mergeQueue` |
| G08 | Chạy thật trên macmini ngoài sandbox: `npm run smoke -w @xdev-hive/desktop` và `e2e`/`e2e:mobile` của web, cho ra ảnh + `result.json` gắn đúng SHA; một nhánh cố ý làm hỏng một bước e2e cho ra gate đỏ |

## 11. Rủi ro còn lại

- Code ở SHA có quyền của OS user trên máy GUI. Phê duyệt và kiểm ref chỉ giảm khả năng chạy code lạ, không cách ly. Cách ly thật cần OS account riêng (§6.5). Đây là điều kiện review phải chấp nhận trước khi bật tự duyệt.
- GUI/TCC trên macOS phụ thuộc session đang đăng nhập. `guiReady` chỉ là tự khai của máy; 69h2 phải kiểm session thật trước khi chạy, và báo `noGui` thay vì treo.
- Lọc secret theo known secret không bắt được secret chưa biết trong ảnh/log. Vì vậy log ở lại máy và chỉ upload artifact theo allowlist.
- `mergeQueue.commands` hiện có vẫn là đường chạy lệnh từ hub cho tới khi R-69h3 xong.
