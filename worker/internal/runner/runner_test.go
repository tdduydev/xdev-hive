package runner

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
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
			if got.DiffStats == nil || got.DiffStats.AddedLines != got.CommitCount || got.DiffStats.DeletedLines != 0 {
				t.Fatalf("diffStats = %#v, commitCount = %d", got.DiffStats, got.CommitCount)
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

// CLI in nhiều log rồi thoát ngay trong khi sink còn chậm: log không được mất, run không được lỗi
// "file already closed" (Wait đóng pipe trước khi đọc xong, từng làm CI macOS đỏ).
func TestRunnerKeepsAllLogWhenCLIExitsFast(t *testing.T) {
	remote, base := makeRemote(t)
	got := map[string]int64{}
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("loud")}
	job := Job{RunID: "loud", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/loud", CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "loud"}}
	var mu sync.Mutex
	var result *Result
	err := r.Run(context.Background(), job, SinkFunc(func(e Event) error {
		mu.Lock()
		defer mu.Unlock()
		switch e.Type {
		case "log":
			if e.Offset != got[e.Stream] {
				t.Errorf("%s offset = %d, muốn %d", e.Stream, e.Offset, got[e.Stream])
			}
			got[e.Stream] += int64(len(e.Data))
			time.Sleep(time.Millisecond)
		case "result":
			result = e.Result
		}
		return nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || result.Status != "no_changes" {
		t.Fatalf("result = %#v", result)
	}
	if got["stdout"] != loudBytes || got["stderr"] != loudBytes {
		t.Fatalf("log = %v, muốn mỗi luồng %d byte", got, loudBytes)
	}
}

const loudBytes = 512 * 1024

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
	switch os.Getenv("HIVE_FAKE_MODE") {
	case "usage-ok":
		fmt.Println(`{"type":"assistant","message":{"id":"m1","model":"claude-test","usage":{"input_tokens":3,"output_tokens":7}}}`)
		fmt.Println(`{"type":"result","usage":{"input_tokens":3,"output_tokens":9},"total_cost_usd":0.5,"num_turns":1}`)
		os.Exit(0)
	case "usage-loop":
		// CLI giả tiêu 100 token mỗi lượt và không tự dừng: runner phải dừng nó khi vượt trần.
		for i := 0; i < 1500; i++ {
			fmt.Printf(`{"type":"assistant","message":{"id":"m%d","usage":{"input_tokens":0,"output_tokens":100}}}`+"\n", i)
			time.Sleep(20 * time.Millisecond)
		}
		os.Exit(0)
	}
	// Run review phải thấy code của nhánh cha trong worktree.
	if f := os.Getenv("HIVE_FAKE_EXPECT_FILE"); f != "" {
		if _, err := os.Stat(f); err != nil {
			os.Exit(4)
		}
	}
	if os.Getenv("HIVE_FAKE_MODE") == "loud" {
		chunk := []byte(strings.Repeat("x", 1024))
		for range loudBytes / len(chunk) {
			_, _ = os.Stdout.Write(chunk)
			_, _ = os.Stderr.Write(chunk)
		}
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
	if filepath.Base(cmd.Args[0]) != "codex" || !strings.Contains(strings.Join(cmd.Args[1:], " "), "exec --json") || cmd.Args[len(cmd.Args)-1] != "p" {
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
		{"codex", "gpt-test", []string{"exec", "--json", "-c", "mcp_servers={}", "-c", `mcp_servers.xdev-hive={url="https://hub.example/mcp",bearer_token_env_var="HIVE_RUN_TOKEN"}`, "-m", "gpt-test", "prompt"}},
		{"codex", "", []string{"exec", "--json", "-c", "mcp_servers={}", "-c", `mcp_servers.xdev-hive={url="https://hub.example/mcp",bearer_token_env_var="HIVE_RUN_TOKEN"}`, "prompt"}},
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
			if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
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
	if runtime.GOOS == "windows" {
		// Windows does not execute the POSIX shell fixture below; validate the command cleanup hook directly.
		cmd, err := (Runner{}).cliCommand(Job{CLI: "claude", Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "secret"}})
		if err != nil {
			t.Fatal(err)
		}
		path := cmd.Args[len(cmd.Args)-1]
		if _, err := os.Stat(path); err != nil {
			t.Fatal(err)
		}
		cmd.cleanup()
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("file MCP còn sau cleanup: %v", err)
		}
		return
	}
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

func TestRunnerReportsCostAndStopsOverBudget(t *testing.T) {
	remote, base := makeRemote(t)
	claude := map[string]Command{"claude": {Path: os.Args[0], Args: []string{"-test.run=TestFakeCLIHelper", "--", "helper"}}}
	maxTok := int64(250)
	for _, tc := range []struct {
		name, mode, status string
		budget             Budget
	}{
		{"cost-ok", "usage-ok", "no_changes", Budget{}},
		{"cost-over", "usage-loop", "failed", Budget{MaxTokens: &maxTok}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var events []Event
			r := Runner{DataDir: t.TempDir(), CLICommands: claude, KillGrace: 2 * time.Second}
			job := Job{RunID: tc.name, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/" + tc.name, CLI: "claude", Timeout: 20 * time.Second, Budget: tc.budget, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": tc.mode}}
			start := time.Now()
			_ = r.Run(context.Background(), job, SinkFunc(func(e Event) error { mu.Lock(); events = append(events, e); mu.Unlock(); return nil }))
			if time.Since(start) > 10*time.Second {
				t.Fatal("runner không dừng CLI khi vượt trần")
			}
			res := lastResult(events)
			if res == nil || res.Status != tc.status {
				t.Fatalf("result = %+v", res)
			}
			// Sự kiện cost cuối nằm trước run_result.
			var last *Usage
			for _, e := range events {
				if e.Type == "cost" {
					last = e.Cost
				}
				if e.Type == "result" && last == nil {
					t.Fatal("không có sự kiện cost trước kết quả")
				}
			}
			if last == nil {
				t.Fatal("không có sự kiện cost")
			}
			if tc.mode == "usage-ok" {
				if last.OutputTokens != 9 || last.CostUSD == nil || *last.CostUSD != 0.5 || last.Model == nil || *last.Model != "claude-test" {
					t.Fatalf("cost cuối = %+v", last)
				}
				return
			}
			if !strings.HasPrefix(res.Error, "Vượt ngân sách: token ") || last.OutputTokens <= maxTok {
				t.Fatalf("lỗi = %q, cost cuối = %+v", res.Error, last)
			}
		})
	}
}

func TestClaudeDefaultCommandPassesBudget(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	usd := 2.5
	cmd, err := (Runner{}).cliCommand(Job{CLI: "claude", Prompt: "p", Budget: Budget{MaxCostUSD: &usd}})
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Join(cmd.Args[1:], " ")
	if !strings.HasPrefix(got, "-p p --output-format stream-json --verbose --setting-sources project --strict-mcp-config --mcp-config ") || !strings.HasSuffix(got, " --max-budget-usd 2.5") {
		t.Fatalf("lệnh = %s", got)
	}
	path := cmd.Args[len(cmd.Args)-3]
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
}
