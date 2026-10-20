package branches

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// scanAll chạy Scan, trả các sự kiện theo thứ tự in.
func scanAll(t testing.TB, ctx context.Context, env Env, o ScanOptions) []Event {
	t.Helper()
	var mu sync.Mutex
	var events []Event
	Scan(ctx, env, o, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, ev)
	})
	return events
}

// scanOne quét một repo, trả sự kiện repo.
func scanOne(t testing.TB, env Env, folder string, noFetch bool) ScanRepo {
	t.Helper()
	for _, ev := range scanAll(t, context.Background(), env, ScanOptions{Folders: []string{folder}, NoFetch: noFetch}) {
		if ev.Type == EventRepo {
			return *ev.Repo
		}
	}
	t.Fatal("không có sự kiện repo")
	return ScanRepo{}
}

// byBranch gom ứng viên và mục bị chặn theo tên nhánh.
func byBranch(r ScanRepo) (cands, blocked map[string]Candidate) {
	cands, blocked = map[string]Candidate{}, map[string]Candidate{}
	for _, c := range r.Candidates {
		cands[c.Branch] = c
	}
	for _, c := range r.Blocked {
		blocked[c.Branch] = c
	}
	return cands, blocked
}

func blockCode(t *testing.T, blocked map[string]Candidate, name string) *BlockReason {
	t.Helper()
	c, ok := blocked[name]
	if !ok || c.Blocked == nil {
		t.Fatalf("%s phải bị chặn: %+v", name, c)
	}
	return c.Blocked
}

// us4Repo dựng repo của Independent Test US4 (spec.md); trả thư mục chính và thư mục chứa worktree.
func us4Repo(t *testing.T) (folder, wts string) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	writeFile(t, seed, ".gitignore", ".env\nnode_modules/\n")
	commit(t, seed, "ignore")
	gitT(t, seed, "push", "-q", "origin", "main")
	gitT(t, folder, "pull", "-q", "--ff-only")

	for _, n := range []string{"ai/A", "ai/D", "ai/E", "ai/F", "ai/G", "ai/H", "feature/x"} {
		mergeNoFF(t, folder, n)
	}
	gitT(t, folder, "push", "-q", "origin", "main")

	gitT(t, folder, "switch", "-q", "-c", "ai/B", "main")
	commit(t, folder, "B")
	gitT(t, folder, "switch", "-q", "-c", "ai/I", "main")
	commit(t, folder, "I1")
	// Tag cùng tên đã đẩy: tên ngắn ai/I trỏ vào tag này, đỉnh nhánh vẫn có commit chưa đẩy (FR-021).
	gitT(t, folder, "tag", "ai/I")
	gitT(t, folder, "push", "-q", "origin", "refs/tags/ai/I")
	commit(t, folder, "I2")
	gitT(t, folder, "switch", "-q", "main")
	gitT(t, folder, "branch", "ai/C", "main")

	wts = filepath.Join(filepath.Dir(folder), "wt")
	for _, n := range []string{"A", "D", "E", "G", "H"} {
		gitT(t, folder, "worktree", "add", "-q", filepath.Join(wts, n), "ai/"+n)
	}
	writeFile(t, filepath.Join(wts, "D"), "ghi-chu.txt", "chưa add\n")
	gitT(t, folder, "worktree", "lock", "--reason", "đang thử", filepath.Join(wts, "E"))
	writeFile(t, filepath.Join(wts, "G"), ".env", "KEY=1\n")
	writeFile(t, filepath.Join(wts, "H"), "node_modules/x/index.js", "x\n")
	writeFile(t, filepath.Join(wts, "H"), "apps/web/node_modules/y/index.js", "y\n")
	gitT(t, folder, "switch", "-q", "ai/F")
	return folder, wts
}

func TestScanUS4(t *testing.T) {
	folder, wts := us4Repo(t)
	env := testEnv(t)
	r := scanOne(t, env, folder, false)
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	if r.DefaultBranch != "main" || r.Current != "ai/F" || !slices.Equal(r.Fetched, []string{"origin"}) || len(r.FetchFailed) != 0 {
		t.Fatalf("repo: %+v", r)
	}
	cands, blocked := byBranch(r)
	if len(cands) != 2 || len(blocked) != 7 {
		t.Fatalf("ứng viên %v, chặn %v", cands, blocked)
	}

	a := cands["ai/A"]
	if !a.Selected || a.Evidence != (Evidence{Kind: EvidenceMergedGit, Onto: "origin/main"}) || a.Worktree == nil ||
		!repolock.SamePath(a.Worktree.Path, filepath.Join(wts, "A")) || a.Worktree.Prunable || a.Worktree.AgentWorktree ||
		a.Worktree.Ignored != nil || a.Tip == "" || a.CommittedAt == 0 || a.Subject != "ai/A" {
		t.Fatalf("ai/A: %+v %+v", a, a.Worktree)
	}
	h := cands["ai/H"]
	if !h.Selected || h.Worktree == nil || !slices.Contains(h.Worktree.Ignored, "node_modules/") ||
		!slices.Contains(h.Worktree.Ignored, "apps/web/node_modules/") {
		t.Fatalf("ai/H phải nhận apps/web/node_modules: %+v %+v", h, h.Worktree)
	}

	if b := blockCode(t, blocked, "ai/B"); b.Code != BlockUnpushed || b.Count != 1 {
		t.Fatalf("ai/B: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/C"); b.Code != BlockNoEvidence || blocked["ai/C"].Evidence.Note != NoteNoOwnCommits {
		t.Fatalf("ai/C: %+v %+v", b, blocked["ai/C"].Evidence)
	}
	if b := blockCode(t, blocked, "ai/D"); b.Code != BlockUntracked || !slices.Equal(b.Files, []string{"ghi-chu.txt"}) || b.FilesTotal != 1 {
		t.Fatalf("ai/D: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/E"); b.Code != BlockLocked || b.Message != "Worktree đang bị khoá: đang thử" {
		t.Fatalf("ai/E: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/F"); b.Code != BlockCurrent || blocked["ai/F"].Worktree != nil {
		t.Fatalf("ai/F: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/G"); b.Code != BlockIgnored || !slices.Equal(b.Files, []string{".env"}) {
		t.Fatalf("ai/G: %+v", b)
	}
	// Đếm theo đỉnh của refs/heads/ai/I: cả commit của tag lẫn commit sau đều không nằm trên ref remote nào.
	if b := blockCode(t, blocked, "ai/I"); b.Code != BlockUnpushed || b.Count != 2 {
		t.Fatalf("ai/I: %+v", b)
	}
	for _, c := range r.Blocked {
		if c.Selected {
			t.Fatalf("mục bị chặn không được chọn: %+v", c)
		}
	}
	if _, ok := cands["feature/x"]; ok {
		t.Fatal("feature/x không khớp mẫu")
	}
	if _, ok := blocked["feature/x"]; ok {
		t.Fatal("feature/x không khớp mẫu")
	}
	if r.SuggestDefault == nil || *r.SuggestDefault != (SuggestDefault{Branch: "main", Clean: true}) {
		t.Fatalf("gợi ý: %+v", r.SuggestDefault)
	}
}

func TestScanEvents(t *testing.T) {
	folder, _ := us4Repo(t)
	missing := filepath.Join(t.TempDir(), "mất")
	events := scanAll(t, context.Background(), testEnv(t), ScanOptions{Folders: []string{folder, missing}})
	var steps []string
	repos := 0
	for i, ev := range events {
		switch ev.Type {
		case EventProgress:
			if ev.Folder != folder || ev.Total == nil || *ev.Total != 2 {
				t.Fatalf("progress: %+v", ev)
			}
			steps = append(steps, ev.Step)
		case EventRepo:
			repos++
			if intOf(ev.Done) != fmt.Sprint(repos) || ev.Repo.Folder != ev.Folder {
				t.Fatalf("repo %d: done %s, %+v", repos, intOf(ev.Done), ev)
			}
			if ev.Folder == missing && (ev.Repo.Error == nil || ev.Repo.Error.Code != CodeNotRepo) {
				t.Fatalf("thư mục mất: %+v", ev.Repo)
			}
		case EventDone:
			if i != len(events)-1 || intOf(ev.Done) != "2" || ev.Error != nil ||
				ev.Summary["candidates"] != 2 || ev.Summary["blocked"] != 7 || ev.Summary["failed"] != 1 {
				t.Fatalf("done: %+v %v", ev, ev.Summary)
			}
		}
	}
	if repos != 2 || !slices.Equal(steps, []string{StepFetch, StepRead, StepEvidence}) {
		t.Fatalf("%d repo, bước %v", repos, steps)
	}
}

func TestScanCancelled(t *testing.T) {
	isolateGit(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	folder := newRepo(t)
	events := scanAll(t, ctx, testEnv(t), ScanOptions{Folders: []string{folder, folder + "-2"}, NoFetch: true})
	repos := 0
	for _, ev := range events {
		if ev.Type == EventRepo {
			repos++
			if ev.Repo.Error == nil || ev.Repo.Error.Code != CodeCancelled {
				t.Fatalf("%+v", ev.Repo)
			}
		}
	}
	last := events[len(events)-1]
	if repos != 2 || last.Type != EventDone || last.Error == nil || last.Error.Code != CodeCancelled {
		t.Fatalf("%d repo, cuối %+v", repos, last)
	}
}

// mergedWorktree tạo nhánh name đã merge và đẩy, mở ở worktree path.
func mergedWorktree(t *testing.T, folder, name, path string) {
	t.Helper()
	mergeNoFF(t, folder, name)
	gitT(t, folder, "push", "-q", "origin", "main")
	gitT(t, folder, "worktree", "add", "-q", path, name)
}

func TestScanWorktreeBlocks(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	base := filepath.Dir(folder)
	data := filepath.Join(base, "data")
	mergedWorktree(t, folder, "ai/run", filepath.Join(data, "runs", "r1"))
	mergedWorktree(t, folder, "ai/busy", filepath.Join(base, "wt", "busy"))
	mergedWorktree(t, folder, "ai/dirty", filepath.Join(base, "wt", "dirty"))
	mergedWorktree(t, folder, "ai/gone", filepath.Join(base, "wt", "gone"))
	mergedWorktree(t, folder, "claude/agent", filepath.Join(folder, ".claude", "worktrees", "agent"))
	writeFile(t, filepath.Join(base, "wt", "dirty"), "log.txt", "đổi\n")
	if err := os.RemoveAll(filepath.Join(base, "wt", "gone")); err != nil {
		t.Fatal(err)
	}

	env := testEnv(t)
	env.DataDir = data
	env.Busy = func() []BusyDir {
		return []BusyDir{{Path: filepath.Join(base, "wt", "busy", "src"), Kind: BusyTerminal}, {Path: folder, Kind: BusyAgent}}
	}
	r := scanOne(t, env, folder, true)
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	cands, blocked := byBranch(r)
	if b := blockCode(t, blocked, "ai/run"); b.Code != BlockHiveWorker {
		t.Fatalf("ai/run: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/busy"); b.Code != BlockBusy || len(b.Busy) != 1 || b.Busy[0].Kind != BusyTerminal {
		t.Fatalf("ai/busy: %+v", b)
	}
	if b := blockCode(t, blocked, "ai/dirty"); b.Code != BlockDirty || !slices.Equal(b.Files, []string{"log.txt"}) {
		t.Fatalf("ai/dirty: %+v", b)
	}
	// Thư mục mất: chỉ gỡ đăng ký, không chọn sẵn (plan.md mục 6).
	gone := cands["ai/gone"]
	if gone.Worktree == nil || !gone.Worktree.Prunable || gone.Selected {
		t.Fatalf("ai/gone: %+v %+v", gone, gone.Worktree)
	}
	// Agent ở thư mục chính không chặn worktree trong .claude/worktrees/ (đường dẫn dài nhất thắng).
	agent := cands["claude/agent"]
	if agent.Worktree == nil || !agent.Worktree.AgentWorktree || !agent.Selected {
		t.Fatalf("claude/agent: %+v %+v", agent, agent.Worktree)
	}
}

func TestScanBranchWithoutWorktree(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	mergeNoFF(t, folder, "ai/a")
	gitT(t, folder, "push", "-q", "origin", "main")
	r := scanOne(t, testEnv(t), folder, true)
	cands, _ := byBranch(r)
	if a := cands["ai/a"]; !a.Selected || a.Worktree != nil || r.SuggestDefault != nil {
		t.Fatalf("%+v", r)
	}
}

func TestScanFetchOneRemoteFails(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	mergeNoFF(t, folder, "ai/a")
	gitT(t, folder, "push", "-q", "origin", "main")
	gitT(t, folder, "switch", "-q", "-c", "ai/open", "main")
	commit(t, folder, "open")
	gitT(t, folder, "push", "-q", "origin", "ai/open")
	gitT(t, folder, "switch", "-q", "main")
	gitT(t, folder, "remote", "add", "broken", filepath.Join(t.TempDir(), "không-có.git"))

	r := scanOne(t, testEnv(t), folder, false)
	if r.Error != nil || !slices.Equal(r.Fetched, []string{"origin"}) || len(r.FetchFailed) != 1 || r.FetchFailed[0].Remote != "broken" {
		t.Fatalf("%+v", r)
	}
	cands, blocked := byBranch(r)
	// Đã vào nhánh mặc định thì fetch lỗi không đổi kết luận (FR-027).
	if !cands["ai/a"].Selected {
		t.Fatalf("ai/a: %+v", r)
	}
	if b := blockCode(t, blocked, "ai/open"); b.Code != BlockNoEvidence {
		t.Fatalf("ai/open: %+v", b)
	}
}

func TestScanAllFetchFailed(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	mergeNoFF(t, folder, "ai/a")
	gitT(t, folder, "push", "-q", "origin", "main")
	gitT(t, folder, "fetch", "-q")
	gitT(t, folder, "switch", "-q", "-c", "ai/b", "main")
	commit(t, folder, "b")
	gitT(t, folder, "switch", "-q", "main")
	gitT(t, folder, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "không-có.git"))

	r := scanOne(t, testEnv(t), folder, false)
	if r.Error != nil || len(r.Fetched) != 0 || len(r.FetchFailed) != 1 {
		t.Fatalf("%+v", r)
	}
	cands, blocked := byBranch(r)
	if !cands["ai/a"].Selected {
		t.Fatalf("ai/a: %+v", r)
	}
	if b := blockCode(t, blocked, "ai/b"); b.Code != BlockUnpushed || b.Count != 1 {
		t.Fatalf("ai/b: %+v", b)
	}
}

func TestScanNoDefaultBranch(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	mergeNoFF(t, folder, "ai/a")
	gitT(t, folder, "push", "-q", "origin", "main", "main:trunk")
	// Không còn origin/HEAD, origin/main, main local: không đoán được nhánh mặc định nên không có bằng chứng.
	gitT(t, folder, "remote", "set-head", "origin", "-d")
	gitT(t, folder, "switch", "-q", "--detach")
	gitT(t, folder, "branch", "-D", "main")
	gitT(t, folder, "update-ref", "-d", "refs/remotes/origin/main")
	r := scanOne(t, testEnv(t), folder, true)
	_, blocked := byBranch(r)
	if r.Error != nil || r.DefaultBranch != "" || r.SuggestDefault != nil {
		t.Fatalf("%+v", r)
	}
	if b := blockCode(t, blocked, "ai/a"); b.Code != BlockNoEvidence || blocked["ai/a"].Evidence.Note != NoteNoDefaultBranch {
		t.Fatalf("ai/a: %+v %+v", b, blocked["ai/a"].Evidence)
	}
}

func TestScanSettingsPatterns(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	mergeNoFF(t, folder, "ai/a")
	mergeNoFF(t, folder, "tmp/b")
	gitT(t, folder, "push", "-q", "origin", "main")
	env := testEnv(t)
	if _, err := SetSettings(env, &SettingsInput{Patterns: []string{"tmp/*"}, Rebuildable: DefaultRebuildable()}); err != nil {
		t.Fatal(err)
	}
	r := scanOne(t, env, folder, true)
	cands, blocked := byBranch(r)
	if len(cands) != 1 || !cands["tmp/b"].Selected || len(blocked) != 0 {
		t.Fatalf("%+v", r)
	}
}

// fakeRepos dựng n repo, mỗi repo 6 nhánh ai/* (3 đã merge có worktree, 3 chưa đẩy) cho SC-002.
func fakeRepos(b testing.TB, n int) []string {
	isolateGit(b)
	out := make([]string, n)
	for i := range n {
		_, _, folder := newRemote(b)
		for j := range 3 {
			name := fmt.Sprintf("ai/m%d", j)
			mergeNoFF(b, folder, name)
			gitT(b, folder, "worktree", "add", "-q", filepath.Join(filepath.Dir(folder), "wt", fmt.Sprint(j)), name)
		}
		gitT(b, folder, "push", "-q", "origin", "main")
		for j := range 3 {
			gitT(b, folder, "switch", "-q", "-c", fmt.Sprintf("ai/u%d", j), "main")
			commit(b, folder, fmt.Sprintf("u%d", j))
		}
		gitT(b, folder, "switch", "-q", "main")
		out[i] = folder
	}
	return out
}

// BenchmarkScanSC002 đo SC-002: quét 20 repo (có fetch remote cục bộ) ≤ 10 giây. Là benchmark như SC-001 vì số đo
// phụ thuộc tải của máy, không hợp làm test có ngưỡng trên CI. Chạy: go test ./internal/branches -run '^$' -bench SC002 -benchtime 3x.
func BenchmarkScanSC002(b *testing.B) {
	folders := fakeRepos(b, 20)
	env := testEnv(b)
	for b.Loop() {
		events := scanAll(b, context.Background(), env, ScanOptions{Folders: folders})
		if s := events[len(events)-1].Summary; s["candidates"] != 60 || s["failed"] != 0 {
			b.Fatalf("%v", s)
		}
	}
}
