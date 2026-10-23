package outbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeUserHub giả `/mcp` và `/rpc` của hub: nhớ khoá để trả `duplicate`, ghi lại header và body của từng lần gọi.
type fakeUserHub struct {
	mu      sync.Mutex
	seen    map[string]bool
	calls   []*http.Request
	bodies  []string
	handler func(w http.ResponseWriter, r *http.Request, body string) bool
}

func newFakeUserHub(t *testing.T) (*fakeUserHub, *httptest.Server) {
	h := &fakeUserHub{seen: map[string]bool{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		h.mu.Lock()
		h.calls, h.bodies = append(h.calls, r), append(h.bodies, string(b))
		handler := h.handler
		h.mu.Unlock()
		if handler != nil && handler(w, r, string(b)) {
			return
		}
		key := r.Header.Get(headerKey)
		h.mu.Lock()
		outcome := "accepted"
		if h.seen[key] {
			outcome = "duplicate"
		}
		h.seen[key] = true
		h.mu.Unlock()
		ev := `{"key":"` + key + `","outcome":"` + outcome + `","receivedAt":"2026-10-23T03:00:01Z"}`
		if r.URL.Path == "/mcp" {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"Đã cập nhật.\"}],\"_meta\":{\""+metaClientEvent+"\":"+ev+"}}}\n\n")
			return
		}
		w.Header().Set(headerResult, ev)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"json":{"id":"m1"}}`)
	}))
	t.Cleanup(srv.Close)
	return h, srv
}

func userSender(token string, err error) UserSender {
	return UserSender{
		Token:     func(context.Context, Identity) (string, error) { return token, err },
		MachineID: "6f1c1b7e-8d7a-4c39-9a51-6a2f0f3c9a10",
		Client:    "hive-worker/test",
	}
}

func submitUser(t *testing.T, s Store, c *clock, id Identity, sub Submission) Item {
	t.Helper()
	c.add(time.Millisecond)
	if sub.Payload == nil {
		sub.Payload = json.RawMessage(`{"taskId":"t1"}`)
	}
	it, err := s.Submit(id, sub)
	if err != nil {
		t.Fatal(err)
	}
	return it
}

func TestUserSenderMCPHeadersAndResponse(t *testing.T) {
	s, c := newStore(t)
	hub, srv := newFakeUserHub(t)
	id := Identity{HubURL: srv.URL, UserID: "u-1"}
	it := submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Project: "p-1", Target: &Target{Type: "task", ID: "t1"}})
	res, err := s.FlushWith(context.Background(), id, userSender("hive_pat_x", nil).Dispatch)
	if err != nil || res.Accepted != 1 || len(res.Items) != 1 {
		t.Fatalf("lượt gửi: %+v %v", res, err)
	}
	if !strings.Contains(string(res.Items[0].Response), "Đã cập nhật.") {
		t.Errorf("kết quả tool phải về cho client: %s", res.Items[0].Response)
	}
	r := hub.calls[0]
	for h, want := range map[string]string{
		"Authorization": "Bearer hive_pat_x", headerKey: it.Key, headerSource: "mcp-local",
		headerMachine: "6f1c1b7e-8d7a-4c39-9a51-6a2f0f3c9a10", headerClient: "hive-worker/test", "X-Hive-Project": "p-1",
		headerCreatedAt: it.CreatedAt.UTC().Format(time.RFC3339Nano),
	} {
		if got := r.Header.Get(h); got != want {
			t.Errorf("header %s = %q, muốn %q", h, got, want)
		}
	}
	var call struct {
		Method string `json:"method"`
		Params struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		} `json:"params"`
	}
	if err := json.Unmarshal([]byte(hub.bodies[0]), &call); err != nil || call.Method != "tools/call" ||
		call.Params.Name != "task_update" || string(call.Params.Arguments) != `{"taskId":"t1"}` {
		t.Errorf("body MCP: %s", hub.bodies[0])
	}
	if strings.Contains(string(mustRead(t, s, id)), "hive_pat_x") {
		t.Error("token không được nằm trong hộp thư đi")
	}
}

func mustRead(t *testing.T, s Store, id Identity) []byte {
	t.Helper()
	sent, err := s.Sent(id)
	if err != nil {
		t.Fatal(err)
	}
	return mustJSON(t, sent)
}

func TestUserSenderMCPOutcomes(t *testing.T) {
	s, c := newStore(t)
	hub, srv := newFakeUserHub(t)
	id := Identity{HubURL: srv.URL, UserID: "u-1"}
	hub.handler = func(w http.ResponseWriter, r *http.Request, body string) bool {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(body, `"rejected-task"`):
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Task đã huỷ."}],"_meta":{"`+metaClientEvent+`":{"key":"`+r.Header.Get(headerKey)+`","outcome":"rejected","code":"TASK_CANCELLED","reason":"Task đã huỷ.","receivedAt":"2026-10-23T03:00:01Z"}}}}`)
		case strings.Contains(body, `"broken-task"`):
			_, _ = io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"isError":true,"content":[{"type":"text","text":"Lỗi hub."}]}}`)
		default:
			return false
		}
		return true
	}
	rej := submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{"taskId":"rejected-task"}`), Target: &Target{Type: "task", ID: "a"}})
	brk := submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{"taskId":"broken-task"}`), Target: &Target{Type: "task", ID: "b"}})
	ok := submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Target: &Target{Type: "task", ID: "c"}})
	res, err := s.FlushWith(context.Background(), id, userSender("hive_pat_x", nil).Dispatch)
	if err != nil || res.Rejected != 1 || res.Retry != 1 || res.Accepted != 1 || res.Offline {
		t.Fatalf("lượt gửi: %+v %v", res, err)
	}
	byKey := map[string]Item{}
	items, _ := s.List(id)
	for _, it := range items {
		byKey[it.Key] = it
	}
	if r := byKey[rej.Key]; r.State != StateRejected || r.Result == nil || r.Result.Code != "TASK_CANCELLED" || r.Result.Reason != "Task đã huỷ." {
		t.Errorf("mục bị từ chối: %+v", r)
	}
	if b := byKey[brk.Key]; b.State != StatePending || b.NextAttemptAt == nil {
		t.Errorf("tool lỗi không có sự kiện phải thử lại: %+v", b)
	}
	if _, left := byKey[ok.Key]; left {
		t.Error("mục được nhận phải rời hộp thư")
	}
}

func TestUserSenderHoldsOn401(t *testing.T) {
	s, c := newStore(t)
	hub, srv := newFakeUserHub(t)
	id := Identity{HubURL: srv.URL, UserID: "u-1"}
	hub.handler = func(w http.ResponseWriter, r *http.Request, body string) bool {
		if strings.Contains(body, `"a1"`) {
			w.WriteHeader(http.StatusUnauthorized)
			return true
		}
		return false
	}
	a1 := submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{"taskId":"a1"}`), Target: &Target{Type: "task", ID: "a"}})
	submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{"taskId":"a2"}`), Target: &Target{Type: "task", ID: "a"}})
	submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Payload: json.RawMessage(`{"taskId":"b1"}`), Target: &Target{Type: "task", ID: "b"}})
	res, err := s.FlushWith(context.Background(), id, userSender("hive_pat_old", nil).Dispatch)
	items, _ := s.List(id)
	if err != nil || res.Held != 1 || res.Accepted != 1 || len(items) != 2 || items[1].State != StatePending {
		t.Fatalf("401 chỉ giữ stream của nó: %+v %+v %v", res, items, err)
	}
	if items[0].Key != a1.Key || items[0].State != StateHeld || items[0].HeldReason != HeldLoginRequired {
		t.Errorf("mục bị giữ: %+v", items[0])
	}

	s2, c2 := newStore(t)
	submitUser(t, s2, c2, id, Submission{Transport: TransportMCP, Kind: "task_update"})
	if res, _ := s2.FlushWith(context.Background(), id, userSender("", ErrLoginRequired).Dispatch); res.Held != 1 || len(hub.calls) != 2 {
		t.Errorf("chưa đăng nhập thì giữ, không gọi hub: %+v (%d lần gọi)", res, len(hub.calls))
	}
}

func TestUserSenderRPC(t *testing.T) {
	s, c := newStore(t)
	hub, srv := newFakeUserHub(t)
	id := Identity{HubURL: srv.URL, UserID: "u-1"}
	hub.handler = func(w http.ResponseWriter, r *http.Request, body string) bool {
		switch {
		case strings.Contains(body, `"conflict"`):
			w.Header().Set(headerResult, `{"key":"`+r.Header.Get(headerKey)+`","outcome":"rejected","code":"MEMORY_DUPLICATE","reason":"Đã có memory này.","receivedAt":"2026-10-23T03:00:01Z"}`)
			w.WriteHeader(http.StatusConflict)
			_, _ = io.WriteString(w, `{"json":{"code":"MEMORY_DUPLICATE","message":"Đã có memory này."}}`)
		case strings.Contains(body, `"invalid"`):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"json":{"code":"BAD_REQUEST","message":"Input validation failed"}}`)
		default:
			return false
		}
		return true
	}
	ok := submitUser(t, s, c, id, Submission{Transport: TransportRPC, Kind: "memory.write", Payload: json.RawMessage(`{"text":"ok"}`), Target: &Target{Type: "memory", ID: "1"}})
	submitUser(t, s, c, id, Submission{Transport: TransportRPC, Kind: "memory.write", Payload: json.RawMessage(`{"text":"conflict"}`), Target: &Target{Type: "memory", ID: "2"}})
	submitUser(t, s, c, id, Submission{Transport: TransportRPC, Kind: "memory.write", Payload: json.RawMessage(`{"text":"invalid"}`), Target: &Target{Type: "memory", ID: "3"}})
	res, err := s.FlushWith(context.Background(), id, userSender("hive_pat_x", nil).Dispatch)
	if err != nil || res.Accepted != 1 || res.Rejected != 2 {
		t.Fatalf("lượt gửi: %+v %v", res, err)
	}
	if hub.calls[0].URL.Path != "/rpc/memory/write" || hub.bodies[0] != `{"json":{"text":"ok"}}` || hub.calls[0].Header.Get(headerSource) != "hive-cli" {
		t.Errorf("yêu cầu oRPC: %s %s %s", hub.calls[0].URL.Path, hub.bodies[0], hub.calls[0].Header.Get(headerSource))
	}
	for _, o := range res.Items {
		switch {
		case o.Key == ok.Key && string(o.Response) != `{"id":"m1"}`:
			t.Errorf("kết quả procedure: %s", o.Response)
		case o.State == StateRejected && o.Code != "MEMORY_DUPLICATE" && o.Code != "HTTP_400":
			t.Errorf("mã từ chối: %+v", o)
		}
	}
}

func TestUserSenderOffline(t *testing.T) {
	s, c := newStore(t)
	_, srv := newFakeUserHub(t)
	id := Identity{HubURL: srv.URL, UserID: "u-1"}
	srv.Close()
	submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Target: &Target{Type: "task", ID: "a"}})
	submitUser(t, s, c, id, Submission{Transport: TransportMCP, Kind: "task_update", Target: &Target{Type: "task", ID: "b"}})
	res, err := s.FlushWith(context.Background(), id, userSender("hive_pat_x", nil).Dispatch)
	if err != nil || !res.Offline || res.Retry != 1 || res.Waiting != 1 {
		t.Errorf("hub vắng thì dừng cả lượt: %+v %v", res, err)
	}
}
