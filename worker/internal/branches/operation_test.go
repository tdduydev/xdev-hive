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

// opRepo là switchRepo đứng trên main, main có thêm một commit sửa log.txt: merge feature vào main sẽ xung đột.
func opRepo(t *testing.T, conflict bool) (folder, mainTip, featureTip string) {
	t.Helper()
	_, folder = switchRepo(t)
	t.Setenv("GIT_EDITOR", "true")
	if conflict {
		commit(t, folder, "main side")
	} else {
		writeFile(t, folder, "main.txt", "main\n")
		gitT(t, folder, "add", "main.txt")
		gitT(t, folder, "commit", "-qm", "main side")
	}
	return folder, headOf(t, folder), gitT(t, folder, "rev-parse", "refs/heads/feature")
}

func parentsOf(t *testing.T, dir, rev string) []string {
	t.Helper()
	return strings.Fields(gitT(t, dir, "rev-list", "--parents", "-n", "1", rev))[1:]
}

func wantState(t *testing.T, op *GitOperation, e *Error, state string) {
	t.Helper()
	if e != nil || op == nil || op.State != state {
		t.Fatalf("operation = %+v, lỗi %+v, muốn state %s", op, e, state)
	}
}

func TestMergeNoConflict(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, false)
	env := testEnv(t)
	op, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip, OntoName: "feature"})
	wantState(t, op, e, OperationDone)
	if op.Kind != OpMerge || op.Branch != "main" || op.HeadBefore != mainTip || op.Head != headOf(t, folder) {
		t.Fatalf("operation = %+v", op)
	}
	if op.Onto == nil || op.Onto.Name != "feature" || op.Onto.Tip != featureTip {
		t.Fatalf("onto = %+v", op.Onto)
	}
	if p := parentsOf(t, folder, "HEAD"); len(p) != 2 || p[0] != mainTip || p[1] != featureTip {
		t.Fatalf("parents = %v", p)
	}
	if op.Conflicts == nil || op.ConflictsTotal != 0 {
		t.Fatalf("conflicts = %#v", op.Conflicts)
	}
	logs := readLog(t, env.ConfigDir)
	if len(logs) != 2 || logs[0].Result != logStarted || logs[1].Result != OperationDone {
		t.Fatalf("nhật ký = %+v", logs)
	}
	for _, l := range logs {
		if l.Action != ActionMerge || l.HeadBefore != mainTip || l.Onto != "feature" || l.OntoTip != featureTip || l.Branch != "main" {
			t.Fatalf("dòng nhật ký = %+v", l)
		}
	}
}

func TestMergeFFAndNoFF(t *testing.T) {
	_, folder := switchRepo(t)
	t.Setenv("GIT_EDITOR", "true")
	mainTip := headOf(t, folder)
	featureTip := gitT(t, folder, "rev-parse", "refs/heads/feature")
	env := testEnv(t)

	// Tiến nhanh được mà không --ff thì vẫn có commit merge.
	op, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip})
	wantState(t, op, e, OperationDone)
	if p := parentsOf(t, folder, "HEAD"); len(p) != 2 || op.Onto.Name != featureTip {
		t.Fatalf("parents = %v, onto = %+v", p, op.Onto)
	}

	// --ff thắng merge.ff=false trong cấu hình repo.
	gitT(t, folder, "reset", "-q", "--hard", mainTip)
	gitT(t, folder, "config", "merge.ff", "false")
	op, e = Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip, FF: true})
	wantState(t, op, e, OperationDone)
	if op.Head != featureTip || headOf(t, folder) != featureTip {
		t.Fatalf("head = %s, muốn tiến nhanh tới %s", op.Head, featureTip)
	}

	// Không --ff thắng merge.ff=only.
	gitT(t, folder, "reset", "-q", "--hard", mainTip)
	gitT(t, folder, "config", "merge.ff", "only")
	op, e = Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip})
	wantState(t, op, e, OperationDone)
	if p := parentsOf(t, folder, "HEAD"); len(p) != 2 {
		t.Fatalf("parents = %v", p)
	}
}

func TestMergeConflictContinue(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, true)
	env := testEnv(t)
	op, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip, OntoName: "feature"})
	wantState(t, op, e, OperationConflict)
	if op.HeadBefore != mainTip || op.ConflictsTotal != 1 || op.Conflicts[0] != "log.txt" || op.Head != "" {
		t.Fatalf("operation = %+v", op)
	}
	if got := readLog(t, env.ConfigDir); len(got) != 2 || got[1].Result != OperationConflict {
		t.Fatalf("nhật ký = %+v", got)
	}

	// Còn file U: trả conflict, không chạy git.
	op, e = Continue(context.Background(), env, folder)
	wantState(t, op, e, OperationConflict)
	if op.HeadBefore != mainTip || op.Branch != "main" || OperationIn(filepath.Join(folder, ".git")) != OpMerge {
		t.Fatalf("operation = %+v", op)
	}
	if got := readLog(t, env.ConfigDir); len(got) != 2 {
		t.Fatalf("continue còn xung đột mà vẫn ghi nhật ký: %+v", got)
	}

	writeFile(t, folder, "log.txt", "resolved\n")
	gitT(t, folder, "add", "log.txt")
	r, _, _ := listAll(t, context.Background(), env, folder)
	wantState(t, r.Operation, nil, OperationInProgress)

	// Trình soạn thảo của người dùng không được mở: --continue phải tự xong.
	t.Setenv("GIT_EDITOR", "false")
	op, e = Continue(context.Background(), env, folder)
	wantState(t, op, e, OperationDone)
	if p := parentsOf(t, folder, "HEAD"); len(p) != 2 || p[0] != mainTip || p[1] != featureTip || op.Head != headOf(t, folder) {
		t.Fatalf("parents = %v, operation = %+v", p, op)
	}
	logs := readLog(t, env.ConfigDir)
	if last := logs[len(logs)-1]; last.Action != ActionContinue || last.Result != OperationDone || last.HeadBefore != mainTip {
		t.Fatalf("dòng nhật ký = %+v", last)
	}
}

func TestMergeConflictAbort(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, true)
	env := testEnv(t)
	op, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip})
	wantState(t, op, e, OperationConflict)

	op, e = Abort(context.Background(), env, folder)
	wantState(t, op, e, OperationAborted)
	if op.Kind != OpMerge || op.HeadBefore != mainTip || op.Head != mainTip || headOf(t, folder) != mainTip || op.ConflictsTotal != 0 {
		t.Fatalf("operation = %+v", op)
	}
	if st := gitT(t, folder, "status", "--porcelain"); st != "" || OperationIn(filepath.Join(folder, ".git")) != "" {
		t.Fatalf("sau abort còn %q", st)
	}
	logs := readLog(t, env.ConfigDir)
	if last := logs[len(logs)-1]; last.Action != ActionAbort || last.Result != OperationAborted || last.HeadBefore != mainTip {
		t.Fatalf("dòng nhật ký = %+v", last)
	}
	_, e = Abort(context.Background(), env, folder)
	wantCode(t, e, CodeNoOperation)
}

// rebaseRepo: topic có hai commit trên main cũ, commit thứ hai sửa log.txt mà main cũng sửa.
func rebaseRepo(t *testing.T) (folder, mainTip, topicTip string) {
	t.Helper()
	_, folder = switchRepo(t)
	t.Setenv("GIT_EDITOR", "true")
	gitT(t, folder, "switch", "-q", "-c", "topic")
	writeFile(t, folder, "a.txt", "a\n")
	gitT(t, folder, "add", "a.txt")
	gitT(t, folder, "commit", "-qm", "topic 1")
	commit(t, folder, "topic 2")
	topicTip = headOf(t, folder)
	gitT(t, folder, "switch", "-q", "main")
	commit(t, folder, "main side")
	mainTip = headOf(t, folder)
	gitT(t, folder, "switch", "-q", "topic")
	return folder, mainTip, topicTip
}

func TestRebaseConflictAtSecondCommit(t *testing.T) {
	folder, mainTip, topicTip := rebaseRepo(t)
	env := testEnv(t)
	op, e := Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: mainTip, OntoName: "main"})
	wantState(t, op, e, OperationConflict)
	if op.Kind != OpRebase || op.Branch != "topic" || op.HeadBefore != topicTip || op.Step != 2 || op.Total != 2 ||
		op.ConflictsTotal != 1 || op.Conflicts[0] != "log.txt" {
		t.Fatalf("operation = %+v", op)
	}

	// Bảng nhánh đọc lại được thao tác dở, kể cả nhánh khi HEAD đang rời.
	r, _, _ := listAll(t, context.Background(), env, folder)
	if o := r.Operation; o == nil || o.Kind != OpRebase || o.State != OperationConflict || o.Branch != "topic" ||
		o.HeadBefore != topicTip || o.Step != 2 || o.Total != 2 || o.Onto != nil {
		t.Fatalf("list operation = %+v", o)
	}

	// Đang dở thì merge, rebase khác bị chặn trước cả HEAD rời.
	_, e = Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: mainTip})
	wantCode(t, e, CodeInProgress)
	if e.Operation != OpRebase {
		t.Fatalf("operation = %q", e.Operation)
	}

	writeFile(t, folder, "log.txt", "resolved\n")
	gitT(t, folder, "add", "log.txt")
	t.Setenv("GIT_EDITOR", "false")
	op, e = Continue(context.Background(), env, folder)
	wantState(t, op, e, OperationDone)
	if branchOf(t, folder) != "topic" || op.Head != headOf(t, folder) || op.HeadBefore != topicTip {
		t.Fatalf("operation = %+v", op)
	}
	if p := parentsOf(t, folder, "HEAD~1"); len(p) != 1 || p[0] != mainTip {
		t.Fatalf("topic chưa nằm trên main: %v", p)
	}
}

func TestRebaseAbortRestoresHead(t *testing.T) {
	folder, mainTip, topicTip := rebaseRepo(t)
	env := testEnv(t)
	op, e := Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: mainTip})
	wantState(t, op, e, OperationConflict)

	op, e = Abort(context.Background(), env, folder)
	wantState(t, op, e, OperationAborted)
	if op.Kind != OpRebase || op.Branch != "topic" || op.HeadBefore != topicTip || op.Head != topicTip {
		t.Fatalf("operation = %+v", op)
	}
	if headOf(t, folder) != topicTip || branchOf(t, folder) != "topic" || gitT(t, folder, "status", "--porcelain") != "" {
		t.Fatal("abort không đưa topic về như cũ")
	}
	_, e = Continue(context.Background(), env, folder)
	wantCode(t, e, CodeNoOperation)
}

func TestOperationDirtyRefused(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, false)
	env := testEnv(t)
	writeFile(t, folder, "README.md", "changed\n")
	_, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip})
	wantCode(t, e, CodeDirty)
	if e.FilesTotal != 1 || e.Files[0] != "README.md" {
		t.Fatalf("files = %v", e.Files)
	}
	gitT(t, folder, "checkout", "--", "README.md")

	// File chưa theo dõi cũng chặn: merge có thể đè lên nó hay để nó lẫn vào commit giải xung đột.
	writeFile(t, folder, "new.txt", "x\n")
	_, e = Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: featureTip})
	wantCode(t, e, CodeDirty)
	if headOf(t, folder) != mainTip {
		t.Fatal("bị chặn mà HEAD vẫn đổi")
	}
	if _, err := os.Stat(LogPath(env.ConfigDir)); err == nil {
		t.Fatal("bị chặn mà vẫn ghi nhật ký")
	}
}

func TestRebaseNeedsConfirmPushed(t *testing.T) {
	seed, folder := switchRepo(t)
	t.Setenv("GIT_EDITOR", "true")
	writeFile(t, folder, "main.txt", "main\n")
	gitT(t, folder, "add", "main.txt")
	gitT(t, folder, "commit", "-qm", "main side")
	mainTip := headOf(t, folder)
	// Nhánh remote khác có commit chưa vào main: không được tính vào số commit rebase viết lại.
	gitT(t, seed, "switch", "-q", "-c", "other")
	for _, m := range []string{"o1", "o2", "o3"} {
		writeFile(t, seed, "other.txt", m+"\n")
		gitT(t, seed, "add", "other.txt")
		gitT(t, seed, "commit", "-qm", m)
	}
	gitT(t, seed, "push", "-q", "origin", "other")
	gitT(t, folder, "fetch", "-q", "origin")
	gitT(t, folder, "switch", "-q", "feature")
	writeFile(t, folder, "local.txt", "x\n")
	gitT(t, folder, "add", "local.txt")
	gitT(t, folder, "commit", "-qm", "local only")
	before := headOf(t, folder)
	env := testEnv(t)

	_, e := Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: mainTip})
	wantCode(t, e, CodeNeedsConfirm)
	if e.Count != 1 {
		t.Fatalf("count = %d, muốn 1 (commit feature đã đẩy)", e.Count)
	}
	if headOf(t, folder) != before {
		t.Fatal("chưa xác nhận mà đã rebase")
	}
	op, e := Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: mainTip, ConfirmRewrite: true})
	wantState(t, op, e, OperationDone)
	if gitT(t, folder, "rev-list", "--count", mainTip+"..HEAD") != "2" || branchOf(t, folder) != "feature" {
		t.Fatal("rebase không đặt hai commit của feature lên main")
	}

	// Chưa đẩy commit nào thì không hỏi.
	gitT(t, folder, "switch", "-q", "-c", "fresh", mainTip+"~1")
	writeFile(t, folder, "fresh.txt", "x\n")
	gitT(t, folder, "add", "fresh.txt")
	gitT(t, folder, "commit", "-qm", "fresh")
	op, e = Rebase(context.Background(), env, RebaseOptions{Folder: folder, Onto: mainTip})
	wantState(t, op, e, OperationDone)
}

// Tag trùng tên nhánh đích: --onto là mã commit nên tag không được chọn nhầm, tên chỉ để hiện.
func TestMergeTagSameNameAsTarget(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, false)
	gitT(t, folder, "tag", "feature", mainTip+"~1")
	env := testEnv(t)
	_, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: "feature"})
	wantCode(t, e, CodeNotFound)
	op, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip, OntoName: "feature"})
	wantState(t, op, e, OperationDone)
	if p := parentsOf(t, folder, "HEAD"); len(p) != 2 || p[1] != featureTip {
		t.Fatalf("parents = %v, muốn nhánh feature %s", p, featureTip)
	}
	// Mã của tag có chú thích được đổi sang commit nó trỏ tới.
	gitT(t, folder, "reset", "-q", "--hard", mainTip)
	gitT(t, folder, "tag", "-a", "-m", "rel", "v1", featureTip)
	op, e = Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: gitT(t, folder, "rev-parse", "v1")})
	wantState(t, op, e, OperationDone)
	if op.Onto.Tip != featureTip {
		t.Fatalf("onto = %+v", op.Onto)
	}
}

func TestOperationRefusals(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, false)
	env := testEnv(t)
	ctx := context.Background()

	_, e := Merge(ctx, env, MergeOptions{Folder: folder, Onto: strings.Repeat("0", 40)})
	wantCode(t, e, CodeNotFound)
	_, e = Merge(ctx, env, MergeOptions{Folder: filepath.Join(t.TempDir(), "none"), Onto: featureTip})
	wantCode(t, e, CodeNotRepo)

	gitT(t, folder, "switch", "-q", "--detach", "HEAD")
	_, e = Rebase(ctx, env, RebaseOptions{Folder: folder, Onto: featureTip})
	wantCode(t, e, CodeDetached)
	gitT(t, folder, "switch", "-q", "main")

	busy := []BusyDir{{Path: folder, Kind: BusyTerminal}}
	env.Busy = func() []BusyDir { return busy }
	_, e = Merge(ctx, env, MergeOptions{Folder: folder, Onto: featureTip})
	wantCode(t, e, CodeBusy)
	op, e := Merge(ctx, env, MergeOptions{Folder: folder, Onto: featureTip, ConfirmBusy: true})
	wantState(t, op, e, OperationDone)
	gitT(t, folder, "reset", "-q", "--hard", mainTip)
	env.Busy = nil

	for _, f := range []func() (*GitOperation, *Error){
		func() (*GitOperation, *Error) { return Continue(ctx, env, folder) },
		func() (*GitOperation, *Error) { return Abort(ctx, env, folder) },
	} {
		_, e := f()
		wantCode(t, e, CodeNoOperation)
	}
}

// cherry-pick dở: list báo, continue, abort không đụng tới.
func TestCherryPickNotHandled(t *testing.T) {
	folder, _, featureTip := opRepo(t, true)
	if _, err := gitTry(folder, "cherry-pick", featureTip); err == nil {
		t.Fatal("cherry-pick phải xung đột")
	}
	env := testEnv(t)
	_, e := Continue(context.Background(), env, folder)
	wantCode(t, e, CodeNoOperation)
	_, e = Abort(context.Background(), env, folder)
	wantCode(t, e, CodeNoOperation)
	r, _, _ := listAll(t, context.Background(), env, folder)
	if o := r.Operation; o == nil || o.Kind != OpCherryPick || o.State != OperationConflict || o.Branch != "main" {
		t.Fatalf("list operation = %+v", o)
	}
	if OperationIn(filepath.Join(folder, ".git")) != OpCherryPick {
		t.Fatal("cherry-pick bị huỷ")
	}
}

func TestMergeLocked(t *testing.T) {
	folder, mainTip, featureTip := opRepo(t, false)
	env := testEnv(t)
	unlock, err := repolock.LockRepo(context.Background(), commonLock(t, env, folder))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	old := lockWait
	lockWait = 200 * time.Millisecond
	t.Cleanup(func() { lockWait = old })

	_, e := Merge(context.Background(), env, MergeOptions{Folder: folder, Onto: featureTip})
	wantCode(t, e, CodeLocked)
	if headOf(t, folder) != mainTip {
		t.Fatal("khoá đang bị giữ mà vẫn merge")
	}
}
