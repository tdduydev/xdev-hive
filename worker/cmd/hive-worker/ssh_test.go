package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/sshkeys"
	"github.com/tdduydev/xdev-hive/worker/internal/sshkeys/sshtest"
)

// sshEnv thay thư mục nhà và bỏ ssh của máy: test không đọc hay ghi ~/.ssh thật. ssh của máy đọc thư mục nhà theo
// tài khoản (không theo HOME), nên các bước cần ssh chỉ chạy trong e2e.
func sshEnv(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	oldHome, oldFind, oldNow := sshHome, sshFindSSH, sshNow
	sshHome = func() (string, error) { return home, nil }
	sshFindSSH = func() (string, error) { return "", errors.New("không có ssh") }
	sshNow = func() time.Time { return time.Date(2026, 10, 17, 9, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { sshHome, sshFindSSH, sshNow = oldHome, oldFind, oldNow })
	return home
}

func sshRun(t *testing.T, stdin string, args ...string) (string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := sshCommand(args, strings.NewReader(stdin), &out, &errOut)
	return out.String(), errOut.String(), code
}

func decode[T any](t *testing.T, out string) T {
	t.Helper()
	var v T
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("JSON: %v\n%s", err, out)
	}
	return v
}

func writeSSHConfig(t *testing.T, home, data string) string {
	t.Helper()
	path := filepath.Join(home, ".ssh", "config")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(data), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func managedConfig(t *testing.T, alias, host string, port int) string {
	t.Helper()
	out, err := sshkeys.AddBlock([]byte("Host macmini\n    HostName 10.86.140.63\n    User duynh60\n"),
		sshkeys.Host{Alias: alias, HostName: host, User: "adminvm", Port: port}, "~/.ssh/id_ed25519")
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestSSHList(t *testing.T) {
	home := sshEnv(t)
	writeSSHConfig(t, home, managedConfig(t, "hive-prod", "10.86.224.34", 22))
	out, stderr, code := sshRun(t, "", "list", "--json")
	if code != 0 {
		t.Fatalf("mã %d: %s", code, stderr)
	}
	v := decode[sshListView](t, out)
	if v.SSH != "" || v.Key.Exists || v.ConfigPath != filepath.Join(home, ".ssh", "config") || len(v.Hosts) != 2 {
		t.Fatalf("có %+v", v)
	}
	if v.Hosts[0].Alias != "macmini" || v.Hosts[0].Managed || !v.Hosts[0].KeyUsable {
		t.Errorf("khối viết tay không IdentityFile: ssh dùng khoá mặc định; có %+v", v.Hosts[0])
	}
	if v.Hosts[1].Alias != "hive-prod" || !v.Hosts[1].Managed || !v.Hosts[1].KeyUsable {
		t.Errorf("có %+v", v.Hosts[1])
	}
}

func scanFingerprint(t *testing.T, s *sshtest.Server) string {
	t.Helper()
	out, stderr, code := sshRun(t, "", "scan", "--host", s.Host, "--port", strconv.Itoa(s.Port), "--json")
	if code != 0 {
		t.Fatalf("scan mã %d: %s", code, stderr)
	}
	r := decode[sshkeys.ScanResult](t, out)
	if r.Known != "unknown" || !strings.HasPrefix(r.Fingerprint, "SHA256:") {
		t.Fatalf("scan có %+v", r)
	}
	return r.Fingerprint
}

func setupArgs(s *sshtest.Server, alias, fingerprint string) []string {
	return []string{"setup", "--host", s.Host, "--port", strconv.Itoa(s.Port), "--user", "adminvm",
		"--alias", alias, "--fingerprint", fingerprint, "--json"}
}

func TestSSHSetupWrongPasswordWritesNothing(t *testing.T) {
	home := sshEnv(t)
	s := sshtest.New(t, sshtest.Options{Password: "đúng"})
	fp := scanFingerprint(t, s)
	out, stderr, code := sshRun(t, "Pw-Sai-9137\n", setupArgs(s, "hive-test", fp)...)
	if code != 1 || !strings.Contains(stderr, sshkeys.ErrAuthFailed.Error()) {
		t.Fatalf("muốn mã 1 và lỗi sai mật khẩu, có %d %q %q", code, stderr, out)
	}
	if strings.Contains(stderr+out, "Pw-Sai-9137") {
		t.Error("mật khẩu không được nằm trong output")
	}
	for _, f := range []string{"config", "known_hosts"} {
		if _, err := os.Stat(filepath.Join(home, ".ssh", f)); !os.IsNotExist(err) {
			t.Errorf("sai mật khẩu thì không được ghi %s", f)
		}
	}
	if n := s.Passwords(); n != 1 {
		t.Errorf("gửi mật khẩu %d lần", n)
	}
}

func TestSSHSetupInstallsAndWritesConfig(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("máy chủ giả chạy script bằng sh")
	}
	home := sshEnv(t)
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	fp := scanFingerprint(t, s)
	out, stderr, code := sshRun(t, "pw\r\n", setupArgs(s, "hive-test", fp)...)
	if code != 0 {
		t.Fatalf("mã %d: %s", code, stderr)
	}
	v := decode[sshSetupView](t, out)
	if !v.KeyCreated || !v.ConfigWritten || v.Check.Status != "no_ssh" || v.Key.Path != sshkeys.DefaultKeyPath(home) {
		t.Fatalf("có %+v", v)
	}
	config, _ := os.ReadFile(filepath.Join(home, ".ssh", "config"))
	if !strings.Contains(string(config), "# >>> xdev-hive hive-test\nHost hive-test\n    HostName 127.0.0.1\n") {
		t.Errorf("config thiếu khối:\n%s", config)
	}
	if status, _ := sshkeys.HostKeyStatus(filepath.Join(home, ".ssh", "known_hosts"), s.Host, s.Port,
		s.Keys["ssh-ed25519"].PublicKey()); status != "known" {
		t.Errorf("known_hosts phải có khoá máy chủ, có %s", status)
	}
	blob := strings.Fields(v.Key.PublicKey)[1]
	auth, _ := os.ReadFile(filepath.Join(s.Home, ".ssh", "authorized_keys"))
	if strings.Count(string(auth), blob) != 1 {
		t.Errorf("authorized_keys phải có khoá đúng một lần:\n%s", auth)
	}

	// Chạy lại: dùng khoá và khối đã có, không ghi config lần nữa.
	out, stderr, code = sshRun(t, "pw\n", setupArgs(s, "hive-test", fp)...)
	if code != 0 {
		t.Fatalf("lần hai mã %d: %s", code, stderr)
	}
	if again := decode[sshSetupView](t, out); again.KeyCreated || again.ConfigWritten {
		t.Errorf("lần hai có %+v", again)
	}
	backups, _ := filepath.Glob(filepath.Join(home, ".ssh", "config.xdev-hive-*.bak"))
	if len(backups) != 0 {
		t.Errorf("config chưa có trước đó thì không cần bản sao lưu, có %v", backups)
	}
}

func TestSSHSetupRejectsAliasOfOtherServer(t *testing.T) {
	home := sshEnv(t)
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	writeSSHConfig(t, home, managedConfig(t, "hive-test", "10.9.9.9", 22))
	_, stderr, code := sshRun(t, "pw\n", setupArgs(s, "hive-test", scanFingerprint(t, s))...)
	if code != 1 || s.Passwords() != 0 {
		t.Errorf("alias đã dùng cho máy chủ khác: phải dừng trước khi gửi mật khẩu; mã %d, %q, mật khẩu %d", code, stderr, s.Passwords())
	}
}

func TestSSHSetupHandWrittenNeedsSSH(t *testing.T) {
	home := sshEnv(t)
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	writeSSHConfig(t, home, "Host macmini\n    HostName 127.0.0.1\n")
	_, stderr, code := sshRun(t, "pw\n", setupArgs(s, "macmini", scanFingerprint(t, s))...)
	if code != 1 || s.Passwords() != 0 {
		t.Errorf("khối viết tay cần ssh -G để đối chiếu; có mã %d %q", code, stderr)
	}
}

func TestSSHSetupEmptyPassword(t *testing.T) {
	sshEnv(t)
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	_, stderr, code := sshRun(t, "\n", setupArgs(s, "hive-test", scanFingerprint(t, s))...)
	if code != 1 || !strings.Contains(stderr, "Nhập mật khẩu") || s.Passwords() != 0 {
		t.Errorf("mã %d %q", code, stderr)
	}
}

func TestSSHRemove(t *testing.T) {
	home := sshEnv(t)
	path := writeSSHConfig(t, home, managedConfig(t, "hive-prod", "10.86.224.34", 22))
	out, stderr, code := sshRun(t, "", "remove", "--alias", "hive-prod", "--json")
	if code != 0 {
		t.Fatalf("mã %d: %s", code, stderr)
	}
	if v := decode[sshListView](t, out); len(v.Hosts) != 1 || v.Hosts[0].Alias != "macmini" {
		t.Errorf("có %+v", v.Hosts)
	}
	if got, _ := os.ReadFile(path); string(got) != "Host macmini\n    HostName 10.86.140.63\n    User duynh60\n" {
		t.Errorf("config sau khi gỡ: %q", got)
	}
	if backups, _ := filepath.Glob(path + ".xdev-hive-*.bak"); len(backups) != 1 {
		t.Errorf("phải có một bản sao lưu, có %v", backups)
	}
	if _, stderr, code := sshRun(t, "", "remove", "--alias", "macmini", "--json"); code != 1 ||
		!strings.Contains(stderr, sshkeys.ErrNotManaged.Error()) {
		t.Errorf("khối viết tay: mã %d %q", code, stderr)
	}
}

func TestSSHUsage(t *testing.T) {
	sshEnv(t)
	for _, args := range [][]string{
		{"nope"},
		{"setup", "--json"},
		{"check", "--json"},
		{"scan", "--json"},
		{"remove", "--json"},
	} {
		if _, _, code := sshRun(t, "", args...); code != 2 {
			t.Errorf("%v: muốn mã 2, có %d", args, code)
		}
	}
	for _, args := range [][]string{
		{"check", "--alias", "-oProxyCommand=x"},
		{"scan", "--host", "a b"},
		{"scan", "--host", "h", "--port", "70000"},
		{"setup", "--host", "h", "--port", "22", "--user", "u", "--alias", "a", "--fingerprint", "md5:x"},
	} {
		if _, _, code := sshRun(t, "pw\n", args...); code != 1 {
			t.Errorf("%v: muốn mã 1, có %d", args, code)
		}
	}
}
