package main

import (
	"net"
	"os"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/sshkeys"
)

// TestSSHEndToEnd chạy trọn luồng với OpenSSH server thật và ssh thật của máy, trên thư mục nhà thật của tài khoản
// chạy test (chỉ chạy trong container dùng một lần). Bật bằng HIVE_SSH_E2E_ADDR=host:cổng, HIVE_SSH_E2E_USER,
// HIVE_SSH_E2E_PASSWORD (mật khẩu thử do script dựng máy chủ sinh).
func TestSSHEndToEnd(t *testing.T) {
	addr, user, password := os.Getenv("HIVE_SSH_E2E_ADDR"), os.Getenv("HIVE_SSH_E2E_USER"), os.Getenv("HIVE_SSH_E2E_PASSWORD")
	if addr == "" || user == "" || password == "" {
		t.Skip("đặt HIVE_SSH_E2E_ADDR, HIVE_SSH_E2E_USER, HIVE_SSH_E2E_PASSWORD để chạy với OpenSSH server thật")
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatal(err)
	}
	out, stderr, code := sshRun(t, "", "scan", "--host", host, "--port", port, "--json")
	if code != 0 {
		t.Fatalf("scan: %s", stderr)
	}
	scan := decode[sshkeys.ScanResult](t, out)
	if scan.Algorithm != "ssh-ed25519" {
		t.Errorf("OpenSSH có ed25519: scan phải trả ed25519, có %+v", scan)
	}
	out, stderr, code = sshRun(t, password+"\n", "setup", "--host", host, "--port", port, "--user", user,
		"--alias", "xdev-e2e", "--fingerprint", scan.Fingerprint, "--json")
	if code != 0 {
		t.Fatalf("setup: %s", stderr)
	}
	if strings.Contains(out+stderr, password) {
		t.Fatal("mật khẩu lọt ra output")
	}
	setup := decode[sshSetupView](t, out)
	if setup.Check.Status != "ok" {
		t.Fatalf("đăng nhập bằng khoá phải được ngay sau khi cài, có %+v", setup)
	}
	out, stderr, code = sshRun(t, "", "check", "--alias", "xdev-e2e", "--json")
	if code != 0 || decode[sshkeys.CheckResult](t, out).Status != "ok" {
		t.Fatalf("check: %d %s %s", code, out, stderr)
	}
	out, _, code = sshRun(t, "", "list", "--json")
	list := decode[sshListView](t, out)
	found := false
	for _, h := range list.Hosts {
		found = found || (h.Alias == "xdev-e2e" && h.Managed && h.KeyUsable && h.Port > 0)
	}
	if code != 0 || !found || list.SSH == "" {
		t.Errorf("list: %+v", list)
	}
	if _, stderr, code = sshRun(t, "", "remove", "--alias", "xdev-e2e", "--json"); code != 0 {
		t.Fatalf("remove: %s", stderr)
	}
}
