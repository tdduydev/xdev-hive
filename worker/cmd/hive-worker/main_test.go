package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
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

func TestSandboxInitRunsCLICommand(t *testing.T) {
	if code := sandboxInit([]string{"--socket", filepath.Join(t.TempDir(), "egress.sock"), "--", "sh", "-c", "exit 0"}); code != 0 {
		t.Fatalf("sandbox-init trả mã %d", code)
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

func TestDetectCLIsUsesOverrides(t *testing.T) {
	// PATH trống: không CLI thật nào được tìm thấy, chỉ CLI ghi đè trỏ tới file chạy được.
	t.Setenv("PATH", t.TempDir())
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(runner.CLIOverridesEnv, fmt.Sprintf(`{"claude": {"path": %q}, "codex": {"path": %q}}`, exe, filepath.Join(t.TempDir(), "khong-co")))
	if got := detectCLIs(); len(got) != 1 || got[0] != "claude" {
		t.Fatalf("detectCLIs = %v", got)
	}
}

// Antigravity cài lệnh agy chứ không phải lệnh trùng tên CLI.
func TestDetectCLIsFindsAntigravityAsAgy(t *testing.T) {
	bin := t.TempDir()
	name := "agy"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin)
	t.Setenv(runner.CLIOverridesEnv, "")
	if got := detectCLIs(); len(got) != 1 || got[0] != "antigravity" {
		t.Fatalf("detectCLIs = %v", got)
	}
}

func TestRegisterJSONAndConfigNeverPrintToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"00000000-0000-4000-8000-000000000001","orgId":"00000000-0000-4000-8000-000000000002","teamId":"00000000-0000-4000-8000-000000000003","machineId":"may-json","machineToken":"hwm_secret"}`))
	}))
	defer srv.Close()
	path := filepath.Join(t.TempDir(), "worker.json")

	var stdout, stderr bytes.Buffer
	if code := showConfig([]string{"--config", path, "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("config trước khi đăng ký: mã %d, %s", code, stderr.String())
	}
	var before configView
	if err := json.Unmarshal(stdout.Bytes(), &before); err != nil || before.Registered || before.ConfigPath != path {
		t.Fatalf("config trước khi đăng ký = %s, %v", stdout.String(), err)
	}

	stdout.Reset()
	if code := register([]string{"--hub", srv.URL, "--token", "hwr_abc", "--config", path, "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("register --json: mã %d, %s", code, stderr.String())
	}
	var reg configView
	if err := json.Unmarshal(stdout.Bytes(), &reg); err != nil || !reg.Registered || reg.MachineID != "may-json" || reg.HubURL != srv.URL {
		t.Fatalf("register --json = %s, %v", stdout.String(), err)
	}

	stdout.Reset()
	if code := showConfig([]string{"--config", path, "--json"}, &stdout, &stderr); code != 0 {
		t.Fatalf("config: mã %d", code)
	}
	var after configView
	if err := json.Unmarshal(stdout.Bytes(), &after); err != nil || !after.Registered || after.MachineID != "may-json" || after.TeamID == "" {
		t.Fatalf("config sau khi đăng ký = %s, %v", stdout.String(), err)
	}
	if strings.Contains(stdout.String(), "hwm_secret") {
		t.Fatal("config in ra machine token")
	}
}

func TestStatusPrinterWritesJSONLines(t *testing.T) {
	var out bytes.Buffer
	p := statusPrinter(&out)
	p(channel.Status{State: "connecting"})
	p(channel.Status{State: "disconnected", Error: "mất mạng"})
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || lines[0] != `{"status":"connecting"}` || lines[1] != `{"status":"disconnected","error":"mất mạng"}` {
		t.Fatalf("dòng trạng thái = %q", lines)
	}
}

func TestRunscAllowsHostUDS(t *testing.T) {
	for raw, want := range map[string]bool{
		`{"path":"/usr/bin/runsc"}`:                                                      false,
		`{"path":"/usr/bin/runsc","runtimeArgs":["--host-uds=open"]}`:                    true,
		`{"path":"/usr/bin/runsc","runtimeArgs":["--platform=systrap","-host-uds=all"]}`: true,
		`{"path":"/usr/bin/runsc","runtimeArgs":["--host-uds=none"]}`:                    false,
		`{"path":"/usr/bin/runsc","runtimeArgs":["--host-uds=create"]}`:                  false,
		`not json`: false,
	} {
		if got := runscAllowsHostUDS(json.RawMessage(raw)); got != want {
			t.Errorf("%s: %v, muốn %v", raw, got, want)
		}
	}
}

func TestSidecarDisablesSelfUpdate(t *testing.T) {
	if selfUpdates(true) {
		t.Fatal("sidecar của app desktop (--stdin-control) không được tự cập nhật")
	}
	if !selfUpdates(false) {
		t.Fatal("worker chạy riêng vẫn tự cập nhật theo lệnh của hub")
	}
}
