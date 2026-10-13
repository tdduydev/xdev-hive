package hubclient

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
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

// Hub mới trả `clis`: worker khai Antigravity. Hub cũ không trả hay không gọi được: chỉ khai CLI mọi hub nhận, vì hub cũ
// từ chối cả hello và đăng ký khi có CLI lạ. Máy chỉ có CLI cũ thì không hỏi health.
func TestSupportedCLIs(t *testing.T) {
	var calls atomic.Int32
	hub := func(body string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(body))
		}))
	}
	newHub := hub(`{"status":"ok","version":"2","time":"2026-10-13T00:00:00Z","clis":["claude","codex","gemini","antigravity"]}`)
	defer newHub.Close()
	oldHub := hub(`{"status":"ok","version":"1","time":"2026-10-13T00:00:00Z"}`)
	defer oldHub.Close()
	down := httptest.NewServer(http.NotFoundHandler())
	down.Close()

	for _, tc := range []struct {
		name          string
		url           string
		detected      []string
		kept, dropped []string
	}{
		{"hub mới", newHub.URL, []string{"claude", "antigravity"}, []string{"claude", "antigravity"}, nil},
		{"hub cũ", oldHub.URL, []string{"claude", "antigravity"}, []string{"claude"}, []string{"antigravity"}},
		{"không gọi được hub", down.URL, []string{"antigravity", "codex"}, []string{"codex"}, []string{"antigravity"}},
		{"không có CLI", oldHub.URL, nil, []string{}, nil},
	} {
		kept, dropped := New(tc.url).SupportedCLIs(context.Background(), tc.detected)
		if !slices.Equal(kept, tc.kept) || kept == nil || !slices.Equal(dropped, tc.dropped) {
			t.Fatalf("%s: kept=%v dropped=%v", tc.name, kept, dropped)
		}
	}
	calls.Store(0)
	if kept, _ := New(newHub.URL).SupportedCLIs(context.Background(), []string{"claude", "gemini"}); !slices.Equal(kept, []string{"claude", "gemini"}) || calls.Load() != 0 {
		t.Fatalf("kept=%v, gọi health %d lần", kept, calls.Load())
	}
}
