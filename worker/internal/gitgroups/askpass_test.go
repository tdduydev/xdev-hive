package gitgroups

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
)

// TestMain cho chính binary test làm GIT_ASKPASS, như hive-worker trong main.go.
func TestMain(m *testing.M) {
	if os.Getenv(AskpassEnv) == "1" {
		os.Exit(Askpass(os.Args[1:], os.Stdout))
	}
	os.Exit(m.Run())
}

// TestCloneOverHTTPUsesAskpass clone qua smart HTTP thật (git http-backend) có Basic auth: token chỉ đi qua askpass,
// không nằm trong URL, cấu hình repo hay thông báo lỗi.
func TestCloneOverHTTPUsesAskpass(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("git http-backend qua CGI chỉ kiểm trên Unix")
	}
	isolateGit(t)
	base := t.TempDir()
	bare, _ := remote(t, base, "api")
	const token = "glpat-secret-123"
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("không có git")
	}
	var calls atomic.Int32
	backend := &cgi.Handler{
		Path:       gitBin,
		Args:       []string{"http-backend"},
		Env:        []string{"GIT_PROJECT_ROOT=" + filepath.Dir(bare), "GIT_HTTP_EXPORT_ALL=1"},
		InheritEnv: []string{"PATH", "HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		calls.Add(1)
		if !ok || user != "oauth2" || pass != token {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		backend.ServeHTTP(w, r)
	}))
	defer srv.Close()
	repo := Repo{Path: "acme/api", DefaultBranch: "main", HTTPURL: srv.URL + "/api.git"}
	g := Group{Root: filepath.Join(base, "code"), Repos: []Repo{repo}}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	got, _ := runSync(t, Sync{Git: gitexec.Git{Askpass: self, Kind: KindGitLab, Token: "sai"}, Group: g}, context.Background(), ActionClone)
	if e := got["acme/api"]; e.Result != ResultFailed || strings.Contains(e.Message, "oauth2:") {
		t.Fatalf("token sai = %+v", e)
	}
	if _, err := os.Stat(filepath.Join(g.Root, "acme", "api")); !os.IsNotExist(err) {
		t.Fatal("clone hỏng còn để lại thư mục")
	}

	s := Sync{Git: gitexec.Git{Askpass: self, Kind: KindGitLab, Token: token}, Group: g}
	got, _ = runSync(t, s, context.Background(), ActionClone)
	if e := got["acme/api"]; e.Result != ResultDone || e.Status.State != StateClean {
		t.Fatalf("clone = %+v %+v", e, e.Status)
	}
	dir := filepath.Join(g.Root, "acme", "api")
	cfg, _ := os.ReadFile(filepath.Join(dir, ".git", "config"))
	if strings.Contains(string(cfg), token) || strings.Contains(string(cfg), "oauth2") {
		t.Fatalf("token nằm trong .git/config:\n%s", cfg)
	}
	if got, _ = runSync(t, s, context.Background(), ActionPull); got["acme/api"].Result != ResultUnchanged {
		t.Fatalf("pull = %+v", got["acme/api"])
	}
	if calls.Load() == 0 {
		t.Fatal("máy chủ không thấy lượt gọi nào")
	}
}
