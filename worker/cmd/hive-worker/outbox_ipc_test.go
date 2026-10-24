package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

const (
	obOrg   = "11111111-2222-4333-8444-555555555555"
	obToken = "hive_pat_" + obOrg + "_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
)

type testKeyring map[string]string

func (k testKeyring) Get(service, user string) (string, error) {
	if v, ok := k[service+"|"+user]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}

type userHubCall struct {
	Path    string
	Header  http.Header
	Name    string
	Args    map[string]any
	RPCBody map[string]any
}

// userHub là hub giả cho kênh `mcp`/`rpc`. down thì cắt kết nối như hub tắt; outcome là kết quả hub ghi.
type userHub struct {
	srv     *httptest.Server
	down    atomic.Bool
	mu      sync.Mutex
	outcome string
	calls   []userHubCall
}

func newUserHub(t *testing.T) *userHub {
	t.Helper()
	h := &userHub{outcome: "accepted"}
	h.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h.down.Load() {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return
		}
		// Lượt gửi hỏi mốc database qua health; không tính là lần gửi mục.
		if r.URL.Path == "/api/v1/health" {
			http.NotFound(w, r)
			return
		}
		h.mu.Lock()
		defer h.mu.Unlock()
		call := userHubCall{Path: r.URL.Path, Header: r.Header.Clone()}
		var rpc struct {
			Params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			} `json:"params"`
		}
		switch {
		case r.URL.Path == "/mcp":
			_ = json.NewDecoder(r.Body).Decode(&rpc)
			call.Name, call.Args = rpc.Params.Name, rpc.Params.Arguments
		case strings.HasPrefix(r.URL.Path, "/rpc/"):
			_ = json.NewDecoder(r.Body).Decode(&call.RPCBody)
		}
		h.calls = append(h.calls, call)
		ev := map[string]any{"outcome": h.outcome, "receivedAt": "2026-10-23T03:00:00Z"}
		if h.outcome == "rejected" {
			ev["code"], ev["reason"] = "TASK_CANCELLED", "Task đã huỷ."
		}
		if strings.HasPrefix(r.URL.Path, "/rpc/") {
			b, _ := json.Marshal(ev)
			w.Header().Set("Hive-Client-Event", string(b))
			_, _ = w.Write([]byte(`{"json":{"id":"m1"}}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{
			"content": []any{map[string]any{"type": "text", "text": "đã ghi"}},
			"_meta":   map[string]any{"dev.xdev.hive/clientEvent": ev},
		}})
	}))
	t.Cleanup(h.srv.Close)
	return h
}

func (h *userHub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.calls)
}

func (h *userHub) last() userHubCall {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.calls[len(h.calls)-1]
}

type obEnv struct {
	svc   *outboxService
	hub   *userHub
	home  string
	login string
	mu    sync.Mutex
	now   time.Time
}

func newOBEnv(t *testing.T) *obEnv {
	t.Helper()
	e := &obEnv{hub: newUserHub(t), home: t.TempDir(), now: time.Date(2026, 10, 23, 3, 0, 0, 0, time.UTC)}
	t.Setenv("HOME", e.home)
	t.Setenv("USERPROFILE", e.home)
	e.login = filepath.Join(e.home, "hive.json")
	t.Setenv(outbox.CLIConfigEnv, e.login)
	e.signIn(t, "u-an", "an@example.test")
	oldHome, oldHTTP := optimizeHome, optimizeHubHTTP
	optimizeHome = func() (string, error) { return e.home, nil }
	optimizeHubHTTP = func() *http.Client { return e.hub.srv.Client() }
	t.Cleanup(func() { optimizeHome, optimizeHubHTTP = oldHome, oldHTTP })
	ctx, cancel := context.WithCancel(context.Background())
	svc, err := newOutboxService(ctx, config.Config{MachineID: "may-1"})
	if err != nil {
		t.Fatal(err)
	}
	svc.creds.Keyring = testKeyring{outbox.KeyringService + "|" + e.hub.srv.URL: obToken}
	svc.store.Now = e.clock
	svc.now = e.clock
	e.svc = svc
	// Chạy trước khi xoá thư mục tạm: lượt gửi còn dở mà ghi vào thư mục đã xoá thì Windows báo lỗi.
	t.Cleanup(func() { cancel(); e.idle(t) })
	return e
}

func (e *obEnv) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now
}

func (e *obEnv) advance(d time.Duration) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.now = e.now.Add(d)
}

func (e *obEnv) signIn(t *testing.T, user, email string) {
	t.Helper()
	// Như `hive login`: danh tính kèm dấu vân tay của token trong keychain.
	b, _ := json.Marshal(map[string]string{"hubUrl": e.hubURL(), "userId": user, "email": email, "tokenSha256": outbox.TokenFingerprint(obToken)})
	if err := os.WriteFile(e.login, b, 0o600); err != nil {
		t.Fatal(err)
	}
}

func (e *obEnv) hubURL() string {
	if e.hub == nil {
		return ""
	}
	return e.hub.srv.URL
}

func (e *obEnv) identity(user string) outbox.Identity {
	return outbox.Identity{HubURL: e.hub.srv.URL, OrgID: obOrg, UserID: user}
}

// idle chờ mọi lượt gửi chạy nền xong.
func (e *obEnv) idle(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		busy := false
		e.svc.mu.Lock()
		for _, st := range e.svc.flushes {
			busy = busy || st.running
		}
		e.svc.mu.Unlock()
		if !busy {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("lượt gửi không xong")
}

// call gửi một yêu cầu qua cặp Conn nối thẳng, như client đã qua bước hello.
func (e *obEnv) call(t *testing.T, req map[string]any) (map[string]any, error) {
	t.Helper()
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()
	srv, cli := localipc.NewConn(a), localipc.NewConn(b)
	done := make(chan error, 1)
	go func() {
		r, err := srv.ReadRequest()
		if err == nil {
			err = e.svc.handle(context.Background(), srv, r)
		}
		done <- err
	}()
	var resp map[string]any
	err := cli.Call(req, &resp)
	if herr := <-done; herr != nil {
		t.Fatalf("handler %v: %v", req["op"], herr)
	}
	return resp, err
}

func (e *obEnv) ok(t *testing.T, req map[string]any) map[string]any {
	t.Helper()
	resp, err := e.call(t, req)
	if err != nil {
		t.Fatalf("%v: %v", req["op"], err)
	}
	return resp
}

func remoteCode(err error) string {
	var re *localipc.RemoteError
	if errors.As(err, &re) {
		return re.Code
	}
	return ""
}

func taskUpdate(key string, wait int) map[string]any {
	return map[string]any{
		"op": "outbox.submit", "key": key, "source": "mcp-local", "transport": "mcp", "kind": "task_update",
		"target": map[string]any{"type": "task", "id": "t-1"}, "project": "p-1",
		"body":   map[string]any{"name": "task_update", "arguments": map[string]any{"taskId": "t-1", "status": "done"}},
		"waitMs": wait,
	}
}

func TestOutboxSubmitAccepted(t *testing.T) {
	e := newOBEnv(t)
	resp := e.ok(t, taskUpdate("01JBAAAAAAAAAAAAAAAAAAAAAA", 5000))
	result, _ := resp["result"].(map[string]any)
	if resp["state"] != "accepted" || result["outcome"] != "accepted" || result["receivedAt"] != "2026-10-23T03:00:00Z" || result["response"] == nil {
		t.Fatalf("trả lời %v", resp)
	}
	c := e.hub.last()
	if c.Path != "/mcp" || c.Name != "task_update" || c.Args["status"] != "done" {
		t.Fatalf("hub nhận %+v", c)
	}
	for h, want := range map[string]string{
		"Authorization": "Bearer " + obToken, "Idempotency-Key": "01JBAAAAAAAAAAAAAAAAAAAAAA", "X-Hive-Source": "mcp-local",
		"X-Hive-Org": obOrg, "X-Hive-Project": "p-1", "X-Hive-Machine": "may-1",
	} {
		if got := c.Header.Get(h); got != want {
			t.Errorf("header %s = %q, muốn %q", h, got, want)
		}
	}
	st := e.ok(t, map[string]any{"op": "outbox.status"})
	if st["hub"] != "up" || st["hubUrl"] != e.hub.srv.URL || st["pending"] != float64(0) || st["lastContactAt"] == nil {
		t.Fatalf("status %v", st)
	}
}

func TestOutboxSubmitQueuedWhileHubDown(t *testing.T) {
	e := newOBEnv(t)
	e.hub.down.Store(true)
	key := "01JBBBBBBBBBBBBBBBBBBBBBBB"
	resp := e.ok(t, taskUpdate(key, 5000))
	if resp["state"] != "queued" || resp["key"] != key || resp["pending"] != float64(1) || resp["hub"] != "down" {
		t.Fatalf("hub vắng: %v", resp)
	}
	// Client gửi lại sau khi socket đứt: cùng khoá không thêm mục.
	e.idle(t)
	if resp := e.ok(t, taskUpdate(key, 0)); resp["state"] != "queued" || resp["pending"] != float64(1) {
		t.Fatalf("nộp lại: %v", resp)
	}
	st := e.ok(t, map[string]any{"op": "outbox.status"})
	if st["hub"] != "down" || st["pending"] != float64(1) || st["limitBytes"] != float64(outbox.DefaultMaxTotalBytes) {
		t.Fatalf("status %v", st)
	}
	list := e.ok(t, map[string]any{"op": "outbox.list", "states": []string{"pending"}})
	items, _ := list["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("list %v", list)
	}
	it := items[0].(map[string]any)
	if it["key"] != key || it["state"] != "pending" || it["title"] != "Cập nhật task (task t-1)" || strings.Contains(it["title"].(string), "done") {
		t.Fatalf("mục %v", it)
	}
	// Nhóm immediate cần hub trả lời ngay: không xếp hàng.
	_, err := e.call(t, map[string]any{
		"op": "outbox.submit", "transport": "mcp", "kind": "leader_reply", "body": map[string]any{"text": "ok"},
	})
	if remoteCode(err) != "NOT_QUEUEABLE" || !strings.Contains(err.Error(), e.hub.srv.URL) {
		t.Fatalf("immediate khi hub vắng: %v", err)
	}

	// Hub nối lại: vòng gửi gửi mục khi tới giờ thử lại.
	e.idle(t)
	e.hub.down.Store(false)
	e.advance(time.Minute)
	e.svc.tick()
	e.idle(t)
	if e.hub.count() != 1 || e.hub.last().Header.Get("Idempotency-Key") != key {
		t.Fatalf("hub nhận %d lần", e.hub.count())
	}
	if st := e.ok(t, map[string]any{"op": "outbox.status"}); st["hub"] != "up" || st["pending"] != float64(0) {
		t.Fatalf("sau khi nối lại: %v", st)
	}
}

func TestOutboxImmediateSentDirectly(t *testing.T) {
	e := newOBEnv(t)
	resp := e.ok(t, map[string]any{
		"op": "outbox.submit", "transport": "mcp", "kind": "leader_reply",
		"body": map[string]any{"name": "leader_reply", "arguments": map[string]any{"text": "ok"}},
	})
	if resp["state"] != "accepted" || e.hub.count() != 1 || e.hub.last().Args["text"] != "ok" {
		t.Fatalf("immediate: %v, hub %d", resp, e.hub.count())
	}
	if st := e.ok(t, map[string]any{"op": "outbox.status"}); st["pending"] != float64(0) || st["bytes"] != float64(0) {
		t.Fatalf("immediate không ghi đĩa: %v", st)
	}
}

func TestOutboxRejectedDropExport(t *testing.T) {
	e := newOBEnv(t)
	e.hub.outcome = "rejected"
	resp := e.ok(t, taskUpdate("01JBCCCCCCCCCCCCCCCCCCCCCC", 5000))
	result, _ := resp["result"].(map[string]any)
	if resp["state"] != "rejected" || result["code"] != "TASK_CANCELLED" || result["reason"] != "Task đã huỷ." {
		t.Fatalf("bị từ chối: %v", resp)
	}
	// Nộp lại khoá đã bị từ chối: trả lần từ chối cũ, không gửi lại.
	if resp := e.ok(t, taskUpdate("01JBCCCCCCCCCCCCCCCCCCCCCC", 5000)); resp["state"] != "rejected" || e.hub.count() != 1 {
		t.Fatalf("nộp lại: %v, hub %d", resp, e.hub.count())
	}
	e.hub.down.Store(true)
	e.ok(t, taskUpdate("01JBDDDDDDDDDDDDDDDDDDDDDD", 0))
	e.idle(t)

	list := e.ok(t, map[string]any{"op": "outbox.list", "states": []string{"rejected"}})
	items, _ := list["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["result"].(map[string]any)["code"] != "TASK_CANCELLED" {
		t.Fatalf("list %v", list)
	}
	out := filepath.Join(e.home, "export.json")
	if resp := e.ok(t, map[string]any{"op": "outbox.export", "keys": []string{"01JBCCCCCCCCCCCCCCCCCCCCCC"}, "path": out}); resp["count"] != float64(1) {
		t.Fatalf("export %v", resp)
	}
	b, err := os.ReadFile(out)
	if err != nil || !strings.Contains(string(b), `"status": "done"`) || strings.Contains(string(b), obToken) {
		t.Fatalf("file export: %v\n%s", err, b)
	}
	if _, err := e.call(t, map[string]any{"op": "outbox.export", "path": "relative.json"}); remoteCode(err) != localipc.CodeBadRequest {
		t.Fatalf("đường dẫn tương đối: %v", err)
	}
	resp = e.ok(t, map[string]any{"op": "outbox.drop", "keys": []string{"01JBCCCCCCCCCCCCCCCCCCCCCC", "01JBDDDDDDDDDDDDDDDDDDDDDD"}})
	if d, s := resp["dropped"].([]any), resp["skipped"].([]any); len(d) != 1 || len(s) != 1 || s[0] != "01JBDDDDDDDDDDDDDDDDDDDDDD" {
		t.Fatalf("mục chờ gửi không bỏ được: %v", resp)
	}
	if st := e.ok(t, map[string]any{"op": "outbox.status"}); st["rejected"] != float64(0) || st["pending"] != float64(1) {
		t.Fatalf("status %v", st)
	}
}

func TestOutboxNotSignedIn(t *testing.T) {
	e := newOBEnv(t)
	e.svc.creds.Keyring = testKeyring{}
	if _, err := e.call(t, taskUpdate("01JBEEEEEEEEEEEEEEEEEEEEEE", 0)); remoteCode(err) != "NOT_SIGNED_IN" {
		t.Fatalf("chưa đăng nhập: %v", err)
	}
	e.svc.creds.Keyring = testKeyring{outbox.KeyringService + "|" + e.hub.srv.URL: obToken}
	if _, err := e.call(t, map[string]any{"op": "outbox.submit", "transport": "mcp", "kind": "no_such_tool", "body": map[string]any{}}); remoteCode(err) != "UNKNOWN_KIND" {
		t.Fatalf("tool lạ: %v", err)
	}
	if _, err := e.call(t, map[string]any{"op": "outbox.submit", "transport": "worker", "kind": "memory.propose", "body": map[string]any{}}); remoteCode(err) != localipc.CodeBadRequest {
		t.Fatalf("kênh worker không nộp qua socket: %v", err)
	}
}

func TestOutboxHeldUntilRightUserSignsIn(t *testing.T) {
	e := newOBEnv(t)
	an := e.identity("u-an")
	an.Email = "an@example.test"
	it, err := e.svc.store.Submit(an, outbox.Submission{
		Transport: outbox.TransportMCP, Kind: "doc_propose", Target: &outbox.Target{Type: "doc", ID: "d-1"}, Payload: json.RawMessage(`{"docId":"d-1"}`),
	})
	if err != nil {
		t.Fatal(err)
	}
	// Máy đổi sang người khác: mục của An bị giữ, không gửi bằng token của Bình.
	e.signIn(t, "u-binh", "binh@example.test")
	e.svc.tick()
	e.idle(t)
	if e.hub.count() != 0 {
		t.Fatal("gửi mục của An bằng token của Bình")
	}
	list := e.ok(t, map[string]any{"op": "outbox.list", "states": []string{"held"}})
	items, _ := list["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["heldReason"] != outbox.HeldIdentityMismatch {
		t.Fatalf("list %v", list)
	}
	e.signIn(t, "u-an", "an@example.test")
	e.svc.tick()
	e.idle(t)
	if e.hub.count() != 1 || e.hub.last().Header.Get("Idempotency-Key") != it.Key {
		t.Fatalf("An đăng nhập lại thì gửi: hub %d", e.hub.count())
	}
}

func TestOutboxRetryAndBodyFile(t *testing.T) {
	e := newOBEnv(t)
	an := e.identity("u-an")
	it, err := e.svc.store.Submit(an, outbox.Submission{Transport: outbox.TransportRPC, Kind: "memory.write", Payload: json.RawMessage(`{"content":"x"}`)})
	if err != nil {
		t.Fatal(err)
	}
	if err := e.svc.store.Hold(an, it.Key, outbox.HeldLoginRequired); err != nil {
		t.Fatal(err)
	}
	if resp := e.ok(t, map[string]any{"op": "outbox.retry", "keys": []string{it.Key}}); resp["retried"] != float64(1) {
		t.Fatalf("retry %v", resp)
	}
	e.idle(t)
	if e.hub.count() != 1 || e.hub.last().Path != "/rpc/memory/write" {
		t.Fatalf("gửi lại mục được Gửi lại: %d", e.hub.count())
	}

	dir := filepath.Join(e.home, ".xdev-hive", "outbox", outbox.IncomingDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "big.json")
	if err := os.WriteFile(file, []byte(`{"path":"memory/write","input":{"content":"lớn"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	resp := e.ok(t, map[string]any{"op": "outbox.submit", "transport": "rpc", "kind": "memory.write", "bodyFile": file, "waitMs": 5000})
	if resp["state"] != "accepted" || e.hub.last().RPCBody["json"].(map[string]any)["content"] != "lớn" {
		t.Fatalf("bodyFile: %v, hub %+v", resp, e.hub.last())
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("file tạm phải bị xoá: %v", err)
	}
	outside := filepath.Join(e.home, "secret.json")
	if err := os.WriteFile(outside, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := e.call(t, map[string]any{"op": "outbox.submit", "transport": "rpc", "kind": "memory.write", "bodyFile": outside}); remoteCode(err) != localipc.CodeBadRequest {
		t.Fatalf("file ngoài incoming: %v", err)
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatalf("không được xoá file ngoài incoming: %v", err)
	}
}

func TestOutboxWatchEvents(t *testing.T) {
	e := newOBEnv(t)
	var mu sync.Mutex
	var events []map[string]any
	e.svc.setNotify(func(ev any) {
		mu.Lock()
		events = append(events, ev.(map[string]any))
		mu.Unlock()
	})
	seen := func(event string) []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		var out []map[string]any
		for _, ev := range events {
			if ev["event"] == event {
				out = append(out, ev)
			}
		}
		return out
	}

	e.hub.down.Store(true)
	e.ok(t, taskUpdate("01JBFFFFFFFFFFFFFFFFFFFFFF", 5000))
	e.idle(t)
	got := seen("outbox")
	if len(got) == 0 {
		t.Fatal("thiếu sự kiện outbox")
	}
	if last := got[len(got)-1]; last["hub"] != hubDown || last["pending"] != 1 || last["hubUrl"] != nil {
		t.Fatalf("outbox khi hub vắng: %v", last)
	}
	n := len(got)
	// Lượt gửi không đổi gì thì không báo lại.
	e.svc.tick()
	e.idle(t)
	if len(seen("outbox")) != n {
		t.Fatalf("báo lại khi không đổi: %v", seen("outbox")[n:])
	}

	e.hub.down.Store(false)
	e.hub.outcome = "rejected"
	e.advance(time.Minute)
	e.svc.tick()
	e.idle(t)
	items := seen("outbox.item")
	var rejected map[string]any
	for _, it := range items {
		if it["key"] == "01JBFFFFFFFFFFFFFFFFFFFFFF" && it["state"] == "rejected" {
			rejected = it
		}
	}
	if rejected == nil || rejected["code"] != "TASK_CANCELLED" || rejected["reason"] != "Task đã huỷ." {
		t.Fatalf("outbox.item: %v", items)
	}
	got = seen("outbox")
	if last := got[len(got)-1]; last["hub"] != hubUp || last["pending"] != 0 || last["rejected"] != 1 {
		t.Fatalf("outbox sau khi hub trả lời: %v", last)
	}

	e.ok(t, map[string]any{"op": "outbox.drop", "keys": []string{"01JBFFFFFFFFFFFFFFFFFFFFFF"}})
	got = seen("outbox")
	if last := got[len(got)-1]; last["rejected"] != 0 {
		t.Fatalf("outbox sau khi bỏ: %v", last)
	}
}
