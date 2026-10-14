package runner

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

var savingEnvNames = []string{
	"BASH_MAX_OUTPUT_LENGTH", "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_SUBAGENT_MODEL",
	"CLAUDE_CODE_PROMPT_CACHE_TTL", "CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL", "MAX_MCP_OUTPUT_TOKENS",
	"CLAUDE_CODE_AUTO_COMPACT_WINDOW", "CLAUDE_CODE_DISABLE_BUNDLED_SKILLS", "CLAUDE_CODE_DISABLE_AUTO_MEMORY",
	"CLAUDE_CODE_DISABLE_WORKFLOWS", "CLAUDE_CODE_DISABLE_CFC_PROMPT", "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS",
}

func TestSavingEnvDefaults(t *testing.T) {
	want := map[string]string{
		"BASH_MAX_OUTPUT_LENGTH":                "15000",
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":       "70",
		"CLAUDE_CODE_SUBAGENT_MODEL":            "sonnet",
		"CLAUDE_CODE_PROMPT_CACHE_TTL":          "5m",
		"CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL": "5m",
		"MAX_MCP_OUTPUT_TOKENS":                 "15000",
		// Không có phiên bản claude (claudeVersion rỗng) nên chỉ có biến không cần kiểm phiên bản.
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW":         "200000",
		"CLAUDE_CODE_DISABLE_BUNDLED_SKILLS":      "1",
		"CLAUDE_CODE_DISABLE_AUTO_MEMORY":         "1",
		"CLAUDE_CODE_DISABLE_WORKFLOWS":           "1",
		"CLAUDE_CODE_DISABLE_CFC_PROMPT":          "1",
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "15000",
	}
	// Hub cũ (nil) và spec thiếu trường (số 0, chuỗi rỗng) đều ra mặc định.
	for name, job := range map[string]*TokenSavingJob{"hub cũ": nil, "spec thiếu trường": {Enabled: true}} {
		got := savingEnv(TokenSavingConfig{}, Job{CLI: "claude", TokenSaving: job})
		if len(got) != len(want) {
			t.Fatalf("%s: %v", name, got)
		}
		for k, v := range want {
			if got[k] != v {
				t.Fatalf("%s: %s = %q, muốn %q", name, k, got[k], v)
			}
		}
	}
}

func TestSavingEnvOverrides(t *testing.T) {
	job := Job{CLI: "claude", TokenSaving: &TokenSavingJob{Enabled: true, BashMaxChars: 8000, AutocompactPct: 60, SubagentModel: "haiku", CacheTTL: "1h"}}
	got := savingEnv(TokenSavingConfig{Env: map[string]string{"BASH_MAX_OUTPUT_LENGTH": "20000", "MAX_MCP_OUTPUT_TOKENS": ""}}, job)
	// Cấu hình máy thắng spec hub; "" bỏ hẳn biến.
	if got["BASH_MAX_OUTPUT_LENGTH"] != "20000" || got["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "60" || got["CLAUDE_CODE_SUBAGENT_MODEL"] != "haiku" {
		t.Fatalf("env = %v", got)
	}
	if got["CLAUDE_CODE_PROMPT_CACHE_TTL"] != "1h" || got["CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL"] != "1h" {
		t.Fatalf("TTL = %v", got)
	}
	if _, ok := got["MAX_MCP_OUTPUT_TOKENS"]; ok {
		t.Fatalf("biến để trống phải bị bỏ: %v", got)
	}
}

func TestSavingEnvOff(t *testing.T) {
	on := &TokenSavingJob{Enabled: true}
	cases := map[string]struct {
		cfg TokenSavingConfig
		job Job
	}{
		"máy tắt":                   {TokenSavingConfig{Off: true}, Job{CLI: "claude", TokenSaving: on}},
		"dự án tắt":                 {TokenSavingConfig{}, Job{CLI: "claude", TokenSaving: &TokenSavingJob{Enabled: false}}},
		"codex không có biến":       {TokenSavingConfig{}, Job{CLI: "codex", TokenSaving: on}},
		"antigravity không có biến": {TokenSavingConfig{}, Job{CLI: "antigravity", TokenSaving: on}},
	}
	for name, c := range cases {
		if got := savingEnv(c.cfg, c.job); got != nil {
			t.Fatalf("%s: env = %v", name, got)
		}
	}
}

func TestTokenSavingFromEnv(t *testing.T) {
	cases := []struct {
		raw     string
		off     bool
		env     map[string]string
		wantErr bool
	}{
		{raw: ""},
		{raw: "off", off: true},
		{raw: " OFF ", off: true},
		{raw: `{"BASH_MAX_OUTPUT_LENGTH":"9000"}`, env: map[string]string{"BASH_MAX_OUTPUT_LENGTH": "9000"}},
		{raw: "bậy", wantErr: true},
	}
	for _, c := range cases {
		t.Setenv(TokenSavingEnv, c.raw)
		got, err := TokenSavingFromEnv()
		if (err != nil) != c.wantErr || got.Off != c.off || len(got.Env) != len(c.env) {
			t.Fatalf("%q: %+v, %v", c.raw, got, err)
		}
		for k, v := range c.env {
			if got.Env[k] != v {
				t.Fatalf("%q: %+v", c.raw, got)
			}
		}
	}
}

// runSaving chạy một run claude với CLI giả và trả các biến mà CLI nhận được.
func runSaving(t *testing.T, r Runner, job Job) (map[string]string, []Event) {
	t.Helper()
	remote, base := makeRemote(t)
	r.DataDir = t.TempDir()
	r.CLICommands = map[string]Command{"claude": fakeCommands("saving-env")["codex"]}
	job.RunID, job.Attempt, job.RepoURL, job.BaseBranch, job.Branch, job.CLI, job.Prompt = "sav", 1, fileURL(remote), base, "ai/sav", "claude", "p"
	job.Timeout = 30 * time.Second
	job.Env = mergeMap(map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "saving-env"}, job.Env)
	var events []Event
	if err := r.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil })); err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, line := range strings.Split(logText(events), "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "SAVING "); ok {
			k, v, _ := strings.Cut(rest, "=")
			got[k] = v
		}
	}
	return got, events
}

func TestRunPassesSavingEnvToClaude(t *testing.T) {
	got, _ := runSaving(t, Runner{TokenSaving: &TokenSavingConfig{}}, Job{})
	if got["BASH_MAX_OUTPUT_LENGTH"] != "15000" || got["CLAUDE_CODE_SUBAGENT_MODEL"] != "sonnet" || got["CLAUDE_CODE_PROMPT_CACHE_TTL"] != "5m" {
		t.Fatalf("CLI nhận %v", got)
	}
}

// job.Env do dự án đặt thắng mặc định.
func TestRunProjectEnvBeatsSavingDefaults(t *testing.T) {
	got, _ := runSaving(t, Runner{TokenSaving: &TokenSavingConfig{}}, Job{Env: map[string]string{"BASH_MAX_OUTPUT_LENGTH": "42000"}})
	if got["BASH_MAX_OUTPUT_LENGTH"] != "42000" || got["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "70" {
		t.Fatalf("CLI nhận %v", got)
	}
}

func TestRunWithSavingOffSetsNothing(t *testing.T) {
	for _, k := range savingEnvNames {
		t.Setenv(k, "") // tránh môi trường chạy test đã đặt sẵn
	}
	got, _ := runSaving(t, Runner{TokenSaving: &TokenSavingConfig{Off: true}}, Job{})
	for _, k := range savingEnvNames {
		if got[k] != "" {
			t.Fatalf("%s = %q, muốn không đặt", k, got[k])
		}
	}
}

// Biến HIVE_WORKER_TOKEN_SAVING hỏng không làm hỏng run: dùng mặc định và báo vào log.
func TestRunBadSavingEnvFallsBackToDefaults(t *testing.T) {
	t.Setenv(TokenSavingEnv, "bậy")
	got, events := runSaving(t, Runner{}, Job{})
	if got["BASH_MAX_OUTPUT_LENGTH"] != "15000" || !strings.Contains(logText(events), "Bỏ qua cấu hình tiết kiệm token") {
		t.Fatalf("CLI nhận %v, log %q", got, logText(events))
	}
}

func TestSavingEnvNotSentToCodex(t *testing.T) {
	for _, k := range savingEnvNames {
		t.Setenv(k, "") // máy dev có thể đã đặt sẵn các biến này
	}
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), CLICommands: fakeCommands("saving-env"), TokenSaving: &TokenSavingConfig{}}
	err := r.Run(context.Background(), Job{RunID: "cx", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/cx", CLI: "codex", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "saving-env"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(logText(events), "BASH_MAX_OUTPUT_LENGTH=15000") {
		t.Fatalf("codex nhận biến của claude: %q", logText(events))
	}
}

// Sự kiện cost mang id gói đã giữ cho run, để hub tính token theo gói; không có gói thì bỏ trống.
func TestCostEventCarriesAccountID(t *testing.T) {
	quoted, _ := json.Marshal(codexLogin(t))
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"codex-3","cli":"codex","configDir":`+string(quoted)+`,"enabled":true,"maxConcurrent":1}]}`))
	lease, err := pool.Acquire("codex", accounts.RoleImplement)
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v, %v", lease, err)
	}
	defer lease.Release()
	for name, account := range map[string]*accounts.Lease{"có gói": lease, "đăng nhập mặc định": nil} {
		remote, base := makeRemote(t)
		var events []Event
		// Lease của codex chỉ dùng lấy id; CLI giả in usage kiểu claude nên job chạy dưới tên claude.
		r := Runner{DataDir: t.TempDir(), CLICommands: map[string]Command{"claude": fakeCommands("usage-ok")["codex"]}, Account: account, TokenSaving: &TokenSavingConfig{Off: true}}
		err := r.Run(context.Background(), Job{RunID: "acid", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/acid", CLI: "claude", Prompt: "p", Timeout: 30 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "usage-ok"}}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
		if err != nil {
			t.Fatal(err)
		}
		var last *Usage
		for _, e := range events {
			if e.Type == "cost" {
				last = e.Cost
			}
		}
		want := ""
		if account != nil {
			want = "codex-3"
		}
		if last == nil || last.AccountID != want {
			t.Fatalf("%s: cost cuối = %+v, muốn accountId %q", name, last, want)
		}
	}
}
