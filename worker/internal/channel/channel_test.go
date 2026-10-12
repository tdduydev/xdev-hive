package channel

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
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
