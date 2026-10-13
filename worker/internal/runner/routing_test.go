package runner

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestParseAndCompareClaudeVersion(t *testing.T) {
	for raw, want := range map[string]string{"2.1.296 (Claude Code)\n": "2.1.296", "claude 10.0": "10.0", "lỗi": ""} {
		if got := parseClaudeVersion(raw); got != want {
			t.Fatalf("parse %q = %q, muốn %q", raw, got, want)
		}
	}
	for _, c := range []struct {
		a, b string
		sign int
	}{{"2.1.296", "2.1.296", 0}, {"2.1.296", "2.1.257", 1}, {"2.1.9", "2.1.10", -1}, {"2.2", "2.1.999", 1}, {"3", "2.9.9", 1}} {
		got := compareVersions(c.a, c.b)
		if (got > 0) != (c.sign > 0) || (got < 0) != (c.sign < 0) {
			t.Fatalf("compare(%s, %s) = %d, muốn dấu %d", c.a, c.b, got, c.sign)
		}
	}
}

func TestClaudeSupportsByVersion(t *testing.T) {
	cases := []struct {
		version, feature string
		want             bool
	}{
		{"2.1.296", "--max-turns", true},
		{"2.1.295", "--max-turns", false},
		{"", "--max-turns", false}, // không biết phiên bản: không bật cờ có điều kiện
		{"2.1.280", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", true},
		{"2.1.279", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", false},
		{"2.1.257", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", true},
		{"2.1.256", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", false},
		{"", "CLAUDE_CODE_DISABLE_WORKFLOWS", true}, // không có trong bảng: luôn bật
	}
	for _, c := range cases {
		if got := claudeSupports(c.version, c.feature); got != c.want {
			t.Fatalf("claudeSupports(%q, %q) = %v", c.version, c.feature, got)
		}
	}
}

func TestSavingEnvGatedByVersion(t *testing.T) {
	gated := []string{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH"}
	got := savingEnv(TokenSavingConfig{}, Job{CLI: "claude", claudeVersion: "2.1.296"})
	if got["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"] != "1" || got["CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH"] != "512" {
		t.Fatalf("bản đủ phiên bản: %v", got)
	}
	for _, v := range []string{"", "2.1.200"} {
		got := savingEnv(TokenSavingConfig{}, Job{CLI: "claude", claudeVersion: v})
		for _, k := range gated {
			if _, ok := got[k]; ok {
				t.Fatalf("version %q không được đặt %s", v, k)
			}
		}
	}
	// Cấu hình máy vẫn bỏ được biến có điều kiện.
	got = savingEnv(TokenSavingConfig{Env: map[string]string{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": ""}}, Job{CLI: "claude", claudeVersion: "2.1.296"})
	if _, ok := got["CLAUDE_CODE_SUBAGENT_MODEL_FORCE"]; ok {
		t.Fatalf("máy bỏ biến mà vẫn đặt: %v", got)
	}
}

func TestSavingEnvAutocompactWindowFromSpec(t *testing.T) {
	got := savingEnv(TokenSavingConfig{}, Job{CLI: "claude", TokenSaving: &TokenSavingJob{Enabled: true, AutocompactWindow: 120000}})
	if got["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] != "120000" {
		t.Fatalf("env = %v", got)
	}
}

func TestSavingArgsClaude(t *testing.T) {
	join := func(a []string) string { return strings.Join(a, " ") }
	code := Job{CLI: "claude", Kind: "code", claudeVersion: "2.1.296"}
	got := join(savingArgs(TokenSavingConfig{}, code))
	for _, want := range []string{"--exclude-dynamic-system-prompt-sections", "--tools Bash,Read,Edit,Write,Grep,Glob", "--disallowedTools WebFetch,WebSearch"} {
		if !strings.Contains(got, want) {
			t.Fatalf("thiếu %q: %s", want, got)
		}
	}
	if strings.Contains(got, "MultiEdit") {
		t.Fatalf("MultiEdit không có trong claude 2.1.296: %s", got)
	}
	web := code
	web.TokenSaving = &TokenSavingJob{Enabled: true, AllowWeb: true}
	if got := join(savingArgs(TokenSavingConfig{}, web)); strings.Contains(got, "--disallowedTools") || !strings.Contains(got, "--tools") {
		t.Fatalf("dự án bật web: %s", got)
	}
	// Run chỉ đọc không bị giới hạn tool, chỉ giữ cờ prompt.
	review := code
	review.Kind = KindReview
	if got := join(savingArgs(TokenSavingConfig{}, review)); got != "--exclude-dynamic-system-prompt-sections" {
		t.Fatalf("run review: %s", got)
	}
	for name, job := range map[string]Job{
		"phiên bản cũ":         {CLI: "claude", Kind: "code", claudeVersion: "2.1.100"},
		"không biết phiên bản": {CLI: "claude", Kind: "code"},
	} {
		if got := savingArgs(TokenSavingConfig{}, job); len(got) != 0 {
			t.Fatalf("%s: %v", name, got)
		}
	}
	if got := savingArgs(TokenSavingConfig{Off: true}, code); got != nil {
		t.Fatalf("máy tắt: %v", got)
	}
	off := code
	off.TokenSaving = &TokenSavingJob{Enabled: false}
	if got := savingArgs(TokenSavingConfig{}, off); got != nil {
		t.Fatalf("dự án tắt: %v", got)
	}
}

func TestSavingArgsCodex(t *testing.T) {
	got := strings.Join(savingArgs(TokenSavingConfig{}, Job{CLI: "codex", Kind: "code"}), " ")
	for _, want := range []string{
		`model_reasoning_summary="none"`, `model_verbosity="low"`, "hide_agent_reasoning=true", "tool_output_token_limit=8000",
		"model_auto_compact_token_limit=150000", `agents.default_subagent_reasoning_effort="low"`, `web_search="disabled"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("thiếu %q: %s", want, got)
		}
	}
	if got := strings.Join(savingArgs(TokenSavingConfig{}, Job{CLI: "codex", Kind: "code", TokenSaving: &TokenSavingJob{Enabled: true, AllowWeb: true}}), " "); strings.Contains(got, "web_search") {
		t.Fatalf("dự án bật web: %s", got)
	}
	if got := strings.Join(savingArgs(TokenSavingConfig{}, Job{CLI: "codex", Kind: KindReview}), " "); strings.Contains(got, "web_search") {
		t.Fatalf("run review không đổi web_search: %s", got)
	}
	if got := savingArgs(TokenSavingConfig{Off: true}, Job{CLI: "codex", Kind: "code"}); got != nil {
		t.Fatalf("máy tắt: %v", got)
	}
	if got := savingArgs(TokenSavingConfig{}, Job{CLI: "gemini", Kind: "code"}); got != nil {
		t.Fatalf("gemini không nhận: %v", got)
	}
}

func TestRoutingEnvEffort(t *testing.T) {
	if got := routingEnv(Job{CLI: "claude", Effort: "high"}); got["CLAUDE_CODE_EFFORT_LEVEL"] != "high" {
		t.Fatalf("env = %v", got)
	}
	for _, j := range []Job{{CLI: "claude"}, {CLI: "claude", Effort: "bậy"}, {CLI: "codex", Effort: "high"}} {
		if got := routingEnv(j); got != nil {
			t.Fatalf("%+v: %v", j, got)
		}
	}
}

func claudeArgs(t *testing.T, j Job) (string, string) {
	t.Helper()
	t.Setenv(CLIOverridesEnv, "")
	for _, k := range telemetryEnv {
		t.Setenv(k, "")
	}
	j.CLI = "claude"
	j.Prompt = "p"
	cmd, err := (Runner{}).cliCommand(j)
	if err != nil {
		t.Fatal(err)
	}
	defer cmd.cleanup()
	return strings.Join(cmd.Args[1:], " "), cmd.notice
}

func TestClaudeRoutingFlags(t *testing.T) {
	turns := 120
	args, notice := claudeArgs(t, Job{claudeVersion: "2.1.296", Advisor: "opus", Budget: Budget{MaxTurns: &turns}})
	if !strings.Contains(args, "--max-turns 120") || !strings.Contains(args, "--advisor opus") || notice != "" {
		t.Fatalf("lệnh = %s, notice = %q", args, notice)
	}
	// Phiên bản chưa đủ hay không rõ: bỏ cả hai cờ thay vì làm CLI thoát vì cờ lạ.
	for _, v := range []string{"", "2.1.100"} {
		args, _ := claudeArgs(t, Job{claudeVersion: v, Advisor: "opus", Budget: Budget{MaxTurns: &turns}})
		if strings.Contains(args, "--max-turns") || strings.Contains(args, "--advisor") {
			t.Fatalf("version %q: %s", v, args)
		}
	}
	args, _ = claudeArgs(t, Job{claudeVersion: "2.1.296"})
	if strings.Contains(args, "--max-turns") || strings.Contains(args, "--advisor") {
		t.Fatalf("không có trần lượt hay cố vấn thì không có cờ: %s", args)
	}
}

func TestClaudeAdvisorDroppedWhenTelemetryOff(t *testing.T) {
	for _, k := range telemetryEnv {
		t.Run(k, func(t *testing.T) {
			args, notice := claudeArgs(t, Job{claudeVersion: "2.1.296", Advisor: "opus", Env: map[string]string{k: "1"}})
			if strings.Contains(args, "--advisor") || !strings.Contains(notice, "Bỏ --advisor opus") {
				t.Fatalf("lệnh = %s, notice = %q", args, notice)
			}
		})
	}
}

func TestClaudeCommandCarriesSavingFlags(t *testing.T) {
	args, _ := claudeArgs(t, Job{claudeVersion: "2.1.296", Kind: "code", cliArgs: savingArgs(TokenSavingConfig{}, Job{CLI: "claude", Kind: "code", claudeVersion: "2.1.296"})})
	if !strings.Contains(args, "--tools Bash,Read,Edit,Write,Grep,Glob") || !strings.Contains(args, "--exclude-dynamic-system-prompt-sections") {
		t.Fatalf("lệnh = %s", args)
	}
}

func TestCodexRoutingEffort(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	cmd, err := (Runner{}).cliCommand(Job{CLI: "codex", Prompt: "p", Effort: "high", cliArgs: savingArgs(TokenSavingConfig{}, Job{CLI: "codex", Kind: "code"})})
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(cmd.Args[1:], " ")
	if !strings.Contains(args, `model_reasoning_effort="high"`) || !strings.Contains(args, "tool_output_token_limit=8000") {
		t.Fatalf("lệnh = %s", args)
	}
	cmd, err = (Runner{}).cliCommand(Job{CLI: "codex", Prompt: "p", Effort: "bậy"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(cmd.Args, " "), "model_reasoning_effort") {
		t.Fatalf("effort sai vẫn được truyền: %v", cmd.Args)
	}
}

func TestCliStopReason(t *testing.T) {
	turns, usd := 60, 1.5
	cases := []struct {
		subtype string
		budget  Budget
		want    string
	}{
		{"error_max_turns", Budget{MaxTurns: &turns}, "Vượt ngân sách: chạm giới hạn 60 lượt của run"},
		{"error_max_turns", Budget{}, "Vượt ngân sách: chạm giới hạn số lượt của run."},
		{"error_max_budget_usd", Budget{MaxCostUSD: &usd}, "Vượt ngân sách: chạm trần chi phí $1.5000 của run."},
		{"", Budget{}, ""},
		{"success", Budget{}, ""},
	}
	for _, c := range cases {
		if got := cliStopReason(c.subtype, c.budget); !strings.HasPrefix(got, c.want) || (c.want == "") != (got == "") {
			t.Fatalf("cliStopReason(%q) = %q", c.subtype, got)
		}
	}
}

func TestClaudeUsageReportsStopSubtype(t *testing.T) {
	m := newMeter("claude", Budget{}, func(Usage) error { return nil }, nil)
	_, _ = m.Write([]byte(`{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":2,"usage":{"input_tokens":1,"output_tokens":1}}` + "\n"))
	if got := m.stopSubtype(); got != "error_max_turns" {
		t.Fatalf("subtype = %q", got)
	}
	ok := newMeter("claude", Budget{}, func(Usage) error { return nil }, nil)
	_, _ = ok.Write([]byte(`{"type":"result","subtype":"success","num_turns":2,"usage":{"input_tokens":1,"output_tokens":1}}` + "\n"))
	if got := ok.stopSubtype(); got != "" {
		t.Fatalf("run thành công không có lý do dừng: %q", got)
	}
	// Codex không báo lý do dừng.
	if got := newMeter("codex", Budget{}, func(Usage) error { return nil }, nil).stopSubtype(); got != "" {
		t.Fatalf("codex: %q", got)
	}
}

// CLI giả tự dừng vì giới hạn: run kết thúc "failed" với lý do tiếng Việt nêu đúng giới hạn.
func TestRunReportsClaudeLimitStop(t *testing.T) {
	remote, base := makeRemote(t)
	claude := map[string]Command{"claude": {Path: os.Args[0], Args: []string{"-test.run=TestFakeCLIHelper", "--", "helper"}}}
	turns, usd := 30, 0.5
	for _, tc := range []struct {
		mode   string
		budget Budget
		want   string
	}{
		{"max-turns", Budget{MaxTurns: &turns}, "Vượt ngân sách: chạm giới hạn 30 lượt của run"},
		{"max-budget", Budget{MaxCostUSD: &usd}, "Vượt ngân sách: chạm trần chi phí $0.5000 của run."},
	} {
		t.Run(tc.mode, func(t *testing.T) {
			var events []Event
			r := Runner{DataDir: t.TempDir(), CLICommands: claude, KillGrace: 2 * time.Second}
			job := Job{RunID: tc.mode, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/" + tc.mode, CLI: "claude", Timeout: 20 * time.Second, Budget: tc.budget, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": tc.mode}}
			_ = r.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
			res := lastResult(events)
			if res == nil || res.Status != "failed" || !strings.HasPrefix(res.Error, tc.want) {
				t.Fatalf("result = %+v", res)
			}
		})
	}
}

// Máy không cài claude thì bỏ qua; có thì lệnh thật phải ra số phiên bản đọc được.
func TestDetectClaudeVersionWithRealCLI(t *testing.T) {
	if _, err := exec.LookPath("claude"); err != nil {
		t.Skip("không có claude trong PATH")
	}
	if v := detectClaudeVersion(context.Background()); compareVersions(v, "2") < 0 {
		t.Fatalf("version = %q", v)
	}
}
