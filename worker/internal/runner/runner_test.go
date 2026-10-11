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
	if filepath.Base(cmd.Args[0]) != "codex" || len(cmd.Args) != 11 || cmd.Args[1] != "exec" || cmd.Args[len(cmd.Args)-1] != "p" {
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

func TestDefaultCLIArgumentsAndClaudeMCPFile(t *testing.T) {
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example/", "HIVE_RUN_TOKEN": "run-secret"}
	for _, tc := range []struct {
		cli, model string
		want       []string
	}{
		{"claude", "sonnet", []string{"-p", "prompt", "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config"}},
		{"claude", "", []string{"-p", "prompt", "--output-format", "stream-json", "--verbose", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config"}},
		{"codex", "gpt-test", []string{"exec", "-c", "mcp_servers={}", "-c", `mcp_servers.xdev-hive-run={url="https://hub.example/mcp",bearer_token_env_var="HIVE_RUN_TOKEN"}`, "-m", "gpt-test", "prompt"}},
		{"codex", "", []string{"exec", "-c", "mcp_servers={}", "-c", `mcp_servers.xdev-hive-run={url="https://hub.example/mcp",bearer_token_env_var="HIVE_RUN_TOKEN"}`, "prompt"}},
		{"gemini", "gemini-test", []string{"-p", "prompt", "-m", "gemini-test"}},
		{"gemini", "", []string{"-p", "prompt"}},
	} {
		j := Job{CLI: tc.cli, Model: tc.model, Prompt: "prompt", Env: env}
		cmd, err := (Runner{}).cliCommand(j)
		if err != nil {
			t.Fatal(err)
		}
		defer func() {
			if cmd.cleanup != nil {
				cmd.cleanup()
			}
		}()
		args := cmd.Args[1:]
		// Quyền được kiểm riêng ở TestRunPermissionArguments; ở đây kiểm model và MCP.
		switch tc.cli {
		case "claude":
			args = args[:len(args)-4]
		case "codex":
			args = append(append([]string(nil), args[:len(args)-5]...), args[len(args)-1])
		case "gemini":
			args = args[:len(args)-5]
		}
		if tc.cli == "claude" {
			extra := 1
			if tc.model != "" {
				extra = 3
			}
			if len(args) != len(tc.want)+extra || strings.Join(args[:len(tc.want)], "\x00") != strings.Join(tc.want, "\x00") || (tc.model != "" && (args[len(tc.want)+1] != "--model" || args[len(tc.want)+2] != tc.model)) {
				t.Fatalf("claude args = %q", args)
			}
			path := args[len(tc.want)]
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0600 {
				t.Fatalf("MCP mode = %o", info.Mode().Perm())
			}
			b, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, want := range []string{`"xdev-hive"`, `"https://hub.example/mcp"`, `"Authorization":"Bearer run-secret"`} {
				if !strings.Contains(string(b), want) {
					t.Fatalf("MCP config thiếu %s: %s", want, b)
				}
			}
		} else if strings.Join(args, "\x00") != strings.Join(tc.want, "\x00") {
			t.Fatalf("%s args = %q, want %q", tc.cli, args, tc.want)
		}
	}
}

func TestClaudeMCPFileCleanup(t *testing.T) {
	path, err := claudeMCPConfig(map[string]string{"HIVE_HUB_URL": "https://hub", "HIVE_RUN_TOKEN": "token"})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("MCP config còn sau cleanup: %v", err)
	}
}

func TestClaudeMCPFileRemovedWhenRunFailsOrIsCancelled(t *testing.T) {
	remote, base := makeRemote(t)
	for _, cancelRun := range []bool{false, true} {
		name := "failure"
		if cancelRun {
			name = "cancelled"
		}
		t.Run(name, func(t *testing.T) {
			bin := t.TempDir()
			capture := filepath.Join(t.TempDir(), "mcp-path")
			fake := filepath.Join(bin, "claude")
			script := "#!/bin/sh\nwhile [ $# -gt 0 ]; do if [ \"$1\" = \"--mcp-config\" ]; then shift; printf '%s' \"$1\" > \"$HIVE_CAPTURE_MCP\"; break; fi; shift; done\n"
			if cancelRun {
				script += "sleep 30\n"
			} else {
				script += "exit 7\n"
			}
			if err := os.WriteFile(fake, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			data := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- (Runner{DataDir: data, CLICommands: map[string]Command{}}).Run(ctx, Job{RunID: name, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/" + name, CLI: "claude", Prompt: "run", Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "secret", "HIVE_CAPTURE_MCP": capture}}, SinkFunc(func(Event) error { return nil }))
			}()
			limit := time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(capture); err == nil {
					break
				}
				if time.Now().After(limit) {
					t.Fatal("CLI không ghi lại đường dẫn MCP")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if cancelRun {
				cancel()
			}
			if err := <-done; err == nil {
				t.Fatal("run phải kết thúc lỗi")
			}
			pathBytes, err := os.ReadFile(capture)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := os.Stat(string(pathBytes)); !os.IsNotExist(err) {
				t.Fatalf("file MCP còn sau run %s: %v", name, err)
			}
		})
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
