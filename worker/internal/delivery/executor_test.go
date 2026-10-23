package delivery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type sink struct {
	mu sync.Mutex
	ev []Event
}

func (s *sink) add(e Event) { s.mu.Lock(); s.ev = append(s.ev, e); s.mu.Unlock() }

func (s *sink) last() Event { s.mu.Lock(); defer s.mu.Unlock(); return s.ev[len(s.ev)-1] }

const jobA = "11111111-1111-4111-8111-111111111111"

func newExec(t *testing.T, reg string, store MapCredentials, s *sink) *Executor {
	t.Helper()
	return &Executor{Scope: Scope{RegistrationID: reg}, Store: store, LogRoot: t.TempDir(), WorkerID: "w1", Emit: s.add, Poll: 10 * time.Millisecond}
}

func TestExecutorMissingCredentialRunsNothing(t *testing.T) {
	s := &sink{}
	e := newExec(t, "reg-a", MapCredentials{}, s)
	err := e.Run(context.Background(), JobSpec{JobID: jobA, Kind: "argocd", Credential: "argo-prod", Target: map[string]any{"baseUrl": "http://127.0.0.1:1", "app": "x"}})
	if CodeOf(err) != CodeMissingCredential {
		t.Fatalf("err = %v", err)
	}
	last := s.last()
	if last["type"] != "finished" || last["state"] != "failed" {
		t.Fatalf("last = %v", last)
	}
	if code := last["error"].(Event)["code"]; code != "missing_credential" {
		t.Fatalf("code = %v", code)
	}
}

// Cùng tên credential ở hai đăng ký khác nhau không được đọc nhầm của nhau.
func TestExecutorCredentialsAreScopedPerRegistration(t *testing.T) {
	store := MapCredentials{"delivery/reg-b/argo-prod": "tok-b"}
	s := &sink{}
	e := newExec(t, "reg-a", store, s)
	err := e.Run(context.Background(), JobSpec{JobID: jobA, Kind: "argocd", Credential: "argo-prod", Target: map[string]any{"baseUrl": "http://127.0.0.1:1", "app": "x"}})
	if CodeOf(err) != CodeMissingCredential {
		t.Fatalf("đăng ký A không được thấy credential của B: %v", err)
	}
}

func TestExecutorLogsGoToScopedDirAndMaskSecrets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(fixture(t, "argocd", "application-synced.json"))
	}))
	defer srv.Close()
	store := MapCredentials{"delivery/reg-a/argo-prod": "super-secret-token"}
	s := &sink{}
	e := newExec(t, "reg-a", store, s)
	spec := JobSpec{JobID: jobA, Kind: "argocd", Credential: "argo-prod", Target: map[string]any{"baseUrl": srv.URL, "app": "his-portal"}, TimeoutSeconds: 5}
	if err := e.Run(context.Background(), spec); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(e.Scope.LogDir(e.LogRoot), jobA+".log")
	b, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "super-secret-token") {
		t.Fatal("log lộ bí mật")
	}
	if !strings.Contains(logPath, "reg-a") {
		t.Fatalf("log phải nằm dưới thư mục của đăng ký: %s", logPath)
	}
	// seq tăng dần từ 0 và không có sự kiện nào mang thân log.
	for i, ev := range s.ev {
		if ev["seq"] != i {
			t.Fatalf("seq[%d] = %v", i, ev["seq"])
		}
		if _, has := ev["log"]; has {
			t.Fatal("sự kiện không được mang log")
		}
	}
	if s.last()["state"] != "succeeded" {
		t.Fatalf("last = %v", s.last())
	}
}

func TestExecutorHealthJob(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(200) }))
	defer srv.Close()
	s := &sink{}
	e := newExec(t, "reg-a", nil, s)
	if err := e.Run(context.Background(), JobSpec{JobID: jobA, Kind: "health", Target: map[string]any{"url": srv.URL}, TimeoutSeconds: 5}); err != nil {
		t.Fatal(err)
	}
	if s.last()["state"] != "succeeded" {
		t.Fatalf("last = %v", s.last())
	}
}

func TestExecutorUnsupportedKindAndInvalidScope(t *testing.T) {
	s := &sink{}
	e := newExec(t, "reg-a", nil, s)
	if err := e.Run(context.Background(), JobSpec{JobID: jobA, Kind: "ssh-script"}); CodeOf(err) != CodeUnsupported {
		t.Fatalf("err = %v", err)
	}
	bad := newExec(t, "../x", nil, &sink{})
	if err := bad.Run(context.Background(), JobSpec{JobID: jobA, Kind: "health"}); CodeOf(err) != CodeBadRequest {
		t.Fatalf("err = %v", err)
	}
}

func TestExecutorTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(500) }))
	defer srv.Close()
	s := &sink{}
	e := newExec(t, "reg-a", nil, s)
	err := e.Run(context.Background(), JobSpec{JobID: jobA, Kind: "health", Target: map[string]any{"url": srv.URL}, TimeoutSeconds: 1})
	if err == nil || s.last()["state"] != "failed" {
		t.Fatalf("err = %v, last = %v", err, s.last())
	}
}
