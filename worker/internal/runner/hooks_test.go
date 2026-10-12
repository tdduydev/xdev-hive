package runner

import (
	"context"
	"encoding/json"
	"os/exec"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestClaudeHookSettingsOnlyToolEvents(t *testing.T) {
	got, err := claudeHookSettings([]Hook{
		{Event: "PreToolUse", Name: "chặn xoá", Command: `hive-guard --deny "rm -rf /"`},
		{Event: "PostToolUse", Name: "định dạng", Command: "pnpm exec prettier --write", Matcher: "Edit|Write"},
		{Event: "Stop", Name: "test", Command: "pnpm test"},
	})
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct{ Type, Command string }
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(got), &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Hooks) != 2 || v.Hooks["Stop"] != nil {
		t.Fatalf("hooks = %s", got)
	}
	pre := v.Hooks["PreToolUse"][0]
	if pre.Matcher != "" || pre.Hooks[0].Type != "command" || pre.Hooks[0].Command != `hive-guard --deny "rm -rf /"` {
		t.Fatalf("PreToolUse = %+v", pre)
	}
	if v.Hooks["PostToolUse"][0].Matcher != "Edit|Write" {
		t.Fatalf("PostToolUse = %+v", v.Hooks["PostToolUse"])
	}
	if s, _ := claudeHookSettings([]Hook{{Event: "Stop", Command: "x"}}); s != "" {
		t.Fatalf("chỉ có Stop thì không cần --settings: %q", s)
	}
}

func TestClaudeArgsFollowPolicy(t *testing.T) {
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example/", "HIVE_RUN_TOKEN": "run-secret"}
	argsOf := func(p JobPolicy) []string {
		cmd, err := (Runner{}).cliCommand(Job{CLI: "claude", Prompt: "p", Env: env, Policy: p})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(cmd.cleanup)
		return cmd.Args[1:]
	}
	valueAfter := func(args []string, flag string) (string, bool) {
		for i, a := range args {
			if a == flag && i+1 < len(args) {
				return args[i+1], true
			}
		}
		return "", false
	}
	plain := argsOf(JobPolicy{})
	if v, _ := valueAfter(plain, "--setting-sources"); v != "project" {
		t.Fatalf("mặc định nạp cấu hình của repo: %v", plain)
	}
	if _, ok := valueAfter(plain, "--settings"); ok {
		t.Fatalf("không có hook thì không thêm --settings: %v", plain)
	}
	managed := argsOf(JobPolicy{ManagedHooksOnly: true, Hooks: []Hook{{Event: "PreToolUse", Name: "g", Command: "guard"}}})
	if v, ok := valueAfter(managed, "--setting-sources"); !ok || v != "" {
		t.Fatalf("chỉ hook của tổ chức thì không nạp nguồn nào: %v", managed)
	}
	if v, _ := valueAfter(managed, "--settings"); !strings.Contains(v, `"command":"guard"`) {
		t.Fatalf("--settings = %q", v)
	}
}

func TestHookEnvDropsSecrets(t *testing.T) {
	got := hookEnv(map[string]string{"HIVE_RUN_TOKEN": "t", "HIVE_MCP_TOKEN": "t", "HIVE_HUB_URL": "u", "DB_PASSWORD": "p", "X_SECRET": "s", "HIVE_PROJECT": "PAY"})
	if len(got) != 2 || got["HIVE_HUB_URL"] != "u" || got["HIVE_PROJECT"] != "PAY" {
		t.Fatalf("env = %v", got)
	}
}

func TestStopHooksRunInWorktreeAndStopOnFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("lệnh hook trong test viết cho sh")
	}
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("không có sh")
	}
	work := t.TempDir()
	var out, errOut strings.Builder
	job := Job{RunID: "r", Env: map[string]string{"HIVE_RUN_TOKEN": "bí-mật"}, Policy: JobPolicy{Hooks: []Hook{
		{Event: "PreToolUse", Name: "không chạy ở đây", Command: "echo PRE"},
		{Event: "Stop", Name: "in thư mục", Command: `pwd; echo "token=${HIVE_RUN_TOKEN:-none}"`},
		{Event: "Stop", Name: "test hỏng", Command: "echo hỏng >&2; exit 3"},
		{Event: "Stop", Name: "không tới", Command: "echo SAU"},
	}}}
	err := (Runner{}).runStopHooks(context.Background(), job, work, &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), `"test hỏng"`) {
		t.Fatalf("err = %v", err)
	}
	logs := out.String()
	if strings.Contains(logs, "PRE") || strings.Contains(logs, "SAU") {
		t.Fatalf("chạy sai hook: %q", logs)
	}
	if !strings.Contains(logs, "token=none") || !strings.Contains(logs, "[xdev-hive] Hook Stop của tổ chức: in thư mục") {
		t.Fatalf("log = %q", logs)
	}
	if !strings.Contains(errOut.String(), "hỏng") {
		t.Fatalf("stderr = %q", errOut.String())
	}
}

func TestRunnerFailsWithoutPushWhenStopHookFails(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("lệnh hook trong test viết cho sh")
	}
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("commit")}
	err := r.Run(context.Background(), Job{RunID: "hook", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/hook", CLI: "codex", Prompt: "p", Timeout: 5 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "commit"}, Policy: JobPolicy{Hooks: []Hook{{Event: "Stop", Name: "test nhanh", Command: "exit 1"}}}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err == nil {
		t.Fatal("hook Stop lỗi thì run lỗi")
	}
	got := lastResult(events)
	if got == nil || got.Status != "failed" || !strings.Contains(got.Error, `"test nhanh"`) {
		t.Fatalf("result = %#v", got)
	}
	if exec.Command("git", "--git-dir", remote, "show-ref", "--verify", "--quiet", "refs/heads/ai/hook").Run() == nil {
		t.Fatal("hook Stop lỗi mà vẫn push")
	}
	var warned bool
	for _, e := range events {
		if e.Type == "log" && strings.Contains(string(e.Data), "Hook Stop của tổ chức: test nhanh") {
			warned = true
		}
	}
	if !warned {
		t.Fatal("log của run thiếu dòng hook Stop")
	}
}
