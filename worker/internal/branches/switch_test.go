package branches

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// switchRepo là thư mục đã clone, main có README.md đã theo dõi, thêm nhánh feature (một commit sửa log.txt) trên cả
// local và remote.
func switchRepo(t *testing.T) (seed, folder string) {
	t.Helper()
	isolateGit(t)
	_, seed, folder = newRemote(t)
	writeFile(t, folder, "README.md", "hello\n")
	gitT(t, folder, "add", "README.md")
	gitT(t, folder, "commit", "-qm", "readme")
	gitT(t, folder, "push", "-q", "origin", "main")
	gitT(t, seed, "pull", "-q", "--ff-only", "origin", "main")
	gitT(t, folder, "switch", "-q", "-c", "feature")
	commit(t, folder, "feature")
	gitT(t, folder, "push", "-q", "-u", "origin", "feature")
	gitT(t, folder, "switch", "-q", "main")
	return seed, folder
}

func headOf(t *testing.T, dir string) string {
	t.Helper()
	return gitT(t, dir, "rev-parse", "HEAD")
}

func branchOf(t *testing.T, dir string) string {
	t.Helper()
	return gitT(t, dir, "branch", "--show-current")
}

func wantCode(t *testing.T, e *Error, code string) {
	t.Helper()
	if e == nil || e.Code != code {
		t.Fatalf("lỗi = %#v, muốn %s", e, code)
	}
}

func TestSwitchBranch(t *testing.T) {
	_, folder := switchRepo(t)
	before := headOf(t, folder)
	res, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: folder, Branch: "feature"})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if branchOf(t, folder) != "feature" || res.Head != headOf(t, folder) || res.HeadBefore != before || res.Carried {
		t.Fatalf("res = %+v, nhánh %s", res, branchOf(t, folder))
	}
}

func TestSwitchNotFoundAndNotRepo(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	_, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "nope"})
	wantCode(t, e, CodeNotFound)
	// Cú pháp revision không phải tên nhánh: main~1 là một commit có thật mà git switch sẽ từ chối.
	_, e = Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "main~1"})
	wantCode(t, e, CodeNotFound)
	_, e = Switch(context.Background(), env, SwitchOptions{Folder: folder, Track: "origin/nope"})
	wantCode(t, e, CodeNotFound)
	_, e = Switch(context.Background(), env, SwitchOptions{Folder: filepath.Join(folder, "gone"), Branch: "main"})
	wantCode(t, e, CodeNotRepo)
	plain := t.TempDir()
	_, e = Switch(context.Background(), env, SwitchOptions{Folder: plain, Branch: "main"})
	wantCode(t, e, CodeNotRepo)
}

func TestSwitchDirtyAndCarry(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	writeFile(t, folder, "README.md", "sửa\n")
	writeFile(t, folder, "new.txt", "chưa theo dõi\n")
	_, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature"})
	wantCode(t, e, CodeDirty)
	if e.FilesTotal != 1 || len(e.Files) != 1 || e.Files[0] != "README.md" {
		t.Fatalf("file bẩn = %+v", e)
	}
	if branchOf(t, folder) != "main" {
		t.Fatal("bẩn mà vẫn đổi nhánh")
	}
	res, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature", Carry: true})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if !res.Carried || branchOf(t, folder) != "feature" {
		t.Fatalf("res = %+v", res)
	}
	if b, _ := os.ReadFile(filepath.Join(folder, "README.md")); string(b) != "sửa\n" {
		t.Fatalf("thay đổi không đi theo: %q", b)
	}
}

func TestSwitchUntrackedOnlyIsNotDirty(t *testing.T) {
	_, folder := switchRepo(t)
	writeFile(t, folder, "scratch.txt", "x\n")
	res, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: folder, Branch: "feature"})
	if e != nil || res.Carried {
		t.Fatalf("res = %+v, lỗi %+v", res, e)
	}
}

// Thay đổi đụng file khác nhau giữa hai nhánh: git từ chối, thư mục giữ nguyên, lỗi có dòng của git.
func TestSwitchCarryConflictKeepsFolder(t *testing.T) {
	_, folder := switchRepo(t)
	writeFile(t, folder, "log.txt", "sửa ở main\n")
	_, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: folder, Branch: "feature", Carry: true})
	wantCode(t, e, CodeGit)
	if e.Detail == "" {
		t.Fatal("thiếu detail của git")
	}
	if branchOf(t, folder) != "main" {
		t.Fatal("git từ chối mà nhánh vẫn đổi")
	}
	if b, _ := os.ReadFile(filepath.Join(folder, "log.txt")); string(b) != "sửa ở main\n" {
		t.Fatalf("thay đổi bị mất: %q", b)
	}
}

func TestSwitchCheckedOutElsewhere(t *testing.T) {
	_, folder := switchRepo(t)
	wt := filepath.Join(t.TempDir(), "wt-feature")
	gitT(t, folder, "worktree", "add", "-q", wt, "feature")
	_, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: folder, Branch: "feature"})
	wantCode(t, e, CodeCheckedOut)
	if !repolock.SamePath(e.Path, wt) {
		t.Fatalf("path = %q, muốn %q", e.Path, wt)
	}
	// Đứng trong chính worktree đó thì nhánh không "mở ở chỗ khác".
	if _, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: wt, Branch: "feature"}); e != nil {
		t.Fatal(e)
	}
	// Từ worktree đổi sang main đang mở ở thư mục chính cũng bị chặn.
	_, e = Switch(context.Background(), testEnv(t), SwitchOptions{Folder: wt, Branch: "main"})
	wantCode(t, e, CodeCheckedOut)
	if !repolock.SamePath(e.Path, folder) {
		t.Fatalf("path = %q, muốn %q", e.Path, folder)
	}
}

func TestSwitchInProgress(t *testing.T) {
	_, folder := switchRepo(t)
	gitT(t, folder, "switch", "-q", "-c", "other")
	writeFile(t, folder, "log.txt", "other\n")
	gitT(t, folder, "commit", "-qam", "other")
	if _, err := gitTry(folder, "merge", "feature"); err == nil {
		t.Fatal("merge phải xung đột")
	}
	_, e := Switch(context.Background(), testEnv(t), SwitchOptions{Folder: folder, Branch: "main", Carry: true})
	wantCode(t, e, CodeInProgress)
	if e.Operation != OpMerge {
		t.Fatalf("operation = %q", e.Operation)
	}
	_, e = Create(context.Background(), testEnv(t), CreateOptions{Folder: folder, Name: "x", Base: "refs/heads/main", Switch: true, Carry: true})
	wantCode(t, e, CodeInProgress)
}

// Tag trùng tên nhánh: git switch chỉ nhận nhánh, create đi theo tên ref đầy đủ.
func TestSwitchAndCreateTagSameName(t *testing.T) {
	_, folder := switchRepo(t)
	gitT(t, folder, "tag", "feature", "main")
	gitT(t, folder, "tag", "origin/feature", "main")
	featureTip := gitT(t, folder, "rev-parse", "refs/heads/feature")
	env := testEnv(t)
	res, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature"})
	if e != nil || res.Head != featureTip {
		t.Fatalf("res = %+v, lỗi %+v, muốn %s", res, e, featureTip)
	}
	gitT(t, folder, "switch", "-q", "main")
	gitT(t, folder, "branch", "-q", "-D", "feature")
	res, e = Switch(context.Background(), env, SwitchOptions{Folder: folder, Track: "origin/feature"})
	if e != nil || res.Head != featureTip || res.Branch != "feature" {
		t.Fatalf("track: res = %+v, lỗi %+v", res, e)
	}
	c, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "from-tagless", Base: "refs/remotes/origin/feature"})
	if e != nil || c.Tip != featureTip {
		t.Fatalf("create: res = %+v, lỗi %+v", c, e)
	}
}

func TestSwitchTrack(t *testing.T) {
	_, folder := switchRepo(t)
	gitT(t, folder, "branch", "-q", "-D", "feature")
	env := testEnv(t)
	res, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Track: "origin/feature"})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if res.Branch != "feature" || branchOf(t, folder) != "feature" {
		t.Fatalf("res = %+v", res)
	}
	if up := gitT(t, folder, "rev-parse", "--abbrev-ref", "feature@{upstream}"); up != "origin/feature" {
		t.Fatalf("upstream = %q", up)
	}
	gitT(t, folder, "switch", "-q", "main")
	_, e = Switch(context.Background(), env, SwitchOptions{Folder: folder, Track: "origin/feature"})
	wantCode(t, e, CodeExists)
}

func TestSwitchBusy(t *testing.T) {
	_, folder := switchRepo(t)
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, folder, "worktree", "add", "-q", "-b", "side", wt, "main")
	env := testEnv(t)
	busy := []BusyDir{{Path: filepath.Join(folder, "src"), Kind: BusyAgent, Label: "claude (pid 1)"}}
	env.Busy = func() []BusyDir { return busy }

	_, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature"})
	wantCode(t, e, CodeBusy)
	if len(e.Busy) != 1 || e.Busy[0].Label != "claude (pid 1)" {
		t.Fatalf("busy = %+v", e.Busy)
	}
	// Agent ở thư mục chính không chặn worktree liên kết.
	if _, e := Switch(context.Background(), env, SwitchOptions{Folder: wt, Branch: "feature"}); e != nil {
		t.Fatal(e)
	}
	_, e = Create(context.Background(), env, CreateOptions{Folder: folder, Name: "n1", Base: "refs/heads/main", Switch: true})
	wantCode(t, e, CodeBusy)
	// Không đổi sang thì busy không chặn: tạo nhánh không đụng thư mục làm việc.
	if _, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "n2", Base: "refs/heads/main"}); e != nil {
		t.Fatal(e)
	}
	if _, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "n2", ConfirmBusy: true}); e != nil {
		t.Fatal(e)
	}
}

func TestSwitchRunWorktreeAlwaysBusy(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	wt := filepath.Join(env.DataDir, "runs", "r1")
	gitT(t, folder, "worktree", "add", "-q", "-b", "run", wt, "main")
	_, e := Switch(context.Background(), env, SwitchOptions{Folder: wt, Branch: "feature", ConfirmBusy: true})
	wantCode(t, e, CodeBusy)
	if len(e.Busy) != 1 || e.Busy[0].Kind != BusyHiveWorker {
		t.Fatalf("busy = %+v", e.Busy)
	}
}

func commonLock(t *testing.T, env Env, folder string) string {
	t.Helper()
	common := gitT(t, folder, "rev-parse", "--path-format=absolute", "--git-common-dir")
	lock := repolock.LocalLock(env.DataDir, filepath.Clean(filepath.FromSlash(common)))
	if err := os.MkdirAll(filepath.Dir(lock), 0o700); err != nil {
		t.Fatal(err)
	}
	return lock
}

func TestSwitchLocked(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	unlock, err := repolock.LockRepo(context.Background(), commonLock(t, env, folder))
	if err != nil {
		t.Fatal(err)
	}
	old := lockWait
	lockWait = 300 * time.Millisecond
	t.Cleanup(func() { lockWait = old })

	start := time.Now()
	_, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature"})
	wantCode(t, e, CodeLocked)
	if time.Since(start) < lockWait {
		t.Fatal("trả locked mà không chờ")
	}
	if branchOf(t, folder) != "main" {
		t.Fatal("khoá đang bị giữ mà vẫn đổi nhánh")
	}
	_, e = Create(context.Background(), env, CreateOptions{Folder: folder, Name: "x", Base: "refs/heads/main"})
	wantCode(t, e, CodeLocked)

	// Khoá được nhả trong lúc chờ thì lệnh chạy tiếp.
	lockWait = 10 * time.Second
	go func() {
		time.Sleep(200 * time.Millisecond)
		unlock()
	}()
	if _, e := Switch(context.Background(), env, SwitchOptions{Folder: folder, Branch: "feature"}); e != nil {
		t.Fatal(e)
	}
}

// Worktree liên kết và thư mục chính khoá cùng một file: khoá theo thư mục git chung.
func TestLockSharedAcrossWorktrees(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, folder, "worktree", "add", "-q", "-b", "side", wt, "main")
	unlock, err := repolock.LockRepo(context.Background(), commonLock(t, env, folder))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	old := lockWait
	lockWait = 200 * time.Millisecond
	t.Cleanup(func() { lockWait = old })
	_, e := Switch(context.Background(), env, SwitchOptions{Folder: wt, Branch: "feature"})
	wantCode(t, e, CodeLocked)
}

func TestWriteGitIgnoresCancel(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	cancel()
	wctx, g := Env{}.writeGit(ctx, WriteTimeout)
	if wctx.Err() != nil {
		t.Fatal("context của lệnh ghi bị huỷ theo lệnh")
	}
	if g.Timeout <= 0 || g.Timeout > 5*time.Second {
		t.Fatalf("timeout = %v, muốn cắt theo --timeout còn lại", g.Timeout)
	}
}

func TestSwitchCancelledBeforeWrite(t *testing.T) {
	_, folder := switchRepo(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := Switch(ctx, testEnv(t), SwitchOptions{Folder: folder, Branch: "feature"})
	wantCode(t, e, CodeCancelled)
	if branchOf(t, folder) != "main" {
		t.Fatal("đã huỷ mà vẫn đổi nhánh")
	}
}

func TestCreateInvalidName(t *testing.T) {
	_, folder := switchRepo(t)
	for _, name := range []string{"feature/a..b", "-x", "HEAD", "@{-1}", "feature/", "a b", "a~1", ""} {
		_, e := Create(context.Background(), testEnv(t), CreateOptions{Folder: folder, Name: name, Base: "refs/heads/main", DryRun: true})
		if e == nil || e.Code != CodeInvalidName {
			t.Errorf("%q: lỗi = %+v, muốn invalid_name", name, e)
		}
	}
}

func TestCreateExistsAndBaseNotFound(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	tip := gitT(t, folder, "rev-parse", "feature")
	_, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "feature", Base: "refs/heads/main"})
	wantCode(t, e, CodeExists)
	if got := gitT(t, folder, "rev-parse", "feature"); got != tip {
		t.Fatal("nhánh đã có bị đặt lại")
	}
	// Nhánh chặn đường dẫn: git không tạo được feature/abc khi có feature, hay topic khi có topic/x; dry-run phải thấy.
	gitT(t, folder, "branch", "topic/x", "main")
	for _, name := range []string{"feature/abc", "topic"} {
		_, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: name, Base: "refs/heads/main", DryRun: true})
		if e == nil || e.Code != CodeExists {
			t.Errorf("%q: lỗi = %#v, muốn exists", name, e)
		}
	}
	for _, base := range []string{"refs/heads/nope", "refs/remotes/origin/nope", "main", "refs/tags/v1"} {
		_, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "fresh", Base: base})
		if e == nil || e.Code != CodeNotFound {
			t.Errorf("%q: lỗi = %+v, muốn not_found", base, e)
		}
	}
	_, e = Create(context.Background(), env, CreateOptions{Folder: t.TempDir(), Name: "x", Base: "refs/heads/main"})
	wantCode(t, e, CodeNotRepo)
}

func TestCreateDryRunWritesNothing(t *testing.T) {
	seed, folder := switchRepo(t)
	commit(t, seed, "mới trên remote")
	gitT(t, seed, "push", "-q", "origin", "main")
	before := gitT(t, folder, "rev-parse", "refs/remotes/origin/main")
	res, e := Create(context.Background(), testEnv(t), CreateOptions{
		Folder: folder, Name: "abc", Base: "refs/remotes/origin/main", Switch: true, Fetch: true, DryRun: true,
	})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if !res.DryRun || res.Switched || res.Fetched || res.Tip != before {
		t.Fatalf("res = %+v", res)
	}
	if _, err := gitTry(folder, "show-ref", "--verify", "--quiet", "refs/heads/abc"); err == nil {
		t.Fatal("dry-run tạo nhánh")
	}
	if got := gitT(t, folder, "rev-parse", "refs/remotes/origin/main"); got != before {
		t.Fatal("dry-run fetch")
	}
}

func TestCreateNoTrack(t *testing.T) {
	_, folder := switchRepo(t)
	// autoSetupMerge=always làm git branch tự đặt upstream kể cả khi gốc là nhánh local; --no-track phải thắng.
	gitT(t, folder, "config", "branch.autoSetupMerge", "always")
	env := testEnv(t)
	res, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "topic/abc", Base: "refs/remotes/origin/main"})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if res.Switched || branchOf(t, folder) != "main" || res.Tip != gitT(t, folder, "rev-parse", "origin/main") {
		t.Fatalf("res = %+v", res)
	}
	res, e = Create(context.Background(), env, CreateOptions{Folder: folder, Name: "topic/def", Base: "refs/remotes/origin/main", Switch: true})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if !res.Switched || branchOf(t, folder) != "topic/def" {
		t.Fatalf("res = %+v", res)
	}
	for _, name := range []string{"topic/abc", "topic/def"} {
		if out, err := gitTry(folder, "config", "--get", "branch."+name+".remote"); err == nil {
			t.Errorf("%s có upstream %q", name, strings.TrimSpace(out))
		}
	}
}

func TestCreateSwitchDirty(t *testing.T) {
	_, folder := switchRepo(t)
	env := testEnv(t)
	writeFile(t, folder, "README.md", "sửa\n")
	_, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "n1", Base: "refs/heads/feature", Switch: true})
	wantCode(t, e, CodeDirty)
	if _, err := gitTry(folder, "show-ref", "--verify", "--quiet", "refs/heads/n1"); err == nil {
		t.Fatal("bẩn mà vẫn tạo nhánh")
	}
	res, e := Create(context.Background(), env, CreateOptions{Folder: folder, Name: "n1", Base: "refs/heads/feature", Switch: true, Carry: true})
	if e != nil || !res.Switched || branchOf(t, folder) != "n1" {
		t.Fatalf("res = %+v, lỗi %+v", res, e)
	}
}

func TestCreateFetchBase(t *testing.T) {
	seed, folder := switchRepo(t)
	commit(t, seed, "mới trên remote")
	gitT(t, seed, "push", "-q", "origin", "main")
	want := headOf(t, seed)
	res, e := Create(context.Background(), testEnv(t), CreateOptions{
		Folder: folder, Name: "fresh", Base: "refs/remotes/origin/main", Fetch: true, Switch: true,
	})
	if e != nil {
		t.Fatalf("%#v", e)
	}
	if !res.Fetched || res.Tip != want || headOf(t, folder) != want {
		t.Fatalf("res = %+v, muốn %s", res, want)
	}
	// Gốc là nhánh local thì không có gì để fetch.
	res, e = Create(context.Background(), testEnv(t), CreateOptions{Folder: folder, Name: "fresh2", Base: "refs/heads/main", Fetch: true})
	if e != nil || res.Fetched {
		t.Fatalf("res = %+v, lỗi %+v", res, e)
	}
}

func TestCreateFetchFailed(t *testing.T) {
	_, folder := switchRepo(t)
	gitT(t, folder, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "missing.git"))
	_, e := Create(context.Background(), testEnv(t), CreateOptions{
		Folder: folder, Name: "fresh", Base: "refs/remotes/origin/main", Fetch: true,
	})
	wantCode(t, e, CodeFetchFailed)
	if e.Remote != "origin" {
		t.Fatalf("remote = %q", e.Remote)
	}
	if _, err := gitTry(folder, "show-ref", "--verify", "--quiet", "refs/heads/fresh"); err == nil {
		t.Fatal("fetch lỗi mà vẫn tạo nhánh")
	}
	// Giao diện hỏi rồi gọi lại không --fetch: tạo từ bản đã có trên máy.
	if _, e := Create(context.Background(), testEnv(t), CreateOptions{Folder: folder, Name: "fresh", Base: "refs/remotes/origin/main"}); e != nil {
		t.Fatal(e)
	}
}
