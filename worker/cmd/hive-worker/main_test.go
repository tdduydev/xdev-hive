package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
)

func TestDefaultMachineID(t *testing.T) {
	cases := map[string]string{
		"Dev-MacBook-Pro.local": "dev-macbook-pro",
		"build_01.corp.example": "build-01-corp-example",
		"---":                   "worker",
		"":                      "worker",
		strings.Repeat("a", 70): strings.Repeat("a", 63),
	}
	for in, want := range cases {
		if got := defaultMachineID(in); got != want {
			t.Errorf("defaultMachineID(%q) = %q, cần %q", in, got, want)
		}
	}
}

func TestRegisterSavesToken(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/worker/register" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewDecoder(r.Body).Decode(&got)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"00000000-0000-4000-8000-000000000001","orgId":"00000000-0000-4000-8000-000000000002","teamId":"00000000-0000-4000-8000-000000000003","machineId":"may-test","machineToken":"hwm_secret"}`))
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "xdev-hive", "worker.json")
	var stdout, stderr bytes.Buffer
	code := register([]string{"--hub", srv.URL, "--token", "hwr_abc", "--machine", "may-test", "--capacity", "2", "--config", path}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("mã thoát %d, stderr: %s", code, stderr.String())
	}
	if got["registrationToken"] != "hwr_abc" || got["machineId"] != "may-test" || got["os"] != runtime.GOOS || got["capacity"] != float64(2) {
		t.Fatalf("body gửi hub = %v", got)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want := config.Config{HubURL: srv.URL, MachineID: "may-test", MachineToken: "hwm_secret", TeamID: "00000000-0000-4000-8000-000000000003"}
	if cfg != want {
		t.Fatalf("cấu hình = %+v", cfg)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(path)
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("quyền file = %o, cần 600", perm)
		}
	}
	if strings.Contains(stdout.String(), "hwm_secret") {
		t.Fatal("không được in machine token ra màn hình")
	}
}

func TestRegisterRejectedKeepsNoConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"message":"Mã đăng ký không hợp lệ, đã hết hạn hoặc đã dùng."}`))
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "worker.json")
	var stdout, stderr bytes.Buffer
	if code := register([]string{"--hub", srv.URL, "--token", "hwr_sai", "--config", path}, &stdout, &stderr); code != 1 {
		t.Fatalf("mã thoát %d", code)
	}
	if !strings.Contains(stderr.String(), "Mã đăng ký không hợp lệ") {
		t.Fatalf("stderr = %s", stderr.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("không được tạo file cấu hình khi đăng ký hỏng")
	}
}

func TestRegisterNeedsFlags(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if code := register([]string{"--token", "x"}, &stdout, &stderr); code != 2 {
		t.Fatalf("mã thoát %d", code)
	}
}
