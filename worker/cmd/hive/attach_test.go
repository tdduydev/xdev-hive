package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
)

const (
	attachRunID     = "aaaaaaaa-1111-4222-8333-444444444444"
	attachSessionID = "bbbbbbbb-1111-4222-8333-444444444444"
	forbiddenRunID  = "cccccccc-1111-4222-8333-444444444444"
)

// attachHub giả các route hive attach gọi: run, luồng SSE, steer, phiên máy khác, vé và /ws/terminal.
type attachHub struct {
	*httptest.Server
	t *testing.T

	mu         sync.Mutex
	streams    int
	lastIDs    []string
	steers     []string
	steered    chan struct{}
	wsOrigin   string
	wsFrames   []string
	closeView  chan struct{}
	sessionEnd string
}

func newAttachHub(t *testing.T) *attachHub {
	h := &attachHub{t: t, steered: make(chan struct{}, 4), closeView: make(chan struct{})}
	h.Server = httptest.NewServer(h)
	t.Cleanup(h.Close)
	return h
}

func (h *attachHub) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *attachHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/ws/terminal" {
		h.terminal(w, r)
		return
	}
	if r.Header.Get("authorization") != "Bearer "+testToken || r.Header.Get("x-hive-org") != testOrg {
		h.json(w, 401, map[string]string{"message": "Chưa đăng nhập."})
		return
	}
	notFound := map[string]string{"message": "Không tìm thấy."}
	switch p := strings.TrimPrefix(r.URL.Path, "/api"); {
	case p == "/v1/me":
		h.json(w, 200, map[string]string{"id": "u1", "name": "Lan", "email": "lan@example.com"})
	case p == "/v1/runs/"+attachRunID:
		h.json(w, 200, map[string]any{"id": attachRunID, "state": "running", "cli": "claude", "machineName": "mac-lan"})
	case p == "/v1/runs/"+forbiddenRunID:
		h.json(w, 403, map[string]string{"message": "Không có quyền xem run này."})
	case p == "/v1/runs/"+attachRunID+"/stream":
		h.stream(w, r)
	case p == "/v1/runs/"+attachRunID+"/steer" && r.Method == http.MethodPost:
		var in struct {
			Input string `json:"input"`
		}
		_ = json.NewDecoder(r.Body).Decode(&in)
		h.mu.Lock()
		h.steers = append(h.steers, in.Input)
		h.mu.Unlock()
		h.json(w, 200, map[string]string{"status": "sent"})
		h.steered <- struct{}{}
	case p == "/v1/remote/sessions/"+attachSessionID:
		h.json(w, 200, map[string]any{"id": attachSessionID, "machineName": "win-lan", "cli": "claude", "state": "running"})
	case p == "/v1/remote/sessions/"+attachSessionID+"/ticket" && r.Method == http.MethodPost:
		h.json(w, 200, map[string]any{"ticket": "r.ve-xem", "expiresAt": time.Now().Add(time.Minute), "canControl": false})
	default:
		h.json(w, 404, notFound)
	}
}

func sse(w io.Writer, id, event string, data any) {
	b, _ := json.Marshal(data)
	if id != "" {
		fmt.Fprintf(w, "id: %s\n", id)
	}
	fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
	w.(http.Flusher).Flush()
}

// stream: lần đầu gửi một đoạn log rồi cắt kết nối; lần sau phải nối lại bằng Last-Event-ID, chờ chỉ dẫn rồi kết thúc run.
func (h *attachHub) stream(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	h.streams++
	n := h.streams
	h.lastIDs = append(h.lastIDs, r.Header.Get("last-event-id"))
	h.mu.Unlock()
	w.Header().Set("content-type", "text/event-stream")
	w.WriteHeader(200)
	if n == 1 {
		sse(w, "0.1", "log", map[string]any{"id": 1, "bytes": base64.StdEncoding.EncodeToString([]byte("xin chào\n"))})
		return
	}
	fmt.Fprint(w, ": ping\n\n")
	select {
	case <-h.steered:
	case <-time.After(5 * time.Second):
		h.t.Error("hive không gửi chỉ dẫn")
		return
	}
	// Để hive kịp in trả lời của steer trước khi run kết thúc.
	time.Sleep(100 * time.Millisecond)
	sse(w, "5.1", "run_event", map[string]any{"id": 5, "type": "steer", "data": map[string]any{"input": "thêm test", "sent": true}})
	sse(w, "6.1", "run_event", map[string]any{"id": 6, "type": "steer_result", "data": map[string]any{"steerId": "5", "applied": true}})
	sse(w, "7.1", "run_event", map[string]any{"id": 7, "type": "steer_result", "data": map[string]any{
		"steerId": "4", "applied": false, "reason": "CLI không nhận chỉ dẫn giữa chừng",
	}})
	sse(w, "7.2", "log", map[string]any{"id": 2, "bytes": base64.StdEncoding.EncodeToString([]byte("đã thêm test\n"))})
	sse(w, "", "end", map[string]any{"state": "succeeded"})
}

func (h *attachHub) terminal(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("ticket") != "r.ve-xem" {
		http.Error(w, "vé sai", 400)
		return
	}
	h.mu.Lock()
	h.wsOrigin = r.Header.Get("Origin")
	h.mu.Unlock()
	ws, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer ws.CloseNow()
	ctx := r.Context()
	frames := make(chan string, 8)
	go func() {
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				close(frames)
				return
			}
			h.mu.Lock()
			h.wsFrames = append(h.wsFrames, string(b))
			h.mu.Unlock()
			frames <- string(b)
		}
	}()
	if f := <-frames; !strings.Contains(f, `"t":"resume"`) || !strings.Contains(f, `"after":-1`) {
		h.t.Errorf("khung đầu = %q", f)
	}
	send := func(v any) {
		b, _ := json.Marshal(v)
		_ = ws.Write(ctx, websocket.MessageText, b)
	}
	session := map[string]any{"id": attachSessionID, "machineName": "win-lan", "state": "running"}
	send(map[string]any{"t": "hello", "session": session, "connId": "c1", "canControl": false})
	send(map[string]any{"t": "out", "seq": 0, "data": base64.StdEncoding.EncodeToString([]byte("màn hình agent"))})
	<-h.closeView
	session["state"] = "closed"
	send(map[string]any{"t": "state", "session": session})
	time.Sleep(50 * time.Millisecond)
}

func (h *attachHub) login(t *testing.T, socket string) *testApp {
	t.Helper()
	a := newTestApp(socket, strings.NewReader(testToken))
	if code := a.run([]string{"login", "--with-token", "--hub", h.URL}); code != exitOK {
		t.Fatalf("login: %d %s", code, a.err.String())
	}
	// App mới, cùng keychain và cấu hình: stdout chỉ còn phần của attach.
	b := newTestApp(socket, nil)
	b.keyring, b.cliConfig = a.keyring, a.cliConfig
	return b
}

func fastReconnect(t *testing.T) {
	old := reconnectWait
	reconnectWait = func(int) time.Duration { return 10 * time.Millisecond }
	t.Cleanup(func() { reconnectWait = old })
}

func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if ok() {
			return
		}
	}
	t.Fatalf("hết giờ chờ %s", what)
}

func TestAttachNeedsLogin(t *testing.T) {
	a := newTestApp(filepath.Join(t.TempDir(), "khong-co.sock"), nil)
	if code := a.run([]string{"attach", attachRunID}); code != exitUsage || !strings.Contains(a.err.String(), "Chưa đăng nhập. Chạy `hive login`.") {
		t.Fatalf("mã %d, stderr %q", code, a.err.String())
	}
}

// Không lộ id có thật: run của người khác (403) và id không có (404) báo cùng một câu.
func TestAttachHidesUnknownAndForbidden(t *testing.T) {
	h := newAttachHub(t)
	for _, id := range []string{forbiddenRunID, "dddddddd-1111-4222-8333-444444444444"} {
		a := h.login(t, filepath.Join(t.TempDir(), "khong-co.sock"))
		if code := a.run([]string{"attach", id}); code != exitFailed || !strings.Contains(a.err.String(), msgNotFound) {
			t.Fatalf("%s: mã %d, stderr %q", id, code, a.err.String())
		}
		if strings.Contains(a.err.String(), "quyền") {
			t.Fatalf("%s: lộ lý do: %q", id, a.err.String())
		}
	}
}

func TestAttachRunStreamsAndSteers(t *testing.T) {
	fastReconnect(t)
	h := newAttachHub(t)
	a := h.login(t, filepath.Join(t.TempDir(), "khong-co.sock"))
	a.stdin = strings.NewReader("thêm test\n\n")
	if code := a.run([]string{"attach", attachRunID}); code != exitOK {
		t.Fatalf("mã %d, stderr %q", code, a.err.String())
	}
	if got := a.out.String(); got != "xin chào\nđã thêm test\n" {
		t.Fatalf("stdout = %q", got)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.lastIDs) != 2 || h.lastIDs[0] != "" || h.lastIDs[1] != "0.1" {
		t.Fatalf("Last-Event-ID = %q, muốn nối lại từ 0.1", h.lastIDs)
	}
	if len(h.steers) != 1 || h.steers[0] != "thêm test" {
		t.Fatalf("chỉ dẫn = %q (dòng trống không được gửi)", h.steers)
	}
	for _, want := range []string{
		"đang xem run " + attachRunID,
		"đang nối lại",
		"Đã gửi chỉ dẫn tới máy",
		"Đã gửi chỉ dẫn (đã nhận): thêm test",
		"CLI không nhận chỉ dẫn giữa chừng",
		"run kết thúc: succeeded",
	} {
		if !strings.Contains(a.err.String(), want) {
			t.Fatalf("thiếu %q trong %q", want, a.err.String())
		}
	}
}

func TestAttachRunViewDoesNotSteer(t *testing.T) {
	fastReconnect(t)
	h := newAttachHub(t)
	a := h.login(t, filepath.Join(t.TempDir(), "khong-co.sock"))
	a.stdin = strings.NewReader("không được gửi\n")
	done := make(chan int, 1)
	go func() { done <- a.run([]string{"attach", attachRunID, "--view"}) }()
	waitUntil(t, "luồng thứ hai", func() bool { h.mu.Lock(); defer h.mu.Unlock(); return h.streams >= 2 })
	time.Sleep(100 * time.Millisecond)
	h.mu.Lock()
	n := len(h.steers)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("--view vẫn gửi %d chỉ dẫn", n)
	}
	// Cho luồng giả xong để test không treo.
	h.steered <- struct{}{}
	select {
	case code := <-done:
		if code != exitOK {
			t.Fatalf("mã %d %q", code, a.err.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatal("attach --view không thoát")
	}
}

func TestAttachRemoteViewOnly(t *testing.T) {
	h := newAttachHub(t)
	a := h.login(t, filepath.Join(t.TempDir(), "khong-co.sock"))
	keysR, keysW := io.Pipe()
	defer keysW.Close()
	a.stdin = keysR
	a.con.tty = true
	done := make(chan int, 1)
	go func() { done <- a.run([]string{"attach", attachSessionID}) }()
	waitUntil(t, "màn hình", func() bool { return strings.Contains(a.out.String(), "màn hình agent") })
	_, _ = keysW.Write([]byte("ls\r"))
	waitUntil(t, "dòng chỉ xem", func() bool { return strings.Contains(a.err.String(), msgViewOnly) })
	close(h.closeView)
	select {
	case code := <-done:
		if code != exitOK || !strings.Contains(a.err.String(), "Phiên đã kết thúc") {
			t.Fatalf("mã %d %q", code, a.err.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("attach không thoát khi phiên đóng")
	}
	if a.con.raw != 1 || a.con.restored != 1 {
		t.Fatalf("raw %d, restore %d", a.con.raw, a.con.restored)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.wsOrigin != h.URL {
		t.Fatalf("Origin = %q, muốn %q", h.wsOrigin, h.URL)
	}
	for _, f := range h.wsFrames {
		if !strings.Contains(f, `"t":"resume"`) {
			t.Fatalf("CLI gửi khung %q; phiên máy khác chỉ được xem", f)
		}
	}
	if !strings.Contains(a.err.String(), "Hub chạy HTTP") {
		t.Fatalf("thiếu cảnh báo HTTP: %q", a.err.String())
	}
}

func TestAttachRemoteDetachKey(t *testing.T) {
	h := newAttachHub(t)
	defer close(h.closeView)
	a := h.login(t, filepath.Join(t.TempDir(), "khong-co.sock"))
	keysR, keysW := io.Pipe()
	defer keysW.Close()
	a.stdin = keysR
	done := make(chan int, 1)
	go func() { done <- a.run([]string{"attach", attachSessionID}) }()
	waitUntil(t, "màn hình", func() bool { return strings.Contains(a.out.String(), "màn hình agent") })
	_, _ = keysW.Write([]byte{escKey, 'd'})
	select {
	case code := <-done:
		if code != exitOK || !strings.Contains(a.err.String(), "Đã thôi xem phiên") {
			t.Fatalf("mã %d %q", code, a.err.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Ctrl-] d không tách")
	}
}

// Mã hub của phiên trên chính máy này gắn qua socket (gõ được), không đi qua hub.
func TestAttachHubIDOfLocalSession(t *testing.T) {
	dir, err := os.MkdirTemp("", "hva")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	path := filepath.Join(dir, "hive.sock")
	ln, err := localipc.Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	attached := make(chan string, 1)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() {
		_ = (&localipc.Server{Worker: "test", Handler: func(_ context.Context, c *localipc.Conn, req localipc.Request) error {
			var m map[string]string
			_ = req.Decode(&m)
			switch m["op"] {
			case "session.list":
				return c.OK(map[string]any{"sessions": []map[string]any{
					{"id": "9f3c1a", "cli": "claude", "hubId": attachSessionID},
				}})
			case "session.attach":
				attached <- m["id"] + " " + m["mode"]
			}
			return c.Fail(localipc.CodeNotFound, "dừng ở đây")
		}}).Serve(ctx, ln)
	}()
	a := newTestApp(path, nil)
	if code := a.run([]string{"attach", strings.ToUpper(attachSessionID)}); code != exitFailed {
		t.Fatalf("mã %d %q", code, a.err.String())
	}
	if got := <-attached; got != "9f3c1a control" {
		t.Fatalf("session.attach = %q", got)
	}
	if strings.Contains(a.err.String(), "Chưa đăng nhập") {
		t.Fatalf("phiên trên máy không cần đăng nhập: %q", a.err.String())
	}
}

func TestReadSSE(t *testing.T) {
	in := ": ping\n\nid: 1.2\nevent: log\ndata: a\ndata: b\n\nevent: end\ndata: {}\n\n"
	var got []sseEvent
	err := readSSE(strings.NewReader(in), func(e sseEvent) error { got = append(got, e); return nil })
	if err != io.ErrUnexpectedEOF {
		t.Fatalf("err = %v", err)
	}
	want := []sseEvent{{id: "1.2", event: "log", data: "a\nb"}, {event: "end", data: "{}"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("got %+v", got)
	}
}

func TestWSURL(t *testing.T) {
	for base, want := range map[string][2]string{
		"https://hive.cong-ty.vn": {"wss://hive.cong-ty.vn/ws/terminal?ticket=r.x", "https://hive.cong-ty.vn"},
		"http://192.0.2.10:3000":  {"ws://192.0.2.10:3000/ws/terminal?ticket=r.x", "http://192.0.2.10:3000"},
		"https://cong-ty.vn/hive": {"wss://cong-ty.vn/hive/ws/terminal?ticket=r.x", "https://cong-ty.vn"},
	} {
		u, origin, err := wsURL(base, "r.x")
		if err != nil || u != want[0] || origin != want[1] {
			t.Errorf("%s: %q %q %v", base, u, origin, err)
		}
	}
}
