package delivery

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func parseFixtureApp(t *testing.T, name string) ArgoApp {
	t.Helper()
	var raw obj
	if err := json.Unmarshal(fixture(t, "argocd", name), &raw); err != nil {
		t.Fatal(err)
	}
	return ParseArgoApp(raw)
}

func TestParseArgoAppSynced(t *testing.T) {
	app := parseFixtureApp(t, "application-synced.json")
	if app.Name != "his-portal" || app.SyncStatus != "Synced" || app.Health != "Healthy" || !app.AutoSync {
		t.Fatalf("app = %+v", app)
	}
	if app.OpPhase != "Succeeded" || len(app.History) != 3 || app.History[2].ID != 2 {
		t.Fatalf("op/history = %+v", app)
	}
}

func TestParseArgoAppFailed(t *testing.T) {
	app := parseFixtureApp(t, "application-failed.json")
	if app.OpPhase == "Succeeded" || app.OpPhase == "" {
		t.Fatalf("phase = %q", app.OpPhase)
	}
}

func TestArgoSyncSendsRevisionAndBearer(t *testing.T) {
	var gotBody, gotAuth, gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		gotBody, gotAuth, gotPath = string(b), r.Header.Get("Authorization"), r.URL.Path
		_, _ = w.Write(fixture(t, "argocd", "application-syncing.json"))
	}))
	defer srv.Close()
	a, err := NewArgoCD(srv.URL, []byte("tok-123"), 0)
	if err != nil {
		t.Fatal(err)
	}
	app, err := a.Sync(context.Background(), "his-portal", "abc")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/api/v1/applications/his-portal/sync" || gotAuth != "Bearer tok-123" || !strings.Contains(gotBody, `"revision":"abc"`) {
		t.Fatalf("path=%q auth=%q body=%q", gotPath, gotAuth, gotBody)
	}
	if app.Name == "" {
		t.Fatalf("app = %+v", app)
	}
}

func TestArgoRejectsBadNameAndMapsErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		_, _ = w.Write([]byte("tok-123 is not allowed"))
	}))
	defer srv.Close()
	a, _ := NewArgoCD(srv.URL, []byte("tok-123"), 0)
	if _, err := a.GetApplication(context.Background(), "../x"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	_, err := a.GetApplication(context.Background(), "his-portal")
	if CodeOf(err) != CodeForbidden || strings.Contains(err.Error(), "tok-123") {
		t.Fatalf("got %v", err)
	}
}
