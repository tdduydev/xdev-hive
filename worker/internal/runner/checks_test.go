package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func skipWindowsShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("lệnh mẫu viết cho sh")
	}
}

func TestRedactSecrets(t *testing.T) {
	for _, tc := range []struct{ name, in, leak string }{
		{"github", "push ghp_abcdefghijklmnopqrstuvwxyz0123456789 xong", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"},
		{"gán biến", "API_TOKEN=abc123xyz789", "abc123xyz789"},
		{"gán có nháy", `password: "hunter2hunter2"`, "hunter2hunter2"},
		{"bearer", "Authorization: Bearer abcdefghijklmnop12345", "abcdefghijklmnop12345"},
		{"url có mật khẩu", "clone https://user:s3cretpass@github.com/o/r.git", "s3cretpass"},
		{"jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "eyJhbGciOiJIUzI1NiJ9"},
		{"khoá riêng", "-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----", "MIIEabc"},
		{"giá trị chính xác", "token của run là run-token-value-9", "run-token-value-9"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := redactSecrets(tc.in, []string{"run-token-value-9"})
			if strings.Contains(got, tc.leak) || !strings.Contains(got, redacted) {
				t.Fatalf("redactSecrets(%q) = %q", tc.in, got)
			}
		})
	}
	if got := redactSecrets("ok 12 tests passed in 3.2s", nil); got != "ok 12 tests passed in 3.2s" {
		t.Fatalf("che nhầm: %q", got)
	}
}

func TestTailBufferKeepsLast200Lines(t *testing.T) {
	var b tailBuffer
	for i := 1; i <= 500; i++ {
		fmt.Fprintf(&b, "dòng %d\n", i)
	}
	lines := strings.Split(b.lines(), "\n")
	if len(lines) != checkTailLines || lines[0] != "dòng 301" || lines[len(lines)-1] != "dòng 500" {
		t.Fatalf("%d dòng, đầu %q, cuối %q", len(lines), lines[0], lines[len(lines)-1])
	}
}

func TestTailBufferBoundsMemoryAndLineLength(t *testing.T) {
	var b tailBuffer
	big := strings.Repeat("x", 300<<10)
	_, _ = b.Write([]byte(big + "\nlast\n"))
	if len(b.buf) > checkTailBufferBytes {
		t.Fatalf("bộ đệm %d byte", len(b.buf))
	}
	if got := b.lines(); !strings.HasSuffix(got, "last") {
		t.Fatalf("tail = %q", got[len(got)-20:])
	}
	var long tailBuffer
	_, _ = long.Write([]byte(strings.Repeat("y", 5000) + "\n"))
	if got := long.lines(); len(got) > checkTailLineBytes+8 {
		t.Fatalf("dòng dài %d byte", len(got))
	}
}

func TestCheckEnvAllowlist(t *testing.T) {
	host := []string{"PATH=/usr/bin", "HOME=/home/u", "ANTHROPIC_API_KEY=sk-ant", "GOOGLE_API_KEY=g", "SSH_AUTH_SOCK=/s", "GOFLAGS=-mod=mod", "GITHUB_TOKEN=t", "NPM_CONFIG_REGISTRY=r", "NPM_CONFIG__AUTHTOKEN=x", "LC_ALL=C"}
	env := checkEnv(host, map[string]string{"HIVE_RUN_TOKEN": "run", "HIVE_MCP_TOKEN": "run", "HIVE_PROJECT": "web"})
	for _, k := range []string{"PATH", "HOME", "GOFLAGS", "NPM_CONFIG_REGISTRY", "LC_ALL", "HIVE_PROJECT", "CI"} {
		if _, ok := env[k]; !ok {
			t.Errorf("thiếu %s", k)
		}
	}
	for _, k := range []string{"ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "SSH_AUTH_SOCK", "GITHUB_TOKEN", "NPM_CONFIG__AUTHTOKEN", "HIVE_RUN_TOKEN", "HIVE_MCP_TOKEN"} {
		if _, ok := env[k]; ok {
			t.Errorf("lọt %s", k)
		}
	}
}

func runChecksIn(t *testing.T, job Job) ([]CommandResult, string, error) {
	t.Helper()
	var log strings.Builder
	res, err := (Runner{KillGrace: time.Second}).runChecks(context.Background(), job, t.TempDir(), &log)
	return res, log.String(), err
}

func TestRunChecksReportsExitTailAndContinuesAfterFailure(t *testing.T) {
	skipWindowsShell(t)
	res, _, err := runChecksIn(t, Job{RunID: "r", Checks: []CheckCommand{
		{Run: "echo ok; echo warn >&2", TimeoutSec: 10},
		{Run: "echo boom; exit 3", TimeoutSec: 10},
		{Run: "echo sau", TimeoutSec: 10},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 3 {
		t.Fatalf("%d kết quả", len(res))
	}
	if res[0].Exit != 0 || !strings.Contains(res[0].Tail, "ok") || !strings.Contains(res[0].Tail, "warn") {
		t.Fatalf("res[0] = %+v", res[0])
	}
	if res[1].Exit != 3 || res[1].Tail != "boom" || res[1].DurationMs < 0 {
		t.Fatalf("res[1] = %+v", res[1])
	}
	if res[2].Exit != 0 || res[2].Run != "echo sau" {
		t.Fatalf("res[2] = %+v", res[2])
	}
}

func TestRunChecksRunsInWorktreeWithAllowlistedEnv(t *testing.T) {
	skipWindowsShell(t)
	t.Setenv("HIVE_TEST_LEAK_TOKEN", "leak-me")
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-leak")
	dir := t.TempDir()
	var log strings.Builder
	res, err := (Runner{KillGrace: time.Second}).runChecks(context.Background(), Job{RunID: "r", Env: map[string]string{"HIVE_RUN_TOKEN": "run-token-xyz", "HIVE_PROJECT": "web"}, Checks: []CheckCommand{
		{Run: `pwd; echo "project=$HIVE_PROJECT ci=$CI"; env | grep -E 'TOKEN|API_KEY' || echo sạch`, TimeoutSec: 10},
	}}, dir, &log)
	if err != nil {
		t.Fatal(err)
	}
	real, _ := filepath.EvalSymlinks(dir)
	if !strings.Contains(res[0].Tail, real) || !strings.Contains(res[0].Tail, "project=web ci=true") || !strings.HasSuffix(res[0].Tail, "sạch") {
		t.Fatalf("tail = %q", res[0].Tail)
	}
}

func TestRunChecksRedactsOutputAndCommand(t *testing.T) {
	skipWindowsShell(t)
	res, log, err := runChecksIn(t, Job{RunID: "r", Env: map[string]string{"HIVE_RUN_TOKEN": "run-token-xyz"}, Checks: []CheckCommand{
		{Run: "echo ghp_abcdefghijklmnopqrstuvwxyz0123456789; echo run-token-xyz; echo DB_PASSWORD=hunter2hunter2", TimeoutSec: 10},
	}})
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"ghp_abcdefghijklmnopqrstuvwxyz0123456789", "run-token-xyz", "hunter2hunter2"} {
		if strings.Contains(res[0].Tail, leak) || strings.Contains(res[0].Run, leak) || strings.Contains(log, leak) {
			t.Fatalf("lộ %q: %+v / %s", leak, res[0], log)
		}
	}
}

func TestRunChecksTimeoutKillsProcessGroup(t *testing.T) {
	skipWindowsShell(t)
	// Dùng 1 giây (nhỏ nhất hợp lệ của spec) để kiểm thời hạn thật; process con `sleep` phải bị dừng cùng shell.
	start := time.Now()
	res, _, err := runChecksIn(t, Job{RunID: "r", Checks: []CheckCommand{
		{Run: "echo bắt đầu; sleep 30 & sleep 30", TimeoutSec: 1},
		{Run: "echo tiếp", TimeoutSec: 10},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(start) > 10*time.Second {
		t.Fatalf("mất %s", time.Since(start))
	}
	if res[0].Exit != -1 || !res[0].TimedOut || !strings.Contains(res[0].Tail, "bắt đầu") || !strings.Contains(res[0].Tail, "quá") {
		t.Fatalf("res[0] = %+v", res[0])
	}
	if res[1].Exit != 0 {
		t.Fatalf("lệnh sau bị ảnh hưởng: %+v", res[1])
	}
}

func TestRunChecksCancelStopsAndReturnsError(t *testing.T) {
	skipWindowsShell(t)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(300*time.Millisecond, cancel)
	var log strings.Builder
	res, err := (Runner{KillGrace: time.Second}).runChecks(ctx, Job{RunID: "r", Checks: []CheckCommand{{Run: "sleep 30", TimeoutSec: 60}, {Run: "echo không chạy", TimeoutSec: 10}}}, t.TempDir(), &log)
	if err == nil || len(res) != 0 {
		t.Fatalf("err = %v, res = %+v", err, res)
	}
}

func TestRunChecksLimitsCountAndSkipsBlank(t *testing.T) {
	skipWindowsShell(t)
	var checks []CheckCommand
	checks = append(checks, CheckCommand{Run: "  "})
	for i := 0; i < 8; i++ {
		checks = append(checks, CheckCommand{Run: fmt.Sprintf("echo %d", i), TimeoutSec: 10})
	}
	res, _, err := runChecksIn(t, Job{RunID: "r", Checks: checks})
	if err != nil {
		t.Fatal(err)
	}
	// Chỉ xét 5 lệnh đầu của spec; lệnh trống không sinh kết quả.
	if len(res) != maxChecks-1 {
		t.Fatalf("%d kết quả", len(res))
	}
}

func TestRunChecksEmptyIsNil(t *testing.T) {
	res, _, err := runChecksIn(t, Job{RunID: "r"})
	if err != nil || res != nil {
		t.Fatalf("res = %v, err = %v", res, err)
	}
}

func TestClampCheckTimeout(t *testing.T) {
	for sec, want := range map[int]time.Duration{0: defaultCheckTimeout, -5: defaultCheckTimeout, 30: 30 * time.Second, 999999: maxCheckTimeout} {
		if got := clampCheckTimeout(sec); got != want {
			t.Errorf("clampCheckTimeout(%d) = %s, muốn %s", sec, got, want)
		}
	}
}

func TestRunnerRunsChecksAfterAgentBeforePush(t *testing.T) {
	skipWindowsShell(t)
	remote, base := makeRemote(t)
	data := t.TempDir()
	marker := filepath.Join(t.TempDir(), "seen-before-push")
	var events []Event
	r := Runner{DataDir: data, CLICommands: fakeCommands("commit")}
	// Hook trước push: lệnh kiểm ghi file đánh dấu cùng lúc kiểm nhánh remote chưa có; lệnh lỗi không chặn push.
	checks := []CheckCommand{
		{Run: fmt.Sprintf("test -f README && git --git-dir=%q show-ref --verify --quiet refs/heads/ai/chk; echo $? > %q; ls; exit 4", remote, marker), TimeoutSec: 20},
	}
	err := r.Run(context.Background(), Job{RunID: "chk", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/chk", CLI: "codex", Prompt: "p", Timeout: 10 * time.Second, Checks: checks,
		Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "commit"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	got := lastResult(events)
	if got == nil || got.Status != "succeeded" || len(got.Commands) != 1 {
		t.Fatalf("result = %#v", got)
	}
	if got.Commands[0].Exit != 4 || !strings.Contains(got.Commands[0].Tail, "README") {
		t.Fatalf("commands = %+v", got.Commands)
	}
	if b, _ := os.ReadFile(marker); strings.TrimSpace(string(b)) != "1" {
		t.Fatalf("lúc chạy lệnh kiểm nhánh đã có trên remote (show-ref exit %q)", b)
	}
	if err := git(context.Background(), remote, "show-ref", "--verify", "--quiet", "refs/heads/ai/chk"); err != nil {
		t.Fatalf("lệnh kiểm lỗi làm mất push: %v", err)
	}
}

func TestRunnerSkipsChecksWithoutCommits(t *testing.T) {
	skipWindowsShell(t)
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("empty")}
	err := r.Run(context.Background(), Job{RunID: "emp", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/emp", CLI: "codex", Prompt: "p", Timeout: 10 * time.Second, Checks: []CheckCommand{{Run: "exit 1", TimeoutSec: 5}},
		Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "empty"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if got := lastResult(events); got == nil || got.Status != "no_changes" || got.Commands != nil {
		t.Fatalf("result = %#v", got)
	}
}

func TestRunnerReadOnlyKindIgnoresChecks(t *testing.T) {
	skipWindowsShell(t)
	remote, base := makeRemote(t)
	must(t, "git", "-C", remote, "branch", "ai/parent", base)
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("empty")}
	err := r.Run(context.Background(), Job{RunID: "rv", Attempt: 1, Kind: KindReview, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/parent", CLI: "codex", Prompt: "p", Timeout: 10 * time.Second, Checks: []CheckCommand{{Run: "exit 1", TimeoutSec: 5}},
		Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "empty"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if got := lastResult(events); got == nil || got.Status != "succeeded" || got.Commands != nil {
		t.Fatalf("result = %#v", got)
	}
}
