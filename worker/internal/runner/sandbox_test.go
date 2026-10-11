package runner

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestSandboxRunArgsEnforceIsolation(t *testing.T) {
	args := SandboxRunArgs(SandboxConfig{}, "run/1", "/host/work", "/host/repos/r.git", "", []string{"codex", "prompt"}, map[string]string{"HIVE_RUN_TOKEN": "token"}, "1001", "1002")
	joined := strings.Join(args, " ")
	for _, required := range []string{"--runtime=runsc", "--network=none", "--read-only", "--tmpfs /tmp:rw,noexec,nosuid,size=1g", "--mount type=bind,src=/host/repos/r.git,dst=/host/repos/r.git", "--cpus=2", "--memory=4g", "--pids-limit=256", "--user 1001:1002", "--cap-drop=ALL", "--security-opt=no-new-privileges", "hive.run=run/1", "--env HIVE_RUN_TOKEN", "xdev-hive-runner:latest", "codex prompt"} {
		if !strings.Contains(joined, required) {
			t.Errorf("tham số Docker thiếu %q: %s", required, joined)
		}
	}
	if strings.Contains(joined, "HIVE_RUN_TOKEN=token") {
		t.Fatal("secret không được đưa vào command line của Docker")
	}
	if strings.Contains(joined, "--network=host") {
		t.Fatal("container không được nối mạng host")
	}
}

func TestSandboxRunArgsAllowRuncOnlyWhenConfigured(t *testing.T) {
	args := SandboxRunArgs(SandboxConfig{AllowRunc: true}, "run", "/work", "", "image", []string{"true"}, nil, "1000", "1000")
	if !strings.Contains(strings.Join(args, " "), "--runtime=runc") {
		t.Fatalf("runtime không dùng runc trong chế độ dev: %v", args)
	}
}

func TestReapSandboxOrphansRemovesContainers(t *testing.T) {
	skipWithoutPOSIXShell(t)
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args")
	docker := filepath.Join(dir, "docker")
	script := "#!/bin/sh\nif [ \"$1\" = ps ]; then echo id-one; echo id-two; exit 0; fi\nprintf '%s\\n' \"$@\" > \"" + logPath + "\"\n"
	if err := os.WriteFile(docker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := ReapSandboxOrphans(context.Background(), SandboxConfig{DockerPath: docker}); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "rm\n--force\nid-one\nid-two\n" {
		t.Fatalf("lệnh dọn container = %q", got)
	}
}

func TestRemoveSandboxForRunCleanup(t *testing.T) {
	skipWithoutPOSIXShell(t)
	dir := t.TempDir()
	logPath := filepath.Join(dir, "args")
	docker := filepath.Join(dir, "docker")
	script := "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"" + logPath + "\"\n"
	if err := os.WriteFile(docker, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	Runner{Sandbox: &SandboxConfig{DockerPath: docker}}.removeSandbox(context.Background(), "run-42")
	got, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "rm\n--force\nhive-run-42\n" {
		t.Fatalf("lệnh xoá container = %q", got)
	}
}

func TestSandboxRunArgsDoesNotEnableNetworkWhenUsingRunc(t *testing.T) {
	args := SandboxRunArgs(SandboxConfig{AllowRunc: true}, "run", "/work", "", "image", []string{"true"}, nil, "1000", "1000")
	if !strings.Contains(strings.Join(args, " "), "--network=none") {
		t.Fatal("chế độ runc dev vẫn phải tắt mạng")
	}
}

func TestSandboxRunArgsMountsOnlyExplicitEgressSocket(t *testing.T) {
	args := SandboxRunArgs(SandboxConfig{EgressSocket: "/run/hive/egress.sock", WorkerBinary: "/usr/bin/hive-worker"}, "run", "/work", "", "image", []string{"codex"}, nil, "1000", "1000")
	joined := strings.Join(args, " ")
	for _, required := range []string{"src=/run/hive/egress.sock,dst=/run/hive/egress.sock", "src=/usr/bin/hive-worker,dst=/usr/local/bin/hive-worker,readonly", "/usr/local/bin/hive-worker sandbox-init --socket /run/hive/egress.sock -- codex"} {
		if !strings.Contains(joined, required) {
			t.Errorf("tham số Docker thiếu %q: %s", required, joined)
		}
	}
}

// Runner host chỉ chạy trên Linux; docker giả ở đây là shell script nên Windows không chạy được.
func skipWithoutPOSIXShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("runner host chỉ chạy trên Linux; docker giả là shell script")
	}
}
