package repolock

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Khoá file phải chặn handle khác, kể cả trong cùng tiến trình: đó là cách hai tiến trình worker thấy nhau.
func TestLockFileExcludesOtherHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.git.lock")
	a, err := LockFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*FilePollInterval)
	defer cancel()
	if b, err := LockFile(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		if b != nil {
			_ = b.Close()
		}
		t.Fatalf("handle thứ hai lấy được khoá: %v", err)
	}
	if err := UnlockFile(a); err != nil {
		t.Fatal(err)
	}
	_ = a.Close()
	b, err := LockFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	_ = UnlockFile(b)
	_ = b.Close()
}

// Khoá trong tiến trình phải nhả được khi context huỷ, để run bị huỷ không kẹt sau lệnh git của run khác.
func TestLockRepoHonorsContext(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "x.git")
	unlock, err := LockRepo(context.Background(), cache)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := LockRepo(ctx, cache); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	unlock()
	unlock2, err := LockRepo(context.Background(), cache)
	if err != nil {
		t.Fatal(err)
	}
	unlock2()
}

// Run và lệnh branches của app khoá file của LockRepo từ hai tiến trình: file khoá phải đúng là <cache>.lock.
func TestLockRepoHoldsFileLock(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "x.git")
	unlock, err := LockRepo(context.Background(), cache)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(cache+".lock", os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if ok, err := TryLockFile(f); ok || err != nil {
		t.Fatalf("khoá file không bị giữ: ok=%v err=%v", ok, err)
	}
	unlock()
	if ok, err := TryLockFile(f); !ok || err != nil {
		t.Fatalf("khoá file chưa nhả: ok=%v err=%v", ok, err)
	}
	_ = UnlockFile(f)
}

func TestDataDir(t *testing.T) {
	cache, err := os.UserCacheDir()
	if err != nil {
		t.Skip(err)
	}
	got, err := DataDir()
	if err != nil || got != filepath.Join(cache, "xdev-hive", "worker") {
		t.Fatalf("DataDir = %q, %v", got, err)
	}
}

// Worktree nào của repo, gọi bằng đường dẫn nào (symlink, chữ hoa trên Windows), cũng ra cùng một khoá.
func TestLocalLockSameForSamePath(t *testing.T) {
	data, repo := t.TempDir(), t.TempDir()
	common := filepath.Join(repo, ".git")
	if err := os.Mkdir(common, 0700); err != nil {
		t.Fatal(err)
	}
	a := LocalLock(data, common)
	if b := LocalLock(data, filepath.Join(repo, "sub", "..", ".git")); a != b {
		t.Fatalf("khoá khác nhau: %s, %s", a, b)
	}
	if filepath.Dir(a) != filepath.Join(data, "repos") {
		t.Fatalf("khoá nằm ngoài DataDir/repos: %s", a)
	}
	if LocalLock(data, filepath.Join(t.TempDir(), ".git")) == a {
		t.Fatal("hai repo khác nhau ra cùng khoá")
	}
}

func TestParseWorktrees(t *testing.T) {
	got := ParseWorktrees("worktree /a\r\nHEAD 1\r\nbranch refs/heads/main\r\n\r\nworktree /b\r\nHEAD 2\r\ndetached\r\n")
	if len(got) != 2 || got[0].Branch != "refs/heads/main" || got[0].HEAD != "1" || got[1].Branch != "" || !got[1].Detached || got[1].Path != filepath.FromSlash("/b") {
		t.Fatalf("ParseWorktrees = %+v", got)
	}
}

func TestParseWorktreesFlags(t *testing.T) {
	porcelain := "worktree /repo.git\nbare\n\n" +
		"worktree /w/locked\nHEAD aaa\nbranch refs/heads/a\nlocked\n\n" +
		"worktree /w/locked reason\nHEAD bbb\nbranch refs/heads/b\nlocked ổ ngoài chưa gắn\n\n" +
		"worktree /w/gone\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n\n" +
		"worktree /w/quoted\nHEAD ddd\nbranch refs/heads/d\nlocked \"\\341\\273\\225 \\\"x\\\"\\nhai\"\n"
	got := ParseWorktrees(porcelain)
	want := []Worktree{
		{Path: filepath.FromSlash("/repo.git"), Bare: true},
		{Path: filepath.FromSlash("/w/locked"), HEAD: "aaa", Branch: "refs/heads/a", Locked: true},
		{Path: filepath.FromSlash("/w/locked reason"), HEAD: "bbb", Branch: "refs/heads/b", Locked: true, LockedReason: "ổ ngoài chưa gắn"},
		{Path: filepath.FromSlash("/w/gone"), HEAD: "ccc", Detached: true, Prunable: true, PrunableReason: "gitdir file points to non-existent location"},
		{Path: filepath.FromSlash("/w/quoted"), HEAD: "ddd", Branch: "refs/heads/d", Locked: true, LockedReason: "ổ \"x\"\nhai"},
	}
	if len(got) != len(want) {
		t.Fatalf("ParseWorktrees = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("mục %d = %+v, muốn %+v", i, got[i], want[i])
		}
	}
}

// Đọc đúng output của git thật: worktree khoá, worktree mất thư mục, worktree detached.
func TestParseWorktreesFromGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	git := func(dir string, args ...string) string {
		t.Helper()
		c := exec.Command("git", args...)
		c.Dir = dir
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x", "GIT_CONFIG_NOSYSTEM=1")
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	git(root, "init", "-q", "-b", "main", repo)
	git(repo, "commit", "-q", "--allow-empty", "-m", "init")
	locked, gone, detached := filepath.Join(root, "locked"), filepath.Join(root, "gone"), filepath.Join(root, "detached")
	git(repo, "worktree", "add", "-q", "-b", "a", locked)
	git(repo, "worktree", "lock", "--reason", "ổ ngoài", locked)
	git(repo, "worktree", "add", "-q", "-b", "b", gone)
	git(repo, "worktree", "add", "-q", "--detach", detached)
	if err := os.RemoveAll(gone); err != nil {
		t.Fatal(err)
	}

	byPath := map[string]Worktree{}
	for _, w := range ParseWorktrees(git(repo, "worktree", "list", "--porcelain")) {
		byPath[CleanAbs(w.Path)] = w
	}
	if w := byPath[CleanAbs(repo)]; w.Branch != "refs/heads/main" || len(w.HEAD) < 40 || w.Locked || w.Prunable {
		t.Errorf("thư mục chính = %+v", w)
	}
	if w := byPath[CleanAbs(locked)]; !w.Locked || w.LockedReason != "ổ ngoài" || w.Branch != "refs/heads/a" {
		t.Errorf("worktree khoá = %+v", w)
	}
	if w := byPath[CleanAbs(gone)]; !w.Prunable || w.PrunableReason == "" || w.Branch != "refs/heads/b" {
		t.Errorf("worktree mất = %+v", w)
	}
	if w := byPath[CleanAbs(detached)]; !w.Detached || w.Branch != "" || len(w.HEAD) < 40 {
		t.Errorf("worktree detached = %+v", w)
	}
}

func TestPaths(t *testing.T) {
	root := t.TempDir()
	child := filepath.Join(root, "runs", "x")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	if !InsideDir(root, child) || InsideDir(child, root) || InsideDir(root, root) {
		t.Fatal("InsideDir sai")
	}
	// Tên bắt đầu bằng ".." vẫn nằm trong thư mục.
	if !InsideDir(root, filepath.Join(root, "..x")) {
		t.Fatal("InsideDir từ chối tên bắt đầu bằng ..")
	}
	if InsideDir(filepath.Join(root, "runs"), filepath.Join(root, "runs2")) {
		t.Fatal("InsideDir nhận thư mục anh em cùng tiền tố")
	}
	if !SamePath(child, filepath.Join(root, "runs", ".", "x")) || SamePath(root, child) {
		t.Fatal("SamePath sai")
	}
	// Worktree đã bị xoá vẫn so được qua thư mục cha.
	if !SamePath(filepath.Join(child, "gone"), filepath.Join(root, "runs", "x", "gone")) {
		t.Fatal("SamePath sai với đường dẫn không còn")
	}
}
