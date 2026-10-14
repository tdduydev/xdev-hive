package terminal

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// fakeLink là Sender giả của một phiên kênh; broken giả kết nối đứt (mọi gói trả lỗi).
type fakeLink struct {
	mu      sync.Mutex
	broken  bool
	opened  []Opened
	outputs map[string][]recOut
	exits   []Exit
	events  []SessionEvent
	states  []State
	denied  []Denied
	pairs   []PairResult
}

type recOut struct {
	seq  int64
	data []byte
}

var errBroken = errors.New("kết nối đã đứt")

func newFakeLink() *fakeLink { return &fakeLink{outputs: map[string][]recOut{}} }

func (f *fakeLink) Enabled() bool { return true }

func (f *fakeLink) do(fn func()) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.broken {
		return errBroken
	}
	fn()
	return nil
}

func (f *fakeLink) State(s State) error   { return f.do(func() { f.states = append(f.states, s) }) }
func (f *fakeLink) Denied(d Denied) error { return f.do(func() { f.denied = append(f.denied, d) }) }
func (f *fakeLink) Opened(o Opened) error { return f.do(func() { f.opened = append(f.opened, o) }) }
func (f *fakeLink) Output(id string, seq int64, data []byte) error {
	return f.do(func() { f.outputs[id] = append(f.outputs[id], recOut{seq, bytes.Clone(data)}) })
}
func (f *fakeLink) Exit(e Exit) error { return f.do(func() { f.exits = append(f.exits, e) }) }
func (f *fakeLink) Event(e SessionEvent) error {
	return f.do(func() { f.events = append(f.events, e) })
}
func (f *fakeLink) Granted(Granted) error { return nil }
func (f *fakeLink) Revoked(Revoked) error { return nil }
func (f *fakeLink) PairResult(p PairResult) error {
	return f.do(func() { f.pairs = append(f.pairs, p) })
}
func (f *fakeLink) snapshot(fn func(f *fakeLink)) {
	f.mu.Lock()
	defer f.mu.Unlock()
	fn(f)
}

// joined ghép output đã nhận theo seq, bỏ bản gửi lại trùng như hub (khoá chính session, seq).
func (f *fakeLink) joined(id string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	seen := map[int64]bool{}
	var b []byte
	for _, o := range f.outputs[id] {
		if !seen[o.seq] {
			seen[o.seq] = true
			b = append(b, o.data...)
		}
	}
	return string(b)
}

func waitRec(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("hết giờ chờ: %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func newRecorder(t *testing.T) *Recorder {
	t.Helper()
	r := &Recorder{Dir: filepath.Join(t.TempDir(), "terminal"), Flush: time.Millisecond}
	// Cleanup chạy ngược thứ tự đăng ký nên Close đóng file đệm trước khi TempDir xoá; Windows không xoá được file đang mở.
	t.Cleanup(r.Close)
	return r
}

func personal() WelcomeInfo {
	return WelcomeInfo{Features: []string{"terminal"}, Terminal: true, Owner: &WelcomeOwner{UserID: "u1"}}
}

func pendingFiles(t *testing.T, r *Recorder) []string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(r.Dir, "*.pending"))
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func TestRecorderOpenOutputExitAck(t *testing.T) {
	r := newRecorder(t)
	link := newFakeLink()
	r.OnWelcome(personal(), link)
	s := r.Open(RecordOpen{CLI: "claude", Cwd: "/Users/an/work/xdev/app", AccountLabel: "Gói 1", ProjectID: "p1",
		TaskID: string(bytes.Repeat([]byte("x"), 65)), Cols: 1000, Rows: 1})
	if s.ID() == "" {
		t.Fatal("phiên phải được ghi")
	}
	s.Write([]byte("xin "))
	s.Write([]byte("chao"))
	waitRec(t, "output", func() bool { return link.joined(s.ID()) == "xin chao" })
	code := 3
	s.Close(&code, ReasonExit, "")
	waitRec(t, "exit", func() bool {
		n := 0
		link.snapshot(func(f *fakeLink) { n = len(f.exits) })
		return n == 1
	})
	link.snapshot(func(f *fakeLink) {
		o := f.opened[0]
		if o.SessionID != s.ID() || o.Origin != "local" || o.CLI != "claude" || o.CwdLabel != "xdev/app" || o.ProjectID != "p1" ||
			o.TaskID != "" || o.Cols != maxCols || o.Rows != minRows || *o.AccountLabel != "Gói 1" || !*o.Record || *o.Remote {
			t.Fatalf("opened = %+v", o)
		}
		e := f.exits[0]
		if e.SessionID != s.ID() || e.Reason != ReasonExit || *e.ExitCode != 3 || e.By != "machine" {
			t.Fatalf("exit = %+v", e)
		}
		last := f.states[len(f.states)-1]
		if len(last.Sessions) != 0 {
			t.Fatalf("phiên đã kết thúc không còn trong state: %+v", last.Sessions)
		}
	})
	if len(pendingFiles(t, r)) != 1 {
		t.Fatal("đệm phải còn tới khi hub ack")
	}
	link.snapshot(func(f *fakeLink) {
		for _, o := range f.outputs[s.ID()] {
			r.Ack(AckRequest{SessionID: s.ID(), Upto: o.seq})
		}
	})
	waitRec(t, "xoá đệm sau ack", func() bool { return len(pendingFiles(t, r)) == 0 })
}

func TestRecorderChunksAtLimit(t *testing.T) {
	r := newRecorder(t)
	r.ChunkBytes = 4
	r.Flush = time.Hour
	link := newFakeLink()
	r.OnWelcome(personal(), link)
	s := r.Open(RecordOpen{CLI: "claude", Cols: 80, Rows: 24})
	s.Write([]byte("abcdefghij"))
	waitRec(t, "đủ khối", func() bool { return len(link.joined(s.ID())) >= 8 })
	s.Close(nil, ReasonClosed, "đóng")
	waitRec(t, "phần còn lại", func() bool { return link.joined(s.ID()) == "abcdefghij" })
	link.snapshot(func(f *fakeLink) {
		for i, o := range f.outputs[s.ID()] {
			if o.seq != int64(i) || len(o.data) > 4 {
				t.Fatalf("khối %d = seq %d, %d byte", i, o.seq, len(o.data))
			}
		}
	})
}

// Mất hub: output vẫn vào đệm; welcome kế tiếp gửi lại term_opened và mọi khối chưa ack.
func TestRecorderResendsAfterReconnect(t *testing.T) {
	r := newRecorder(t)
	first := newFakeLink()
	r.OnWelcome(personal(), first)
	s := r.Open(RecordOpen{CLI: "claude", Cols: 80, Rows: 24})
	s.Write([]byte("mot "))
	waitRec(t, "gói đầu", func() bool { return first.joined(s.ID()) == "mot " })
	first.snapshot(func(f *fakeLink) { f.broken = true })
	r.OnDisconnect()
	s.Write([]byte("hai "))
	s.Write([]byte("ba"))
	time.Sleep(20 * time.Millisecond)

	second := newFakeLink()
	r.OnWelcome(personal(), second)
	waitRec(t, "gửi bù", func() bool { return second.joined(s.ID()) == "mot hai ba" })
	second.snapshot(func(f *fakeLink) {
		if len(f.opened) != 1 || f.opened[0].SessionID != s.ID() {
			t.Fatalf("phải gửi lại term_opened: %+v", f.opened)
		}
		last := f.states[len(f.states)-1]
		if len(last.Sessions) != 1 || last.Sessions[0].ID != s.ID() || last.Sessions[0].Origin != "local" {
			t.Fatalf("state = %+v", last.Sessions)
		}
	})
	r.Ack(AckRequest{SessionID: s.ID(), Upto: 0})
	third := newFakeLink()
	r.OnWelcome(personal(), third)
	waitRec(t, "chỉ gửi phần chưa ack", func() bool { return third.joined(s.ID()) == "hai ba" })
}

// Máy dùng chung, hub không khai terminal: bỏ đệm và không ghi phiên mới (D13, SC-010).
func TestRecorderOffForSharedOrOldHub(t *testing.T) {
	for name, info := range map[string]WelcomeInfo{
		"shared": {Features: []string{"terminal"}, Terminal: true, Owner: &WelcomeOwner{UserID: "u1", Shared: true}},
		"oldHub": {},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRecorder(t)
			s := r.Open(RecordOpen{CLI: "claude", Cols: 80, Rows: 24})
			s.Write([]byte("truoc welcome"))
			link := newFakeLink()
			r.OnWelcome(info, link)
			waitRec(t, "bỏ đệm", func() bool { return len(pendingFiles(t, r)) == 0 })
			s.Write([]byte("sau"))
			if r.Open(RecordOpen{CLI: "claude"}) != nil {
				t.Fatal("không ghi phiên mới")
			}
			time.Sleep(20 * time.Millisecond)
			link.snapshot(func(f *fakeLink) {
				if len(f.opened)+len(f.outputs)+len(f.states) != 0 {
					t.Fatalf("không được gửi gì: %+v", f)
				}
			})
		})
	}
}

// Quá đệm chưa ack: bỏ output và báo `gap` một lần cho cả đoạn thiếu.
func TestRecorderGapWhenPendingFull(t *testing.T) {
	r := newRecorder(t)
	r.MaxPending = 4
	r.ChunkBytes = 4
	s := r.Open(RecordOpen{CLI: "claude", Cols: 80, Rows: 24})
	s.Write([]byte("abcdefghijkl"))
	time.Sleep(20 * time.Millisecond)
	link := newFakeLink()
	r.OnWelcome(personal(), link)
	waitRec(t, "gap", func() bool {
		n := 0
		link.snapshot(func(f *fakeLink) { n = len(f.events) })
		return n == 1
	})
	link.snapshot(func(f *fakeLink) {
		e := f.events[0]
		if e.Event != "gap" || e.Seq != 1 || string(e.Data) != `{"from":1,"to":2}` {
			t.Fatalf("event = %+v %s", e, e.Data)
		}
	})
	if got := link.joined(s.ID()); got != "abcd" {
		t.Fatalf("output = %q", got)
	}
}

// Phiên in liên tục không bao giờ hết đệm: phần đã ack bị dời đi để file không lớn theo đời phiên.
func TestRecorderCompactsAckedPrefix(t *testing.T) {
	old := compactMin
	compactMin = 8
	t.Cleanup(func() { compactMin = old })
	r := newRecorder(t)
	r.ChunkBytes = 4
	r.Flush = time.Hour
	link := newFakeLink()
	r.OnWelcome(personal(), link)
	s := r.Open(RecordOpen{CLI: "claude", Cols: 80, Rows: 24})
	s.Write([]byte("aaaabbbbccccdddd"))
	waitRec(t, "gửi hết", func() bool { return len(link.joined(s.ID())) == 16 })
	r.Ack(AckRequest{SessionID: s.ID(), Upto: 2})
	files := pendingFiles(t, r)
	if len(files) != 1 {
		t.Fatalf("đệm = %v", files)
	}
	b, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "dddd" {
		t.Fatalf("đệm sau khi dời = %q", b)
	}
	// Nối lại phải gửi đúng khối còn lại từ vị trí mới.
	again := newFakeLink()
	r.OnWelcome(personal(), again)
	waitRec(t, "gửi bù sau khi dời", func() bool { return again.joined(s.ID()) == "dddd" })
	again.snapshot(func(f *fakeLink) {
		if o := f.outputs[s.ID()]; len(o) != 1 || o[0].seq != 3 {
			t.Fatalf("outputs = %+v", o)
		}
	})
}

func TestRecorderStartupClearsOldPending(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "terminal")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "cu.pending")
	if err := os.WriteFile(stale, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	r := &Recorder{Dir: dir}
	r.OnWelcome(personal(), newFakeLink())
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("đệm cũ phải bị xoá: %v", err)
	}
}

// Điều khiển từ xa chưa bật: hub nhận lý do rõ ràng thay vì chờ hết giờ.
func TestRecorderDeniesRemote(t *testing.T) {
	r := newRecorder(t)
	link := newFakeLink()
	r.OnWelcome(personal(), link)
	r.Start(StartRequest{RequestID: "rq"})
	r.Pair(PairRequest{PairID: "pr"})
	waitRec(t, "từ chối", func() bool {
		ok := false
		link.snapshot(func(f *fakeLink) { ok = len(f.denied) == 1 && len(f.pairs) == 1 })
		return ok
	})
	link.snapshot(func(f *fakeLink) {
		if f.denied[0].RequestID != "rq" || f.denied[0].Code != "REMOTE_DISABLED" || f.pairs[0].OK || f.pairs[0].Reason != "disabled" {
			t.Fatalf("denied = %+v, pair = %+v", f.denied, f.pairs)
		}
	})
}

func TestRecorderNilIsNoop(t *testing.T) {
	var r *Recorder
	s := r.Open(RecordOpen{CLI: "claude"})
	s.Write([]byte("x"))
	s.Close(nil, ReasonExit, "")
	if s.ID() != "" {
		t.Fatal("Recorder nil không ghi")
	}
}
