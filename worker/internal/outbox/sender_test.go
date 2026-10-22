package outbox

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"sync"
	"testing"
	"time"
)

// TestMain cho phép test chạy lại chính binary test làm tiến trình gửi, để giết nó thật giữa lúc đang gửi.
func TestMain(m *testing.M) {
	if root := os.Getenv("OUTBOX_HELPER_ROOT"); root != "" {
		id := Identity{HubURL: os.Getenv("OUTBOX_HELPER_HUB"), MachineID: "may-1"}
		s := Store{Root: root}
		if _, err := s.Flush(context.Background(), id, HubSender(http.DefaultClient, id.HubURL, "hwm_test")); err != nil {
			os.Exit(3)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// hubDedup giả hub: ghi sự kiện (theo khoá) trước khi trả lời, như withClientEvent ghi trong transaction rồi mới trả.
type hubDedup struct {
	mu       sync.Mutex
	seen     map[string]bool
	requests int
	applied  int
	hang     bool
	arrived  chan struct{}
}

func (h *hubDedup) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/v1/client-events" || r.Header.Get("Authorization") != "Bearer hwm_test" {
		http.Error(w, "sai đường dẫn", http.StatusNotFound)
		return
	}
	b, _ := io.ReadAll(r.Body)
	var ev struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal(b, &ev)
	h.mu.Lock()
	h.requests++
	outcome := "duplicate"
	if !h.seen[ev.Key] {
		h.seen[ev.Key] = true
		h.applied++
		outcome = "accepted"
	}
	hang := h.hang
	h.mu.Unlock()
	if hang {
		// Hub đã ghi nhưng trả lời không tới được tiến trình gửi: báo test giết tiến trình.
		close(h.arrived)
		<-r.Context().Done()
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"key": ev.Key, "outcome": outcome, "receivedAt": "2026-10-22T03:00:01Z"})
}

// SC-006: tiến trình gửi bị giết thật khi đang ở `sending` (hub đã ghi, chưa kịp trả lời). Lần chạy sau gửi lại cùng
// khoá và hub chỉ thực hiện việc một lần.
func TestKilledSenderProcessIsExactlyOnce(t *testing.T) {
	if testing.Short() {
		t.Skip("chạy tiến trình con")
	}
	hub := &hubDedup{seen: map[string]bool{}, hang: true, arrived: make(chan struct{})}
	srv := httptest.NewServer(hub)
	defer srv.Close()

	root := t.TempDir()
	id := Identity{HubURL: srv.URL, MachineID: "may-1"}
	s := Store{Root: root}
	it, err := s.Submit(id, Submission{Kind: KindTokenScore, Payload: json.RawMessage(`{"days":7}`)})
	if err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), "OUTBOX_HELPER_ROOT="+root, "OUTBOX_HELPER_HUB="+srv.URL)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-hub.arrived:
	case <-time.After(60 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("tiến trình con không gửi tới hub")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()

	items, err := s.List(id)
	if err != nil || len(items) != 1 || items[0].State != StateSending {
		t.Fatalf("sau khi bị giết: %+v %v", items, err)
	}

	hub.mu.Lock()
	hub.hang = false
	hub.mu.Unlock()
	res, err := s.Flush(context.Background(), id, HubSender(srv.Client(), srv.URL, "hwm_test"))
	if err != nil {
		t.Fatal(err)
	}
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.applied != 1 || hub.requests != 2 || res.Duplicate != 1 {
		t.Fatalf("hub thực hiện %d lần qua %d yêu cầu, kết quả %+v", hub.applied, hub.requests, res)
	}
	if items, _ := s.List(id); len(items) != 0 {
		t.Errorf("còn mục: %+v", items)
	}
	if sent, _ := s.Sent(id); len(sent) != 1 || sent[0].Key != it.Key {
		t.Errorf("sent.jsonl: %+v", sent)
	}
}
