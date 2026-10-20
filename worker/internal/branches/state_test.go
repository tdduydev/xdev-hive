package branches

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestParseStatus(t *testing.T) {
	out := "# branch.oid 1111111111111111111111111111111111111111\x00" +
		"# branch.head feature/x\x00" +
		"# branch.upstream origin/feature/x\x00" +
		"# branch.ab +2 -3\x00" +
		"1 .M N... 100644 100644 100644 aaaa bbbb file with space.txt\x00" +
		"2 R. N... 100644 100644 100644 aaaa bbbb R100 new.txt\x00old.txt\x00" +
		"1 .M SC.. 160000 160000 160000 aaaa bbbb vendor/sub\x00" +
		"u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt\x00" +
		"? tệp mới.txt\x00" +
		"! node_modules/\x00"
	got := parseStatus(out)
	if got.head != "feature/x" || got.detached || got.upstream != "origin/feature/x" || !got.hasAB ||
		got.ahead != 2 || got.behind != 3 {
		t.Fatalf("nhánh đọc sai: %+v", got)
	}
	if want := []string{"file with space.txt", "new.txt", "vendor/sub", "conflict.txt"}; !slices.Equal(got.tracked, want) {
		t.Fatalf("tracked = %q, muốn %q", got.tracked, want)
	}
	if !slices.Equal(got.untracked, []string{"tệp mới.txt"}) || !slices.Equal(got.ignored, []string{"node_modules/"}) {
		t.Fatalf("untracked/ignored sai: %+v", got)
	}
	if !got.submodule || got.state() != StateDirty {
		t.Fatalf("submodule và dirty: %+v", got)
	}
}

func TestParseStatusDetachedAndGoneUpstream(t *testing.T) {
	got := parseStatus("# branch.oid (initial)\x00# branch.head (detached)\x00")
	if !got.detached || got.head != "" || got.oid != "" || got.state() != StateClean {
		t.Fatalf("detached sai: %+v", got)
	}
	gone := parseStatus("# branch.oid 1\x00# branch.head x\x00# branch.upstream origin/x\x00? a\x00")
	if gone.hasAB || gone.state() != StateUntracked {
		t.Fatalf("upstream đã xoá không có branch.ab: %+v", gone)
	}
}

func TestFilesCap(t *testing.T) {
	var tr tree
	for i := range 25 {
		tr.untracked = append(tr.untracked, string(rune('a'+i)))
	}
	tr.tracked = []string{"T"}
	files, total := tr.files()
	if len(files) != maxFiles || total != 26 || files[0] != "T" {
		t.Fatalf("files phải cắt ở 20, file theo dõi trước: %d %d %q", len(files), total, files[0])
	}
}

func TestOperationIn(t *testing.T) {
	cases := []struct {
		files []string
		want  string
	}{
		{nil, ""},
		{[]string{"MERGE_HEAD"}, OpMerge},
		{[]string{"rebase-merge/", "MERGE_HEAD"}, OpRebase},
		{[]string{"rebase-apply/"}, OpRebase},
		{[]string{"CHERRY_PICK_HEAD"}, OpCherryPick},
		{[]string{"REVERT_HEAD"}, OpRevert},
		{[]string{"BISECT_LOG"}, OpBisect},
	}
	for _, c := range cases {
		dir := t.TempDir()
		for _, f := range c.files {
			p := filepath.Join(dir, filepath.FromSlash(f))
			if f[len(f)-1] == '/' {
				if err := os.MkdirAll(p, 0o755); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(p, []byte("x"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		if got := OperationIn(dir); got != c.want {
			t.Fatalf("%v: %q, muốn %q", c.files, got, c.want)
		}
	}
}

func TestIgnoredBlocking(t *testing.T) {
	ignored := []string{"node_modules/", "apps/web/node_modules/", "dist/", ".env", "apps/hub/.env.local", "target/"}
	got := IgnoredBlocking(ignored, DefaultRebuildable())
	if !slices.Contains(got, ".env") || !slices.Contains(got, "apps/hub/.env.local") {
		t.Fatalf(".env phải chặn: %q", got)
	}
	for _, p := range got {
		if p == "node_modules/" || p == "apps/web/node_modules/" {
			t.Fatalf("node_modules dựng lại được: %q", got)
		}
	}
}

func TestPathState(t *testing.T) {
	dir := t.TempDir()
	if s := pathState(dir); s != "" {
		t.Fatalf("thư mục còn: %q", s)
	}
	if s := pathState(filepath.Join(dir, "gone")); s != StateMissing {
		t.Fatalf("cha còn là missing: %q", s)
	}
	if s := pathState(filepath.Join(dir, "no-parent", "gone")); s != StateUnreachable {
		t.Fatalf("cha mất là unreachable: %q", s)
	}
}

// Thao tác dở đọc từ thư mục git riêng của worktree, kể cả worktree liên kết.
func TestReadTreeMergeConflict(t *testing.T) {
	isolateGit(t)
	repo := newRepo(t)
	gitT(t, repo, "switch", "-c", "other")
	writeFile(t, repo, "README.md", "other\n")
	gitT(t, repo, "commit", "-qam", "other")
	gitT(t, repo, "switch", "main")
	writeFile(t, repo, "README.md", "main\n")
	gitT(t, repo, "commit", "-qam", "main")
	gitTry(repo, "merge", "other")
	tr, op, err := testEnv(t).readTree(context.Background(), repo, false)
	if err != nil {
		t.Fatal(err)
	}
	if op != OpMerge || tr.state() != StateDirty {
		t.Fatalf("merge dở: op=%q state=%q", op, tr.state())
	}
}

// subRepo là repo nhỏ để làm submodule.
func subRepo(t testing.TB) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "sub")
	gitT(t, "", "init", "-q", "-b", "main", dir)
	writeFile(t, dir, "a.txt", "a\n")
	gitT(t, dir, "add", "-A")
	gitT(t, dir, "commit", "-qm", "sub")
	return dir
}

// gitFile chạy git với protocol.file.allow: từ git 2.38.1 submodule clone từ đường dẫn tại máy bị chặn mặc định.
func gitFile(t testing.TB, dir string, args ...string) {
	t.Helper()
	gitT(t, dir, append([]string{"-c", "protocol.file.allow=always"}, args...)...)
}

// addSubmodule thêm submodule libs/sub (có .gitmodules) vào dir rồi commit.
func addSubmodule(t testing.TB, dir string) {
	t.Helper()
	gitFile(t, dir, "submodule", "add", "-q", filepath.ToSlash(subRepo(t)), "libs/sub")
	gitT(t, dir, "commit", "-qm", "submodule")
}

// addGitlink thêm gitlink vendor/emb không ghi trong .gitmodules (git add một repo lồng), trả repo nguồn.
func addGitlink(t testing.TB, dir string) string {
	t.Helper()
	sub := subRepo(t)
	gitT(t, "", "clone", "-q", sub, filepath.Join(dir, "vendor", "emb"))
	gitT(t, dir, "add", "vendor/emb")
	gitT(t, dir, "commit", "-qm", "gitlink")
	if out := gitT(t, dir, "ls-files", "--stage", "vendor/emb"); !strings.HasPrefix(out, "160000 ") {
		t.Fatalf("vendor/emb phải là gitlink: %q", out)
	}
	return sub
}

// readSubmodule là cờ submodule của lượt đọc cho dọn.
func readSubmodule(t *testing.T, env Env, dir string) bool {
	t.Helper()
	tr, _, err := env.readTree(context.Background(), dir, true)
	if err != nil {
		t.Fatal(err)
	}
	return tr.submodule
}

// Cờ submodule khớp đúng lúc git worktree remove (không --force) từ chối (FR-022, research mục 5).
func TestSubmoduleMatchesGitWorktreeRemove(t *testing.T) {
	isolateGit(t)
	env := testEnv(t)
	withModules := newRepo(t)
	addSubmodule(t, withModules)
	gitlinkOnly := newRepo(t)
	sub := addGitlink(t, gitlinkOnly)
	if _, err := os.Stat(filepath.Join(gitlinkOnly, ".gitmodules")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("không được có .gitmodules: %v", err)
	}
	wts := t.TempDir()

	cases := []struct {
		name     string
		repo     string
		populate func(wt string)
		want     bool
	}{
		{"gitmodules-uninit", withModules, func(string) {}, false},
		{"gitmodules-init", withModules, func(wt string) { gitFile(t, wt, "submodule", "update", "-q", "--init") }, true},
		// deinit để lại modules/ trong thư mục git của worktree; git vẫn từ chối.
		{"gitmodules-deinit", withModules, func(wt string) {
			gitFile(t, wt, "submodule", "update", "-q", "--init")
			gitT(t, wt, "submodule", "deinit", "-q", "-f", "libs/sub")
		}, true},
		{"gitlink-empty", gitlinkOnly, func(string) {}, false},
		{"gitlink-cloned", gitlinkOnly, func(wt string) { gitT(t, "", "clone", "-q", sub, filepath.Join(wt, "vendor", "emb")) }, true},
	}
	for _, c := range cases {
		wt := filepath.Join(wts, c.name)
		gitT(t, c.repo, "worktree", "add", "-q", "-b", c.name, wt)
		c.populate(wt)
		if got := readSubmodule(t, env, wt); got != c.want {
			t.Errorf("%s: submodule = %v, muốn %v", c.name, got, c.want)
		}
		out, err := gitTry(c.repo, "worktree", "remove", wt)
		if refused := err != nil; refused != c.want {
			t.Errorf("%s: git từ chối = %v, muốn %v\n%s", c.name, refused, c.want, out)
		}
	}
	// Thư mục chính: repo lồng vendor/emb có .git nên là submodule đã init; libs/sub do submodule add clone vào.
	if !readSubmodule(t, env, gitlinkOnly) || !readSubmodule(t, env, withModules) {
		t.Fatal("thư mục chính có submodule đã init")
	}
}

func TestMayHaveGitlink(t *testing.T) {
	isolateGit(t)
	// Repo không có gitlink: không gọi thêm git cho worktree nào (đo SC-001 không đổi).
	repo := newRepo(t)
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, repo, "worktree", "add", "-q", "-b", "w", wt)
	for _, d := range []string{repo, wt} {
		gitDir := gitT(t, d, "rev-parse", "--absolute-git-dir")
		if maybe, err := mayHaveGitlink(gitDir); maybe || err != nil {
			t.Fatalf("%s: %v %v", d, maybe, err)
		}
	}
	gitlink := newRepo(t)
	addGitlink(t, gitlink)
	if maybe, err := mayHaveGitlink(filepath.Join(gitlink, ".git")); !maybe || err != nil {
		t.Fatalf("có gitlink: %v %v", maybe, err)
	}

	dir := t.TempDir()
	if maybe, err := mayHaveGitlink(dir); maybe || err != nil {
		t.Fatalf("chưa có index: %v %v", maybe, err)
	}
	index := filepath.Join(dir, "index")
	if err := os.WriteFile(index, []byte("DIRC\x00\x00\x00\x02\x00\x00\x00\x01\x00\x00\x81\xa4"), 0o644); err != nil {
		t.Fatal(err)
	}
	if maybe, err := mayHaveGitlink(dir); maybe || err != nil {
		t.Fatalf("không có gitlink: %v %v", maybe, err)
	}
	// Split index: mục nằm ở sharedindex.<mã>, không đọc được từ index.
	writeFile(t, dir, "sharedindex.0123", "")
	if maybe, err := mayHaveGitlink(dir); !maybe || err != nil {
		t.Fatalf("split index phải hỏi git: %v %v", maybe, err)
	}
	if err := os.Remove(filepath.Join(dir, "sharedindex.0123")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(index, []byte("DIRC\x00\x00\x00\x02\x00\x00\x00\x01\x00\x00\xe0\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	if maybe, err := mayHaveGitlink(dir); !maybe || err != nil {
		t.Fatalf("có mode gitlink: %v %v", maybe, err)
	}
}

// Index có thể có gitlink mà git ls-files lỗi: không biết thì chặn.
func TestHasSubmoduleUnsureBlocks(t *testing.T) {
	isolateGit(t)
	gitDir, dir := t.TempDir(), t.TempDir()
	t.Setenv("GIT_CEILING_DIRECTORIES", filepath.Dir(dir))
	if err := os.WriteFile(filepath.Join(gitDir, "index"), []byte("DIRC\x00\x00\xe0\x00"), 0o644); err != nil {
		t.Fatal(err)
	}
	if !testEnv(t).hasSubmodule(context.Background(), dir, gitDir) {
		t.Fatal("git ls-files lỗi thì phải chặn")
	}
}
