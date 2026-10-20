package branches

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

func gitT(t testing.TB, dir string, args ...string) string {
	t.Helper()
	out, err := gitTry(dir, args...)
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(out)
}

func gitTry(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

// isolateGit để test không đọc cấu hình git của người chạy test (hook, credential, autocrlf…).
func isolateGit(t testing.TB) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
}

func writeFile(t testing.TB, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func commit(t testing.TB, dir, msg string) {
	t.Helper()
	writeFile(t, dir, "log.txt", msg+"\n")
	gitT(t, dir, "add", "-A")
	gitT(t, dir, "commit", "-qm", msg)
}

// newRepo là repo không remote, một commit trên main.
func newRepo(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "repo")
	gitT(t, "", "init", "-q", "-b", "main", dir)
	writeFile(t, dir, "README.md", "hello\n")
	gitT(t, dir, "add", "-A")
	gitT(t, dir, "commit", "-qm", "init")
	return dir
}

// newRemote tạo bare remote cục bộ, bản seed để đẩy commit "từ người khác", và thư mục chính đã clone (có origin/HEAD).
func newRemote(t testing.TB) (bare, seed, folder string) {
	t.Helper()
	base := t.TempDir()
	bare = filepath.Join(base, "remote.git")
	gitT(t, "", "init", "-q", "--bare", "-b", "main", bare)
	seed = filepath.Join(base, "seed")
	gitT(t, "", "clone", "-q", bare, seed)
	gitT(t, seed, "switch", "-q", "-c", "main")
	commit(t, seed, "init")
	gitT(t, seed, "push", "-q", "origin", "main")
	folder = filepath.Join(base, "shop")
	gitT(t, "", "clone", "-q", bare, folder)
	return bare, seed, folder
}

func testEnv(t testing.TB) Env {
	return Env{Git: gitexec.Git{MachineCredentials: true}, DataDir: filepath.Join(t.TempDir(), "data"), ConfigDir: t.TempDir()}
}

func findBranch(t testing.TB, r RepoBranches, name string) BranchInfo {
	t.Helper()
	for _, b := range r.Branches {
		if b.Name == name {
			return b
		}
	}
	t.Fatalf("không có nhánh %q trong %+v", name, r.Branches)
	return BranchInfo{}
}

func intOf(p *int) string {
	if p == nil {
		return "nil"
	}
	return fmt.Sprint(*p)
}

// listAll chạy List rồi Fill, trả dòng kết quả và các sự kiện worktree theo tên thư mục.
func listAll(t testing.TB, ctx context.Context, env Env, folder string) (RepoBranches, map[string]WorktreeInfo, int) {
	t.Helper()
	l := List(ctx, env, folder)
	var mu sync.Mutex
	events := map[string]WorktreeInfo{}
	dones := 0
	l.Fill(ctx, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		switch ev.Type {
		case EventWorktree:
			events[filepath.Base(ev.Worktree.Path)] = *ev.Worktree
		case EventDone:
			dones++
		}
	})
	return l.Repo, events, dones
}

func TestListAheadBehind(t *testing.T) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	gitT(t, folder, "switch", "-q", "-c", "ai/x")
	commit(t, folder, "x1")
	commit(t, folder, "x2")
	gitT(t, folder, "push", "-q", "-u", "origin", "ai/x")
	commit(t, folder, "x3")
	gitT(t, folder, "switch", "-q", "main")
	for i := range 3 {
		commit(t, seed, fmt.Sprintf("main %d", i))
	}
	gitT(t, seed, "push", "-q", "origin", "main")
	gitT(t, folder, "fetch", "-q")

	r, _, _ := listAll(t, context.Background(), testEnv(t), folder)
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	if r.DefaultBranch != "main" || r.DefaultRef != "refs/remotes/origin/main" || r.SlowPath {
		t.Fatalf("nhánh mặc định: %q %q slow=%v", r.DefaultBranch, r.DefaultRef, r.SlowPath)
	}
	main := findBranch(t, r, "main")
	if !main.IsCurrent || !main.IsDefault || main.Upstream != "origin/main" || intOf(main.BehindUpstream) != "3" ||
		intOf(main.AheadUpstream) != "0" || intOf(main.BehindDefault) != "3" {
		t.Fatalf("main: %+v up=%s/%s", main, intOf(main.AheadUpstream), intOf(main.BehindUpstream))
	}
	x := findBranch(t, r, "ai/x")
	if !x.MatchesPattern || x.IsCurrent || intOf(x.AheadUpstream) != "1" || intOf(x.BehindUpstream) != "0" ||
		intOf(x.AheadDefault) != "3" || intOf(x.BehindDefault) != "3" || intOf(x.Unpushed) != "1" {
		t.Fatalf("ai/x: up=%s/%s default=%s/%s unpushed=%s", intOf(x.AheadUpstream), intOf(x.BehindUpstream),
			intOf(x.AheadDefault), intOf(x.BehindDefault), intOf(x.Unpushed))
	}
	if x.Subject != "x3" || x.CommittedAt == 0 || len(x.Tip) != 40 {
		t.Fatalf("ai/x thiếu đỉnh: %+v", x)
	}
	// Đã có local cùng tên thì không hiện bản remote.
	for _, b := range r.Branches {
		if b.Name == "origin/ai/x" || b.Name == "origin/main" || b.Name == "origin/HEAD" {
			t.Fatalf("không được hiện %q", b.Name)
		}
	}
	if r.Current.Branch != "main" || intOf(r.Current.Behind) != "3" || r.Current.Upstream != "origin/main" {
		t.Fatalf("current: %+v", r.Current)
	}
	if len(r.Remotes) != 1 || r.Remotes[0] != "origin" || len(r.Patterns) != 2 {
		t.Fatalf("remotes, patterns: %q %q", r.Remotes, r.Patterns)
	}
}

func TestListUpstreamGone(t *testing.T) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	gitT(t, folder, "switch", "-q", "-c", "ai/gone")
	commit(t, folder, "g")
	gitT(t, folder, "push", "-q", "-u", "origin", "ai/gone")
	gitT(t, seed, "push", "-q", "origin", "--delete", "ai/gone")
	gitT(t, folder, "fetch", "-q", "--prune")

	r, _, _ := listAll(t, context.Background(), testEnv(t), folder)
	g := findBranch(t, r, "ai/gone")
	if !g.UpstreamGone || g.Upstream != "origin/ai/gone" || g.AheadUpstream != nil || !g.IsCurrent {
		t.Fatalf("upstream đã xoá: %+v", g)
	}
	if !r.Current.UpstreamGone || r.Current.Ahead != nil {
		t.Fatalf("current upstream đã xoá: %+v", r.Current)
	}
}

func TestListRemoteOnlyBranch(t *testing.T) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	gitT(t, seed, "switch", "-q", "-c", "feature/r")
	commit(t, seed, "r")
	gitT(t, seed, "push", "-q", "origin", "feature/r")
	gitT(t, seed, "switch", "-q", "-c", "claude/c")
	gitT(t, seed, "push", "-q", "origin", "claude/c")
	gitT(t, folder, "fetch", "-q")

	r, _, _ := listAll(t, context.Background(), testEnv(t), folder)
	f := findBranch(t, r, "origin/feature/r")
	if f.Kind != KindRemote || f.Remote != "origin" || f.Ref != "refs/remotes/origin/feature/r" || f.MatchesPattern ||
		intOf(f.AheadDefault) != "1" || f.Unpushed != nil {
		t.Fatalf("nhánh chỉ có trên remote: %+v", f)
	}
	if c := findBranch(t, r, "origin/claude/c"); !c.MatchesPattern {
		t.Fatalf("mẫu so trên tên sau remote: %+v", c)
	}
	if last := r.Branches[len(r.Branches)-1]; last.Kind != KindRemote || r.Branches[0].Kind != KindLocal {
		t.Fatal("nhánh local phải đứng trước nhánh remote")
	}
}

func TestListDefaultWithoutOriginHEAD(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	gitT(t, folder, "remote", "set-head", "origin", "-d")
	r, _, _ := listAll(t, context.Background(), testEnv(t), folder)
	if r.DefaultBranch != "main" || r.DefaultRef != "refs/remotes/origin/main" {
		t.Fatalf("không có origin/HEAD phải lùi về origin/main: %q %q", r.DefaultBranch, r.DefaultRef)
	}

	// Không có origin: không có nhánh mặc định, không có ahead/behind so với nó.
	plain := newRepo(t)
	r, _, _ = listAll(t, context.Background(), testEnv(t), plain)
	if r.Error != nil || r.DefaultBranch != "" || r.SlowPath || len(r.Remotes) != 0 {
		t.Fatalf("repo không remote: %+v", r)
	}
	if m := findBranch(t, r, "main"); m.AheadDefault != nil || m.IsDefault {
		t.Fatalf("không có nhánh mặc định: %+v", m)
	}
}

func TestListWorktrees(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	env := testEnv(t)
	wtBase := filepath.Join(filepath.Dir(folder), "shop-wt")
	add := func(name string) string {
		p := filepath.Join(wtBase, name)
		gitT(t, folder, "worktree", "add", "-q", "-b", "ai/"+name, p)
		return p
	}
	locked := add("locked")
	gitT(t, folder, "worktree", "lock", "--reason", "ổ ngoài", locked)
	missing := add("missing")
	if err := os.RemoveAll(missing); err != nil {
		t.Fatal(err)
	}
	dirty := add("dirty")
	writeFile(t, dirty, "log.txt", "đổi\n")
	writeFile(t, dirty, ".env", "X=1\n")
	writeFile(t, dirty, ".gitignore", ".env\nnode_modules/\n")
	writeFile(t, dirty, "node_modules/a.js", "x\n")
	clean := add("clean")
	run := filepath.Join(env.DataDir, "runs", "r1")
	gitT(t, folder, "worktree", "add", "-q", "-b", "ai/HIVE-1", run)
	env.Busy = func() []BusyDir {
		return []BusyDir{{Path: filepath.Join(clean, "src"), Kind: BusyAgent}, {Path: folder, Kind: BusyTerminal}}
	}
	writeFile(t, folder, "new.txt", "x\n")

	r, events, dones := listAll(t, context.Background(), env, folder)
	if r.Error != nil || dones != 1 {
		t.Fatalf("lỗi %v, done %d", r.Error, dones)
	}
	if len(r.Worktrees) != 6 {
		t.Fatalf("muốn 6 worktree: %+v", r.Worktrees)
	}
	wt := map[string]WorktreeInfo{}
	for _, w := range r.Worktrees {
		wt[filepath.Base(w.Path)] = w
	}
	if m := r.Worktrees[0]; !m.IsMain || m.State != StateUntracked || m.Busy != BusyTerminal || !repolock.SamePath(m.Path, folder) {
		t.Fatalf("thư mục chính: %+v", m)
	}
	if w := wt["r1"]; w.State != StateSkipped || w.Busy != BusyHiveWorker {
		t.Fatalf("worktree dưới DataDir: %+v", w)
	}
	if w := wt["missing"]; w.State != StateMissing {
		t.Fatalf("worktree mất thư mục: %+v", w)
	}
	for _, name := range []string{"locked", "dirty", "clean"} {
		if wt[name].State != StatePending {
			t.Fatalf("%s phải chờ Fill: %+v", name, wt[name])
		}
	}
	if len(events) != 3 {
		t.Fatalf("muốn 3 sự kiện worktree: %+v", events)
	}
	if w := events["locked"]; !w.Locked || w.LockReason != "ổ ngoài" || w.State != StateClean || w.Branch != "ai/locked" {
		t.Fatalf("worktree khoá: %+v", w)
	}
	w := events["dirty"]
	if w.State != StateDirty || w.FilesTotal != 2 || len(w.IgnoredBlocking) != 1 || w.IgnoredBlocking[0] != ".env" {
		t.Fatalf("worktree bẩn: %+v", w)
	}
	if w := events["clean"]; w.State != StateClean || w.Busy != BusyAgent {
		t.Fatalf("worktree sạch có agent: %+v", w)
	}
	if b := findBranch(t, r, "ai/dirty"); !repolock.SamePath(b.WorktreePath, dirty) {
		t.Fatalf("worktreePath: %+v", b)
	}
}

// Trường submodule là submodule đã init (hợp đồng mục 2.2), như cờ chặn của scan; chỉ có .gitmodules thì false.
func TestListSubmodule(t *testing.T) {
	isolateGit(t)
	folder := newRepo(t)
	addSubmodule(t, folder)
	wtBase := filepath.Join(filepath.Dir(folder), "wt")
	gitT(t, folder, "worktree", "add", "-q", "-b", "ai/plain", filepath.Join(wtBase, "plain"))
	gitT(t, folder, "worktree", "add", "-q", "-b", "ai/init", filepath.Join(wtBase, "init"))
	gitFile(t, filepath.Join(wtBase, "init"), "submodule", "update", "-q", "--init")

	r, events, _ := listAll(t, context.Background(), testEnv(t), folder)
	if r.Error != nil || len(events) != 2 {
		t.Fatalf("lỗi %v, sự kiện %+v", r.Error, events)
	}
	if !r.Worktrees[0].Submodule {
		t.Fatalf("thư mục chính có submodule đã clone: %+v", r.Worktrees[0])
	}
	if w := events["plain"]; w.Submodule || w.State != StateClean {
		t.Fatalf("submodule chưa init: %+v", w)
	}
	if w := events["init"]; !w.Submodule || w.State != StateClean {
		t.Fatalf("submodule đã init: %+v", w)
	}
}

// Huỷ trong lúc đọc: worktree chưa xong có state error "Đã huỷ", vẫn có done.
func TestListCancelMarksPending(t *testing.T) {
	isolateGit(t)
	_, _, folder := newRemote(t)
	gitT(t, folder, "worktree", "add", "-q", "-b", "ai/a", filepath.Join(filepath.Dir(folder), "a"))
	ctx, cancel := context.WithCancel(context.Background())
	l := List(ctx, testEnv(t), folder)
	cancel()
	var got []Event
	l.Fill(ctx, func(ev Event) { got = append(got, ev) })
	if len(got) != 2 || got[0].Worktree.State != StateError || got[0].Worktree.Error != "Đã huỷ" || got[1].Type != EventDone {
		t.Fatalf("sự kiện sau huỷ: %+v", got)
	}
}

// git < 2.41 không có %(ahead-behind): rev-list cho nhánh khớp mẫu phải ra cùng số.
func TestListSlowPathMatchesFast(t *testing.T) {
	isolateGit(t)
	_, seed, folder := newRemote(t)
	gitT(t, folder, "switch", "-q", "-c", "ai/s")
	commit(t, folder, "s1")
	commit(t, folder, "s2")
	gitT(t, folder, "switch", "-q", "main")
	commit(t, seed, "m")
	gitT(t, seed, "push", "-q", "origin", "main")
	gitT(t, folder, "fetch", "-q")
	env := testEnv(t)
	fast := List(context.Background(), env, folder)
	want := findBranch(t, fast.Repo, "ai/s")

	slow := List(context.Background(), env, folder)
	slow.Repo.SlowPath = true
	for i := range slow.Repo.Branches {
		slow.Repo.Branches[i].AheadDefault, slow.Repo.Branches[i].BehindDefault = nil, nil
	}
	slow.fillCounts(context.Background(), gitT(t, folder, "rev-parse", "refs/remotes/origin/main"))
	got := findBranch(t, slow.Repo, "ai/s")
	if intOf(got.AheadDefault) != intOf(want.AheadDefault) || intOf(got.BehindDefault) != intOf(want.BehindDefault) ||
		intOf(got.AheadDefault) != "2" || intOf(got.BehindDefault) != "1" {
		t.Fatalf("slow %s/%s, fast %s/%s", intOf(got.AheadDefault), intOf(got.BehindDefault),
			intOf(want.AheadDefault), intOf(want.BehindDefault))
	}
	// Đường chậm chỉ đếm nhánh khớp mẫu.
	if m := findBranch(t, slow.Repo, "main"); m.AheadDefault != nil {
		t.Fatalf("main không khớp mẫu không được đếm: %+v", m)
	}
}

func TestVersionAtLeast(t *testing.T) {
	cases := map[string]bool{
		"2.41.0": true, "2.54.0": true, "2.40.1": false, "2.39.3 (Apple Git-146)": false, "2.45.1.windows.1": true,
		"3.0": true, "1.9.9": false, "lạ": true,
	}
	for v, want := range cases {
		if got := versionAtLeast(v, 2, 41); got != want {
			t.Fatalf("%q: %v", v, got)
		}
	}
}

func TestSplitRemoteLongest(t *testing.T) {
	rem, name := splitRemote("team/a/feature/x", []string{"team", "team/a"})
	if rem != "team/a" || name != "feature/x" {
		t.Fatalf("%q %q", rem, name)
	}
	if rem, name := splitRemote("gone/x", nil); rem != "gone" || name != "x" {
		t.Fatalf("%q %q", rem, name)
	}
}

func TestListAndStatusNotRepo(t *testing.T) {
	isolateGit(t)
	plain := t.TempDir()
	missing := filepath.Join(plain, "gone")
	for _, dir := range []string{plain, missing} {
		r, events, dones := listAll(t, context.Background(), testEnv(t), dir)
		if r.Error == nil || r.Error.Code != CodeNotRepo || r.Error.Path != dir || len(events) != 0 || dones != 1 {
			t.Fatalf("%s: %+v", dir, r.Error)
		}
		if r.Branches == nil || r.Worktrees == nil || r.Remotes == nil {
			t.Fatal("mảng phải khác nil")
		}
	}
	repo := newRepo(t)
	writeFile(t, repo, "README.md", "đổi\n")
	got := Status(context.Background(), testEnv(t), []string{repo, missing})
	if got[0].Error != nil || !got[0].Dirty || got[0].Branch != "main" || got[0].Ahead != nil {
		t.Fatalf("status repo: %+v", got[0])
	}
	if got[1].Error == nil || got[1].Error.Code != CodeNotRepo || got[1].Folder != missing {
		t.Fatalf("status thư mục mất: %+v", got[1])
	}
}

// Merge người dùng tự chạy ngoài app rồi bỏ dở: list báo operation, headBefore đọc từ ORIG_HEAD.
func TestListOperationLeftByUser(t *testing.T) {
	_, folder := switchRepo(t)
	commit(t, folder, "main side")
	mainTip := headOf(t, folder)
	if _, err := gitTry(folder, "merge", "--no-edit", "feature"); err == nil {
		t.Fatal("merge phải xung đột")
	}
	env := testEnv(t)
	r, _, _ := listAll(t, context.Background(), env, folder)
	o := r.Operation
	if o == nil || o.Kind != OpMerge || o.State != OperationConflict || o.Branch != "main" || o.HeadBefore != mainTip ||
		o.ConflictsTotal != 1 || o.Conflicts[0] != "log.txt" || o.Onto != nil || r.Current.Operation != OpMerge {
		t.Fatalf("operation = %+v", o)
	}

	writeFile(t, folder, "log.txt", "resolved\n")
	gitT(t, folder, "add", "log.txt")
	r, _, _ = listAll(t, context.Background(), env, folder)
	if o := r.Operation; o == nil || o.State != OperationInProgress || o.ConflictsTotal != 0 || o.Conflicts == nil {
		t.Fatalf("đã add hết: operation = %+v", o)
	}

	gitT(t, folder, "merge", "--abort")
	if r, _, _ = listAll(t, context.Background(), env, folder); r.Operation != nil {
		t.Fatalf("hết dở mà vẫn có operation: %+v", r.Operation)
	}
}

// bigRepo dựng repo của SC-001: 200 nhánh (100 local ai/*, 100 chỉ trên remote) và 30 worktree liên kết.
func bigRepo(b testing.TB) string {
	isolateGit(b)
	_, seed, folder := newRemote(b)
	commit(b, seed, "base")
	gitT(b, seed, "push", "-q", "origin", "main")
	gitT(b, folder, "fetch", "-q")
	tip := gitT(b, folder, "rev-parse", "refs/remotes/origin/main")
	// fast-import một lần thay 200 lần commit: dựng repo nhanh để đo đúng phần list.
	var stream strings.Builder
	for i := range 200 {
		ref := fmt.Sprintf("refs/heads/ai/b-%03d", i)
		if i >= 100 {
			ref = fmt.Sprintf("refs/remotes/origin/feature/f-%03d", i)
		}
		msg := fmt.Sprintf("commit %d", i)
		fmt.Fprintf(&stream, "commit %s\ncommitter Test <test@example.com> %d +0000\ndata %d\n%s\nfrom %s\n\n",
			ref, 1_700_000_000+i, len(msg), msg, tip)
	}
	cmd := exec.Command("git", "fast-import", "--quiet")
	cmd.Dir = folder
	cmd.Stdin = strings.NewReader(stream.String())
	if out, err := cmd.CombinedOutput(); err != nil {
		b.Fatalf("fast-import: %v\n%s", err, out)
	}
	for i := range 30 {
		p := filepath.Join(filepath.Dir(folder), "wt", fmt.Sprintf("w%02d", i))
		gitT(b, folder, "worktree", "add", "-q", p, fmt.Sprintf("ai/b-%03d", i))
		if i%3 == 0 {
			writeFile(b, p, "log.txt", "đổi\n")
		}
	}
	return folder
}

// BenchmarkListSC001 đo SC-001: list (dòng kết quả và mọi sự kiện worktree) của repo 30 worktree, 200 nhánh ≤ 2 giây.
// Chạy: go test ./internal/branches -run '^$' -bench SC001 -benchtime 5x.
func BenchmarkListSC001(b *testing.B) {
	folder := bigRepo(b)
	env := testEnv(b)
	for b.Loop() {
		r, events, _ := listAll(b, context.Background(), env, folder)
		if r.Error != nil || len(r.Branches) != 201 || len(events) != 30 {
			b.Fatalf("lỗi %v, %d nhánh, %d sự kiện", r.Error, len(r.Branches), len(events))
		}
	}
}
