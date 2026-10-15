package gitgroups

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// Thao tác hàng loạt trên repo của nhóm.
const (
	ActionStatus = "status"
	ActionClone  = "clone"
	ActionFetch  = "fetch"
	ActionPull   = "pull"
)

// Kết quả của một repo sau thao tác.
const (
	ResultDone      = "done"
	ResultUnchanged = "unchanged"
	ResultSkipped   = "skipped"
	ResultFailed    = "failed"
	ResultCancelled = "cancelled"
)

// DefaultConcurrency: bốn repo một lúc đủ nhanh mà không bị máy chủ giới hạn lượt hay làm nghẽn mạng.
const DefaultConcurrency = 4

// authStopped là lý do bỏ qua repo sau khi máy chủ đã từ chối đăng nhập ở một repo khác của cùng lượt.
const authStopped = "không chạy vì máy chủ đã từ chối đăng nhập ở repo khác; sửa đăng nhập rồi chạy lại"

// Event là một dòng tiến độ gửi cho app: "start" (tổng số repo), "repo" (xong một repo), "done" (hết).
type Event struct {
	Type    string      `json:"type"`
	Action  string      `json:"action"`
	Total   int         `json:"total"`
	Done    int         `json:"done"`
	Path    string      `json:"path,omitempty"`
	Result  string      `json:"result,omitempty"`
	Message string      `json:"message,omitempty"`
	Status  *RepoStatus `json:"status,omitempty"`
	// Summary đếm repo theo kết quả, chỉ có ở sự kiện "done".
	Summary map[string]int `json:"summary,omitempty"`
}

// Sync chạy một thao tác trên các repo đã chọn của nhóm.
type Sync struct {
	Git   Git
	Group Group
	// Projects là projects.json: repo clone xong được thêm vào danh sách Dự án trên máy. Rỗng thì không thêm.
	Projects    string
	Concurrency int
}

// Run chạy action trên mọi repo đã chọn, song song có giới hạn, gọi emit (đã khoá, gọi lần lượt) cho từng repo. Huỷ ctx
// thì git đang chạy dừng và repo chưa bắt đầu báo "cancelled".
func (s Sync) Run(ctx context.Context, action string, emit func(Event)) error {
	switch action {
	case ActionStatus, ActionClone, ActionFetch, ActionPull:
	default:
		return fmt.Errorf("thao tác %q không hỗ trợ", action)
	}
	repos, err := Selected(s.Group)
	if err != nil {
		return err
	}
	n := s.Concurrency
	if n <= 0 {
		n = DefaultConcurrency
	}
	if action == ActionStatus {
		// Đọc trạng thái chỉ chạy git tại máy, không gọi mạng.
		n = 8
	}
	total := len(repos)
	summary := map[string]int{}
	var mu sync.Mutex
	done := 0
	emit(Event{Type: "start", Action: action, Total: total})
	report := func(path string, st *RepoStatus, result, msg string) {
		mu.Lock()
		defer mu.Unlock()
		done++
		summary[result]++
		emit(Event{Type: "repo", Action: action, Total: total, Done: done, Path: path, Result: result, Message: msg, Status: st})
	}
	jobs := make(chan Repo)
	var authDenied atomic.Bool
	var wg sync.WaitGroup
	for range n {
		wg.Go(func() {
			for r := range jobs {
				if ctx.Err() != nil {
					// Repo chưa bắt đầu: không có trạng thái mới, app giữ trạng thái cũ.
					report(r.Path, nil, ResultCancelled, "đã huỷ")
					continue
				}
				st, result, msg := s.one(ctx, action, r, &authDenied)
				report(r.Path, &st, result, msg)
			}
		})
	}
	for _, r := range repos {
		jobs <- r
	}
	close(jobs)
	wg.Wait()
	emit(Event{Type: "done", Action: action, Total: total, Done: done, Summary: summary})
	return nil
}

func (s Sync) one(ctx context.Context, action string, r Repo, authDenied *atomic.Bool) (RepoStatus, string, string) {
	st := Inspect(ctx, s.Git, s.Group, r)
	if ctx.Err() != nil {
		return st, ResultCancelled, "đã huỷ"
	}
	switch action {
	case ActionStatus:
		return st, ResultUnchanged, ""
	case ActionClone:
		if st.State != StateMissing {
			return st, ResultUnchanged, ""
		}
		if authDenied.Load() {
			return st, ResultSkipped, authStopped
		}
		return s.clone(ctx, r, st, authDenied)
	}
	switch st.State {
	case StateMissing:
		return st, ResultSkipped, "chưa clone"
	case StateError:
		return st, ResultSkipped, st.Reason
	}
	if authDenied.Load() {
		return st, ResultSkipped, authStopped
	}
	url := CloneURL(s.Group, r)
	if _, err := s.Git.run(ctx, st.Dir, hostOf(url), "fetch", "--prune", "--quiet", "origin"); err != nil {
		return s.failed(ctx, st, err, authDenied)
	}
	st = Inspect(ctx, s.Git, s.Group, r)
	if action == ActionFetch {
		return st, ResultDone, ""
	}
	switch st.State {
	case StateDirty, StateDiverged, StateError:
		// Không stash, không reset, không merge: thay đổi của người dùng là của người dùng.
		return st, ResultSkipped, st.Reason
	case StateBehind:
	default:
		return st, ResultUnchanged, ""
	}
	// Đã fetch ở trên nên chỉ cần tiến nhánh tới @{u}, không gọi mạng lần hai như `pull --ff-only`.
	_, err := s.Git.run(ctx, st.Dir, "", "merge", "--ff-only", "--quiet", "@{u}")
	after := Inspect(context.WithoutCancel(ctx), s.Git, s.Group, r)
	if err != nil {
		return s.failed(ctx, after, err, authDenied)
	}
	return after, ResultDone, ""
}

func (s Sync) clone(ctx context.Context, r Repo, st RepoStatus, authDenied *atomic.Bool) (RepoStatus, string, string) {
	url := CloneURL(s.Group, r)
	if url == "" {
		return st, ResultFailed, "máy chủ không trả URL clone"
	}
	parent := filepath.Dir(st.Dir)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return st, ResultFailed, err.Error()
	}
	// "--" để URL lạ từ API (bắt đầu bằng "-") không thành cờ của git.
	if _, err := s.Git.run(ctx, parent, hostOf(url), "clone", "--quiet", "--origin", "origin", "--", url, st.Dir); err != nil {
		// Thư mục chưa có trước lượt clone này (StateMissing). Git tự dọn khi nhận Interrupt, nhưng trên Windows git bị
		// giết thẳng nên còn lại clone dở; để lại thì lần sau thành "không phải repo" và chặn clone lại.
		_ = os.RemoveAll(st.Dir)
		return s.failed(ctx, st, err, authDenied)
	}
	if s.Projects != "" {
		if _, err := projects.AddFolder(s.Projects, st.Dir, r.Name); err != nil {
			after := Inspect(ctx, s.Git, s.Group, r)
			return after, ResultDone, "đã clone nhưng không thêm được vào Dự án trên máy: " + err.Error()
		}
	}
	return Inspect(ctx, s.Git, s.Group, r), ResultDone, ""
}

func (s Sync) failed(ctx context.Context, st RepoStatus, err error, authDenied *atomic.Bool) (RepoStatus, string, string) {
	if ctx.Err() != nil || errors.Is(err, context.Canceled) {
		return st, ResultCancelled, "đã huỷ"
	}
	if ge := (*GitError)(nil); errors.As(err, &ge) && ge.Auth {
		authDenied.Store(true)
	}
	return st, ResultFailed, err.Error()
}
