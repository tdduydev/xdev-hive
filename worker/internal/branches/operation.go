package branches

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
)

// Trạng thái của GitOperation.
const (
	OperationDone       = "done"
	OperationConflict   = "conflict"
	OperationInProgress = "inProgress"
	OperationAborted    = "aborted"
	OperationError      = "error"
)

// OperationTimeout là giới hạn của merge, rebase, --continue, --abort (FR-052).
const OperationTimeout = 120 * time.Second

// maxConflicts là số file xung đột tối đa trong kết quả (FR-053).
const maxConflicts = 200

// logStarted là result của dòng nhật ký ghi ngay trước khi chạy git, để headBefore còn lại kể cả khi sidecar bị giết
// giữa chừng (FR-056).
const logStarted = "started"

// GitOperation là merge, rebase do app chạy hay thao tác dở list đọc được (US8).
type GitOperation struct {
	Kind           string   `json:"kind"`
	State          string   `json:"state"`
	Branch         string   `json:"branch,omitempty"`
	Onto           *OntoRef `json:"onto,omitempty"`
	HeadBefore     string   `json:"headBefore,omitempty"`
	Head           string   `json:"head,omitempty"`
	Conflicts      []string `json:"conflicts"`
	ConflictsTotal int      `json:"conflictsTotal"`
	Step           int      `json:"step,omitempty"`
	Total          int      `json:"total,omitempty"`
	Error          *Error   `json:"error,omitempty"`
}

type OntoRef struct {
	Name string `json:"name"`
	Tip  string `json:"tip"`
}

// MergeOptions là cờ của `merge`; Onto là mã commit đầy đủ, OntoName chỉ để hiện và ghi nhật ký.
type MergeOptions struct {
	Folder      string
	Onto        string
	OntoName    string
	FF          bool
	ConfirmBusy bool
}

type RebaseOptions struct {
	Folder         string
	Onto           string
	OntoName       string
	ConfirmRewrite bool
	ConfirmBusy    bool
}

// fullOID: --onto phải là mã đã đọc lúc người dùng bấm (FR-050), không nhận tên để tag trùng tên không bị chọn nhầm.
var fullOID = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

// Merge là lệnh `merge` (US8, FR-050): `git merge --no-ff --no-edit`, --ff cho phép tiến nhanh. --ff ghi rõ thay vì
// bỏ cờ, để merge.ff=only hay false trong cấu hình của người dùng không đổi kết quả người dùng đã chọn.
func Merge(ctx context.Context, env Env, o MergeOptions) (*GitOperation, *Error) {
	ff := "--no-ff"
	if o.FF {
		ff = "--ff"
	}
	return env.begin(ctx, OpMerge, o.Folder, o.Onto, o.OntoName, o.ConfirmBusy, true, func(tip string) []string {
		return []string{"merge", ff, "--no-edit", "--no-autostash", "--end-of-options", tip}
	})
}

// Rebase là lệnh `rebase` (US8, FR-050, FR-055): không -i, không --autostash, không --onto. rebase.updateRefs của người
// dùng sẽ viết lại cả nhánh khác mà needsConfirm không đếm, nên tắt cho lệnh này.
func Rebase(ctx context.Context, env Env, o RebaseOptions) (*GitOperation, *Error) {
	return env.begin(ctx, OpRebase, o.Folder, o.Onto, o.OntoName, o.ConfirmBusy, o.ConfirmRewrite, func(tip string) []string {
		return []string{"-c", "rebase.updateRefs=false", "rebase", "--no-autostash", "--no-fork-point", "--end-of-options", tip}
	})
}

// begin kiểm theo thứ tự của hợp đồng mục 3.10 rồi chạy merge hay rebase trong khoá repo. Thao tác dở xét trước HEAD
// rời: rebase dở luôn để HEAD rời, báo detached thì người dùng không biết phải hoàn tất rebase.
func (e Env) begin(ctx context.Context, kind, folder, onto, ontoName string, confirmBusy, confirmRewrite bool,
	args func(tip string) []string) (*GitOperation, *Error) {
	w, fe := e.openWorkdir(ctx, folder)
	if fe != nil {
		return nil, fe
	}
	t, op, err := e.readTree(ctx, folder, false)
	if err != nil {
		return nil, gitFailure(err)
	}
	if op != "" {
		return nil, &Error{Code: CodeInProgress, Operation: op,
			Message: "Thư mục đang dở " + operationText[op] + "; hoàn tất hoặc huỷ trước."}
	}
	if t.detached {
		return nil, &Error{Code: CodeDetached, Message: "HEAD đang rời; hãy đứng trên một nhánh trước khi " + kind + "."}
	}
	if t.oid == "" {
		return nil, &Error{Code: CodeGit, Message: "Nhánh " + t.head + " chưa có commit nào."}
	}
	tip, fe := e.commitOf(ctx, folder, onto)
	if fe != nil {
		return nil, fe
	}
	if fe := w.checkBusy(e, confirmBusy); fe != nil {
		return nil, fe
	}
	if files, total := t.files(); total > 0 {
		return nil, &Error{Code: CodeDirty, Files: files, FilesTotal: total,
			Message: fmt.Sprintf("Thư mục có %d file thay đổi hoặc chưa theo dõi; %s cần thư mục sạch.", total, kind)}
	}
	if !confirmRewrite {
		n, err := e.pushedCommits(ctx, folder, tip)
		if err != nil {
			return nil, gitFailure(err)
		}
		if n > 0 {
			return nil, &Error{Code: CodeNeedsConfirm, Count: n,
				Message: fmt.Sprintf("Rebase viết lại %d commit đã đẩy. Sau đó phải force-push (app không push).", n)}
		}
	}

	if ontoName == "" {
		ontoName = tip
	}
	res := &GitOperation{Kind: kind, Branch: t.head, Onto: &OntoRef{Name: ontoName, Tip: tip}, Conflicts: []string{}}
	entry := LogEntry{Action: kind, Folder: folder, Branch: t.head, Onto: ontoName, OntoTip: tip}
	var runErr error
	le := e.locked(ctx, folder, func(run func(...string) error) *Error {
		head, err := e.read(ctx, folder, "rev-parse", "--verify", "HEAD")
		if err != nil {
			return gitFailure(err)
		}
		// Kiểm sạch, đếm commit đã đẩy chạy ngoài khoá: HEAD đổi trong lúc chờ khoá thì các kết quả đó không còn đúng.
		if res.HeadBefore = strings.TrimSpace(head); res.HeadBefore != t.oid {
			return &Error{Code: CodeGit, Message: "Nhánh vừa thay đổi trong lúc kiểm; thử lại."}
		}
		entry.HeadBefore = res.HeadBefore
		e.log(entry, logStarted, nil)
		runErr = run(args(tip)...)
		return nil
	})
	if le != nil {
		return nil, le
	}
	e.settle(ctx, folder, w.gitDir, res, runErr, OperationDone)
	e.log(entry, res.State, res.Error)
	return res, nil
}

// Continue là lệnh `continue` (FR-054): còn file xung đột chưa add thì trả conflict, không chạy git.
func Continue(ctx context.Context, env Env, folder string) (*GitOperation, *Error) {
	return env.resume(ctx, folder, ActionContinue, OperationDone)
}

// Abort là lệnh `abort`: `git merge --abort` hay `git rebase --abort`, đưa nhánh về headBefore.
func Abort(ctx context.Context, env Env, folder string) (*GitOperation, *Error) {
	return env.resume(ctx, folder, ActionAbort, OperationAborted)
}

func (e Env) resume(ctx context.Context, folder, action, doneState string) (*GitOperation, *Error) {
	w, fe := e.openWorkdir(ctx, folder)
	if fe != nil {
		return nil, fe
	}
	kind := OperationIn(w.gitDir)
	if kind != OpMerge && kind != OpRebase {
		// cherry-pick, revert, bisect vẫn hiện ở list nhưng app không tiếp tục hay huỷ hộ (hợp đồng mục 3.10).
		msg := "Không có merge hay rebase nào đang dở."
		if kind != "" {
			msg = "Thư mục đang dở " + operationText[kind] + ", app chỉ tiếp tục hay huỷ được merge, rebase."
		}
		return nil, &Error{Code: CodeNoOperation, Message: msg}
	}
	// Worktree của run luôn chặn; agent, terminal thì không hỏi lại: người dùng đang gỡ dở chính thao tác này.
	if fe := w.checkBusy(e, true); fe != nil {
		return nil, fe
	}
	res, err := e.operationState(ctx, folder, w.gitDir, kind)
	if err != nil {
		return nil, gitFailure(err)
	}
	if action == ActionContinue && res.ConflictsTotal > 0 {
		return res, nil
	}
	entry := LogEntry{Action: action, Folder: folder, Branch: res.Branch, HeadBefore: res.HeadBefore}
	var runErr error
	if le := e.locked(ctx, folder, func(run func(...string) error) *Error {
		runErr = run(kind, "--"+action)
		return nil
	}); le != nil {
		return nil, le
	}
	e.settle(ctx, folder, w.gitDir, res, runErr, doneState)
	e.log(entry, res.State, res.Error)
	return res, nil
}

// locked chạy f trong khoá repo với bộ chạy lệnh ghi: context không bị huỷ, giới hạn OperationTimeout (FR-052). Huỷ
// trước khi có khoá thì không chạy gì.
func (e Env) locked(ctx context.Context, dir string, f func(run func(...string) error) *Error) *Error {
	unlock, le := e.lockRepo(ctx, dir)
	if le != nil {
		return le
	}
	defer unlock()
	if err := ctx.Err(); err != nil {
		return gitFailure(err)
	}
	useNoEditor()
	wctx, g := e.writeGit(ctx, OperationTimeout)
	return f(func(args ...string) error {
		_, err := g.Run(wctx, dir, "", args...)
		return err
	})
}

// useNoEditor: --continue mở trình soạn thảo cho thông điệp commit kể cả với rebase không -i. GIT_EDITOR thắng
// core.editor nên -c không đủ, mà gitexec lấy biến môi trường của tiến trình; sidecar chạy một lệnh mỗi tiến trình nên
// đặt cho cả tiến trình.
func useNoEditor() { _ = os.Setenv("GIT_EDITOR", "true") }

// settle đọc trạng thái sau khi git chạy xong. Hết giờ hay lỗi thì không tự --abort (FR-052): repo còn dở thì kết
// quả cho biết, list sau đó cũng vậy.
func (e Env) settle(ctx context.Context, dir, gitDir string, res *GitOperation, runErr error, doneState string) {
	ctx = context.WithoutCancel(ctx)
	res.Conflicts, res.ConflictsTotal, res.Step, res.Total = []string{}, 0, 0, 0
	if kind := OperationIn(gitDir); kind == OpMerge || kind == OpRebase {
		res.Kind = kind
		_ = e.fillProgress(ctx, dir, gitDir, res)
		switch {
		case res.ConflictsTotal > 0:
			res.State = OperationConflict
		case runErr != nil:
			res.State = OperationError
		default:
			res.State = OperationInProgress
		}
	} else if runErr != nil {
		res.State = OperationError
	} else {
		res.State = doneState
	}
	if res.State == OperationError {
		res.Error = operationFailure(runErr)
	}
	if res.State == OperationDone || res.State == OperationAborted {
		if head, err := e.read(ctx, dir, "rev-parse", "--verify", "HEAD"); err == nil {
			res.Head = strings.TrimSpace(head)
		}
	}
}

// operationFailure: hết giờ thì nói rõ repo có thể đang dở, vì app không tự huỷ thao tác.
func operationFailure(err error) *Error {
	f := gitFailure(err)
	if f.Code == CodeTimeout {
		f.Message = fmt.Sprintf("Git chạy quá %g giây nên đã dừng; repo có thể đang dở, xem lại bảng nhánh.", OperationTimeout.Seconds())
	}
	return f
}

// operationState là thao tác đang dở của một thư mục làm việc, kể cả do người dùng tự chạy ngoài app.
func (e Env) operationState(ctx context.Context, dir, gitDir, kind string) (*GitOperation, error) {
	op := &GitOperation{Kind: kind, Conflicts: []string{}, Branch: e.operationBranch(ctx, dir, gitDir, kind)}
	switch kind {
	case OpMerge:
		// git merge ghi ORIG_HEAD là HEAD trước merge; qua rev-parse để đọc được cả với kho ref reftable.
		if out, err := e.read(ctx, dir, "rev-parse", "--verify", "--quiet", "ORIG_HEAD"); err == nil {
			op.HeadBefore = strings.TrimSpace(out)
		}
	case OpRebase:
		op.HeadBefore = readStateFile(gitDir, "rebase-merge/orig-head", "rebase-apply/orig-head")
	}
	if err := e.fillProgress(ctx, dir, gitDir, op); err != nil {
		return nil, err
	}
	op.State = OperationInProgress
	if op.ConflictsTotal > 0 {
		op.State = OperationConflict
	}
	return op, nil
}

// pendingOperation là operation của list (FR-053). Đọc lỗi thì bỏ trống: current.operation vẫn cho biết loại thao tác.
func (e Env) pendingOperation(ctx context.Context, dir, kind string) *GitOperation {
	gitDir, err := e.gitDirOf(ctx, dir)
	if err != nil {
		return nil
	}
	op, err := e.operationState(ctx, dir, gitDir, kind)
	if err != nil {
		return nil
	}
	return op
}

// operationBranch: rebase dở để HEAD rời, tên nhánh nằm trong head-name của thư mục trạng thái.
func (e Env) operationBranch(ctx context.Context, dir, gitDir, kind string) string {
	if kind == OpRebase {
		if name := readStateFile(gitDir, "rebase-merge/head-name", "rebase-apply/head-name"); name != "" {
			return strings.TrimPrefix(name, "refs/heads/")
		}
	}
	out, err := e.read(ctx, dir, "symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return ""
	}
	return strings.TrimSpace(out)
}

// fillProgress đọc file xung đột (FR-053) và, với rebase, commit đang áp trên tổng số.
func (e Env) fillProgress(ctx context.Context, dir, gitDir string, op *GitOperation) error {
	out, err := e.read(ctx, dir, "diff", "--name-only", "--diff-filter=U", "-z")
	if err != nil {
		return err
	}
	var all []string
	seen := map[string]bool{}
	for p := range strings.SplitSeq(out, "\x00") {
		if p != "" && !seen[p] {
			seen[p] = true
			all = append(all, p)
		}
	}
	if files, total := capList(all, maxConflicts); total > 0 {
		op.Conflicts, op.ConflictsTotal = files, total
	}
	if op.Kind == OpRebase {
		for _, s := range [][3]string{{"rebase-merge", "msgnum", "end"}, {"rebase-apply", "next", "last"}} {
			step, err1 := strconv.Atoi(readStateFile(gitDir, s[0]+"/"+s[1]))
			total, err2 := strconv.Atoi(readStateFile(gitDir, s[0]+"/"+s[2]))
			if err1 == nil && err2 == nil {
				op.Step, op.Total = step, total
				break
			}
		}
	}
	return nil
}

// readStateFile trả nội dung file đầu tiên đọc được trong thư mục git của worktree.
func readStateFile(gitDir string, names ...string) string {
	for _, n := range names {
		if b, err := os.ReadFile(filepath.Join(gitDir, filepath.FromSlash(n))); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

// commitOf kiểm --onto là một commit có trên máy và trả mã commit (mã tag có chú thích thì lấy commit nó trỏ tới).
func (e Env) commitOf(ctx context.Context, dir, onto string) (string, *Error) {
	onto = strings.ToLower(strings.TrimSpace(onto))
	if !fullOID.MatchString(onto) {
		return "", &Error{Code: CodeNotFound, Message: "Cần mã commit đầy đủ của nhánh đích.", Detail: onto}
	}
	out, err := e.read(ctx, dir, "rev-parse", "--verify", "--quiet", onto+"^{commit}")
	var ge *gitexec.GitError
	switch {
	case err == nil:
		return strings.TrimSpace(out), nil
	case ctx.Err() != nil:
		return "", gitFailure(ctx.Err())
	case errors.As(err, &ge) && !ge.Timeout:
		return "", &Error{Code: CodeNotFound, Message: "Không có commit " + onto + " trên máy; fetch rồi thử lại.", Detail: onto}
	}
	return "", gitFailure(err)
}

// pushedCommits đếm commit rebase sẽ viết lại (tip..HEAD) mà đã nằm trên một ref remote nào đó (FR-055): tổng trừ số
// commit không ref remote nào chứa. `rev-list --count <tip>..HEAD --remotes` như plan.md ghi đếm cả commit của mọi
// nhánh remote chưa vào tip, không phải commit của nhánh này.
func (e Env) pushedCommits(ctx context.Context, dir, tip string) (int, error) {
	count := func(args ...string) (int, error) {
		out, err := e.read(ctx, dir, append([]string{"rev-list", "--count"}, args...)...)
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(strings.TrimSpace(out))
	}
	all, err := count("HEAD", "--not", tip)
	if err != nil || all == 0 {
		return 0, err
	}
	local, err := count("HEAD", "--not", tip, "--remotes")
	if err != nil {
		return 0, err
	}
	return all - local, nil
}

// log ghi một dòng nhật ký; lỗi ghi không làm hỏng thao tác, headBefore vẫn có trong kết quả.
func (e Env) log(entry LogEntry, result string, fe *Error) {
	entry.Time, entry.Result = e.now().UTC().Format(time.RFC3339), result
	if fe != nil {
		entry.Code = fe.Code
	}
	_ = AppendLog(e.ConfigDir, entry)
}
