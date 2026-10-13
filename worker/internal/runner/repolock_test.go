package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Nhiều run cùng repo chạy song song trên một DataDir (worker --capacity > 1): clone, fetch, worktree add/remove
// và push vào cùng repo cache không được tranh khoá của nhau. "cold" kiểm lúc cache chưa có (cùng clone); "warm" kiểm
// lúc cache đã có và nhánh chính vừa tiến, nên mọi run cùng fetch ghi một ref (lỗi "cannot lock ref" của e2e).
func TestRunnerParallelRunsSameRepo(t *testing.T) {
	remote, base := makeRemote(t)
	t.Run("cold", func(t *testing.T) {
		runParallel(t, remote, base, t.TempDir(), "cold")
	})
	t.Run("warm", func(t *testing.T) {
		data := t.TempDir()
		runParallel(t, remote, base, data, "warm-seed")
		src := filepath.Join(t.TempDir(), "src")
		must(t, "git", "clone", remote, src)
		mustDir(t, src, "next.txt", "next")
		must(t, "git", "-C", src, "add", ".")
		must(t, "git", "-C", src, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "next")
		must(t, "git", "-C", src, "push", "origin", base)
		runParallel(t, remote, base, data, "warm")
	})
}

func runParallel(t *testing.T, remote, base, data, prefix string) {
	t.Helper()
	n := 4
	if prefix == "warm-seed" {
		n = 1
	}
	var wg sync.WaitGroup
	errs := make([]error, n)
	results := make([]*Result, n)
	for i := range n {
		wg.Go(func() {
			var mu sync.Mutex
			var events []Event
			r := Runner{DataDir: data, CLICommands: fakeCommands("commit")}
			job := Job{RunID: fmt.Sprintf("%s-%d", prefix, i), Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: fmt.Sprintf("ai/%s-%d", prefix, i), CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "commit"}}
			errs[i] = r.Run(context.Background(), job, SinkFunc(func(e Event) error { mu.Lock(); events = append(events, e); mu.Unlock(); return nil }))
			mu.Lock()
			results[i] = lastResult(events)
			mu.Unlock()
		})
	}
	wg.Wait()
	for i := range n {
		if errs[i] != nil || results[i] == nil || results[i].Status != "succeeded" {
			t.Fatalf("run %s-%d: err = %v, result = %#v", prefix, i, errs[i], results[i])
		}
		must(t, "git", "--git-dir", remote, "show-ref", "--verify", "--quiet", fmt.Sprintf("refs/heads/ai/%s-%d", prefix, i))
	}
	entries, err := os.ReadDir(filepath.Join(data, "runs"))
	if err != nil || len(entries) != 0 {
		t.Fatalf("worktree còn sót: %v, %v", entries, err)
	}
}

// Khoá file phải chặn handle khác, kể cả trong cùng tiến trình: đó là cách hai tiến trình worker thấy nhau.
func TestLockFileExcludesOtherHandle(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cache.git.lock")
	a, err := lockFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*filePollInterval)
	defer cancel()
	if b, err := lockFile(ctx, path); !errors.Is(err, context.DeadlineExceeded) {
		if b != nil {
			_ = b.Close()
		}
		t.Fatalf("handle thứ hai lấy được khoá: %v", err)
	}
	if err := unlockFile(a); err != nil {
		t.Fatal(err)
	}
	_ = a.Close()
	b, err := lockFile(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	_ = unlockFile(b)
	_ = b.Close()
}

// Khoá trong tiến trình phải nhả được khi context huỷ, để run bị huỷ không kẹt sau lệnh git của run khác.
func TestLockRepoHonorsContext(t *testing.T) {
	cache := filepath.Join(t.TempDir(), "x.git")
	unlock, err := lockRepo(context.Background(), cache)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := lockRepo(ctx, cache); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	unlock()
	unlock2, err := lockRepo(context.Background(), cache)
	if err != nil {
		t.Fatal(err)
	}
	unlock2()
}

// Git ngoài worker giữ khoá ref một lúc rồi nhả: fetch phải thử lại và thành công. Lỗi khác thì báo ngay.
func TestGitWriteRetriesHeldRefLock(t *testing.T) {
	remote, base := makeRemote(t)
	cache := filepath.Join(t.TempDir(), "cache.git")
	must(t, "git", "clone", "--bare", remote, cache)
	refspec := base + ":refs/remotes/origin/" + base
	must(t, "git", "--git-dir", cache, "fetch", "origin", refspec)
	// Nhánh chính tiến lên để fetch phải ghi ref.
	src := filepath.Join(t.TempDir(), "src")
	must(t, "git", "clone", remote, src)
	mustDir(t, src, "next.txt", "next")
	must(t, "git", "-C", src, "add", ".")
	must(t, "git", "-C", src, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "next")
	must(t, "git", "-C", src, "push", "origin", base)
	want := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/"+base))

	held := filepath.Join(cache, "refs", "remotes", "origin", base+".lock")
	if err := os.WriteFile(held, nil, 0600); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(gitLockBackoff + gitLockBackoff/2)
		_ = os.Remove(held)
		close(released)
	}()
	if err := gitWrite(context.Background(), cache, cache, "fetch", "origin", refspec); err != nil {
		t.Fatal(err)
	}
	<-released
	if got := strings.TrimSpace(mustOut(t, "git", "--git-dir", cache, "rev-parse", "refs/remotes/origin/"+base)); got != want {
		t.Fatalf("ref = %s, muốn %s", got, want)
	}

	start := time.Now()
	if err := gitWrite(context.Background(), cache, cache, "fetch", "origin", "no-such-branch:refs/remotes/origin/no-such-branch"); err == nil {
		t.Fatal("fetch nhánh không có phải lỗi")
	}
	if time.Since(start) >= gitLockBackoff {
		t.Fatal("lỗi không phải khoá ref vẫn bị thử lại")
	}
}

func TestIsGitLockError(t *testing.T) {
	for msg, want := range map[string]bool{
		"error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/c/refs/remotes/origin/main.lock': File exists.": true,
		"fatal: Unable to create '/c/worktrees/x/index.lock': File exists.":                                                    true,
		"error: could not lock config file config: File exists":                                                                true,
		"error: fetching ref refs/remotes/origin/master failed: reference already exists":                                      true,
		"fatal: couldn't find remote ref no-such-branch":                                                                       false,
		"fatal: unable to access 'https://example.invalid/': Could not resolve host":                                           false,
	} {
		if got := isGitLockError(msg); got != want {
			t.Errorf("%q: %v, muốn %v", msg, got, want)
		}
	}
}

// Checkout ngoài khoá vẫn phải cho worktree sạch, đúng nhánh như `worktree add` thường.
func TestAddWorktreeChecksOutCleanTree(t *testing.T) {
	remote, base := makeRemote(t)
	cache := filepath.Join(t.TempDir(), "cache.git")
	must(t, "git", "clone", "--bare", remote, cache)
	work := filepath.Join(t.TempDir(), "w")
	if err := addWorktree(context.Background(), cache, work, "-B", "ai/clean", work, base); err != nil {
		t.Fatal(err)
	}
	if b, err := os.ReadFile(filepath.Join(work, "README")); err != nil || string(b) != "init" {
		t.Fatalf("README = %q, %v", b, err)
	}
	if st := mustOut(t, "git", "-C", work, "status", "--porcelain"); st != "" {
		t.Fatalf("worktree bẩn: %q", st)
	}
	if br := strings.TrimSpace(mustOut(t, "git", "-C", work, "branch", "--show-current")); br != "ai/clean" {
		t.Fatalf("nhánh = %q", br)
	}
}
