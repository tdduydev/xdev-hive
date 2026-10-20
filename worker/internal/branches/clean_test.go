package branches

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// cleanAll chạy Clean, trả các sự kiện theo thứ tự in.
func cleanAll(ctx context.Context, env Env, items []CleanItem, fetched map[string][]string) []Event {
	var mu sync.Mutex
	var events []Event
	Clean(ctx, env, items, fetched, func(ev Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, ev)
	})
	return events
}

// cleanResults gom kết quả theo tên nhánh, kèm sự kiện done.
func cleanResults(t *testing.T, events []Event) (map[string]CleanResult, Event) {
	t.Helper()
	out := map[string]CleanResult{}
	var done Event
	for _, ev := range events {
		switch ev.Type {
		case EventItem:
			out[ev.Item.Branch] = *ev.Item
		case EventDone:
			done = ev
		}
	}
	if done.Type != EventDone {
		t.Fatal("không có sự kiện done")
	}
	return out, done
}

func itemOf(c Candidate) CleanItem {
	it := CleanItem{Folder: c.Folder, Branch: c.Branch, Tip: c.Tip, Evidence: c.Evidence}
	if c.Worktree != nil {
		it.Worktree, it.Prunable = c.Worktree.Path, c.Worktree.Prunable
	}
	return it
}

// scanItems quét có fetch như lúc người dùng mở hộp thoại, trả mục dọn của các ứng viên theo tên nhánh và fetched.
func scanItems(t *testing.T, env Env, folder string) (map[string]CleanItem, map[string][]string) {
	t.Helper()
	r := scanOne(t, env, folder, false)
	if r.Error != nil {
		t.Fatal(r.Error)
	}
	items := map[string]CleanItem{}
	for _, c := range r.Candidates {
		items[c.Branch] = itemOf(c)
	}
	return items, map[string][]string{folder: r.Fetched}
}

func hasBranch(t *testing.T, dir, name string) bool {
	_, err := gitTry(dir, "show-ref", "--verify", "--quiet", "refs/heads/"+name)
	return err == nil
}

func exists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func wantResult(t *testing.T, got map[string]CleanResult, branch, result, code string) CleanResult {
	t.Helper()
	r, ok := got[branch]
	if !ok {
		t.Fatalf("không có kết quả của %s: %+v", branch, got)
	}
	if r.Result != result || (code != "" && r.Code != code) {
		t.Fatalf("%s: muốn %s/%s, được %+v", branch, result, code, r)
	}
	return r
}

// cleanRepo là repo có .gitignore (.env, node_modules/) đã đẩy, để worktree có file bị bỏ qua.
func cleanRepo(t *testing.T) (bare, seed, folder string) {
	isolateGit(t)
	bare, seed, folder = newRemote(t)
	writeFile(t, folder, ".gitignore", ".env\nnode_modules/\n")
	commit(t, folder, "ignore")
	gitT(t, folder, "push", "-q", "origin", "main")
	return bare, seed, folder
}

func remoteRefs(t *testing.T, bare string) string {
	return gitT(t, bare, "for-each-ref", "--format=%(refname) %(objectname)")
}

func readLog(t *testing.T, configDir string) []LogEntry {
	t.Helper()
	f, err := os.Open(LogPath(configDir))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []LogEntry
	s := bufio.NewScanner(f)
	for s.Scan() {
		var e LogEntry
		if err := json.Unmarshal(s.Bytes(), &e); err != nil {
			t.Fatalf("dòng nhật ký hỏng %q: %v", s.Text(), err)
		}
		out = append(out, e)
	}
	return out
}

func TestCleanRemoves(t *testing.T) {
	bare, _, folder := cleanRepo(t)
	base := filepath.Dir(folder)
	wtA := filepath.Join(base, "wt", "a")
	mergedWorktree(t, folder, "ai/a", wtA)
	// node_modules dựng lại được: không chặn, worktree remove xoá theo.
	writeFile(t, wtA, "node_modules/x/index.js", "x\n")
	tipB := mergeNoFF(t, folder, "ai/b")
	gitT(t, folder, "push", "-q", "origin", "main", "ai/b")
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	if len(items) != 2 {
		t.Fatalf("ứng viên: %+v", items)
	}
	before := remoteRefs(t, bare)

	events := cleanAll(context.Background(), env, []CleanItem{items["ai/a"], items["ai/b"]}, fetched)
	got, done := cleanResults(t, events)
	a := wantResult(t, got, "ai/a", ResultRemoved, "")
	if !a.WorktreeRemoved || !a.BranchDeleted || !repolock.SamePath(a.Worktree, wtA) {
		t.Fatalf("ai/a: %+v", a)
	}
	if b := wantResult(t, got, "ai/b", ResultRemoved, ""); b.WorktreeRemoved || !b.BranchDeleted {
		t.Fatalf("ai/b: %+v", b)
	}
	if exists(wtA) || hasBranch(t, folder, "ai/a") || hasBranch(t, folder, "ai/b") {
		t.Fatal("chưa gỡ worktree hoặc chưa xoá nhánh")
	}
	// FR-031: nhánh trên remote còn nguyên, không lệnh nào ghi lên remote.
	if after := remoteRefs(t, bare); after != before || !strings.Contains(after, "refs/heads/ai/b "+tipB) {
		t.Fatalf("remote đổi:\n%s\n---\n%s", before, after)
	}

	var steps []string
	for _, ev := range events {
		if ev.Type == EventProgress {
			steps = append(steps, ev.Branch+":"+ev.Step)
		}
	}
	want := "ai/a:removeWorktree ai/a:deleteBranch ai/b:deleteBranch"
	if strings.Join(steps, " ") != want {
		t.Fatalf("progress = %v", steps)
	}
	if done.Summary[ResultRemoved] != 2 || done.Error != nil || intOf(done.Done) != "2" || done.Log != LogPath(env.ConfigDir) {
		t.Fatalf("done = %+v", done)
	}
	logs := readLog(t, env.ConfigDir)
	if len(logs) != 2 {
		t.Fatalf("nhật ký: %+v", logs)
	}
	for _, l := range logs {
		if l.Action != ActionClean || l.Result != ResultRemoved || l.Evidence != EvidenceMergedGit || l.Tip == "" ||
			l.Restore != "git branch "+l.Branch+" "+l.Tip {
			t.Fatalf("dòng nhật ký: %+v", l)
		}
	}
}

// SC-003: thay đổi giữa lúc quét và lúc dọn không làm mất commit chưa đẩy hay worktree bẩn.
func TestCleanSC003ChangesAfterScan(t *testing.T) {
	_, _, folder := cleanRepo(t)
	base := filepath.Dir(folder)
	wt := func(n string) string { return filepath.Join(base, "wt", n) }
	for _, n := range []string{"commit", "file", "ignored", "agent", "free"} {
		mergedWorktree(t, folder, "ai/"+n, wt(n))
	}
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	if len(items) != 5 {
		t.Fatalf("ứng viên: %+v", items)
	}

	commit(t, wt("commit"), "việc mới")
	writeFile(t, wt("file"), "notes.md", "mới\n")
	writeFile(t, wt("ignored"), ".env", "SECRET=1\n")
	env.Busy = func() []BusyDir { return []BusyDir{{Path: wt("agent"), Kind: BusyAgent}} }
	var list []CleanItem
	for _, n := range []string{"commit", "file", "ignored", "agent", "free"} {
		list = append(list, items["ai/"+n])
	}
	got, done := cleanResults(t, cleanAll(context.Background(), env, list, fetched))

	wantResult(t, got, "ai/commit", ResultSkipped, CodeTipChanged)
	wantResult(t, got, "ai/file", ResultSkipped, BlockUntracked)
	wantResult(t, got, "ai/ignored", ResultSkipped, BlockIgnored)
	wantResult(t, got, "ai/agent", ResultSkipped, BlockBusy)
	wantResult(t, got, "ai/free", ResultRemoved, "")
	for _, n := range []string{"commit", "file", "ignored", "agent"} {
		if !exists(wt(n)) || !hasBranch(t, folder, "ai/"+n) {
			t.Fatalf("ai/%s bị gỡ dù bị chặn", n)
		}
	}
	if !exists(filepath.Join(wt("ignored"), ".env")) || !exists(filepath.Join(wt("file"), "notes.md")) {
		t.Fatal("mất file của người dùng")
	}
	if done.Summary[ResultSkipped] != 4 || done.Summary[ResultRemoved] != 1 {
		t.Fatalf("summary = %+v", done.Summary)
	}
}

// Ref remote đổi sau khi quét: bằng chứng git và commit chưa đẩy được đọc lại, không tin xem trước.
func TestCleanRecheckEvidenceAndUnpushed(t *testing.T) {
	_, _, folder := cleanRepo(t)
	initTip := gitT(t, folder, "rev-parse", "origin/main")
	mergeNoFF(t, folder, "ai/merged")
	gitT(t, folder, "push", "-q", "origin", "main")
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	// Bằng chứng API không đọc lại được; commit chưa đẩy vẫn chặn.
	gitT(t, folder, "switch", "-q", "-c", "ai/api", "main")
	commit(t, folder, "chưa đẩy")
	apiTip := gitT(t, folder, "rev-parse", "HEAD")
	gitT(t, folder, "switch", "-q", "main")
	api := CleanItem{Folder: folder, Branch: "ai/api", Tip: apiTip, Evidence: Evidence{Kind: EvidenceMergedAPI}}
	none := CleanItem{Folder: folder, Branch: "ai/api", Tip: apiTip, Evidence: Evidence{Kind: EvidenceNone}}

	got, _ := cleanResults(t, cleanAll(context.Background(), env, []CleanItem{api}, fetched))
	if r := wantResult(t, got, "ai/api", ResultSkipped, BlockUnpushed); r.Reason == "" {
		t.Fatalf("%+v", r)
	}
	got, _ = cleanResults(t, cleanAll(context.Background(), env, []CleanItem{none}, fetched))
	wantResult(t, got, "ai/api", ResultSkipped, BlockNoEvidence)
	// fetched rỗng (fetch lỗi hết lúc quét): đỉnh ngoài nhánh mặc định không được xoá (FR-027).
	gitT(t, folder, "push", "-q", "origin", "ai/api")
	got, _ = cleanResults(t, cleanAll(context.Background(), env, []CleanItem{api}, nil))
	wantResult(t, got, "ai/api", ResultSkipped, BlockNeedsFetch)

	// origin/main lùi về trước merge (force-push rồi fetch): không còn bằng chứng git.
	gitT(t, folder, "update-ref", "refs/remotes/origin/main", initTip)
	got, _ = cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/merged"]}, fetched))
	wantResult(t, got, "ai/merged", ResultSkipped, BlockNoEvidence)
	if !hasBranch(t, folder, "ai/merged") || !hasBranch(t, folder, "ai/api") {
		t.Fatal("xoá nhánh dù bị chặn")
	}
	// fetched rỗng mà đỉnh đã trong nhánh mặc định thì xoá được.
	gitT(t, folder, "update-ref", "refs/remotes/origin/main", gitT(t, folder, "rev-parse", "main"))
	got, _ = cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/merged"]}, nil))
	wantResult(t, got, "ai/merged", ResultRemoved, "")
}

func TestCleanPrunable(t *testing.T) {
	_, _, folder := cleanRepo(t)
	base := filepath.Dir(folder)
	gone := filepath.Join(base, "wt", "gone")
	back := filepath.Join(base, "wt", "back")
	// Thư mục cha cũng mất: giống ổ chưa gắn, không gỡ được đăng ký.
	noParent := filepath.Join(base, "disk", "x")
	mergedWorktree(t, folder, "ai/gone", gone)
	mergedWorktree(t, folder, "ai/back", back)
	mergedWorktree(t, folder, "ai/noparent", noParent)
	for _, p := range []string{gone, back} {
		if err := os.RemoveAll(p); err != nil {
			t.Fatal(err)
		}
	}
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	for _, n := range []string{"ai/gone", "ai/back"} {
		if !items[n].Prunable {
			t.Fatalf("%s: %+v", n, items[n])
		}
	}
	// Đường dẫn lấy từ xem trước như app: thư mục mất rồi thì không giải được liên kết /var → /private/var trên macOS.
	np := items["ai/noparent"]
	np.Prunable = true
	if err := os.RemoveAll(filepath.Dir(noParent)); err != nil {
		t.Fatal(err)
	}
	// Ổ vừa gắn lại sau khi quét: thư mục có lại, xoá là mất file chưa được đồng ý.
	writeFile(t, back, "keep.txt", "giữ\n")

	got, _ := cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/gone"], items["ai/back"], np}, fetched))
	if r := wantResult(t, got, "ai/gone", ResultRemoved, ""); !r.WorktreeRemoved || !r.BranchDeleted {
		t.Fatalf("ai/gone: %+v", r)
	}
	wantResult(t, got, "ai/back", ResultSkipped, CodeTipChanged)
	wantResult(t, got, "ai/noparent", ResultSkipped, BlockUnreachable)
	if !exists(filepath.Join(back, "keep.txt")) {
		t.Fatal("mất file của worktree có lại")
	}
	wts := gitT(t, folder, "worktree", "list", "--porcelain")
	if strings.Contains(wts, "ai/gone") || !strings.Contains(wts, "ai/noparent") || !strings.Contains(wts, "ai/back") {
		t.Fatalf("đăng ký worktree sai:\n%s", wts)
	}
}

func TestCleanClosedAPI(t *testing.T) {
	bare, seed, folder := cleanRepo(t)
	branch := func(name string) string {
		gitT(t, folder, "switch", "-q", "-c", name, "main")
		commit(t, folder, name)
		gitT(t, folder, "push", "-q", "origin", name)
		gitT(t, folder, "switch", "-q", "main")
		return gitT(t, folder, "rev-parse", name)
	}
	tips := map[string]string{}
	for _, n := range []string{"ai/kept", "ai/deleted", "ai/moved", "ai/ahead"} {
		tips[n] = branch(n)
	}
	gitT(t, seed, "fetch", "-q", "origin")
	// Remote xoá nhánh sau khi PR đóng: không còn bản nào giữ commit.
	gitT(t, seed, "push", "-q", "origin", "--delete", "ai/deleted")
	// Nhánh trên remote bị ghi đè bằng commit máy này không có.
	gitT(t, seed, "switch", "-q", "-c", "moved", "origin/main")
	commit(t, seed, "khác")
	gitT(t, seed, "push", "-q", "--force", "origin", "moved:ai/moved")
	// Nhánh trên remote có thêm commit, máy này đã fetch: đỉnh cũ vẫn nằm trong đó.
	gitT(t, seed, "switch", "-q", "-c", "ahead", "origin/ai/ahead")
	commit(t, seed, "thêm")
	gitT(t, seed, "push", "-q", "origin", "ahead:ai/ahead")
	gitT(t, folder, "fetch", "-q", "origin", "ai/ahead:refs/remotes/origin/ai/ahead")
	before := remoteRefs(t, bare)

	var list []CleanItem
	for _, n := range []string{"ai/kept", "ai/deleted", "ai/moved", "ai/ahead"} {
		list = append(list, CleanItem{Folder: folder, Branch: n, Tip: tips[n], Evidence: Evidence{Kind: EvidenceClosedAPI}})
	}
	env := testEnv(t)
	got, _ := cleanResults(t, cleanAll(context.Background(), env, list, map[string][]string{folder: {"origin"}}))
	wantResult(t, got, "ai/kept", ResultRemoved, "")
	wantResult(t, got, "ai/ahead", ResultRemoved, "")
	wantResult(t, got, "ai/deleted", ResultSkipped, CodeRemoteGone)
	wantResult(t, got, "ai/moved", ResultSkipped, CodeRemoteMoved)
	if !hasBranch(t, folder, "ai/deleted") || !hasBranch(t, folder, "ai/moved") {
		t.Fatal("xoá nhánh mà remote không còn giữ commit")
	}
	if after := remoteRefs(t, bare); after != before {
		t.Fatalf("remote đổi:\n%s\n---\n%s", before, after)
	}
}

func TestCleanLocked(t *testing.T) {
	_, _, folder := cleanRepo(t)
	wt := filepath.Join(filepath.Dir(folder), "wt", "a")
	mergedWorktree(t, folder, "ai/a", wt)
	mergeNoFF(t, folder, "ai/b")
	gitT(t, folder, "push", "-q", "origin", "main")
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	unlock, err := repolock.LockRepo(context.Background(), commonLock(t, env, folder))
	if err != nil {
		t.Fatal(err)
	}
	defer unlock()
	old := lockWait
	lockWait = 300 * time.Millisecond
	t.Cleanup(func() { lockWait = old })

	got, _ := cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/a"], items["ai/b"]}, fetched))
	wantResult(t, got, "ai/b", ResultSkipped, CodeLocked)
	// Worktree gỡ ngoài khoá (plan.md mục 6); nhánh chỉ xoá trong khoá nên còn.
	if a := wantResult(t, got, "ai/a", ResultError, CodeLocked); !a.WorktreeRemoved || a.BranchDeleted {
		t.Fatalf("ai/a: %+v", a)
	}
	if !hasBranch(t, folder, "ai/a") || !hasBranch(t, folder, "ai/b") {
		t.Fatal("xoá nhánh khi khoá đang bị giữ")
	}
}

func TestCleanCheckedOutElsewhere(t *testing.T) {
	_, _, folder := cleanRepo(t)
	base := filepath.Dir(folder)
	mergeNoFF(t, folder, "ai/a")
	mergeNoFF(t, folder, "ai/race")
	gitT(t, folder, "push", "-q", "origin", "main")
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)

	// Mở sau khi quét: thấy ngay lúc đọc lại.
	gitT(t, folder, "worktree", "add", "-q", filepath.Join(base, "wt", "a"), "ai/a")
	// Mở sau lúc đọc lại, trước branch -D: Busy được gọi sau khi worker đã đọc danh sách worktree.
	var once sync.Once
	env.Busy = func() []BusyDir {
		once.Do(func() { gitT(t, folder, "worktree", "add", "-q", filepath.Join(base, "wt", "race"), "ai/race") })
		return nil
	}
	got, _ := cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/race"]}, fetched))
	if r := wantResult(t, got, "ai/race", ResultError, CodeGit); r.BranchDeleted {
		t.Fatalf("%+v", r)
	}
	env.Busy = nil
	got, _ = cleanResults(t, cleanAll(context.Background(), env, []CleanItem{items["ai/a"]}, fetched))
	wantResult(t, got, "ai/a", ResultSkipped, CodeCheckedOut)
	for _, n := range []string{"a", "race"} {
		if !hasBranch(t, folder, "ai/"+n) || !exists(filepath.Join(base, "wt", n, "log.txt")) {
			t.Fatalf("ai/%s bị xoá dù đang mở ở worktree khác", n)
		}
	}
}

func TestCleanCancel(t *testing.T) {
	_, _, folder := cleanRepo(t)
	mergeNoFF(t, folder, "ai/a")
	mergeNoFF(t, folder, "ai/b")
	gitT(t, folder, "push", "-q", "origin", "main")
	env := testEnv(t)
	items, fetched := scanItems(t, env, folder)
	list := []CleanItem{items["ai/a"], items["ai/b"]}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	got, done := cleanResults(t, cleanAll(ctx, env, list, fetched))
	wantResult(t, got, "ai/a", ResultCancelled, "")
	wantResult(t, got, "ai/b", ResultCancelled, "")
	if done.Error == nil || done.Error.Code != CodeCancelled || done.Summary[ResultCancelled] != 2 {
		t.Fatalf("done = %+v", done)
	}
	if !hasBranch(t, folder, "ai/a") || !hasBranch(t, folder, "ai/b") {
		t.Fatal("xoá nhánh sau khi huỷ")
	}
	if exists(LogPath(env.ConfigDir)) {
		t.Fatal("mục chưa chạy không ghi nhật ký")
	}

	// Huỷ giữa mục đầu: mục đó chạy hết, mục sau không chạy.
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	var events []Event
	Clean(ctx, env, list, fetched, func(ev Event) {
		if ev.Type == EventProgress && ev.Step == StepDeleteBranch {
			cancel()
		}
		events = append(events, ev)
	})
	got, _ = cleanResults(t, events)
	wantResult(t, got, "ai/a", ResultRemoved, "")
	wantResult(t, got, "ai/b", ResultCancelled, "")
	if hasBranch(t, folder, "ai/a") || !hasBranch(t, folder, "ai/b") {
		t.Fatal("huỷ giữa chừng làm sai mục")
	}
}

func TestCleanTwoRepos(t *testing.T) {
	_, _, one := cleanRepo(t)
	_, _, two := newRemote(t)
	for _, f := range []string{one, two} {
		mergeNoFF(t, f, "ai/x")
		gitT(t, f, "push", "-q", "origin", "main")
	}
	env := testEnv(t)
	a, fa := scanItems(t, env, one)
	b, fb := scanItems(t, env, two)
	fetched := map[string][]string{one: fa[one], two: fb[two]}
	events := cleanAll(context.Background(), env, []CleanItem{a["ai/x"], b["ai/x"]}, fetched)
	n := 0
	for _, ev := range events {
		if ev.Type == EventItem {
			n++
			if ev.Item.Result != ResultRemoved || intOf(ev.Done) != strconv.Itoa(n) {
				t.Fatalf("item = %+v done=%s", ev.Item, intOf(ev.Done))
			}
		}
	}
	if n != 2 || hasBranch(t, one, "ai/x") || hasBranch(t, two, "ai/x") {
		t.Fatalf("hai repo: %d mục", n)
	}
}

func TestCleanInvalidItem(t *testing.T) {
	isolateGit(t)
	dir := newRepo(t)
	missing := filepath.Join(t.TempDir(), "missing")
	tip := gitT(t, dir, "rev-parse", "HEAD")
	list := []CleanItem{
		{Folder: dir, Branch: "ai/short", Tip: tip[:7]},
		{Folder: dir, Branch: "", Tip: tip},
		{Folder: missing, Branch: "ai/gone", Tip: tip},
	}
	got, done := cleanResults(t, cleanAll(context.Background(), testEnv(t), list, nil))
	wantResult(t, got, "ai/short", ResultError, CodeInvalidInput)
	wantResult(t, got, "", ResultError, CodeInvalidInput)
	wantResult(t, got, "ai/gone", ResultError, CodeNotRepo)
	if done.Summary[ResultError] != 3 {
		t.Fatalf("summary = %+v", done.Summary)
	}
}
