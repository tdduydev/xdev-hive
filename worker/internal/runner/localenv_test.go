package runner

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

// claudeLease giữ gói Claude của accounts.json; configDir rỗng là đăng nhập mặc định trong home.
func claudeLease(t *testing.T, home, configDir, token string) *accounts.Lease {
	t.Helper()
	dir := home
	if configDir != "" {
		dir = configDir
	}
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"a@b.c"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if token != "" {
		if err := os.WriteFile(filepath.Join(dir, ".oauth-token"), []byte(token), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	quoted, _ := json.Marshal(configDir)
	pool := accounts.NewPool(writeAccounts(t, `{"accounts":[{"id":"claude-1","cli":"claude","configDir":`+string(quoted)+`,"enabled":true,"maxConcurrent":1}]}`))
	lease, err := pool.AcquireInteractive("claude", "claude-1")
	if err != nil || lease == nil {
		t.Fatalf("acquire = %v, %v", lease, err)
	}
	t.Cleanup(lease.Release)
	return lease
}

func TestLocalEnv(t *testing.T) {
	t.Setenv("HIVE_MACHINE_TOKEN", "machine-secret-1")
	t.Setenv("GITHUB_TOKEN", "ghp-secret-12345")
	t.Setenv("OPENAI_API_KEY", "sk-openai-12345")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-12345")
	t.Setenv("LANG", "vi_VN.UTF-8")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

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
	goi := t.TempDir()
	env, secrets = LocalEnv("claude", claudeLease(t, home, goi, "sk-ant-goi-123"), map[string]string{"CLAUDE_CONFIG_DIR": "/khac"})
	if slices.Contains(env, "OPENAI_API_KEY=sk-openai-12345") || !slices.Contains(env, "CLAUDE_CONFIG_DIR="+goi) ||
		!slices.Contains(env, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-goi-123") {
		t.Fatalf("env có gói = %v", env)
	}
	if !slices.Equal(secrets, []string{"sk-ant-goi-123"}) {
		t.Fatalf("secrets có gói = %v", secrets)
	}
}

// Gói đăng nhập mặc định trong shell của gói khác: bỏ CLAUDE_CONFIG_DIR và token kế thừa, nếu không phiên chạy bằng tài
// khoản của gói kia.
func TestLocalEnvDefaultAccountDropsInheritedLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("CLAUDE_CONFIG_DIR", "/goi-khac")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat-khac")
	env, _ := LocalEnv("claude", claudeLease(t, home, "", ""), nil)
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		if name == "CLAUDE_CONFIG_DIR" || name == "CLAUDE_CODE_OAUTH_TOKEN" {
			t.Fatalf("lọt %s", kv)
		}
	}
	// Không có accounts.json (lease nil): giữ nguyên, máy đăng nhập bằng chính các biến này.
	env, _ = LocalEnv("claude", nil, nil)
	if !slices.Contains(env, "CLAUDE_CONFIG_DIR=/goi-khac") || !slices.Contains(env, "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-khac") {
		t.Fatalf("không gói mà mất biến đăng nhập: %v", env)
	}
}
