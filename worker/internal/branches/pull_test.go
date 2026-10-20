package branches

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// pullRepo là thư mục đã clone, main theo dõi origin/main; seed là bản "của người khác" để đẩy commit mới lên remote.
func pullRepo(t *testing.T) (seed, folder string) {
	t.Helper()
	isolateGit(t)
	_, seed, folder = newRemote(t)
	return seed, folder
}

func pushFromSeed(t *testing.T, seed, msg string) {
	t.Helper()
	commit(t, seed, msg)
	gitT(t, seed, "push", "-q", "origin", "main")
}

// runPull chạy Pull và trả sự kiện done cùng các progress đã phát.
func runPull(t *testing.T, env Env, o PullOptions) (Event, []Event) {
	t.Helper()
	return runPullCtx(t, context.Background(), env, o)
}

func runPullCtx(t *testing.T, ctx context.Context, env Env, o PullOptions) (Event, []Event) {
	t.Helper()
	var events []Event
	Pull(ctx, env, o, func(ev Event) { events = append(events, ev) })
	if len(events) == 0 || events[len(events)-1].Type != EventDone {
		t.Fatalf("dòng cuối phải là done: %+v", events)
	}
	return events[len(events)-1], events[:len(events)-1]
}

func TestPullBehindFastForwards(t *testing.T) {
	seed, folder := pullRepo(t)
	before := headOf(t, folder)
	pushFromSeed(t, seed, "c2")
	pushFromSeed(t, seed, "c3")
	env := testEnv(t)

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull == nil {
		t.Fatalf("%+v", done)
	}
	head := headOf(t, folder)
	if head != headOf(t, seed) || head == before {
		t.Fatalf("HEAD %s, muốn %s", head, headOf(t, seed))
	}
	if p := done.Pull; p.State != PullDone || p.HeadBefore != before || p.Head != head || p.Behind != 2 {
		t.Fatalf("pull = %+v", p)
	}
	if len(progress) != 2 || progress[0].Step != StepFetch || progress[0].Remote != "origin" || progress[0].Result != ResultDone ||
		progress[1].Step != StepMerge {
		t.Fatalf("progress = %+v", progress)
	}
	if done.Folder != folder {
		t.Fatalf("folder = %q", done.Folder)
	}

	log := readLog(t, env.ConfigDir)
	if len(log) != 1 || log[0].Action != ActionPull || log[0].Result != ResultDone || log[0].Branch != "main" ||
		log[0].HeadBefore != before || log[0].Tip != head || log[0].Onto != "origin/main" || log[0].OntoTip != head {
		t.Fatalf("log = %+v", log)
	}
}

func TestPullUnchanged(t *testing.T) {
	_, folder := pullRepo(t)
	env := testEnv(t)
	head := headOf(t, folder)

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull == nil || done.Pull.State != PullUnchanged || done.Pull.Head != head {
		t.Fatalf("%+v", done)
	}
	if len(progress) != 1 || progress[0].Step != StepFetch {
		t.Fatalf("không behind thì không có bước merge: %+v", progress)
	}

	// Chỉ ahead cũng là không có gì để kéo.
	commit(t, folder, "local")
	done, _ = runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull.State != PullUnchanged || done.Pull.Head != headOf(t, folder) {
		t.Fatalf("%+v", done)
	}
	if _, err := os.Stat(LogPath(env.ConfigDir)); !os.IsNotExist(err) {
		t.Fatal("không đổi gì thì không ghi nhật ký")
	}
}

func TestPullDiverged(t *testing.T) {
	seed, folder := pullRepo(t)
	writeFile(t, folder, "local.txt", "local\n")
	gitT(t, folder, "add", "local.txt")
	gitT(t, folder, "commit", "-qm", "local 1")
	writeFile(t, folder, "local.txt", "local 2\n")
	gitT(t, folder, "commit", "-aqm", "local 2")
	pushFromSeed(t, seed, "remote")
	before := headOf(t, folder)
	env := testEnv(t)

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	e := done.Error
	wantCode(t, e, CodeDiverged)
	if e.Ahead != 2 || e.Behind != 1 || e.Upstream != "origin/main" || e.UpstreamTip != headOf(t, seed) {
		t.Fatalf("diverged = %+v", e)
	}
	if done.Pull != nil || headOf(t, folder) != before {
		t.Fatal("diverged thì không đổi gì")
	}
	// Đã fetch (để biết behind), nhưng không có bước merge.
	for _, p := range progress {
		if p.Step == StepMerge {
			t.Fatal("diverged mà vẫn chạy merge")
		}
	}
	if _, err := os.Stat(LogPath(env.ConfigDir)); !os.IsNotExist(err) {
		t.Fatal("không ghi gì thì không có nhật ký")
	}
}

func TestPullDirty(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	before := headOf(t, folder)
	env := testEnv(t)

	// File đã theo dõi đang sửa.
	writeFile(t, folder, "log.txt", "changed\n")
	done, progress := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeDirty)
	if len(done.Error.Files) != 1 || done.Error.Files[0] != "log.txt" || done.Error.FilesTotal != 1 {
		t.Fatalf("dirty = %+v", done.Error)
	}
	if len(progress) != 0 {
		t.Fatalf("bẩn thì không fetch: %+v", progress)
	}
	gitT(t, folder, "checkout", "--", "log.txt")

	// File chưa theo dõi cũng chặn (khác switch).
	writeFile(t, folder, "scratch.txt", "x\n")
	done, _ = runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeDirty)
	if len(done.Error.Files) != 1 || done.Error.Files[0] != "scratch.txt" {
		t.Fatalf("dirty = %+v", done.Error)
	}
	if headOf(t, folder) != before {
		t.Fatal("HEAD đã đổi dù thư mục bẩn")
	}

	// File bị .gitignore bỏ qua thì không phải bẩn.
	if err := os.Remove(filepath.Join(folder, "scratch.txt")); err != nil {
		t.Fatal(err)
	}
	writeFile(t, folder, ".git/info/exclude", "ignored.txt\n")
	writeFile(t, folder, "ignored.txt", "x\n")
	done, _ = runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull.State != PullDone {
		t.Fatalf("%+v", done)
	}
}

func TestPullNoUpstream(t *testing.T) {
	_, folder := pullRepo(t)
	env := testEnv(t)
	gitT(t, folder, "switch", "-q", "-c", "local-only")

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeNoUpstream)
	if done.Error.Upstream != "" || len(progress) != 0 {
		t.Fatalf("%+v %+v", done.Error, progress)
	}
}

// Nhánh trên remote bị xoá: upstream vẫn ghi trong cấu hình nhưng ref mất sau fetch --prune.
func TestPullUpstreamDeleted(t *testing.T) {
	seed, folder := pullRepo(t)
	env := testEnv(t)
	gitT(t, seed, "switch", "-q", "-c", "topic")
	commit(t, seed, "topic")
	gitT(t, seed, "push", "-q", "-u", "origin", "topic")
	gitT(t, folder, "fetch", "-q")
	gitT(t, folder, "switch", "-q", "--track", "origin/topic")
	gitT(t, seed, "push", "-q", "origin", "--delete", "topic")

	done, _ := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeNoUpstream)
	if done.Error.Upstream != "origin/topic" {
		t.Fatalf("upstream = %q", done.Error.Upstream)
	}
}

func TestPullFetchFailed(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	before := headOf(t, folder)
	env := testEnv(t)
	gitT(t, folder, "remote", "set-url", "origin", filepath.Join(t.TempDir(), "gone.git"))

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeFetchFailed)
	if done.Error.Remote != "origin" || done.Error.Detail == "" {
		t.Fatalf("fetch_failed = %+v", done.Error)
	}
	if len(progress) != 1 || progress[0].Step != StepFetch || progress[0].Result != ResultFailed {
		t.Fatalf("progress = %+v", progress)
	}
	if headOf(t, folder) != before {
		t.Fatal("fetch lỗi mà HEAD vẫn đổi")
	}
}

// Upstream là nhánh local khác (remote "."): không có gì để fetch, vẫn tiến nhanh được.
func TestPullLocalUpstream(t *testing.T) {
	_, folder := pullRepo(t)
	env := testEnv(t)
	gitT(t, folder, "branch", "-q", "--track", "follow", "main")
	commit(t, folder, "ahead on main")
	gitT(t, folder, "switch", "-q", "follow")

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull.State != PullDone || done.Pull.Behind != 1 {
		t.Fatalf("%+v %+v", done, done.Error)
	}
	if len(progress) != 1 || progress[0].Step != StepMerge {
		t.Fatalf("progress = %+v", progress)
	}
	if headOf(t, folder) != gitT(t, folder, "rev-parse", "main") {
		t.Fatal("follow chưa tiến tới main")
	}
}

func TestPullDetachedAndInProgress(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	env := testEnv(t)

	// Merge dở (MERGE_HEAD có trong thư mục git).
	gitDir := filepath.Join(folder, ".git")
	writeFile(t, gitDir, "MERGE_HEAD", headOf(t, folder)+"\n")
	done, progress := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeInProgress)
	if done.Error.Operation != OpMerge || len(progress) != 0 {
		t.Fatalf("%+v %+v", done.Error, progress)
	}
	if err := os.Remove(filepath.Join(gitDir, "MERGE_HEAD")); err != nil {
		t.Fatal(err)
	}

	gitT(t, folder, "switch", "-q", "--detach")
	done, progress = runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeDetached)
	if len(progress) != 0 {
		t.Fatalf("progress = %+v", progress)
	}
}

func TestPullNotRepo(t *testing.T) {
	env := testEnv(t)
	for _, dir := range []string{filepath.Join(t.TempDir(), "gone"), t.TempDir()} {
		done, _ := runPull(t, env, PullOptions{Folder: dir})
		wantCode(t, done.Error, CodeNotRepo)
	}
}

func TestPullBusy(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	wt := filepath.Join(t.TempDir(), "wt")
	gitT(t, folder, "worktree", "add", "-q", "--track", "-b", "side", wt, "origin/main")
	pushFromSeed(t, seed, "c3")
	env := testEnv(t)
	busy := []BusyDir{{Path: filepath.Join(folder, "src"), Kind: BusyAgent, Label: "claude (pid 1)"}}
	env.Busy = func() []BusyDir { return busy }
	before := headOf(t, folder)

	done, progress := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeBusy)
	if len(done.Error.Busy) != 1 || done.Error.Busy[0].Label != "claude (pid 1)" || len(progress) != 0 {
		t.Fatalf("%+v %+v", done.Error, progress)
	}
	if headOf(t, folder) != before {
		t.Fatal("busy mà HEAD vẫn đổi")
	}
	// Agent ở thư mục chính không chặn worktree liên kết.
	done, _ = runPull(t, env, PullOptions{Folder: wt})
	if done.Error != nil || done.Pull.State != PullDone || headOf(t, wt) != headOf(t, seed) {
		t.Fatalf("%+v", done)
	}
	done, _ = runPull(t, env, PullOptions{Folder: folder, ConfirmBusy: true})
	if done.Error != nil || done.Pull.State != PullDone {
		t.Fatalf("%+v", done)
	}
}

func TestPullRunWorktreeAlwaysBusy(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	env := testEnv(t)
	wt := filepath.Join(env.DataDir, "runs", "r1")
	gitT(t, folder, "worktree", "add", "-q", "--track", "-b", "run", wt, "origin/main")

	done, _ := runPull(t, env, PullOptions{Folder: wt, ConfirmBusy: true})
	wantCode(t, done.Error, CodeBusy)
	if len(done.Error.Busy) != 1 || done.Error.Busy[0].Kind != BusyHiveWorker {
		t.Fatalf("busy = %+v", done.Error.Busy)
	}
}

func TestPullLocked(t *testing.T) {
	seed, folder := pullRepo(t)
	pushFromSeed(t, seed, "c2")
	env := testEnv(t)
	before := headOf(t, folder)
	unlock, err := repolock.LockRepo(context.Background(), commonLock(t, env, folder))
	if err != nil {
		t.Fatal(err)
	}
	old := lockWait
	lockWait = 300 * time.Millisecond
	t.Cleanup(func() { lockWait = old })

	start := time.Now()
	done, _ := runPull(t, env, PullOptions{Folder: folder})
	wantCode(t, done.Error, CodeLocked)
	if time.Since(start) < lockWait || headOf(t, folder) != before {
		t.Fatal("khoá đang bị giữ mà vẫn tiến nhanh")
	}
	if _, err := os.Stat(LogPath(env.ConfigDir)); !os.IsNotExist(err) {
		t.Fatal("chưa ghi gì thì không có nhật ký")
	}

	lockWait = 10 * time.Second
	go func() {
		time.Sleep(200 * time.Millisecond)
		unlock()
	}()
	done, _ = runPull(t, env, PullOptions{Folder: folder})
	if done.Error != nil || done.Pull.State != PullDone {
		t.Fatalf("%+v", done)
	}
}

// Huỷ ở bước nào trước khi có khoá thì nhánh giữ nguyên: lệnh ghi chỉ chạy khi còn nguyên ngữ cảnh lúc lấy khoá.
func TestPullCancelledBeforeMerge(t *testing.T) {
	for _, step := range []string{StepFetch, StepMerge} {
		seed, folder := pullRepo(t)
		pushFromSeed(t, seed, "c2")
		env := testEnv(t)
		before := headOf(t, folder)
		ctx, cancel := context.WithCancel(context.Background())
		var events []Event
		Pull(ctx, env, PullOptions{Folder: folder}, func(ev Event) {
			events = append(events, ev)
			if ev.Step == step {
				cancel()
			}
		})
		cancel()
		done := events[len(events)-1]
		wantCode(t, done.Error, CodeCancelled)
		if headOf(t, folder) != before {
			t.Fatalf("huỷ ở %s mà HEAD vẫn đổi", step)
		}
		if _, err := os.Stat(LogPath(env.ConfigDir)); !os.IsNotExist(err) {
			t.Fatalf("huỷ ở %s thì không có gì để ghi nhật ký", step)
		}
	}
}
