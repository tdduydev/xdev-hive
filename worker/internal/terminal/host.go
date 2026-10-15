// Package terminal giữ các phiên `claude` tương tác trong PTY cho terminal Leader trên máy dùng chung (specs/010 lát
// đầu). Không phụ thuộc gói giao thức: kênh đổi Event thành gói term_* và gọi Open/Input/Resize/Close.
package terminal

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/pty"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// Mặc định theo TERMINAL_LIMITS của packages/contracts/src/worker-protocol.ts.
const (
	DefaultMaxSessions = 4
	DefaultIdleTimeout = 1800 * time.Second
	DefaultFlush       = 40 * time.Millisecond
	DefaultChunkBytes  = 32 * 1024
	DefaultRateBytes   = 256 * 1024
	DefaultKillGrace   = 3 * time.Second
	// inputQueue: phím tới lúc phiên còn chuẩn bị (clone, worktree) nằm chờ ở đây; đầy thì bỏ để vòng đọc kênh không kẹt.
	inputQueue = 256
	// drainWait: sau khi CLI thoát, chờ output cuối chừng này rồi đóng PTY (tiến trình cháu còn giữ PTY thì không có EOF).
	drainWait  = 2 * time.Second
	maxMessage = 500
	maxLabel   = 80
)

// Loại Event.
const (
	KindOpened = "opened"
	KindOutput = "output"
	KindExit   = "exit"
)

// Lý do kết thúc phiên (termExitReason của hợp đồng).
const (
	ReasonExit   = "exit"
	ReasonClosed = "closed"
	ReasonIdle   = "idle"
	ReasonDenied = "denied"
	ReasonError  = "error"
)

// Event là việc Host báo hub: opened (AccountLabel, Permissions), output (Seq, Data) hay exit (ExitCode, Reason,
// Message). AccountLabel rỗng là đăng nhập mặc định.
type Event struct {
	Kind         string
	SessionID    string
	AccountLabel string
	Permissions  string
	Seq          int64
	Data         []byte
	ExitCode     *int
	Reason       string
	Message      string
}

// OpenRequest là term_open đã đổi sang kiểu của worker. AccountID rỗng là tự chọn gói rảnh.
type OpenRequest struct {
	SessionID string
	AccountID string
	Cols      int
	Rows      int
	Spec      runner.InteractiveSpec
}

// Host quản lý các phiên đang mở trên máy. Giá trị 0 của các trường cấu hình là mặc định.
type Host struct {
	// Runner chuẩn bị worktree và lệnh (DataDir, CLICommands, TokenSaving, ClaudeVersion); Account đặt theo từng phiên.
	Runner runner.Runner
	// Accounts chọn gói cho phiên; nil là đăng nhập mặc định của CLI.
	Accounts *accounts.Pool
	// Send gửi Event lên hub; lỗi (mất kết nối) bị bỏ qua: hub coi phiên đã hỏng khi máy ngắt.
	Send   func(Event) error
	Logger *slog.Logger

	MaxSessions int
	IdleTimeout time.Duration
	Flush       time.Duration
	ChunkBytes  int
	RateBytes   int
	KillGrace   time.Duration

	mu       sync.Mutex
	sessions map[string]*session
	wg       sync.WaitGroup
}

type session struct {
	id     string
	ctx    context.Context
	cancel context.CancelFunc
	input  chan []byte
	// last là lúc có input hay output gần nhất (UnixNano), để đóng phiên không hoạt động.
	last atomic.Int64

	mu      sync.Mutex
	reason  string
	message string
	f       pty.Terminal
}

// stop đặt lý do kết thúc (lý do đầu tiên thắng) rồi huỷ phiên.
func (s *session) stop(reason, message string) {
	s.mu.Lock()
	if s.reason == "" {
		s.reason, s.message = reason, message
	}
	s.mu.Unlock()
	s.cancel()
}

func (s *session) result() (string, string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.reason, s.message
}

func (s *session) touch() { s.last.Store(time.Now().UnixNano()) }

func (h *Host) log() *slog.Logger {
	if h.Logger == nil {
		return slog.Default()
	}
	return h.Logger
}

func orDefault[T int | time.Duration](v, def T) T {
	if v > 0 {
		return v
	}
	return def
}

func (h *Host) send(e Event) {
	if h.Send == nil {
		return
	}
	if err := h.Send(e); err != nil {
		h.log().Debug("Không gửi được gói terminal", "session", e.SessionID, "kind", e.Kind, "error", err)
	}
}

func clip(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	r := []rune(s)
	return string(r[:n-1]) + "…"
}

func (h *Host) exit(id string, code *int, reason, message string) {
	h.send(Event{Kind: KindExit, SessionID: id, ExitCode: code, Reason: reason, Message: clip(message, maxMessage)})
}

// Count là số phiên đang mở hoặc đang chuẩn bị.
func (h *Host) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.sessions)
}

// Open mở phiên trong nền; kết quả đi ra bằng Event (opened rồi output, hoặc exit denied/error). ctx là đời của worker:
// huỷ ctx đóng phiên.
func (h *Host) Open(ctx context.Context, req OpenRequest) {
	h.mu.Lock()
	if h.sessions == nil {
		h.sessions = map[string]*session{}
	}
	if _, dup := h.sessions[req.SessionID]; dup {
		h.mu.Unlock()
		// Hub gửi lại term_open của phiên đang chạy (nối lại): giữ phiên cũ.
		h.log().Info("Bỏ term_open của phiên đang mở", "session", req.SessionID)
		return
	}
	if limit := orDefault(h.MaxSessions, DefaultMaxSessions); len(h.sessions) >= limit {
		h.mu.Unlock()
		h.exit(req.SessionID, nil, ReasonDenied, fmt.Sprintf("Máy đã mở đủ %d phiên terminal; đóng bớt phiên rồi thử lại.", limit))
		return
	}
	sctx, cancel := context.WithCancel(ctx)
	s := &session{id: req.SessionID, ctx: sctx, cancel: cancel, input: make(chan []byte, inputQueue)}
	s.touch()
	h.sessions[req.SessionID] = s
	h.wg.Add(1)
	h.mu.Unlock()
	go h.run(s, req)
}

func (h *Host) get(id string) *session {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.sessions[id]
}

// Input ghi phím vào PTY (qua hàng chờ, để vòng đọc kênh không chờ CLI).
func (h *Host) Input(id string, data []byte) {
	s := h.get(id)
	if s == nil {
		h.log().Debug("Bỏ input cho phiên không còn", "session", id)
		return
	}
	s.touch()
	select {
	case s.input <- append([]byte(nil), data...):
	default:
		h.log().Warn("Bỏ input vì phiên còn nhiều phím chưa ghi", "session", id)
	}
}

// Resize đổi cỡ PTY; phiên còn chuẩn bị thì bỏ (PTY mở theo cỡ của term_open).
func (h *Host) Resize(id string, cols, rows int) {
	s := h.get(id)
	if s == nil {
		return
	}
	s.mu.Lock()
	f := s.f
	s.mu.Unlock()
	if f == nil {
		return
	}
	if err := f.Resize(cols, rows); err != nil {
		h.log().Debug("Không đổi được cỡ PTY", "session", id, "error", err)
	}
}

// Close đóng phiên theo lệnh của hub; term_exit lý do closed đi ra khi đã dọn xong.
func (h *Host) Close(id, message string) {
	if s := h.get(id); s != nil {
		s.stop(ReasonClosed, message)
	}
}

// CloseAll đóng mọi phiên (mất kết nối hub, worker tắt): không giữ phiên mồ côi mà không ai xem.
func (h *Host) CloseAll(message string) {
	h.mu.Lock()
	list := make([]*session, 0, len(h.sessions))
	for _, s := range h.sessions {
		list = append(list, s)
	}
	h.mu.Unlock()
	for _, s := range list {
		s.stop(ReasonClosed, message)
	}
}

// Wait chờ mọi phiên dọn xong (CLI dừng, worktree gỡ), tối đa timeout; false khi hết giờ.
func (h *Host) Wait(timeout time.Duration) bool {
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	select {
	case <-done:
		return true
	case <-time.After(timeout):
		return false
	}
}

func idleText(d time.Duration) string {
	if d >= time.Minute {
		return fmt.Sprintf("%d phút", int(d/time.Minute))
	}
	return fmt.Sprintf("%d giây", max(1, int(d/time.Second)))
}

func (h *Host) run(s *session, req OpenRequest) {
	defer h.wg.Done()
	// Gỡ phiên khỏi bảng trước khi báo term_exit: hub nhận exit rồi mở lại cùng id (hoặc đếm phiên) không được gặp phiên ma
	// vừa bị bỏ term_open là trùng, hay vừa tính vào giới hạn.
	exit := func(code *int, reason, message string) {
		h.mu.Lock()
		if h.sessions[s.id] == s {
			delete(h.sessions, s.id)
		}
		h.mu.Unlock()
		s.cancel()
		h.exit(s.id, code, reason, message)
	}
	lease, err := h.Accounts.AcquireInteractive("claude", req.AccountID)
	if err != nil {
		exit(nil, ReasonDenied, "Không dùng được gói Claude cho phiên này: "+err.Error())
		return
	}
	r := h.Runner
	r.Account = lease
	it, err := r.PrepareInteractive(s.ctx, req.Spec)
	if err != nil {
		lease.Release()
		if s.ctx.Err() != nil {
			reason, msg := s.result()
			exit(nil, orReason(reason), msg)
			return
		}
		h.log().Warn("Không chuẩn bị được phiên terminal", "session", s.id, "error", err)
		exit(nil, ReasonError, "Không chuẩn bị được phiên terminal: "+err.Error())
		return
	}
	code, reason, msg := h.serve(s, req, lease, it)
	it.Cleanup()
	lease.Release()
	exit(code, reason, msg)
}

func orReason(r string) string {
	if r == "" {
		return ReasonClosed
	}
	return r
}

// serve chạy CLI trong PTY tới khi nó thoát hoặc phiên bị đóng; trả mã thoát (chỉ khi CLI tự thoát) và lý do.
func (h *Host) serve(s *session, req OpenRequest, lease *accounts.Lease, it *runner.Interactive) (*int, string, string) {
	if s.ctx.Err() != nil {
		reason, msg := s.result()
		return nil, orReason(reason), msg
	}
	cmd := it.Cmd
	f, err := pty.Start(cmd, req.Cols, req.Rows)
	if err != nil {
		if errors.Is(err, pty.ErrUnsupported) {
			return nil, ReasonDenied, "Máy này chưa hỗ trợ terminal Leader."
		}
		return nil, ReasonError, "Không chạy được claude: " + err.Error()
	}
	s.mu.Lock()
	s.f = f
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.f = nil
		s.mu.Unlock()
		_ = f.Close()
	}()
	h.send(Event{Kind: KindOpened, SessionID: s.id, AccountLabel: clip(lease.Label(), maxLabel), Permissions: it.Permissions})
	h.log().Info("Đã mở phiên terminal Leader", "session", s.id, "account", lease.ID(), "permissions", it.Permissions)

	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	go h.writeInput(s, f, exited)
	outDone := h.pumpOutput(s, f, it.Secrets)

	idle := orDefault(h.IdleTimeout, DefaultIdleTimeout)
	check := time.NewTicker(max(idle/4, 10*time.Millisecond))
	defer check.Stop()
	selfExit := false
loop:
	for {
		select {
		case <-exited:
			selfExit = true
			break loop
		case <-s.ctx.Done():
			break loop
		case <-check.C:
			if time.Since(time.Unix(0, s.last.Load())) > idle {
				s.stop(ReasonIdle, "Phiên không hoạt động quá "+idleText(idle)+" nên đã đóng.")
			}
		}
	}
	if !selfExit {
		// Như đóng cửa sổ terminal: SIGHUP để claude tự dọn, quá hạn thì SIGKILL cả nhóm.
		pty.HangupGroup(cmd)
		select {
		case <-exited:
		case <-time.After(orDefault(h.KillGrace, DefaultKillGrace)):
		}
	}
	// Tiến trình con chạy nền của CLI (lệnh Bash của agent) giữ PTY mở; dừng cả nhóm để output kết thúc.
	pty.KillGroup(cmd)
	<-exited
	select {
	case <-outDone:
	case <-time.After(drainWait):
		_ = f.Close()
		<-outDone
	}
	if selfExit {
		s.stop(ReasonExit, "")
	}
	reason, msg := s.result()
	if reason != ReasonExit {
		return nil, orReason(reason), msg
	}
	var code *int
	if c := cmd.ProcessState.ExitCode(); c >= 0 {
		code = &c
	}
	return code, ReasonExit, ""
}

func (h *Host) writeInput(s *session, f pty.Terminal, exited <-chan struct{}) {
	for {
		select {
		case b := <-s.input:
			if _, err := f.Write(b); err != nil {
				return
			}
		case <-exited:
			return
		}
	}
}

// pumpOutput đọc PTY, che bí mật, gom theo Flush hoặc ChunkBytes rồi gửi trong giới hạn RateBytes/giây. Kênh giữa đọc
// và gửi nhỏ nên gửi chậm thì đọc dừng và CLI bị chặn ghi: chờ chứ không bỏ byte. Kênh trả về đóng khi đã gửi hết.
func (h *Host) pumpOutput(s *session, f pty.Terminal, secrets []string) <-chan struct{} {
	chunkBytes := orDefault(h.ChunkBytes, DefaultChunkBytes)
	flush := orDefault(h.Flush, DefaultFlush)
	chunks := make(chan []byte, 4)
	go func() {
		defer close(chunks)
		buf := make([]byte, chunkBytes)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				s.touch()
				chunks <- append([]byte(nil), buf[:n]...)
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
		limit := newBucket(orDefault(h.RateBytes, DefaultRateBytes))
		var seq int64
		var pending []byte
		send := func() {
			for len(pending) > 0 {
				n := min(len(pending), chunkBytes)
				limit.wait(n)
				h.send(Event{Kind: KindOutput, SessionID: s.id, Seq: seq, Data: pending[:n:n]})
				seq++
				pending = pending[n:]
			}
			pending = nil
		}
		timer := time.NewTimer(flush)
		timer.Stop()
		armed, fresh := false, false
		for {
			select {
			case b, ok := <-chunks:
				if !ok {
					pending = append(pending, red.release()...)
					send()
					timer.Stop()
					return
				}
				pending = append(pending, red.push(b)...)
				fresh = true
				if len(pending) >= chunkBytes {
					send()
				}
				if !armed {
					timer.Reset(flush)
					armed = true
				}
			case <-timer.C:
				armed = false
				// Đuôi có thể là đầu của bí mật được giữ qua một nhịp; nhịp sau không có gì mới thì nhả để màn hình không
				// đứng chờ.
				if !fresh {
					pending = append(pending, red.release()...)
				}
				fresh = false
				send()
				if red.holding() {
					timer.Reset(flush)
					armed = true
				}
			}
		}
	}()
	return done
}

// bucket giới hạn byte gửi mỗi giây; cho dồn tối đa một giây.
type bucket struct {
	rate   float64
	tokens float64
	last   time.Time
}

func newBucket(rate int) *bucket {
	return &bucket{rate: float64(rate), tokens: float64(rate), last: time.Now()}
}

func (b *bucket) wait(n int) {
	now := time.Now()
	b.tokens = min(b.rate, b.tokens+now.Sub(b.last).Seconds()*b.rate)
	b.last = now
	if need := float64(n) - b.tokens; need > 0 {
		time.Sleep(time.Duration(need / b.rate * float64(time.Second)))
		b.tokens += need
		b.last = time.Now()
	}
	b.tokens -= float64(n)
}
