package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/update"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

func fakeLatest(t *testing.T, tag string) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/latest" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"tag_name":"` + tag + `"}`))
	}))
	t.Cleanup(srv.Close)
	old := updateSource
	updateSource = func() (update.Source, error) {
		return update.Source{HTTP: srv.Client(), Releases: srv.URL + "/releases", LatestAPI: srv.URL + "/latest"}, nil
	}
	t.Cleanup(func() { updateSource = old })
}

func TestUpdateCheckReportsOutdated(t *testing.T) {
	fakeLatest(t, "v1.2.3")
	var out, errOut bytes.Buffer
	if code := updateCommand([]string{"--check", "--json"}, &out, &errOut); code != 0 {
		t.Fatalf("mã thoát %d: %s", code, errOut.String())
	}
	var got struct {
		Current, Latest string
		Outdated        bool
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	// Bản test dựng từ mã nguồn (0.0.0-dev) luôn cũ hơn bản phát hành.
	if got.Current != version.Version || got.Latest != "1.2.3" || !got.Outdated {
		t.Fatalf("kết quả = %+v", got)
	}
}

func TestUpdateSkipsWhenAlreadyLatest(t *testing.T) {
	fakeLatest(t, "v"+version.Version)
	old := updateExecutable
	updateExecutable = func() (string, error) { return t.TempDir() + "/hive-worker", nil }
	t.Cleanup(func() { updateExecutable = old })
	var out, errOut bytes.Buffer
	if code := updateCommand(nil, &out, &errOut); code != 0 {
		t.Fatalf("mã thoát %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "Đã là bản mới nhất") {
		t.Fatalf("stdout = %q", out.String())
	}
}

func TestUpdateRejectsBadVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := updateCommand([]string{"--version", "../1"}, &out, &errOut); code != 2 {
		t.Fatalf("mã thoát %d, cần 2", code)
	}
}
