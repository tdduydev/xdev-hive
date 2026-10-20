# Research: Quản lý nhánh Git trong app desktop

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · **Ngày**: 2026-10-19

## 1. Nguồn đã đọc

Code trên `main` tại `3a0c6304`.

| Nguồn | Điều rút ra |
|---|---|
| `AGENTS.md`, `CLAUDE.md`, `.specify/memory/constitution.md` | Quy ước module, ngôn ngữ, test; nguyên tắc I–VII dùng cho Constitution Check |
| `specs/016-desktop-git-groups/spec.md` | Git chạy qua sidecar `hive-worker gitgroups`; không cần đăng nhập Hive; `status --porcelain=v2 --branch`; pull chỉ tiến nhanh; đổi nhánh nằm ở Ngoài phạm vi của 016 |
| `specs/021-desktop-agents-terminal/spec.md` | Màn Agent trên máy biết thư mục làm việc của agent; nhận run Hive theo thư mục `…/xdev-hive/worker/runs/<runId>-<attempt>` |
| `specs/023-desktop-ssh-keys/spec.md` | Mẫu sidecar Go + Rust chuyển tiếp; secret chỉ qua stdin/biến môi trường |
| `specs/019-word-import/spec.md`, `specs/020-cicd-console/plan.md` | Định dạng spec, plan, research |
| `worker/internal/gitgroups/git.go` | `Git.run`: biến môi trường an toàn, huỷ, `GitError{Auth}`, che token |
| `worker/internal/gitgroups/status.go`, `sync.go` | `parsePorcelain`, `classify`; `fetch --prune`; `merge --ff-only @{u}` |
| `worker/internal/gitgroups/api.go` | Client GitLab/GitHub, `apiBase`, phân trang; chưa có hàm liệt kê MR/PR |
| `worker/internal/runner/runner.go:286-334` | Worktree run ở `<DataDir>/runs/<runId>-<attempt>`; gỡ ngay sau run; nhánh giữ khi đã push |
| `worker/internal/runner/runner.go:392,822-827` | `worktree add --no-checkout -B <nhánh> <work> origin/<base>` |
| `worker/internal/runner/local.go:29-148` | Kho bare `<DataDir>/repos/<sha>.git`; khoá `local-<sha(commonDir)>`; `prepareBranch` kiểm commit chưa có trên `refs/remotes/origin`; `restoreBranch`; `removeLocalWorktree` không prune cả repo |
| `worker/internal/runner/repolock.go:30-86` | `lockRepo` khoá trong tiến trình và khoá file giữa tiến trình |
| `worker/internal/channel/channel.go:191-196,278-296` | Nhánh mặc định của run `ai/<RunID>` khi hub không gửi; `ReapOrphans` khi khởi động |
| `worker/cmd/hive-worker/main.go:391,633` | `DataDir = os.UserCacheDir()/xdev-hive/worker` |
| `worker/cmd/hive-worker/local.go:53-84` | `worker.status` qua localipc chỉ trả số run đang chạy |
| `apps/hub/src/modules/runs/engine.ts:2818` | Hub đặt nhánh run là `ai/${task.key}` |
| `apps/hub/src/modules/runs/scm-events.ts:78-214` | Hub biết PR merge/đóng qua webhook; tìm task theo `pr_url` rồi theo nhánh |
| `apps/hub/src/modules/runs/schema.ts`, `packages/contracts/src/runs.ts:257-300` | `runs` có `branch`, `pr_url`, không có trạng thái PR; không có API tra theo nhánh |
| `apps/hub/src/modules/scm/types.ts:114-243` | `GitProvider.getPR` có trạng thái; không có hàm xoá nhánh |
| `apps/desktop/src-tauri/src/lib.rs:56,313-368,507-539,1067-1199` | `sidecar_json` (không giới hạn thời gian); danh sách lệnh Tauri |
| `apps/desktop/src-tauri/src/git_groups.rs:22,33,386-469,537-565` | Job sidecar, sự kiện `git-groups:event`, huỷ qua stdin, keychain `dev.xdev.hive.git`, tự fetch |
| `apps/desktop/src-tauri/src/git_credentials.rs:46,159-163` | `git credential fill` không tương tác, 15 giây |
| `apps/desktop/src-tauri/src/workspace.rs:23-66` | Rust gọi git trực tiếp để đọc nhánh hiện tại (5 giây) |
| `apps/desktop/src-tauri/src/agents/classify.rs:229-245` | Nhận thư mục run Hive |
| `apps/desktop/src-tauri/build.rs`, `capabilities/app.json`, `capabilities_audit.rs` | Cách thêm lệnh Tauri mới và kiểm quyền |
| `apps/desktop/src/screens/projects-screen.tsx`, `components/git-groups.tsx`, `lib/local-projects.ts` | Danh sách repo chưa hiện nhánh; nhóm Git hiện nhánh, ahead/behind |
| `.claude/skills/agent-fleet/scripts/cleanup-merged.sh` (trong git, `HEAD`) | Tiền lệ dọn: `gh pr list --state merged`, `--force` khi chỉ có file chưa theo dõi |
| `docs/history/phan-tich-2026-10/README.md:378-379` | Ý tưởng cũ A2, A3: dọn worktree N ngày sau khi task xong, xoá nhánh `ai/*` đã merge; chưa làm |
| Ghi chú các phiên khác (thư mục ghi chú chung) | Repo git nhóm `acme-ai` clone tay; máy dev không có Go toolchain mặc định (`E:\DevCache\go`); `GOTOOLCHAIN=local` |

## 2. Đo trên máy dev Windows (2026-10-19)

Lệnh chỉ đọc, chạy trong repo `E:\Codes\xDev\xdev-hive` (git 2.56.0.windows.1). Không xoá gì.

| Đo | Kết quả |
|---|---|
| `git worktree list` | 29 mục: thư mục chính (đang ở `ai/DOCSMYPROJECTS`) và 28 worktree trong `.claude/worktrees/` |
| Nhánh local | 33: 13 `ai/*`, 19 `claude/*`, `main` |
| `git branch --merged origin/main` | 28 nhánh, gồm `main` (12 `ai/*`, 15 `claude/*`) |
| Trong 28 nhánh đó, đỉnh nằm trên first-parent của `origin/main` | 3: `main`, `claude/spec-026-git-branches-0e58d1` (worktree của phiên viết spec này, chưa có commit), `claude/cicd-t003-design-bc1014` |
| `git branch --no-merged origin/main` | 5 nhánh |
| Nhánh có commit không nằm trong ref remote nào | 3: `ai/SKILLHARNESS` (1), `claude/cranky-rhodes-999a14` (1), `claude/gifted-torvalds-e6105a` (1) |
| `ai/SKILLHARNESS` | upstream là `origin/main`, ahead 1 behind 45: upstream không cho biết đã đẩy |
| Ref remote trên máy / nhánh thật trên remote | 36 ref `refs/remotes/origin/*` trên máy, 11 nhánh trên GitHub (`git ls-remote`): máy chưa `fetch --prune` nên ref cũ còn, `%(upstream:track)` chưa hiện `gone` |
| Thư mục `runs/` của worker (`%LOCALAPPDATA%\xdev-hive\worker\runs`) | Không có: máy này chưa chạy run Hive |
| `%(ahead-behind:origin/main)` trong `for-each-ref` | Chạy được trên git 2.56 |

Kết luận:
- Worktree cũ trên máy này do Claude Code desktop và skill `agent-fleet` tạo, không do run Hive. Run Hive tự gỡ worktree,
  chỉ để lại nhánh `ai/<key>`. Spec chọn dọn theo mẫu tên (Q8).
- `git branch --merged` một mình nhận nhầm nhánh mới tạo chưa có commit. Phép thử "ngoài first-parent" tách đúng 2
  trường hợp đó trên máy này. [Inference] Đúng khi đội merge PR bằng merge commit; squash cần API (P2).
- Không `fetch --prune` thì ref remote cũ làm commit của nhánh đã xoá trên remote trông như "đã đẩy". FR-021 và FR-027 dựa
  trên điều này.

## 3. Thử hành vi git (git 2.56, Windows, repo tạm trong scratchpad)

| Thử | Kết quả |
|---|---|
| `git worktree remove` khi worktree chỉ có file bị bỏ qua (`node_modules/` trong `.gitignore`) | Gỡ được, không cần `--force` |
| `git worktree remove -- <đường dẫn>` khi worktree có `.env` bị bỏ qua (qua `info/exclude`) và `node_modules/` | Gỡ được, **`.env` mất theo** không hỏi. `status --porcelain=v2 --ignored=matching` liệt kê được `! .env`, `! node_modules/` trước khi gỡ → lý do của Q15 |
| `git worktree remove` khi có file chưa theo dõi | Từ chối: "contains modified or untracked files, use --force" |
| `git worktree remove` khi worktree bị `lock` | Từ chối: "cannot remove a locked working tree" |
| `git switch --no-track -c feat/x main` | Tạo và đổi sang nhánh mới, không có upstream |
| Nhánh `ai/T` và tag `ai/T` cùng tên, `git rev-parse ai/T` | Báo "refname is ambiguous" và trả mã của **tag** |
| `git branch -D --end-of-options ai/T` khi có tag cùng tên | Xoá nhánh, tag còn nguyên |
| `git branch -D` nhánh đang checkout ở worktree khác | Từ chối: "cannot delete branch … used by worktree" |
| `git rev-list --count <mã> --not --remotes=origin` | Chạy được; đặt `--end-of-options` trước `--not` thì git báo lỗi, nên dùng mã thay tên |

## 4. Hiểu biết chưa kiểm chứng

- [Unverified] `%(ahead-behind:…)` có từ git 2.41. Plan có đường chậm cho git cũ hơn.
- [Unverified] Cách merge mặc định (merge commit hay squash) của các repo GitLab `acme-ai`. Nếu là squash, bằng
  chứng git ở P1 nhận rất ít nhánh; nên làm P2 sớm.
- [Unverified] API GitLab `merge_requests` cần quyền `read_api`; token theo hướng dẫn của spec 016 đã có quyền này.
  GitHub fine-grained token cần quyền đọc Pull requests.
- [Unverified] Claude Code desktop xử lý thế nào khi worktree của một phiên cũ bị gỡ từ ngoài (R8 của plan).
- [Inference] Đường dẫn dài trong `node_modules` trên Windows cần `core.longpaths`; chưa thử với `worktree remove`.
- [Unverified] `ssh -o BatchMode=yes` qua `GIT_SSH_COMMAND` đủ để fetch qua SSH không treo khi khoá có passphrase.
- [Unverified] Git báo `prunable` giống nhau cho thư mục đã xoá và cho ổ chưa gắn hay thư mục mạng mất kết nối. Spec chặn
  khi gốc ổ hay thư mục cha không truy cập được.
- [Inference] Trên Linux, service systemd của worker chỉ đặt `HOME`, `PATH`; `XDG_CACHE_HOME` của service có thể khác
  của app desktop, làm hai bên khoá hai file khác nhau.
- [Unverified] Thời gian `git status` của 28 worktree trên Windows (SC-001). Đã đo trên macOS ở mục 5.

## 5. Đo P1 trên máy dev macOS (2026-10-20, task T013)

Chỉ đọc. Chỉ chạy `hive-worker branches list` và `scan --no-fetch`; không `fetch`, `clean`, `pull`, không gọi API
GitHub/GitLab. `HOME` đặt về thư mục tạm khi đo, nên không đọc cấu hình git hay `branches.json` của người dùng. Bản
build từ `worker/` của nhánh T013 (`go build ./cmd/hive-worker`, go 1.27.2 darwin/arm64).

Môi trường: git 2.54.0 (Apple Git-157), macOS 27.0.1 (build 26A434, theo `sw_vers`). Đo thời gian bằng `date +%s.%N`
quanh lệnh, hay bằng tiến trình Python đọc từng dòng stdout để lấy thời điểm dòng đầu.

Repo đo: 4 repo thật của máy dev (A, B, C, D) và 16 bản sao `git clone --no-hardlinks` của chính 4 repo này; bản sao
SC-001 và SC-004 là clone của repo A. Mọi bản sao nằm trong thư mục tạm, đã xoá khi xong.

### 5.1. Bốn repo thật (`list`, 3 lần mỗi repo)

| Repo | Mục `git worktree list` | Nhánh local | Ref remote | `list` (giây, lần 1 → lần 2, 3) |
|---|---|---|---|---|
| A | 37 | 37 | 35 | 2,05 → 0,72, 0,67 |
| B | 1 | 1 | 3 | 0,07 |
| C | 5 | 87 | 2 | 0,50 → 0,42, 0,42 |
| D | 5 | 6 | 8 | 0,10 → 0,09, 0,09 |

[Inference] Lần đầu của repo A chậm hơn do cache đĩa lạnh. Với repo A, dòng kết quả đầu (bảng nhánh) về sau 0,21–0,22
giây, dòng cuối (đủ trạng thái các worktree liên kết) sau 0,68–1,16 giây.

### 5.2. SC-001: 30 worktree và 200 nhánh (bản sao của repo A)

Dựng: 201 nhánh local (`ai/B1…B200` và `main`), thêm 200 ref `refs/remotes/origin/feat/R*` (từ commit của `main`),
28 worktree liên kết trong `.claude/worktrees/` (mục 5.4), rồi thêm 2 worktree. Mỗi worktree là checkout đủ của repo
(hàng nghìn file). Lệnh:

```text
hive-worker branches list --folder=<bản sao> --timeout=30
```

| Trạng thái | Nhánh trong bảng | Dòng đầu (bảng nhánh) | Dòng cuối (đủ trạng thái worktree) |
|---|---|---|---|
| 28 liên kết + thư mục chính (29 mục) | 465 | 1,10–1,12 giây | 3,17–3,25 giây (3 lần) |
| 29 liên kết + thư mục chính (30 mục) | 467 | 1,32–1,45 giây | 4,26–4,43 giây (3 lần) |

Kết luận: bảng nhánh hiện sau khoảng 1,1–1,5 giây, đạt ≤ 2 giây. Đủ trạng thái 30 worktree mất khoảng 4,3 giây, **không
đạt** nếu hiểu SC-001 là "mọi thứ xong"; plan mục 2 tách trạng thái từng worktree để hiện dần, nên bảng dùng được trước
đó. Chưa tách riêng chi phí của 200 nhánh với chi phí của worktree. [Unverified] Số đo trên Windows.

### 5.3. SC-002: quét 20 repo

```text
hive-worker branches scan --folder=<repo> (lặp 20 lần) --no-fetch --timeout=150
```

Không `fetch` được (giới hạn mạng của task), nên đây là quét `--no-fetch`, không phải "đã fetch" như SC-002.

| Bộ repo | Kết quả |
|---|---|
| 20 repo = 4 thật + 16 bản sao | 3,06–3,48 giây (2 lần); 75 ứng viên, 50 bị chặn, 0 lỗi |
| 16 bản sao chỉ có nhánh mặc định | 2,05–2,65 giây (2 lần); 0 ứng viên |
| Từng repo thật, quét riêng | A 0,80 giây; B 0,07 giây; C 0,78 giây; D 0,13 giây |

Kết luận: đạt ≤ 10 giây cho 20 repo, nhưng bộ đo nhẹ: bản sao chỉ có nhánh `main`, không có nhánh khớp mẫu. Một repo
nặng (bản sao mục 5.2: 200 nhánh khớp `ai/*`, 28 worktree) tự quét hết 5,0–8,9 giây (lần đầu 8,9 giây), nên 20 repo nặng
như vậy sẽ vượt 10 giây. [Inference] Chi phí chính nằm ở repo nặng, không ở số repo.

### 5.4. SC-004: quét trên bản sao repo A có 28 worktree giả

Dựng 28 worktree liên kết trong `.claude/worktrees/`: 20 nhánh `claude/m*` tại đỉnh nằm ngoài first-parent của
`origin/main` (đã merge bằng merge commit, sạch), 3 nhánh `claude/d*` như vậy nhưng có file đã theo dõi bị sửa, 3 nhánh
`claude/u*` có một commit riêng, 2 nhánh `claude/e*` mới tạo tại đỉnh `origin/main`. Lệnh:
`hive-worker branches scan --folder=<bản sao> --no-fetch --timeout=150` (không chạy `clean`).

| Số đo | Kết quả |
|---|---|
| Worktree có bằng chứng `mergedGit` | 23 (20 sạch, 3 bẩn) |
| `notMerged` | 3 |
| `noOwnCommits` | 2 |
| **Worktree bị chặn với lý do `submodule`** | **28 trên 28** |
| Worktree được chọn sẵn để dọn | **0** |
| Nhánh local khớp mẫu không có worktree | 200 (146 `mergedGit` được chọn sẵn, 54 `noOwnCommits` bị chặn `noEvidence`) |

Nguyên nhân: repo A có `.gitmodules` (một gitlink) và `hasSubmodule` coi có `.gitmodules` là có submodule, chặn mọi
worktree (`state.go`, `scan.go`). Thử riêng `git worktree remove` (không `--force`) trên một worktree của bản sao này
(submodule chưa init): git gỡ được, không phàn nàn. Kết luận: với repo A, số worktree liên kết **không giảm** theo bản
code hiện tại, **không đạt SC-004** dù đủ điều kiện về mặt git. Chưa chạy `clean` nên chưa đo số worktree sau dọn.
[Inference] Nếu bỏ chặn này cho submodule chưa init, ước tính 20 worktree được chọn sẵn, còn lại 8 (3 bẩn, 3 chưa
merge, 2 mới tạo). [Unverified] Git có từ chối worktree có submodule đã `init` hay không: chưa thử.

### 5.5. SC-004 đo lại sau T020 (2026-10-20)

Máy dev macOS (cùng máy mục 5), git 2.54.0 (Apple Git-157). `hive-worker` build từ nhánh `ai/GITBR-SC004` (gốc là `main`
sau PR #481, có T020): `cd worker && go build -o <tmp>/hive-worker ./cmd/hive-worker`. `HOME` và `USERPROFILE` đặt về thư
mục tạm, nên không đọc cấu hình git hay `branches.json` của người dùng. Mọi lệnh `branches` chỉ chạy trên bản sao; repo
thật chỉ được đọc để clone.

Dựng bộ đo như 5.4: `git clone --no-hardlinks` repo A (repo A **có** `.gitmodules`, một submodule chưa init) vào thư mục
tạm, rồi dựng bằng lệnh git: 20 nhánh `claude/m*` đã merge bằng `merge --no-ff` vào `main` (đỉnh nằm ngoài first-parent,
sạch), 3 nhánh `claude/d*` như vậy nhưng sửa `package.json` trong worktree, 3 nhánh `claude/u*` có một commit riêng, 2
nhánh `claude/e*` tại đỉnh `main`; `refs/remotes/origin/main` đặt bằng `git update-ref` về `main`. Mỗi nhánh một worktree
trong `.claude/worktrees/`: 28 worktree liên kết. Thêm 200 nhánh local `ai/*` không có worktree.

Lệnh:

```text
hive-worker branches scan  --folder=<bản sao> --no-fetch --timeout=150            # 9,4 s
hive-worker branches clean --timeout=300 < clean.in                                # theo branches-cli.md mục 3.8
```

`clean.in` là `{"busy":[],"fetched":{},"items":[…]}` với đúng các ứng viên `selected` của `scan` (20 mục, có `worktree`,
`evidence`, `tip` như `scan` trả). Không `fetch`, không gọi mạng.

| Số đo | Trước T020 (5.4) | Sau T020 (đo này) |
|---|---|---|
| Bị chặn `submodule` | 28 trên 28 | **0** |
| Ứng viên chọn sẵn (`mergedGit`, có worktree) | 0 | **20** |
| Bị chặn `dirty` (3 `d*`) | (che bởi `submodule`) | 3 |
| Bị chặn `unpushed`, evidence `notMerged` (3 `u*`) | (che) | 3 |
| Bị chặn `noEvidence`, `noOwnCommits` (2 `e*`) | (che) | 2 |
| 200 nhánh `ai/*` không worktree | 146 chọn sẵn, 54 chặn | 200 chặn `noEvidence` (xem lưu ý) |
| `git worktree list` trước dọn | 29 dòng (1 chính + 28) | 29 dòng |
| `clean` | không chạy | 20 `removed`, 0 `skipped`/`partial`/`error`/`cancelled` |
| `git worktree list` sau dọn | không đo | **9 dòng (1 chính + 8)** |

Sau dọn còn đúng 8 worktree liên kết: `d1`–`d3` (bẩn, file `package.json` vẫn còn sửa nguyên), `u1`–`u3` (có commit chưa
merge), `e1`–`e2` (mới tạo). Số worktree liên kết giảm từ 28 xuống 8. 20 nhánh `claude/m*` bị xoá cùng worktree.
`clean` chạy khoảng 3 phút cho 20 mục [Unverified: chỉ đo bằng đồng hồ tay, không đo chính xác].

Lưu ý bộ đo: 200 nhánh `ai/*` tôi tạo tại các commit first-parent cũ của `main`, nên đều là tổ tiên (`noOwnCommits`),
khác 5.4 (146 `mergedGit`). Con số này không ảnh hưởng SC-004 vì chỉ đếm worktree liên kết.

Thử worktree có submodule đã init (repo tạm trong thư mục tạm, submodule trỏ tới repo cục bộ, `git -c
protocol.file.allow=always submodule update --init` trong worktree): `scan` chặn nhánh đó với lý do `submodule`, và
`git worktree remove` (không `--force`) từ chối: "working trees containing submodules cannot be moved or removed".
Worktree `.gitmodules` + gitlink nhưng chưa init cùng repo đó được chọn sẵn.

Kết luận: **SC-004 đạt** trên bản sao repo A có 28 worktree giả, trên macOS dev, git 2.54.0: 28 xuống 8, đúng các
worktree bẩn, có commit chưa merge và mới tạo. [Unverified] Chưa đo trên Windows, chưa đo trên repo A thật (không chạy
`clean` trên repo thật), bộ 28 worktree là giả lập chứ không phải worktree agent thật.
