package channel

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

// testPool là accounts pool có một tài khoản codex, thư mục nhà riêng cho test.
func testPool(t *testing.T) *accounts.Pool {
	t.Helper()
	// Windows lấy thư mục home từ USERPROFILE; thiếu thì test ghi vào home thật của máy chạy.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	path := filepath.Join(t.TempDir(), "accounts.json")
	if err := accounts.Save(path, 0, []accounts.Account{{ID: "codex-1", Label: "Codex", CLI: "codex", Enabled: true}}); err != nil {
		t.Fatal(err)
	}
	return accounts.NewPool(path)
}

func TestHeartbeatReportsAccounts(t *testing.T) {
	j := testJobs(t, 1)
	if raw := mustJSON(j.heartbeat()); containsKey(t, raw, "accounts") {
		t.Fatalf("runner host báo accounts: %s", raw)
	}
	j.cfg.Accounts = accounts.NewPool(filepath.Join(t.TempDir(), "accounts.json"))
	// Chưa có gói nào vẫn gửi [] để hub xoá tóm tắt cũ.
	var hb struct {
		Accounts []accounts.Summary `json:"accounts"`
	}
	_ = json.Unmarshal(mustJSON(j.heartbeat()), &hb)
	if hb.Accounts == nil || len(hb.Accounts) != 0 {
		t.Fatalf("accounts = %+v", hb.Accounts)
	}
	j.cfg.Accounts = testPool(t)
	_ = json.Unmarshal(mustJSON(j.heartbeat()), &hb)
	if len(hb.Accounts) != 1 || hb.Accounts[0].ID != "codex-1" || !hb.Accounts[0].Enabled {
		t.Fatalf("accounts = %+v", hb.Accounts)
	}
}

func containsKey(t *testing.T, raw []byte, key string) bool {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	_, ok := m[key]
	return ok
}

// fakeAccountsHub nhận hello, trả welcome với features rồi chuyển mọi gói worker gửi lên vào channel.
func fakeAccountsHub(t *testing.T, features []string) (*httptest.Server, chan Hello, chan *websocket.Conn, chan map[string]any) {
	hellos := make(chan Hello, 1)
	conns := make(chan *websocket.Conn, 1)
	msgs := make(chan map[string]any, 64)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Error(err)
			return
		}
		hellos <- receiveHello(t, conn)
		welcome := map[string]any{"type": "welcome", "v": 1, "id": "w", "sessionId": "s", "heartbeatSec": 3600, "features": features}
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

func send(t *testing.T, conn *websocket.Conn, v map[string]any) {
	t.Helper()
	v["v"], v["id"] = 1, newID()
	if err := conn.Write(context.Background(), websocket.MessageText, mustJSON(v)); err != nil {
		t.Fatal(err)
	}
}

// expect chờ gói đầu tiên có type và (nếu có) kind như muốn.
func expect(t *testing.T, msgs chan map[string]any, typ, kind string) map[string]any {
	t.Helper()
	deadline := time.After(waitFor)
	for {
		select {
		case m := <-msgs:
			if m["type"] == typ && (kind == "" || m["kind"] == kind) {
				return m
			}
		case <-deadline:
			t.Fatalf("không nhận %s %s", typ, kind)
		}
	}
}

func TestSharedMachineAppliesAccountCommands(t *testing.T) {
	srv, hellos, conns, msgs := fakeAccountsHub(t, []string{"shared"})
	defer srv.Close()
	cfg := testConfig(t, srv.URL)
	cfg.Accounts = testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	if hello := <-hellos; !slices.Contains(hello.Capabilities, "accounts-remote") || !slices.Contains(hello.Capabilities, "doccheck") {
		t.Fatalf("capabilities = %v", hello.Capabilities)
	}
	conn := <-conns

	send(t, conn, map[string]any{"type": "account_set", "accountId": "codex-1", "enabled": false})
	hb := expect(t, msgs, "heartbeat", "")
	list, _ := hb["accounts"].([]any)
	if len(list) != 1 || list[0].(map[string]any)["enabled"] != false {
		t.Fatalf("heartbeat sau account_set: %v", hb["accounts"])
	}

	send(t, conn, map[string]any{"type": "account_login_start", "requestId": "req-1", "cli": "claude", "label": "Token", "how": "token"})
	expect(t, msgs, "account_login_event", "prompt")
	send(t, conn, map[string]any{"type": "account_login_input", "requestId": "req-1", "text": "sk-ant-oat01-thu"})
	done := expect(t, msgs, "account_login_event", "done")
	if done["requestId"] != "req-1" || done["accountId"] != "claude-1" {
		t.Fatalf("done = %v", done)
	}
	got, _ := accounts.Load(cfg.Accounts.Path())
	if len(got) != 2 || got[0].Enabled || got[1].ID != "claude-1" || !got[1].Enabled || got[1].Pending {
		t.Fatalf("accounts.json = %+v", got)
	}
}

func TestPersonalMachineIgnoresAccountCommands(t *testing.T) {
	srv, hellos, conns, msgs := fakeAccountsHub(t, nil)
	defer srv.Close()
	cfg := testConfig(t, srv.URL)
	cfg.Accounts = testPool(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	<-hellos
	conn := <-conns
	send(t, conn, map[string]any{"type": "account_set", "accountId": "codex-1", "enabled": false})
	send(t, conn, map[string]any{"type": "account_login_start", "requestId": "req-2", "cli": "claude", "label": "Token", "how": "token"})
	if e := expect(t, msgs, "account_login_event", "error"); e["requestId"] != "req-2" {
		t.Fatalf("error = %v", e)
	}
	got, _ := accounts.Load(cfg.Accounts.Path())
	if len(got) != 1 || !got[0].Enabled {
		t.Fatalf("máy cá nhân bị đổi gói: %+v", got)
	}
	if entries, _ := os.ReadDir(accounts.AccountsDir(cfg.Accounts.Home())); len(entries) != 0 {
		t.Fatalf("máy cá nhân có thư mục gói mới: %v", entries)
	}
}

func TestStartupRemovesPendingAccounts(t *testing.T) {
	p := testPool(t)
	list, _ := accounts.Load(p.Path())
	list = append(list, accounts.Account{ID: "claude-1", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-1", Pending: true})
	_ = accounts.Save(p.Path(), 0, list)
	srv, hellos, _, _ := fakeAccountsHub(t, nil)
	defer srv.Close()
	cfg := testConfig(t, srv.URL)
	cfg.Accounts = p
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() { _ = cfg.Run(ctx) }()
	<-hellos
	if got, _ := accounts.Load(p.Path()); len(got) != 1 || got[0].ID != "codex-1" {
		t.Fatalf("accounts.json = %+v", got)
	}
}
