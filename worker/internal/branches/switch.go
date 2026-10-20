package branches

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// WriteTimeout là giới hạn riêng của switch, branch: hợp đồng mục 1.5 không ghi riêng, lấy như merge, rebase, và
// writeGit vẫn cắt theo --timeout còn lại.
const WriteTimeout = 120 * time.Second

// lockWait là thời gian chờ khoá repo; biến để test không phải chờ đủ 30 giây.
var lockWait = LockTimeout

// SwitchOptions là cờ của `switch`: đúng một trong Branch (nhánh local) và Track (<remote>/<tên>).
type SwitchOptions struct {
	Folder      string
	Branch      string
	Track       string
	Carry       bool
	ConfirmBusy bool
}

type SwitchResult struct {
	Folder     string `json:"folder"`
	Branch     string `json:"branch"`
	HeadBefore string `json:"headBefore,omitempty"`
	Head       string `json:"head"`
	Carried    bool   `json:"carried"`
}

// Switch là lệnh `switch` (US2, FR-010…FR-012): kiểm theo thứ tự của hợp đồng mục 3.5 rồi `git switch` trong khoá
// repo. Không --force, --discard-changes, --merge: git từ chối thì thư mục giữ nguyên và lỗi git đi ra.
func Switch(ctx context.Context, env Env, o SwitchOptions) (*SwitchResult, *Error) {
	w, e := env.openWorkdir(ctx, o.Folder)
	if e != nil {
		return nil, e
	}
	name, args := o.Branch, []string{"switch", "--quiet"}
	if o.Track != "" {
		remotes, err := env.remotes(ctx, o.Folder)
		if err != nil {
			return nil, gitFailure(err)
		}
		_, name = splitRemote(o.Track, remotes)
		ref := "refs/remotes/" + o.Track
		if e := env.mustRef(ctx, o.Folder, ref, "Không có nhánh "+o.Track+" trên máy."); e != nil {
			return nil, e
		}
		if name == "" {
			return nil, &Error{Code: CodeNotFound, Message: "Không có nhánh " + o.Track + " trên máy.", Detail: ref}
		}
		if e := env.notExists(ctx, o.Folder, name); e != nil {
			return nil, e
		}
		// Tên ref đầy đủ để tag trùng tên "origin/x" không được chọn thay nhánh remote; --create đặt tên local rõ ràng
		// thay vì để git tự suy từ refspec.
		args = append(args, "--track", "--create="+name, "--end-of-options", ref)
	} else {
		if e := env.mustRef(ctx, o.Folder, "refs/heads/"+name, "Không có nhánh "+name+" trên máy."); e != nil {
			return nil, e
		}
		// git switch chỉ nhận tên nhánh, nên tag cùng tên không bị chọn nhầm.
		args = append(args, "--end-of-options", name)
	}
	if e := w.inProgress(); e != nil {
		return nil, e
	}
	if o.Track == "" {
		if e := w.checkedOut(name); e != nil {
			return nil, e
		}
	}
	if e := w.checkBusy(env, o.ConfirmBusy); e != nil {
		return nil, e
	}
	t, _, err := env.readTree(ctx, o.Folder, false)
	if err != nil {
		return nil, gitFailure(err)
	}
	if e := dirtyError(t, o.Carry); e != nil {
		return nil, e
	}

	res := &SwitchResult{Folder: o.Folder, Branch: name, HeadBefore: t.oid, Carried: o.Carry && len(t.tracked) > 0}
	if e := env.write(ctx, o.Folder, args...); e != nil {
		return nil, e
	}
	// Đã đổi xong: huỷ lúc này không được biến kết quả thành lỗi, giao diện cần biết thư mục đã sang nhánh mới.
	head, err := env.read(context.WithoutCancel(ctx), o.Folder, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return nil, gitFailure(err)
	}
	res.Head = strings.TrimSpace(head)
	return res, nil
}

// CreateOptions là cờ của `create`; Base là tên ref đầy đủ.
type CreateOptions struct {
	Folder      string
	Name        string
	Base        string
	Switch      bool
	Fetch       bool
	Carry       bool
	ConfirmBusy bool
	DryRun      bool
}

type CreateResult struct {
	Folder   string `json:"folder"`
	Name     string `json:"name"`
	Base     string `json:"base"`
	Tip      string `json:"tip"`
	Switched bool   `json:"switched"`
	Fetched  bool   `json:"fetched"`
	DryRun   bool   `json:"dryRun"`
}

// Create là lệnh `create` (US3, FR-013): kiểm theo thứ tự của hợp đồng mục 3.6, fetch nhánh gốc ngoài khoá, rồi tạo
// nhánh từ mã của gốc trong khoá. Không -B, -C: nhánh đã có thì trả exists chứ không đặt lại.
func Create(ctx context.Context, env Env, o CreateOptions) (*CreateResult, *Error) {
	w, e := env.openWorkdir(ctx, o.Folder)
	if e != nil {
		return nil, e
	}
	if e := env.checkName(ctx, o.Folder, o.Name); e != nil {
		return nil, e
	}
	if e := env.notExists(ctx, o.Folder, o.Name); e != nil {
		return nil, e
	}
	isRemote := strings.HasPrefix(o.Base, "refs/remotes/")
	if !isRemote && !strings.HasPrefix(o.Base, "refs/heads/") {
		return nil, &Error{Code: CodeNotFound, Message: "Nhánh gốc phải là nhánh local hay nhánh remote.", Detail: o.Base}
	}
	tip, e := env.tipOf(ctx, o.Folder, o.Base)
	if e != nil {
		return nil, e
	}
	res := &CreateResult{Folder: o.Folder, Name: o.Name, Base: o.Base, Tip: tip, DryRun: o.DryRun}
	if o.DryRun {
		return res, nil
	}

	var t tree
	if o.Switch {
		if e := w.inProgress(); e != nil {
			return nil, e
		}
		if e := w.checkBusy(env, o.ConfirmBusy); e != nil {
			return nil, e
		}
		var err error
		if t, _, err = env.readTree(ctx, o.Folder, false); err != nil {
			return nil, gitFailure(err)
		}
		if e := dirtyError(t, o.Carry); e != nil {
			return nil, e
		}
	}
	if o.Fetch && isRemote {
		if e := env.fetchBase(ctx, o.Folder, o.Base); e != nil {
			return nil, e
		}
		res.Fetched = true
		if res.Tip, e = env.tipOf(ctx, o.Folder, o.Base); e != nil {
			return nil, e
		}
	}

	// Tạo từ mã chứ không từ tên ref, để ref gốc đổi giữa lúc đọc và lúc tạo thì nhánh vẫn đúng mã đã trả cho giao diện.
	args := []string{"branch", "--no-track", "--end-of-options", o.Name, res.Tip}
	if o.Switch {
		args = []string{"switch", "--quiet", "--no-track", "--create=" + o.Name, "--end-of-options", res.Tip}
	}
	if e := env.write(ctx, o.Folder, args...); e != nil {
		if e.Code == CodeGit && strings.Contains(e.Detail, "already exists") {
			return nil, existsError(o.Name)
		}
		return nil, e
	}
	res.Switched = o.Switch
	return res, nil
}

// workdir là thư mục làm việc của switch, create (thư mục chính hay worktree liên kết) cùng danh sách worktree của repo
// để xét checked_out và busy.
type workdir struct {
	folder    string
	gitDir    string
	worktrees []repolock.Worktree
	paths     []string
	owner     int
	dataDir   string
}

func (e Env) openWorkdir(ctx context.Context, folder string) (*workdir, *Error) {
	if !isDir(folder) {
		return nil, notRepo(folder)
	}
	gitDir, err := e.gitDirOf(ctx, folder)
	if err != nil {
		return nil, repoError(folder, err)
	}
	out, err := e.read(ctx, folder, "worktree", "list", "--porcelain")
	if err != nil {
		return nil, gitFailure(err)
	}
	w := &workdir{folder: folder, gitDir: gitDir, worktrees: repolock.ParseWorktrees(out), owner: -1, dataDir: e.DataDir}
	best := -1
	for i, wt := range w.worktrees {
		w.paths = append(w.paths, wt.Path)
		if (repolock.SamePath(wt.Path, folder) || repolock.InsideDir(wt.Path, folder)) && len(wt.Path) > best {
			w.owner, best = i, len(wt.Path)
		}
	}
	// --folder là thư mục con mà git không liệt kê (không nên có): coi nó là một worktree riêng để busy vẫn xét được.
	if w.owner < 0 {
		w.paths = append(w.paths, folder)
		w.owner = len(w.paths) - 1
	}
	return w, nil
}

// inProgress chặn đổi nhánh khi worktree đang dở thao tác (FR-012), đọc file trong thư mục git riêng của worktree.
func (w *workdir) inProgress() *Error {
	op := OperationIn(w.gitDir)
	if op == "" {
		return nil
	}
	return &Error{Code: CodeInProgress, Operation: op,
		Message: "Thư mục đang dở " + operationText[op] + "; hoàn tất hoặc huỷ trước khi đổi nhánh."}
}

var operationText = map[string]string{
	OpMerge: "merge", OpRebase: "rebase", OpCherryPick: "cherry-pick", OpRevert: "revert", OpBisect: "bisect",
}

// checkedOut: git không cho hai worktree đứng cùng một nhánh; báo trước kèm đường dẫn để giao diện mở được chỗ đó.
func (w *workdir) checkedOut(name string) *Error {
	for i, wt := range w.worktrees {
		if i != w.owner && wt.Branch == "refs/heads/"+name {
			p := filepath.Clean(wt.Path)
			return &Error{Code: CodeCheckedOut, Message: "Nhánh đang mở ở " + p + ".", Path: p}
		}
	}
	return nil
}

// checkBusy (FR-014): agent, terminal, cửa sổ app trong worktree này thì hỏi lại (--confirm-busy). Worktree của run
// dưới DataDir thì luôn chặn: đổi nhánh ở đó làm hỏng run đang chạy, không có gì để người dùng xác nhận.
func (w *workdir) checkBusy(env Env, confirmed bool) *Error {
	if w.dataDir != "" && (repolock.SamePath(w.dataDir, w.folder) || repolock.InsideDir(w.dataDir, w.folder)) {
		return &Error{Code: CodeBusy, Message: "Thư mục này là worktree của worker đang chạy việc.",
			Busy: []BusyDir{{Path: filepath.Clean(w.folder), Kind: BusyHiveWorker}}}
	}
	if confirmed {
		return nil
	}
	owned := busyOwned(w.paths, w.owner, env.busy())
	if len(owned) == 0 {
		return nil
	}
	msg := map[string]string{
		BusyAgent:    "Agent đang chạy trong thư mục này.",
		BusyTerminal: "Terminal đang mở trong thư mục này.",
		BusyApp:      "Cửa sổ app đang mở thư mục này.",
	}[busyKind(owned)]
	if msg == "" {
		msg = "Thư mục đang được dùng."
	}
	return &Error{Code: CodeBusy, Message: msg, Busy: owned}
}

// dirtyError: chỉ thay đổi đã theo dõi mới chặn (Q10); file chưa theo dõi đi theo sang nhánh mới như git vẫn làm.
func dirtyError(t tree, carry bool) *Error {
	if carry || len(t.tracked) == 0 {
		return nil
	}
	files, total := capList(t.tracked, maxFiles)
	return &Error{Code: CodeDirty, Message: fmt.Sprintf("Thư mục có %d file đang sửa.", total), Files: files, FilesTotal: total}
}

func existsError(name string) *Error {
	return &Error{Code: CodeExists, Message: "Nhánh " + name + " đã có trên máy."}
}

// hasRef dùng show-ref --verify: chỉ khớp đúng tên ref đầy đủ, không đi qua cú pháp revision (main~1, tag cùng tên).
func (e Env) hasRef(ctx context.Context, dir, ref string) (bool, error) {
	_, err := e.read(ctx, dir, "show-ref", "--verify", "--quiet", ref)
	var ge *gitexec.GitError
	switch {
	case err == nil:
		return true, nil
	case ctx.Err() != nil:
		return false, ctx.Err()
	case errors.As(err, &ge) && !ge.Timeout:
		return false, nil
	}
	return false, err
}

func (e Env) mustRef(ctx context.Context, dir, ref, msg string) *Error {
	ok, err := e.hasRef(ctx, dir, ref)
	if err != nil {
		return gitFailure(err)
	}
	if !ok {
		return &Error{Code: CodeNotFound, Message: msg, Detail: ref}
	}
	return nil
}

// notExists còn xét nhánh chặn đường dẫn: có nhánh feature thì git không tạo được feature/abc và ngược lại, mà
// check-ref-format không biết. Báo ở bước này để dry-run lúc gõ tên đã thấy, không đợi tới lúc tạo mới lỗi.
func (e Env) notExists(ctx context.Context, dir, name string) *Error {
	ok, err := e.hasRef(ctx, dir, "refs/heads/"+name)
	if err != nil {
		return gitFailure(err)
	}
	if ok {
		return existsError(name)
	}
	parts := strings.Split(name, "/")
	for i := 1; i < len(parts); i++ {
		prefix := strings.Join(parts[:i], "/")
		ok, err := e.hasRef(ctx, dir, "refs/heads/"+prefix)
		if err != nil {
			return gitFailure(err)
		}
		if ok {
			return &Error{Code: CodeExists, Message: "Đã có nhánh " + prefix + " nên không tạo được " + name + "."}
		}
	}
	out, err := e.read(ctx, dir, "for-each-ref", "--count=1", "--format=%(refname:short)", "refs/heads/"+name+"/")
	if err != nil {
		return gitFailure(err)
	}
	if child := strings.TrimSpace(out); child != "" {
		return &Error{Code: CodeExists, Message: "Đã có nhánh " + child + " nên không tạo được " + name + "."}
	}
	return nil
}

func (e Env) tipOf(ctx context.Context, dir, ref string) (string, *Error) {
	if e := e.mustRef(ctx, dir, ref, "Không có nhánh gốc "+shortRef(ref)+" trên máy."); e != nil {
		return "", e
	}
	out, err := e.read(ctx, dir, "rev-parse", "--verify", "--quiet", ref+"^{commit}")
	if err != nil {
		return "", gitFailure(err)
	}
	return strings.TrimSpace(out), nil
}

// checkName dùng luật của chính git (FR-013). check-ref-format --branch còn mở rộng @{-1} thành tên nhánh trước, nên
// tên in ra phải trùng tên đưa vào; HEAD git nhận ở bản cũ nhưng làm rối mọi lệnh sau.
func (e Env) checkName(ctx context.Context, dir, name string) *Error {
	invalid := &Error{Code: CodeInvalidName, Message: "Tên nhánh không hợp lệ."}
	if name == "" || name == "HEAD" {
		invalid.Detail = "'" + name + "' is not a valid branch name"
		return invalid
	}
	out, err := e.read(ctx, dir, "check-ref-format", "--branch", name)
	var ge *gitexec.GitError
	switch {
	case ctx.Err() != nil:
		return gitFailure(ctx.Err())
	case errors.As(err, &ge) && !ge.Timeout:
		invalid.Detail = ge.Msg
		return invalid
	case err != nil:
		return gitFailure(err)
	case strings.TrimSpace(out) != name:
		invalid.Detail = "'" + name + "' is not a valid branch name"
		return invalid
	}
	return nil
}

// fetchBase fetch đúng nhánh gốc, ngoài khoá như job fetch: fetch chỉ ghi ref remote, giữ khoá suốt lúc mạng chậm thì
// chặn worker.
func (e Env) fetchBase(ctx context.Context, dir, base string) *Error {
	remotes, err := e.remotes(ctx, dir)
	if err != nil {
		return gitFailure(err)
	}
	short := strings.TrimPrefix(base, "refs/remotes/")
	remote, branch := splitRemote(short, remotes)
	_, err = e.git(FetchTimeout).Run(ctx, dir, "", "fetch", "--quiet", "--end-of-options", remote, "refs/heads/"+branch)
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return gitFailure(ctx.Err())
	}
	f := gitFailure(err)
	f.Remote = remote
	if f.Code != CodeAuth && f.Code != CodeTimeout {
		f.Code, f.Message = CodeFetchFailed, "Không fetch được "+short+"."
	}
	return f
}

// lockRepo giữ khoá repo chung với run của worker (FR-025). Khoá theo thư mục git chung như runner nên thư mục chính
// và worktree nào của repo cũng ra cùng một file. Chờ quá lockWait thì trả locked; huỷ trong lúc chờ thì trả cancelled.
func (e Env) lockRepo(ctx context.Context, dir string) (func(), *Error) {
	out, err := e.read(ctx, dir, "rev-parse", "--path-format=absolute", "--git-common-dir")
	if err != nil {
		return nil, gitFailure(err)
	}
	lock := repolock.LocalLock(e.DataDir, filepath.Clean(filepath.FromSlash(strings.TrimSpace(out))))
	if err := os.MkdirAll(filepath.Dir(lock), 0o700); err != nil {
		return nil, &Error{Code: CodeGit, Message: "Không tạo được thư mục khoá repo.", Detail: err.Error()}
	}
	wait, cancel := context.WithTimeout(ctx, lockWait)
	defer cancel()
	unlock, err := repolock.LockRepo(wait, lock)
	if err != nil {
		if ctx.Err() != nil {
			return nil, gitFailure(ctx.Err())
		}
		return nil, &Error{Code: CodeLocked, Message: fmt.Sprintf("Worker đang giữ repo này quá %g giây; thử lại sau.", lockWait.Seconds())}
	}
	return unlock, nil
}

// writeGit là bộ chạy cho lệnh ghi (hợp đồng mục 1.5): context không bị huỷ, để git không bị dừng giữa lúc đang ghi
// index và thư mục làm việc; vẫn có giới hạn d, không quá --timeout còn lại của lệnh.
func (e Env) writeGit(ctx context.Context, d time.Duration) (context.Context, gitexec.Git) {
	g := e.git(d)
	if dl, ok := ctx.Deadline(); ok {
		g.Timeout = max(min(g.Timeout, time.Until(dl)), time.Second)
	}
	return context.WithoutCancel(ctx), g
}

// write chạy một lệnh ghi trong khoá repo. Huỷ trước khi có khoá thì không ghi gì; có khoá rồi thì chạy tới hết.
func (e Env) write(ctx context.Context, dir string, args ...string) *Error {
	unlock, le := e.lockRepo(ctx, dir)
	if le != nil {
		return le
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return gitFailure(err)
	}
	wctx, g := e.writeGit(ctx, WriteTimeout)
	if _, err := g.Run(wctx, dir, "", args...); err != nil {
		return gitFailure(err)
	}
	return nil
}
