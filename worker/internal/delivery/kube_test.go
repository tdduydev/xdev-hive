package delivery

import (
	"context"
	"encoding/json"
	"encoding/pem"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func fixtureWorkload(t *testing.T, kind WorkloadKind, file string) Workload {
	t.Helper()
	var raw obj
	if err := json.Unmarshal(fixture(t, "kube", file), &raw); err != nil {
		t.Fatal(err)
	}
	return ParseWorkload(kind, raw)
}

func TestComputeRolloutFixtures(t *testing.T) {
	cases := []struct {
		kind  WorkloadKind
		file  string
		state string
	}{
		{KindDeployment, "deployment-complete.json", "complete"},
		{KindDeployment, "deployment-progressing.json", "progressing"},
		{KindDeployment, "deployment-deadline-exceeded.json", "failed"},
		{KindDeployment, "deployment-stale-generation.json", "progressing"},
		{KindStatefulSet, "statefulset-complete.json", "complete"},
		{KindStatefulSet, "statefulset-rolling.json", "progressing"},
		{KindDaemonSet, "daemonset-rolling.json", "progressing"},
	}
	for _, c := range cases {
		if got := fixtureWorkload(t, c.kind, c.file).Rollout.State; got != c.state {
			t.Errorf("%s: state = %s, want %s", c.file, got, c.state)
		}
	}
}

func TestParseWorkloadContainers(t *testing.T) {
	w := fixtureWorkload(t, KindDeployment, "deployment-complete.json")
	if w.Name != "his-portal" || len(w.Containers) != 2 || w.Containers[0].Name != "portal" {
		t.Fatalf("w = %+v", w)
	}
}

func TestKubeRequiresHTTPS(t *testing.T) {
	if _, err := NewKube("http://10.0.0.1:6443", []byte("t"), "", 0); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
}

func TestKubePatchImage(t *testing.T) {
	var patchBody, patchType string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer sa-token" {
			w.WriteHeader(401)
			return
		}
		switch r.Method {
		case http.MethodGet:
			_, _ = w.Write(fixture(t, "kube", "deployment-complete.json"))
		case http.MethodPatch:
			b, _ := io.ReadAll(r.Body)
			patchBody, patchType = string(b), r.Header.Get("Content-Type")
			_, _ = w.Write(fixture(t, "kube", "deployment-progressing.json"))
		}
	}))
	defer srv.Close()
	ca := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: srv.Certificate().Raw}))

	k, err := NewKube(srv.URL, []byte("sa-token"), ca, 0)
	if err != nil {
		t.Fatal(err)
	}
	prev, err := k.PatchImage(context.Background(), "his-portal", KindDeployment, "his-portal", "portal", "registry.example.invalid/his/portal:1.9.0")
	if err != nil {
		t.Fatal(err)
	}
	if prev != "registry.example.invalid/his/portal:1.8.3" {
		t.Fatalf("prev = %q", prev)
	}
	if patchType != "application/strategic-merge-patch+json" || !strings.Contains(patchBody, `"portal"`) || !strings.Contains(patchBody, "1.9.0") {
		t.Fatalf("type=%q body=%q", patchType, patchBody)
	}
	if _, err := k.PatchImage(context.Background(), "his-portal", KindDeployment, "his-portal", "khong-co", "x:1"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("container thiếu phải bị từ chối, got %v", err)
	}
}

func TestKubeDoesNotTrustUnknownCA(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()
	k, _ := NewKube(srv.URL, []byte("sa-token"), "", 0)
	if _, err := k.GetWorkload(context.Background(), "ns", KindDeployment, "x"); CodeOf(err) != CodeUnavailable {
		t.Fatalf("chứng chỉ lạ phải bị từ chối, got %v", err)
	}
}

func TestKubeRejectsPathInjection(t *testing.T) {
	k, _ := NewKube("https://10.0.0.1:6443", []byte("t"), "", 0)
	if _, err := k.GetWorkload(context.Background(), "ns/../kube-system", KindDeployment, "x"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	if _, err := k.GetWorkload(context.Background(), "ns", WorkloadKind("Pod"), "x"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
}
