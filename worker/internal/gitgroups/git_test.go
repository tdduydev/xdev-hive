package gitgroups

import (
	"context"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestNativeGitKeepsConfiguredHelperAndStripsHiveSecrets(t *testing.T) {
	isolateGit(t)
	gitT(t, "", "config", "--global", "credential.helper", "test-helper")
	native := Git{UseGitCredentials: true, Askpass: "hive-askpass", Token: "hive-secret"}
	out, err := native.run(context.Background(), "", "", "config", "--get", "credential.helper")
	if err != nil || strings.TrimSpace(out) != "test-helper" {
		t.Fatalf("native helper = %q, %v", out, err)
	}
	out, err = (Git{}).run(context.Background(), "", "", "config", "--get", "credential.helper")
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
	_, err := (Git{UseGitCredentials: true}).run(context.Background(), "", "", "ls-remote", srv.URL+"/repo.git")
	if !authenticated.Load() {
		t.Fatal("Git did not authenticate using the configured helper")
	}
	if err == nil || strings.Contains(err.Error(), "helper-secret") {
		t.Fatalf("unsafe Git error: %v", err)
	}
}
