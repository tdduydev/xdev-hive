// Package branches là phần Go của quản lý nhánh Git trong app desktop (spec 026): lệnh `hive-worker branches` đọc,
// đổi, tạo, dọn nhánh và worktree của repo trên máy. Hợp đồng JSON với Rust và React ở
// specs/026-desktop-git-branches/contracts/branches-cli.md; tên trường, mã lỗi ở đây phải khớp file đó.
package branches

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexec"
	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// Mã lỗi của BranchError (hợp đồng mục 1.6).
const (
	CodeInvalidInput    = "invalid_input"
	CodeNotRepo         = "not_repo"
	CodeNotFound        = "not_found"
	CodeInvalidName     = "invalid_name"
	CodeExists          = "exists"
	CodeDirty           = "dirty"
	CodeInProgress      = "in_progress"
	CodeNoOperation     = "no_operation"
	CodeCheckedOut      = "checked_out"
	CodeDetached        = "detached"
	CodeNoUpstream      = "no_upstream"
	CodeDiverged        = "diverged"
	CodeBusy            = "busy"
	CodeNeedsConfirm    = "needsConfirm"
	CodeFetchFailed     = "fetch_failed"
	CodeAuth            = "auth"
	CodeLocked          = "locked"
	CodeTimeout         = "timeout"
	CodeCancelled       = "cancelled"
	CodeInvalidSettings = "invalid_settings"
	CodeGit             = "git"
	CodeNotImplemented  = "not_implemented"
)

// Error là BranchError của hợp đồng: lỗi nghiệp vụ nằm trong JSON kết quả, không làm sidecar thoát khác 0.
type Error struct {
	Code       string    `json:"code"`
	Message    string    `json:"message"`
	Detail     string    `json:"detail,omitempty"`
	Files      []string  `json:"files,omitempty"`
	FilesTotal int       `json:"filesTotal,omitempty"`
	Count      int       `json:"count,omitempty"`
	Path       string    `json:"path,omitempty"`
	Operation  string    `json:"operation,omitempty"`
	Busy       []BusyDir `json:"busy,omitempty"`
	Ahead      int       `json:"ahead,omitempty"`
	Behind     int       `json:"behind,omitempty"`
	Upstream   string    `json:"upstream,omitempty"`
	// UpstreamTip là mã của upstream khi diverged, để giao diện gọi merge/rebase với --onto đúng mã đó.
	UpstreamTip string `json:"upstreamTip,omitempty"`
	Remote      string `json:"remote,omitempty"`
}

func (e *Error) Error() string { return e.Message }

func notImplemented() *Error {
	return &Error{Code: CodeNotImplemented, Message: "Chức năng này chưa có trong bản worker hiện tại."}
}

func notRepo(folder string) *Error {
	return &Error{Code: CodeNotRepo, Message: "Thư mục không còn hoặc không phải repo git.", Path: folder}
}

// gitFailure đổi lỗi của một lệnh git thành BranchError. Huỷ và hết giờ có mã riêng để giao diện không hiện như lỗi git.
func gitFailure(err error) *Error {
	var ge *gitexec.GitError
	switch {
	case errors.Is(err, context.Canceled):
		return &Error{Code: CodeCancelled, Message: "Đã huỷ."}
	case errors.Is(err, context.DeadlineExceeded):
		return &Error{Code: CodeTimeout, Message: "Hết thời gian chờ git."}
	case errors.As(err, &ge) && ge.Timeout:
		return &Error{Code: CodeTimeout, Message: "Hết thời gian chờ git.", Detail: ge.Msg}
	case errors.As(err, &ge) && ge.Auth:
		return &Error{Code: CodeAuth, Message: "Remote từ chối đăng nhập.", Detail: ge.Msg}
	case errors.As(err, &ge):
		return &Error{Code: CodeGit, Message: "Git báo lỗi.", Detail: ge.Msg}
	}
	return &Error{Code: CodeGit, Message: "Git báo lỗi.", Detail: err.Error()}
}

// Loại thư mục đang dùng (BusyDir.kind) và nhãn busy của worktree.
const (
	BusyHiveWorker = "hiveWorker"
	BusyAgent      = "agent"
	BusyTerminal   = "terminal"
	BusyApp        = "app"
)

// BusyDir là một thư mục app đang dùng: agent, terminal hay cửa sổ app.
type BusyDir struct {
	Path  string `json:"path"`
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
}

// Input là JSON dòng đầu stdin, chung cho mọi lệnh con.
type Input struct {
	Busy     []BusyDir           `json:"busy,omitempty"`
	Items    []CleanItem         `json:"items,omitempty"`
	Fetched  map[string][]string `json:"fetched,omitempty"`
	Settings *SettingsInput      `json:"settings,omitempty"`
}

// Stdin giữ danh sách busy mới nhất. Rust gửi lại danh sách mỗi 5 giây trong lúc job chạy, nên bước chặn của mục sau
// phải đọc lại chứ không dùng bản của dòng đầu.
type Stdin struct {
	r    *bufio.Reader
	mu   sync.Mutex
	busy []BusyDir
}

// ReadInput đọc dòng đầu stdin. Không dùng bufio.Scanner: danh sách items của clean có thể vượt 64 KB một dòng.
func ReadInput(r io.Reader) (*Stdin, Input, *Error) {
	s := &Stdin{r: bufio.NewReader(r)}
	var in Input
	line, err := readLine(s.r)
	if err != nil && !errors.Is(err, io.EOF) {
		return s, in, &Error{Code: CodeInvalidInput, Message: "Không đọc được dữ liệu vào.", Detail: err.Error()}
	}
	// Stdin đóng trước dòng đầu hay dòng trống: coi như {}, để chạy tay trên terminal vẫn được.
	if strings.TrimSpace(line) != "" {
		if err := json.Unmarshal([]byte(line), &in); err != nil {
			return s, Input{}, &Error{Code: CodeInvalidInput, Message: "Dữ liệu vào không phải JSON đúng dạng.", Detail: err.Error()}
		}
	}
	s.busy = in.Busy
	return s, in, nil
}

// Busy là danh sách thư mục đang dùng mới nhất.
func (s *Stdin) Busy() []BusyDir {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.busy
}

// Follow đọc các dòng sau dòng đầu tới EOF: "cancel" gọi cancel, {"busy":[…]} thay danh sách cũ. EOF không phải huỷ:
// Rust chết hay đóng stdin thì job chạy tiếp với danh sách cuối. Đọc tiếp cả sau cancel để Rust ghi busy không bị
// nghẽn ống.
func (s *Stdin) Follow(cancel func(), log io.Writer) {
	for {
		line, err := readLine(s.r)
		if t := strings.TrimSpace(line); t != "" {
			s.apply(t, cancel, log)
		}
		if err != nil {
			return
		}
	}
}

func (s *Stdin) apply(line string, cancel func(), log io.Writer) {
	if line == "cancel" {
		cancel()
		return
	}
	var msg struct {
		Busy *[]BusyDir `json:"busy"`
	}
	if err := json.Unmarshal([]byte(line), &msg); err != nil || msg.Busy == nil {
		_, _ = fmt.Fprintf(log, "bỏ qua dòng stdin không hiểu được: %.80q\n", line)
		return
	}
	s.mu.Lock()
	s.busy = *msg.Busy
	s.mu.Unlock()
}

// readLine trả một dòng đã bỏ \r\n (Windows); dòng cuối không có \n vẫn được trả, kèm io.EOF ở lần đọc sau.
func readLine(r *bufio.Reader) (string, error) {
	line, err := r.ReadString('\n')
	if err != nil && (!errors.Is(err, io.EOF) || line == "") {
		return "", err
	}
	return strings.TrimRight(line, "\r\n"), nil
}

// Env là những gì mọi lệnh con dùng chung, do cmd/hive-worker dựng từ cờ và stdin.
type Env struct {
	// Git luôn ở chế độ MachineCredentials: fetch như người dùng tự gõ, lệnh tại máy giữ dòng lỗi của git.
	Git gitexec.Git
	// DataDir là repolock.DataDir(): khoá repo chung với worker, worktree dưới đây là của run (FR-024).
	DataDir string
	// ConfigDir là thư mục cấu hình cạnh worker.json, chứa branches.json và branches-log.jsonl.
	ConfigDir string
	// Timeout là --timeout: cả lệnh với lệnh một lần, một bước với job (hợp đồng mục 1.5).
	Timeout time.Duration
	// Busy trả danh sách thư mục đang dùng mới nhất.
	Busy func() []BusyDir
	Now  func() time.Time
}

// Giới hạn riêng của từng loại lệnh git (FR-041, hợp đồng mục 1.5).
const (
	ReadTimeout  = 15 * time.Second
	FetchTimeout = 120 * time.Second
	LockTimeout  = 30 * time.Second
)

// git trả bộ chạy git có giới hạn d, không quá --timeout.
func (e Env) git(d time.Duration) gitexec.Git {
	g := e.Git
	if e.Timeout > 0 && e.Timeout < d {
		d = e.Timeout
	}
	g.Timeout = d
	return g
}

// read chạy một lệnh đọc tại máy, giới hạn ReadTimeout.
func (e Env) read(ctx context.Context, dir string, args ...string) (string, error) {
	return e.git(ReadTimeout).Run(ctx, dir, "", args...)
}

func (e Env) busy() []BusyDir {
	if e.Busy == nil {
		return nil
	}
	return e.Busy()
}

func (e Env) now() time.Time {
	if e.Now == nil {
		return time.Now()
	}
	return e.Now()
}

// Emit nhận một sự kiện dòng. Lệnh có thể gọi Emit từ nhiều goroutine; bên in phải tự khoá.
type Emit func(Event)

// Event là một dòng sự kiện của job và của list (hợp đồng mục 4). Trường nào không thuộc loại sự kiện thì bỏ trống.
type Event struct {
	Type     string        `json:"type"`
	Folder   string        `json:"folder,omitempty"`
	Branch   string        `json:"branch,omitempty"`
	Remote   string        `json:"remote,omitempty"`
	Step     string        `json:"step,omitempty"`
	Result   string        `json:"result,omitempty"`
	Error    *Error        `json:"error,omitempty"`
	Done     *int          `json:"done,omitempty"`
	Total    *int          `json:"total,omitempty"`
	Worktree *WorktreeInfo `json:"worktree,omitempty"`
	Repo     *ScanRepo     `json:"repo,omitempty"`
	Item     *CleanResult  `json:"item,omitempty"`
	// omitzero: fetch xong mà không remote nào thành công vẫn in "fetched":[] cho giao diện.
	Fetched     []string       `json:"fetched,omitzero"`
	FetchFailed []FetchFailure `json:"fetchFailed,omitzero"`
	FetchedAt   string         `json:"fetchedAt,omitempty"`
	Pull        *PullResult    `json:"pull,omitempty"`
	Summary     map[string]int `json:"summary,omitempty"`
	Log         string         `json:"log,omitempty"`
}

// Loại sự kiện.
const (
	EventProgress = "progress"
	EventWorktree = "worktree"
	EventRepo     = "repo"
	EventItem     = "item"
	EventDone     = "done"
)

// Count trả con trỏ tới n cho Event.Done, Event.Total: số 0 vẫn phải có trong JSON.
func Count(n int) *int { return &n }

// FetchFailure là một remote fetch lỗi (ScanRepo.fetchFailed, done của fetch).
type FetchFailure struct {
	Remote  string `json:"remote"`
	Message string `json:"message"`
	Auth    bool   `json:"auth"`
}

// busyOwned trả các thư mục trong busy thuộc worktree i: worktree có đường dẫn dài nhất chứa thư mục đó (hợp đồng mục
// 1.3). Nhờ vậy agent ở thư mục chính không chặn worktree trong .claude/worktrees/ và ngược lại.
func busyOwned(worktrees []string, i int, busy []BusyDir) []BusyDir {
	if len(busy) == 0 {
		return nil
	}
	clean := make([]string, len(worktrees))
	for j, w := range worktrees {
		clean[j] = repolock.CleanAbs(w)
	}
	var out []BusyDir
	for _, b := range busy {
		if b.Path == "" {
			continue
		}
		p := repolock.CleanAbs(b.Path)
		owner, best := -1, -1
		for j, w := range clean {
			if (p == w || repolock.InsideDir(w, p)) && len(w) > best {
				owner, best = j, len(w)
			}
		}
		if owner == i {
			out = append(out, b)
		}
	}
	return out
}

// busyKind chọn nhãn busy ưu tiên agent > terminal > app; hiveWorker do người gọi tự xét theo DataDir.
func busyKind(owned []BusyDir) string {
	rank := map[string]int{BusyAgent: 3, BusyTerminal: 2, BusyApp: 1}
	kind := ""
	for _, b := range owned {
		if rank[b.Kind] > rank[kind] {
			kind = b.Kind
		}
	}
	return kind
}
