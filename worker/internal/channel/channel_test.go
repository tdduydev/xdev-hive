package channel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func testConfig(url string) Config {
	return Config{HubURL: url, Machine: "machine-1", Version: "1.2.3", CLIs: []string{"codex"}, Capacity: 2, MinBackoff: time.Millisecond, MaxBackoff: 4 * time.Millisecond}
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
	go func() { done <- testConfig(srv.URL).Run(ctx) }()
	select {
	case <-got:
	case <-time.After(time.Second):
		t.Fatal("không nhận hello")
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
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
	err := testConfig(srv.URL).Run(context.Background())
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
	go func() { done <- testConfig(srv.URL).Run(ctx) }()
	select {
	case <-reconnected:
	case <-time.After(2 * time.Second):
		t.Fatalf("worker không nối lại; số lần thử %d", attempts.Load())
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
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
