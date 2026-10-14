package gitgroups

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
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

// remote tạo bare repo có một commit trên main, trả đường dẫn bare và một bản clone để đẩy commit mới.
func remote(t *testing.T, base, name string) (string, string) {
	t.Helper()
	bare := filepath.Join(base, "remotes", name+".git")
	gitT(t, base, "init", "-q", "--bare", "-b", "main", bare)
	work := filepath.Join(base, "pushers", name)
	gitT(t, base, "clone", "-q", bare, work)
	gitT(t, work, "checkout", "-q", "-b", "main")
	writeFile(t, filepath.Join(work, "README.md"), "v1\n")
	gitT(t, work, "add", ".")
	gitT(t, work, "commit", "-q", "-m", "v1")
	gitT(t, work, "push", "-q", "origin", "main")
	return bare, work
}

func push(t *testing.T, work, content string) {
	t.Helper()
	writeFile(t, filepath.Join(work, "README.md"), content)
	gitT(t, work, "commit", "-q", "-am", content)
	gitT(t, work, "push", "-q", "origin", "main")
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func runSync(t *testing.T, s Sync, ctx context.Context, action string) (map[string]Event, Event) {
	t.Helper()
	got := map[string]Event{}
	var last Event
	if err := s.Run(ctx, action, func(e Event) {
		if e.Type == "repo" {
			got[e.Path] = e
		}
		last = e
	}); err != nil {
		t.Fatal(err)
	}
	if last.Type != "done" || last.Done != last.Total {
		t.Fatalf("sự kiện cuối = %+v", last)
	}
	return got, last
}

func TestSyncEndToEndWithBareRepos(t *testing.T) {
	isolateGit(t)
	base := t.TempDir()
	apiBare, apiWork := remote(t, base, "api")
	webBare, webWork := remote(t, base, "web")
	docsBare, _ := remote(t, base, "docs")
	oldBare, _ := remote(t, base, "old")
	root := filepath.Join(base, "code")
	projectsFile := filepath.Join(base, "projects.json")
	g := Group{
		Root: root,
		Repos: []Repo{
			{Path: "acme/pay/api", Name: "api", DefaultBranch: "main", HTTPURL: apiBare},
			{Path: "acme/web", Name: "web", DefaultBranch: "main", HTTPURL: webBare},
			{Path: "acme/docs", Name: "docs", DefaultBranch: "main", HTTPURL: docsBare},
			{Path: "acme/old", Name: "old", DefaultBranch: "main", HTTPURL: oldBare, Archived: true},
		},
	}
	s := Sync{Git: Git{}, Group: g, Projects: projectsFile, Concurrency: 2}
	ctx := context.Background()

	got, _ := runSync(t, s, ctx, ActionStatus)
	if len(got) != 3 || got["acme/pay/api"].Status.State != StateMissing {
		t.Fatalf("trạng thái trước clone = %+v", got)
	}
	if _, ok := got["acme/old"]; ok {
		t.Fatal("repo archived vẫn được chọn")
	}
	if got, _ = runSync(t, s, ctx, ActionPull); got["acme/web"].Result != ResultSkipped || got["acme/web"].Message != "chưa clone" {
		t.Fatalf("pull khi chưa clone = %+v", got["acme/web"])
	}

	got, done := runSync(t, s, ctx, ActionClone)
	if done.Summary[ResultDone] != 3 {
		t.Fatalf("clone = %+v", got)
	}
	apiDir := filepath.Join(root, "acme", "pay", "api")
	if st := got["acme/pay/api"].Status; st.State != StateClean || st.Dir != apiDir {
		t.Fatalf("api sau clone = %+v", st)
	}
	list, _ := projects.Load(projectsFile)
	if len(list) != 3 {
		t.Fatalf("Dự án trên máy = %+v", list)
	}
	if got, _ = runSync(t, s, ctx, ActionClone); got["acme/web"].Result != ResultUnchanged {
		t.Fatalf("clone lần hai = %+v", got["acme/web"])
	}

	// api: remote có commit mới. web: remote có commit mới và người dùng đang sửa file. docs: người dùng ở nhánh khác.
	push(t, apiWork, "v2\n")
	push(t, webWork, "v2\n")
	webDir := filepath.Join(root, "acme", "web")
	writeFile(t, filepath.Join(webDir, "README.md"), "sửa dở\n")
	docsDir := filepath.Join(root, "acme", "docs")
	gitT(t, docsDir, "checkout", "-q", "-b", "feat")
	writeFile(t, filepath.Join(apiDir, "untracked.txt"), "x")

	got, _ = runSync(t, s, ctx, ActionFetch)
	if st := got["acme/pay/api"].Status; st.State != StateBehind || st.Behind != 1 {
		t.Fatalf("api sau fetch = %+v", st)
	}

	got, done = runSync(t, s, ctx, ActionPull)
	if e := got["acme/pay/api"]; e.Result != ResultDone || e.Status.State != StateClean {
		t.Fatalf("pull api = %+v %+v", e, e.Status)
	}
	if b, _ := os.ReadFile(filepath.Join(apiDir, "README.md")); string(b) != "v2\n" {
		t.Fatalf("api chưa tiến: %q", b)
	}
	if e := got["acme/web"]; e.Result != ResultSkipped || e.Status.State != StateDirty {
		t.Fatalf("pull web bẩn = %+v", e)
	}
	if b, _ := os.ReadFile(filepath.Join(webDir, "README.md")); string(b) != "sửa dở\n" {
		t.Fatalf("thay đổi của người dùng bị mất: %q", b)
	}
	if e := got["acme/docs"]; e.Result != ResultSkipped || e.Status.State != StateDiverged || !strings.Contains(e.Message, "feat") {
		t.Fatalf("pull docs lệch nhánh = %+v", e)
	}
	if done.Summary[ResultDone] != 1 || done.Summary[ResultSkipped] != 2 {
		t.Fatalf("tổng = %+v", done.Summary)
	}
	if gitT(t, webDir, "stash", "list") != "" {
		t.Fatal("pull đã stash thay đổi của người dùng")
	}

	// Thư mục có sẵn mà không phải repo, và repo của origin khác: báo lỗi, không clone đè, không pull.
	broken := g
	broken.Repos = []Repo{
		{Path: "acme/plain", DefaultBranch: "main", HTTPURL: apiBare},
		{Path: "acme/web", DefaultBranch: "main", HTTPURL: apiBare},
	}
	if err := os.MkdirAll(filepath.Join(root, "acme", "plain"), 0o755); err != nil {
		t.Fatal(err)
	}
	got, _ = runSync(t, Sync{Group: broken}, ctx, ActionPull)
	if e := got["acme/plain"]; e.Result != ResultSkipped || e.Status.State != StateError {
		t.Fatalf("thư mục thường = %+v", e)
	}
	if e := got["acme/web"]; e.Status.State != StateError || !strings.Contains(e.Status.Reason, "repo khác") {
		t.Fatalf("origin khác = %+v", e.Status)
	}
}

func TestSyncCancelled(t *testing.T) {
	isolateGit(t)
	base := t.TempDir()
	bare, _ := remote(t, base, "api")
	g := Group{Root: filepath.Join(base, "code"), Repos: []Repo{{Path: "a/api", HTTPURL: bare}, {Path: "a/web", HTTPURL: bare}}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, done := runSync(t, Sync{Group: g}, ctx, ActionClone)
	if done.Summary[ResultCancelled] != 2 || got["a/api"].Status != nil {
		t.Fatalf("huỷ = %+v %+v", got, done)
	}
	if _, err := os.Stat(filepath.Join(base, "code", "a", "api")); !os.IsNotExist(err) {
		t.Fatalf("clone vẫn chạy sau khi huỷ: %v", err)
	}
	if err := (Sync{Group: g}).Run(context.Background(), "push", func(Event) {}); err == nil {
		t.Fatal("thao tác lạ không báo lỗi")
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
