package main

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/branches"
)

// branchesRun chạy `hive-worker branches` với thư mục dữ liệu, cấu hình, git riêng của test.
func branchesRun(t *testing.T, stdin string, args ...string) (int, string, string) {
	t.Helper()
	branchesIsolate(t)
	data, conf := t.TempDir(), t.TempDir()
	oldData, oldConf := branchesDataDir, branchesConfigDir
	branchesDataDir = func() (string, error) { return data, nil }
	branchesConfigDir = func() (string, error) { return conf, nil }
	t.Cleanup(func() { branchesDataDir, branchesConfigDir = oldData, oldConf })
	var out, errOut bytes.Buffer
	code := branchesCommand(args, strings.NewReader(stdin), &out, &errOut)
	return code, out.String(), errOut.String()
}

// branchesIsolate để git của test không đọc cấu hình, hook của người chạy test.
func branchesIsolate(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, "no-gitconfig"))
}

func branchesRepo(t *testing.T) string {
	t.Helper()
	branchesIsolate(t)
	dir := filepath.Join(t.TempDir(), "repo có dấu cách")
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=T", "GIT_AUTHOR_EMAIL=t@example.com",
			"GIT_COMMITTER_NAME=T", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v: %s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main", dir)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("-C", dir, "add", ".")
	run("-C", dir, "commit", "-qm", "init")
	run("-C", dir, "worktree", "add", "-q", "-b", "ai/x", filepath.Join(filepath.Dir(dir), "wt"))
	return dir
}

func lines(out string) []string { return strings.Split(strings.TrimSpace(out), "\n") }

func TestBranchesBadArgsExit2(t *testing.T) {
	abs := t.TempDir()
	cases := [][]string{
		{},
		{"--folder=" + abs},
		{"lạ"},
		{"list"},
		{"list", "--folder=relative/dir"},
		{"list", "--folder=" + abs, "--folder=" + abs},
		{"list", "--folder=" + abs, "--remote=origin"},
		{"status", "--folder=" + abs, "--timeout=-1"},
		{"status", "--folder=" + abs, "thừa"},
		{"switch", "--folder=" + abs},
		{"switch", "--folder=" + abs, "--branch=a", "--track=origin/a"},
		{"create", "--folder=" + abs, "--name=a"},
		{"merge", "--folder=" + abs},
		{"settings", "--folder=" + abs},
		{"fetch", "--folder=" + abs, "--remote="},
	}
	for _, args := range cases {
		code, out, errOut := branchesRun(t, "{}\n", args...)
		if code != 2 || out != "" || strings.TrimSpace(errOut) == "" {
			t.Fatalf("%q: mã %d, stdout %q, stderr %q", args, code, out, errOut)
		}
	}
}

// Lệnh của task sau: thoát 0 với lỗi not_implemented đúng dạng kết quả của từng lệnh.
func TestBranchesStubsNotImplemented(t *testing.T) {
	abs := t.TempDir()
	oneShot := [][]string{
		{"merge", "--folder=" + abs, "--onto=abc", "--onto-name=main", "--ff"},
		{"rebase", "--folder=" + abs, "--onto=abc", "--confirm-rewrite"},
		{"continue", "--folder=" + abs},
		{"abort", "--folder=" + abs, "--timeout=120"},
	}
	for _, args := range oneShot {
		code, out, _ := branchesRun(t, "{}\n", args...)
		got := decode[struct{ Error *branches.Error }](t, out)
		if code != 0 || got.Error == nil || got.Error.Code != branches.CodeNotImplemented || len(lines(out)) != 1 {
			t.Fatalf("%q: %d %s", args, code, out)
		}
	}
}

func TestBranchesInvalidInput(t *testing.T) {
	abs := t.TempDir()
	code, out, _ := branchesRun(t, "không phải json\n", "status", "--folder="+abs)
	if got := decode[struct{ Error *branches.Error }](t, out); code != 0 || got.Error == nil || got.Error.Code != branches.CodeInvalidInput {
		t.Fatalf("status: %d %s", code, out)
	}
	_, out, _ = branchesRun(t, "{\n", "list", "--folder="+abs)
	ls := lines(out)
	repo := decode[branches.RepoBranches](t, ls[0])
	done := decode[branches.Event](t, ls[len(ls)-1])
	if len(ls) != 2 || repo.Error == nil || repo.Error.Code != branches.CodeInvalidInput || done.Type != branches.EventDone {
		t.Fatalf("list: %s", out)
	}
	_, out, _ = branchesRun(t, "{\n", "fetch", "--folder="+abs)
	if ev := decode[branches.Event](t, out); ev.Type != branches.EventDone || ev.Error.Code != branches.CodeInvalidInput {
		t.Fatalf("fetch: %s", out)
	}
}

func TestBranchesListAndStatus(t *testing.T) {
	repo := branchesRepo(t)
	code, out, errOut := branchesRun(t, "{}\n", "list", "--folder="+repo, "--timeout=30")
	ls := lines(out)
	if code != 0 || len(ls) != 3 {
		t.Fatalf("list: %d %s %s", code, out, errOut)
	}
	r := decode[branches.RepoBranches](t, ls[0])
	if r.Error != nil || r.Folder != repo || len(r.Worktrees) != 2 || r.Current.Branch != "main" {
		t.Fatalf("RepoBranches: %s", ls[0])
	}
	if ev := decode[branches.Event](t, ls[1]); ev.Type != branches.EventWorktree || ev.Worktree.State != "clean" {
		t.Fatalf("worktree: %s", ls[1])
	}
	if ev := decode[branches.Event](t, ls[2]); ev.Type != branches.EventDone || ev.Folder != repo {
		t.Fatalf("done: %s", ls[2])
	}
	// Mảng rỗng vẫn là [] cho kiểu TypeScript.
	if !strings.Contains(ls[0], `"remotes":[]`) {
		t.Fatalf("remotes phải là []: %s", ls[0])
	}

	missing := filepath.Join(t.TempDir(), "gone")
	code, out, _ = branchesRun(t, "", "status", "--folder="+repo, "--folder="+missing)
	got := decode[struct{ Repos []branches.BranchStatus }](t, out)
	if code != 0 || len(got.Repos) != 2 || got.Repos[0].Error != nil || got.Repos[1].Error.Code != branches.CodeNotRepo {
		t.Fatalf("status: %s", out)
	}
}

func TestBranchesFetchUnknownRemote(t *testing.T) {
	repo := branchesRepo(t)
	_, out, _ := branchesRun(t, "{}\n", "fetch", "--folder="+repo, "--remote=origin")
	if ev := decode[branches.Event](t, out); ev.Type != branches.EventDone || ev.Error.Code != branches.CodeNotFound ||
		!strings.Contains(out, `"fetched":[]`) {
		t.Fatalf("fetch: %s", out)
	}
}

// pull là job: một dòng done kể cả khi lỗi nghiệp vụ, thoát 0.
func TestBranchesPullNoUpstream(t *testing.T) {
	repo := branchesRepo(t)
	code, out, errOut := branchesRun(t, "{}\n", "pull", "--folder="+repo, "--confirm-busy", "--timeout=30")
	ev := decode[branches.Event](t, out)
	if code != 0 || len(lines(out)) != 1 || ev.Type != branches.EventDone || ev.Folder != repo ||
		ev.Error == nil || ev.Error.Code != branches.CodeNoUpstream {
		t.Fatalf("pull: %d %s %s", code, out, errOut)
	}
}
