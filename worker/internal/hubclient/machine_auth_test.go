package hubclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

type fixedSigner struct{ hub, machine, nonce string }

func (s *fixedSigner) Sign(hubURL, machineID, nonce string) string {
	s.hub, s.machine, s.nonce = hubURL, machineID, nonce
	return "sig-" + nonce
}

func tokenHub(t *testing.T, exp time.Time, status int) (*httptest.Server, *atomic.Int32) {
	var tokens atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/worker/challenge":
			if r.URL.Query().Get("machine") != "id-1" {
				t.Errorf("challenge cho máy %q", r.URL.Query().Get("machine"))
			}
			_, _ = w.Write([]byte(`{"nonce":"n1","expiresAt":"2026-10-23T00:01:00Z"}`))
		case "/api/v1/worker/token":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["machineId"] != "id-1" || body["nonce"] != "n1" || body["signature"] != "sig-n1" {
				t.Errorf("body đổi token = %v", body)
			}
			if status != http.StatusOK {
				w.WriteHeader(status)
				_, _ = w.Write([]byte(`{"message":"Máy không xác thực được."}`))
				return
			}
			tokens.Add(1)
			_, _ = w.Write([]byte(`{"accessToken":"hwa_1","expiresAt":"` + exp.UTC().Format(time.RFC3339Nano) + `"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &tokens
}

func TestTokenSourceCachesUntilRefresh(t *testing.T) {
	now := time.Date(2026, 10, 23, 0, 0, 0, 0, time.UTC)
	srv, tokens := tokenHub(t, now.Add(15*time.Minute), http.StatusOK)
	signer := &fixedSigner{}
	ts := &TokenSource{Client: New(srv.URL), HubURL: srv.URL + "/", MachineID: "id-1", Key: signer, Now: func() time.Time { return now }}
	ctx := context.Background()
	token, exp, err := ts.Token(ctx, false)
	if err != nil || token != "hwa_1" || !exp.Equal(now.Add(15*time.Minute)) {
		t.Fatalf("Token = %q %v %v", token, exp, err)
	}
	if signer.hub != srv.URL+"/" || signer.machine != "id-1" || signer.nonce != "n1" {
		t.Fatalf("ký với %+v", signer)
	}
	if _, _, _ = ts.Token(ctx, false); tokens.Load() != 1 {
		t.Fatalf("còn hạn mà đổi token %d lần", tokens.Load())
	}
	now = now.Add(13*time.Minute + time.Second)
	if _, _, _ = ts.Token(ctx, false); tokens.Load() != 2 {
		t.Fatal("còn dưới RefreshBefore phải đổi token mới")
	}
	if _, _, _ = ts.Token(ctx, true); tokens.Load() != 3 {
		t.Fatal("fresh phải đổi token mới")
	}
}

func TestTokenSourceAuthFailed(t *testing.T) {
	srv, _ := tokenHub(t, time.Now(), http.StatusUnauthorized)
	ts := &TokenSource{Client: New(srv.URL), HubURL: srv.URL, MachineID: "id-1", Key: &fixedSigner{}}
	_, _, err := ts.Token(context.Background(), false)
	if !IsAuthFailed(err) {
		t.Fatalf("err = %v, cần lỗi xác thực", err)
	}
	if IsAuthFailed(&StatusError{Status: http.StatusBadGateway}) {
		t.Fatal("502 không phải lỗi xác thực")
	}
}

func TestRegisterKeySendsMachineToken(t *testing.T) {
	var auth string
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"machineId":"id-1","registeredAt":"2026-10-23T00:00:00Z"}`))
	}))
	defer srv.Close()
	id, err := New(srv.URL).RegisterKey(context.Background(), "hwm_x", "pub", "file")
	if err != nil || id != "id-1" {
		t.Fatalf("RegisterKey = %q, %v", id, err)
	}
	if auth != "Bearer hwm_x" || body["publicKey"] != "pub" || body["keyStorage"] != "file" {
		t.Fatalf("auth %q body %v", auth, body)
	}
}
