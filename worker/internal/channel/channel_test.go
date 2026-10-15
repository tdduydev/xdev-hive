package channel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
)

func testConfig(t *testing.T, url string) Config {
	return Config{HubURL: url, Machine: "machine-1", Version: "1.2.3", CLIs: []string{"codex"}, Capacity: 2, MinBackoff: time.Millisecond, MaxBackoff: 4 * time.Millisecond, DataDir: t.TempDir(), Logger: quietLogger()}
}

func receiveHello(t *testing.T, conn *websocket.Conn) Hello {
	t.Helper()
	_, data, err := conn.Read(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var hello Hello
	if err := json.Unmarshal(data, &hello); err != nil {
		t.Fatal(err)
	}
	if hello.Type != "hello" || hello.V != 1 || hello.MachineID != "machine-1" || hello.Version != "1.2.3" || hello.ProtoRange != [2]int{1, 1} {
		t.Fatalf("hello sai: %+v", hello)
	}
	return hello
}

func TestWelcome(t *testing.T) {
	got := make(chan Hello, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ws/worker" {
			t.Errorf("path = %s", r.URL.Path)
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		got <- receiveHello(t, conn)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"reply","sessionId":"session","heartbeatSec":30,"accessTokenExp":"2026-10-11T00:00:00Z"}`))
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- testConfig(t, srv.URL).Run(ctx) }()
	select {
	case <-got:
	case <-time.After(waitFor):
		t.Fatal("không nhận hello")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(waitFor):
		t.Fatal("worker không thoát sau khi huỷ context")
	}
}

// Hub cũ kiểm hello bằng enum CLI cũ và từ chối cả gói khi có CLI lạ: worker chỉ khai antigravity khi health của hub
// có nó trong `clis`.
func TestHelloOnlyListsCLIsTheHubKnows(t *testing.T) {
	for _, tc := range []struct {
		name, health string
		want         []string
	}{
		{"hub mới", `{"status":"ok","version":"2","time":"2026-10-13T00:00:00Z","clis":["claude","codex","gemini","antigravity"]}`, []string{"codex", "antigravity"}},
		{"hub cũ", `{"status":"ok","version":"1","time":"2026-10-13T00:00:00Z"}`, []string{"codex"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := make(chan Hello, 1)
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/health" {
					w.Header().Set("Content-Type", "application/json")
					_, _ = w.Write([]byte(tc.health))
					return
				}
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					t.Error(err)
					return
				}
				got <- receiveHello(t, conn)
				_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"reply","sessionId":"session","heartbeatSec":30}`))
				<-r.Context().Done()
			}))
			defer srv.Close()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			cfg := testConfig(t, srv.URL)
			cfg.CLIs = []string{"codex", "antigravity"}
			done := make(chan error, 1)
			go func() { done <- cfg.Run(ctx) }()
			select {
			case hello := <-got:
				if !slices.Equal(hello.CLIs, tc.want) {
					t.Fatalf("hello.clis = %v, cần %v", hello.CLIs, tc.want)
				}
			case <-time.After(waitFor):
				t.Fatal("không nhận hello")
			}
			cancel()
			<-done
		})
	}
}

func TestUpgradeRequired(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		receiveHello(t, conn)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"upgrade_required","v":1,"id":"reply","url":"https://example.test/worker","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sig":"sig"}`))
	}))
	defer srv.Close()
	err := testConfig(t, srv.URL).Run(context.Background())
	if _, ok := err.(*UpgradeError); !ok {
		t.Fatalf("error = %T %v, cần UpgradeError", err, err)
	}
}

func TestReconnectAfterServerCloses(t *testing.T) {
	var attempts atomic.Int32
	reconnected := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		receiveHello(t, conn)
		if attempts.Add(1) == 1 {
			_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"1","sessionId":"s1","heartbeatSec":30,"accessTokenExp":"2026-10-11T00:00:00Z"}`))
			_ = conn.Close(websocket.StatusGoingAway, "restart")
			return
		}
		close(reconnected)
		<-r.Context().Done()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- testConfig(t, srv.URL).Run(ctx) }()
	select {
	case <-reconnected:
	case <-time.After(waitFor):
		t.Fatalf("worker không nối lại; số lần thử %d", attempts.Load())
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(waitFor):
		t.Fatal("worker không dừng")
	}
}

func TestWebsocketURL(t *testing.T) {
	got, err := websocketURL("https://hub.example/")
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(got) != "wss://hub.example/ws/worker" {
		t.Fatalf("url = %q", got)
	}
}

func TestTokenAndHeartbeat(t *testing.T) {
	// Máy dev có thể cài rtk, codegraph: tắt để danh sách capability không tuỳ máy chạy test.
	t.Setenv(runner.RTKEnv, "off")
	t.Setenv(runner.CodeGraphEnv, "off")
	gotAuth := make(chan string, 1)
	gotHeartbeat := make(chan Heartbeat, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth <- r.Header.Get("Authorization")
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		hello := receiveHello(t, conn)
		if hello.ResumeRuns == nil || hello.CLIs == nil {
			t.Errorf("hello có mảng null: %+v", hello)
		}
		// Hub chỉ giao run kiểm tài liệu, trợ lý tài liệu, brief và soạn tài liệu SDLC cho worker khai doccheck, docassist, brief, sdlc.
		if len(hello.Capabilities) != 5 || hello.Capabilities[0] != "doccheck" || hello.Capabilities[1] != "docassist" || hello.Capabilities[2] != "brief" || hello.Capabilities[3] != "skill_proposal" || hello.Capabilities[4] != "sdlc" {
			t.Errorf("hello.capabilities = %v", hello.Capabilities)
		}
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"w","sessionId":"s","heartbeatSec":30}`))
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}
		var hb Heartbeat
		_ = json.Unmarshal(data, &hb)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"heartbeat_ack","v":1,"id":"a","renewed":[],"cancel":[]}`))
		gotHeartbeat <- hb
		<-r.Context().Done()
	}))
	defer srv.Close()
	cfg := testConfig(t, srv.URL)
	cfg.Token = "hwm_secret"
	cfg.Heartbeat = 10 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	if auth := <-gotAuth; auth != "Bearer hwm_secret" {
		t.Fatalf("Authorization = %q", auth)
	}
	select {
	case hb := <-gotHeartbeat:
		if hb.Type != "heartbeat" || hb.V != 1 || hb.ID == "" || hb.Runs == nil {
			t.Fatalf("heartbeat sai: %+v", hb)
		}
	case <-time.After(waitFor):
		t.Fatal("không nhận heartbeat")
	}
}

func TestUnauthorizedStops(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "Machine token không hợp lệ", http.StatusUnauthorized)
	}))
	defer srv.Close()
	err := testConfig(t, srv.URL).Run(context.Background())
	var rejected *RejectedError
	if !errors.As(err, &rejected) || rejected.Code != http.StatusUnauthorized {
		t.Fatalf("error = %v, cần RejectedError 401", err)
	}
}

func TestRevokedCloseStops(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		receiveHello(t, conn)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"w","sessionId":"s","heartbeatSec":30}`))
		_ = conn.Close(4401, "Máy đã bị thu hồi")
	}))
	defer srv.Close()
	done := make(chan error, 1)
	go func() { done <- testConfig(t, srv.URL).Run(context.Background()) }()
	select {
	case err := <-done:
		var rejected *RejectedError
		if !errors.As(err, &rejected) || rejected.Code != 4401 {
			t.Fatalf("error = %v, cần RejectedError 4401", err)
		}
	case <-time.After(waitFor):
		t.Fatal("worker không dừng khi máy bị thu hồi")
	}
}

func TestStatusCallback(t *testing.T) {
	var attempts atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		receiveHello(t, conn)
		_ = conn.Write(r.Context(), websocket.MessageText, []byte(`{"type":"welcome","v":1,"id":"w","sessionId":"s","heartbeatSec":30}`))
		if attempts.Add(1) == 1 {
			_ = conn.Close(websocket.StatusGoingAway, "restart")
			return
		}
		_ = conn.Close(4401, "Máy đã bị thu hồi")
	}))
	defer srv.Close()
	var states []string
	cfg := testConfig(t, srv.URL)
	cfg.OnStatus = func(s Status) { states = append(states, s.State) }
	if err := cfg.Run(context.Background()); err == nil {
		t.Fatal("cần lỗi khi máy bị thu hồi")
	}
	want := []string{"connecting", "online", "disconnected", "connecting", "online", "stopped"}
	if strings.Join(states, ",") != strings.Join(want, ",") {
		t.Fatalf("trạng thái = %v, cần %v", states, want)
	}
}

// ---- Điều khiển terminal từ xa trên máy cá nhân (specs/010 T010, D14) ----

// fakeTerm ghi lại mọi lời gọi của kênh để test so với gói hub giả đã gửi.
type fakeTerm struct {
	mu       sync.Mutex
	calls    []string
	welcomes chan terminal.WelcomeInfo
	sender   chan terminal.Sender
	last     map[string]any
}

func newFakeTerm() *fakeTerm {
	return &fakeTerm{welcomes: make(chan terminal.WelcomeInfo, 4), sender: make(chan terminal.Sender, 4), last: map[string]any{}}
}

func (f *fakeTerm) record(name string, arg any) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, name)
	f.last[name] = arg
}

func (f *fakeTerm) seen() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func (f *fakeTerm) arg(name string) any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.last[name]
}

func (f *fakeTerm) OnWelcome(info terminal.WelcomeInfo, send terminal.Sender) {
	f.welcomes <- info
	f.sender <- send
}
func (f *fakeTerm) OnDisconnect()                               { f.record("disconnect", nil) }
func (f *fakeTerm) Start(r terminal.StartRequest)               { f.record("start", r) }
func (f *fakeTerm) Control(r terminal.ControlRequest)           { f.record("control", r) }
func (f *fakeTerm) Detach(r terminal.DetachRequest)             { f.record("detach", r) }
func (f *fakeTerm) Ack(r terminal.AckRequest)                   { f.record("ack", r) }
func (f *fakeTerm) Input(r terminal.InputRequest)               { f.record("input", r) }
func (f *fakeTerm) Resize(r terminal.ResizeRequest)             { f.record("resize", r) }
func (f *fakeTerm) Disable(r terminal.DisableRequest)           { f.record("disable", r) }
func (f *fakeTerm) Pair(r terminal.PairRequest)                 { f.record("pair", r) }
func (f *fakeTerm) DeviceRevoke(r terminal.DeviceRevokeRequest) { f.record("deviceRevoke", r) }
func (f *fakeTerm) CloseSession(r terminal.CloseRequest)        { f.record("closeSession", r) }

// termHub là hub giả: gửi welcome theo ý test rồi chuyển mọi gói worker gửi lên vào msgs. Chỉ phục vụ kết nối đầu:
// worker nối lại sau khi test ngắt (có khi lúc test đã xong) thì bị đóng ngay, không gọi t.Fatal ngoài test.
func termHub(t *testing.T, welcome map[string]any) (*httptest.Server, chan Hello, chan *websocket.Conn, chan map[string]any) {
	hellos := make(chan Hello, 1)
	conns := make(chan *websocket.Conn, 1)
	msgs := make(chan map[string]any, 64)
	welcome["type"], welcome["v"], welcome["id"], welcome["sessionId"], welcome["heartbeatSec"] = "welcome", 1, "w", "s", 3600
	var served atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if served.Swap(true) {
			http.Error(w, "đã có kết nối", http.StatusServiceUnavailable)
			return
		}
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		hellos <- receiveHello(t, conn)
		_ = conn.Write(r.Context(), websocket.MessageText, mustJSON(welcome))
		conns <- conn
		for {
			_, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var m map[string]any
			_ = json.Unmarshal(data, &m)
			msgs <- m
		}
	}))
	return srv, hellos, conns, msgs
}

func sendRaw(t *testing.T, conn *websocket.Conn, v map[string]any) {
	t.Helper()
	v["v"], v["id"] = 1, newID()
	if err := conn.Write(context.Background(), websocket.MessageText, mustJSON(v)); err != nil {
		t.Fatal(err)
	}
}

func remotePackets() []map[string]any {
	auth := map[string]any{"kind": "passkey", "ephPub": "EPH", "ts": 1760000000, "nonce": "n1", "assertion": map[string]any{"credentialId": "c", "authenticatorData": "a", "clientDataJSON": "d", "signature": "s"}}
	return []map[string]any{
		{"type": "term_start", "requestId": "r1", "userId": "u1", "deviceId": "d1", "cli": "claude", "rootId": "root1", "cols": 80, "rows": 24, "auth": auth},
		{"type": "term_control", "sessionId": "s1", "connId": "c1", "userId": "u1", "deviceId": "d1", "resumeToken": "tok"},
		{"type": "term_detach", "sessionId": "s1", "connId": "c1"},
		{"type": "term_ack", "sessionId": "s1", "upto": 42},
		{"type": "term_input", "sessionId": "s1", "data": "aGk=", "connId": "c1", "seq": 3, "mac": "m"},
		{"type": "term_resize", "sessionId": "s1", "cols": 100, "rows": 30, "connId": "c1", "seq": 4, "mac": "m"},
		{"type": "term_disable", "by": "admin"},
		{"type": "term_pair", "pairId": "p1", "userId": "u1", "label": "Điện thoại", "credentialId": "c", "spki": "k", "tag": "t"},
		{"type": "term_device_revoke", "deviceId": "d1", "by": "owner"},
	}
}

// Hub khai terminal: gói H→W tới Handler với đủ trường, welcome.owner/policy được chuyển, Handler gửi lại được term_*.
func TestRemoteTerminalPacketsReachHandler(t *testing.T) {
	srv, hellos, conns, msgs := termHub(t, map[string]any{
		"features": []string{"terminal"}, "owner": map[string]any{"userId": "u1", "shared": false}, "policy": map[string]any{"totpFallback": false},
	})
	defer srv.Close()
	h := newFakeTerm()
	cfg := testConfig(t, srv.URL)
	cfg.Terminal = h
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	// Máy cá nhân không có claude vẫn khai terminal khi có Handler.
	if hello := <-hellos; !slices.Contains(hello.Capabilities, "terminal") {
		t.Fatalf("capabilities = %v", hello.Capabilities)
	}
	conn := <-conns
	select {
	case info := <-h.welcomes:
		if !info.Terminal || info.Owner == nil || info.Owner.UserID != "u1" || info.Owner.Shared || info.Policy == nil || info.Policy.TOTPFallback {
			t.Fatalf("welcome info = %+v", info)
		}
	case <-time.After(waitFor):
		t.Fatal("Handler không nhận OnWelcome")
	}
	send := <-h.sender
	if err := send.State(terminal.State{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	state := expect(t, msgs, "term_state", "")
	for _, k := range []string{"roots", "clis", "accounts", "devices", "sessions"} {
		if arr, ok := state[k].([]any); !ok || len(arr) != 0 {
			t.Fatalf("term_state.%s = %v, cần mảng rỗng", k, state[k])
		}
	}

	for _, p := range remotePackets() {
		sendRaw(t, conn, p)
	}
	// Phím không có connId là của phiên Leader, không thuộc Handler.
	sendRaw(t, conn, map[string]any{"type": "term_input", "sessionId": "s1", "data": "aGk="})
	eventually(t, "Handler nhận đủ gói", func() bool { return len(h.seen()) == 9 })
	want := []string{"start", "control", "detach", "ack", "input", "resize", "disable", "pair", "deviceRevoke"}
	if got := h.seen(); !slices.Equal(got, want) {
		t.Fatalf("thứ tự gọi = %v, cần %v", got, want)
	}
	start := h.arg("start").(terminal.StartRequest)
	if start.RequestID != "r1" || start.RootID != "root1" || start.Cols != 80 || start.Auth.Kind != "passkey" || start.Auth.EphPub != "EPH" || start.Auth.Assertion == nil || start.Auth.Assertion.Signature != "s" {
		t.Fatalf("start = %+v", start)
	}
	in := h.arg("input").(terminal.InputRequest)
	if in.ConnID != "c1" || string(in.Data) != "hi" || in.Seq == nil || *in.Seq != 3 || in.MAC != "m" {
		t.Fatalf("input = %+v", in)
	}
	if ack := h.arg("ack").(terminal.AckRequest); ack.Upto != 42 {
		t.Fatalf("ack = %+v", ack)
	}

	// Mọi hàm Sender ra đúng gói term_*.
	controller := "c1"
	for _, tc := range []struct {
		typ  string
		call func() error
	}{
		{"term_denied", func() error {
			return send.Denied(terminal.Denied{RequestID: "r1", Code: "forbidden", Reason: "Không được phép."})
		}},
		{"term_opened", func() error {
			return send.Opened(terminal.Opened{SessionID: "s1", Origin: "remote", RequestID: "r1", Permissions: "workspace", CLI: "claude"})
		}},
		{"term_event", func() error {
			return send.Event(terminal.SessionEvent{SessionID: "s1", Seq: 1, Event: "controller", Data: []byte(`{"connId":"c1"}`)})
		}},
		{"term_granted", func() error {
			return send.Granted(terminal.Granted{SessionID: "s1", ConnID: "c1", WorkerEphPub: "W", ResumeToken: "tok"})
		}},
		{"term_revoked", func() error {
			return send.Revoked(terminal.Revoked{SessionID: "s1", ConnID: "c1", Reason: "device_revoked"})
		}},
		{"term_pair_result", func() error { return send.PairResult(terminal.PairResult{PairID: "p1", OK: true, DeviceID: "d1"}) }},
		{"term_output", func() error { return send.Output("s1", 0, []byte("x")) }},
		{"term_exit", func() error { return send.Exit(terminal.Exit{SessionID: "s1", Reason: "exit", By: controller}) }},
	} {
		if err := tc.call(); err != nil {
			t.Fatalf("%s: %v", tc.typ, err)
		}
		m := expect(t, msgs, tc.typ, "")
		if m["v"] != float64(1) || m["id"] == "" {
			t.Fatalf("%s thiếu v/id: %v", tc.typ, m)
		}
	}
}

// SC-010: hub không khai terminal (hub cũ) thì worker không gửi gói term_* mới nào, dù Handler muốn gửi; gói điều khiển từ
// xa hub lỡ gửi bị bỏ và kênh vẫn sống.
func TestNoRemoteTerminalPacketsWithoutHubFeature(t *testing.T) {
	srv, hellos, conns, msgs := termHub(t, map[string]any{})
	defer srv.Close()
	h := newFakeTerm()
	cfg := testConfig(t, srv.URL)
	cfg.Terminal = h
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	<-hellos
	conn := <-conns
	info := <-h.welcomes
	if info.Terminal || info.Owner != nil || info.Policy != nil {
		t.Fatalf("welcome info = %+v", info)
	}
	send := <-h.sender
	if send.Enabled() {
		t.Fatal("Sender báo bật dù hub không khai terminal")
	}
	for name, err := range map[string]error{
		"state": send.State(terminal.State{}), "denied": send.Denied(terminal.Denied{}), "opened": send.Opened(terminal.Opened{Origin: "local"}),
		"output": send.Output("s", 0, nil), "exit": send.Exit(terminal.Exit{}), "event": send.Event(terminal.SessionEvent{}),
		"granted": send.Granted(terminal.Granted{}), "revoked": send.Revoked(terminal.Revoked{}), "pairResult": send.PairResult(terminal.PairResult{}),
	} {
		if !errors.Is(err, terminal.ErrHubNoTerminal) {
			t.Errorf("%s: err = %v, cần ErrHubNoTerminal", name, err)
		}
	}
	for _, p := range remotePackets() {
		sendRaw(t, conn, p)
	}
	// term_open trên máy không có phiên Leader được trả lời tuần tự sau các gói trên: thấy term_exit nghĩa là chúng đã
	// được xử lý xong.
	sendRaw(t, conn, map[string]any{"type": "term_open", "sessionId": "s9"})
	for {
		var m map[string]any
		select {
		case m = <-msgs:
		case <-time.After(waitFor):
			t.Fatal("không nhận term_exit: kênh có thể đã đóng")
		}
		typ, _ := m["type"].(string)
		if typ == "term_exit" {
			break
		}
		if strings.HasPrefix(typ, "term_") {
			t.Fatalf("worker gửi %s cho hub không khai terminal", typ)
		}
	}
	if got := h.seen(); len(got) != 0 {
		t.Fatalf("Handler nhận %v dù hub không khai terminal", got)
	}
}

// Máy chưa có Handler: gói điều khiển từ xa bị bỏ, không khai terminal, kênh vẫn chạy.
func TestRemoteTerminalPacketsIgnoredWithoutHandler(t *testing.T) {
	srv, hellos, conns, msgs := termHub(t, map[string]any{"features": []string{"terminal"}})
	defer srv.Close()
	cfg := testConfig(t, srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	if hello := <-hellos; slices.Contains(hello.Capabilities, "terminal") {
		t.Fatalf("capabilities = %v", hello.Capabilities)
	}
	conn := <-conns
	for _, p := range remotePackets() {
		sendRaw(t, conn, p)
	}
	sendRaw(t, conn, map[string]any{"type": "term_open", "sessionId": "s9"})
	expect(t, msgs, "term_exit", "")
}

// Mất kết nối: Handler được báo, Sender của phiên cũ không ghi sang kết nối sau.
func TestTerminalSenderDiesWithSession(t *testing.T) {
	srv, _, conns, _ := termHub(t, map[string]any{"features": []string{"terminal"}})
	defer srv.Close()
	h := newFakeTerm()
	cfg := testConfig(t, srv.URL)
	cfg.Terminal = h
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	conn := <-conns
	<-h.welcomes
	send := <-h.sender
	_ = conn.CloseNow()
	eventually(t, "Handler nhận OnDisconnect", func() bool { return slices.Contains(h.seen(), "disconnect") })
	eventually(t, "Sender cũ ngừng gửi", func() bool { return errors.Is(send.State(terminal.State{}), terminal.ErrHubNoTerminal) })
}
