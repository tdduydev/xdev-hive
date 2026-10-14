package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

// syncBuffer: stdout/stderr được ghi từ goroutine của phiên trong khi test đọc.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type fakeConsole struct {
	tty      bool
	rawErr   error
	raw      int
	restored int
	mu       sync.Mutex
}

func (f *fakeConsole) IsTerminal() bool { return f.tty }

func (f *fakeConsole) MakeRaw() (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.rawErr != nil {
		return nil, f.rawErr
	}
	f.raw++
	return func() { f.mu.Lock(); f.restored++; f.mu.Unlock() }, nil
}

func (f *fakeConsole) Size() (int, int, bool) { return 120, 40, true }

type testApp struct {
	*app
	out, err *syncBuffer
	con      *fakeConsole
}

func newTestApp(socket string, stdin io.Reader) *testApp {
	out, errb := &syncBuffer{}, &syncBuffer{}
	con := &fakeConsole{}
	if stdin == nil {
		stdin = strings.NewReader("")
	}
	a := &app{
		stdin: stdin, stdout: out, stderr: errb, console: con,
		signals: func() (<-chan os.Signal, <-chan os.Signal, func()) { return nil, nil, func() {} },
		getenv:  func(k string) string { return map[string]string{"TERM": "xterm-test"}[k] },
		getwd:   os.Getwd,
		socket:  func() (string, error) { return socket, nil },
	}
	return &testApp{app: a, out: out, err: errb, con: con}
}

func TestUsageAndUnsupported(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "khong-co.sock")
	for _, tt := range []struct {
		args []string
		code int
		msg  string
	}{
		{nil, exitUsage, "Cách dùng"},
		{[]string{"lam-gi"}, exitUsage, `không có lệnh "lam-gi"`},
		{[]string{"login"}, exitUsage, "chưa hỗ trợ"},
		{[]string{"whoami"}, exitUsage, "chưa hỗ trợ"},
		{[]string{"__hook", "attention"}, exitUsage, "chưa hỗ trợ"},
		{[]string{"chat", "--task", "PAY-12"}, exitUsage, "--task và --project chưa hỗ trợ"},
		{[]string{"chat", "--project", "PAY"}, exitUsage, "chưa hỗ trợ"},
		{[]string{"chat", "--cli", "bash"}, exitUsage, `CLI "bash" không hỗ trợ`},
		{[]string{"chat", "thua"}, exitUsage, "Thừa đối số"},
		{[]string{"chat", "--khong-co-co"}, exitUsage, "flag provided but not defined"},
		{[]string{"run"}, exitUsage, "Thiếu lời nhắc"},
		{[]string{"run", "  "}, exitUsage, "Thiếu lời nhắc"},
		{[]string{"ls", "--all"}, exitUsage, "--all chưa hỗ trợ"},
		{[]string{"attach"}, exitUsage, "hive attach <id>"},
		{[]string{"kill"}, exitUsage, "hive kill <id>"},
	} {
		a := newTestApp(missing, nil)
		if code := a.run(tt.args); code != tt.code || !strings.Contains(a.err.String(), tt.msg) {
			t.Errorf("%v: mã %d, stderr %q", tt.args, code, a.err.String())
		}
	}
}

func TestWorkerMissing(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "khong-co.sock")
	want := msgNotRunning
	if runtime.GOOS == "windows" {
		want = "chưa hỗ trợ trên Windows"
	}
	for _, args := range [][]string{{"chat"}, {"run", "sửa lỗi"}, {"ls"}, {"attach", "abc"}, {"kill", "abc"}, {"version"}} {
		a := newTestApp(missing, nil)
		if code := a.run(args); code != exitUsage || !strings.Contains(a.err.String(), want) {
			t.Errorf("%v: mã %d, stderr %q", args, code, a.err.String())
		}
	}
}

func TestParseChat(t *testing.T) {
	a := newTestApp("", nil)
	o, code := a.parseChat([]string{"sửa lỗi đăng nhập", "--cli", "codex", "--model", "gpt-5", "--force", "--account", "codex-2", "--", "--search"}, true)
	if code != exitOK {
		t.Fatalf("mã %d: %s", code, a.err.String())
	}
	if o.cli != "codex" || o.model != "gpt-5" || !o.force || o.account != "codex-2" || o.prompt != "sửa lỗi đăng nhập" ||
		!slices.Equal(o.extra, []string{"--search"}) {
		t.Fatalf("o = %+v", o)
	}
	if o, code := a.parseChat([]string{"--no-record", "--no-remote"}, false); code != exitOK || o.cli != "claude" || !o.noRecord {
		t.Fatalf("mặc định: %+v %d", o, code)
	}
}

func TestCLIArgs(t *testing.T) {
	for _, tt := range []struct {
		o    chatOptions
		want []string
	}{
		{chatOptions{cli: "claude"}, nil},
		{chatOptions{cli: "claude", model: "opus", prompt: "viết test"}, []string{"--model", "opus", "viết test"}},
		{chatOptions{cli: "codex", prompt: "-v có nghĩa gì", extra: []string{"--search"}}, []string{"--search", "--", "-v có nghĩa gì"}},
		{chatOptions{cli: "gemini", model: "gemini-2.5-pro", prompt: "giải thích repo"}, []string{"--model", "gemini-2.5-pro", "--prompt-interactive=giải thích repo"}},
	} {
		if got := cliArgs(tt.o); !slices.Equal(got, tt.want) {
			t.Errorf("%+v: %q, muốn %q", tt.o, got, tt.want)
		}
	}
}

func TestEscaper(t *testing.T) {
	var e escaper
	out, acts := e.feed([]byte("ab\x1d"))
	if string(out) != "ab" || len(acts) != 0 || !e.pending {
		t.Fatalf("1: %q %q", out, acts)
	}
	// Phím thứ hai tới ở lần đọc sau.
	out, acts = e.feed([]byte("tc\x1d\x1dx\x1dqy\x1ddzz"))
	if string(out) != "c\x1dx\x1dqy" || string(acts) != "td" {
		t.Fatalf("2: %q %q", out, acts)
	}
}

func TestRemoteExitCodes(t *testing.T) {
	for code, want := range map[string]int{
		localipc.CodeDenied: exitDenied, localipc.CodeBadRequest: exitUsage, localipc.CodeUnsupported: exitUsage,
		localipc.CodeNotFound: exitFailed, localipc.CodeBusy: exitFailed, localipc.CodeFailed: exitFailed,
	} {
		a := newTestApp("", nil)
		if got := a.fail(&localipc.RemoteError{Code: code, Message: "x"}); got != want {
			t.Errorf("%s: %d, muốn %d", code, got, want)
		}
	}
	a := newTestApp("", nil)
	if got := a.fail(fmt.Errorf("bọc: %w", localipc.ErrDenied)); got != exitDenied {
		t.Fatalf("bị từ chối: %d", got)
	}
	if got := a.fail(&localipc.VersionError{Want: 1, Got: 2}); got != exitUsage || !strings.Contains(a.err.String(), "hive-worker update") {
		t.Fatalf("lệch phiên bản: %d %q", got, a.err.String())
	}
}

// fakeSession đóng vai worker sau khi gắn: gửi khung theo script trên một đầu net.Pipe.
func fakeSession(t *testing.T, script func(w *localipc.Conn)) *localipc.Conn {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() { _ = client.Close(); _ = server.Close() })
	w := localipc.NewConn(server)
	go func() {
		// Đọc bỏ khung của client để ghi của client không bị chặn trên pipe.
		go func() {
			for {
				if _, _, err := w.ReadFrame(); err != nil {
					return
				}
			}
		}()
		script(w)
	}()
	return localipc.NewConn(client)
}

func TestInteractRestoresTerminal(t *testing.T) {
	code7 := 7
	stdinR, stdinW := io.Pipe()
	defer stdinW.Close()
	a := newTestApp("", stdinR)
	a.con.tty = true
	c := fakeSession(t, func(w *localipc.Conn) {
		_ = w.WriteFrame(localipc.FrameOut, []byte("xin chào"))
		_ = w.WriteCtl(localipc.Ctl{Type: localipc.CtlExit, Reason: "exit", Code: &code7})
	})
	if code := a.interact(c, "abc", modeControl); code != exitFailed {
		t.Fatalf("mã %d", code)
	}
	if a.con.raw != 1 || a.con.restored != 1 {
		t.Fatalf("raw %d, restore %d", a.con.raw, a.con.restored)
	}
	if a.out.String() != "xin chào" || !strings.Contains(a.err.String(), "mã 7") {
		t.Fatalf("out %q err %q", a.out.String(), a.err.String())
	}

	// Mất kết nối giữa chừng: vẫn trả terminal.
	b := newTestApp("", stdinR)
	b.con.tty = true
	c = fakeSession(t, func(w *localipc.Conn) { _ = w.Close() })
	if code := b.interact(c, "abc", modeControl); code != exitFailed || b.con.restored != 1 || !strings.Contains(b.err.String(), "Mất kết nối") {
		t.Fatalf("mất kết nối: mã %d restore %d err %q", code, b.con.restored, b.err.String())
	}

	// Không đặt được raw: báo lỗi, không gửi gì.
	r := newTestApp("", stdinR)
	r.con.tty = true
	r.con.rawErr = errors.New("không phải tty")
	if code := r.interact(c, "abc", modeControl); code != exitFailed || !strings.Contains(r.err.String(), "chế độ raw") {
		t.Fatalf("raw lỗi: %d %q", code, r.err.String())
	}
}

func TestInteractDetachSendsCtl(t *testing.T) {
	got := make(chan localipc.Ctl, 4)
	client, server := net.Pipe()
	defer client.Close()
	w := localipc.NewConn(server)
	go func() {
		for {
			typ, data, err := w.ReadFrame()
			if err != nil {
				return
			}
			if typ == localipc.FrameCtl {
				var ctl localipc.Ctl
				_ = json.Unmarshal(data, &ctl)
				got <- ctl
			}
		}
	}()
	a := newTestApp("", strings.NewReader("ls\r\x1dt\x1dd"))
	if code := a.interact(localipc.NewConn(client), "abc", modeView); code != exitOK {
		t.Fatalf("mã %d: %s", code, a.err.String())
	}
	if (<-got).Type != localipc.CtlTake || (<-got).Type != localipc.CtlDetach {
		t.Fatal("phải gửi take rồi detach")
	}
	if !strings.Contains(a.err.String(), "hive attach abc") {
		t.Fatalf("thiếu chỉ dẫn gắn lại: %q", a.err.String())
	}
}
