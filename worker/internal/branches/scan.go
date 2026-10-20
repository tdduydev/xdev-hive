package branches

import (
	"context"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// Lý do chặn (BlockCode), theo thứ tự xét của plan.md mục 5 bước 5.
const (
	BlockHiveWorker     = "hiveWorker"
	BlockBusy           = "busy"
	BlockUnreachable    = "unreachable"
	BlockLocked         = "locked"
	BlockSubmodule      = "submodule"
	BlockDirty          = "dirty"
	BlockUntracked      = "untracked"
	BlockIgnored        = "ignored"
	BlockUnpushed       = "unpushed"
	BlockPROpen         = "prOpen"
	BlockCurrent        = "current"
	BlockCheckedOutMain = "checkedOutMain"
	BlockNoEvidence     = "noEvidence"
	BlockNeedsFetch     = "needsFetch"
)

// Bước của sự kiện progress khi quét (ngoài StepFetch).
const (
	StepRead     = "read"
	StepEvidence = "evidence"
	StepAPI      = "api"
)

type ScanOptions struct {
	Folders []string
	NoFetch bool
}

type ScanRepo struct {
	Folder         string          `json:"folder"`
	DefaultBranch  string          `json:"defaultBranch,omitempty"`
	Current        string          `json:"current,omitempty"`
	Fetched        []string        `json:"fetched"`
	FetchFailed    []FetchFailure  `json:"fetchFailed"`
	APIError       string          `json:"apiError,omitempty"`
	Candidates     []Candidate     `json:"candidates"`
	Blocked        []Candidate     `json:"blocked"`
	SuggestDefault *SuggestDefault `json:"suggestDefault,omitempty"`
	Error          *Error          `json:"error,omitempty"`
}

type SuggestDefault struct {
	Branch string `json:"branch"`
	Clean  bool   `json:"clean"`
}

type Candidate struct {
	Folder      string             `json:"folder"`
	Branch      string             `json:"branch"`
	Tip         string             `json:"tip"`
	CommittedAt int64              `json:"committedAt"`
	Subject     string             `json:"subject,omitempty"`
	Worktree    *CandidateWorktree `json:"worktree,omitempty"`
	Evidence    Evidence           `json:"evidence"`
	Selected    bool               `json:"selected"`
	Blocked     *BlockReason       `json:"blocked,omitempty"`
}

type CandidateWorktree struct {
	Path          string   `json:"path"`
	Prunable      bool     `json:"prunable"`
	AgentWorktree bool     `json:"agentWorktree"`
	Ignored       []string `json:"ignored,omitempty"`
}

type BlockReason struct {
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	Files      []string  `json:"files,omitempty"`
	FilesTotal int       `json:"filesTotal,omitempty"`
	Count      int       `json:"count,omitempty"`
	Busy       []BusyDir `json:"busy,omitempty"`
}

// newScanRepo có mọi mảng khác nil để JSON là [] như kiểu TypeScript.
func newScanRepo(folder string) ScanRepo {
	return ScanRepo{Folder: folder, Fetched: []string{}, FetchFailed: []FetchFailure{}, Candidates: []Candidate{}, Blocked: []Candidate{}}
}

// Scan là job `scan` (US4, FR-044): quét song song tối đa 4 repo, mỗi repo xong một sự kiện repo, cuối là done kèm số
// đếm. Repo chưa bắt đầu khi bị huỷ vẫn có sự kiện repo với lỗi cancelled để giao diện không chờ mãi.
func Scan(ctx context.Context, env Env, o ScanOptions, emit Emit) {
	total := len(o.Folders)
	var mu sync.Mutex
	done := 0
	summary := map[string]int{"candidates": 0, "blocked": 0, "failed": 0}
	api := env.loadAPI()
	parallel(total, readConcurrency, func(i int) {
		folder := o.Folders[i]
		progress := func(ev Event) {
			ev.Folder = folder
			mu.Lock()
			defer mu.Unlock()
			ev.Done, ev.Total = Count(done), Count(total)
			emit(ev)
		}
		r := newScanRepo(folder)
		if err := ctx.Err(); err != nil {
			r.Error = gitFailure(err)
		} else {
			r = env.scanRepo(ctx, folder, o.NoFetch, api, progress)
		}
		// In trong khoá: sự kiện repo phải đến theo thứ tự done tăng dần.
		mu.Lock()
		defer mu.Unlock()
		done++
		summary["candidates"] += len(r.Candidates)
		summary["blocked"] += len(r.Blocked)
		if r.Error != nil {
			summary["failed"]++
		}
		emit(Event{Type: EventRepo, Folder: folder, Repo: &r, Done: Count(done), Total: Count(total)})
	})
	ev := Event{Type: EventDone, Done: Count(done), Total: Count(total), Summary: summary}
	if err := ctx.Err(); err != nil {
		ev.Error = gitFailure(err)
	}
	emit(ev)
}

// scanItem là một nhánh khớp mẫu đang được xét.
type scanItem struct {
	branch BranchInfo
	wt     int // chỉ số trong RepoBranches.worktrees; -1 khi nhánh không mở ở đâu
	tree   tree
	op     string
	err    error
	ev     tipEvidence
	block  *BlockReason
	// prOpen là nhãn PR/MR mới nhất của nhánh khi nó đang mở (bước chặn 6), kể cả khi nhánh có bằng chứng git.
	prOpen string
	// apiNote là câu giải thích khi PR/MR có mà không dùng làm bằng chứng được.
	apiNote string
}

// scanRepo quét một repo theo plan.md mục 5: fetch, đọc như list, lọc theo mẫu, bằng chứng, rồi chặn theo thứ tự.
func (e Env) scanRepo(ctx context.Context, folder string, noFetch bool, api *apiSource, progress Emit) ScanRepo {
	r := newScanRepo(folder)
	if !isDir(folder) {
		r.Error = notRepo(folder)
		return r
	}
	fetchFailed := false
	if !noFetch {
		remotes, err := e.remotes(ctx, folder)
		if err != nil {
			r.Error = repoError(folder, err)
			return r
		}
		out, stop := e.fetchRemotes(ctx, folder, remotes, progress)
		r.Fetched, r.FetchFailed = out.Fetched, out.Failed
		if stop != nil {
			r.Error = stop
			return r
		}
		fetchFailed = len(out.Failed) > 0
	}

	// --timeout của job giới hạn một bước: fetch đã có giới hạn từng remote, phần đọc và xét của repo là một bước.
	if e.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, e.Timeout)
		defer cancel()
	}
	progress(Event{Type: EventProgress, Step: StepRead})
	l := List(ctx, e, folder)
	if l.Repo.Error != nil {
		r.Error = l.Repo.Error
		return r
	}
	repo := &l.Repo
	r.DefaultBranch = repo.DefaultBranch
	if !repo.Current.Detached {
		r.Current = repo.Current.Branch
	}

	// Nhánh mở ở nhiều worktree (git worktree add --force) thì giữ worktree đầu: thư mục chính đứng trước nên nhánh
	// đó bị chặn, không bị gỡ một nửa.
	wtOf := map[string]int{}
	for i, w := range repo.Worktrees {
		if _, ok := wtOf[w.Branch]; w.Branch != "" && !ok {
			wtOf[w.Branch] = i
		}
	}
	var items []*scanItem
	for _, b := range repo.Branches {
		if b.Kind != KindLocal || !b.MatchesPattern || b.IsDefault {
			continue
		}
		it := &scanItem{branch: b, wt: -1}
		if i, ok := wtOf[b.Name]; ok {
			it.wt = i
		}
		items = append(items, it)
	}

	// Chỉ đọc worktree của nhánh khớp mẫu, kèm file bị bỏ qua (Q15): repo máy dev có vài chục worktree không liên quan.
	parallel(len(items), readConcurrency, func(k int) {
		it := items[k]
		if it.wt < 0 || repo.Worktrees[it.wt].State != StatePending {
			return
		}
		it.tree, it.op, it.err = e.readTree(ctx, repo.Worktrees[it.wt].Path, true)
	})
	if err := ctx.Err(); err != nil {
		r.Error = gitFailure(err)
		return r
	}

	progress(Event{Type: EventProgress, Step: StepEvidence})
	tips := make([]string, len(items))
	for k, it := range items {
		tips[k] = it.branch.Tip
	}
	evs, err := e.gitEvidence(ctx, folder, repo.DefaultRef, tips)
	if err != nil {
		r.Error = gitFailure(err)
		return r
	}
	for _, it := range items {
		it.ev = evs[it.branch.Tip]
	}
	r.APIError = e.apiEvidence(ctx, api, folder, items, progress)
	if err := ctx.Err(); err != nil {
		r.Error = gitFailure(err)
		return r
	}

	busy := e.busy()
	for _, it := range items {
		it.block = blockWorktree(l, it, busy)
	}
	if err := e.countUnpushed(ctx, folder, items, noFetch, r.Fetched); err != nil {
		r.Error = gitFailure(err)
		return r
	}
	for _, it := range items {
		if it.block == nil && it.prOpen != "" {
			it.block = &BlockReason{Code: BlockPROpen, Message: it.prOpen + " của nhánh đang mở."}
		}
	}

	for _, it := range items {
		c := candidateOf(l, it)
		_, removable := linked(l, it)
		switch {
		case it.block == nil && it.branch.IsCurrent:
			it.block = &BlockReason{Code: BlockCurrent, Message: "Thư mục chính đang đứng ở nhánh này."}
		case it.block == nil && it.wt >= 0 && !removable:
			it.block = &BlockReason{Code: BlockCheckedOutMain, Message: "Nhánh đang mở ở thư mục chính của repo, không gỡ được."}
		case it.block == nil && it.ev.Kind == EvidenceNone:
			msg := it.apiNote
			if msg == "" {
				msg = noEvidenceText(it.ev.Note)
			}
			it.block = &BlockReason{Code: BlockNoEvidence, Message: msg}
		case it.block == nil && fetchFailed && !it.ev.inDefault:
			it.block = &BlockReason{Code: BlockNeedsFetch, Message: "Cần fetch được để kiểm."}
		}
		c.Blocked = it.block
		if it.block != nil {
			r.Blocked = append(r.Blocked, c)
			continue
		}
		// Chọn sẵn chỉ khi đã merge (Q11); worktree prunable chỉ gỡ đăng ký nên để người dùng tự chọn (plan.md mục 6).
		c.Selected = (c.Evidence.Kind == EvidenceMergedGit || c.Evidence.Kind == EvidenceMergedAPI) &&
			(c.Worktree == nil || !c.Worktree.Prunable)
		r.Candidates = append(r.Candidates, c)
	}

	for _, it := range items {
		if it.branch.IsCurrent && repo.DefaultBranch != "" &&
			(it.ev.Kind == EvidenceMergedGit || it.ev.Kind == EvidenceMergedAPI) {
			cur := repo.Current
			r.SuggestDefault = &SuggestDefault{Branch: repo.DefaultBranch, Clean: !cur.Dirty && !cur.Untracked && cur.Operation == ""}
		}
	}
	return r
}

// linked là worktree liên kết gỡ được của item: không phải thư mục đang quét, thư mục chính hay bare.
func linked(l *Listing, it *scanItem) (WorktreeInfo, bool) {
	if it.wt < 0 {
		return WorktreeInfo{}, false
	}
	w := l.Repo.Worktrees[it.wt]
	if w.IsMain || w.Bare || repolock.SamePath(w.Path, l.Repo.Folder) {
		return w, false
	}
	return w, true
}

// blockWorktree là bước chặn 1–4 (plan.md mục 5 bước 5) cho worktree của nhánh, dừng ở lý do đầu.
func blockWorktree(l *Listing, it *scanItem, busy []BusyDir) *BlockReason {
	w, ok := linked(l, it)
	if !ok {
		return nil
	}
	if l.underDataDir(w.Path) {
		return &BlockReason{Code: BlockHiveWorker, Message: "Worktree của worker Hive."}
	}
	if owned := busyOwned(l.paths, it.wt, busy); len(owned) > 0 {
		return &BlockReason{Code: BlockBusy, Message: "Đang có agent, terminal hoặc cửa sổ app mở trong worktree.", Busy: owned}
	}
	state := w.State
	if it.err != nil {
		// Đọc lỗi mà thư mục vẫn còn: không biết worktree có sạch không thì không được gỡ.
		if state = pathState(w.Path); state == "" {
			return &BlockReason{Code: BlockUnreachable, Message: "Không đọc được trạng thái worktree: " + gitFailure(it.err).text()}
		}
	}
	if state == StateUnreachable {
		return &BlockReason{Code: BlockUnreachable, Message: "Không truy cập được thư mục của worktree."}
	}
	if w.Locked {
		msg := "Worktree đang bị khoá (git worktree lock)."
		if w.LockReason != "" {
			msg = "Worktree đang bị khoá: " + w.LockReason
		}
		return &BlockReason{Code: BlockLocked, Message: msg}
	}
	if state == StateMissing {
		// Thư mục đã mất: không có file nào để mất, clean chỉ gỡ đăng ký.
		return nil
	}
	t := it.tree
	if t.submodule || hasSubmodule(w.Path) {
		return &BlockReason{Code: BlockSubmodule, Message: "Worktree có submodule."}
	}
	if it.op != "" {
		files, total := t.files()
		return &BlockReason{Code: BlockDirty, Message: "Worktree đang dở merge, rebase hoặc thao tác git khác.", Files: files, FilesTotal: total}
	}
	if len(t.tracked) > 0 {
		files, total := t.files()
		return &BlockReason{Code: BlockDirty, Message: fmt.Sprintf("Có %d file đã sửa chưa commit.", len(t.tracked)), Files: files, FilesTotal: total}
	}
	if len(t.untracked) > 0 {
		files, total := capList(t.untracked, maxFiles)
		return &BlockReason{Code: BlockUntracked, Message: fmt.Sprintf("Có %d file chưa theo dõi.", len(t.untracked)), Files: files, FilesTotal: total}
	}
	if blocking := IgnoredBlocking(t.ignored, l.rebuild); len(blocking) > 0 {
		files, total := capList(blocking, maxFiles)
		return &BlockReason{Code: BlockIgnored, Message: "Có file bị bỏ qua không dựng lại được.", Files: files, FilesTotal: total}
	}
	return nil
}

// countUnpushed là bước chặn 5 (FR-021) cho các nhánh chưa bị chặn. Đếm bằng mã đỉnh, không bằng tên: tag cùng
// tên đã đẩy không được làm nhánh trông như đã đẩy.
func (e Env) countUnpushed(ctx context.Context, dir string, items []*scanItem, noFetch bool, fetched []string) error {
	args := []string{"--remotes"}
	switch {
	case noFetch:
		// Hợp đồng mục 3.7: --no-fetch chỉ để đếm cho huy hiệu, dùng mọi ref remote có trên máy.
	case len(fetched) > 0:
		args = args[:0]
		for _, r := range fetched {
			args = append(args, "--remotes="+r)
		}
	}
	allFailed := !noFetch && len(fetched) == 0
	var mu sync.Mutex
	var firstErr error
	parallel(len(items), readConcurrency, func(k int) {
		it := items[k]
		if it.block != nil {
			return
		}
		// Fetch lỗi hết: ref remote có thể cũ, chỉ nhánh mặc định của origin được coi là đã đẩy (FR-027). Đỉnh ngoài
		// nhánh mặc định vẫn đếm theo ref cũ để báo unpushed khi chắc chắn; đếm ra 0 thì thành needsFetch ở sau.
		if allFailed && it.ev.inDefault {
			return
		}
		out, err := e.read(ctx, dir, append([]string{"rev-list", "--count", it.branch.Tip, "--not"}, args...)...)
		if err != nil {
			mu.Lock()
			if firstErr == nil {
				firstErr = err
			}
			mu.Unlock()
			return
		}
		if n, _ := strconv.Atoi(strings.TrimSpace(out)); n > 0 {
			it.block = &BlockReason{Code: BlockUnpushed, Message: fmt.Sprintf("Có %d commit chưa đẩy lên remote nào.", n), Count: n}
		}
	})
	return firstErr
}

func candidateOf(l *Listing, it *scanItem) Candidate {
	b := it.branch
	c := Candidate{Folder: l.Repo.Folder, Branch: b.Name, Tip: b.Tip, CommittedAt: b.CommittedAt, Subject: b.Subject, Evidence: it.ev.Evidence}
	w, ok := linked(l, it)
	if !ok {
		return c
	}
	cw := &CandidateWorktree{
		Path:          w.Path,
		Prunable:      w.Prunable || w.State == StateMissing,
		AgentWorktree: strings.Contains(filepath.ToSlash(w.Path), "/.claude/worktrees/"),
	}
	if it.err == nil {
		// File bị bỏ qua trong danh sách dựng lại được: git worktree remove xoá theo mà không hỏi, nên hiện ở xem trước.
		blocking := map[string]bool{}
		for _, p := range IgnoredBlocking(it.tree.ignored, l.rebuild) {
			blocking[p] = true
		}
		var lost []string
		for _, p := range it.tree.ignored {
			if !blocking[p] {
				lost = append(lost, p)
			}
		}
		cw.Ignored, _ = capList(lost, maxFiles)
	}
	c.Worktree = cw
	return c
}

func noEvidenceText(note string) string {
	switch note {
	case NoteNoOwnCommits:
		return "Chưa có commit riêng hoặc merge tiến nhanh."
	case NoteOlderThanWindow:
		return "Cũ hơn " + strconv.Itoa(firstParentWindow) + " commit của nhánh mặc định, không rõ đã merge chưa."
	case NoteNoDefaultBranch:
		return "Không xác định được nhánh mặc định."
	}
	return "Chưa vào nhánh mặc định."
}
