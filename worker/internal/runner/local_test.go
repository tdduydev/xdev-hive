package runner

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// userRepo là repo người dùng đã clone từ remote và gắn với dự án (ADR 0020), có thay đổi chưa commit để kiểm run không
// đụng thư mục làm việc của họ.
func userRepo(t *testing.T, remote string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "app")
	must(t, "git", "clone", "-q", fileURL(remote), dir)
	mustDir(t, dir, "README", "người dùng đang sửa")
	return dir
}

func localJob(id, remote, folder, branch, base, mode string) Job {
	return Job{RunID: id, Attempt: 1, RepoURL: fileURL(remote), LocalRepo: folder, BaseBranch: base, Branch: branch, CLI: "codex", Prompt: "p", Timeout: 10 * time.Second, Env: map[string]string{"HIVE_RUNNER_HELPER": "1", "HIVE_FAKE_MODE": mode}}
}

func runLocal(t *testing.T, data string, job Job, mode string) *Result {
	t.Helper()
	var events []Event
	err := Runner{DataDir: data, CLICommands: fakeCommands(mode)}.Run(context.Background(), job, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	res := lastResult(events)
	if res == nil {
		t.Fatalf("không có kết quả, lỗi %v", err)
	}
	return res
}

func refExists(dir, ref string) bool {
	return exec.Command("git", "-C", dir, "rev-parse", "--verify", "--quiet", ref).Run() == nil
}

// Run của dự án đã gắn tạo worktree từ repo của người dùng, đẩy nhánh qua origin của repo đó, để lại nhánh trong repo,
// không clone bare riêng, không đụng thư mục làm việc và dọn sạch worktree.
func TestLocalRepoRunUsesBoundRepository(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	data := t.TempDir()
	res := runLocal(t, data, localJob("loc", remote, repo, "ai/LOC-1", base, "commit"), "commit")
	if res.Status != "succeeded" || res.CommitCount != 1 {
		t.Fatalf("kết quả = %+v", res)
	}
	head := strings.TrimSpace(mustOut(t, "git", "--git-dir", remote, "rev-parse", "refs/heads/ai/LOC-1"))
	if local := strings.TrimSpace(mustOut(t, "git", "-C", repo, "rev-parse", "refs/heads/ai/LOC-1")); local != head || head != res.HeadSHA {
		t.Fatalf("nhánh trong repo người dùng %s, remote %s, run %s", local, head, res.HeadSHA)
	}
	if b, _ := os.ReadFile(filepath.Join(repo, "README")); string(b) != "người dùng đang sửa" {
		t.Fatalf("run đụng thư mục làm việc: %q", b)
	}
	if _, err := os.Stat(filepath.Join(repo, "change.txt")); !os.IsNotExist(err) {
		t.Fatal("file của agent lọt vào thư mục làm việc")
	}
	if caches, _ := filepath.Glob(filepath.Join(data, "repos", "*.git")); len(caches) != 0 {
		t.Fatalf("vẫn clone bare: %v", caches)
	}
	if list := mustOut(t, "git", "-C", repo, "worktree", "list", "--porcelain"); strings.Count(list, "worktree ") != 1 {
		t.Fatalf("worktree của run còn trong repo:\n%s", list)
	}
	if left, _ := os.ReadDir(filepath.Join(repo, ".git", "worktrees")); len(left) != 0 {
		t.Fatalf("còn siêu dữ liệu worktree: %v", left)
	}
	if _, err := os.Stat(markPath(filepath.Join(data, "runs", "loc-1"))); !os.IsNotExist(err) {
		t.Fatal("còn file ghi nhánh")
	}
	// Lượt sau của cùng task (PR cũ đã merge, nhánh trên remote đã xoá) đặt lại nhánh đã push mà không coi là commit
	// chưa push: push cập nhật origin/<nhánh> trong repo người dùng.
	must(t, "git", "--git-dir", remote, "branch", "-D", "ai/LOC-1")
	if res := runLocal(t, data, localJob("loc2", remote, repo, "ai/LOC-1", base, "commit"), "commit"); res.Status != "succeeded" {
		t.Fatalf("lượt hai = %+v", res)
	}
}

// Run không đẩy gì thì nhánh trong repo người dùng về như trước: xoá nếu run vừa tạo, giữ đầu cũ nếu đã có.
func TestLocalRepoRunRestoresBranchWithoutPush(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	data := t.TempDir()
	if res := runLocal(t, data, localJob("empty", remote, repo, "ai/NEW", base, "empty"), "empty"); res.Status != "no_changes" {
		t.Fatalf("kết quả = %+v", res)
	}
	if refExists(repo, "refs/heads/ai/NEW") {
		t.Fatal("nhánh run tạo mà không đẩy vẫn còn")
	}
	// Nhánh đã có và đã push: run hỏng vẫn trả nhánh về đầu cũ.
	must(t, "git", "-C", repo, "branch", "ai/OLD", "origin/"+base)
	tip := strings.TrimSpace(mustOut(t, "git", "-C", repo, "rev-parse", "ai/OLD"))
	job := localJob("fail", remote, repo, "ai/OLD", base, "commit")
	job.Env["HIVE_FAKE_EXPECT_FILE"] = "khong-co.txt"
	if res := runLocal(t, data, job, "commit"); res.Status != "failed" {
		t.Fatalf("kết quả = %+v", res)
	}
	if got := strings.TrimSpace(mustOut(t, "git", "-C", repo, "rev-parse", "ai/OLD")); got != tip {
		t.Fatalf("nhánh không về đầu cũ: %s, muốn %s", got, tip)
	}
}

// Repo không dùng được thì run hỏng kèm lý do tiếng Việt, không quay về repo cache.
func TestLocalRepoRunRefusesUnusableRepository(t *testing.T) {
	remote, base := makeRemote(t)
	other, _ := makeRemote(t)
	for _, tc := range []struct {
		name, want string
		setup      func(repo string) (folder string, job func(Job) Job)
	}{
		{"thư mục mất", "không còn", func(repo string) (string, func(Job) Job) {
			return filepath.Join(repo, "mat"), nil
		}},
		{"không phải repo", "không phải repo git", func(string) (string, func(Job) Job) {
			return t.TempDir(), nil
		}},
		{"remote khác", "không khớp", func(repo string) (string, func(Job) Job) {
			must(t, "git", "-C", repo, "remote", "set-url", "origin", fileURL(other))
			return repo, nil
		}},
		{"không có origin", "không có remote origin", func(repo string) (string, func(Job) Job) {
			must(t, "git", "-C", repo, "remote", "remove", "origin")
			return repo, nil
		}},
		{"nhánh đang checkout", "đang được checkout", func(repo string) (string, func(Job) Job) {
			must(t, "git", "-C", repo, "checkout", "-q", "-b", "ai/BUSY")
			return repo, func(j Job) Job { j.Branch = "ai/BUSY"; return j }
		}},
		{"commit chưa push", "chưa push", func(repo string) (string, func(Job) Job) {
			must(t, "git", "-C", repo, "branch", "ai/MINE")
			must(t, "git", "-C", repo, "worktree", "add", "-q", filepath.Join(t.TempDir(), "mine"), "ai/MINE")
			wt := strings.Fields(strings.Split(mustOut(t, "git", "-C", repo, "worktree", "list"), "\n")[1])[0]
			mustDir(t, wt, "mine.txt", "x")
			must(t, "git", "-C", wt, "add", ".")
			must(t, "git", "-C", wt, "-c", "user.name=Ha", "-c", "user.email=ha@example.invalid", "commit", "-qm", "của tôi")
			must(t, "git", "-C", repo, "worktree", "remove", wt)
			return repo, func(j Job) Job { j.Branch = "ai/MINE"; return j }
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := userRepo(t, remote)
			folder, change := tc.setup(repo)
			job := localJob("bad", remote, folder, "ai/BAD", base, "commit")
			if change != nil {
				job = change(job)
			}
			data := t.TempDir()
			res := runLocal(t, data, job, "commit")
			if res.Status != "failed" || !strings.Contains(res.Error, tc.want) {
				t.Fatalf("kết quả = %+v, muốn lỗi chứa %q", res, tc.want)
			}
			if caches, _ := filepath.Glob(filepath.Join(data, "repos", "*.git")); len(caches) != 0 {
				t.Fatal("quay về clone bare")
			}
		})
	}
}

// Run chỉ đọc của dự án đã gắn cũng dùng repo đó, tách HEAD nên không tạo nhánh.
func TestLocalRepoReadOnlyRunDetaches(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	job := localJob("plan", remote, repo, "ai/PLAN", base, "empty")
	job.Kind = KindPlan
	if res := runLocal(t, t.TempDir(), job, "empty"); res.Status != "succeeded" {
		t.Fatalf("kết quả = %+v", res)
	}
	if refExists(repo, "refs/heads/ai/PLAN") {
		t.Fatal("run plan tạo nhánh")
	}
}

// Worker chết giữa run của repo đã gắn: lần khởi động sau gỡ siêu dữ liệu worktree trong repo người dùng và trả nhánh.
func TestReapOrphansCleansLocalRepository(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	data := t.TempDir()
	root := filepath.Join(data, "runs")
	work := filepath.Join(root, "dead-1")
	src := localSource(repo)
	if err := src.openLocal(context.Background(), data, fileURL(remote)); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := src.prepareBranch(context.Background(), root, work, "ai/DEAD"); err != nil {
		t.Fatal(err)
	}
	if err := addWorktreeAt(context.Background(), src.lock, src.dir, work, "-B", "ai/DEAD", work, "origin/"+base); err != nil {
		t.Fatal(err)
	}
	if err := ReapOrphans(data, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(work); !os.IsNotExist(err) {
		t.Fatal("worktree mồ côi còn")
	}
	if left, _ := os.ReadDir(filepath.Join(repo, ".git", "worktrees")); len(left) != 0 {
		t.Fatalf("còn siêu dữ liệu worktree: %v", left)
	}
	if refExists(repo, "refs/heads/ai/DEAD") {
		t.Fatal("nhánh run tạo chưa được trả")
	}
	if _, err := os.Stat(markPath(work)); !os.IsNotExist(err) {
		t.Fatal("còn file ghi nhánh")
	}
}

func TestParseWorktrees(t *testing.T) {
	got := parseWorktrees("worktree /a\r\nHEAD 1\r\nbranch refs/heads/main\r\n\r\nworktree /b\r\nHEAD 2\r\ndetached\r\n")
	if len(got) != 2 || got[0].branch != "refs/heads/main" || got[1].branch != "" || got[1].path != filepath.FromSlash("/b") {
		t.Fatalf("parseWorktrees = %+v", got)
	}
}

// Review chạy nhiều lần trên repo của người dùng chỉ ghi một dòng vào info/exclude chung.
func TestAppendExcludeOnce(t *testing.T) {
	remote, _ := makeRemote(t)
	repo := userRepo(t, remote)
	for range 3 {
		if err := appendExclude(repo, ReviewDiffFile); err != nil {
			t.Fatal(err)
		}
	}
	b, _ := os.ReadFile(filepath.Join(repo, ".git", "info", "exclude"))
	if n := strings.Count(string(b), "/"+ReviewDiffFile); n != 1 {
		t.Fatalf("exclude có %d dòng:\n%s", n, b)
	}
}
