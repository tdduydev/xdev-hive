package runner

import (
	"context"
	"net/http"
	"net/http/cgi"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunGitAuthOnlyForTokenHostAndRepo(t *testing.T) {
	g := NewRunGit(GitCredential{Host: "github.com", Username: "x-access-token", Token: "ghs_run_token", Repo: "acme/web"})
	g.askpass = "/opt/hive-worker"
	for _, tc := range []struct {
		remote, host string
	}{
		{"https://github.com/acme/web.git", "github.com"},
		{"https://GitHub.com/Acme/Web", "GitHub.com"},
		{"https://github.com:443/acme/web.git", "github.com:443"},
		// Khác máy chủ, khác repo, không phải HTTPS: không nhận token, dùng thông tin git của máy.
		{"https://gitlab.com/acme/web.git", ""},
		{"https://github.com.evil.example/acme/web.git", ""},
		{"https://github.com/acme/api.git", ""},
		{"https://github.com/acme/web/extra.git", ""},
		{"http://github.com/acme/web.git", ""},
		{"git@github.com:acme/web.git", ""},
		{"ssh://git@github.com/acme/web.git", ""},
		{"file:///srv/acme/web.git", ""},
		{"", ""},
	} {
		a := g.auth(tc.remote)
		if (a.git != nil) != (tc.host != "") || a.host != tc.host {
			t.Errorf("auth(%q) = host %q git %v", tc.remote, a.host, a.git != nil)
		}
	}
	if a := (*RunGit)(nil).auth("https://github.com/acme/web.git"); a.git != nil {
		t.Fatal("job không có token git vẫn nhận auth")
	}
	// GitLab nhóm nhiều cấp; token không ghi repo thì nhận mọi repo trên đúng máy chủ.
	g.Set(GitCredential{Host: "gitlab.example", Username: "oauth2", Token: "glpat-run", Repo: "team/sub/web"})
	if a := g.auth("https://gitlab.example/team/sub/web.git"); a.git == nil || a.git.User != "oauth2" || a.git.Token != "glpat-run" {
		t.Fatalf("auth = %+v", a.git)
	}
	g.Set(GitCredential{Host: "gitlab.example", Token: "glpat-run"})
	if a := g.auth("https://gitlab.example/other/repo.git"); a.git == nil {
		t.Fatal("token không ghi repo không được dùng")
	}
	g.Set(GitCredential{Host: "gitlab.example"})
	if a := g.auth("https://gitlab.example/other/repo.git"); a.git != nil {
		t.Fatal("token rỗng vẫn được dùng")
	}
}

func TestRunGitKeepsTokenOutOfArgs(t *testing.T) {
	const token = "ghs_run_token_args"
	g := NewRunGit(GitCredential{Host: "github.com", Username: "x-access-token", Token: token, Repo: "acme/web"})
	g.askpass = "/opt/hive-worker"
	a := g.auth("https://github.com/acme/web.git")
	args, env := a.git.Prepare(a.host, "push", "origin", "HEAD:refs/heads/ai/x")
	if strings.Contains(strings.Join(args, " "), token) || !strings.Contains(strings.Join(args, " "), "credential.helper=") {
		t.Fatalf("args = %v", args)
	}
	var withToken []string
	for _, kv := range env {
		if strings.Contains(kv, token) {
			withToken = append(withToken, kv)
		}
	}
	if len(withToken) != 1 || !strings.HasPrefix(withToken[0], "HIVE_GIT_ASKPASS_TOKEN=") {
		t.Fatalf("token trong env: %v", withToken)
	}
	for _, want := range []string{"GIT_TERMINAL_PROMPT=0", "GIT_ASKPASS=/opt/hive-worker", "HIVE_GIT_ASKPASS_USER=x-access-token", "HIVE_GIT_ASKPASS_HOST=github.com"} {
		if !slices.Contains(env, want) {
			t.Fatalf("thiếu %s trong env", want)
		}
	}
	var out strings.Builder
	w := a.mask.Writer(&out)
	_, _ = w.Write([]byte("fatal: https://x-access-token:" + token + "@github.com/acme/web.git\n"))
	_ = w.Flush()
	if strings.Contains(out.String(), token) {
		t.Fatalf("log còn token: %s", out.String())
	}
}

// TestRunnerUsesRunGitTokenOverHTTPS chạy run thật qua smart HTTP (git http-backend) có Basic auth: clone, fetch và push
// chỉ qua được bằng token theo run, token không nằm trong cấu hình repo cache, env của CLI hay lỗi trả về.
func TestRunnerUsesRunGitTokenOverHTTPS(t *testing.T) {
	gitBin, err := exec.LookPath("git")
	if err != nil {
		t.Skip("không có git")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	// Máy chủ test dùng chứng chỉ tự ký của httptest.
	t.Setenv("GIT_SSL_NO_VERIFY", "1")

	remote, base := makeRemote(t)
	project := t.TempDir()
	bare := filepath.Join(project, "acme", "web.git")
	must(t, "git", "clone", "--bare", remote, bare)
	must(t, "git", "--git-dir", bare, "config", "http.receivepack", "true")

	const token = "ghs_run_token_https"
	var authed atomic.Int32
	backend := &cgi.Handler{
		Path:       gitBin,
		Args:       []string{"http-backend"},
		Env:        []string{"GIT_PROJECT_ROOT=" + project, "GIT_HTTP_EXPORT_ALL=1"},
		InheritEnv: []string{"PATH", "HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"},
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "x-access-token" || pass != token {
			w.Header().Set("WWW-Authenticate", `Basic realm="git"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		authed.Add(1)
		backend.ServeHTTP(w, r)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	repoURL := srv.URL + "/acme/web.git"
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	run := func(name, secret string) (*Result, string, string) {
		data := t.TempDir()
		g := NewRunGit(GitCredential{Host: u.Hostname(), Username: "x-access-token", Token: secret, Repo: "acme/web", ExpiresAt: time.Now().Add(time.Hour)})
		g.askpass = self
		dump := filepath.Join(t.TempDir(), "env")
		var events []Event
		// fakeCommands khai ReadOnly (không push); run này cần push nên dùng CLI giả không ReadOnly.
		r := Runner{DataDir: data, CLICommands: map[string]Command{"codex": {Path: os.Args[0], Args: []string{"-test.run=TestFakeCLIHelper", "--", "helper"}}}}
		job := Job{RunID: name, Attempt: 1, RepoURL: repoURL, BaseBranch: base, Branch: "ai/" + name, CLI: "codex", Prompt: "prompt", Timeout: 30 * time.Second, Git: g, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": "commit", "HIVE_FAKE_ENV_DUMP": dump}}
		if err := r.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil })); err != nil && secret == token {
			t.Fatal(err)
		}
		env, _ := os.ReadFile(dump)
		var cfg strings.Builder
		caches, _ := filepath.Glob(filepath.Join(data, "repos", "*.git"))
		for _, c := range caches {
			b, _ := os.ReadFile(filepath.Join(c, "config"))
			cfg.Write(b)
		}
		return lastResult(events), string(env), cfg.String()
	}

	got, env, cfg := run("token", token)
	if got == nil || got.Status != "succeeded" {
		t.Fatalf("result = %#v", got)
	}
	if out := mustOut(t, "git", "--git-dir", bare, "branch", "--list", "ai/token"); !strings.Contains(out, "ai/token") {
		t.Fatal("push bằng token theo run không tới remote")
	}
	if authed.Load() == 0 {
		t.Fatal("máy chủ không thấy lượt gọi có token")
	}
	if env == "" {
		t.Fatal("CLI giả không ghi env")
	}
	for name, s := range map[string]string{"env của CLI": env, "config repo cache": cfg, "lỗi": got.Error} {
		if strings.Contains(s, token) || strings.Contains(s, "HIVE_GIT_ASKPASS") {
			t.Fatalf("token nằm trong %s:\n%s", name, s)
		}
	}

	const wrong = "ghs_wrong_token"
	got, _, _ = run("wrong", wrong)
	if got == nil || got.Status != "failed" || strings.Contains(got.Error, wrong) {
		t.Fatalf("token sai = %#v", got)
	}
}
