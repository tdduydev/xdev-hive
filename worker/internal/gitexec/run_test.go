package gitexec

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

func repo(t *testing.T) string {
	t.Helper()
	isolateGit(t)
	dir := t.TempDir()
	gitT(t, dir, "init", "-q", "-b", "main")
	gitT(t, dir, "commit", "-q", "--allow-empty", "-m", "v1")
	return dir
}

func gitError(t *testing.T, err error) *GitError {
	t.Helper()
	var ge *GitError
	if !errors.As(err, &ge) {
		t.Fatalf("lỗi = %v (%T), muốn *GitError", err, err)
	}
	return ge
}

func TestTimeoutStopsGit(t *testing.T) {
	isolateGit(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Máy chủ treo: chỉ hết giờ mới làm git dừng.
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)

	start := time.Now()
	_, err := (Git{MachineCredentials: true, Timeout: 500 * time.Millisecond}).Run(context.Background(), "", "", "ls-remote", srv.URL+"/repo.git")
	if ge := gitError(t, err); !ge.Timeout || !strings.Contains(ge.Msg, "ls-remote") {
		t.Fatalf("hết giờ = %+v", ge)
	}
	// Dưới WaitDelay 10 giây: git con dừng khi nhận tín hiệu, không phải bị giết muộn. Windows giết git ngay nhưng
	// git-remote-http con có thể giữ ống stderr tới hết WaitDelay.
	limit := 8 * time.Second
	if runtime.GOOS == "windows" {
		limit = 15 * time.Second
	}
	if d := time.Since(start); d > limit {
		t.Fatalf("git dừng sau %s", d)
	}
}

func TestCancelIsNotTimeout(t *testing.T) {
	isolateGit(t)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer srv.Close()
	defer close(release)

	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	_, err := (Git{MachineCredentials: true, Timeout: time.Minute}).Run(ctx, "", "", "ls-remote", srv.URL+"/repo.git")
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("huỷ từ người gọi = %v", err)
	}
}

func TestMachineCredentialsKeepsLocalGitError(t *testing.T) {
	dir := repo(t)
	g := Git{MachineCredentials: true, Timeout: 15 * time.Second}
	_, err := g.Run(context.Background(), dir, "", "switch", "khong-co")
	if ge := gitError(t, err); !strings.Contains(ge.Msg, "khong-co") || ge.Auth || ge.Timeout {
		t.Fatalf("switch sai = %+v", ge)
	}
	_, err = g.Run(context.Background(), dir, "", "switch", "https://hive:ghp_secret@git.example/x.git")
	if ge := gitError(t, err); strings.Contains(ge.Msg, "ghp_secret") || !strings.Contains(ge.Msg, "https://***@git.example/x.git") {
		t.Fatalf("token trong URL = %q", ge.Msg)
	}
	out, err := g.Run(context.Background(), dir, "", "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil || strings.TrimSpace(out) != "main" {
		t.Fatalf("rev-parse = %q, %v", out, err)
	}
}

func TestMachineCredentialsHidesNetworkErrors(t *testing.T) {
	isolateGit(t)
	gitT(t, "", "config", "--global", "credential.helper", "test-helper")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte("helper-secret"))
	}))
	defer srv.Close()
	g := Git{MachineCredentials: true}
	out, err := g.Run(context.Background(), "", "", "config", "--get", "credential.helper")
	if err != nil || strings.TrimSpace(out) != "test-helper" {
		t.Fatalf("helper của máy = %q, %v", out, err)
	}
	url := strings.Replace(srv.URL, "://", "://hive:ghp_secret@", 1) + "/repo.git"
	_, err = g.Run(context.Background(), "", "", "ls-remote", url)
	ge := gitError(t, err)
	if ge.Auth || strings.Contains(ge.Msg, "ghp_secret") || strings.Contains(ge.Msg, "helper-secret") || !strings.HasPrefix(ge.Msg, "git ls-remote không hoàn tất") {
		t.Fatalf("lỗi mạng = %+v", ge)
	}
}

func TestMachineCredentialsReportsAuthFailure(t *testing.T) {
	isolateGit(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("WWW-Authenticate", `Basic realm="test"`)
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	t.Setenv("GIT_ASKPASS", "hive-askpass-cua-nguoi-dung")
	g := Git{MachineCredentials: true, Askpass: "/bin/hive-worker", Token: "glpat-z"}
	_, err := g.Run(context.Background(), "", "", "ls-remote", srv.URL+"/repo.git")
	if ge := gitError(t, err); !ge.Auth || !strings.Contains(ge.Msg, "từ chối đăng nhập") {
		t.Fatalf("đăng nhập sai = %+v", ge)
	}
	for _, kv := range g.env("git.example") {
		if strings.HasPrefix(kv, "GIT_ASKPASS=") || strings.Contains(kv, "glpat-z") {
			t.Fatalf("chế độ máy vẫn đưa askpass/token cho git: %q", kv)
		}
	}
}

func TestRedactHidesURLUserinfo(t *testing.T) {
	cases := map[string]string{
		"fatal: unable to access 'https://oauth2:glpat-x@gitlab.example/a.git/': 403": "fatal: unable to access 'https://***@gitlab.example/a.git/': 403",
		"remote https://ghp_abc@github.com/a/b.git":                                   "remote https://***@github.com/a/b.git",
		"ssh://git@github.com/a/b.git và ssh://git:pw@h/x":                            "ssh://git@github.com/a/b.git và ssh://***@h/x",
		"git@github.com:a/b.git":                                                      "git@github.com:a/b.git",
	}
	for in, want := range cases {
		if got := (Git{}).redact(in); got != want {
			t.Errorf("redact(%q) = %q, muốn %q", in, got, want)
		}
	}
}
