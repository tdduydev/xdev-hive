package runner

import (
	"slices"
	"testing"
)

func TestLocalEnv(t *testing.T) {
	t.Setenv("HIVE_MACHINE_TOKEN", "machine-secret-1")
	t.Setenv("GITHUB_TOKEN", "ghp-secret-12345")
	t.Setenv("OPENAI_API_KEY", "sk-openai-12345")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-12345")
	t.Setenv("LANG", "vi_VN.UTF-8")

	env, secrets := LocalEnv("codex", nil, map[string]string{"TERM": "xterm-256color"})
	for _, bad := range []string{"HIVE_MACHINE_TOKEN=machine-secret-1", "GITHUB_TOKEN=ghp-secret-12345", "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-12345"} {
		if slices.Contains(env, bad) {
			t.Fatalf("lọt %s", bad)
		}
	}
	for _, want := range []string{"OPENAI_API_KEY=sk-openai-12345", "LANG=vi_VN.UTF-8", "TERM=xterm-256color"} {
		if !slices.Contains(env, want) {
			t.Fatalf("thiếu %s", want)
		}
	}
	if !slices.Equal(secrets, []string{"sk-openai-12345"}) {
		t.Fatalf("secrets = %v", secrets)
	}

	// Có gói: không giữ biến đăng nhập mặc định, env gói thắng over.
	env, secrets = LocalEnv("claude", map[string]string{"CLAUDE_CONFIG_DIR": "/goi", "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-goi-123"},
		map[string]string{"CLAUDE_CONFIG_DIR": "/khac"})
	if slices.Contains(env, "OPENAI_API_KEY=sk-openai-12345") || !slices.Contains(env, "CLAUDE_CONFIG_DIR=/goi") ||
		!slices.Contains(env, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-goi-123") {
		t.Fatalf("env có gói = %v", env)
	}
	if !slices.Equal(secrets, []string{"sk-ant-goi-123"}) {
		t.Fatalf("secrets có gói = %v", secrets)
	}
}
