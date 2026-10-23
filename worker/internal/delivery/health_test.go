package delivery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthRetriesUntilOK(t *testing.T) {
	n := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n++
		if n < 3 {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"status":{"state":"UP"}}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	res := RunHealth(ctx, HealthCheck{URL: srv.URL + "/health", Interval: 10 * time.Millisecond, Match: &HealthMatch{Path: "status.state", Equals: "UP"}})
	if !res.OK || res.Attempts != 3 {
		t.Fatalf("res = %+v", res)
	}
}

func TestHealthFailureMessageNamesOnlyHost(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	res := RunHealth(ctx, HealthCheck{URL: srv.URL + "/health?token=abc123", Interval: 20 * time.Millisecond})
	if res.OK || strings.Contains(res.Message, "abc123") || strings.Contains(res.Message, "/health") {
		t.Fatalf("res = %+v", res)
	}
}

func TestHealthDoesNotFollowRedirect(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/login", http.StatusFound)
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if res := RunHealth(ctx, HealthCheck{URL: srv.URL, Interval: 20 * time.Millisecond}); res.OK {
		t.Fatalf("3xx không được tính là đạt: %+v", res)
	}
}

func TestHealthMatchMismatchAndBadURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"ok":"no"}`))
	}))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if res := RunHealth(ctx, HealthCheck{URL: srv.URL, Interval: 20 * time.Millisecond, Match: &HealthMatch{Path: "ok", Equals: "yes"}}); res.OK {
		t.Fatalf("res = %+v", res)
	}
	if res := RunHealth(context.Background(), HealthCheck{URL: "ftp://x"}); res.OK {
		t.Fatalf("res = %+v", res)
	}
}
