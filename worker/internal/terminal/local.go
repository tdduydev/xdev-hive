package terminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/pty"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// Mặc định của phiên tại máy.
const (
	DefaultLocalSessions = 8
	// DefaultTailBytes: đuôi output giữ lại để phát cho client gắn lại; TUI vẽ lại khi có output mới hay đổi cỡ nên không
	// cần dựng màn hình (specs/010 D8).
	DefaultTailBytes = 256 * 1024
	// clientQueue: số khung chờ gửi cho một client; client đọc chậm tới mức đầy thì bị tách, để một terminal treo không
	// chặn CLI (PTY luôn được đọc) hay các client khác.
	clientQueue  = 1024
	writeTimeout = 30 * time.Second
	maxArgs      = 64
	maxSize      = 1000
)

// Lý do kết thúc riêng của phiên tại máy.
const ReasonKilled = "killed"

// LocalCLIs là CLI `hive chat` mở được.
var LocalCLIs = []string{"claude", "codex", "gemini"}

// Local giữ các phiên tương tác do `hive` mở tại máy qua socket nội bộ (specs/010 T011, phần tại máy; D2: worker giữ
// PTY). Phiên sống tới khi CLI thoát hoặc bị ngắt, không theo client: client đóng chỉ là tách, như tmux. Một client
// điều khiển, các client khác chỉ xem.
//
// Phiên được ghi lên hub qua Recorder (nil là không ghi, như runner host); Recorder tự thôi ghi trên máy dùng chung (D13).
type Local struct {
	// Accounts chọn gói cho phiên; nil là đăng nhập mặc định của CLI.
	Accounts *accounts.Pool
	// Commands ghi đè lệnh của CLI (HIVE_WORKER_CLI_OVERRIDES, test); đối số của client nối sau Args.
	Commands map[string]runner.Command
	Logger   *slog.Logger
	Recorder *Recorder

	MaxSessions int
	TailBytes   int
	Flush       time.Duration
	KillGrace   time.Duration

	mu       sync.Mutex
	sessions map[string]*localSession
	closing  bool
	wg       sync.WaitGroup
}

type localSession struct {
	id        string
	cli       string
	cwd       string
	accountID string
	account   string
	started   time.Time
	cmd       *exec.Cmd
	f         *os.File
	lease     *accounts.Lease
	rec       *RecordedSession

	stopOnce sync.Once
	stopCh   chan struct{}
	done     chan struct{}

	mu      sync.Mutex
	reason  string
	message string
	tail    []byte
	clients map[*localClient]struct{}
	ctl     *localClient
	ended   bool
	exit    localipc.Ctl
}

type localFrame struct {
	typ  byte
	data []byte
}

type localClient struct {
	conn   *localipc.Conn
	queue  chan localFrame
	closed bool
}

// SessionInfo là một dòng của session.list.
type SessionInfo struct {
	ID         string    `json:"id"`
	CLI        string    `json:"cli"`
	Cwd        string    `json:"cwd"`
	Account    string    `json:"account,omitempty"`
	Started    time.Time `json:"started"`
	PID        int       `json:"pid"`
	Controlled bool      `json:"controlled"`
	Viewers    int       `json:"viewers"`
	// HubID là mã phiên trên hub khi phiên được ghi (để mở trang phiên trên web); rỗng là không ghi.
	HubID string `json:"hubId,omitempty"`
}

// CreateParams là session.create.
type CreateParams struct {
	CLI     string   `json:"cli"`
	Cwd     string   `json:"cwd"`
	Cols    int      `json:"cols"`
	Rows    int      `json:"rows"`
	Args    []string `json:"args,omitempty"`
	Account string   `json:"account,omitempty"`
	Force   bool     `json:"force,omitempty"`
	// Term là $TERM của terminal người dùng, để CLI vẽ đúng loại terminal đang gắn.
	Term string `json:"term,omitempty"`
	// NoRecord là `hive chat --no-record`: không ghi phiên lên hub.
	NoRecord bool `json:"noRecord,omitempty"`
	// ProjectID, TaskID do `hive` tra trên hub; hub tự bỏ liên kết khi không thuộc đội của máy (FR-030).
	ProjectID string `json:"projectId,omitempty"`
	TaskID    string `json:"taskId,omitempty"`
}

// AttachParams là session.attach; Mode rỗng là control.
type AttachParams struct {
	ID   string `json:"id"`
	Mode string `json:"mode,omitempty"`
}

const (
	ModeControl = "control"
	ModeView    = "view"
)

func (l *Local) log() *slog.Logger {
	if l.Logger == nil {
		return slog.Default()
	}
	return l.Logger
}

// Handle là localipc.Handler cho các op session.*.
func (l *Local) Handle(_ context.Context, c *localipc.Conn, req localipc.Request) error {
	switch req.Op {
	case "session.create":
		var p CreateParams
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		return l.create(c, p)
	case "session.list":
		return c.OK(map[string]any{"sessions": l.List()})
	case "session.attach":
		var p AttachParams
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		if p.Mode == "" {
			p.Mode = ModeControl
		}
		if p.Mode != ModeControl && p.Mode != ModeView {
			return c.Fail(localipc.CodeBadRequest, "mode phải là control hoặc view.")
		}
		s, code, msg := l.find(p.ID)
		if s == nil {
			return c.Fail(code, msg)
		}
		if err := c.OK(map[string]any{"id": s.id, "cli": s.cli, "mode": p.Mode}); err != nil {
			return err
		}
		return l.attach(s, c, p.Mode)
	case "session.kill":
		var p AttachParams
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		s, code, msg := l.find(p.ID)
		if s == nil {
			return c.Fail(code, msg)
		}
		s.stop(ReasonKilled, "Phiên đã bị ngắt bằng hive kill.")
		return c.OK(map[string]any{"id": s.id})
	}
	return c.Fail(localipc.CodeUnsupported, "hive-worker chưa nhận thao tác "+clip(req.Op, 40)+".")
}

// List là các phiên đang chạy, cũ trước.
func (l *Local) List() []SessionInfo {
	l.mu.Lock()
	list := make([]*localSession, 0, len(l.sessions))
	for _, s := range l.sessions {
		if s != nil {
			list = append(list, s)
		}
	}
	l.mu.Unlock()
	out := make([]SessionInfo, 0, len(list))
	for _, s := range list {
		s.mu.Lock()
		info := SessionInfo{ID: s.id, CLI: s.cli, Cwd: s.cwd, Account: s.account, Started: s.started, Controlled: s.ctl != nil,
			Viewers: len(s.clients), HubID: s.rec.ID()}
		s.mu.Unlock()
		if info.Controlled {
			info.Viewers--
		}
		if s.cmd.Process != nil {
			info.PID = s.cmd.Process.Pid
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Started.Before(out[j].Started) })
	return out
}

// find tìm theo id đủ, hoặc tiền tố duy nhất (gõ vài ký tự đầu như docker).
func (l *Local) find(id string) (*localSession, string, string) {
	if id == "" {
		return nil, localipc.CodeBadRequest, "Thiếu mã phiên."
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if s := l.sessions[id]; s != nil {
		return s, "", ""
	}
	var match *localSession
	for sid, s := range l.sessions {
		// nil là id đang giữ chỗ cho phiên còn chuẩn bị.
		if s != nil && strings.HasPrefix(sid, id) {
			if match != nil {
				return nil, localipc.CodeBadRequest, fmt.Sprintf("Mã %q khớp nhiều phiên; gõ thêm ký tự.", id)
			}
			match = s
		}
	}
	if match == nil {
		return nil, localipc.CodeNotFound, fmt.Sprintf("Không có phiên %s trên máy.", clip(id, 40))
	}
	return match, "", ""
}

var termName = regexp.MustCompile(`^[A-Za-z0-9._+-]{1,64}$`)

func (l *Local) create(c *localipc.Conn, p CreateParams) error {
	if !slices.Contains(LocalCLIs, p.CLI) {
		return c.Fail(localipc.CodeBadRequest, fmt.Sprintf("CLI %q không hỗ trợ; dùng %s.", clip(p.CLI, 40), strings.Join(LocalCLIs, ", ")))
	}
	if !filepath.IsAbs(p.Cwd) {
		return c.Fail(localipc.CodeBadRequest, "Thư mục làm việc phải là đường dẫn tuyệt đối.")
	}
	if fi, err := os.Stat(p.Cwd); err != nil || !fi.IsDir() {
		return c.Fail(localipc.CodeBadRequest, "Không mở được thư mục "+clip(p.Cwd, 200)+".")
	}
	if len(p.Args) > maxArgs {
		return c.Fail(localipc.CodeBadRequest, "Quá nhiều đối số cho CLI.")
	}
	cols, rows := fitSize(p.Cols, 80), fitSize(p.Rows, 24)
	term := "xterm-256color"
	if termName.MatchString(p.Term) {
		term = p.Term
	}
	if !pty.Supported {
		return c.Fail(localipc.CodeUnsupported, "Máy này chưa hỗ trợ phiên tương tác (chưa có PTY).")
	}
	id, err := l.reserve()
	if err != nil {
		return c.Fail(localipc.CodeBusy, err.Error())
	}
	s, err := l.start(id, p, cols, rows, term)
	if err != nil {
		l.release(id)
		code := localipc.CodeFailed
		if errors.Is(err, accounts.ErrNoAccount) || errors.Is(err, accounts.ErrBusy) {
			code = localipc.CodeBusy
		}
		return c.Fail(code, err.Error())
	}
	if err := c.OK(map[string]any{"id": s.id, "cli": s.cli, "account": s.account, "mode": ModeControl}); err != nil {
		return err
	}
	return l.attach(s, c, ModeControl)
}

func fitSize(v, def int) int {
	if v <= 0 {
		return def
	}
	return min(v, maxSize)
}

// reserve giữ chỗ một id trước khi chuẩn bị phiên, để hai yêu cầu cùng lúc không vượt MaxSessions.
func (l *Local) reserve() (string, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closing {
		return "", errors.New("hive-worker đang tắt, không mở phiên mới.")
	}
	if l.sessions == nil {
		l.sessions = map[string]*localSession{}
	}
	if limit := orDefault(l.MaxSessions, DefaultLocalSessions); len(l.sessions) >= limit {
		return "", fmt.Errorf("Máy đã mở đủ %d phiên; ngắt bớt bằng hive kill rồi thử lại.", limit)
	}
	for {
		b := make([]byte, 4)
		_, _ = rand.Read(b)
		id := hex.EncodeToString(b)
		if _, dup := l.sessions[id]; !dup {
			l.sessions[id] = nil
			return id, nil
		}
	}
}

func (l *Local) release(id string) {
	l.mu.Lock()
	delete(l.sessions, id)
	l.mu.Unlock()
}

func (l *Local) command(cli string, args []string) (*exec.Cmd, error) {
	if c, ok := l.Commands[cli]; ok {
		base := make([]string, 0, len(c.Args)+len(args))
		for _, a := range c.Args {
			if a != "{{prompt}}" {
				base = append(base, a)
			}
		}
		return exec.Command(c.Path, append(base, args...)...), nil
	}
	path, err := exec.LookPath(runner.Binary(cli))
	if err != nil {
		return nil, fmt.Errorf("Không tìm thấy lệnh %s trên máy (theo PATH của hive-worker).", runner.Binary(cli))
	}
	return exec.Command(path, args...), nil
}

func (l *Local) start(id string, p CreateParams, cols, rows int, term string) (*localSession, error) {
	lease, err := l.Accounts.AcquireInteractiveForce(p.CLI, p.Account, p.Force)
	if err != nil {
		return nil, fmt.Errorf("Không dùng được gói %s cho phiên này: %w", p.CLI, err)
	}
	cmd, err := l.command(p.CLI, p.Args)
	if err != nil {
		lease.Release()
		return nil, err
	}
	env, secrets := runner.LocalEnv(p.CLI, lease.Env(), map[string]string{"TERM": term})
	cmd.Env = env
	cmd.Dir = p.Cwd
	f, err := pty.Start(cmd, cols, rows)
	if err != nil {
		lease.Release()
		return nil, fmt.Errorf("Không chạy được %s: %w", p.CLI, err)
	}
	s := &localSession{
		id: id, cli: p.CLI, cwd: p.Cwd, accountID: lease.ID(), account: clip(lease.Label(), maxLabel), started: time.Now(),
		cmd: cmd, f: f, lease: lease, stopCh: make(chan struct{}), done: make(chan struct{}),
		clients: map[*localClient]struct{}{},
	}
	if !p.NoRecord {
		s.rec = l.Recorder.Open(RecordOpen{CLI: p.CLI, Cwd: p.Cwd, AccountLabel: lease.Label(), ProjectID: p.ProjectID,
			TaskID: p.TaskID, Cols: cols, Rows: rows})
	}
	l.mu.Lock()
	l.sessions[id] = s
	closing := l.closing
	l.wg.Add(1)
	l.mu.Unlock()
	if closing {
		s.stop(ReasonClosed, "hive-worker đang tắt.")
	}
	l.log().Info("Đã mở phiên tại máy", "session", id, "cli", p.CLI, "account", lease.ID(), "cwd", p.Cwd)
	go l.run(s, secrets)
	return s, nil
}

// stop đặt lý do (lý do đầu tiên thắng) rồi báo vòng chạy dừng CLI.
func (s *localSession) stop(reason, message string) {
	s.mu.Lock()
	if s.reason == "" {
		s.reason, s.message = reason, message
	}
	s.mu.Unlock()
	s.stopOnce.Do(func() { close(s.stopCh) })
}

func (l *Local) run(s *localSession, secrets []string) {
	defer l.wg.Done()
	exited := make(chan struct{})
	go func() { _ = s.cmd.Wait(); close(exited) }()
	outDone := l.pump(s, secrets)
	selfExit := false
	select {
	case <-exited:
		selfExit = true
	case <-s.stopCh:
		// Như đóng cửa sổ terminal: SIGHUP để CLI tự dọn, quá hạn thì giết cả nhóm.
		pty.HangupGroup(s.cmd)
		select {
		case <-exited:
		case <-time.After(orDefault(l.KillGrace, DefaultKillGrace)):
		}
	}
	// Tiến trình con chạy nền của agent giữ PTY mở; dừng cả nhóm để output kết thúc.
	pty.KillGroup(s.cmd)
	<-exited
	select {
	case <-outDone:
	case <-time.After(drainWait):
		_ = s.f.Close()
		<-outDone
	}
	_ = s.f.Close()
	s.lease.Release()

	if selfExit {
		s.stop(ReasonExit, "")
	}
	s.mu.Lock()
	ctl := localipc.Ctl{Type: localipc.CtlExit, Reason: s.reason, Message: s.message}
	s.mu.Unlock()
	if ctl.Reason == ReasonExit {
		if c := s.cmd.ProcessState.ExitCode(); c >= 0 {
			ctl.Code = &c
		}
	}
	s.finish(ctl)
	s.rec.Close(ctl.Code, ctl.Reason, ctl.Message)
	l.mu.Lock()
	if l.sessions[s.id] == s {
		delete(l.sessions, s.id)
	}
	l.mu.Unlock()
	close(s.done)
	l.log().Info("Đã đóng phiên tại máy", "session", s.id, "reason", ctl.Reason)
}

// pump đọc PTY liên tục (dù không client nào gắn, để CLI không bị chặn ghi), che bí mật, giữ đuôi và phát cho client.
func (l *Local) pump(s *localSession, secrets []string) <-chan struct{} {
	reads := make(chan []byte, 4)
	go func() {
		defer close(reads)
		buf := make([]byte, DefaultChunkBytes)
		for {
			n, err := s.f.Read(buf)
			if n > 0 {
				reads <- append([]byte(nil), buf[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	done := make(chan struct{})
	go func() {
		defer close(done)
		red := newRedactor(secrets)
		flush := orDefault(l.Flush, DefaultFlush)
		timer := time.NewTimer(flush)
		timer.Stop()
		for {
			select {
			case b, ok := <-reads:
				if !ok {
					s.emit(red.release(), l.tailBytes())
					return
				}
				s.emit(red.push(b), l.tailBytes())
				// Đuôi có thể là đầu của bí mật được giữ lại; không có gì mới trong một nhịp thì nhả để màn hình không đứng.
				if red.holding() {
					timer.Reset(flush)
				}
			case <-timer.C:
				s.emit(red.release(), l.tailBytes())
			}
		}
	}()
	return done
}

func (l *Local) tailBytes() int { return orDefault(l.TailBytes, DefaultTailBytes) }

func (s *localSession) emit(b []byte, limit int) {
	if len(b) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.rec.Write(b)
	s.tail = append(s.tail, b...)
	// Cắt khi gấp đôi giới hạn để không chép đuôi mỗi lần đọc.
	if len(s.tail) > 2*limit {
		s.tail = append([]byte(nil), s.tail[len(s.tail)-limit:]...)
	}
	for cl := range s.clients {
		s.enqueue(cl, localFrame{typ: localipc.FrameOut, data: b})
	}
}

// enqueue gửi khung cho client (giữ s.mu); hàng đầy thì tách client.
func (s *localSession) enqueue(cl *localClient, f localFrame) {
	if cl.closed {
		return
	}
	select {
	case cl.queue <- f:
	default:
		s.dropLocked(cl)
	}
}

func (s *localSession) dropLocked(cl *localClient) {
	if cl.closed {
		return
	}
	cl.closed = true
	close(cl.queue)
	delete(s.clients, cl)
	if s.ctl == cl {
		s.ctl = nil
	}
}

func ctlFrame(c localipc.Ctl) localFrame {
	b, _ := json.Marshal(c)
	return localFrame{typ: localipc.FrameCtl, data: b}
}

// finish báo mọi client phiên đã kết thúc rồi tách họ.
func (s *localSession) finish(ctl localipc.Ctl) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ended = true
	s.exit = ctl
	for cl := range s.clients {
		s.enqueue(cl, ctlFrame(ctl))
		s.dropLocked(cl)
	}
}

// attach gắn client vào phiên tới khi client tách, đọc chậm quá, hoặc phiên kết thúc.
func (l *Local) attach(s *localSession, c *localipc.Conn, mode string) error {
	cl := &localClient{conn: c, queue: make(chan localFrame, clientQueue)}
	s.mu.Lock()
	if s.ended {
		cl.queue <- ctlFrame(s.exit)
		cl.closed = true
		close(cl.queue)
	} else {
		limit := l.tailBytes()
		tail := s.tail
		if len(tail) > limit {
			tail = tail[len(tail)-limit:]
		}
		for len(tail) > 0 {
			n := min(len(tail), DefaultChunkBytes)
			cl.queue <- localFrame{typ: localipc.FrameOut, data: tail[:n:n]}
			tail = tail[n:]
		}
		s.clients[cl] = struct{}{}
		if mode == ModeControl {
			s.takeLocked(cl)
		}
	}
	s.mu.Unlock()

	written := make(chan struct{})
	go func() {
		defer close(written)
		failed := false
		for f := range cl.queue {
			if failed {
				continue
			}
			_ = c.SetWriteDeadline(time.Now().Add(writeTimeout))
			if err := c.WriteFrame(f.typ, f.data); err != nil {
				failed = true
				_ = c.Close()
			}
		}
		// Hết hàng (tách, bị đẩy ra, phiên kết thúc): đóng để vòng đọc dưới thoát.
		_ = c.Close()
	}()

	for {
		typ, data, err := c.ReadFrame()
		if err != nil {
			break
		}
		if !l.handleFrame(s, cl, typ, data) {
			break
		}
	}
	s.mu.Lock()
	s.dropLocked(cl)
	s.mu.Unlock()
	<-written
	return localipc.ErrDone
}

// handleFrame xử lý một khung của client; false là client tách.
func (l *Local) handleFrame(s *localSession, cl *localClient, typ byte, data []byte) bool {
	switch typ {
	case localipc.FrameIn:
		if s.controlledBy(cl) {
			// Ghi thẳng: CLI chưa đọc kịp thì chỉ client này chờ, output và client khác vẫn chạy.
			_, _ = s.f.Write(data)
		}
	case localipc.FrameResize:
		var sz localipc.Size
		if json.Unmarshal(data, &sz) == nil && sz.Cols > 0 && sz.Rows > 0 && s.controlledBy(cl) {
			if err := pty.Resize(s.f, min(sz.Cols, maxSize), min(sz.Rows, maxSize)); err != nil {
				l.log().Debug("Không đổi được cỡ PTY", "session", s.id, "error", err)
			}
		}
	case localipc.FrameCtl:
		var ctl localipc.Ctl
		if json.Unmarshal(data, &ctl) != nil {
			return true
		}
		switch ctl.Type {
		case localipc.CtlDetach:
			return false
		case localipc.CtlTake:
			s.mu.Lock()
			s.takeLocked(cl)
			s.mu.Unlock()
		}
	}
	// Loại khung lạ bỏ qua: client mới hơn có thể gửi thêm loại.
	return true
}

func (s *localSession) controlledBy(cl *localClient) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ctl == cl
}

// takeLocked trao quyền điều khiển cho cl; người đang điều khiển nhận "taken" và chỉ còn xem.
func (s *localSession) takeLocked(cl *localClient) {
	if cl.closed || s.ctl == cl {
		return
	}
	if old := s.ctl; old != nil {
		s.enqueue(old, ctlFrame(localipc.Ctl{Type: localipc.CtlTaken, Message: "Terminal khác đã giành quyền điều khiển; bạn đang xem."}))
	}
	s.ctl = cl
	s.enqueue(cl, ctlFrame(localipc.Ctl{Type: localipc.CtlControl}))
}

// CloseAll ngắt mọi phiên (worker tắt) và từ chối phiên mới.
func (l *Local) CloseAll(message string) {
	l.mu.Lock()
	l.closing = true
	list := make([]*localSession, 0, len(l.sessions))
	for _, s := range l.sessions {
		if s != nil {
			list = append(list, s)
		}
	}
	l.mu.Unlock()
	for _, s := range list {
		s.stop(ReasonClosed, message)
	}
}

// Wait chờ mọi phiên dọn xong, tối đa timeout; false khi hết giờ.
func (l *Local) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { l.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}
