package terminal

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Ghi phiên tại máy lên hub (specs/010 T011, plan "Luồng: phiên tại máy"). Output gom 8 ms/32 KiB thành term_output,
// nằm trong đệm đĩa tới khi hub term_ack; mất hub thì giữ đệm và gửi bù sau welcome kế tiếp (hub loại trùng theo seq).
// Máy dùng chung và hub không khai "terminal" thì không ghi gì (D13, SC-010).

const (
	DefaultRecordFlush = 8 * time.Millisecond
	// DefaultRecordChunk bằng TERMINAL_LIMITS.outputBytes: hub đóng kết nối khi gói lớn hơn.
	DefaultRecordChunk = 32 * 1024
	// DefaultPendingBytes: đệm chưa ack mỗi phiên; quá thì bỏ output và báo `gap` để trang phát lại biết thiếu đoạn.
	DefaultPendingBytes = 32 << 20
	// sendBatch: mỗi lượt gửi tối đa chừng này byte rồi nhường, để gửi bù 32 MB không giữ khoá lâu.
	sendBatch = 1 << 20
)

// compactMin: phần đã ack ở đầu file phải lớn hơn chừng này mới dời, để không chép lại liên tục khi đệm nhỏ. Biến để
// test hạ xuống.
var compactMin int64 = 4 << 20

// Giới hạn của term_opened phía hub; vượt là hub đóng kết nối worker (gói không hợp lệ).
const (
	minCols, maxCols = 20, 500
	minRows, maxRows = 5, 200
	maxCwdLabel      = 200
	maxRefID         = 64
)

// RecordOpen là thông tin phiên tại máy để báo hub.
type RecordOpen struct {
	CLI, Cwd, AccountLabel string
	ProjectID, TaskID      string
	Cols, Rows             int
}

// Recorder là Handler của kênh cho phiên trên máy cá nhân. Ghép, tắt và gỡ thiết bị chuyển cho Remote; cấp quyền gõ
// chuyển cho Controller; mở phiên từ xa chưa có nên bị từ chối như máy chưa bật từ xa (T050 thay phần này).
type Recorder struct {
	// Dir chứa đệm `<phiên>.pending`; file còn lại từ lần chạy trước bị xoá vì PTY của chúng đã mất.
	Dir        string
	MaxPending int64
	Flush      time.Duration
	ChunkBytes int
	Logger     *slog.Logger
	// BaseState dựng phần term_state ngoài danh sách phiên (bật từ xa, thư mục, thiết bị); nil thì lấy từ Remote, không
	// có Remote là chưa bật gì.
	BaseState func() State
	// Remote nhận term_pair, term_disable, term_device_revoke; nil là máy không có điều khiển từ xa.
	Remote *Remote
	// Controller nhận term_control, term_detach, term_input, term_resize; nil là từ chối như máy chưa bật từ xa.
	Controller *Controller

	once     sync.Once
	wake     chan struct{}
	mu       sync.Mutex
	link     Sender
	off      bool
	resync   bool
	dirty    bool
	sessions []*RecordedSession
}

var _ Handler = (*Recorder)(nil)

// RecordedSession là một phiên đang ghi. Mọi trường được giữ bởi Recorder.mu.
type RecordedSession struct {
	r      *Recorder
	id     string
	opened Opened

	file    *os.File
	size    int64
	chunks  []recChunk
	pending int64
	buf     []byte
	timer   *time.Timer
	nextSeq int64

	// sent: seq lớn nhất đã gửi trên kết nối hiện tại; nối lại thì về -1 để gửi bù mọi thứ chưa ack.
	sent       int64
	controller string
	openedSent bool
	exit       *Exit
	exitSent   bool
	gapFrom    int64
	gapTo      int64
	dropped    bool
}

type recChunk struct {
	seq int64
	off int64
	n   int
}

func (r *Recorder) log() *slog.Logger {
	if r.Logger == nil {
		return slog.Default()
	}
	return r.Logger
}

func (r *Recorder) init() {
	r.once.Do(func() {
		r.wake = make(chan struct{}, 1)
		if r.Dir != "" {
			if err := os.MkdirAll(r.Dir, 0o700); err != nil {
				r.log().Warn("Không tạo được thư mục đệm phiên", "dir", r.Dir, "error", err)
			}
			old, _ := filepath.Glob(filepath.Join(r.Dir, "*.pending"))
			for _, f := range old {
				_ = os.Remove(f)
			}
		}
		go r.loop()
	})
}

func (r *Recorder) signal() {
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

func clamp(v, lo, hi int) int { return max(lo, min(v, hi)) }

// cwdLabel: hai cấp cuối của thư mục, không gửi đường dẫn tuyệt đối (lộ tên người dùng, cấu trúc máy) lên hub.
func cwdLabel(cwd string) string {
	parts := strings.FieldsFunc(filepath.ToSlash(cwd), func(r rune) bool { return r == '/' })
	if len(parts) > 2 {
		parts = parts[len(parts)-2:]
	}
	return clip(strings.Join(parts, "/"), maxCwdLabel)
}

func refID(s string) string {
	if len(s) > maxRefID {
		return ""
	}
	return s
}

// Open bắt đầu ghi một phiên; nil khi không ghi (máy dùng chung, hub không nhận phiên, không mở được đệm).
func (r *Recorder) Open(o RecordOpen) *RecordedSession {
	if r == nil {
		return nil
	}
	r.init()
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.off {
		return nil
	}
	id := newUUID()
	f, err := os.OpenFile(filepath.Join(r.Dir, id+".pending"), os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		r.log().Warn("Không mở được đệm ghi phiên; phiên không được ghi lên hub", "error", err)
		return nil
	}
	label := clip(o.AccountLabel, maxLabel)
	yes, no := true, false
	s := &RecordedSession{r: r, id: id, file: f, sent: -1, gapFrom: -1, opened: Opened{
		SessionID: id, Origin: "local", AccountLabel: &label, Permissions: "workspace", CLI: o.CLI, CwdLabel: cwdLabel(o.Cwd),
		ProjectID: refID(o.ProjectID), TaskID: refID(o.TaskID), Cols: clamp(o.Cols, minCols, maxCols),
		Rows: clamp(o.Rows, minRows, maxRows), Record: &yes, Remote: &no,
	}}
	r.sessions = append(r.sessions, s)
	r.dirty = true
	r.signal()
	return s
}

// ID là mã phiên trên hub (khác mã ngắn của `hive ls`).
func (s *RecordedSession) ID() string {
	if s == nil {
		return ""
	}
	return s.id
}

// Seq là seq của khối output kế tiếp: sự kiện mang seq này để trang phát lại đặt nó đúng chỗ trong output.
func (s *RecordedSession) Seq() int64 {
	if s == nil {
		return 0
	}
	s.r.mu.Lock()
	defer s.r.mu.Unlock()
	return s.nextSeq
}

// SetController đổi người điều khiển trong term_state: ControllerLocal, ControllerRemote, rỗng là không ai.
func (s *RecordedSession) SetController(who string) {
	if s == nil {
		return
	}
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.controller == who {
		return
	}
	s.controller = who
	r.dirty = true
	r.signal()
}

// Write nhận output đã che bí mật. Không chặn: chỉ chép vào bộ nhớ, ghi đĩa và gửi do vòng gửi làm.
func (s *RecordedSession) Write(b []byte) {
	if s == nil || len(b) == 0 {
		return
	}
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.dropped || s.exit != nil {
		return
	}
	s.buf = append(s.buf, b...)
	if len(s.buf) >= r.chunkBytes() {
		r.signal()
		return
	}
	if s.timer == nil {
		s.timer = time.AfterFunc(orDefault(r.Flush, DefaultRecordFlush), r.signal)
	}
}

// Close báo phiên đã kết thúc; reason là lý do của phiên tại máy, đổi sang lý do của hợp đồng.
func (s *RecordedSession) Close(code *int, reason, message string) {
	s.CloseBy(code, reason, message, "")
}

// CloseBy như Close, kèm người ngắt (userId của hub hoặc "machine"); rỗng là "machine".
func (s *RecordedSession) CloseBy(code *int, reason, message, by string) {
	if s == nil {
		return
	}
	r := s.r
	r.mu.Lock()
	defer r.mu.Unlock()
	if s.exit != nil {
		return
	}
	if by == "" {
		by = byMachine
	}
	e := Exit{SessionID: s.id, ExitCode: code, Reason: reason, Message: clip(message, 500), By: clip(by, 64)}
	if reason != ReasonExit && reason != ReasonIdle {
		e.Reason = ReasonClosed
	}
	s.exit = &e
	r.dirty = true
	r.signal()
}

func (r *Recorder) chunkBytes() int { return orDefault(r.ChunkBytes, DefaultRecordChunk) }

// flushLocked chuyển output đang gom vào đệm đĩa, mỗi khối tối đa chunkBytes.
func (r *Recorder) flushLocked(s *RecordedSession) {
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	limit := int64(DefaultPendingBytes)
	if r.MaxPending > 0 {
		limit = r.MaxPending
	}
	for len(s.buf) > 0 && !s.dropped {
		n := min(len(s.buf), r.chunkBytes())
		data := s.buf[:n]
		seq := s.nextSeq
		s.nextSeq++
		if s.pending+int64(n) > limit {
			if s.gapFrom < 0 {
				s.gapFrom = seq
			}
			s.gapTo = seq
		} else if _, err := s.file.WriteAt(data, s.size); err != nil {
			r.log().Warn("Không ghi được đệm phiên; thôi ghi phiên này lên hub", "session", s.id, "error", err)
			r.dropLocked(s)
		} else {
			s.chunks = append(s.chunks, recChunk{seq: seq, off: s.size, n: n})
			s.size += int64(n)
			s.pending += int64(n)
		}
		s.buf = s.buf[n:]
	}
	s.buf = nil
}

func (r *Recorder) dropLocked(s *RecordedSession) {
	s.dropped = true
	s.chunks, s.buf, s.pending = nil, nil, 0
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if s.file != nil {
		_ = s.file.Close()
		_ = os.Remove(s.file.Name())
		s.file = nil
	}
}

// Close đóng và xoá mọi file đệm còn mở. Windows không xoá được file đang mở, nên thư mục đệm chỉ dọn được sau khi gọi
// hàm này; ở các nền tảng khác nó chỉ bỏ sớm những file mà lần chạy sau cũng sẽ xoá.
func (r *Recorder) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.sessions {
		r.dropLocked(s)
	}
	r.sessions = nil
}

// removeLocked bỏ phiên đã gửi xong (exit đã gửi, mọi output đã ack).
func (r *Recorder) removeDoneLocked() {
	kept := r.sessions[:0]
	for _, s := range r.sessions {
		if s.dropped || (s.exitSent && len(s.chunks) == 0 && len(s.buf) == 0) {
			r.dropLocked(s)
			r.dirty = true
			continue
		}
		kept = append(kept, s)
	}
	r.sessions = kept
}

type recItem struct {
	send func(Sender) error
	done func()
}

func (r *Recorder) loop() {
	for range r.wake {
		for r.pass() {
		}
	}
}

// pass gửi một lượt; true khi còn việc (lượt bị cắt theo sendBatch).
func (r *Recorder) pass() bool {
	r.mu.Lock()
	link := r.link
	if link == nil || !link.Enabled() {
		for _, s := range r.sessions {
			r.flushLocked(s)
		}
		r.mu.Unlock()
		return false
	}
	resync := r.resync
	r.resync = false
	if resync {
		for _, s := range r.sessions {
			s.sent, s.openedSent, s.exitSent = -1, false, false
		}
	}
	var items []recItem
	budget := sendBatch
	more := false
	for _, s := range r.sessions {
		r.flushLocked(s)
		if s.dropped {
			continue
		}
		if !s.openedSent {
			o := s.opened
			items = append(items, recItem{send: func(l Sender) error { return l.Opened(o) }, done: func() { s.openedSent = true }})
		}
		for _, c := range s.chunks {
			if c.seq <= s.sent {
				continue
			}
			if budget <= 0 {
				more = true
				break
			}
			data := make([]byte, c.n)
			if _, err := s.file.ReadAt(data, c.off); err != nil {
				r.log().Warn("Không đọc được đệm phiên; thôi ghi phiên này lên hub", "session", s.id, "error", err)
				r.dropLocked(s)
				break
			}
			budget -= c.n
			id, seq := s.id, c.seq
			items = append(items, recItem{send: func(l Sender) error { return l.Output(id, seq, data) },
				done: func() { s.sent = max(s.sent, seq) }})
		}
		if s.dropped {
			continue
		}
		if s.gapFrom >= 0 {
			from, to := s.gapFrom, s.gapTo
			data, _ := json.Marshal(map[string]int64{"from": from, "to": to})
			items = append(items, recItem{send: func(l Sender) error {
				return l.Event(SessionEvent{SessionID: s.id, Seq: from, Event: "gap", Data: data})
			}, done: func() {
				if s.gapFrom == from {
					s.gapFrom = -1
				}
			}})
		}
		if s.exit != nil && !s.exitSent && !more {
			e := *s.exit
			items = append(items, recItem{send: func(l Sender) error { return l.Exit(e) }, done: func() { s.exitSent = true }})
		}
	}
	if resync || r.dirty {
		r.dirty = false
		st := r.stateLocked()
		items = append(items, recItem{send: func(l Sender) error { return l.State(st) }})
	}
	r.mu.Unlock()

	for _, it := range items {
		if err := it.send(link); err != nil {
			// Kết nối đã đứt: welcome kế tiếp đặt resync và gửi bù mọi thứ chưa ack.
			return false
		}
		if it.done != nil {
			r.mu.Lock()
			it.done()
			r.mu.Unlock()
		}
	}
	r.mu.Lock()
	r.removeDoneLocked()
	r.mu.Unlock()
	return more
}

func (r *Recorder) stateLocked() State {
	var st State
	switch {
	case r.BaseState != nil:
		st = r.BaseState()
	case r.Remote != nil:
		st = r.Remote.State()
	}
	st.Sessions = nil
	for _, s := range r.sessions {
		// Phiên đã báo kết thúc thì không còn trên máy, để hub kết thúc nếu chưa nhận term_exit.
		if !s.dropped && s.exit == nil {
			ss := StateSession{ID: s.id, Origin: s.opened.Origin}
			if s.controller != "" {
				who := s.controller
				ss.Controller = &who
			}
			st.Sessions = append(st.Sessions, ss)
		}
	}
	return st
}

// OnWelcome: hub khai "terminal" và máy không dùng chung thì ghi và gửi bù; không thì bỏ mọi đệm và thôi ghi.
func (r *Recorder) OnWelcome(info WelcomeInfo, send Sender) {
	r.init()
	if r.Remote != nil {
		r.Remote.OnChange(r.StateChanged)
		r.Remote.OnWelcome(info)
	}
	r.Controller.onWelcome(info)
	r.mu.Lock()
	r.off = !info.Terminal || (info.Owner != nil && info.Owner.Shared)
	if r.off {
		for _, s := range r.sessions {
			r.dropLocked(s)
		}
		r.sessions = nil
		r.link = nil
	} else {
		r.link = send
		r.resync = true
	}
	r.mu.Unlock()
	r.signal()
}

// StateChanged gửi term_state mới ở lượt gửi kế tiếp (bật/tắt, thư mục, thiết bị đổi tại máy).
func (r *Recorder) StateChanged() {
	r.init()
	r.mu.Lock()
	r.dirty = true
	r.mu.Unlock()
	r.signal()
}

func (r *Recorder) OnDisconnect() {
	r.mu.Lock()
	r.link = nil
	r.mu.Unlock()
	r.Controller.onDisconnect()
}

// sender là kết nối hub hiện tại; nil khi mất hub hay hub không nhận phiên.
func (r *Recorder) sender() Sender {
	if r == nil {
		return nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.link
}

// Ack xoá đệm tới Upto; hết đệm thì cắt file về 0 để file không lớn dần theo đời phiên.
func (r *Recorder) Ack(a AckRequest) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, s := range r.sessions {
		if s.id != a.SessionID || s.dropped {
			continue
		}
		i := 0
		for i < len(s.chunks) && s.chunks[i].seq <= a.Upto {
			s.pending -= int64(s.chunks[i].n)
			i++
		}
		s.chunks = s.chunks[i:]
		if len(s.chunks) == 0 && s.file != nil {
			_ = s.file.Truncate(0)
			s.size = 0
		} else if s.file != nil {
			r.compactLocked(s)
		}
		if s.exitSent && len(s.chunks) == 0 {
			r.removeDoneLocked()
		}
		return
	}
}

// compactLocked dời phần chưa ack về đầu file. Phiên in liên tục luôn có khối đang chờ ack nên file ít khi rỗng để cắt;
// chỉ dời khi phần đã ack lớn hơn phần còn lại để mỗi byte chỉ bị chép một số lần nhỏ.
func (r *Recorder) compactLocked(s *RecordedSession) {
	head := s.chunks[0].off
	if head < compactMin || head < s.pending {
		return
	}
	data := make([]byte, s.size-head)
	if _, err := s.file.ReadAt(data, head); err != nil {
		r.log().Warn("Không đọc được đệm phiên; thôi ghi phiên này lên hub", "session", s.id, "error", err)
		r.dropLocked(s)
		return
	}
	if _, err := s.file.WriteAt(data, 0); err != nil {
		r.log().Warn("Không ghi được đệm phiên; thôi ghi phiên này lên hub", "session", s.id, "error", err)
		r.dropLocked(s)
		return
	}
	_ = s.file.Truncate(int64(len(data)))
	for i := range s.chunks {
		s.chunks[i].off -= head
	}
	s.size -= head
}

// Điều khiển từ xa chưa bật trên máy này: trả lời như máy đang tắt từ xa để hub báo đúng lý do (FR-012).

func (r *Recorder) Start(req StartRequest) {
	r.reply(func(l Sender) error {
		return l.Denied(Denied{RequestID: req.RequestID, Code: "REMOTE_DISABLED", Reason: remoteDisabledText})
	})
}

func (r *Recorder) Control(req ControlRequest) {
	if r.Controller != nil {
		r.Controller.Control(req)
		return
	}
	r.reply(func(l Sender) error {
		return l.Revoked(Revoked{SessionID: req.SessionID, ConnID: req.ConnID, Reason: "disabled"})
	})
}

func (r *Recorder) Pair(req PairRequest) {
	if r.Remote == nil {
		r.reply(func(l Sender) error { return l.PairResult(PairResult{PairID: req.PairID, Reason: pairDisabled}) })
		return
	}
	// Chờ người ở máy bấm Cho phép tới 50 giây: không được chặn vòng đọc của kênh. Gửi kết quả qua kết nối lúc trả lời,
	// vì kết nối lúc nhận có thể đã đứt.
	go func() {
		res := r.Remote.HandlePair(req)
		r.mu.Lock()
		link := r.link
		r.mu.Unlock()
		if link != nil {
			_ = link.PairResult(res)
		}
	}()
}

func (r *Recorder) Disable(req DisableRequest) {
	if r.Remote != nil {
		go r.Remote.HubDisable(req)
	}
}

func (r *Recorder) DeviceRevoke(req DeviceRevokeRequest) {
	if r.Remote != nil {
		go r.Remote.HubDeviceRevoke(req)
	}
}

func (r *Recorder) Detach(req DetachRequest) {
	if r.Controller != nil {
		r.Controller.Detach(req)
	}
}

func (r *Recorder) Input(req InputRequest) {
	if r.Controller != nil {
		r.Controller.Input(req)
	}
}

func (r *Recorder) Resize(req ResizeRequest) {
	if r.Controller != nil {
		r.Controller.Resize(req)
	}
}

const remoteDisabledText = "Máy chưa bật điều khiển từ xa. Chủ máy bật tại máy (app hoặc `hive remote on`)."

// reply gửi ngoài vòng đọc của kênh (Handler phải trả về nhanh).
func (r *Recorder) reply(fn func(Sender) error) {
	r.mu.Lock()
	link := r.link
	r.mu.Unlock()
	if link == nil {
		return
	}
	go func() { _ = fn(link) }()
}
