package hubclient

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPostClientEvent(t *testing.T) {
	var got map[string]any
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/client-events" || r.Header.Get("Authorization") != "Bearer hwm_x" ||
			r.Header.Get("Content-Type") != "application/json" {
			t.Errorf("yêu cầu: %s %v", r.URL.Path, r.Header)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.WriteHeader(status)
		if status == http.StatusOK {
			_, _ = w.Write([]byte(`{"key":"k","outcome":"duplicate","receivedAt":"2026-10-13T03:00:00Z"}`))
			return
		}
		_, _ = w.Write([]byte(`{"message":"Machine token không hợp lệ."}`))
	}))
	defer srv.Close()
	ev := ClientEvent{Key: "0123456789abcdef", Kind: "machine.token_score", CreatedAt: "2026-10-13T03:00:00Z",
		Payload: json.RawMessage(`{"days":7}`)}

	res, err := PostClientEvent(context.Background(), srv.Client(), srv.URL+"/", "hwm_x", ev)
	if err != nil || res.Outcome != OutcomeDuplicate {
		t.Fatalf("kết quả: %+v %v", res, err)
	}
	if got["key"] != ev.Key || got["kind"] != ev.Kind || got["payload"].(map[string]any)["days"] != float64(7) {
		t.Errorf("body: %v", got)
	}

	for _, tc := range []struct {
		status    int
		retryable bool
	}{{http.StatusUnauthorized, false}, {http.StatusBadRequest, false}, {http.StatusServiceUnavailable, true}} {
		status = tc.status
		_, err := PostClientEvent(context.Background(), srv.Client(), srv.URL, "hwm_x", ev)
		var se *StatusError
		if !errors.As(err, &se) || se.Status != tc.status || se.Retryable() != tc.retryable {
			t.Errorf("mã %d: %v", tc.status, err)
		}
	}
}
