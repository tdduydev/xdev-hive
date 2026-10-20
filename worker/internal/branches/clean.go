package branches

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// CleanItem là một mục người dùng chọn ở xem trước (hợp đồng mục 2.3).
type CleanItem struct {
	Folder   string   `json:"folder"`
	Branch   string   `json:"branch"`
	Tip      string   `json:"tip"`
	Worktree string   `json:"worktree,omitempty"`
	Prunable bool     `json:"prunable,omitempty"`
	Evidence Evidence `json:"evidence"`
}

// CleanResult là kết quả dọn một mục.
type CleanResult struct {
	Folder          string `json:"folder"`
	Branch          string `json:"branch"`
	Tip             string `json:"tip"`
	Worktree        string `json:"worktree,omitempty"`
	Result          string `json:"result"`
	Code            string `json:"code,omitempty"`
	Reason          string `json:"reason,omitempty"`
	WorktreeRemoved bool   `json:"worktreeRemoved"`
	BranchDeleted   bool   `json:"branchDeleted"`
	Left            string `json:"left,omitempty"`
}

// Bước của sự kiện progress khi dọn.
const (
	StepRemoveWorktree = "removeWorktree"
	StepDeleteBranch   = "deleteBranch"
)

// CleanResult.result.
const (
	ResultRemoved   = "removed"
	ResultSkipped   = "skipped"
	ResultPartial   = "partial"
	ResultError     = "error"
	ResultCancelled = "cancelled"
)

// Mã riêng của clean trong CleanResult.code, ngoài BlockCode và ErrorCode.
const (
	CodeTipChanged  = "tipChanged"
	CodeRemoteGone  = "remoteGone"
	CodeRemoteMoved = "remoteMoved"
)

// Giới hạn riêng của clean (hợp đồng mục 1.5): ls-remote là lệnh mạng duy nhất; worktree remove xoá cả cây thư mục.
const (
	cleanConcurrency = 2
	lsRemoteTimeout  = 30 * time.Second
	removeTimeout    = 300 * time.Second
)

const tipChangedText = "Nhánh đã đổi sau khi xem trước"

// Clean là job `clean` (US4, plan.md mục 6). fetched là remote fetch được lúc quét của từng thư mục chính. Mục trong
// một repo chạy tuần tự, tối đa 2 repo cùng lúc (FR-044). Huỷ thì mục đang chạy chạy hết, mục còn lại là cancelled.
func Clean(ctx context.Context, env Env, items []CleanItem, fetched map[string][]string, emit Emit) {
	total := len(items)
	var folders []string
	byFolder := map[string][]int{}
	for i, it := range items {
		if _, ok := byFolder[it.Folder]; !ok {
			folders = append(folders, it.Folder)
		}
		byFolder[it.Folder] = append(byFolder[it.Folder], i)
	}
	var mu sync.Mutex
	done := 0
	summary := map[string]int{ResultRemoved: 0, ResultSkipped: 0, ResultPartial: 0, ResultError: 0, ResultCancelled: 0}
	parallel(len(folders), cleanConcurrency, func(k int) {
		folder := folders[k]
		remotes := fetchedOf(fetched, folder)
		for _, i := range byFolder[folder] {
			it := items[i]
			progress := func(ev Event) {
				ev.Folder, ev.Branch = it.Folder, it.Branch
				mu.Lock()
				defer mu.Unlock()
				ev.Done, ev.Total = Count(done), Count(total)
				emit(ev)
			}
			var r CleanResult
			if ctx.Err() != nil {
				r = cleanResult(it)
				r.Result, r.Code, r.Reason = ResultCancelled, CodeCancelled, "Đã huỷ trước khi tới mục này."
			} else {
				r = env.cleanItem(ctx, it, remotes, progress)
				// Không ghi được nhật ký thì vẫn báo kết quả: nhánh đã xoá rồi, giấu kết quả còn tệ hơn mất một dòng nhật ký.
				_ = AppendLog(env.ConfigDir, logOf(env.now(), it, r))
			}
			mu.Lock()
			done++
			summary[r.Result]++
			emit(Event{Type: EventItem, Item: &r, Done: Count(done), Total: Count(total)})
			mu.Unlock()
		}
	})
	ev := Event{Type: EventDone, Done: Count(done), Total: Count(total), Summary: summary}
	if env.ConfigDir != "" {
		ev.Log = LogPath(env.ConfigDir)
	}
	if err := ctx.Err(); err != nil {
		ev.Error = gitFailure(err)
	}
	emit(ev)
}

// fetchedOf tìm theo đúng chuỗi trước, rồi theo đường dẫn: Rust và giao diện có thể viết khác hoa thường trên Windows.
func fetchedOf(fetched map[string][]string, folder string) []string {
	if r, ok := fetched[folder]; ok {
		return r
	}
	for f, r := range fetched {
		if repolock.SamePath(f, folder) {
			return r
		}
	}
	return nil
}

func cleanResult(it CleanItem) CleanResult {
	return CleanResult{Folder: it.Folder, Branch: it.Branch, Tip: it.Tip, Worktree: it.Worktree}
}

func logOf(now time.Time, it CleanItem, r CleanResult) LogEntry {
	e := LogEntry{
		Time: now.UTC().Format(time.RFC3339), Action: ActionClean, Folder: it.Folder, Branch: it.Branch, Tip: it.Tip,
		Worktree: it.Worktree, Result: r.Result, Code: r.Code, Evidence: it.Evidence.Kind,
	}
	if r.BranchDeleted {
		e.Restore = "git branch " + it.Branch + " " + it.Tip
	}
	return e
}

// cleaning là một mục đang dọn: kết quả dồn dần, và các lối ra dừng giữa chừng.
type cleaning struct {
	r CleanResult
}

// skip dừng mục ở bước kiểm. Đã gỡ worktree rồi thì không còn là "không ghi gì" nên là error, nhánh vẫn giữ.
func (c *cleaning) skip(code, reason string) CleanResult {
	c.r.Result, c.r.Code, c.r.Reason = ResultSkipped, code, reason
	if c.r.WorktreeRemoved {
		c.r.Result, c.r.Reason = ResultError, "Đã gỡ worktree, giữ nhánh: "+reason
	}
	return c.r
}

func (c *cleaning) block(b *BlockReason) CleanResult { return c.skip(b.Code, b.Message) }

func (c *cleaning) fail(e *Error) CleanResult {
	c.r.Result, c.r.Code, c.r.Reason = ResultError, e.Code, reasonOf(e)
	return c.r
}

func reasonOf(e *Error) string {
	if e.Detail == "" {
		return e.Message
	}
	return e.Message + " " + e.Detail
}

// cleanItem dọn một mục theo plan.md mục 6. Mọi bước kiểm đọc lại từ git, không tin dữ liệu xem trước ngoài tip: nghi
// ngờ thì bỏ qua mục (SC-003).
func (e Env) cleanItem(ctx context.Context, it CleanItem, fetched []string, progress Emit) CleanResult {
	c := &cleaning{r: cleanResult(it)}
	if msg := checkItem(it); msg != "" {
		return c.fail(&Error{Code: CodeInvalidInput, Message: msg})
	}
	// Mục đã bắt đầu thì chạy hết (hợp đồng mục 3.8): huỷ giữa chừng để lại worktree đã gỡ mà nhánh chưa xét. --timeout
	// của job vẫn giới hạn cả mục.
	ctx = context.WithoutCancel(ctx)
	if e.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, e.Timeout)
		defer cancel()
	}

	l := List(ctx, e, it.Folder)
	if l.Repo.Error != nil {
		return c.fail(l.Repo.Error)
	}
	repo := &l.Repo
	var b *BranchInfo
	for i := range repo.Branches {
		if repo.Branches[i].Kind == KindLocal && repo.Branches[i].Name == it.Branch {
			b = &repo.Branches[i]
			break
		}
	}
	switch {
	case b == nil || b.Tip != it.Tip:
		return c.skip(CodeTipChanged, tipChangedText)
	case b.IsDefault || !b.MatchesPattern:
		// Hợp đồng chưa có mã riêng: cấu hình mẫu hay nhánh mặc định đổi sau khi xem trước.
		return c.skip(CodeInvalidInput, "Nhánh không còn khớp mẫu dọn hoặc đã là nhánh mặc định.")
	case b.IsCurrent:
		return c.skip(BlockCurrent, "Thư mục chính đang đứng ở nhánh này.")
	}

	si := &scanItem{branch: *b, wt: -1}
	for i, w := range repo.Worktrees {
		if w.Branch == it.Branch {
			si.wt = i
			break
		}
	}
	var w WorktreeInfo
	gone := false
	if si.wt >= 0 {
		var ok bool
		if w, ok = linked(l, si); !ok {
			return c.skip(BlockCheckedOutMain, "Nhánh đang mở ở thư mục chính của repo, không gỡ được.")
		}
		if it.Worktree == "" || !repolock.SamePath(w.Path, it.Worktree) {
			return c.skip(CodeCheckedOut, "Nhánh vừa được mở ở worktree khác: "+w.Path)
		}
		gone = w.State == StateMissing
		// Xem trước hứa "chỉ gỡ đăng ký, không xoá file"; thư mục có lại (ổ vừa gắn) thì gỡ là xoá file chưa được đồng ý.
		if it.Prunable && w.State == StatePending {
			return c.skip(CodeTipChanged, "Thư mục worktree đã có lại sau khi xem trước.")
		}
		c.r.Worktree = w.Path
	} else if it.Worktree != "" {
		for _, o := range repo.Worktrees {
			if repolock.SamePath(o.Path, it.Worktree) {
				return c.skip(CodeTipChanged, "Worktree đã đổi nhánh sau khi xem trước.")
			}
		}
		// Worktree đã được gỡ ở chỗ khác: chỉ còn xoá nhánh.
	}

	if blk := e.recheckWorktree(ctx, l, si); blk != nil {
		return c.block(blk)
	}
	if blk := e.recheckEvidence(ctx, it, repo, b); blk != nil {
		return c.block(blk)
	}
	// Kiểm commit chưa đẩy cả trước khi gỡ worktree: chặn ở đây thì worktree còn nguyên, không chỉ giữ được nhánh.
	if blk, err := e.unpushed(ctx, it.Folder, it.Tip, repo.DefaultRef, fetched); err != nil {
		return c.fail(gitFailure(err))
	} else if blk != nil {
		return c.block(blk)
	}

	if si.wt >= 0 && !gone {
		progress(Event{Type: EventProgress, Step: StepRemoveWorktree})
		// Đọc lại ngay trước lệnh gỡ: worktree remove xoá file bị bỏ qua mà không hỏi, nên khoảng hở chỉ còn một lệnh.
		if blk := e.recheckWorktree(ctx, l, si); blk != nil {
			return c.block(blk)
		}
		wctx, g := e.writeGit(ctx, removeTimeout)
		if _, err := g.Run(wctx, it.Folder, "", "worktree", "remove", "--", w.Path); err != nil {
			f := gitFailure(err)
			c.r.Result, c.r.Code, c.r.Reason = ResultPartial, f.Code, "Gỡ worktree không xong: "+reasonOf(f)
			if pathState(w.Path) != StateMissing {
				c.r.Left = w.Path
			}
			return c.r
		}
		c.r.WorktreeRemoved = true
	}

	unlock, le := e.lockRepo(ctx, it.Folder)
	if le != nil {
		return c.skip(le.Code, le.Message)
	}
	defer unlock()
	if gone {
		progress(Event{Type: EventProgress, Step: StepRemoveWorktree})
		if pe := e.unregisterWorktree(ctx, it.Folder, w.Path); pe != nil {
			c.r.Result, c.r.Code, c.r.Reason = ResultPartial, pe.Code, reasonOf(pe)
			return c.r
		}
		c.r.WorktreeRemoved = true
	}
	tip, err := e.branchTip(ctx, it.Folder, it.Branch)
	if err != nil {
		return c.fail(gitFailure(err))
	}
	if tip != it.Tip {
		return c.skip(CodeTipChanged, tipChangedText)
	}
	if blk, err := e.unpushed(ctx, it.Folder, it.Tip, repo.DefaultRef, fetched); err != nil {
		return c.fail(gitFailure(err))
	} else if blk != nil {
		return c.block(blk)
	}
	progress(Event{Type: EventProgress, Step: StepDeleteBranch})
	// branch -D tự từ chối nhánh vừa được checkout ở worktree nào đó (FR-029); không dùng update-ref -d.
	wctx, g := e.writeGit(ctx, WriteTimeout)
	if _, err := g.Run(wctx, it.Folder, "", "branch", "-D", "--end-of-options", it.Branch); err != nil {
		f := gitFailure(err)
		if c.r.WorktreeRemoved {
			f.Message = "Đã gỡ worktree nhưng không xoá được nhánh."
		}
		return c.fail(f)
	}
	c.r.Result, c.r.BranchDeleted = ResultRemoved, true
	return c.r
}

// checkItem kiểm mục trước khi đụng git; rỗng là hợp lệ. tip phải là mã đầy đủ để so đúng từng ký tự với ref.
func checkItem(it CleanItem) string {
	switch {
	case !filepath.IsAbs(it.Folder):
		return "Thư mục của mục dọn phải là đường dẫn tuyệt đối."
	case strings.TrimSpace(it.Branch) == "":
		return "Mục dọn thiếu tên nhánh."
	case !isOID(it.Tip):
		return "Mã đỉnh của nhánh " + it.Branch + " không hợp lệ."
	case it.Worktree != "" && !filepath.IsAbs(it.Worktree):
		return "Worktree của mục dọn phải là đường dẫn tuyệt đối."
	}
	return ""
}

// isOID nhận mã SHA-1 hay SHA-256 viết thường như git in ra.
func isOID(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, r := range s {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return false
		}
	}
	return true
}

// recheckWorktree là bước chặn 1–4 với busy mới nhất và trạng thái đọc lại ngay lúc gọi.
func (e Env) recheckWorktree(ctx context.Context, l *Listing, si *scanItem) *BlockReason {
	if si.wt < 0 {
		return nil
	}
	w := &l.Repo.Worktrees[si.wt]
	if s := pathState(w.Path); s != "" {
		w.State = s
	} else {
		w.State = StatePending
		si.tree, si.op, si.err = e.readTree(ctx, w.Path, true)
	}
	return blockWorktree(l, si, e.busy())
}

// recheckEvidence đọc lại bằng chứng git; bằng chứng API không đọc lại được vì clean không có token, nên dựa vào bước
// chặn commit chưa đẩy. Bằng chứng đã đóng thì hỏi remote nhánh còn đúng mã không (FR-026).
func (e Env) recheckEvidence(ctx context.Context, it CleanItem, repo *RepoBranches, b *BranchInfo) *BlockReason {
	switch it.Evidence.Kind {
	case EvidenceMergedAPI:
		return nil
	case EvidenceMergedGit:
		evs, err := e.gitEvidence(ctx, it.Folder, repo.DefaultRef, []string{it.Tip})
		if err != nil {
			return &BlockReason{Code: gitFailure(err).Code, Message: reasonOf(gitFailure(err))}
		}
		if ev := evs[it.Tip]; ev.Kind != EvidenceMergedGit {
			return &BlockReason{Code: BlockNoEvidence, Message: noEvidenceText(ev.Note)}
		}
		return nil
	case EvidenceClosedAPI:
		return e.remoteKept(ctx, it.Folder, repo.Remotes, b)
	}
	return &BlockReason{Code: BlockNoEvidence, Message: "Không có bằng chứng nhánh đã merge hay PR đã đóng."}
}

// remoteKept: PR đã đóng mà chưa merge thì chỉ an toàn khi remote còn giữ đúng các commit của nhánh. Đây là lệnh mạng
// duy nhất của clean, và chỉ đọc (FR-031).
func (e Env) remoteKept(ctx context.Context, dir string, remotes []string, b *BranchInfo) *BlockReason {
	remote := ""
	if slices.Contains(remotes, "origin") {
		remote = "origin"
	} else if b.Upstream != "" {
		if r, _ := splitRemote(b.Upstream, remotes); slices.Contains(remotes, r) {
			remote = r
		}
	}
	if remote == "" {
		return &BlockReason{Code: CodeRemoteGone, Message: "Repo không có remote để kiểm nhánh."}
	}
	ref := "refs/heads/" + b.Name
	out, err := e.git(lsRemoteTimeout).Run(ctx, dir, "", "ls-remote", "--end-of-options", remote, ref)
	if err != nil {
		f := gitFailure(err)
		return &BlockReason{Code: f.Code, Message: "Không kiểm được nhánh trên " + remote + ": " + reasonOf(f)}
	}
	// ls-remote so mẫu theo đuôi tên ref, nên refs/heads/x/ai/A cũng khớp ai/A: chỉ nhận đúng tên.
	sha := ""
	for line := range strings.SplitSeq(out, "\n") {
		if id, name, ok := strings.Cut(strings.TrimSpace(line), "\t"); ok && name == ref {
			sha = id
		}
	}
	if sha == "" {
		return &BlockReason{Code: CodeRemoteGone, Message: "Nhánh đã bị xoá trên " + remote + ", không còn bản nào giữ các commit."}
	}
	if sha == b.Tip {
		return nil
	}
	if isOID(sha) {
		if _, err := e.read(ctx, dir, "cat-file", "-e", sha+"^{commit}"); err == nil {
			anc, err := e.ancestors(ctx, dir, sha, []string{b.Tip})
			if err == nil && anc[b.Tip] {
				return nil
			}
		}
	}
	return &BlockReason{Code: CodeRemoteMoved, Message: "Nhánh trên " + remote + " đã khác bản trên máy."}
}

// unpushed là bước chặn 5 cho một đỉnh, theo đúng remote fetch được lúc quét. Không có remote nào fetch được thì ref
// remote có thể cũ: chỉ đỉnh đã nằm trong nhánh mặc định mới được xoá (FR-027).
func (e Env) unpushed(ctx context.Context, dir, tip, defaultRef string, fetched []string) (*BlockReason, error) {
	if len(fetched) == 0 {
		if defaultRef == "" {
			return &BlockReason{Code: BlockNeedsFetch, Message: "Cần fetch được để kiểm."}, nil
		}
		anc, err := e.ancestors(ctx, dir, defaultRef, []string{tip})
		if err != nil {
			return nil, err
		}
		if !anc[tip] {
			return &BlockReason{Code: BlockNeedsFetch, Message: "Cần fetch được để kiểm."}, nil
		}
		return nil, nil
	}
	args := []string{"rev-list", "--count", tip, "--not"}
	for _, r := range fetched {
		args = append(args, "--remotes="+r)
	}
	out, err := e.read(ctx, dir, args...)
	if err != nil {
		return nil, err
	}
	if n, _ := strconv.Atoi(strings.TrimSpace(out)); n > 0 {
		return &BlockReason{Code: BlockUnpushed, Message: fmt.Sprintf("Có %d commit chưa đẩy lên remote nào.", n), Count: n}, nil
	}
	return nil, nil
}

// branchTip đọc mã của refs/heads/<nhánh>; rỗng khi nhánh không còn.
func (e Env) branchTip(ctx context.Context, dir, branch string) (string, error) {
	out, err := e.read(ctx, dir, "rev-parse", "--verify", "--quiet", "refs/heads/"+branch+"^{commit}")
	var ge *gitexec.GitError
	switch {
	case err == nil:
		return strings.TrimSpace(out), nil
	case ctx.Err() != nil:
		return "", ctx.Err()
	case errors.As(err, &ge) && !ge.Timeout:
		return "", nil
	}
	return "", err
}

// unregisterWorktree gỡ đăng ký worktree mất thư mục, gọi trong khoá repo. Cùng cách removeLocalWorktree của runner:
// chỉ xoá đúng <commonDir>/worktrees/<tên> có gitdir trỏ về đường dẫn đó, không `git worktree prune` cả repo vì prune
// xoá luôn worktree khác đang nằm trên ổ chưa gắn. Không xoá file nào của worktree.
func (e Env) unregisterWorktree(ctx context.Context, dir, path string) *Error {
	if s := pathState(path); s != StateMissing {
		return &Error{Code: BlockUnreachable, Message: "Thư mục worktree đã có lại hoặc không truy cập được; không gỡ đăng ký."}
	}
	out, err := e.read(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return gitFailure(err)
	}
	root := filepath.Join(filepath.Clean(filepath.FromSlash(strings.TrimSpace(out))), "worktrees")
	entries, err := os.ReadDir(root)
	if err != nil {
		return &Error{Code: CodeGit, Message: "Không đọc được đăng ký worktree.", Detail: err.Error()}
	}
	for _, d := range entries {
		meta := filepath.Join(root, d.Name())
		if !d.IsDir() || filepath.Base(filepath.Dir(meta)) != "worktrees" {
			continue
		}
		back, err := os.ReadFile(filepath.Join(meta, "gitdir"))
		if err != nil || !repolock.SamePath(filepath.Dir(filepath.FromSlash(strings.TrimSpace(string(back)))), path) {
			continue
		}
		if err := os.RemoveAll(meta); err != nil {
			return &Error{Code: CodeGit, Message: "Không gỡ được đăng ký worktree.", Detail: err.Error()}
		}
		return nil
	}
	return &Error{Code: CodeNotFound, Message: "Không tìm thấy đăng ký của worktree.", Path: path}
}
