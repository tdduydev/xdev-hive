package main

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/outbox"
)

func (e *obEnv) logout(t *testing.T, action string) map[string]any {
	t.Helper()
	resp := e.ok(t, map[string]any{"op": "outbox.logout", "hubUrl": e.hub.srv.URL + "/", "action": action, "waitMs": 5000})
	e.idle(t)
	return resp
}

func TestOutboxLogoutKeepSendDrop(t *testing.T) {
	e := newOBEnv(t)
	e.hub.down.Store(true)
	e.ok(t, taskUpdate("01JBLAAAAAAAAAAAAAAAAAAAAA", 0))
	e.ok(t, taskUpdate("01JBLBBBBBBBBBBBBBBBBBBBBB", 0))
	e.idle(t)
	if resp := e.logout(t, "count"); resp["pending"] != float64(2) || resp["held"] != float64(0) {
		t.Fatalf("count %v", resp)
	}

	// Giữ lại: mục nằm ở held, nhịp gửi sau (hub đã về) không gửi bằng token sắp bị xoá.
	if resp := e.logout(t, "keep"); resp["pending"] != float64(0) || resp["held"] != float64(2) {
		t.Fatalf("keep %v", resp)
	}
	e.hub.down.Store(false)
	e.svc.tick()
	e.idle(t)
	if e.hub.count() != 0 {
		t.Fatalf("mục giữ lại vẫn được gửi: hub %d", e.hub.count())
	}

	// Gửi trước: thử lại mục đang giữ bằng token hiện tại.
	if resp := e.logout(t, "send"); resp["pending"] != float64(0) || resp["held"] != float64(0) || e.hub.count() != 2 {
		t.Fatalf("send %v, hub %d", resp, e.hub.count())
	}

	// Hub vắng lúc gửi trước: mục chưa tới hub thì giữ lại, không mất.
	e.hub.down.Store(true)
	e.ok(t, taskUpdate("01JBLCCCCCCCCCCCCCCCCCCCCC", 0))
	e.idle(t)
	if resp := e.logout(t, "send"); resp["pending"] != float64(0) || resp["held"] != float64(1) {
		t.Fatalf("send khi hub vắng %v", resp)
	}

	e.ok(t, taskUpdate("01JBLDDDDDDDDDDDDDDDDDDDDD", 0))
	e.idle(t)
	if resp := e.logout(t, "drop"); resp["dropped"] != float64(2) || resp["pending"] != float64(0) || resp["held"] != float64(0) {
		t.Fatalf("drop %v", resp)
	}
	if st := e.ok(t, map[string]any{"op": "outbox.status"}); st["pending"] != float64(0) || st["held"] != float64(0) {
		t.Fatalf("status %v", st)
	}
	if _, err := e.call(t, map[string]any{"op": "outbox.logout", "hubUrl": e.hub.srv.URL, "action": "xoa"}); remoteCode(err) != localipc.CodeBadRequest {
		t.Fatalf("action lạ: %v", err)
	}
}

func TestOutboxLogoutOtherUsersUntouched(t *testing.T) {
	e := newOBEnv(t)
	binh := e.identity("u-binh")
	if _, err := e.svc.store.Submit(binh, outbox.Submission{
		Transport: outbox.TransportMCP, Kind: "doc_propose", Target: &outbox.Target{Type: "doc", ID: "d-1"}, Payload: json.RawMessage(`{"docId":"d-1"}`),
	}); err != nil {
		t.Fatal(err)
	}
	// An đăng xuất và bỏ mục: mục của Bình trên cùng máy còn nguyên.
	if resp := e.logout(t, "drop"); resp["dropped"] != float64(0) {
		t.Fatalf("drop %v", resp)
	}
	if st, _ := e.svc.store.Stats(binh); st.Pending != 1 {
		t.Fatalf("mục của Bình %+v", st)
	}

	// Không biết ai đang đăng nhập hub: đếm vẫn được, bỏ thì không.
	b, _ := json.Marshal(map[string]string{"hubUrl": "http://hub-khac.test"})
	if err := os.WriteFile(e.login, b, 0o600); err != nil {
		t.Fatal(err)
	}
	if resp := e.logout(t, "count"); resp["pending"] != float64(1) {
		t.Fatalf("count %v", resp)
	}
	if _, err := e.call(t, map[string]any{"op": "outbox.logout", "hubUrl": e.hub.srv.URL, "action": "drop"}); remoteCode(err) != "UNKNOWN_IDENTITY" {
		t.Fatalf("bỏ khi không rõ người: %v", err)
	}
}
