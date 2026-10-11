package hubclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/health" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","version":"1.2.3","time":"2026-10-11T00:00:00Z"}`))
	}))
	defer srv.Close()

	h, err := New(srv.URL + "/").Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if h.Version != "1.2.3" {
		t.Fatalf("version = %q", h.Version)
	}
}

func TestHealthErrorStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()

	if _, err := New(srv.URL).Health(context.Background()); err == nil {
		t.Fatal("cần lỗi khi hub trả 503")
	}
}
