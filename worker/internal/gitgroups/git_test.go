package gitgroups

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
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

func TestBatchStopsCallingServerAfterAuthFailure(t *testing.T) {
	cases := map[string]bool{"token": false}
	if runtime.GOOS != "windows" {
		cases["git"] = true
	}
	for name, native := range cases {
		t.Run(name, func(t *testing.T) {
			isolateGit(t)
			if native {
				gitT(t, "", "config", "--global", "credential.helper", `!f() { printf 'username=test\npassword=expired\n'; }; f`)
			}
			var withAuth atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "" {
					withAuth.Add(1)
				}
				w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
				w.WriteHeader(http.StatusUnauthorized)
			}))
			defer srv.Close()
			g := Group{Root: filepath.Join(t.TempDir(), "code")}
			for i := range 6 {
				g.Repos = append(g.Repos, Repo{Path: fmt.Sprintf("acme/r%d", i), HTTPURL: fmt.Sprintf("%s/acme/r%d.git", srv.URL, i)})
			}
			got, done := runSync(t, Sync{Git: Git{UseGitCredentials: native}, Group: g, Concurrency: 2}, context.Background(), ActionClone)
			// Chỉ các repo đang chạy cùng lúc với lần bị từ chối đầu tiên mới gọi máy chủ.
			if done.Summary[ResultFailed] < 1 || done.Summary[ResultFailed] > 2 || done.Summary[ResultSkipped] != 6-done.Summary[ResultFailed] {
				t.Fatalf("tổng = %+v", done.Summary)
			}
			if native && withAuth.Load() > 2 {
				t.Fatalf("gửi đăng nhập sai %d lần", withAuth.Load())
			}
			for path, e := range got {
				switch e.Result {
				case ResultSkipped:
					if e.Message != authStopped {
						t.Errorf("%s bỏ qua = %q", path, e.Message)
					}
				case ResultFailed:
					if native && !strings.Contains(e.Message, "từ chối đăng nhập") {
						t.Errorf("%s lỗi = %q", path, e.Message)
					}
				}
			}
		})
	}
}
