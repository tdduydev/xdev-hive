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
- [Unverified] Thời gian `git status` của 28 worktree trên Windows (SC-001).
