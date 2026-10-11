package runner

import (
	"context"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRunnerPublishesAndNoChanges(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	for _, tc := range []struct {
		name, mode, status string
		pushed             bool
	}{{"commit", "commit", "succeeded", true}, {"empty", "empty", "no_changes", false}} {
		t.Run(tc.name, func(t *testing.T) {
			branch := "ai/" + tc.name
			_ = git(context.Background(), remote, "branch", "-D", branch)
			var events []Event
			r := Runner{DataDir: data, CLICommands: fakeCommands(tc.mode)}
			err := r.Run(context.Background(), Job{RunID: tc.name, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: branch, CLI: "codex", Prompt: "prompt", Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": tc.mode}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
			if err != nil {
				t.Fatal(err)
			}
			got := lastResult(events)
			if got == nil || got.Status != tc.status {
				t.Fatalf("result = %#v", got)
			}
			cmd := exec.Command("git", "--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
			present := cmd.Run() == nil
			if present != tc.pushed {
				t.Fatalf("pushed = %v", present)
			}
			if _, err := os.Stat(filepath.Join(data, "runs", tc.name+"-1")); !os.IsNotExist(err) {
				t.Fatalf("worktree remains: %v", err)
			}
		})
	}
}

// Run review checkout nhánh của run cha, không push dù agent có commit, và vẫn succeeded khi không có commit.
func TestRunnerReviewChecksOutParentBranchWithoutPush(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	// Nhánh của run cha đã push, có một file mà nhánh chính không có.
	src := filepath.Join(t.TempDir(), "parent")
	must(t, "git", "clone", remote, src)
	must(t, "git", "-C", src, "checkout", "-b", "ai/HD-1")
	mustDir(t, src, "parent.txt", "cha")
	must(t, "git", "-C", src, "add", ".")
	must(t, "git", "-C", src, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "cha")
	must(t, "git", "-C", src, "push", "origin", "ai/HD-1")
	parentSHA := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/ai/HD-1"))

	for _, mode := range []string{"empty", "commit"} {
		t.Run(mode, func(t *testing.T) {
			var events []Event
			r := Runner{DataDir: data, CLICommands: fakeCommands(mode)}
			job := Job{RunID: "review-" + mode, Kind: KindReview, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/HD-1", CLI: "codex", Prompt: "review", Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": mode, "HIVE_FAKE_EXPECT_FILE": "parent.txt"}}
			if err := r.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil })); err != nil {
				t.Fatal(err)
			}
			got := lastResult(events)
			if got == nil || got.Status != "succeeded" || got.CommitCount != 0 {
				t.Fatalf("result = %#v", got)
			}
			for _, e := range events {
				if e.Type == "phase" && e.Phase == "publishing" {
					t.Fatal("run review không được push")
				}
			}
			if now := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/ai/HD-1")); now != parentSHA {
				t.Fatalf("nhánh của cha bị đổi: %s → %s", parentSHA, now)
			}
		})
	}
}

func TestRunnerTimeoutAndCancelCleanWorktree(t *testing.T) {
	remote, base := makeRemote(t)
	for _, tc := range []struct {
		name    string
		timeout time.Duration
		cancel  bool
	}{{"timeout", 80 * time.Millisecond, false}, {"cancel", 0, true}} {
		t.Run(tc.name, func(t *testing.T) {
			data := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			running := make(chan struct{}, 1)
			var events []Event
			go func() {
				done <- (Runner{DataDir: data, CLICommands: fakeCommands("sleep"), KillGrace: 200 * time.Millisecond}).Run(ctx, Job{RunID: tc.name, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/" + tc.name, CLI: "codex", Timeout: tc.timeout, Env: map[string]string{"HIVE_RUNNER_HELPER": "1"}}, SinkFunc(func(e Event) error {
					events = append(events, e)
					if e.Type == "phase" && e.Phase == "running" {
						running <- struct{}{}
					}
					return nil
				}))
			}()
			if tc.cancel {
				<-running
				cancel()
			}
			err := <-done
			if err == nil {
				t.Fatal("expected process to stop")
			}
			if _, statErr := os.Stat(filepath.Join(data, "runs", tc.name+"-1")); !os.IsNotExist(statErr) {
				t.Fatalf("worktree remains: %v", statErr)
			}
			res := lastResult(events)
			if res == nil {
				t.Fatal("result event missing")
			}
			status := res.Status
			if tc.cancel && status != "cancelled" {
				t.Fatalf("status %q", status)
			}
			if !tc.cancel && status != "timeout" {
				t.Fatalf("status %q", status)
			}
		})
	}
}

func TestReapOrphans(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	cache := filepath.Join(data, "repos", "cache.git")
	root := filepath.Join(data, "runs")
	if err := os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	must(t, "git", "clone", "--bare", remote, cache)
	must(t, "git", "--git-dir", cache, "worktree", "add", "-b", "ai/live", filepath.Join(root, "live-1"), "refs/heads/"+base)
	must(t, "git", "--git-dir", cache, "worktree", "add", "-b", "ai/orphan", filepath.Join(root, "orphan-1"), "refs/heads/"+base)
	if err := ReapOrphans(data, []string{"live"}); err != nil {
		t.Fatal(err)
	}
	if _, e := os.Stat(filepath.Join(data, "runs", "live-1")); e != nil {
		t.Fatal("live worktree removed")
	}
	if _, e := os.Stat(filepath.Join(data, "runs", "orphan-1")); !os.IsNotExist(e) {
		t.Fatalf("orphan remains: %v", e)
	}
}

func TestFakeCLIHelper(t *testing.T) {
	if os.Getenv("HIVE_RUNNER_HELPER") != "1" {
		return
	}
	if strings.Contains(strings.Join(os.Args, " "), "helper-sleep") {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	// Run review phải thấy code của nhánh cha trong worktree.
	if f := os.Getenv("HIVE_FAKE_EXPECT_FILE"); f != "" {
		if _, err := os.Stat(f); err != nil {
			os.Exit(4)
		}
	}
	if os.Getenv("HIVE_FAKE_MODE") == "commit" {
		_ = os.WriteFile("change.txt", []byte("change"), 0600)
		c := exec.Command("git", "add", "change.txt")
		if err := c.Run(); err != nil {
			os.Exit(2)
		}
		c = exec.Command("git", "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "test")
		if err := c.Run(); err != nil {
			os.Exit(3)
		}
	}
	os.Exit(0)
}

func fakeCommands(mode string) map[string]Command {
	args := []string{"-test.run=TestFakeCLIHelper", "--", "helper"}
	if mode == "sleep" {
		args = append(args, "helper-sleep")
	}
	return map[string]Command{"codex": {Path: os.Args[0], Args: args}}
}
func lastResult(events []Event) *Result {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].Type == "result" {
			return events[i].Result
		}
	}
	return nil
}
func makeRemote(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	work := filepath.Join(root, "source")
	must(t, "git", "init", "--bare", remote)
	must(t, "git", "init", work)
	mustDir(t, work, "README", "init")
	mustDir(t, work, ".gitkeep", "x")
	must(t, "git", "-C", work, "add", ".")
	must(t, "git", "-C", work, "-c", "user.name=Runner Test", "-c", "user.email=runner@example.invalid", "commit", "-m", "base")
	out := mustOut(t, "git", "-C", work, "branch", "--show-current")
	base := strings.TrimSpace(out)
	must(t, "git", "-C", work, "remote", "add", "origin", remote)
	must(t, "git", "-C", work, "push", "-u", "origin", base)
	return remote, base
}
func fileURL(path string) string {
	return (&url.URL{Scheme: "file", Path: filepath.ToSlash(path)}).String()
}
func mustDir(t *testing.T, dir, name, value string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}
func must(t *testing.T, args ...string) {
	t.Helper()
	c := exec.Command(args[0], args[1:]...)
	if b, e := c.CombinedOutput(); e != nil {
		t.Fatalf("%v: %s: %v", args, b, e)
	}
}
func mustOut(t *testing.T, args ...string) string {
	t.Helper()
	b, e := exec.Command(args[0], args[1:]...).Output()
	if e != nil {
		t.Fatal(e)
	}
	return string(b)
}

func TestCLICommandFromEnv(t *testing.T) {
	t.Setenv(CLIOverridesEnv, `{"claude": {"path": "/opt/fake-claude", "args": ["--task", "{{prompt}}"]}}`)
	cmd, err := (Runner{}).cliCommand(Job{CLI: "claude", Prompt: "sửa README"})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != "/opt/fake-claude" || strings.Join(cmd.Args[1:], " ") != "--task sửa README" {
		t.Fatalf("lệnh = %s %v", cmd.Path, cmd.Args)
	}
	// CLI không có trong biến môi trường vẫn dùng lệnh mặc định.
	cmd, err = (Runner{}).cliCommand(Job{CLI: "codex", Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(cmd.Args[0]) != "codex" || strings.Join(cmd.Args[1:], " ") != "exec p" {
		t.Fatalf("lệnh mặc định = %v", cmd.Args)
	}
	// Runner.CLICommands do code đặt thắng biến môi trường.
	cmd, err = (Runner{CLICommands: map[string]Command{"claude": {Path: "/opt/khac", Args: []string{"{{prompt}}"}}}}).cliCommand(Job{CLI: "claude", Prompt: "p"})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != "/opt/khac" {
		t.Fatalf("lệnh = %s", cmd.Path)
	}
}

func TestCommandsFromEnvRejectsBadValue(t *testing.T) {
	for _, raw := range []string{`{"claude":`, `{"claude": {"args": ["x"]}}`} {
		t.Setenv(CLIOverridesEnv, raw)
		if _, err := CommandsFromEnv(); err == nil {
			t.Fatalf("%s: cần báo lỗi", raw)
		}
		if _, err := (Runner{}).cliCommand(Job{CLI: "claude", Prompt: "p"}); err == nil {
			t.Fatalf("%s: cliCommand cần báo lỗi thay vì chạy lệnh mặc định", raw)
		}
	}
	t.Setenv(CLIOverridesEnv, " ")
	if m, err := CommandsFromEnv(); err != nil || len(m) != 0 {
		t.Fatalf("biến trống: %v, %v", m, err)
	}
}
