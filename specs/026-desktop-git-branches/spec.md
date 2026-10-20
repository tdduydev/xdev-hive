# Feature Specification: Quản lý nhánh Git trong app desktop

**Feature Branch**: `claude/spec-026-git-branches-0e58d1`

**Created**: 2026-10-19

**Status**: Đã chốt câu hỏi Q1–Q15 (2026-10-20). Đã code P1–P3: Go, Rust, màn xem, đổi, tạo, dọn, pull, merge, rebase, huy hiệu (T001–T018, T020). Còn T019 (kiểm tay trên macOS và Windows); SC-004 chưa đo lại sau T020. Có [tasks.md](tasks.md); hướng dẫn dùng ở [docs/git-branches.md](../../docs/git-branches.md).

**Input**: Chủ dự án (2026-10-19): "Mở một phiên riêng viết spec, plan, research cho quản lý nhánh Git trong app desktop
(danh sách nhánh, ahead/behind, đổi, tạo nhánh, dọn nhánh và worktree ai/* đã merge), câu hỏi mở kèm khuyến nghị.
Chưa code."

**Kế hoạch**: [plan.md](plan.md) · **Nghiên cứu**: [research.md](research.md) · **Tasks**: [tasks.md](tasks.md)

## Vì sao làm

App desktop đã có nhóm Git theo dõi (spec 016), màn Dự án trên máy, màn Agent trên máy và Terminal theo dự án (spec 021).
App chưa có chỗ xem và quản lý nhánh của từng repo.

Trên máy dev, nhánh và worktree cũ tích tụ vì không có chỗ dọn sau khi PR đã merge. Đo trên máy dev Windows ngày
2026-10-19, repo `xdev-hive` (chi tiết ở [research.md](research.md) mục 2):
- 29 worktree (1 thư mục chính, 28 worktree liên kết trong `.claude/worktrees/`);
- 33 nhánh local: 13 nhánh `ai/*`, 19 nhánh `claude/*`, `main`;
- 28 nhánh (gồm `main`) đã vào `origin/main`; 3 nhánh có commit chưa đẩy lên remote nào.

Số liệu đổi theo giờ vì các phiên khác trên máy vẫn tạo nhánh.

**Điểm cần biết trước khi chốt phạm vi:** trên máy này, worktree cũ **không** do run của Hive để lại.
- Worker tự gỡ worktree của run ngay khi run xong (`worker/internal/runner/runner.go:308-334`). Worktree của run nằm ở
  `<cache>/xdev-hive/worker/runs/`, không nằm trong thư mục repo. Máy dev này chưa có thư mục `runs/`.
- Worktree cũ trên máy này do Claude Code desktop (`.claude/worktrees/<tên>`, nhánh `claude/*`) và skill `agent-fleet`
  (nhánh `ai/<TÊN>` viết hoa) tạo.
- Run của Hive để lại **nhánh** `ai/<key task>` trong repo của người dùng sau khi đã push (`runner.go:323-324`), không để
  lại worktree.

Vì vậy spec này dọn theo **mẫu tên nhánh** và **bằng chứng đã merge**, không dọn theo "ai tạo ra" (câu hỏi Q8).

## Câu hỏi đã chốt

Chủ dự án chốt ngày 2026-10-20: Q1–Q6, Q8–Q15 theo khuyến nghị; **Q7 chọn khác khuyến nghị: có merge và rebase**
(US8, FR-050…FR-056). Cột "Khuyến nghị" giữ nguyên để thấy lý do ban đầu.

| # | Câu hỏi | Khuyến nghị | Phương án khác |
|---|---|---|---|
| Q1 | Chạy git qua sidecar Go hay Rust gọi git trực tiếp | **Sidecar Go**, lệnh mới `hive-worker branches`. Dùng lại cách chạy git của `gitgroups` (biến môi trường an toàn, huỷ, che token), bộ đọc `worktree list --porcelain` và khoá repo của runner. Go test chạy với git thật trên Linux, macOS, Windows ở CI. Rust chỉ chuyển tiếp | (a) Rust gọi `git` như `workspace.rs`: nhanh hơn vì không tạo tiến trình sidecar, nhưng phải viết lại khoá repo, askpass, che token. (b) Đọc bằng Rust, ghi bằng Go: hai nơi phân tích output git |
| Q2 | Biết PR/MR đã merge bằng cách nào | **Bản đầu chỉ dựa vào git** (P1): nhánh đã vào nhánh mặc định của remote sau `fetch --prune`, không nằm trên chuỗi first-parent. **Đợt sau (P2)** hỏi GitHub/GitLab bằng kết nối Git tại máy (spec 016), để nhận PR squash-merge và PR đã đóng. Không hỏi hub | (a) Hỏi hub: cần đăng nhập Hive, cần API mới tra theo nhánh (hiện không có), hub chỉ biết nhánh của run Hive. (b) Gọi API ngay từ P1: nhận squash-merge sớm, nhưng repo không có kết nối Git thì vẫn phải dựa vào git |
| Q3 | Dọn tự động hay chỉ bằng nút | **Chỉ bằng nút**, luôn qua xem trước và xác nhận. App chỉ đếm số nhánh dọn được sau mỗi lần fetch và hiện huy hiệu | Tự dọn theo lịch với nhánh đủ điều kiện: trái yêu cầu "không xoá khi chưa xác nhận" |
| Q4 | Có cần đăng nhập Hive không | **Không**. Mọi thao tác chạy tại máy như spec 016 | Bắt đăng nhập để dùng bằng chứng từ hub: không có lợi khi Q2 không hỏi hub |
| Q5 | Có cho force-delete không | **Không có nút force** cho người dùng. Nhánh có commit chưa có trên remote nào **không bao giờ** bị xoá. Bên trong, app được dùng `branch -D` chỉ khi đủ bằng chứng merge và mọi commit đã có trên remote (vì `branch -d` từ chối nhánh squash-merge). Worktree có thay đổi chưa commit, file chưa theo dõi, hay file bị bỏ qua ngoài danh sách thư mục dựng lại được (Q15) thì không gỡ | (a) Nút force sau hộp thoại cảnh báo thứ hai: mất việc khó lấy lại. (b) Cho gỡ worktree bẩn nếu chỉ có file chưa theo dõi: dễ mất file tạo tay |
| Q6 | Đụng worktree mà run hoặc agent đang chạy | **Bỏ qua, nêu lý do**. Worktree nằm dưới thư mục dữ liệu của worker (`runs/`, `terminals/`, `.trash-*`) không bao giờ là ứng viên. Worktree có agent đang chạy (màn Agent trên máy, spec 021), có terminal của app đang mở, hoặc bị `git worktree lock` cũng vậy. Lệnh ghi ngắn (xoá nhánh, gỡ siêu dữ liệu, đổi, tạo nhánh) giữ cùng khoá repo với worker | Hỏi worker qua localipc danh sách run: `worker.status` hiện chỉ trả số run, phải thêm thao tác mới |
| Q7 | Có làm merge hoặc rebase không | **Đã chốt: có** (US8, P2). Khuyến nghị ban đầu: **không** ở bản đầu. Có Fetch và Pull chỉ tiến nhanh (`merge --ff-only @{u}`) như spec 016 | Merge, rebase có giao diện xung đột: phạm vi lớn, trùng IDE |
| Q8 | Dọn những nhánh nào | **Mẫu tên cấu hình được, mặc định `ai/*` và `claude/*`**. Nhánh khác hiện trong danh sách nhưng không được đề xuất dọn | (a) Chỉ `ai/*` theo lời chủ dự án: bỏ sót 19 nhánh `claude/*` trên máy dev. (b) Mọi nhánh đã merge: dễ xoá nhánh người dùng giữ có chủ đích (`release/*`, `develop`) |
| Q9 | Có xoá nhánh trên remote không | **Không** ở bản đầu. GitHub/GitLab đã có tuỳ chọn tự xoá nhánh nguồn khi merge | Nút xoá nhánh remote sau khi merge: cần quyền ghi repo, ảnh hưởng cả đội |
| Q10 | Đổi nhánh khi worktree bẩn | **Hỏi**: hộp thoại liệt kê file đang sửa, hai nút "Huỷ" và "Đổi, mang thay đổi theo". Git tự từ chối khi thay đổi đụng file khác nhau giữa hai nhánh; app báo lại lỗi đó. Không stash | (a) Chặn hẳn: an toàn nhưng phiền khi chỉ sửa một file không liên quan. (b) Stash tự động: dễ quên stash, khó thấy trong app |
| Q11 | PR/MR đã đóng mà không merge | Là ứng viên **chỉ khi** nhánh vẫn còn trên remote và chứa đỉnh nhánh local, kiểm lại bằng `git ls-remote` ngay trước khi xoá (xoá local còn lấy lại được). Mặc định **không chọn** trong xem trước. Cần Q2 phần P2 | Không bao giờ dọn nhánh của PR đã đóng: an toàn hơn, nhưng nhánh bỏ dở tích tụ |
| Q12 | Đặt giao diện ở đâu | **Màn Dự án trên máy**: mỗi repo có nút "Nhánh" mở bảng nhánh. Đầu màn có nút **"Dọn nhánh"** quét mọi repo. Không thêm mục điều hướng mới | Màn riêng "Nhánh" trong nhóm điều hướng Dự án: thêm một mục, trùng danh sách repo |
| Q13 | Thư mục chính đang đứng ở nhánh đã merge (vd. `xdev-hive` đang ở `ai/DOCSMYPROJECTS`) | Không phải ứng viên. Xem trước gợi ý nút **"Về nhánh mặc định"**, chỉ bật khi thư mục sạch; người dùng bấm riêng, rồi quét lại | Tự đổi về nhánh mặc định trong lượt dọn: đổi thư mục người dùng đang làm mà họ không để ý |
| Q14 | Nhánh trong kho bare của worker (`<cache>/xdev-hive/worker/repos/*.git`) | **Ngoài phạm vi** bản đầu. Người dùng không làm việc trong kho này; nhánh trong đó không làm rối danh sách | Thêm mục "Bộ nhớ đệm của worker" có nút dọn |
| Q15 | Worktree có file bị bỏ qua (`.gitignore`) | `git worktree remove` **xoá cả file bị bỏ qua** mà không hỏi (đã thử, research mục 3), gồm `.env` tạo tay. Khuyến nghị: chỉ gỡ khi mọi file bị bỏ qua nằm trong danh sách thư mục dựng lại được: `node_modules`, `dist`, `build`, `target`, `.turbo`, `.next`, `.venv`, `__pycache__`, `coverage` (sửa được cùng chỗ với mẫu dọn). Còn file khác thì mục bị chặn, xem trước liệt kê tối đa 20 file | (a) Bỏ qua file bị bỏ qua như git: mất `.env`, khoá, ghi chú tạo tay. (b) Hiện danh sách và cho người dùng tự chọn gỡ từng mục: thêm một bước xác nhận cho mỗi worktree |

## Hiện trạng: dùng lại, mở rộng, làm mới

Khảo sát code trên `main` tại `3a0c6304` (2026-10-19).

| Phần | Đã có | Dùng thế nào |
|---|---|---|
| Chạy git trong sidecar (`worker/internal/gitgroups/git.go:92`) | `Git.run`: `git -c credential.helper= -c core.askPass=`, biến `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `LC_ALL=C`, `GIT_OPTIONAL_LOCKS=0`; lọc biến chứa secret; `UseGitCredentials` bỏ hai `-c` đầu để dùng credential helper của máy; huỷ bằng Interrupt rồi giết sau 10 giây, riêng Windows giết ngay (`git.go:101-104`); `GitError{Msg, Auth}` che token | **Dùng lại** cho fetch và mọi lệnh git của `branches`, luôn ở chế độ credential của máy (như người dùng chạy git trong terminal). Cần tách ra package dùng chung cùng phần askpass, biến môi trường (`askpass.go`) |
| Trạng thái repo (`gitgroups/status.go`) | `status --porcelain=v2 --branch`, `parsePorcelain` (chưa export; head, upstream, ahead/behind; file chưa theo dõi không tính), `classify` → `clean/dirty/ahead/behind/diverged/error` | **Dùng lại** `parsePorcelain` (export) cho trạng thái thư mục chính và từng worktree. Cách tính "bẩn" khác ở bước dọn: file chưa theo dõi và file bị bỏ qua **có** tính (FR-022) |
| Fetch, pull (`gitgroups/sync.go:146,162`) | `fetch --prune --quiet origin` (chỉ `origin`); pull = `merge --ff-only --quiet @{u}` chỉ khi Behind; không stash, không reset | **Dùng lại** cho nút Pull. Fetch của `branches` chạy từng remote một để biết remote nào fetch được (FR-004) |
| Luồng sự kiện và huỷ (`git_groups.rs:386-469`) | Sidecar in mỗi dòng một JSON; Rust phát `git-groups:event`; huỷ bằng `cancel\n` qua stdin; bảng `Jobs` | **Dùng lại** cùng mẫu cho lượt dọn (sự kiện `git-branches:event`) |
| Gọi sidecar một lần (`lib.rs:507-539`) | `sidecar_json`: tham số `--key=value`, secret chỉ qua biến môi trường, chạy bằng `.output()` (không ghi được stdin), kết quả là một JSON. Không có giới hạn thời gian. Giết sidecar thì git con vẫn chạy (`cmd/hive-worker/gitgroups.go:362-363`) | **Mở rộng**: hàm mới gửi được một dòng JSON qua stdin; giới hạn thời gian do sidecar tự huỷ (plan mục 4) |
| Nhánh hiện tại (`workspace.rs:23-66`) | Rust gọi `git -C <thư mục> symbolic-ref --short HEAD`, giới hạn 5 giây. Thẻ thư mục ở màn Trang chủ hiện "nhánh X" | **Giữ nguyên**. Không chuyển sang sidecar |
| Màn Dự án trên máy (`projects-screen.tsx`, `LocalRepoList`) | Mỗi repo hiện tên, thư mục, origin; **không** có nhánh, không có trạng thái bẩn | **Mở rộng**: thêm nhánh hiện tại, sạch/bẩn, ahead/behind, nút "Nhánh". Thêm nút "Dọn nhánh" |
| Nhóm Git theo dõi (`git-groups.tsx:587-598`) | Mỗi repo hiện trạng thái, nhánh, ahead, behind | **Giữ nguyên**. Nút "Nhánh" cũng mở được từ dòng repo đã clone |
| Danh sách repo trên máy (`projects.json`, `internal/projects`) | `{projectId, name, folder, fullPermission}`; `projectId` rỗng là repo chưa gắn dự án hub; repo clone từ nhóm Git cũng được thêm (`gitgroups/sync.go` `AddFolder`) | **Dùng lại** làm danh sách repo để quét. Không đổi định dạng |
| Kết nối Git tại máy (spec 016) | Token trong keychain (`dev.xdev.hive.git`) hoặc `authMode=git` đọc `git credential fill`; Rust chuyển token cho sidecar qua `HIVE_GIT_TOKENS`; `gitgroups/api.go` có client GitLab/GitHub, phân trang, `apiBase` | **Dùng lại** ở P2 để hỏi trạng thái PR/MR (FR-030). Thêm hàm liệt kê MR/PR của một repo |
| Worktree của run (`runner.go:290-334`, `local.go:69-148`) | Worktree ở `<DataDir>/runs/<runId>-<attempt>`; khi xong dời sang `runs/.trash-*` rồi xoá; nhánh `ai/<key>` giữ lại khi đã push, trả về hay xoá khi không push. `prepareBranch` từ chối nếu nhánh có commit chưa có trên `refs/remotes/origin`. Không `worktree prune` cả repo người dùng. Terminal của worker cũng đăng ký worktree rời trong repo người dùng, ở `<DataDir>/terminals/` (`interactive.go:51,105`) | **Dùng lại** ý: không prune cả repo, chỉ gỡ siêu dữ liệu đúng worktree. Kiểm "đã đẩy" **chặt hơn** worker: theo mọi remote đã fetch được, theo mã đỉnh |
| Khoá repo (`runner/repolock.go:30-93`, `local.go:38`) | `lockRepo`: khoá trong tiến trình và khoá file `<DataDir>/repos/local-<sha(commonDir)[:12]>.lock`. Worker giữ khoá cho **từng lệnh** git ghi (`gitWrite`), không giữ suốt `prepareBranch` | **Dùng lại** cho lệnh ghi ngắn của `branches`. Cần chuyển ra package dùng chung (cùng `lockFile`, `tryLockFile`, `unlockFile` mà `guard.go` cũng dùng) |
| Đọc worktree (`local.go:169` `parseWorktrees`) | Đọc `worktree list --porcelain` (path, branch) | **Mở rộng**: thêm `locked`, `prunable`, `detached`, `bare` |
| Agent trên máy (spec 021, `agents.rs`) | Lệnh `machine_agents` trả tiến trình agent kèm thư mục làm việc; `classify.rs:229-245` nhận thư mục `runs/<runId>-<attempt>` | **Dùng lại**: Rust gửi danh sách thư mục đang có agent cho sidecar. Worktree bị coi là đang dùng khi thư mục của agent **nằm trong** worktree (agent ở thư mục chính không chặn worktree trong `.claude/worktrees/` của nó) |
| Terminal theo dự án (`pty.rs`, `lib/pty.ts`) | `pty_open` nhận `folder`, nhưng `Session` (`pty.rs:165-170`) chỉ giữ `pid`, không giữ thư mục; shell có thể `cd` đi chỗ khác | **Mở rộng**: `Session` giữ thư mục lúc mở; Rust còn đọc thư mục hiện tại của tiến trình shell qua `sysinfo` (như `agents.rs`) khi đọc được [Inference: Windows có thể không cho đọc thư mục của một số tiến trình] |
| Hub (`apps/hub/src/modules/scm`, `runs/scm-events.ts`) | Biết PR merge/đóng qua webhook; đặt task `done`; bảng `runs` có `branch`, `pr_url`, không có trạng thái PR. Không có API tra theo nhánh | **Không dùng** (Q2, Q4) |
| Tiền lệ (`.claude/skills/agent-fleet/scripts/cleanup-merged.sh`) | Script zsh: `gh pr list --state merged`, kiểm tổ tiên của `origin/main`, bỏ worktree đang có job, gỡ worktree bẩn bằng `--force` khi chỉ có file chưa theo dõi | **Tham khảo**. Spec chặt hơn: không `--force`, chặn cả file bị bỏ qua ngoài danh sách dựng lại được (Q15), kiểm commit chưa đẩy |

## Khái niệm

| Khái niệm | Nghĩa |
|---|---|
| Repo trên máy | Một mục trong `projects.json` có thư mục tồn tại và là repo git (thư mục chính) |
| Worktree | Một mục trong `git worktree list --porcelain` của repo. Mục đầu là thư mục chính, các mục sau là worktree liên kết |
| Nhánh mặc định | `refs/remotes/origin/HEAD` nếu có; không có thì nhánh mặc định trong danh sách của nhóm Git; không có nữa thì `main`, rồi `master` nếu có trên remote |
| Commit chưa đẩy | Commit tới được từ mã đỉnh của nhánh mà không nằm trong ref nào của các remote đã `fetch --prune` thành công trong lượt quét. Ref của remote fetch lỗi không được tính là "đã đẩy", trừ một ngoại lệ ở FR-027: commit đã nằm trong nhánh mặc định của `origin` theo ref có trên máy (nhánh mặc định trên remote hiếm khi bị viết lại) |
| Bằng chứng đã merge | Một trong: (1) PR/MR của nhánh đã merge, theo API (P2); (2) đỉnh nhánh nằm trong nhánh mặc định của remote và **không** nằm trên chuỗi first-parent của nó (đã vào qua merge commit), trong cửa sổ lịch sử plan quy định |
| Bằng chứng đã đóng | PR/MR mới nhất của nhánh đã đóng không merge, theo API (P2) |
| Ứng viên dọn | Nhánh khớp mẫu dọn, có bằng chứng đã merge hay đã đóng, không có commit chưa đẩy, không bị chặn (FR-020…FR-026) |
| Mẫu dọn | Danh sách mẫu tên nhánh được đề xuất dọn. Mặc định `ai/*`, `claude/*` (Q8) |

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Xem nhánh của một repo (Priority: P1)

Người dùng mở **Dự án trên máy**, thấy mỗi repo có nhánh đang đứng, sạch hay bẩn, số commit trước/sau remote. Bấm
**Nhánh** để mở bảng nhánh của repo.

Bảng nhánh có:
- **Nhánh local**: tên, nhánh remote theo dõi, trước/sau nhánh theo dõi, trước/sau nhánh mặc định, ngày commit cuối,
  worktree đang mở nhánh đó (nếu có), nhãn "đang đứng", "chưa đẩy N commit", "remote đã xoá".
- **Nhánh remote**: các nhánh dưới `refs/remotes/<remote>/` chưa có nhánh local cùng tên.
- **Worktree**: đường dẫn, nhánh, sạch/bẩn, nhãn "đang có agent", "đang có terminal", "bị khoá", "thư mục đã mất".

**Why this priority**: là nền cho đổi, tạo và dọn nhánh; trả lời "repo này đang ở đâu" mà không mở terminal.

**Independent Test**: repo thử có bare remote cục bộ, ba nhánh local (một ahead, một behind, một không theo dõi), một
nhánh chỉ có trên remote, một worktree liên kết bẩn. Mở bảng, đối chiếu từng cột.

**Acceptance Scenarios**:

1. **Given** repo có nhánh `feature` trước upstream 2, sau 1, **When** mở bảng, **Then** dòng `feature` hiện "↑2 ↓1".
2. **Given** repo chưa fetch lần nào trong phiên, **When** mở bảng, **Then** số liệu lấy từ ref đã có (không gọi mạng)
   và có dòng "Fetch lúc …" hay "Chưa fetch"; nút **Fetch** chạy `fetch --prune` rồi tải lại bảng.
3. **Given** thư mục chính có file đã theo dõi bị sửa, **When** xem danh sách repo, **Then** repo có nhãn "Có thay đổi".
4. **Given** repo có 200 nhánh remote, **When** mở bảng, **Then** bảng hiện trong 2 giây (SC-001) và có ô lọc theo tên.
5. **Given** thư mục trong `projects.json` không còn hay không phải repo git, **When** mở màn, **Then** repo hiện lỗi,
   không có nút Nhánh.

---

### User Story 2 - Đổi nhánh (Priority: P1)

Người dùng chọn một nhánh trong bảng và bấm **Đổi sang nhánh này** cho thư mục chính (hay một worktree đã chọn).

**Why this priority**: thao tác hằng ngày, hiện phải mở terminal.

**Independent Test**: repo thử sạch, đổi sang nhánh local; đổi sang nhánh chỉ có trên remote; thử đổi khi bẩn; thử đổi
sang nhánh đang mở ở worktree khác.

**Acceptance Scenarios**:

1. **Given** thư mục sạch, **When** đổi sang nhánh local `feature`, **Then** chạy `git switch feature`, bảng và thẻ repo
   hiện nhánh mới.
2. **Given** nhánh chỉ có trên remote `origin/feature`, **When** đổi, **Then** tạo nhánh local `feature` theo dõi
   `origin/feature` (`git switch --track origin/feature`).
3. **Given** thư mục có file đã theo dõi bị sửa, **When** đổi, **Then** hộp thoại liệt kê file (tối đa 20, kèm "và N file
   khác") với hai nút **Huỷ** và **Đổi, mang thay đổi theo** (Q10). Git từ chối thì hiện lỗi của git, thư mục giữ nguyên.
4. **Given** nhánh đích đang mở ở worktree khác, **When** đổi, **Then** báo "Nhánh đang mở ở <đường dẫn>" và có nút mở
   thư mục đó; không chạy git.
5. **Given** repo đang giữa merge, rebase, cherry-pick hay bisect, **When** đổi, **Then** từ chối và nêu thao tác đang dở.
6. **Given** có agent đang chạy trong thư mục, **When** đổi, **Then** cảnh báo "Agent đang chạy trong thư mục này" và
   phải xác nhận lần nữa.

---

### User Story 3 - Tạo nhánh từ nhánh gốc (Priority: P1)

Người dùng bấm **Tạo nhánh**, gõ tên, chọn nhánh gốc (local hay remote, mặc định là nhánh mặc định trên remote), chọn có
đổi sang nhánh mới ngay không.

**Independent Test**: tạo nhánh từ `origin/main` có đổi sang; tạo nhánh từ nhánh local không đổi sang; tên sai; tên trùng.

**Acceptance Scenarios**:

1. **Given** tên `feature/abc` hợp lệ, gốc `origin/main`, ô "Đổi sang nhánh mới" bật, thư mục sạch, **When** tạo,
   **Then** chạy `git switch --no-track -c feature/abc origin/main`; nhánh mới không có upstream.
2. **Given** ô "Đổi sang nhánh mới" tắt, **When** tạo, **Then** chạy `git branch --no-track <tên> <gốc>`, thư mục đứng yên.
3. **Given** tên có khoảng trắng, `..`, kết thúc `.lock`, hay `git check-ref-format --branch` từ chối, **When** gõ,
   **Then** nút Tạo tắt và hiện lý do.
4. **Given** tên đã có, **When** tạo, **Then** báo "Nhánh đã có" và không ghi đè (không dùng `-B`, `-C`).
5. **Given** ô "Fetch nhánh gốc trước" bật (mặc định bật khi gốc là nhánh remote), **When** tạo, **Then** fetch nhánh gốc
   trước; fetch lỗi thì hỏi "Tạo từ bản đã có trên máy?".

---

### User Story 4 - Dọn nhánh và worktree đã merge (Priority: P1)

Người dùng bấm **Dọn nhánh** (cho một repo hay mọi repo). App fetch, tìm ứng viên rồi hiện **xem trước**. Người dùng bỏ
chọn mục không muốn, bấm **Dọn N mục**, xác nhận lần nữa. App gỡ worktree và xoá nhánh local đã chọn, hiện kết quả từng
mục.

**Why this priority**: là lý do chính của spec. Máy dev có khoảng 30 worktree cũ.

**Independent Test**: repo thử có bare remote và các nhánh `ai/*`:
- `ai/A` đã merge qua merge commit, có worktree sạch → ứng viên;
- `ai/B` có 1 commit chưa đẩy → chặn;
- `ai/C` mới tạo từ `main`, chưa có commit → không ứng viên;
- `ai/D` đã merge, worktree có file chưa theo dõi → chặn;
- `ai/E` đã merge, worktree bị khoá → chặn;
- `ai/F` đã merge, thư mục chính đang đứng → chặn, có gợi ý "Về nhánh mặc định";
- `ai/G` đã merge, worktree có `.env` bị bỏ qua → chặn (Q15); `ai/H` đã merge, worktree chỉ có `node_modules/` → ứng viên;
- `ai/I` có commit chưa đẩy và có tag `ai/I` đã đẩy cùng tên → chặn (kiểm theo `refs/heads/`, FR-021);
- `feature/x` đã merge → không khớp mẫu, không hiện.

Chạy dọn, kiểm chỉ `ai/A`, `ai/H` và worktree của chúng mất.

**Acceptance Scenarios**:

1. **Given** bấm Dọn nhánh, **When** app quét, **Then** app chạy `fetch --prune` từng repo trước; repo fetch lỗi vẫn quét
   nhưng có nhãn "Không fetch được, chỉ dùng bằng chứng đã có trên máy" (FR-027).
2. **Given** kết quả quét, **When** hiện xem trước, **Then** mỗi mục có: repo, nhánh, worktree (nếu có), bằng chứng
   ("Đã vào origin/main qua merge commit", "MR !123 đã merge", "PR #45 đã đóng"), ngày commit cuối. Mục bị chặn hiện ở
   nhóm riêng "Không dọn" kèm lý do, không chọn được.
3. **Given** mục có bằng chứng đã merge, **When** hiện xem trước, **Then** mục được chọn sẵn. Mục chỉ có bằng chứng đã
   đóng thì không chọn sẵn (Q11).
4. **Given** người dùng bấm Dọn N mục, **When** xác nhận, **Then** hộp thoại thứ hai nêu số nhánh, số worktree sẽ gỡ và
   câu "Nhánh local sẽ bị xoá. Commit vẫn còn trên remote."; chỉ chạy khi bấm **Dọn**.
5. **Given** đang dọn, **When** từng mục xong, **Then** hiện tiến độ; nút **Huỷ** dừng sau mục đang chạy.
6. **Given** giữa lúc xem trước và lúc dọn có thay đổi (commit mới, file mới trong worktree, agent mới chạy), **When**
   tới mục đó, **Then** app kiểm lại mọi điều kiện ngay trước khi ghi; điều kiện không còn đúng thì bỏ qua mục và nêu lý do
   (FR-028).
7. **Given** dọn xong, **When** xem kết quả, **Then** có số đã dọn, số bỏ qua kèm lý do, và mã commit đỉnh của từng nhánh
   đã xoá (để lấy lại bằng `git branch <tên> <mã>` khi cần).

---

### User Story 5 - Pull một repo (Priority: P2)

Trong bảng nhánh có **Pull** (nút Fetch thuộc US1, P1). Pull chỉ tiến nhanh, cùng quy tắc spec 016 US3.

**Acceptance Scenarios**:

1. **Given** nhánh đang đứng Behind và thư mục sạch, **When** Pull, **Then** chạy `merge --ff-only @{u}` sau khi fetch.
2. **Given** nhánh vừa ahead vừa behind, hay thư mục bẩn, **When** Pull, **Then** không chạy và nêu lý do.

---

### User Story 6 - Bằng chứng từ GitHub/GitLab (Priority: P2)

Repo có origin trùng máy chủ của một kết nối Git tại máy (spec 016) thì app hỏi API trạng thái PR/MR của các nhánh khớp
mẫu dọn. Nhờ đó nhận được nhánh squash-merge, rebase-merge và PR đã đóng.

**Acceptance Scenarios**:

1. **Given** MR của `ai/X` đã squash-merge trên GitLab, **When** quét, **Then** `ai/X` có bằng chứng "MR !N đã merge".
2. **Given** token thiếu quyền hay hết hạn, **When** quét, **Then** repo dùng bằng chứng git, có nhãn "Không đọc được
   PR/MR: <lý do>"; không lộ token.
3. **Given** một nhánh có nhiều PR, **When** quét, **Then** lấy PR cập nhật mới nhất; còn PR đang mở thì không ứng viên.

---

### User Story 8 - Merge hoặc rebase nhánh đang đứng (Priority: P2)

Chủ dự án chốt Q7 ngày 2026-10-20: có merge và rebase. Cách làm dưới đây là [Inference] của người điều phối, chọn theo
hướng an toàn; chủ dự án sửa được khi duyệt tasks.

Trong bảng nhánh, menu của một nhánh (local hay remote) có **Merge vào nhánh đang đứng** và **Rebase nhánh đang đứng lên
nhánh này**. Dòng nhánh đang đứng có lối tắt **Cập nhật từ <nhánh mặc định>** (merge hay rebase lên `origin/<mặc định>`).
Pull mà nhánh vừa ahead vừa behind (US5 kịch bản 2) gợi ý hai nút "Merge upstream" và "Rebase lên upstream".

App không có trình giải xung đột. Khi xung đột, app liệt kê file, cho mở thư mục hay terminal để người dùng sửa bằng IDE,
rồi bấm **Tiếp tục** hoặc **Huỷ merge/rebase**.

**Why this priority**: chủ dự án muốn có (Q7). Đặt P2 vì cần US1–US2 trước và có giao diện xung đột.

**Independent Test**: repo thử có bare remote:
- merge nhánh không xung đột → có merge commit;
- merge tiến nhanh được → chỉ tiến nhanh khi người dùng chọn "Cho phép tiến nhanh" (mặc định tạo merge commit, `--no-ff`);
- merge có xung đột → trạng thái "Đang merge", danh sách file xung đột, Huỷ đưa repo về đúng mã trước merge;
- rebase không xung đột → lịch sử tuyến tính, cảnh báo khi nhánh đã đẩy;
- rebase xung đột → sửa file, `add`, Tiếp tục → xong; Huỷ → về đúng mã trước rebase;
- thư mục bẩn → từ chối.

**Acceptance Scenarios**:

1. **Given** thư mục sạch, không dở thao tác, **When** merge `origin/main` vào `feature`, **Then** chạy
   `git merge --no-ff --no-edit --end-of-options <mã của origin/main>` trong khoá repo; bảng tải lại, hiện mã trước và sau.
2. **Given** thư mục có thay đổi đã theo dõi hay file chưa theo dõi sẽ bị ghi đè, **When** merge hay rebase, **Then** từ
   chối "Cần commit hoặc bỏ thay đổi trước" và liệt kê file (tối đa 20). Không stash, không `--autostash`.
3. **Given** merge hay rebase gặp xung đột, **When** git dừng, **Then** bảng hiện băng "Đang merge/rebase <nhánh>",
   danh sách file xung đột (`git diff --name-only --diff-filter=U`), các nút **Mở thư mục**, **Mở terminal**, **Tiếp tục**
   (chỉ bật khi không còn file xung đột chưa `add`), **Huỷ merge/rebase**.
4. **Given** đang dở rebase, **When** bấm Tiếp tục, **Then** chạy `git rebase --continue` với `GIT_EDITOR=true`; gặp
   xung đột ở commit sau thì quay lại kịch bản 3. Merge thì `git merge --continue` (cũng `GIT_EDITOR=true`).
5. **Given** đang dở merge hay rebase (kể cả do người dùng tự chạy ngoài app), **When** bấm Huỷ, **Then** xác nhận rồi
   chạy `git merge --abort` hay `git rebase --abort`; kết quả: HEAD về mã trước thao tác.
6. **Given** nhánh đang đứng có commit đã nằm trên một ref remote, **When** chọn rebase, **Then** hộp thoại cảnh báo
   "Rebase viết lại N commit đã đẩy. Sau đó phải force-push (app không push)." và phải bấm **Rebase** lần nữa.
7. **Given** có agent hay terminal của app đang chạy trong thư mục, **When** merge hay rebase, **Then** cảnh báo và phải
   xác nhận lần nữa (như FR-014).
8. **Given** HEAD rời, **When** mở menu, **Then** merge và rebase bị tắt, nêu "Cần đứng trên một nhánh".

---

### User Story 7 - Huy hiệu số nhánh dọn được (Priority: P3)

Sau mỗi lần fetch (tay hay tự fetch của nhóm Git), nút "Dọn nhánh" hiện số ứng viên. Không tự xoá.

---

### Edge Cases

- **Nhánh mới tạo, chưa có commit riêng** (đỉnh nằm trên first-parent của `origin/main`, như nhánh của phiên Claude Code
  vừa mở): `git branch --merged` coi là đã merge, nhưng spec **không** coi là ứng viên nếu không có bằng chứng API. Đo
  trên máy dev: 2 nhánh (ngoài `main`) rơi vào trường hợp này, một là worktree của chính phiên viết spec này.
- **Nhánh tạo từ commit cũ của `main`** (cũ hơn cửa sổ lịch sử plan đọc): không được coi là đã merge; hiện "không rõ".
- **Merge "foxtrot"** (merge `main` vào nhánh rồi đẩy tiến nhanh lên `main`, đảo cha của commit): đỉnh của nhánh khác có
  thể rơi ra ngoài first-parent và bị nhận là đã merge dù chưa qua PR. [Inference] Hiếm, và vẫn an toàn về dữ liệu vì mọi
  commit đã nằm trong `main`.
- **Merge tiến nhanh (fast-forward)**: đỉnh nằm trên first-parent, nên bằng chứng git không nhận. Chỉ API (P2) nhận được.
  [Inference] Ít gặp với PR GitHub/GitLab mặc định (tạo merge commit hoặc squash).
- **Squash-merge, rebase-merge**: đỉnh nhánh không nằm trong `origin/main`. Chỉ API nhận (P2). Ở P1 nhánh này hiện là
  "chưa có bằng chứng merge".
- **Remote-tracking ref cũ**: không `fetch --prune` thì `refs/remotes/origin/ai/X` vẫn còn sau khi remote đã xoá nhánh, làm
  commit trông như "đã đẩy". Vì vậy ref của remote fetch lỗi không tính là "đã đẩy" (Khái niệm), và mục có bằng chứng đã
  đóng được kiểm lại bằng `git ls-remote` ngay trước khi xoá (FR-026).
- **Tag trùng tên nhánh** (`refs/tags/ai/X` và `refs/heads/ai/X`): tên ngắn trỏ vào tag trước nhánh. Mọi lệnh dùng tên
  đầy đủ. Lệnh nhận revision (`rev-list`, `rev-parse`, `merge-base`) dùng mã đỉnh hay `refs/heads/…`; lệnh nhận tên nhánh
  (`branch -D`, `switch`) kèm `--end-of-options`.
- **Upstream là `origin/main`** (vd. `ai/SKILLHARNESS` trên máy dev, ahead 1 behind 45): "trước/sau upstream" không phải
  "đã đẩy". Kiểm commit chưa đẩy luôn theo mọi ref remote, không theo upstream.
- **Worktree mà thư mục đã bị xoá tay** (`prunable`): gỡ siêu dữ liệu của đúng worktree đó, **chỉ khi** gốc ổ đĩa và thư
  mục cha của đường dẫn worktree còn truy cập được. Bước này chỉ gỡ đăng ký, không xoá file. Mục loại này không chọn sẵn
  trong xem trước, vì trên Linux/macOS điểm gắn của ổ chưa gắn là thư mục rỗng có thật nên không phân biệt được với
  thư mục đã xoá. Không chạy `git worktree prune` cho cả repo, vì prune xoá luôn worktree nằm trên ổ chưa gắn (cùng lý
  do ở `runner/local.go:130-131`).
- **Worktree trên ổ chưa gắn hay thư mục mạng mất kết nối**: git cũng báo `prunable` [Unverified: git không phân biệt
  hai trường hợp]. Gốc ổ hay thư mục cha không truy cập được thì hiện "không truy cập được", không phải ứng viên, giữ
  nhánh.
- **Worktree của worker đang bị dời đi** (`runs/.trash-*` sau run): thoáng hiện là `prunable`. Mọi worktree dưới thư mục
  dữ liệu của worker bị chặn trước bước xét `prunable` (FR-024).
- **File bị khoá trên Windows** (tiến trình giữ file trong `node_modules`): gỡ thư mục lỗi giữa chừng. App báo "Gỡ dở,
  còn lại <đường dẫn>" và **giữ nhánh** trong mọi trường hợp gỡ dở.
- **Đường dẫn dài trên Windows** (vượt 260 ký tự trong `node_modules`): [Unverified] git và Go xử lý được khi
  `core.longpaths` bật; cần thử khi làm.
- **Nhánh mặc định không xác định được** (không có `origin/HEAD`, không có `main`/`master` trên remote): không có bằng
  chứng git; repo hiện "Không xác định nhánh mặc định".
- **Repo không có remote**: chỉ xem, đổi, tạo nhánh. Không dọn (mọi commit đều "chưa đẩy").
- **Nhiều remote** (`origin`, `upstream`): bằng chứng merge theo `origin`; "đã đẩy" tính theo mọi remote fetch được.
- **Submodule trong worktree**: `git worktree remove` từ chối worktree có submodule **đã init** (có `.git` trong thư mục
  submodule); mục bị chặn với lý do "Có submodule". Repo chỉ có `.gitmodules` mà submodule chưa init thì không chặn vì
  lý do này (đo ở research mục 5, T020).
- **Worker đang chuẩn bị run trên cùng repo**: lệnh ghi chờ khoá repo tối đa 30 giây rồi bỏ qua mục đó. Worker chỉ giữ
  khoá cho từng lệnh ghi, nên app có thể xoá `ai/<key>` giữa lúc `prepareBranch` đọc và lúc `worktree add -B` ghi.
  [Inference] Vô hại: `-B` tạo lại nhánh từ `origin/<base>`, và `restoreBranch` có thể tạo lại nhánh đã xoá từ mã đỉnh cũ
  (commit vẫn có trên remote).
- **Repo ở trạng thái HEAD rời** (detached): bảng hiện "HEAD rời tại <mã>"; đổi nhánh vẫn được nếu sạch.
- **Tên nhánh có ký tự Unicode hay `/` nhiều cấp**: hiện đúng; tham số git truyền nguyên, không qua shell.
- **Hai lượt dọn cùng lúc** (hai cửa sổ hay bấm hai lần): lượt sau bị từ chối "Đang dọn".

## Requirements *(mandatory)*

### Functional Requirements

**Xem**

- **FR-001**: Màn Dự án trên máy hiện cho mỗi repo: nhánh đang đứng (hay "HEAD rời"), sạch/có thay đổi, trước/sau
  upstream. Đọc bằng `status --porcelain=v2 --branch`, không gọi mạng.
- **FR-002**: Bảng nhánh liệt kê nhánh local, nhánh chỉ có trên remote và worktree như US1. Đọc bằng một lần
  `for-each-ref` và một lần `worktree list --porcelain`; không chạy lệnh git riêng cho từng nhánh khi git ≥ 2.41 (có
  `%(ahead-behind:…)`). Git cũ hơn thì chỉ tính trước/sau nhánh mặc định cho nhánh khớp mẫu dọn.
- **FR-003**: Bảng nhánh có ô lọc theo tên, sắp theo ngày commit cuối (mới trước), nhánh đang đứng ở đầu.
- **FR-004**: Nút Fetch chạy `fetch --prune <remote>` cho từng remote của repo, ghi remote nào thành công; lưu thời điểm
  fetch thành công trong bộ nhớ của app. Fetch dùng credential helper và khoá SSH của máy, như khi người dùng gõ
  `git fetch` (không ghi đè `credential.helper`).

**Đổi, tạo nhánh**

- **FR-010**: Đổi nhánh dùng `git switch` (không `checkout`), có `--track` cho nhánh chỉ có trên remote. Không truyền
  `--force`, `--discard-changes`, `--merge`.
- **FR-011**: Thư mục có thay đổi đã theo dõi thì hỏi theo Q10. File chưa theo dõi không làm hỏi; git tự từ chối nếu sẽ ghi
  đè.
- **FR-012**: Từ chối đổi khi repo đang dở merge, rebase, cherry-pick, revert, bisect (có `MERGE_HEAD`,
  `rebase-merge/`, `rebase-apply/`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` trong gitdir của worktree).
- **FR-013**: Tạo nhánh kiểm tên bằng `git check-ref-format --branch`; không ghi đè nhánh có sẵn; nhánh mới không có
  upstream (`--no-track`).
- **FR-014**: Đổi hay tạo nhánh trong thư mục có agent đang chạy (spec 021) phải xác nhận lần nữa.

**Merge, rebase (P2, Q7, US8)**

- **FR-050**: Merge dùng `git merge --no-ff --no-edit` (tuỳ chọn "Cho phép tiến nhanh" bỏ `--no-ff`); rebase dùng
  `git rebase` không `-i`, không `--autostash`, không `--onto`. Ref đích truyền bằng mã commit đã đọc lúc người dùng bấm,
  không bằng tên ngắn (tránh nhầm tag, như FR-021).
- **FR-051**: Chỉ chạy khi thư mục sạch (không thay đổi đã theo dõi, không file chưa theo dõi), đứng trên một nhánh, không
  dở thao tác nào (FR-012). Không stash.
- **FR-052**: Lệnh `merge`, `rebase`, `--continue`, `--abort` giữ khoá repo dùng chung với worker (FR-025) và không bị
  ngắt khi huỷ (FR-041). Giới hạn thời gian 120 giây; hết giờ thì báo, không tự `--abort`.
- **FR-053**: Khi git dừng vì xung đột, trả trạng thái `conflict` kèm thao tác (`merge`/`rebase`), file xung đột (tối đa
  200), với rebase thêm commit đang áp (`rebase-merge/msgnum`, `end`). App không tự sửa file, không `checkout --ours/--theirs`.
- **FR-054**: `--continue` chạy với `GIT_EDITOR=true` (giữ thông điệp có sẵn). Còn file xung đột chưa `add` thì không chạy.
  `rebase --skip`, `merge --quit`, `rebase --quit` không có trong app.
- **FR-055**: Rebase nhánh có commit đã nằm trên ref remote nào đó phải xác nhận thêm (US8 kịch bản 6). Merge thì không
  cần (không viết lại lịch sử).
- **FR-056**: Ghi mã HEAD trước thao tác vào nhật ký tại máy (`branches-log.jsonl`, FR-032) để khôi phục bằng
  `git reset --keep <mã>` khi cần; app hiện lệnh này trong kết quả, không tự chạy.

**Dọn**

- **FR-020**: Ứng viên dọn phải khớp mẫu dọn (Q8). Nhánh mặc định, nhánh đang đứng ở thư mục chính và nhánh có
  bằng chứng PR/MR đang mở không bao giờ là ứng viên.
- **FR-021**: Không bao giờ xoá nhánh có commit chưa đẩy. Ngay trước lệnh xoá, kiểm bằng
  `git rev-list --count <mã đỉnh đã kiểm> --not --remotes=<remote>…` (một `--remotes=` cho mỗi remote fetch được; kết quả
  0 mới được xoá). Không đưa tên ngắn của nhánh vào lệnh nhận revision (`rev-list`, `rev-parse`, `merge-base`): tên ngắn
  trỏ vào tag cùng tên trước nhánh (đã thử, research mục 3). Dùng mã đỉnh hay `refs/heads/…`.
- **FR-022**: Worktree chỉ được gỡ khi sạch: không có thay đổi đã theo dõi, không có file chưa theo dõi, mọi file bị bỏ
  qua nằm trong danh sách thư mục dựng lại được (Q15), không bị `git worktree lock`, không có submodule đã init. Gỡ bằng
  `git worktree remove <đường dẫn>` **không** `--force`. Đã thử trên git 2.56 (Windows): worktree có file bị bỏ qua gỡ
  được và **file bị bỏ qua mất theo**; có file chưa theo dõi hay bị khoá thì git từ chối.
- **FR-023**: Worktree đang dùng thì không gỡ: có tiến trình agent có thư mục làm việc nằm trong worktree (spec 021), có
  terminal của app mở trong đó, hoặc là thư mục hiện tại của cửa sổ app. Danh sách thư mục đang dùng được lấy lại lúc
  bắt đầu lượt dọn và cập nhật mỗi 5 giây trong lúc dọn; mỗi mục dùng danh sách mới nhất.
- **FR-024**: Worktree nằm dưới thư mục dữ liệu của worker (`<DataDir>`, gồm `runs/`, `runs/.trash-*`, `terminals/`) bị
  chặn trước mọi bước khác, hiện nhãn "Của worker Hive", không đọc trạng thái. Không ghi gì dưới `<DataDir>` ngoài file
  khoá repo dùng chung (`<DataDir>/repos/local-*.lock`). Không đụng kho bare `<DataDir>/repos/*.git`.
- **FR-025**: Lệnh ghi ngắn (đổi, tạo nhánh, pull, xoá nhánh, gỡ siêu dữ liệu worktree `prunable`) giữ khoá repo dùng chung
  với worker trong lúc chạy. `git worktree remove` (xoá file, có thể lâu) **không** giữ khoá, để không làm worker chờ: lệnh
  dọn của run chờ khoá không giới hạn thời gian (`runner.go:316`).
- **FR-026**: Nhánh chỉ có bằng chứng đã đóng (không merge) là ứng viên khi nhánh cùng tên còn trên remote và chứa đỉnh
  nhánh local. Ngay trước khi xoá, kiểm lại bằng `git ls-remote <remote> refs/heads/<nhánh>`: mã trả về phải bằng mã đỉnh,
  hoặc có trên máy và chứa mã đỉnh. Mặc định không chọn (Q11).
- **FR-027**: Repo fetch lỗi trong lượt quét: chỉ nhận ứng viên có đỉnh nằm trong nhánh mặc định của remote theo ref đã có;
  mục còn lại hiện "Cần fetch được để kiểm".
- **FR-028**: Ngay trước khi ghi từng mục, kiểm lại FR-020…FR-026 và đỉnh nhánh vẫn đúng mã lúc xem trước
  (`rev-parse --verify refs/heads/<nhánh>`). Lệch thì bỏ qua mục.
- **FR-029**: Thứ tự cho mỗi mục: gỡ worktree trước, xoá nhánh sau. Gỡ worktree dở hay lỗi thì giữ nhánh. Xoá nhánh bằng
  `git branch -D --end-of-options <nhánh>` trong khoá repo, ngay sau bước kiểm mã đỉnh. `git branch` luôn hiểu tên là
  nhánh (không nhầm tag) và tự từ chối nhánh đang checkout ở worktree nào đó; `git update-ref -d` không có kiểm này nên
  không dùng. Không dùng `branch -d` vì nhánh squash-merge không vào HEAD nên `-d` từ chối; an toàn đến từ FR-021 và
  FR-028.
- **FR-030** (P2): Repo có origin trùng máy chủ của kết nối Git tại máy thì hỏi API một lần cho mỗi repo (GitLab
  `GET /projects/:id/merge_requests?state=all`, GitHub `GET /repos/:owner/:repo/pulls?state=all`, sắp theo cập nhật,
  tối đa 3 trang 100 mục), so nhánh nguồn ở máy. Token chỉ đi qua biến môi trường như spec 016.
- **FR-031**: Không bao giờ xoá nhánh trên remote, không push (Q9).
- **FR-032**: Kết quả dọn ghi vào file nhật ký tại máy (`<UserConfigDir>/xdev-hive/branches-log.jsonl`): thời điểm, repo,
  nhánh, mã đỉnh, worktree, kết quả. Không ghi token, không ghi nội dung file. Giữ 1.000 dòng gần nhất.
- **FR-033**: Mẫu dọn và danh sách thư mục dựng lại được (Q15) lưu trong cấu hình tại máy, sửa được ở hộp thoại Dọn
  nhánh. Mẫu là glob đơn giản (`*` khớp mọi ký tự kể cả `/`).

**Chung**

- **FR-040**: Không cần đăng nhập Hive (Q4). Không gửi dữ liệu nào lên hub.
- **FR-041**: Mọi lệnh git chạy với `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, `LC_ALL=C`, có giới hạn thời gian
  (đọc 15 giây, fetch 120 giây một remote, `ls-remote` 30 giây, gỡ worktree 300 giây). Huỷ và hết giờ do sidecar tự
  xử lý: lệnh đọc và fetch dừng ngay; lệnh ghi (`switch`, `worktree remove`, xoá nhánh) không bị ngắt giữa chừng, huỷ có
  hiệu lực từ lệnh sau.
- **FR-042**: Lỗi git hiện dòng cuối stderr đã che token; lỗi đăng nhập dừng gọi máy chủ đó trong lượt (như
  `GitError.Auth` của spec 016).
- **FR-043**: Chữ giao diện tiếng Việt, có bản tiếng Anh như các màn khác.
- **FR-044**: Lượt quét nhiều repo chạy song song tối đa 4 repo; lượt dọn chạy tuần tự trong một repo, song song tối đa 2
  repo.

### Key Entities

- **BranchInfo**: `name`, `kind` (`local`/`remote`), `upstream?`, `aheadUpstream?`, `behindUpstream?`, `upstreamGone`,
  `aheadDefault?`, `behindDefault?`, `tip`, `committedAt`, `worktreePath?`, `unpushed` (số commit), `isCurrent`.
- **WorktreeInfo**: `path`, `branch?`, `head`, `isMain`, `locked`, `prunable`, `state` (`clean`/`dirty`/`untracked`/
  `missing`/`unreachable`/`error`), `ignoredBlocking[]` (file bị bỏ qua ngoài danh sách dựng lại được, tối đa 20),
  `busy?` (`agent`/`terminal`/`hiveWorker`/`app`).
- **RepoBranches**: `folder`, `defaultBranch?`, `current`, `operation?` (merge/rebase/…), `branches[]`, `worktrees[]`,
  `fetchedAt?`, `error?`.
- **CleanupCandidate**: `repo`, `branch`, `tip`, `worktree?`, `evidence` (`mergedGit`/`mergedApi`/`closedApi`, kèm số
  PR/MR và URL nếu có), `selected`, `blocked?` (mã lý do + chữ), `committedAt`.
- **GitOperation** (P2): `kind` (`merge`/`rebase`), `onto` (tên và mã), `headBefore`, `conflicts[]`, `step?`/`total?`
  (rebase), `state` (`done`/`conflict`/`aborted`/`error`).
- **CleanupResult**: `repo`, `branch`, `tip`, `worktree?`, `result` (`removed`/`skipped`/`partial`/`error`), `reason?`.
- **BranchSettings** (tại máy, `branches.json`): `patterns[]` (mặc định `["ai/*", "claude/*"]`), `rebuildable[]` (danh
  sách thư mục dựng lại được của Q15).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Bảng nhánh của repo có 30 worktree và 200 nhánh hiện trong ≤ 2 giây trên máy dev (không tính fetch).
  [Unverified] Chưa đo thời gian `git status` của 28 worktree trên Windows; plan mục 2 tách phần trạng thái từng worktree
  để hiện dần nếu chậm.
- **SC-002**: Quét Dọn nhánh 20 repo (đã fetch) xong trong ≤ 10 giây [Inference: mỗi repo vài lệnh git đọc, chạy 4
  song song].
- **SC-003**: Trên bộ test của US4, 0 nhánh có commit chưa đẩy bị xoá, 0 worktree bẩn bị gỡ, kể cả khi trạng thái đổi
  giữa xem trước và dọn.
- **SC-004**: Trên repo `xdev-hive` của máy dev, sau một lượt dọn với khuyến nghị Q8, số worktree liên kết giảm từ 28 xuống
  còn những worktree bẩn, đang dùng hay chưa merge [Inference: đo lại khi làm].
- **SC-005**: Người dùng đổi nhánh và tạo nhánh mà không mở terminal, ≤ 3 lần bấm cho mỗi thao tác.

## Assumptions

- Máy có `git` trong PATH của người dùng (như spec 016). Git ≥ 2.41 cho đường nhanh của FR-002; cũ hơn vẫn chạy, chậm
  hơn. Máy dev có git 2.56.
- Origin của repo là remote tên `origin` (như worker và spec 016).
- PR của đội được merge bằng merge commit (repo `xdev-hive` trên GitHub: đúng, theo `git log`) hoặc squash (cần P2).
  [Unverified] Cách merge mặc định của các repo GitLab `acme-ai`.
- Màn Agent trên máy (spec 021) đã chạy được trên Windows và macOS để biết thư mục làm việc của agent.
- Không có hub ở `192.0.2.10` (đã gỡ ngày 2026-10-19). Tính năng không cần hub.

## Out of Scope

- Cherry-pick, rebase tương tác, trình giải xung đột trong app (Q7 chỉ thêm merge và rebase, US8).
- Push, xoá nhánh trên remote, mở PR (Q9).
- Stash và quản lý stash.
- Đổi tên nhánh, đặt upstream bằng tay.
- Dọn kho bare và nhánh `ai/*` trong bộ nhớ đệm của worker (Q14).
- Tạo worktree mới từ app (Claude Code desktop và worker đã tạo).
- Dọn tự động theo lịch (Q3).
- Lấy bằng chứng merge từ hub (Q2).
- Repo không nằm trong `projects.json`.
