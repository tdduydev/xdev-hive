package gitexclude

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@example.com"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newRepo(t *testing.T) string {
	t.Helper()
	needGit(t)
	repo := filepath.Join(t.TempDir(), "app")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "init", "-q")
	return repo
}

func read(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	return string(raw)
}

func countLine(text, line string) int {
	n := 0
	for _, l := range strings.Split(text, "\n") {
		if l == line {
			n++
		}
	}
	return n
}

func TestAddIsIdempotent(t *testing.T) {
	repo := newRepo(t)
	exclude := filepath.Join(repo, ".git", "info", "exclude")
	added, warn := Add(repo, "CLAUDE.local.md")
	if !added || warn != "" {
		t.Fatalf("Add = %v, %q", added, warn)
	}
	added, warn = Add(repo, "CLAUDE.local.md")
	if added || warn != "" {
		t.Fatalf("Add lần hai = %v, %q", added, warn)
	}
	if n := countLine(read(t, exclude), "/CLAUDE.local.md"); n != 1 {
		t.Fatalf("exclude có %d dòng, muốn 1:\n%s", n, read(t, exclude))
	}
	if got := runGit(t, repo, "check-ignore", "CLAUDE.local.md"); got != "CLAUDE.local.md" {
		t.Fatalf("check-ignore = %q", got)
	}
}

func TestAddSkipsFileAlreadyIgnored(t *testing.T) {
	repo := newRepo(t)
	if err := os.WriteFile(filepath.Join(repo, ".gitignore"), []byte("*.local.md\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	added, warn := Add(repo, "CLAUDE.local.md")
	if added || warn != "" {
		t.Fatalf("Add = %v, %q", added, warn)
	}
	if strings.Contains(read(t, filepath.Join(repo, ".git", "info", "exclude")), "CLAUDE.local.md") {
		t.Fatal("không được thêm dòng khi git đã bỏ qua file")
	}
}

func TestAddNestedPathUsesSlashes(t *testing.T) {
	repo := newRepo(t)
	added, _ := Add(repo, filepath.Join(".agents", "rules", "xdev-hive.md"))
	if !added {
		t.Fatal("Add = false")
	}
	if !strings.Contains(read(t, filepath.Join(repo, ".git", "info", "exclude")), "\n/.agents/rules/xdev-hive.md\n") {
		t.Fatalf("exclude = %q", read(t, filepath.Join(repo, ".git", "info", "exclude")))
	}
}

func TestAddOutsideGitDoesNothing(t *testing.T) {
	needGit(t)
	dir := t.TempDir()
	added, warn := Add(dir, "CLAUDE.local.md")
	if added || warn != "" {
		t.Fatalf("Add = %v, %q", added, warn)
	}
	if Tracked(dir, "CLAUDE.local.md") {
		t.Fatal("Tracked ngoài repo phải là false")
	}
	if warn := Remove(dir, "/CLAUDE.local.md"); warn != "" {
		t.Fatalf("Remove = %q", warn)
	}
}

func TestRemoveKeepsOtherLines(t *testing.T) {
	repo := newRepo(t)
	exclude := filepath.Join(repo, ".git", "info", "exclude")
	before := read(t, exclude)
	if added, _ := Add(repo, "GEMINI.local.md"); !added {
		t.Fatal("Add = false")
	}
	if warn := Remove(repo, Line("GEMINI.local.md")); warn != "" {
		t.Fatalf("Remove = %q", warn)
	}
	after := read(t, exclude)
	if strings.Contains(after, "GEMINI.local.md") {
		t.Fatalf("exclude còn dòng: %q", after)
	}
	if strings.TrimRight(after, "\n") != strings.TrimRight(before, "\n") {
		t.Fatalf("exclude đổi phần khác:\nbefore=%q\nafter=%q", before, after)
	}
}

func TestTracked(t *testing.T) {
	repo := newRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "AGENTS.md"), []byte("# a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "CLAUDE.local.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "AGENTS.md")
	runGit(t, repo, "commit", "-q", "-m", "init")
	if !Tracked(repo, "AGENTS.md") {
		t.Fatal("AGENTS.md đã commit mà Tracked = false")
	}
	if Tracked(repo, "CLAUDE.local.md") {
		t.Fatal("file chưa add mà Tracked = true")
	}
	if Tracked(repo, "missing.md") {
		t.Fatal("file không có mà Tracked = true")
	}
}

func TestWorktreeUsesCommonExclude(t *testing.T) {
	repo := newRepo(t)
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	runGit(t, repo, "commit", "-q", "-m", "init")
	wt := filepath.Join(filepath.Dir(repo), "wt")
	runGit(t, repo, "worktree", "add", "-q", wt)

	added, warn := Add(wt, "CLAUDE.local.md")
	if !added || warn != "" {
		t.Fatalf("Add = %v, %q", added, warn)
	}
	common := runGit(t, wt, "rev-parse", "--path-format=absolute", "--git-common-dir")
	want := filepath.Join(filepath.FromSlash(common), "info", "exclude")
	if !strings.Contains(read(t, want), "/CLAUDE.local.md") {
		t.Fatalf("%s = %q", want, read(t, want))
	}
	if got := runGit(t, wt, "check-ignore", "CLAUDE.local.md"); got != "CLAUDE.local.md" {
		t.Fatalf("check-ignore trong worktree = %q", got)
	}
	if !Tracked(wt, "README.md") {
		t.Fatal("README.md trong worktree phải Tracked")
	}
	if warn := Remove(wt, Line("CLAUDE.local.md")); warn != "" {
		t.Fatalf("Remove = %q", warn)
	}
	if strings.Contains(read(t, want), "CLAUDE.local.md") {
		t.Fatalf("exclude còn dòng: %q", read(t, want))
	}
}
