//go:build !windows

package terminal

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

// fakeCLI in đối số, biến môi trường (để kiểm che bí mật và bỏ HIVE_*), rồi trả lời từng dòng; "quit" thoát mã 7.
const fakeCLI = `#!/bin/sh
echo "READY $*"
echo "tok=${CLAUDE_CODE_OAUTH_TOKEN:-none} hive=${HIVE_FAKE_SECRET:-none} term=$TERM"
while IFS= read -r line; do
  [ "$line" = "quit" ] && exit 7
  echo "got:$line"
done
`

func shortDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "ht")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

// startLocal chạy Local sau một socket nội bộ thật; trả đường dẫn socket.
func startLocal(t *testing.T, l *Local) string {
	t.Helper()
	dir := shortDir(t)
	script := filepath.Join(dir, "fake.sh")
	if err := os.WriteFile(script, []byte(fakeCLI), 0o700); err != nil {
		t.Fatal(err)
	}
	if l.Commands == nil {
		l.Commands = map[string]runner.Command{"claude": {Path: script, Args: []string{"{{prompt}}"}}, "codex": {Path: script}}
	}
	if l.KillGrace == 0 {
		l.KillGrace = 500 * time.Millisecond
	}
	path := filepath.Join(dir, "run", "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = (&localipc.Server{Worker: "test", Handler: l.Handle}).Serve(ctx, ln)
		close(done)
	}()
	t.Cleanup(func() {
		l.CloseAll("test xong")
		if !l.Wait(10 * time.Second) {
			t.Error("phiên không dừng")
		}
		cancel()
		<-done
	})
	return path
}

func dial(t *testing.T, path string) *localipc.Conn {
	t.Helper()
	c, _, err := localipc.Dial(path, "hive/test")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// tclient gom output và khung điều khiển của một client đã gắn.
type tclient struct {
	c    *localipc.Conn
	mu   sync.Mutex
	out  bytes.Buffer
	ctls []localipc.Ctl
	done chan struct{}
}

func gate(t *testing.T, path string, req map[string]any) (*tclient, map[string]any) {
	t.Helper()
	c := dial(t, path)
	var resp map[string]any
	if err := c.Call(req, &resp); err != nil {
		t.Fatalf("%v: %v", req["op"], err)
	}
	tc := &tclient{c: c, done: make(chan struct{})}
	go func() {
		defer close(tc.done)
		for {
			typ, data, err := c.ReadFrame()
			if err != nil {
				return
			}
			tc.mu.Lock()
			switch typ {
			case localipc.FrameOut:
				tc.out.Write(data)
			case localipc.FrameCtl:
				var ctl localipc.Ctl
				_ = json.Unmarshal(data, &ctl)
				tc.ctls = append(tc.ctls, ctl)
			}
			tc.mu.Unlock()
		}
	}()
	return tc, resp
}

func (tc *tclient) output() string {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	return tc.out.String()
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("hết giờ chờ %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (tc *tclient) waitOut(t *testing.T, s string) {
	t.Helper()
	eventually(t, "output "+s, func() bool { return strings.Contains(tc.output(), s) })
}

func (tc *tclient) waitCtl(t *testing.T, typ string) localipc.Ctl {
	t.Helper()
	var got localipc.Ctl
	eventually(t, "ctl "+typ, func() bool {
		tc.mu.Lock()
		defer tc.mu.Unlock()
		for _, c := range tc.ctls {
			if c.Type == typ {
				got = c
				return true
			}
		}
		return false
	})
	return got
}

func (tc *tclient) send(t *testing.T, s string) {
	t.Helper()
	if err := tc.c.WriteFrame(localipc.FrameIn, []byte(s)); err != nil {
		t.Fatal(err)
	}
}

func (tc *tclient) ctl(t *testing.T, typ string) {
	t.Helper()
	if err := tc.c.WriteCtl(localipc.Ctl{Type: typ}); err != nil {
		t.Fatal(err)
	}
}

func createReq(t *testing.T, extra map[string]any) map[string]any {
	req := map[string]any{"op": "session.create", "cli": "claude", "cwd": shortDir(t), "cols": 100, "rows": 30}
	for k, v := range extra {
		req[k] = v
	}
	return req
}

func TestLocalCreateInputExit(t *testing.T) {
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-bimat-khong-lo")
	t.Setenv("HIVE_FAKE_SECRET", "machine-token-123")
	path := startLocal(t, &Local{})
	tc, resp := gate(t, path, createReq(t, map[string]any{"args": []string{"--model", "opus"}, "term": "xterm-kitty"}))
	if resp["mode"] != ModeControl || resp["id"] == "" {
		t.Fatalf("create = %v", resp)
	}
	tc.waitCtl(t, localipc.CtlControl)
	tc.waitOut(t, "READY --model opus")
	tc.waitOut(t, "hive=none term=xterm-kitty")
	if out := tc.output(); !strings.Contains(out, "tok=***") || strings.Contains(out, "bimat") {
		t.Fatalf("bí mật phải bị che: %q", out)
	}
	tc.send(t, "xin chao\n")
	tc.waitOut(t, "got:xin chao")
	tc.send(t, "quit\n")
	exit := tc.waitCtl(t, localipc.CtlExit)
	if exit.Reason != ReasonExit || exit.Code == nil || *exit.Code != 7 {
		t.Fatalf("exit = %+v", exit)
	}
	<-tc.done
}

func TestLocalDetachReattach(t *testing.T) {
	path := startLocal(t, &Local{})
	tc, resp := gate(t, path, createReq(t, nil))
	id := resp["id"].(string)
	tc.waitOut(t, "READY")
	tc.send(t, "mot\n")
	tc.waitOut(t, "got:mot")
	tc.ctl(t, localipc.CtlDetach)
	<-tc.done

	var list struct {
		Sessions []SessionInfo `json:"sessions"`
	}
	eventually(t, "phiên không còn ai điều khiển", func() bool {
		if err := dial(t, path).Call(map[string]string{"op": "session.list"}, &list); err != nil {
			t.Fatal(err)
		}
		return len(list.Sessions) == 1 && !list.Sessions[0].Controlled
	})
	if s := list.Sessions[0]; s.ID != id || s.CLI != "claude" || s.PID == 0 {
		t.Fatalf("list = %+v", list)
	}

	// Gắn lại bằng tiền tố: nhận lại đuôi output cũ rồi gõ tiếp được.
	again, _ := gate(t, path, map[string]any{"op": "session.attach", "id": id[:4]})
	again.waitOut(t, "got:mot")
	again.send(t, "hai\n")
	again.waitOut(t, "got:hai")
}

func TestLocalControlAndView(t *testing.T) {
	path := startLocal(t, &Local{})
	a, resp := gate(t, path, createReq(t, nil))
	id := resp["id"].(string)
	a.waitOut(t, "READY")
	b, _ := gate(t, path, map[string]any{"op": "session.attach", "id": id, "mode": ModeView})
	b.waitOut(t, "READY")

	a.send(t, "tu-a\n")
	b.waitOut(t, "got:tu-a")
	// Người xem gõ không vào CLI.
	b.send(t, "tu-b\n")
	a.send(t, "moc\n")
	a.waitOut(t, "got:moc")
	if strings.Contains(a.output(), "tu-b") {
		t.Fatalf("phím của người xem lọt vào phiên: %q", a.output())
	}

	// Người xem giành quyền: a nhận "taken", phím của a không còn vào.
	b.ctl(t, localipc.CtlTake)
	a.waitCtl(t, localipc.CtlTaken)
	b.waitCtl(t, localipc.CtlControl)
	a.send(t, "a-sau\n")
	b.send(t, "b-sau\n")
	b.waitOut(t, "got:b-sau")
	if strings.Contains(b.output(), "a-sau") {
		t.Fatalf("phím của người mất quyền lọt vào phiên: %q", b.output())
	}

	// Gắn control mới giành quyền của b.
	c, _ := gate(t, path, map[string]any{"op": "session.attach", "id": id})
	b.waitCtl(t, localipc.CtlTaken)
	c.send(t, "tu-c\n")
	a.waitOut(t, "got:tu-c")
}

func TestLocalKill(t *testing.T) {
	path := startLocal(t, &Local{})
	tc, resp := gate(t, path, createReq(t, map[string]any{"cli": "codex"}))
	id := resp["id"].(string)
	tc.waitOut(t, "READY")
	if err := dial(t, path).Call(map[string]string{"op": "session.kill", "id": id}, nil); err != nil {
		t.Fatal(err)
	}
	exit := tc.waitCtl(t, localipc.CtlExit)
	if exit.Reason != ReasonKilled || exit.Code != nil {
		t.Fatalf("exit = %+v", exit)
	}
	<-tc.done
	var re *localipc.RemoteError
	eventually(t, "phiên bị xoá", func() bool {
		err := dial(t, path).Call(map[string]string{"op": "session.attach", "id": id}, nil)
		return errors.As(err, &re) && re.Code == localipc.CodeNotFound
	})
}

func TestLocalCloseAll(t *testing.T) {
	l := &Local{}
	path := startLocal(t, l)
	tc, _ := gate(t, path, createReq(t, nil))
	tc.waitOut(t, "READY")
	l.CloseAll("hive-worker đang tắt.")
	exit := tc.waitCtl(t, localipc.CtlExit)
	if exit.Reason != ReasonClosed || exit.Message != "hive-worker đang tắt." {
		t.Fatalf("exit = %+v", exit)
	}
	if !l.Wait(5 * time.Second) {
		t.Fatal("phiên không dọn xong")
	}
	err := dial(t, path).Call(createReq(t, nil), nil)
	var re *localipc.RemoteError
	if !errors.As(err, &re) || re.Code != localipc.CodeBusy {
		t.Fatalf("mở phiên khi đang tắt: %v", err)
	}
}

func TestLocalRejects(t *testing.T) {
	path := startLocal(t, &Local{MaxSessions: 1})
	cases := []struct {
		req  map[string]any
		code string
	}{
		{createReq(t, map[string]any{"cli": "bash"}), localipc.CodeBadRequest},
		{createReq(t, map[string]any{"cwd": "tuong-doi"}), localipc.CodeBadRequest},
		{createReq(t, map[string]any{"cwd": filepath.Join(shortDir(t), "khong-co")}), localipc.CodeBadRequest},
		{createReq(t, map[string]any{"account": "khong-co"}), localipc.CodeBusy},
		{map[string]any{"op": "session.attach", "id": "zzzz"}, localipc.CodeNotFound},
		{map[string]any{"op": "session.attach", "id": "x", "mode": "admin"}, localipc.CodeBadRequest},
		{map[string]any{"op": "session.kill"}, localipc.CodeBadRequest},
		{map[string]any{"op": "remote.enable"}, localipc.CodeUnsupported},
	}
	for _, tt := range cases {
		err := dial(t, path).Call(tt.req, nil)
		var re *localipc.RemoteError
		if !errors.As(err, &re) || re.Code != tt.code {
			t.Fatalf("%v: lỗi = %v, muốn mã %s", tt.req, err, tt.code)
		}
	}
	tc, _ := gate(t, path, createReq(t, nil))
	tc.waitOut(t, "READY")
	err := dial(t, path).Call(createReq(t, nil), nil)
	var re *localipc.RemoteError
	if !errors.As(err, &re) || re.Code != localipc.CodeBusy || !strings.Contains(re.Message, "đủ 1 phiên") {
		t.Fatalf("quá số phiên: %v", err)
	}
}

// Client không đọc: bị tách khi hàng đầy, CLI và phiên vẫn chạy.
func TestLocalSlowClientDropped(t *testing.T) {
	l := &Local{}
	path := startLocal(t, l)
	tc, resp := gate(t, path, createReq(t, nil))
	tc.waitOut(t, "READY")
	id := resp["id"].(string)
	s, _, _ := l.find(id)
	cl := &localClient{queue: make(chan localFrame, 1)}
	s.mu.Lock()
	s.clients[cl] = struct{}{}
	s.mu.Unlock()
	// Gửi từng dòng và chờ tiếng vọng rồi mới gửi tiếp: gửi liền thì hai dòng có thể về chung một lần đọc PTY, thành một
	// khung và hàng một chỗ không bao giờ đầy.
	tc.send(t, "a\n")
	tc.waitOut(t, "got:a")
	tc.send(t, "b\n")
	tc.waitOut(t, "got:b")
	eventually(t, "client chậm bị tách", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		_, still := s.clients[cl]
		return !still && cl.closed
	})
}

// Phiên tại máy được ghi lên hub (đã che bí mật) và kết thúc kèm mã thoát; --no-record thì không ghi.
func TestLocalRecordsToHub(t *testing.T) {
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-bimat-khong-lo")
	rec := &Recorder{Dir: filepath.Join(shortDir(t), "terminal")}
	link := newFakeLink()
	rec.OnWelcome(personal(), link)
	path := startLocal(t, &Local{Recorder: rec})

	quiet, _ := gate(t, path, createReq(t, map[string]any{"noRecord": true}))
	quiet.waitOut(t, "READY")
	tc, _ := gate(t, path, createReq(t, map[string]any{"projectId": "p1", "taskId": "t1"}))
	tc.waitOut(t, "READY")

	var list struct {
		Sessions []SessionInfo `json:"sessions"`
	}
	if err := dial(t, path).Call(map[string]string{"op": "session.list"}, &list); err != nil {
		t.Fatal(err)
	}
	var hubID string
	recorded := 0
	for _, s := range list.Sessions {
		if s.HubID != "" {
			hubID = s.HubID
			recorded++
		}
	}
	if recorded != 1 {
		t.Fatalf("chỉ phiên không có --no-record được ghi: %+v", list.Sessions)
	}

	tc.send(t, "xin chao\n")
	tc.waitOut(t, "got:xin chao")
	tc.send(t, "quit\n")
	tc.waitCtl(t, localipc.CtlExit)
	eventually(t, "term_exit", func() bool {
		n := 0
		link.snapshot(func(f *fakeLink) { n = len(f.exits) })
		return n == 1
	})
	out := link.joined(hubID)
	if !strings.Contains(out, "got:xin chao") || !strings.Contains(out, "tok=***") || strings.Contains(out, "bimat") {
		t.Fatalf("bản ghi = %q", out)
	}
	link.snapshot(func(f *fakeLink) {
		if len(f.opened) != 1 || f.opened[0].ProjectID != "p1" || f.opened[0].TaskID != "t1" || f.opened[0].Cols != 100 {
			t.Fatalf("opened = %+v", f.opened)
		}
		if e := f.exits[0]; e.SessionID != hubID || e.Reason != ReasonExit || e.ExitCode == nil || *e.ExitCode != 7 {
			t.Fatalf("exit = %+v", e)
		}
	})
}
