package gitexec

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func gitT(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// isolateGit để test không đọc cấu hình git của người chạy test (hook, credential, autocrlf…).
func isolateGit(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
}

func TestNativeGitKeepsConfiguredHelperAndStripsHiveSecrets(t *testing.T) {
	isolateGit(t)
	gitT(t, "", "config", "--global", "credential.helper", "test-helper")
	native := Git{UseGitCredentials: true, Askpass: "hive-askpass", Token: "hive-secret"}
	out, err := native.Run(context.Background(), "", "", "config", "--get", "credential.helper")
	if err != nil || strings.TrimSpace(out) != "test-helper" {
		t.Fatalf("native helper = %q, %v", out, err)
	}
	out, err = (Git{}).Run(context.Background(), "", "", "config", "--get", "credential.helper")
	if err != nil || strings.TrimSpace(out) != "" {
		t.Fatalf("token mode helper = %q, %v", out, err)
	}
	t.Setenv(TokenEnv, "secret")
	t.Setenv(TokensEnv, "secret")
	t.Setenv("GIT_ASKPASS", "hive-askpass")
	for _, kv := range native.env("git.test") {
		if strings.Contains(kv, "secret") || strings.Contains(kv, "hive-askpass") || strings.HasPrefix(kv, "HIVE_GIT_") {
			t.Fatalf("secret/askpass passed to native Git: %q", kv)
		}
	}
}

func TestNativeGitAuthenticatesThroughMachineHelper(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("helper giả dùng sh chỉ chạy trên Unix")
	}
	isolateGit(t)
	gitT(t, "", "config", "--global", "credential.helper", `!f() { printf 'username=test\npassword=helper-secret\n'; }; f`)
	var authenticated atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok {
			w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		authenticated.Store(user == "test" && pass == "helper-secret")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte("helper-secret"))
	}))
	defer srv.Close()
	_, err := (Git{UseGitCredentials: true}).Run(context.Background(), "", "", "ls-remote", srv.URL+"/repo.git")
	if !authenticated.Load() {
		t.Fatal("Git did not authenticate using the configured helper")
	}
	if err == nil || strings.Contains(err.Error(), "helper-secret") {
		t.Fatalf("unsafe Git error: %v", err)
	}
}

func TestGitEnvDropsSecretsAndScopesAskpass(t *testing.T) {
	t.Setenv(TokensEnv, `{"a":"x"}`)
	t.Setenv(TokenEnv, "y")
	env := strings.Join(Git{Askpass: "/bin/hive-worker", Kind: KindGitLab, Token: "glpat-z"}.env("gitlab.com"), "\n")
	for _, bad := range []string{TokensEnv + "=", TokenEnv + "="} {
		if strings.Contains(env, bad) {
			t.Errorf("env còn %s", bad)
		}
	}
	for _, want := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/bin/hive-worker", askpassHostEnv + "=gitlab.com", askpassTokenEnv + "=glpat-z", askpassUserEnv + "=oauth2"} {
		if !strings.Contains(env, want) {
			t.Errorf("env thiếu %s", want)
		}
	}
	// Không có máy chủ HTTPS (SSH, lệnh tại máy): không đưa token cho git.
	if env := strings.Join((Git{Askpass: "/x", Token: "glpat-z"}).env(""), "\n"); strings.Contains(env, "glpat-z") {
		t.Error("lệnh không cần mạng vẫn có token")
	}
	if got := (Git{Token: "glpat-z"}).redact("fatal: https://oauth2:glpat-z@h/x"); strings.Contains(got, "glpat-z") {
		t.Errorf("redact = %q", got)
	}
}

func TestAskpassAnswersOnlyItsHost(t *testing.T) {
	t.Setenv(askpassHostEnv, "gitlab.acme.vn:8443")
	t.Setenv(askpassUserEnv, "oauth2")
	t.Setenv(askpassTokenEnv, "glpat-secret")
	var out bytes.Buffer
	if code := Askpass([]string{"Username for 'https://gitlab.acme.vn:8443': "}, &out); code != 0 || out.String() != "oauth2\n" {
		t.Fatalf("username = %d %q", code, out.String())
	}
	out.Reset()
	if code := Askpass([]string{"Password for 'https://oauth2@GITLAB.acme.vn:8443': "}, &out); code != 0 || out.String() != "glpat-secret\n" {
		t.Fatalf("password = %d %q", code, out.String())
	}
	out.Reset()
	if code := Askpass([]string{"Password for 'https://evil.example': "}, &out); code == 0 || out.Len() != 0 {
		t.Fatalf("máy chủ lạ = %d %q", code, out.String())
	}
	if tokenUser(KindGitHub) != "x-access-token" {
		t.Error("tokenUser sai")
	}
}
