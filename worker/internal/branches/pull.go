package branches

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"
)

// StepMerge là bước tiến nhanh trong sự kiện progress của pull.
const StepMerge = "merge"

// Trạng thái của PullResult.
const (
	PullDone      = "done"
	PullUnchanged = "unchanged"
)

type PullOptions struct {
	Folder      string
	ConfirmBusy bool
}

// PullResult là trường pull của sự kiện done: State là "done" (đã tiến nhanh) hay "unchanged".
type PullResult struct {
	State      string `json:"state"`
	HeadBefore string `json:"headBefore,omitempty"`
	Head       string `json:"head,omitempty"`
	Behind     int    `json:"behind,omitempty"`
}

// Pull là job `pull` (US5, FR-025): fetch remote của upstream rồi chỉ tiến nhanh. Ahead và behind cùng lúc, hay thư
// mục bẩn, thì không chạy gì mà trả lý do; việc hợp nhất hai nhánh đã rẽ là của merge, rebase (US8) để người dùng chọn.
func Pull(ctx context.Context, env Env, o PullOptions, emit Emit) {
	done := Event{Type: EventDone, Folder: o.Folder}
	res, e := env.pull(ctx, o, emit)
	done.Pull, done.Error = res, e
	emit(done)
}

func (e Env) pull(ctx context.Context, o PullOptions, emit Emit) (*PullResult, *Error) {
	w, le := e.openWorkdir(ctx, o.Folder)
	if le != nil {
		return nil, le
	}
	t, _, err := e.readTree(ctx, o.Folder, false)
	if err != nil {
		return nil, gitFailure(err)
	}
	if t.detached {
		return nil, &Error{Code: CodeDetached, Message: "Thư mục đang ở HEAD rời; đứng trên một nhánh rồi pull."}
	}
	if op := OperationIn(w.gitDir); op != "" {
		return nil, &Error{Code: CodeInProgress, Operation: op,
			Message: "Thư mục đang dở " + operationText[op] + "; hoàn tất hoặc huỷ trước khi pull."}
	}
	if le := w.checkBusy(e, o.ConfirmBusy); le != nil {
		return nil, le
	}
	if t.upstream == "" {
		return nil, noUpstream(t.head, "")
	}
	// Khác switch: pull chặn cả file chưa theo dõi (hợp đồng mục 1.6), vì tiến nhanh có thể phải ghi đè chúng.
	if files, total := t.files(); total > 0 {
		return nil, &Error{Code: CodeDirty, Message: fmt.Sprintf("Thư mục có %d file chưa commit.", total), Files: files, FilesTotal: total}
	}

	// Fetch ngoài khoá như job fetch: giữ khoá suốt lúc mạng chậm thì chặn worker. Upstream là nhánh local khác
	// (remote ".") thì không có gì để fetch.
	if remote := e.upstreamRemote(ctx, o.Folder, t.head); remote != "" {
		var failure *Error
		out, stop := e.fetchRemotes(ctx, o.Folder, []string{remote}, func(ev Event) {
			if ev.Error != nil {
				failure = ev.Error
			}
			emit(ev)
		})
		if stop != nil {
			return nil, stop
		}
		if len(out.Failed) > 0 && failure != nil {
			return nil, failure
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, gitFailure(err)
	}

	// Đọc lại sau fetch: ahead, behind, upstream có thể đã đổi, và fetch --prune gỡ ref của upstream đã xoá trên remote.
	if t, _, err = e.readTree(ctx, o.Folder, false); err != nil {
		return nil, gitFailure(err)
	}
	if t.detached || t.upstream == "" || !t.hasAB {
		return nil, noUpstream(t.head, t.upstream)
	}
	tip, err := e.read(ctx, o.Folder, "rev-parse", "--verify", "--quiet", "@{upstream}^{commit}")
	if err != nil {
		return nil, gitFailure(err)
	}
	tip = strings.TrimSpace(tip)
	if t.ahead > 0 && t.behind > 0 {
		return nil, &Error{Code: CodeDiverged, Ahead: t.ahead, Behind: t.behind, Upstream: t.upstream, UpstreamTip: tip,
			Message: "Nhánh vừa có commit mới ở máy vừa thiếu commit của " + t.upstream + "."}
	}
	if t.behind == 0 {
		return &PullResult{State: PullUnchanged, Head: t.oid}, nil
	}

	emit(Event{Type: EventProgress, Folder: o.Folder, Step: StepMerge})
	// Tiến nhanh tới đúng mã đã dùng để xét diverged, không tới tên ref: upstream nhích thêm giữa chừng thì không kéo
	// về commit chưa ai xem. Máy có commit mới trong lúc chờ khoá thì ff-only tự từ chối.
	res := &PullResult{State: PullDone, HeadBefore: t.oid, Behind: t.behind}
	le = e.write(ctx, o.Folder, "merge", "--ff-only", "--quiet", "--end-of-options", tip)
	entry := LogEntry{Time: e.now().UTC().Format(time.RFC3339), Action: ActionPull, Folder: o.Folder,
		Branch: t.head, HeadBefore: t.oid, Onto: t.upstream, OntoTip: tip, Result: ResultDone}
	if le != nil {
		entry.Result, entry.Code = ResultError, le.Code
		// Chưa ghi gì (huỷ, hết chờ khoá) thì không có gì để ghi nhật ký.
		if le.Code != CodeCancelled && le.Code != CodeLocked {
			_ = AppendLog(e.ConfigDir, entry)
		}
		return nil, le
	}
	// Đã tiến nhanh xong: huỷ lúc này không được biến kết quả thành lỗi, giao diện cần biết nhánh đã nhận commit mới.
	head, err := e.read(context.WithoutCancel(ctx), o.Folder, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return nil, gitFailure(err)
	}
	res.Head = strings.TrimSpace(head)
	entry.Tip = res.Head
	// Không ghi được nhật ký thì vẫn báo kết quả: nhánh đã tiến rồi.
	_ = AppendLog(e.ConfigDir, entry)
	return res, nil
}

func noUpstream(branch, upstream string) *Error {
	msg := "Nhánh " + branch + " chưa có upstream."
	if upstream != "" {
		msg = "Upstream " + upstream + " của nhánh " + branch + " không còn."
	}
	return &Error{Code: CodeNoUpstream, Message: msg, Upstream: upstream}
}

// upstreamRemote là remote mà upstream của nhánh thuộc về; rỗng khi upstream là nhánh local (remote ".") hay khi
// remote trong cấu hình không phải tên remote đã khai: git cho phép đặt cả URL ở đó, mà fetch URL lạ thì đi ra ngoài
// các remote người dùng đã chọn.
func (e Env) upstreamRemote(ctx context.Context, dir, branch string) string {
	out, err := e.read(ctx, dir, "config", "--get", "branch."+branch+".remote")
	if err != nil {
		return ""
	}
	remote := strings.TrimSpace(out)
	all, err := e.remotes(ctx, dir)
	if err != nil || !slices.Contains(all, remote) {
		return ""
	}
	return remote
}
