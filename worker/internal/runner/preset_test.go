package runner

import (
	"reflect"
	"slices"
	"strings"
	"testing"
)

func TestInteractivePresetClaudeByLevelAndVersion(t *testing.T) {
	base := map[string]string{
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW":         "200000",
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":         "80",
		"BASH_MAX_OUTPUT_LENGTH":                  "15000",
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "15000",
		"MAX_MCP_OUTPUT_TOKENS":                   "15000",
	}
	aggressive := map[string]string{
		"CLAUDE_CODE_AUTO_COMPACT_WINDOW":         "200000",
		"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":         "70",
		"BASH_MAX_OUTPUT_LENGTH":                  "15000",
		"CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "10000",
		"MAX_MCP_OUTPUT_TOKENS":                   "10000",
		"CLAUDE_CODE_SUBAGENT_MODEL":              "sonnet",
	}
	withGated := func(m map[string]string) map[string]string {
		out := map[string]string{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH": "512"}
		for k, v := range m {
			out[k] = v
		}
		return out
	}
	cases := []struct {
		name, version, level string
		env                  map[string]string
		hooks                []string
		exec                 bool
		skipped              []SkipReason
	}{
		{"cân bằng, bản mới", "2.1.296", "balanced", base, []string{"pre-tool", "post-tool"}, true, nil},
		{"mặc định là cân bằng", "2.1.296", "", base, []string{"pre-tool", "post-tool"}, true, nil},
		{"cân bằng, bản cũ", "2.1.250", "balanced", base, []string{"pre-tool"}, false, []SkipReason{
			{"post-tool", "2.1.296"}, {"hook-args", "2.1.296"},
		}},
		{"mạnh, bản mới", "2.1.296", "aggressive", withGated(aggressive), []string{"pre-tool", "post-tool"}, true, nil},
		{"mạnh, bản cũ", "2.1.250", "aggressive", aggressive, []string{"pre-tool"}, false, []SkipReason{
			{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "2.1.257"}, {"CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", "2.1.280"},
			{"post-tool", "2.1.296"}, {"hook-args", "2.1.296"},
		}},
		{"mạnh, bản giữa: có FORCE, chưa cắt mô tả MCP", "2.1.270", "aggressive", func() map[string]string {
			m := map[string]string{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE": "1"}
			for k, v := range aggressive {
				m[k] = v
			}
			return m
		}(), []string{"pre-tool"}, false, []SkipReason{
			{"CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", "2.1.280"}, {"post-tool", "2.1.296"}, {"hook-args", "2.1.296"},
		}},
		// Không đọc được phiên bản: không bật gì có điều kiện, như run.
		{"không rõ phiên bản", "", "aggressive", aggressive, []string{"pre-tool"}, false, []SkipReason{
			{"CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "2.1.257"}, {"CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH", "2.1.280"},
			{"post-tool", "2.1.296"}, {"hook-args", "2.1.296"},
		}},
	}
	for _, c := range cases {
		p := InteractivePreset("claude", c.version, c.level)
		if !reflect.DeepEqual(p.Env, c.env) {
			t.Fatalf("%s: env = %v", c.name, p.Env)
		}
		if !slices.Equal(p.Hooks, c.hooks) || p.HookExec != c.exec {
			t.Fatalf("%s: hooks = %v, exec = %v", c.name, p.Hooks, p.HookExec)
		}
		if !slices.Equal(p.Skipped, c.skipped) {
			t.Fatalf("%s: skipped = %v", c.name, p.Skipped)
		}
		if p.Codex != nil {
			t.Fatalf("%s: claude không có khối codex: %v", c.name, p.Codex)
		}
	}
}

// Các tính năng người dùng cần khi làm tay không được tắt, ở mọi mức và mọi phiên bản.
func TestInteractivePresetKeepsUserFeatures(t *testing.T) {
	for _, level := range []string{"balanced", "aggressive"} {
		for _, v := range []string{"", "2.1.250", "2.1.296", "9.0.0"} {
			p := InteractivePreset("claude", v, level)
			for k := range p.Env {
				if strings.HasPrefix(k, "CLAUDE_CODE_DISABLE_") || strings.Contains(k, "CACHE_TTL") {
					t.Fatalf("%s %q: không được đặt %s", level, v, k)
				}
			}
			if _, ok := p.Env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"]; ok {
				t.Fatalf("%s %q: có DISABLE_AUTO_MEMORY", level, v)
			}
		}
	}
	if _, ok := InteractivePreset("claude", "2.1.296", "balanced").Env["CLAUDE_CODE_SUBAGENT_MODEL"]; ok {
		t.Fatal("mức cân bằng không được đổi model subagent")
	}
}

func TestInteractivePresetCodex(t *testing.T) {
	want := map[string]map[string]string{
		"balanced":   {"tool_output_token_limit": "8000", "model_auto_compact_token_limit": "150000"},
		"aggressive": {"tool_output_token_limit": "6000", "model_auto_compact_token_limit": "120000"},
	}
	for level, w := range want {
		p := InteractivePreset("codex", "", level)
		if !reflect.DeepEqual(p.Codex, w) || p.Env != nil || p.Hooks != nil || p.Skipped != nil {
			t.Fatalf("%s: %+v", level, p)
		}
	}
}

func TestInteractivePresetEmpty(t *testing.T) {
	for _, c := range [][2]string{{"claude", "off"}, {"claude", "turbo"}, {"codex", "off"}, {"gemini", "balanced"}, {"antigravity", "aggressive"}} {
		if p := InteractivePreset(c[0], "2.1.296", c[1]); !reflect.DeepEqual(p, Preset{}) {
			t.Fatalf("%s/%s: %+v", c[0], c[1], p)
		}
	}
}

// Mức cân bằng dùng chung giá trị với run ở các khoá hai bên cùng có (FR-002: một nguồn sự thật).
func TestInteractivePresetSharesRunValues(t *testing.T) {
	run := savingEnv(TokenSavingConfig{}, Job{CLI: "claude", claudeVersion: "2.1.296"})
	p := InteractivePreset("claude", "2.1.296", "balanced")
	for _, k := range []string{"CLAUDE_CODE_AUTO_COMPACT_WINDOW", "BASH_MAX_OUTPUT_LENGTH", "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "MAX_MCP_OUTPUT_TOKENS"} {
		if p.Env[k] != run[k] {
			t.Fatalf("%s: preset %q, run %q", k, p.Env[k], run[k])
		}
	}
	a := InteractivePreset("claude", "2.1.296", "aggressive")
	for _, k := range []string{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH"} {
		if a.Env[k] != run[k] {
			t.Fatalf("%s: preset mạnh %q, run %q", k, a.Env[k], run[k])
		}
	}
	args := strings.Join(savingArgs(TokenSavingConfig{}, Job{CLI: "codex", Kind: "code"}), " ")
	for k, v := range InteractivePreset("codex", "", "balanced").Codex {
		if !strings.Contains(args, k+"="+v) {
			t.Fatalf("run codex thiếu %s=%s: %s", k, v, args)
		}
	}
}

func TestInteractiveHookMatchesRunHooks(t *testing.T) {
	g, err := Runner{DataDir: t.TempDir(), HookExe: "hive-worker"}.prepareGuard(Job{CLI: "claude", Kind: "code", RunID: "r", claudeVersion: "2.1.296"}, "", 4, 12000, false)
	if err != nil || g == nil {
		t.Fatalf("prepareGuard: %v", err)
	}
	defer g.cleanup()
	for _, name := range InteractivePreset("claude", "2.1.296", "balanced").Hooks {
		h, ok := InteractiveHook(name)
		if !ok {
			t.Fatalf("thiếu hook %s", name)
		}
		i := slices.IndexFunc(g.hooks, func(r Hook) bool { return r.Command == name })
		if i < 0 || g.hooks[i].Event != h.Event || g.hooks[i].Matcher != h.Matcher {
			t.Fatalf("%s: preset %+v, run %+v", name, h, g.hooks)
		}
	}
	if _, ok := InteractiveHook("lạ"); ok {
		t.Fatal("hook lạ không được có")
	}
}
