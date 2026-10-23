package delivery

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Fixture dùng chung với client TypeScript ở hub để hai bên hiểu cùng một dạng JSON.
func fixture(t *testing.T, parts ...string) []byte {
	t.Helper()
	p := filepath.Join(append([]string{"..", "..", "..", "apps", "hub", "src", "modules", "delivery", "fixtures"}, parts...)...)
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatalf("đọc fixture %s: %v", p, err)
	}
	return b
}

func TestJenkinsJobPath(t *testing.T) {
	got, err := JenkinsJobPath("acme/build dev/v3")
	if err != nil || got != "/job/acme/job/build%20dev/job/v3" {
		t.Fatalf("got %q, %v", got, err)
	}
	for _, bad := range []string{"", "a//b", "a/../b", "."} {
		if _, err := JenkinsJobPath(bad); CodeOf(err) != CodeBadRequest {
			t.Errorf("%q phải bị từ chối, got %v", bad, err)
		}
	}
}

func TestNewJenkinsRejectsBadCredential(t *testing.T) {
	for _, cred := range []string{"", "user", "user:", ":token"} {
		if _, err := NewJenkins("http://jenkins.test", []byte(cred), 0); CodeOf(err) != CodeBadRequest {
			t.Errorf("%q phải bị từ chối", cred)
		}
	}
}

func TestJenkinsTriggerWaitsForBuildNumber(t *testing.T) {
	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("bot:s3cret"))
	var form string
	polls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != wantAuth {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/job/acme/job/build/buildWithParameters":
			b := make([]byte, 256)
			n, _ := r.Body.Read(b)
			form = string(b[:n])
			if r.URL.RawQuery != "" {
				t.Errorf("tham số không được nằm trên URL: %s", r.URL.RawQuery)
			}
			w.Header().Set("Location", "http://"+r.Host+"/queue/item/7001/")
			w.WriteHeader(201)
		case r.URL.Path == "/queue/item/7001/api/json":
			polls++
			if polls == 1 {
				_, _ = w.Write(fixture(t, "jenkins", "queue-item-waiting.json"))
				return
			}
			_, _ = w.Write(fixture(t, "jenkins", "queue-item-started.json"))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()

	j, err := NewJenkins(srv.URL, []byte("bot:s3cret"), 0)
	if err != nil {
		t.Fatal(err)
	}
	res, err := j.Trigger(context.Background(), "acme/build", map[string]string{"BRANCH": "main"}, 5*time.Second, 10*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	if res.QueueID != 7001 || res.Number != 43 || res.Cancelled {
		t.Fatalf("res = %+v", res)
	}
	if !strings.Contains(form, "BRANCH=main") {
		t.Fatalf("form = %q", form)
	}
}

func TestJenkinsTriggerCancelled(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			w.Header().Set("Location", "http://"+r.Host+"/queue/item/7002/")
			w.WriteHeader(201)
			return
		}
		_, _ = w.Write(fixture(t, "jenkins", "queue-item-cancelled.json"))
	}))
	defer srv.Close()
	j, _ := NewJenkins(srv.URL, []byte("bot:tok"), 0)
	res, err := j.Trigger(context.Background(), "a", nil, time.Second, 10*time.Millisecond)
	if err != nil || !res.Cancelled {
		t.Fatalf("res = %+v, err = %v", res, err)
	}
}

func TestJenkinsBuildAndLog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/job/acme/job/build-dev-v3/40/api/json":
			_, _ = w.Write(fixture(t, "jenkins", "build-success.json"))
		case "/job/acme/job/build-dev-v3/40/logText/progressiveText":
			if r.URL.Query().Get("start") != "5" {
				t.Errorf("start = %q", r.URL.Query().Get("start"))
			}
			w.Header().Set("X-Text-Size", "11")
			w.Header().Set("X-More-Data", "true")
			_, _ = w.Write([]byte("lo wor"))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	j, _ := NewJenkins(srv.URL, []byte("bot:tok"), 0)

	b, err := j.Build(context.Background(), "acme/build-dev-v3", 40)
	if err != nil || b.Number != 40 || b.Result != "SUCCESS" || b.Building {
		t.Fatalf("build = %+v, err = %v", b, err)
	}
	l, err := j.Log(context.Background(), "acme/build-dev-v3", 40, 5)
	if err != nil || l.Text != "lo wor" || l.Next != 11 || !l.More {
		t.Fatalf("log = %+v, err = %v", l, err)
	}
}

func TestJenkinsErrorsDoNotLeakToken(t *testing.T) {
	cases := map[int]Code{401: CodeAuthFailed, 403: CodeForbidden, 404: CodeNotFound, 500: CodeUnavailable}
	for status, want := range cases {
		status := status
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = w.Write([]byte("token=s3cret-value"))
		}))
		j, _ := NewJenkins(srv.URL, []byte("bot:s3cret-value"), 0)
		_, err := j.Build(context.Background(), "a", 1)
		srv.Close()
		if CodeOf(err) != want {
			t.Errorf("status %d: code = %v, want %v", status, CodeOf(err), want)
		}
		if err != nil && strings.Contains(err.Error(), "s3cret-value") {
			t.Errorf("lỗi lộ token: %v", err)
		}
	}
}

func TestJenkinsRedirectToLoginIsAuthFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/securityRealm/commenceLogin", http.StatusFound)
	}))
	defer srv.Close()
	j, _ := NewJenkins(srv.URL, []byte("bot:tok"), 0)
	if err := j.Stop(context.Background(), "a", 1); CodeOf(err) != CodeAuthFailed {
		t.Fatalf("got %v", err)
	}
}

func TestJenkinsPendingInputsAndProceed(t *testing.T) {
	var proceeded string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/wfapi/pendingInputActions"):
			_, _ = w.Write(fixture(t, "jenkins", "wfapi-pending-input-actions.json"))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/proceed"):
			proceeded = r.URL.Path
			w.Header().Set("Location", "/job/a/1/")
			w.WriteHeader(302)
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	j, _ := NewJenkins(srv.URL, []byte("bot:tok"), 0)
	ins, err := j.PendingInputs(context.Background(), "a", 1)
	if err != nil || len(ins) == 0 || ins[0].ID == "" {
		t.Fatalf("inputs = %+v, err = %v", ins, err)
	}
	if err := j.InputProceed(context.Background(), "a", 1, ins[0].ID); err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(proceeded, "/input/"+ins[0].ID+"/proceed") {
		t.Fatalf("proceeded = %q", proceeded)
	}
}
