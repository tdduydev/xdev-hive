package branches

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// BranchStatus là trạng thái gọn của một thư mục (status, RepoBranches.current).
type BranchStatus struct {
	Folder       string `json:"folder"`
	Branch       string `json:"branch,omitempty"`
	Detached     bool   `json:"detached"`
	Head         string `json:"head,omitempty"`
	Upstream     string `json:"upstream,omitempty"`
	UpstreamGone bool   `json:"upstreamGone"`
	// Ahead, Behind là con trỏ: 0 so với upstream vẫn phải có trong JSON, không có upstream thì bỏ.
	Ahead     *int   `json:"ahead,omitempty"`
	Behind    *int   `json:"behind,omitempty"`
	Dirty     bool   `json:"dirty"`
	Untracked bool   `json:"untracked"`
	Operation string `json:"operation,omitempty"`
	Error     *Error `json:"error,omitempty"`
}

// RepoBranches là dòng kết quả của list. Mảng luôn khác nil để JSON là [] như kiểu TypeScript.
type RepoBranches struct {
	Folder        string         `json:"folder"`
	DefaultBranch string         `json:"defaultBranch,omitempty"`
	DefaultRef    string         `json:"defaultRef,omitempty"`
	Current       BranchStatus   `json:"current"`
	Operation     *GitOperation  `json:"operation,omitempty"`
	Remotes       []string       `json:"remotes"`
	Branches      []BranchInfo   `json:"branches"`
	Worktrees     []WorktreeInfo `json:"worktrees"`
	Patterns      []string       `json:"patterns"`
	SlowPath      bool           `json:"slowPath"`
	GitVersion    string         `json:"gitVersion,omitempty"`
	Error         *Error         `json:"error,omitempty"`
}

type BranchInfo struct {
	Name           string `json:"name"`
	Ref            string `json:"ref"`
	Kind           string `json:"kind"`
	Remote         string `json:"remote,omitempty"`
	Upstream       string `json:"upstream,omitempty"`
	UpstreamGone   bool   `json:"upstreamGone"`
	AheadUpstream  *int   `json:"aheadUpstream,omitempty"`
	BehindUpstream *int   `json:"behindUpstream,omitempty"`
	AheadDefault   *int   `json:"aheadDefault,omitempty"`
	BehindDefault  *int   `json:"behindDefault,omitempty"`
	Tip            string `json:"tip"`
	CommittedAt    int64  `json:"committedAt"`
	Subject        string `json:"subject,omitempty"`
	WorktreePath   string `json:"worktreePath,omitempty"`
	Unpushed       *int   `json:"unpushed,omitempty"`
	IsCurrent      bool   `json:"isCurrent"`
	IsDefault      bool   `json:"isDefault"`
	MatchesPattern bool   `json:"matchesPattern"`
}

const (
	KindLocal  = "local"
	KindRemote = "remote"
)

type WorktreeInfo struct {
	Path            string   `json:"path"`
	Branch          string   `json:"branch,omitempty"`
	Head            string   `json:"head,omitempty"`
	IsMain          bool     `json:"isMain"`
	Locked          bool     `json:"locked"`
	LockReason      string   `json:"lockReason,omitempty"`
	Prunable        bool     `json:"prunable"`
	Bare            bool     `json:"bare"`
	State           string   `json:"state"`
	Files           []string `json:"files,omitempty"`
	FilesTotal      int      `json:"filesTotal,omitempty"`
	IgnoredBlocking []string `json:"ignoredBlocking,omitempty"`
	Submodule       bool     `json:"submodule"`
	Busy            string   `json:"busy,omitempty"`
	Operation       string   `json:"operation,omitempty"`
	Error           string   `json:"error,omitempty"`
}

// Song song tối đa 4 thư mục, 4 worktree (hợp đồng mục 3.1, 3.2).
const readConcurrency = 4

// parallel chạy f(0…n-1), tối đa limit cùng lúc.
func parallel(n, limit int, f func(i int)) {
	var wg sync.WaitGroup
	sem := make(chan struct{}, limit)
	for i := range n {
		sem <- struct{}{}
		wg.Go(func() {
			defer func() { <-sem }()
			f(i)
		})
	}
	wg.Wait()
}

// Status là lệnh `status`: trạng thái gọn của từng thư mục, không gọi mạng. Thư mục lỗi chỉ làm lỗi mục của nó.
func Status(ctx context.Context, env Env, folders []string) []BranchStatus {
	out := make([]BranchStatus, len(folders))
	parallel(len(folders), readConcurrency, func(i int) {
		s := BranchStatus{Folder: folders[i]}
		t, op, err := env.readTree(ctx, folders[i], false)
		if err != nil {
			s.Error = repoError(folders[i], err)
		} else {
			s = statusOf(folders[i], t, op)
		}
		out[i] = s
	})
	return out
}

func statusOf(folder string, t tree, op string) BranchStatus {
	s := BranchStatus{
		Folder:    folder,
		Branch:    t.head,
		Detached:  t.detached,
		Head:      t.oid,
		Upstream:  t.upstream,
		Dirty:     len(t.tracked) > 0,
		Untracked: len(t.untracked) > 0,
		Operation: op,
	}
	if t.upstream != "" {
		s.UpstreamGone = !t.hasAB
		if t.hasAB {
			s.Ahead, s.Behind = Count(t.ahead), Count(t.behind)
		}
	}
	return s
}

// repoError: thư mục không còn hay không phải repo là not_repo (US1 kịch bản 5); lỗi khác giữ nguyên lỗi git.
func repoError(folder string, err error) *Error {
	var ge *gitexec.GitError
	if !isDir(folder) || (errors.As(err, &ge) && strings.Contains(ge.Msg, "not a git repository")) {
		return notRepo(folder)
	}
	return gitFailure(err)
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// Listing là list đã có dòng kết quả; Fill đọc tiếp trạng thái các worktree liên kết.
type Listing struct {
	Repo    RepoBranches
	env     Env
	paths   []string
	pending []int
	rebuild []string
}

func newListing(env Env, folder string) *Listing {
	settings := LoadSettings(env.ConfigDir)
	return &Listing{env: env, rebuild: settings.Rebuildable, Repo: RepoBranches{
		Folder:    folder,
		Current:   BranchStatus{Folder: folder},
		Remotes:   []string{},
		Branches:  []BranchInfo{},
		Worktrees: []WorktreeInfo{},
		Patterns:  append([]string{}, settings.Patterns...),
	}}
}

// ListFailed là list lỗi trước khi đọc được gì (stdin sai): vẫn đúng dạng RepoBranches, Fill chỉ in done.
func ListFailed(env Env, folder string, e *Error) *Listing {
	l := newListing(env, folder)
	l.Repo.Error = e
	return l
}

// List đọc bảng nhánh của thư mục chính bằng bốn nhánh đọc song song (plan.md mục 2), không gọi mạng. Trạng thái
// worktree liên kết để Fill đọc sau, để bảng hiện trước khi 30 lần status xong.
func List(ctx context.Context, env Env, folder string) *Listing {
	l := newListing(env, folder)
	if !isDir(folder) {
		l.Repo.Error = notRepo(folder)
		return l
	}

	var (
		wg                     sync.WaitGroup
		main                   tree
		mainOp, wtOut, remOut  string
		refs                   refsResult
		mainErr, wtErr, refErr error
		remErr                 error
	)
	wg.Go(func() { main, mainOp, mainErr = env.readTree(ctx, folder, true) })
	wg.Go(func() { wtOut, wtErr = env.read(ctx, folder, "worktree", "list", "--porcelain") })
	wg.Go(func() { refs, refErr = env.readRefs(ctx, folder) })
	wg.Go(func() { remOut, remErr = env.read(ctx, folder, "remote") })
	wg.Wait()
	if mainErr != nil {
		l.Repo.Error = repoError(folder, mainErr)
		return l
	}
	for _, err := range []error{wtErr, refErr, remErr} {
		if err != nil {
			l.Repo.Error = gitFailure(err)
			return l
		}
	}

	r := &l.Repo
	r.Current = statusOf(folder, main, mainOp)
	if mainOp != "" {
		r.Operation = env.pendingOperation(ctx, folder, mainOp)
	}
	r.GitVersion, r.SlowPath = refs.version, refs.slow
	r.DefaultBranch, r.DefaultRef = refs.defaultBranch, refs.defaultRef
	for _, name := range strings.Split(strings.TrimSpace(remOut), "\n") {
		if name = strings.TrimSpace(name); name != "" {
			r.Remotes = append(r.Remotes, name)
		}
	}
	r.Branches = branchesOf(refs, r.Remotes, r.Patterns, main)
	l.fillCounts(ctx, refs.defaultTip)
	l.worktreesOf(wtOut, folder, main, mainOp)
	return l
}

// refsResult là phần đọc ref: phiên bản git, nhánh mặc định, rồi for-each-ref có ahead-behind so với nhánh đó.
type refsResult struct {
	version       string
	slow          bool
	defaultBranch string
	defaultRef    string
	defaultTip    string
	rows          []refRow
}

type refRow struct {
	ref, tip, upstream, track, worktree, subject string
	date                                         int64
	ahead, behind                                *int
}

var refFields = []string{
	"%(refname)", "%(objectname)", "%(upstream)", "%(upstream:track,nobracket)", "%(committerdate:unix)",
	"%(worktreepath)", "%(symref)", "%(contents:subject)",
}

func (e Env) readRefs(ctx context.Context, dir string) (refsResult, error) {
	var r refsResult
	out, err := e.read(ctx, dir, "version")
	if err != nil {
		return r, err
	}
	r.version = strings.TrimPrefix(strings.TrimSpace(out), "git version ")
	if err := e.readDefault(ctx, dir, &r); err != nil {
		return r, err
	}
	// %(ahead-behind) có từ git 2.41: một lần duyệt cho mọi nhánh thay vì một rev-list mỗi nhánh. Dùng mã đỉnh thay
	// tên ref vì tên nhánh được phép chứa ")" làm hỏng chuỗi định dạng.
	fast := r.defaultTip != "" && versionAtLeast(r.version, 2, 41)
	r.slow = r.defaultTip != "" && !fast
	format := strings.Join(refFields, "%00")
	if fast {
		format += "%00%(ahead-behind:" + r.defaultTip + ")"
	}
	out, err = e.read(ctx, dir, "for-each-ref", "--format="+format, "refs/heads", "refs/remotes")
	if err != nil && fast && ctx.Err() == nil {
		// Đọc sai phiên bản (bản dựng riêng ghi số lạ): thử lại cách cũ thay vì làm hỏng cả bảng.
		r.slow = true
		out, err = e.read(ctx, dir, "for-each-ref", "--format="+strings.Join(refFields, "%00"), "refs/heads", "refs/remotes")
		fast = false
	}
	if err != nil {
		return r, err
	}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(strings.TrimSuffix(line, "\r"), "\x00")
		if len(f) < len(refFields) || f[6] != "" {
			// Dòng rỗng, hay ref tượng trưng (refs/remotes/origin/HEAD) không phải một nhánh.
			continue
		}
		row := refRow{ref: f[0], tip: f[1], upstream: f[2], track: f[3], worktree: f[5], subject: f[7]}
		row.date, _ = strconv.ParseInt(f[4], 10, 64)
		if fast && len(f) > len(refFields) {
			if ab := strings.Fields(f[len(refFields)]); len(ab) == 2 {
				a, errA := strconv.Atoi(ab[0])
				b, errB := strconv.Atoi(ab[1])
				if errA == nil && errB == nil {
					row.ahead, row.behind = Count(a), Count(b)
				}
			}
		}
		r.rows = append(r.rows, row)
	}
	return r, nil
}

// readDefault tìm nhánh mặc định theo Khái niệm của spec: refs/remotes/origin/HEAD, rồi main, master trên origin.
// Bước "nhánh mặc định trong danh sách nhóm Git" cần cấu hình gitgroups mà hợp đồng chưa truyền vào, nên chưa có.
func (e Env) readDefault(ctx context.Context, dir string, r *refsResult) error {
	head, err := e.read(ctx, dir, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD")
	if err != nil && ctx.Err() != nil {
		return ctx.Err()
	}
	head = strings.TrimSpace(head)
	candidates := []string{"refs/remotes/origin/main", "refs/remotes/origin/master"}
	if strings.HasPrefix(head, "refs/remotes/origin/") {
		candidates = append([]string{head}, candidates...)
	}
	out, err := e.read(ctx, dir, append([]string{"for-each-ref", "--format=%(refname)%00%(objectname)"}, candidates...)...)
	if err != nil {
		return err
	}
	// for-each-ref khớp cả ref con (refs/remotes/origin/main/x), nên chỉ nhận đúng tên; origin/HEAD trỏ tới ref đã
	// xoá thì rơi xuống main, master.
	tips := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if ref, tip, ok := strings.Cut(line, "\x00"); ok {
			tips[ref] = tip
		}
	}
	for _, c := range candidates {
		if tip, ok := tips[c]; ok {
			r.defaultRef, r.defaultTip = c, tip
			r.defaultBranch = strings.TrimPrefix(c, "refs/remotes/origin/")
			return nil
		}
	}
	return nil
}

// versionAtLeast đọc "2.45.1.windows.1", "2.39.3 (Apple Git-146)"; không đọc được thì coi như đủ mới, readRefs tự lùi
// về cách cũ khi git từ chối trường ahead-behind.
func versionAtLeast(v string, major, minor int) bool {
	f := strings.SplitN(strings.Fields(v + " ")[0], ".", 3)
	if len(f) < 2 {
		return true
	}
	ma, err1 := strconv.Atoi(f[0])
	mi, err2 := strconv.Atoi(f[1])
	if err1 != nil || err2 != nil {
		return true
	}
	return ma > major || (ma == major && mi >= minor)
}

// branchesOf dựng danh sách nhánh: local trước, rồi nhánh remote chưa có local cùng tên (FR-002).
func branchesOf(refs refsResult, remotes, patterns []string, main tree) []BranchInfo {
	local := map[string]bool{}
	for _, row := range refs.rows {
		if name, ok := strings.CutPrefix(row.ref, "refs/heads/"); ok {
			local[name] = true
		}
	}
	out := []BranchInfo{}
	var remote []BranchInfo
	for _, row := range refs.rows {
		b := BranchInfo{
			Ref: row.ref, Tip: row.tip, CommittedAt: row.date, Subject: truncate(row.subject, 200),
			AheadDefault: row.ahead, BehindDefault: row.behind,
		}
		if row.worktree != "" {
			b.WorktreePath = filepath.Clean(filepath.FromSlash(row.worktree))
		}
		if name, ok := strings.CutPrefix(row.ref, "refs/heads/"); ok {
			b.Name, b.Kind = name, KindLocal
			b.IsCurrent = !main.detached && main.head == name
			b.IsDefault = refs.defaultBranch != "" && name == refs.defaultBranch
			b.MatchesPattern = MatchAny(patterns, name)
			b.Upstream = shortRef(row.upstream)
			if b.Upstream != "" {
				b.UpstreamGone = row.track == "gone"
				if !b.UpstreamGone {
					a, behind := parseTrack(row.track)
					b.AheadUpstream, b.BehindUpstream = Count(a), Count(behind)
				}
			}
			out = append(out, b)
			continue
		}
		name, ok := strings.CutPrefix(row.ref, "refs/remotes/")
		if !ok {
			continue
		}
		rem, short := splitRemote(name, remotes)
		if local[short] {
			continue
		}
		b.Name, b.Kind, b.Remote = name, KindRemote, rem
		b.IsDefault = row.ref == refs.defaultRef
		b.MatchesPattern = MatchAny(patterns, short)
		remote = append(remote, b)
	}
	return append(out, remote...)
}

// shortRef bỏ refs/remotes/, refs/heads/ (upstream là nhánh local khác) cho tên hiện.
func shortRef(ref string) string {
	if s, ok := strings.CutPrefix(ref, "refs/remotes/"); ok {
		return s
	}
	return strings.TrimPrefix(ref, "refs/heads/")
}

// splitRemote tách "origin/feature/x" thành remote và tên; tên remote được phép có "/", nên chọn remote dài nhất khớp.
// Ref của remote đã gỡ khỏi config thì lấy đoạn đầu.
func splitRemote(name string, remotes []string) (string, string) {
	best := ""
	for _, r := range remotes {
		if strings.HasPrefix(name, r+"/") && len(r) > len(best) {
			best = r
		}
	}
	if best == "" {
		best, _, _ = strings.Cut(name, "/")
	}
	return best, strings.TrimPrefix(name, best+"/")
}

// parseTrack đọc "ahead 1, behind 2"; chuỗi rỗng là ngang upstream.
func parseTrack(s string) (ahead, behind int) {
	for part := range strings.SplitSeq(s, ",") {
		f := strings.Fields(part)
		if len(f) != 2 {
			continue
		}
		n, _ := strconv.Atoi(f[1])
		switch f[0] {
		case "ahead":
			ahead = n
		case "behind":
			behind = n
		}
	}
	return ahead, behind
}

func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}

// fillCounts đếm commit chưa đẩy cho nhánh local khớp mẫu hay đang đứng (plan.md mục 2), và với git < 2.41 thì
// ahead/behind so với nhánh mặc định cho đúng các nhánh đó. Mỗi nhánh một rev-list nên không làm cho mọi nhánh.
func (l *Listing) fillCounts(ctx context.Context, defaultTip string) {
	var idx []int
	for i, b := range l.Repo.Branches {
		if b.Kind == KindLocal && (b.MatchesPattern || b.IsCurrent) {
			idx = append(idx, i)
		}
	}
	parallel(len(idx), readConcurrency, func(k int) {
		b := &l.Repo.Branches[idx[k]]
		if out, err := l.env.read(ctx, l.Repo.Folder, "rev-list", "--count", b.Tip, "--not", "--remotes"); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(out)); err == nil {
				b.Unpushed = Count(n)
			}
		}
		if l.Repo.SlowPath && b.MatchesPattern {
			out, err := l.env.read(ctx, l.Repo.Folder, "rev-list", "--left-right", "--count", b.Tip+"..."+defaultTip)
			if f := strings.Fields(out); err == nil && len(f) == 2 {
				a, errA := strconv.Atoi(f[0])
				behind, errB := strconv.Atoi(f[1])
				if errA == nil && errB == nil {
					b.AheadDefault, b.BehindDefault = Count(a), Count(behind)
				}
			}
		}
	})
}

// worktreesOf dựng danh sách worktree; thư mục chính có trạng thái ngay, worktree liên kết chờ Fill.
func (l *Listing) worktreesOf(porcelain, folder string, main tree, mainOp string) {
	wts := repolock.ParseWorktrees(porcelain)
	l.paths = make([]string, len(wts))
	for i, w := range wts {
		l.paths[i] = w.Path
	}
	busy := l.env.busy()
	for i, w := range wts {
		info := WorktreeInfo{
			Path:       filepath.Clean(w.Path),
			Branch:     strings.TrimPrefix(w.Branch, "refs/heads/"),
			Head:       w.HEAD,
			IsMain:     i == 0,
			Locked:     w.Locked,
			LockReason: w.LockedReason,
			Prunable:   w.Prunable,
			Bare:       w.Bare,
			State:      StatePending,
		}
		switch {
		case repolock.SamePath(w.Path, folder):
			fillTree(&info, main, mainOp, l.rebuild)
		case l.underDataDir(w.Path):
			// Worktree của run (FR-024): không đọc, không để ai đụng vào.
			info.State, info.Busy = StateSkipped, BusyHiveWorker
		case w.Bare:
			info.State = StateSkipped
		default:
			if s := pathState(w.Path); s != "" {
				info.State = s
			} else {
				l.pending = append(l.pending, i)
			}
		}
		if info.Busy == "" {
			info.Busy = busyKind(busyOwned(l.paths, i, busy))
		}
		l.Repo.Worktrees = append(l.Repo.Worktrees, info)
	}
}

func (l *Listing) underDataDir(p string) bool {
	d := l.env.DataDir
	return d != "" && (repolock.SamePath(d, p) || repolock.InsideDir(d, p))
}

func fillTree(info *WorktreeInfo, t tree, op string, rebuild []string) {
	info.State = t.state()
	info.Files, info.FilesTotal = t.files()
	info.IgnoredBlocking, _ = capList(IgnoredBlocking(t.ignored, rebuild), maxFiles)
	info.Submodule = t.submodule || hasSubmodule(info.Path)
	info.Operation = op
}

// Fill đọc trạng thái các worktree liên kết, song song tối đa 4, mỗi worktree xong in một sự kiện worktree, cuối cùng
// là done. Huỷ thì các worktree chưa xong có state error "Đã huỷ" (hợp đồng mục 3.2).
func (l *Listing) Fill(ctx context.Context, emit Emit) {
	if l.Repo.Error == nil {
		parallel(len(l.pending), readConcurrency, func(k int) {
			i := l.pending[k]
			info := l.Repo.Worktrees[i]
			if err := ctx.Err(); err != nil {
				info.State, info.Error = StateError, stopText(err)
			} else if t, op, err := l.env.readTree(ctx, info.Path, true); err == nil {
				fillTree(&info, t, op, l.rebuild)
			} else if ctx.Err() != nil {
				info.State, info.Error = StateError, stopText(ctx.Err())
			} else if s := pathState(info.Path); s != "" {
				info.State = s
			} else {
				info.State, info.Error = StateError, gitFailure(err).text()
			}
			// Nhãn busy theo danh sách mới nhất: Rust có thể gửi lại trong lúc đọc.
			info.Busy = busyKind(busyOwned(l.paths, i, l.env.busy()))
			emit(Event{Type: EventWorktree, Folder: l.Repo.Folder, Worktree: &info})
		})
	}
	emit(Event{Type: EventDone, Folder: l.Repo.Folder})
}

func stopText(err error) string {
	if errors.Is(err, context.Canceled) {
		return "Đã huỷ"
	}
	return "Hết thời gian chờ git."
}

// text là chữ hiện trong WorktreeInfo.error: dòng của git nếu có, không thì câu chung.
func (e *Error) text() string {
	if e.Detail != "" {
		return e.Detail
	}
	return e.Message
}
