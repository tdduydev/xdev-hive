# Hợp đồng: `hive-worker branches` và lệnh Tauri `git_branches_*`

**Task**: T003 · **Date**: 2026-10-20 · **Spec**: [../spec.md](../spec.md) · **Plan**: [../plan.md](../plan.md)

File này là nguồn chung cho Go (`worker/internal/branches`, `cmd/hive-worker/branches.go`), Rust
(`src-tauri/src/git_branches.rs`) và React (`apps/desktop/src/lib/git-branches.ts`). Task sau thấy thiếu thì ghi bàn
giao, không tự đổi file này (tasks.md "Hợp đồng trước").

Kiểu TypeScript trong `git-branches.ts` là bản viết tay của các kiểu ở đây. Tên trường JSON là camelCase như `gitgroups`.

## 1. Quy tắc chung

### 1.1. Gọi

```text
hive-worker branches <lệnh con> [--cờ=giá trị …] [--timeout=<giây>]
```

- Lệnh con: `status`, `list`, `fetch`, `pull`, `switch`, `create`, `scan`, `clean`, `settings`, `settings-set`, `merge`,
  `rebase`, `continue`, `abort`.
- Cờ viết `--tên=giá trị` (như `sidecar_json` hiện nay). Cờ lặp được (`--folder`) ghi rõ ở từng lệnh. Cờ boolean viết
  `--carry` (bật), không truyền là tắt.
- Tên nhánh, đường dẫn đi nguyên trong giá trị cờ, không qua shell. Rust truyền bằng `args`, không ghép chuỗi lệnh.
- Mọi đường dẫn vào là đường dẫn tuyệt đối. Mọi đường dẫn ra đã qua `filepath.Clean` (dấu phân cách của hệ điều hành,
  kể cả khi `git worktree list` trả `C:/…`). So đường dẫn bằng `repolock.SamePath` / `InsideDir` (Windows không phân
  biệt hoa thường).
- Mã đỉnh, mã commit là SHA đầy đủ 40 (hay 64) ký tự hex. Thời điểm commit là giây Unix (`committedAt`). Thời điểm khác
  là chuỗi RFC 3339 UTC.

### 1.2. Stdin

Mọi lệnh con đọc **dòng đầu stdin** là một JSON `Input` (plan.md mục 4):

```ts
interface Input {
  busy?: BusyDir[];                       // thư mục đang dùng, mọi lệnh
  items?: CleanItem[];                    // chỉ clean
  fetched?: Record<string, string[]>;     // chỉ clean: thư mục chính → remote fetch được lúc quét
  settings?: BranchSettingsInput;         // chỉ settings-set
}
interface BusyDir {
  path: string;                           // thư mục làm việc của agent, terminal, cửa sổ app
  kind: "agent" | "terminal" | "app";
  label?: string;                         // vd. "claude (pid 4242)", để hiện trong lỗi busy
}
```

- Rust **luôn** ghi dòng đầu (ít nhất `{}`), kết thúc bằng `\n`. Sidecar đọc bằng một `bufio.Reader` (`input.go`),
  không dùng `bufio.Scanner` (giới hạn 64 KB một dòng). Bỏ `\r` cuối dòng (Windows).
- Stdin đóng (EOF) trước khi có dòng nào thì coi như `{}`. Dòng đầu không phải JSON hợp lệ thì lỗi `invalid_input`.
- Lệnh một lần (`status`, `list`, `switch`, `create`, `settings`, `settings-set`, `merge`, `rebase`, `continue`,
  `abort`): Rust ghi dòng đầu rồi **đóng** stdin. Riêng `list` Rust giữ stdin mở để gửi `cancel` (mục 3.2).
- Job (`fetch`, `pull`, `scan`, `clean`) và `list`: các dòng sau dòng đầu là một trong:
  - `cancel` → huỷ (mục 1.5);
  - `{"busy":[…]}` → danh sách thư mục đang dùng **mới thay cũ**. Rust gửi lại mỗi 5 giây trong lúc job chạy.
    Trường khác trong dòng sau bị bỏ qua.
- EOF sau dòng đầu **không** phải là huỷ: sidecar dùng danh sách `busy` cuối cùng đã nhận và chạy tiếp.
- Dòng sau không hiểu được thì bỏ qua (ghi stderr), không dừng job.

### 1.3. Thư mục đang dùng (`busy`)

Một thư mục `B` trong `busy` thuộc về worktree `W` của repo khi `W` là worktree có đường dẫn **dài nhất** chứa `B`
(`InsideDir(W, B)` hay `SamePath(W, B)`), xét mọi worktree của repo trong `git worktree list`. Vì vậy agent ở thư mục
chính không chặn worktree trong `.claude/worktrees/`, và agent trong worktree con không chặn thư mục chính (plan.md mục
5).

Worktree nằm dưới `repolock.DataDir()` mang `busy: "hiveWorker"` do sidecar tự tính; Rust không gửi các thư mục này.

### 1.4. Stdout, mã thoát

- Lệnh một lần in **đúng một** JSON kết quả rồi thoát `0`, kể cả khi lỗi nghiệp vụ: kết quả có trường `error`
  (mục 1.6). Riêng `list` in thêm dòng sự kiện sau dòng kết quả (mục 3.2).
- Job in mỗi dòng một JSON sự kiện (mục 4), dòng cuối luôn là `{"type":"done",…}` rồi thoát `0`. Lỗi của cả job nằm ở
  `done.error`; lỗi của một repo hay một mục nằm trong sự kiện của nó.
- Thoát `2` kèm một dòng stderr tiếng Việt: cờ sai, thiếu cờ bắt buộc, lệnh con lạ. Đây là lỗi lập trình giữa Rust và
  Go; Rust trả nguyên dòng stderr làm `Err(String)`.
- Thoát khác `0`, `2` (panic…): Rust trả stderr làm `Err(String)` (lệnh một lần) hay phát `exit` (job).
- Stderr chỉ để chẩn đoán, không bao giờ chứa token (lỗi git đã qua `redact`).

### 1.5. Huỷ và giới hạn thời gian (FR-041, FR-052)

- `--timeout=<giây>` (Rust luôn truyền, giá trị ở bảng mục 5):
  - lệnh một lần: giới hạn cho cả lệnh;
  - job: giới hạn cho **một bước** (fetch một remote, quét một repo, dọn một mục).
- Giới hạn riêng của từng lệnh git trong sidecar (FR-041), lấy giá trị nhỏ hơn giữa giới hạn này và `--timeout` còn lại:
  đọc 15 giây; `fetch` 120 giây một remote; `ls-remote` 30 giây; `worktree remove` 300 giây; `merge`, `rebase`,
  `--continue`, `--abort` 120 giây; chờ khoá repo 30 giây.
- Lệnh **đọc** và **mạng** (`status`, `for-each-ref`, `fetch`, `ls-remote`…): huỷ hay hết giờ thì dừng git con ngay.
- Lệnh **ghi** (`switch`, `branch`, `branch -D`, `worktree remove`, gỡ siêu dữ liệu `prunable`, `merge`, `rebase`,
  `--continue`, `--abort`, `merge --ff-only` của pull): chạy với context riêng **không bị huỷ** bởi `cancel`. Huỷ có hiệu
  lực từ bước sau. Quá giới hạn riêng thì trả `timeout`; **không** tự `--abort` (FR-052). `list` sau đó cho biết repo có
  đang dở không.
- Rust giết sidecar khi:
  - lệnh một lần chưa trả lời sau `timeout + 30` giây;
  - job không in dòng nào trong `timeout + 30` giây (mỗi dòng đặt lại đồng hồ).
  Khi đó Rust trả `Err("Worker không phản hồi sau N giây.")` (lệnh một lần) hay phát `exit` (job).

### 1.6. Lỗi

```ts
interface BranchError {
  code: ErrorCode;
  message: string;            // câu tiếng Việt hiện được ngay; giao diện có thể dịch theo code
  detail?: string;            // dòng cuối stderr của git đã che token (FR-042)
  files?: string[];           // tối đa 20 (dirty) hay 200 (conflict), đường dẫn tương đối với thư mục làm việc
  filesTotal?: number;        // tổng số file khi danh sách bị cắt
  count?: number;             // needsConfirm: số commit đã đẩy sẽ bị viết lại
  path?: string;              // checked_out: worktree đang mở nhánh; not_repo: thư mục lỗi
  operation?: OperationKind;  // in_progress
  busy?: BusyDir[];           // busy: thư mục đang dùng trong worktree này
  ahead?: number;             // diverged
  behind?: number;            // diverged
  upstream?: string;          // diverged, no_upstream: tên upstream, vd. "origin/feature"
  upstreamTip?: string;       // diverged: mã của upstream, dùng làm --onto cho merge/rebase (US8)
  remote?: string;            // fetch_failed, auth
}
```

| `code` | Lệnh | Nghĩa | Trường thêm |
|---|---|---|---|
| `invalid_input` | mọi lệnh | Dòng đầu stdin không phải JSON đúng dạng | — |
| `not_repo` | mọi lệnh có `--folder` | Thư mục không còn hay không phải repo git (US1 kịch bản 5) | `path` |
| `not_found` | `switch`, `create`, `merge`, `rebase` | Nhánh, ref gốc hay mã `--onto` không có | `detail` |
| `invalid_name` | `create` | `git check-ref-format --branch` từ chối (FR-013) | `detail` |
| `exists` | `create`, `switch --track` | Nhánh local cùng tên đã có (US3 kịch bản 4) | — |
| `dirty` | `switch`, `create --switch`, `pull`, `merge`, `rebase` | Có thay đổi đã theo dõi (switch/create: khi thiếu `--carry`, FR-011); merge/rebase/pull: có thêm file chưa theo dõi (FR-051) | `files`, `filesTotal` |
| `in_progress` | `switch`, `create --switch`, `pull`, `merge`, `rebase` | Đang dở merge, rebase, cherry-pick, revert, bisect (FR-012) | `operation` |
| `no_operation` | `continue`, `abort` | Không có merge hay rebase nào đang dở | — |
| `checked_out` | `switch` | Nhánh đích đang mở ở worktree khác (US2 kịch bản 4) | `path` |
| `detached` | `pull`, `merge`, `rebase` | HEAD rời, cần đứng trên một nhánh (US8 kịch bản 8) | — |
| `no_upstream` | `pull` | Nhánh đang đứng không có upstream, hay upstream đã xoá | `upstream` |
| `diverged` | `pull` | Vừa ahead vừa behind; giao diện gợi ý merge/rebase (US5, US8) | `ahead`, `behind`, `upstream`, `upstreamTip` |
| `busy` | `switch`, `create`, `pull`, `merge`, `rebase` | Có agent, terminal hay cửa sổ app trong worktree mà thiếu `--confirm-busy` (FR-014, US8 kịch bản 7) | `busy` |
| `needsConfirm` | `rebase` | Nhánh có commit đã nằm trên ref remote mà thiếu `--confirm-rewrite` (FR-055) | `count` |
| `fetch_failed` | `create --fetch`, `pull` | Fetch nhánh gốc/upstream lỗi; `create` hỏi "Tạo từ bản đã có trên máy?" rồi gọi lại không `--fetch` | `remote`, `detail` |
| `auth` | `fetch`, `pull`, `create --fetch`, `scan` | Lỗi đăng nhập remote (`GitError.Auth`); không thử lại máy chủ đó trong lượt (FR-042) | `remote` |
| `locked` | mọi lệnh ghi | Chờ khoá repo quá 30 giây (worker đang giữ) | — |
| `timeout` | mọi lệnh | Hết giới hạn thời gian (mục 1.5) | `detail` |
| `cancelled` | job | Bị huỷ trước khi bắt đầu bước này | — |
| `invalid_settings` | `settings-set` | Mẫu rỗng, quá dài, ký tự điều khiển; quá 50 mục | `detail` |
| `git` | mọi lệnh | Git báo lỗi khác (vd. `switch` từ chối vì sẽ ghi đè file) | `detail` |
| `not_implemented` | mọi lệnh | Lệnh con chưa làm (khung của T004) | — |

Mã lỗi viết snake_case như tasks.md, trừ `needsConfirm` (tên trong tasks.md, spec). Giá trị liệt kê khác (kiểu, trạng
thái, lý do chặn) viết camelCase như Key Entities của spec.

`conflict` **không** là lỗi: là `GitOperation.state` (mục 2.4). Merge, rebase, continue gặp xung đột trả kết quả bình
thường với `operation.state = "conflict"`.

## 2. Kiểu dữ liệu

### 2.1. Trạng thái gọn (`status`)

```ts
interface BranchStatus {
  folder: string;
  branch?: string;            // tên ngắn, không có khi HEAD rời
  detached: boolean;
  head?: string;              // mã HEAD; không có khi repo chưa có commit
  upstream?: string;          // vd. "origin/main"
  upstreamGone: boolean;
  ahead?: number;             // so với upstream
  behind?: number;
  dirty: boolean;             // có thay đổi đã theo dõi (file chưa theo dõi không tính, như gitgroups)
  untracked: boolean;
  operation?: OperationKind;
  error?: BranchError;        // repo này lỗi (not_repo…), các trường khác bỏ trống
}
```

### 2.2. Bảng nhánh (`list`)

```ts
interface RepoBranches {
  folder: string;                    // thư mục chính
  defaultBranch?: string;            // tên ngắn, vd. "main"; không xác định thì không có
  defaultRef?: string;               // vd. "refs/remotes/origin/main"
  current: BranchStatus;             // thư mục chính, như mục 2.1 (không có error)
  operation?: GitOperation;          // repo đang dở (kể cả do người dùng tự chạy), state "conflict" hay "inProgress"
  remotes: string[];                 // `git remote`, theo thứ tự git trả
  branches: BranchInfo[];            // local trước, rồi remote chưa có local cùng tên (FR-002)
  worktrees: WorktreeInfo[];         // mục đầu là thư mục chính
  patterns: string[];                // mẫu dọn hiện tại (branches.json), để giao diện đánh dấu nhánh khớp
  slowPath: boolean;                 // git < 2.41: aheadDefault/behindDefault chỉ có cho nhánh khớp mẫu
  gitVersion?: string;
  error?: BranchError;               // có thì các trường khác có thể trống
}

interface BranchInfo {
  name: string;                      // local: "ai/X"; remote: "origin/ai/X"
  ref: string;                       // tên đầy đủ: "refs/heads/ai/X", "refs/remotes/origin/ai/X"
  kind: "local" | "remote";
  remote?: string;                   // chỉ kind remote
  upstream?: string;                 // chỉ kind local, vd. "origin/ai/X"
  upstreamGone: boolean;             // "remote đã xoá"
  aheadUpstream?: number;
  behindUpstream?: number;
  aheadDefault?: number;             // so với defaultRef
  behindDefault?: number;
  tip: string;
  committedAt: number;               // giây Unix
  subject?: string;                  // dòng đầu thông điệp commit, tối đa 200 ký tự
  worktreePath?: string;             // worktree đang mở nhánh này
  unpushed?: number;                 // chỉ nhánh local khớp mẫu hay đang đứng (plan.md mục 2)
  isCurrent: boolean;                // đang đứng ở thư mục chính
  isDefault: boolean;
  matchesPattern: boolean;
}

interface WorktreeInfo {
  path: string;
  branch?: string;                   // tên ngắn
  head?: string;
  isMain: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  bare: boolean;
  state: WorktreeState;
  files?: string[];                  // dirty/untracked: tối đa 20 file
  filesTotal?: number;
  ignoredBlocking?: string[];        // file bị bỏ qua ngoài danh sách dựng lại được (Q15), tối đa 20
  submodule: boolean;
  busy?: BusyKind;                   // ưu tiên hiveWorker > agent > terminal > app
  operation?: OperationKind;
  error?: string;                    // state "error": dòng cuối stderr đã che
}

type WorktreeState =
  | "pending"      // chưa đọc xong; sự kiện worktree sẽ đến (mục 3.2)
  | "skipped"      // dưới DataDir, không đọc (FR-024)
  | "clean" | "dirty" | "untracked" | "missing" | "unreachable" | "error";
type BusyKind = "hiveWorker" | "agent" | "terminal" | "app";
type OperationKind = "merge" | "rebase" | "cherryPick" | "revert" | "bisect";
```

- `state`: `dirty` khi có thay đổi đã theo dõi; `untracked` khi chỉ có file chưa theo dõi; file bị bỏ qua không đổi
  `state`, chỉ điền `ignoredBlocking`. `missing`: thư mục không còn, cha truy cập được (`prunable`); `unreachable`: gốc ổ
  hay thư mục cha không truy cập được (spec "Edge Cases").
- Thư mục chính có `state` ngay ở dòng kết quả. Worktree liên kết có `state: "pending"` (trừ `skipped`, `missing`,
  `unreachable`) rồi được điền qua sự kiện `worktree`.

### 2.3. Ứng viên dọn (`scan`, `clean`)

```ts
interface ScanRepo {
  folder: string;
  defaultBranch?: string;
  current?: string;                    // nhánh đang đứng ở thư mục chính
  fetched: string[];                   // remote fetch được trong lượt (rỗng khi --no-fetch hay lỗi hết)
  fetchFailed: { remote: string; message: string; auth: boolean }[];
  apiError?: string;                   // P2: "Không đọc được PR/MR: <lý do>" (US6 kịch bản 2)
  candidates: Candidate[];             // dọn được
  blocked: Candidate[];                // khớp mẫu nhưng không dọn được, có `blocked`
  suggestDefault?: { branch: string; clean: boolean }; // Q13: thư mục chính đứng ở nhánh khớp mẫu đã merge
  error?: BranchError;                 // repo lỗi (not_repo, timeout…), không có ứng viên
}

interface Candidate {
  folder: string;
  branch: string;                      // tên ngắn local
  tip: string;
  committedAt: number;
  subject?: string;
  worktree?: CandidateWorktree;
  evidence: Evidence;
  selected: boolean;                   // chọn sẵn: mergedGit/mergedApi và không prunable (Q11, plan.md mục 6)
  blocked?: BlockReason;
}

interface CandidateWorktree {
  path: string;
  prunable: boolean;                   // chỉ gỡ đăng ký, không xoá file
  agentWorktree: boolean;              // nằm trong `.claude/worktrees/` (R11: hiện rõ)
  ignored?: string[];                  // file bị bỏ qua trong danh sách dựng lại được sẽ mất theo, tối đa 20
}

interface Evidence {
  kind: "mergedGit" | "mergedApi" | "closedApi" | "none";
  onto?: string;                       // mergedGit: "origin/main"
  provider?: "github" | "gitlab";      // *Api
  number?: number;                     // PR #N / MR !N
  url?: string;
  note?: "notMerged" | "noOwnCommits" | "olderThanWindow" | "noDefaultBranch" | "prOpen"; // kind none
}

interface BlockReason {
  code: BlockCode;
  message: string;                     // câu tiếng Việt, vd. "Có 2 file chưa theo dõi"
  files?: string[];                    // tối đa 20
  filesTotal?: number;
  count?: number;                      // unpushed
  busy?: BusyDir[];
}

type BlockCode =                       // theo thứ tự xét (plan.md mục 5 bước 5), dừng ở lý do đầu
  | "hiveWorker"     // 1. worktree dưới DataDir (FR-024)
  | "busy"           // 2. agent, terminal, cửa sổ app (FR-023)
  | "unreachable"    // 3. gốc ổ hay thư mục cha không truy cập được
  | "locked"         // 4. git worktree lock
  | "submodule"      // 4.
  | "dirty"          // 4. thay đổi đã theo dõi
  | "untracked"      // 4. file chưa theo dõi
  | "ignored"        // 4. file bị bỏ qua ngoài danh sách dựng lại được (Q15)
  | "unpushed"       // 5. commit chưa đẩy (FR-021)
  | "prOpen"         // 6. PR/MR đang mở (P2, FR-020)
  | "current"        // nhánh đang đứng ở thư mục chính (Q13)
  | "checkedOutMain" // nhánh đang mở ở thư mục chính của worktree khác không gỡ được (vd. bare)
  | "noEvidence"     // không có bằng chứng merge (Evidence.kind none)
  | "needsFetch";    // FR-027: repo fetch lỗi và đỉnh không nằm trong nhánh mặc định
```

- Nhánh mặc định không bao giờ có mặt (FR-020). Nhánh không khớp mẫu không có mặt.
- `noEvidence`, `current`, `needsFetch` xét sau bước chặn 1–6 chỉ khi các bước đó không chặn; mục bị chặn ở bước 1–6
  vẫn giữ `evidence` thật.

```ts
interface CleanItem {                  // dòng đầu stdin của clean, lấy từ Candidate người dùng chọn
  folder: string;
  branch: string;
  tip: string;
  worktree?: string;                   // đường dẫn worktree; không có thì chỉ xoá nhánh
  prunable?: boolean;
  evidence: Evidence;
}

interface CleanResult {
  folder: string;
  branch: string;
  tip: string;
  worktree?: string;
  result: "removed" | "skipped" | "partial" | "error" | "cancelled";
  code?: BlockCode | "tipChanged" | "remoteGone" | "remoteMoved" | ErrorCode;
  reason?: string;                     // câu tiếng Việt, vd. "Nhánh đã đổi sau khi xem trước"
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  left?: string;                       // partial: thư mục còn lại ("Gỡ dở, còn lại <đường dẫn>")
}
```

- `removed`: đã gỡ worktree (nếu có) và xoá nhánh. `partial`: gỡ worktree dở hay lỗi, **giữ nhánh** (FR-029).
  `skipped`: kiểm lại không qua (FR-028), không ghi gì. `cancelled`: chưa chạy vì đã huỷ.
- Lệnh khôi phục `git branch <nhánh> <tip>` do giao diện dựng (`restoreCommand` trong `git-branches.ts`), không có
  trong kết quả.

### 2.4. Merge, rebase (P2, US8)

```ts
interface GitOperation {
  kind: OperationKind;                 // merge/rebase do app chạy; list còn trả cherryPick, revert, bisect
  state: "done" | "conflict" | "inProgress" | "aborted" | "error";
  branch?: string;                     // nhánh đang đứng
  onto?: { name: string; tip: string };
  headBefore?: string;                 // mã HEAD trước thao tác (FR-056)
  head?: string;                       // mã HEAD sau (done, aborted)
  conflicts: string[];                 // `git diff --name-only --diff-filter=U -z`, tối đa 200
  conflictsTotal: number;
  step?: number;                       // rebase: rebase-merge/msgnum (hay rebase-apply/next)
  total?: number;                      // rebase: rebase-merge/end (hay rebase-apply/last)
  error?: BranchError;                 // state "error"
}
```

- `state`:
  - `done`: xong, `head` là mã mới;
  - `conflict`: git dừng vì xung đột, còn file `U`;
  - `inProgress`: đang dở mà không còn file `U` (đã `add` hết, hay thao tác người dùng tự chạy dừng vì lý do khác);
  - `aborted`: `abort` xong, `head` bằng `headBefore`;
  - `error`: git lỗi không phải xung đột; repo có thể vẫn dở, `list` cho biết.
- `headBefore`: lệnh do app chạy thì là mã đọc ngay trước lệnh, đã ghi vào `branches-log.jsonl`. Repo dở do người dùng
  tự chạy thì `list` đọc `ORIG_HEAD` (merge) hay `rebase-merge/orig-head`, `rebase-apply/orig-head` (rebase)
  [Inference: các file này có khi git dừng giữa thao tác]. Không đọc được thì bỏ trống.
- Lệnh khôi phục `git reset --keep <headBefore>` do giao diện dựng (`resetKeepCommand`), app không tự chạy (FR-056).

### 2.5. Cấu hình (`settings`)

```ts
interface BranchSettings {
  path: string;                        // đường dẫn branches.json (thư mục cấu hình, cạnh worker.json)
  patterns: string[];                  // mẫu dọn, mặc định ["ai/*", "claude/*"] (Q8)
  rebuildable: string[];               // tên thư mục dựng lại được (Q15)
  defaults: { patterns: string[]; rebuildable: string[] };
}
type BranchSettingsInput = Pick<BranchSettings, "patterns" | "rebuildable">;
```

- Mẫu là glob đơn giản: `*` khớp mọi ký tự kể cả `/`; ký tự khác khớp đúng; phân biệt hoa thường (FR-033).
- `rebuildable` mặc định: `node_modules`, `dist`, `build`, `target`, `.turbo`, `.next`, `.venv`, `__pycache__`,
  `coverage`. Một file bị bỏ qua được chấp nhận khi **một đoạn bất kỳ** của đường dẫn trùng một tên trong danh sách
  (plan.md mục 5 bước 5.4).
- File không có hay hỏng thì dùng mặc định (không ghi đè file hỏng; `settings` vẫn trả mặc định).

## 3. Lệnh con

Bảng tóm tắt; chi tiết bên dưới. "Khoá" là `repolock.LocalLock(DataDir, commonDir)` dùng chung với worker (FR-025).

| Lệnh con | Kiểu | Cờ | Kết quả | Ghi | Mạng |
|---|---|---|---|---|---|
| `status` | một lần | `--folder` (lặp) | `{repos: BranchStatus[]}` | không | không |
| `list` | một lần + sự kiện | `--folder` | `RepoBranches`, rồi `worktree`…, `done` | không | không |
| `fetch` | job | `--folder`, `--remote` (lặp, tuỳ chọn) | sự kiện `progress`, `done` | ref remote | có |
| `pull` | job | `--folder`, `--confirm-busy` | sự kiện `progress`, `done` | trong khoá | có |
| `switch` | một lần | `--folder`, `--branch` hay `--track`, `--carry`, `--confirm-busy` | `SwitchResult` | trong khoá | không |
| `create` | một lần | `--folder`, `--name`, `--base`, `--switch`, `--fetch`, `--carry`, `--confirm-busy`, `--dry-run` | `CreateResult` | trong khoá | `--fetch` |
| `scan` | job | `--folder` (lặp), `--no-fetch` | sự kiện `progress`, `repo`, `done` | không | có (trừ `--no-fetch`) |
| `clean` | job | (stdin `items`, `fetched`) | sự kiện `progress`, `item`, `done` | có | `ls-remote` |
| `settings` | một lần | — | `BranchSettings` | không | không |
| `settings-set` | một lần | (stdin `settings`) | `BranchSettings` | `branches.json` | không |
| `merge` | một lần | `--folder`, `--onto`, `--onto-name`, `--ff`, `--confirm-busy` | `{operation: GitOperation}` | trong khoá | không |
| `rebase` | một lần | `--folder`, `--onto`, `--onto-name`, `--confirm-rewrite`, `--confirm-busy` | `{operation: GitOperation}` | trong khoá | không |
| `continue` | một lần | `--folder` | `{operation: GitOperation}` | trong khoá | không |
| `abort` | một lần | `--folder` | `{operation: GitOperation}` | trong khoá | không |

Mọi kết quả một lần có thể chỉ là `{"error": BranchError}` khi lỗi trước khi làm được gì.

`--folder` của `status`, `list`, `fetch`, `scan` là **thư mục chính** của repo (mục trong `projects.json`). Của `pull`,
`switch`, `create`, `merge`, `rebase`, `continue`, `abort` là **thư mục làm việc**: thư mục chính hay một worktree liên
kết (US2 "hay một worktree đã chọn"). Khoá luôn theo `git rev-parse --git-common-dir`, nên hai thư mục của cùng repo
dùng chung một khoá.

### 3.1. `status`

```text
hive-worker branches status --folder=/Users/ha/Code/shop --folder=/Users/ha/Code/api --timeout=15
```

- Mỗi thư mục chạy `git status --porcelain=v2 --branch --untracked-files=normal` và đọc thao tác dở trong `git
  rev-parse --git-dir` (FR-001, FR-012). Không gọi mạng. Song song tối đa 4 thư mục.
- Thư mục lỗi không làm lỗi cả lệnh: mục đó có `error`.

```json
{"repos":[
  {"folder":"/Users/ha/Code/shop","branch":"feature/cart","detached":false,"head":"9f1c…","upstream":"origin/feature/cart",
   "upstreamGone":false,"ahead":2,"behind":1,"dirty":true,"untracked":false},
  {"folder":"/Users/ha/Code/api","detached":true,"head":"0be3…","upstreamGone":false,"dirty":false,"untracked":false},
  {"folder":"/Users/ha/Code/old","detached":false,"upstreamGone":false,"dirty":false,"untracked":false,
   "error":{"code":"not_repo","message":"Thư mục không còn hoặc không phải repo git.","path":"/Users/ha/Code/old"}}
]}
```

### 3.2. `list`

```text
hive-worker branches list --folder=/Users/ha/Code/xdev-hive --timeout=30
```

- Bốn lệnh đọc song song (plan.md mục 2), không gọi mạng. Trạng thái từng worktree liên kết đọc sau, song song tối đa 4.
- Stdout:
  1. dòng đầu: `RepoBranches` (không có trường `type`);
  2. mỗi worktree liên kết đọc xong: `{"type":"worktree","folder":…,"worktree":WorktreeInfo}`;
  3. dòng cuối: `{"type":"done","folder":…}`.
- Stdin giữ mở: `cancel` dừng đọc trạng thái worktree, các worktree chưa xong có `state: "error"`, `error: "Đã huỷ"`.
  `busy` mới cập nhật nhãn `busy` cho các sự kiện sau.
- `RepoBranches.error` có thì không có dòng sự kiện, chỉ có `done`.

```json
{"folder":"/Users/ha/Code/xdev-hive","defaultBranch":"main","defaultRef":"refs/remotes/origin/main",
 "current":{"folder":"/Users/ha/Code/xdev-hive","branch":"main","detached":false,"head":"df58…","upstream":"origin/main",
            "upstreamGone":false,"ahead":0,"behind":3,"dirty":false,"untracked":true},
 "remotes":["origin"],"patterns":["ai/*","claude/*"],"slowPath":false,"gitVersion":"2.56.0",
 "branches":[
  {"name":"main","ref":"refs/heads/main","kind":"local","upstream":"origin/main","upstreamGone":false,"aheadUpstream":0,
   "behindUpstream":3,"aheadDefault":0,"behindDefault":3,"tip":"df58…","committedAt":1792483200,"subject":"Merge pull request #444",
   "worktreePath":"/Users/ha/Code/xdev-hive","isCurrent":true,"isDefault":true,"matchesPattern":false},
  {"name":"ai/GITBR-T003","ref":"refs/heads/ai/GITBR-T003","kind":"local","upstreamGone":false,"aheadDefault":1,
   "behindDefault":0,"tip":"1a2b…","committedAt":1792490000,"worktreePath":"/Users/ha/Code/xdev-hive-wt/GITBR-T003",
   "unpushed":1,"isCurrent":false,"isDefault":false,"matchesPattern":true},
  {"name":"origin/feature/x","ref":"refs/remotes/origin/feature/x","kind":"remote","remote":"origin","upstreamGone":false,
   "aheadDefault":4,"behindDefault":10,"tip":"77aa…","committedAt":1792000000,"isCurrent":false,"isDefault":false,
   "matchesPattern":false}
 ],
 "worktrees":[
  {"path":"/Users/ha/Code/xdev-hive","branch":"main","head":"df58…","isMain":true,"locked":false,"prunable":false,
   "bare":false,"state":"clean","submodule":false},
  {"path":"/Users/ha/Code/xdev-hive-wt/GITBR-T003","branch":"ai/GITBR-T003","head":"1a2b…","isMain":false,"locked":false,
   "prunable":false,"bare":false,"state":"pending","submodule":false,"busy":"agent"},
  {"path":"/Users/ha/Library/Caches/xdev-hive/worker/runs/r1-1","branch":"ai/HIVE-12","head":"5c5c…","isMain":false,
   "locked":false,"prunable":false,"bare":false,"state":"skipped","submodule":false,"busy":"hiveWorker"}
 ]}
{"type":"worktree","folder":"/Users/ha/Code/xdev-hive","worktree":{"path":"/Users/ha/Code/xdev-hive-wt/GITBR-T003",
 "branch":"ai/GITBR-T003","head":"1a2b…","isMain":false,"locked":false,"prunable":false,"bare":false,"state":"dirty",
 "files":["apps/desktop/src/lib/git-branches.ts"],"filesTotal":1,"submodule":false,"busy":"agent"}}
{"type":"done","folder":"/Users/ha/Code/xdev-hive"}
```

### 3.3. `fetch` (job, FR-004)

```text
hive-worker branches fetch --folder=/Users/ha/Code/shop [--remote=origin] --timeout=120
```

- Không có `--remote` thì fetch mọi remote của `git remote`, lần lượt. Mỗi remote: `git fetch --prune --quiet
  --end-of-options <remote>`, **ngoài khoá**, dùng credential của máy (`gitexec.MachineCredentials`).
- Sự kiện: mỗi remote một `progress`, cuối là `done` kèm tập remote fetch được.

```json
{"type":"progress","folder":"/Users/ha/Code/shop","step":"fetch","remote":"origin","result":"done"}
{"type":"progress","folder":"/Users/ha/Code/shop","step":"fetch","remote":"upstream","result":"failed",
 "error":{"code":"auth","message":"Remote từ chối đăng nhập.","remote":"upstream"}}
{"type":"done","folder":"/Users/ha/Code/shop","fetched":["origin"],
 "fetchFailed":[{"remote":"upstream","message":"Remote từ chối đăng nhập.","auth":true}],"fetchedAt":"2026-10-20T03:15:00Z"}
```

- `done.fetchedAt` chỉ có khi ít nhất một remote thành công. App giữ thời điểm này trong bộ nhớ (FR-004).

### 3.4. `pull` (job, US5)

```text
hive-worker branches pull --folder=/Users/ha/Code/shop [--confirm-busy] --timeout=120
```

Thứ tự kiểm (dừng ở lỗi đầu): `not_repo` → `detached` → `in_progress` → `busy` → `no_upstream` → `dirty` (kể cả file
chưa theo dõi) → fetch remote của upstream ngoài khoá (`fetch_failed`, `auth`) → đọc lại ahead/behind → `diverged` →
trong khoá: `git merge --ff-only --quiet <mã upstream>`.

```json
{"type":"progress","folder":"/Users/ha/Code/shop","step":"fetch","remote":"origin","result":"done"}
{"type":"progress","folder":"/Users/ha/Code/shop","step":"merge"}
{"type":"done","folder":"/Users/ha/Code/shop","pull":{"state":"done","headBefore":"9f1c…","head":"ab12…","behind":3}}
```

- `pull.state`: `done` (đã tiến nhanh) hay `unchanged` (không behind). Lỗi nằm ở `done.error`:

```json
{"type":"done","folder":"/Users/ha/Code/shop","error":{"code":"diverged","message":"Nhánh vừa có commit mới ở máy vừa thiếu commit của origin/feature/cart.",
 "ahead":2,"behind":1,"upstream":"origin/feature/cart","upstreamTip":"c0ff…"}}
```

### 3.5. `switch` (US2, FR-010…FR-012, FR-014)

```text
hive-worker branches switch --folder=/Users/ha/Code/shop --branch=feature/cart [--carry] [--confirm-busy] --timeout=60
hive-worker branches switch --folder=/Users/ha/Code/shop --track=origin/feature/x [--carry] [--confirm-busy] --timeout=60
```

- Đúng một trong `--branch` (nhánh local, kiểm `refs/heads/<tên>`) và `--track` (`<remote>/<tên>`, kiểm
  `refs/remotes/<remote>/<tên>`; tạo nhánh local `<tên>` theo dõi nó; local cùng tên đã có thì `exists`).
- Thứ tự kiểm: `not_repo` → `not_found` → `in_progress` → `checked_out` (nhánh mở ở worktree khác) → `busy` → `dirty`
  (chỉ thay đổi đã theo dõi, khi thiếu `--carry`; Q10) → trong khoá: `git switch [--track] --end-of-options <nhánh>`.
  Không `--force`, `--discard-changes`, `--merge` (FR-010).
- Git từ chối (thay đổi đụng file khác nhau giữa hai nhánh…) → `git` với `detail`; thư mục giữ nguyên.

```ts
interface SwitchResult { folder: string; branch: string; headBefore?: string; head: string; carried: boolean }
```

```json
{"folder":"/Users/ha/Code/shop","branch":"feature/x","headBefore":"9f1c…","head":"77aa…","carried":false}
{"error":{"code":"dirty","message":"Thư mục có 3 file đang sửa.","files":["src/a.ts","src/b.ts","README.md"],"filesTotal":3}}
{"error":{"code":"checked_out","message":"Nhánh đang mở ở /Users/ha/Code/shop-wt/x.","path":"/Users/ha/Code/shop-wt/x"}}
{"error":{"code":"busy","message":"Agent đang chạy trong thư mục này.","busy":[{"path":"/Users/ha/Code/shop","kind":"agent","label":"claude (pid 4242)"}]}}
```

### 3.6. `create` (US3, FR-013, FR-014)

```text
hive-worker branches create --folder=/Users/ha/Code/shop --name=feature/abc --base=refs/remotes/origin/main \
  [--switch] [--fetch] [--carry] [--confirm-busy] [--dry-run] --timeout=150
```

- `--base` là tên ref **đầy đủ** (`refs/heads/…` hay `refs/remotes/<remote>/…`), để tên trùng tag không nhầm (spec "Tag
  trùng tên nhánh").
- `--dry-run`: chỉ kiểm tên (`git check-ref-format --branch`), `exists` và `--base` có; không fetch, không ghi. Giao diện
  gọi khi người dùng gõ (US3 kịch bản 3) sau khi `branchNameError` (TS) đã qua.
- Thứ tự kiểm: `not_repo` → `invalid_name` → `exists` (`show-ref --verify --quiet refs/heads/<tên>`) → `not_found`
  (base) → với `--switch`: `in_progress`, `busy`, `dirty` (khi thiếu `--carry`) → `--fetch` và base là ref remote:
  `git fetch <remote> <nhánh>` ngoài khoá, lỗi thì `fetch_failed` (giao diện hỏi rồi gọi lại không `--fetch`) → trong
  khoá: `git switch --no-track -c <tên> <mã base>` (có `--switch`) hay `git branch --no-track <tên> <mã base>`.
- Không dùng `-B`, `-C` (US3 kịch bản 4).

```ts
interface CreateResult {
  folder: string; name: string; base: string; tip: string;
  switched: boolean; fetched: boolean; dryRun: boolean;
}
```

```json
{"folder":"/Users/ha/Code/shop","name":"feature/abc","base":"refs/remotes/origin/main","tip":"df58…","switched":true,"fetched":true,"dryRun":false}
{"error":{"code":"invalid_name","message":"Tên nhánh không hợp lệ.","detail":"fatal: 'feature/a..b' is not a valid branch name"}}
{"error":{"code":"fetch_failed","message":"Không fetch được origin/main.","remote":"origin","detail":"fatal: unable to access …"}}
```

### 3.7. `scan` (job, US4, FR-020…FR-027, FR-044)

```text
hive-worker branches scan --folder=/Users/ha/Code/shop --folder=/Users/ha/Code/api [--no-fetch] --timeout=150
```

- `--folder` lặp, ít nhất một. Song song tối đa 4 repo (FR-044).
- Mỗi repo: fetch từng remote (bỏ qua khi `--no-fetch`, dùng cho huy hiệu P3, T017) → đọc như `list` → lọc theo mẫu →
  bằng chứng git (plan.md mục 5 bước 4) → API (P2, token qua `HIVE_GIT_TOKENS`) → bước chặn theo thứ tự `BlockCode`.
- Với `--no-fetch`, `ScanRepo.fetched` rỗng và FR-027 **không** áp dụng: bước kiểm commit chưa đẩy dùng mọi remote có
  ref trên máy. [Inference] Chấp nhận được vì `--no-fetch` chỉ dùng để đếm; lượt dọn luôn bắt đầu bằng quét có fetch.
- Sự kiện: `progress` (bước của từng repo), `repo` (một repo xong), `done`.

```json
{"type":"progress","folder":"/Users/ha/Code/shop","step":"fetch","remote":"origin","result":"done","done":0,"total":2}
{"type":"progress","folder":"/Users/ha/Code/shop","step":"evidence","done":0,"total":2}
{"type":"repo","folder":"/Users/ha/Code/shop","done":1,"total":2,"repo":{
  "folder":"/Users/ha/Code/shop","defaultBranch":"main","current":"main","fetched":["origin"],"fetchFailed":[],
  "candidates":[
   {"folder":"/Users/ha/Code/shop","branch":"ai/A","tip":"aaaa…","committedAt":1792400000,
    "worktree":{"path":"/Users/ha/Code/shop/.claude/worktrees/a","prunable":false,"agentWorktree":true,"ignored":["node_modules/"]},
    "evidence":{"kind":"mergedGit","onto":"origin/main"},"selected":true}],
  "blocked":[
   {"folder":"/Users/ha/Code/shop","branch":"ai/B","tip":"bbbb…","committedAt":1792410000,
    "evidence":{"kind":"mergedGit","onto":"origin/main"},"selected":false,
    "blocked":{"code":"unpushed","message":"Có 1 commit chưa đẩy lên remote nào.","count":1}},
   {"folder":"/Users/ha/Code/shop","branch":"ai/G","tip":"gggg…","committedAt":1792420000,
    "worktree":{"path":"/Users/ha/Code/shop-wt/g","prunable":false,"agentWorktree":false},
    "evidence":{"kind":"mergedGit","onto":"origin/main"},"selected":false,
    "blocked":{"code":"ignored","message":"Có file bị bỏ qua không dựng lại được.","files":[".env"],"filesTotal":1}},
   {"folder":"/Users/ha/Code/shop","branch":"ai/C","tip":"cccc…","committedAt":1792430000,
    "evidence":{"kind":"none","note":"noOwnCommits"},"selected":false,
    "blocked":{"code":"noEvidence","message":"Chưa có commit riêng hoặc merge tiến nhanh."}}]}}
{"type":"done","total":2,"done":2,"summary":{"candidates":1,"blocked":3,"failed":0}}
```

- Huỷ: repo đang quét dừng ngay (chỉ có lệnh đọc, mạng), repo chưa bắt đầu có sự kiện `repo` với
  `repo.error.code = "cancelled"`. `done` vẫn được in.

### 3.8. `clean` (job, US4, FR-021…FR-032)

```text
hive-worker branches clean --timeout=300
```

Dòng đầu stdin:

```json
{"busy":[{"path":"/Users/ha/Code/shop","kind":"terminal"}],
 "fetched":{"/Users/ha/Code/shop":["origin"]},
 "items":[{"folder":"/Users/ha/Code/shop","branch":"ai/A","tip":"aaaa…","worktree":"/Users/ha/Code/shop/.claude/worktrees/a",
           "evidence":{"kind":"mergedGit","onto":"origin/main"}}]}
```

- Thứ tự cho từng mục theo plan.md mục 6 (kiểm `tip`, bước chặn 1–4 với `busy` mới nhất, `ls-remote` cho `closedApi`,
  gỡ worktree ngoài khoá, trong khoá kiểm lại `tip` và commit chưa đẩy theo `fetched`, `git branch -D --end-of-options`,
  ghi nhật ký). Tuần tự trong repo, song song tối đa 2 repo (FR-044).
- `fetched` của một repo thiếu hay rỗng: chỉ xoá khi `tip` là tổ tiên của `defaultRef` (FR-027).
- Một job `clean` cùng lúc: Rust từ chối job thứ hai bằng `Err("Đang dọn nhánh.")` (spec "Hai lượt dọn cùng lúc").
- Huỷ: mục đang chạy chạy hết; mỗi mục còn lại có một sự kiện `item` với `result: "cancelled"`.
- `code` của `skipped`: `tipChanged` ("Nhánh đã đổi sau khi xem trước"), `remoteGone`, `remoteMoved` (FR-026), một
  `BlockCode` (bước chặn lúc dọn), hay `locked`.

```json
{"type":"progress","folder":"/Users/ha/Code/shop","branch":"ai/A","step":"removeWorktree","done":0,"total":2}
{"type":"item","done":1,"total":2,"item":{"folder":"/Users/ha/Code/shop","branch":"ai/A","tip":"aaaa…",
 "worktree":"/Users/ha/Code/shop/.claude/worktrees/a","result":"removed","worktreeRemoved":true,"branchDeleted":true}}
{"type":"item","done":2,"total":2,"item":{"folder":"/Users/ha/Code/shop","branch":"ai/H","tip":"hhhh…","result":"skipped",
 "code":"tipChanged","reason":"Nhánh đã đổi sau khi xem trước","worktreeRemoved":false,"branchDeleted":false}}
{"type":"done","total":2,"done":2,"summary":{"removed":1,"skipped":1,"partial":0,"error":0,"cancelled":0},
 "log":"/Users/ha/Library/Application Support/xdev-hive/branches-log.jsonl"}
```

### 3.9. `settings`, `settings-set` (FR-033)

```text
hive-worker branches settings --timeout=15
hive-worker branches settings-set --timeout=15     # stdin: {"settings":{"patterns":[…],"rebuildable":[…]}}
```

- `settings-set` kiểm rồi ghi cả file (ghi file tạm rồi đổi tên), trả `BranchSettings` mới. Lỗi `invalid_settings`
  không ghi gì. Mảng rỗng được (không dọn nhánh nào, hay không chấp nhận file bị bỏ qua nào).

```json
{"path":"/Users/ha/Library/Application Support/xdev-hive/branches.json","patterns":["ai/*","claude/*"],
 "rebuildable":["node_modules","dist","build","target",".turbo",".next",".venv","__pycache__","coverage"],
 "defaults":{"patterns":["ai/*","claude/*"],"rebuildable":["node_modules","dist","build","target",".turbo",".next",".venv","__pycache__","coverage"]}}
```

### 3.10. `merge`, `rebase`, `continue`, `abort` (P2, US8, FR-050…FR-056)

```text
hive-worker branches merge  --folder=F --onto=<mã> --onto-name=origin/main [--ff] [--confirm-busy] --timeout=150
hive-worker branches rebase --folder=F --onto=<mã> --onto-name=origin/main [--confirm-rewrite] [--confirm-busy] --timeout=150
hive-worker branches continue --folder=F --timeout=150
hive-worker branches abort    --folder=F --timeout=150
```

- `--onto` là mã commit đầy đủ đã đọc lúc người dùng bấm (FR-050); `--onto-name` chỉ để hiện và ghi nhật ký.
- `merge`, `rebase`, thứ tự kiểm: `not_repo` → `detached` → `in_progress` → `not_found` (`--onto` không phải commit) →
  `busy` → `dirty` (thay đổi đã theo dõi **và** file chưa theo dõi, FR-051, tối đa 20 file) → rebase: đếm commit đã đẩy
  `git rev-list --count <onto>..HEAD --remotes` [Inference: cách đếm, T015 kiểm lại], lớn hơn 0 mà thiếu
  `--confirm-rewrite` thì `needsConfirm` với `count` → đọc `headBefore`, ghi nhật ký → trong khoá, `GIT_EDITOR=true`:
  `git merge --no-ff --no-edit --end-of-options <mã>` (bỏ `--no-ff` khi `--ff`) hay `git rebase --end-of-options <mã>`.
- `continue`: không dở merge/rebase → `no_operation`; còn file `U` → trả `state: "conflict"` (không chạy git); không thì
  `git merge --continue` hay `git rebase --continue` (`GIT_EDITOR=true`) trong khoá. Rebase gặp xung đột ở commit sau thì
  trả `conflict` với `step` mới (US8 kịch bản 4).
- `abort`: không dở → `no_operation`; không thì `git merge --abort` hay `git rebase --abort` trong khoá, trả
  `state: "aborted"`, `head`, `headBefore`.
- Không có `--skip`, `--quit`, `-i`, `--autostash`, `--onto <a> <b>`, `checkout --ours/--theirs` (FR-054, plan.md 3b).
- Thao tác dở là cherry-pick, revert, bisect: `continue`, `abort` trả `no_operation`; `list` vẫn báo `operation`.

```json
{"operation":{"kind":"merge","state":"done","branch":"feature/cart","onto":{"name":"origin/main","tip":"df58…"},
 "headBefore":"9f1c…","head":"e0e0…","conflicts":[],"conflictsTotal":0}}
{"operation":{"kind":"rebase","state":"conflict","branch":"feature/cart","onto":{"name":"origin/main","tip":"df58…"},
 "headBefore":"9f1c…","conflicts":["src/cart.ts"],"conflictsTotal":1,"step":2,"total":3}}
{"error":{"code":"needsConfirm","message":"Rebase viết lại 2 commit đã đẩy. Sau đó phải force-push (app không push).","count":2}}
{"operation":{"kind":"rebase","state":"aborted","branch":"feature/cart","headBefore":"9f1c…","head":"9f1c…","conflicts":[],"conflictsTotal":0}}
```

## 4. Sự kiện dòng

Sidecar in mỗi sự kiện một dòng JSON có `type`. Rust phát mỗi dòng nguyên văn dưới tên `git-branches:event` với
payload `{"jobId": "<id>", "event": <dòng>}`, chỉ tới cửa sổ app (như `git-groups:event`).

```ts
type BranchEvent =
  | { type: "progress"; folder?: string; branch?: string; remote?: string;
      step: "fetch" | "read" | "evidence" | "api" | "merge" | "removeWorktree" | "deleteBranch";
      result?: "done" | "failed"; error?: BranchError; done?: number; total?: number }
  | { type: "worktree"; folder: string; worktree: WorktreeInfo }                       // list
  | { type: "repo"; folder: string; repo: ScanRepo; done?: number; total?: number }   // scan
  | { type: "item"; item: CleanResult; done?: number; total?: number }                // clean
  | { type: "done"; folder?: string; error?: BranchError;
      fetched?: string[]; fetchFailed?: ScanRepo["fetchFailed"]; fetchedAt?: string;  // fetch
      pull?: { state: "done" | "unchanged"; headBefore?: string; head?: string; behind?: number }; // pull
      summary?: Record<string, number>;                                                // scan, clean
      log?: string; total?: number; done?: number }
  | { type: "exit"; message?: string };   // chỉ Rust phát: sidecar dừng mà không in done
```

| Lệnh | Sự kiện có thể có | Kết thúc |
|---|---|---|
| `list` | `worktree` | `done` |
| `fetch` | `progress` (`step: fetch`) | `done` có `fetched`, `fetchFailed`, `fetchedAt?` |
| `pull` | `progress` (`fetch`, `merge`) | `done` có `pull` hay `error` |
| `scan` | `progress` (`fetch`, `read`, `evidence`, `api`), `repo` | `done` có `summary` (`candidates`, `blocked`, `failed`) |
| `clean` | `progress` (`removeWorktree`, `deleteBranch`), `item` | `done` có `summary` (theo `CleanResult.result`), `log` |

- Mỗi job kết thúc bằng **đúng một** `done` hay `exit`. Rust đặt cờ "đã xong" khi thấy `type == "done"`; sidecar thoát
  mà chưa có `done` thì Rust phát `{"type":"exit","message":<stderr đã cắt 4000 ký tự>}`.
- Sự kiện có thể đến **trước** khi lệnh Tauri trả `jobId` (repo đầu xong rất nhanh): giao diện gom theo `jobId` ở cấp
  module (`useBranchJob`), như `useSyncJob` của `git-groups.ts`.

## 5. Lệnh Tauri (plan.md mục 4)

Tên tham số phía JS là camelCase; Tauri tự đổi sang snake_case của hàm Rust. Mọi lệnh có một mục trong
`generate_handler!`, `build.rs` và một `allow-…` trong `capabilities/app.json` (`capabilities_audit.rs`).

| Lệnh Tauri | Tham số JS | Lệnh con, cờ | `--timeout` | Trả | Cách gọi |
|---|---|---|---|---|---|
| `git_branches_status` | `folders: string[]` | `status --folder=…` | 15 | `{repos: BranchStatus[]}` | `sidecar_json_stdin` |
| `git_branches_list` | `folder` | `list --folder` | 30 | `RepoBranches & {jobId}` | đọc dòng đầu, các dòng sau thành sự kiện |
| `git_branches_switch` | `folder, branch?, track?, carry, confirmBusy` | `switch` | 60 | `SwitchResult` | `sidecar_json_stdin` |
| `git_branches_create` | `folder, name, base, switchTo, fetch, carry, confirmBusy, dryRun` | `create` | 150 | `CreateResult` | `sidecar_json_stdin` |
| `git_branches_fetch` | `folder` | `fetch --folder` | 120 | `jobId` | job |
| `git_branches_pull` | `folder, confirmBusy` | `pull` | 120 | `jobId` | job |
| `git_branches_scan` | `folders: string[], fetch: boolean` | `scan`, `--no-fetch` khi `fetch` tắt | 150 | `jobId` | job (token P2) |
| `git_branches_clean` | `items: CleanItem[], fetched` | `clean` | 300 | `jobId` | job, một job cùng lúc |
| `git_branches_cancel` | `jobId` | ghi `cancel\n` vào stdin của job | — | `void` | — |
| `git_branches_settings` | — | `settings` | 15 | `BranchSettings` | `sidecar_json_stdin` |
| `git_branches_settings_set` | `settings: BranchSettingsInput` | `settings-set` | 15 | `BranchSettings` | `sidecar_json_stdin` |
| `git_branches_merge` | `folder, onto, ontoName, ff, confirmBusy` | `merge` | 150 | `{operation}` | `sidecar_json_stdin` |
| `git_branches_rebase` | `folder, onto, ontoName, confirmRewrite, confirmBusy` | `rebase` | 150 | `{operation}` | `sidecar_json_stdin` |
| `git_branches_continue` | `folder` | `continue` | 150 | `{operation}` | `sidecar_json_stdin` |
| `git_branches_abort` | `folder` | `abort` | 150 | `{operation}` | `sidecar_json_stdin` |

- Rust thu `busy` (agent của spec 021, terminal đang mở trong `pty.rs`, thư mục hiện tại của cửa sổ app) cho **mọi**
  lệnh có `--folder` của thư mục làm việc và cho `list`, `scan`, `clean`; các lệnh khác gửi `{}`.
- `git_branches_list` trả `jobId` để giao diện nghe sự kiện `worktree` (`useBranchJob`). `git_branches_cancel` dùng được
  với `jobId` của `list` (đóng bảng thì huỷ).
- Kết quả có `error` thì Rust trả **nguyên** JSON (không đổi thành `Err`); `git-branches.ts` đổi thành
  `GitBranchError`. `Err(String)` của Rust chỉ dành cho lỗi chạy sidecar (mục 1.4, 1.5) và job `clean` thứ hai.
- Token (P2, FR-030): chỉ `git_branches_scan` truyền `HIVE_GIT_TOKENS` cho host trùng origin của các repo quét
  (như `git_group_sync`). Lệnh khác không có token; fetch dùng credential của máy.

## 6. Nhật ký `branches-log.jsonl` (FR-032, FR-056)

Đường dẫn `<UserConfigDir>/xdev-hive/branches-log.jsonl`, mỗi dòng một JSON, giữ 1.000 dòng gần nhất. Không ghi token,
không ghi nội dung file.

```json
{"time":"2026-10-20T03:20:00Z","action":"clean","folder":"/Users/ha/Code/shop","branch":"ai/A","tip":"aaaa…","worktree":"/Users/ha/Code/shop/.claude/worktrees/a","result":"removed","evidence":"mergedGit"}
{"time":"2026-10-20T03:25:00Z","action":"rebase","folder":"/Users/ha/Code/shop","branch":"feature/cart","headBefore":"9f1c…","onto":"origin/main","ontoTip":"df58…","result":"conflict"}
```

`action`: `clean`, `merge`, `rebase`, `continue`, `abort`, `switch`, `create`, `pull`. Lệnh đọc không ghi.

## 7. Đối chiếu yêu cầu

| FR | Chỗ trong hợp đồng |
|---|---|
| FR-001 | `status` (3.1), `BranchStatus` |
| FR-002 | `list` (3.2), `RepoBranches.branches`, `slowPath` |
| FR-003 | `BranchInfo.committedAt`, `isCurrent` (sắp, lọc ở giao diện) |
| FR-004 | `fetch` (3.3): từng remote, `fetched`, `fetchFailed`, `fetchedAt`; `MachineCredentials` |
| FR-010 | `switch` (3.5): `--branch`, `--track`, không `--force` |
| FR-011 | `switch`/`create` `dirty`, `--carry` |
| FR-012 | `in_progress`, `OperationKind` |
| FR-013 | `create` (3.6): `invalid_name`, `exists`, `--no-track`, `--dry-run` |
| FR-014 | `busy`, `--confirm-busy`, mục 1.3 |
| FR-020 | `scan`: lọc mẫu, `current`, `prOpen`, nhánh mặc định không có mặt |
| FR-021 | `BlockCode.unpushed`, `clean` kiểm lại trong khoá theo `fetched` |
| FR-022 | `BlockCode` `locked`, `submodule`, `dirty`, `untracked`, `ignored`; `CandidateWorktree.ignored` |
| FR-023 | `busy` trong stdin, dòng `{"busy":…}` mỗi 5 giây (1.2) |
| FR-024 | `WorktreeState.skipped`, `BusyKind.hiveWorker`, `BlockCode.hiveWorker` |
| FR-025 | cột "Ghi" của bảng mục 3, `locked` |
| FR-026 | `Evidence.closedApi`, `clean` `remoteGone`/`remoteMoved`, `selected: false` |
| FR-027 | `ScanRepo.fetchFailed`, `BlockCode.needsFetch`, `clean` khi `fetched` rỗng |
| FR-028 | `clean`: `tipChanged`, bước chặn lúc dọn |
| FR-029 | `CleanResult.partial`, `worktreeRemoved`, `branchDeleted`, `left` |
| FR-030 | `Evidence.mergedApi`, `ScanRepo.apiError`, `HIVE_GIT_TOKENS` (mục 5) |
| FR-031 | không lệnh nào push hay xoá nhánh remote; `clean` chỉ `ls-remote` |
| FR-032 | mục 6, `done.log` |
| FR-033 | `settings`, `settings-set` (3.9) |
| FR-040 | không lệnh nào gọi hub |
| FR-041 | mục 1.5 |
| FR-042 | `BranchError.detail`, `auth` |
| FR-043 | `message` tiếng Việt, giao diện dịch theo `code` |
| FR-044 | `scan` 4 repo, `clean` 2 repo |
| FR-050 | `merge`, `rebase` (3.10): `--onto=<mã>`, `--ff` |
| FR-051 | `dirty` gồm file chưa theo dõi, `detached`, `in_progress` |
| FR-052 | khoá, context không huỷ, 120 giây, `timeout` không tự abort (1.5) |
| FR-053 | `GitOperation.conflicts`, `step`, `total` |
| FR-054 | `continue`: `GIT_EDITOR=true`, còn `U` thì `conflict`; không `--skip`, `--quit` |
| FR-055 | `needsConfirm`, `count`, `--confirm-rewrite` |
| FR-056 | `headBefore`, nhật ký (6), `resetKeepCommand` |

## 8. Lệch so với plan.md

- **Kiểm agent đang chạy (FR-014) ở sidecar**, không ở Rust (plan.md mục 3 "Rust kiểm trước khi gọi"): sidecar đã nhận
  `busy` qua stdin và đã biết worktree nào chứa thư mục nào (mục 1.3), nên kiểm một chỗ, có test Go. Rust chỉ thu và
  gửi `busy`.
- **`list` in thêm sự kiện sau dòng kết quả** và Rust trả `jobId` kèm kết quả, vì plan.md mục 2 muốn trạng thái worktree
  điền dần mà mục 4 lại xếp `list` vào `sidecar_json_stdin`.
- **`create --dry-run`** để kiểm tên khi gõ (US3 kịch bản 3) mà không thêm lệnh Tauri thứ 16.
- **`--base` của `create` là tên ref đầy đủ**, không phải tên ngắn (spec "Tag trùng tên nhánh").
