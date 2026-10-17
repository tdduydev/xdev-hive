package sshkeys

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func needSh(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("máy chủ giả chạy script bằng sh")
	}
}

func keyLine(t *testing.T) string {
	t.Helper()
	info, err := GenerateKey(DefaultKeyPath(t.TempDir()), "ha@may xdev-hive 2026-10-17")
	if err != nil {
		t.Fatal(err)
	}
	line, err := AuthorizedLine(info)
	if err != nil {
		t.Fatal(err)
	}
	return line
}

func installOpts(t *testing.T, s *testServer, password string) InstallOptions {
	return InstallOptions{
		Host:        s.host,
		Port:        s.port,
		User:        "adminvm",
		Fingerprint: ssh.FingerprintSHA256(s.keys[ssh.KeyAlgoED25519].PublicKey()),
		Password:    []byte(password),
		KnownHosts:  filepath.Join(t.TempDir(), "known_hosts"),
	}
}

func authorizedKeys(t *testing.T, s *testServer) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.home, ".ssh", "authorized_keys"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestInstallAddsKeyOnce(t *testing.T) {
	needSh(t)
	s := newTestServer(t, serverOpts{password: "mật khẩu đúng"})
	line := keyLine(t)
	for range 2 {
		hostKey, err := Install(context.Background(), installOpts(t, s, "mật khẩu đúng"), line)
		if err != nil {
			t.Fatal(err)
		}
		if ssh.FingerprintSHA256(hostKey) != ssh.FingerprintSHA256(s.keys[ssh.KeyAlgoED25519].PublicKey()) {
			t.Error("phải trả khoá máy chủ đã xác minh")
		}
	}
	if got := authorizedKeys(t, s); got != line+"\n" {
		t.Errorf("authorized_keys phải có đúng một dòng khoá, có %q", got)
	}
	for p, want := range map[string]os.FileMode{
		filepath.Join(s.home, ".ssh"):                    0o700,
		filepath.Join(s.home, ".ssh", "authorized_keys"): 0o600,
	} {
		if st, _ := os.Stat(p); st.Mode().Perm() != want {
			t.Errorf("%s: muốn %v, có %v", p, want, st.Mode().Perm())
		}
	}
	for _, c := range s.execs() {
		if c != "exec sh -s" {
			t.Errorf("chuỗi lệnh gửi máy chủ phải là `exec sh -s`, có %q", c)
		}
	}
	if n := s.passwords.Load(); n != 2 {
		t.Errorf("hai lần cài, mỗi lần gửi mật khẩu một lần: máy chủ nhận %d", n)
	}
}

func TestInstallKeepsExistingKeyWithOptions(t *testing.T) {
	needSh(t)
	s := newTestServer(t, serverOpts{password: "pw"})
	line := keyLine(t)
	blob := strings.Fields(line)[1]
	existing := "ssh-rsa AAAAB3NzaC1yc2E other\nfrom=\"10.0.0.1\" ssh-ed25519 " + blob + " máy-cũ"
	if err := os.MkdirAll(filepath.Join(s.home, ".ssh"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.home, ".ssh", "authorized_keys"), []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), installOpts(t, s, "pw"), line); err != nil {
		t.Fatal(err)
	}
	if got := authorizedKeys(t, s); got != existing+"\n" {
		t.Errorf("khoá đã có (kèm option, comment khác) thì không thêm; chỉ thêm xuống dòng cuối. Có %q", got)
	}
}

func TestInstallAfterLineWithoutNewline(t *testing.T) {
	needSh(t)
	s := newTestServer(t, serverOpts{password: "pw"})
	line := keyLine(t)
	if err := os.MkdirAll(filepath.Join(s.home, ".ssh"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.home, ".ssh", "authorized_keys"), []byte("ssh-rsa AAAAB3 cũ"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), installOpts(t, s, "pw"), line); err != nil {
		t.Fatal(err)
	}
	if got := authorizedKeys(t, s); got != "ssh-rsa AAAAB3 cũ\n"+line+"\n" {
		t.Errorf("dòng mới không được dính vào dòng cũ, có %q", got)
	}
}

func TestInstallFingerprintMismatchSendsNothing(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw"})
	o := installOpts(t, s, "pw")
	o.Fingerprint = "SHA256:" + strings.Repeat("A", 43)
	if _, err := Install(context.Background(), o, "ssh-ed25519 AAAA"); !errors.Is(err, ErrHostKeyMismatch) {
		t.Fatalf("muốn ErrHostKeyMismatch, có %v", err)
	}
	if s.passwords.Load() != 0 || s.auths.Load() != 0 {
		t.Errorf("không được thử xác thực: mật khẩu %d, lượt %d", s.passwords.Load(), s.auths.Load())
	}
}

func TestInstallRefusesChangedHostKey(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw", algos: []string{ssh.KeyAlgoED25519}})
	o := installOpts(t, s, "pw")
	if err := os.WriteFile(o.KnownHosts, []byte(knownhosts.Line([]string{knownhosts.Normalize(s.addr())}, edKey(t))+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Install(context.Background(), o, "ssh-ed25519 AAAA"); !errors.Is(err, ErrHostKeyChanged) {
		t.Fatalf("known_hosts có khoá khác: muốn ErrHostKeyChanged, có %v", err)
	}
	if s.passwords.Load() != 0 {
		t.Error("không được gửi mật khẩu")
	}
}

func TestInstallWrongPasswordSentOnce(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "đúng"})
	_, err := Install(context.Background(), installOpts(t, s, "Pw-Sai-9137"), keyLine(t))
	if !errors.Is(err, ErrAuthFailed) {
		t.Fatalf("muốn ErrAuthFailed, có %v", err)
	}
	if strings.Contains(err.Error(), "Pw-Sai-9137") {
		t.Errorf("lỗi không được chứa mật khẩu: %v", err)
	}
	if n := s.passwords.Load(); n != 1 {
		t.Errorf("máy chủ cho cả password và keyboard-interactive: chỉ được gửi mật khẩu một lần, đã gửi %d", n)
	}
}

func TestInstallKeyboardInteractiveOnly(t *testing.T) {
	needSh(t)
	s := newTestServer(t, serverOpts{password: "pw", kbdOnly: true})
	if _, err := Install(context.Background(), installOpts(t, s, "pw"), keyLine(t)); err != nil {
		t.Fatal(err)
	}
	if n := s.passwords.Load(); n != 1 {
		t.Errorf("muốn một lần, có %d", n)
	}
}

func TestInstallStopsAtOTP(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw", kbdOnly: true, otp: true})
	if _, err := Install(context.Background(), installOpts(t, s, "pw"), keyLine(t)); !errors.Is(err, ErrExtraAuth) {
		t.Fatalf("máy chủ hỏi mã xác minh: muốn ErrExtraAuth, có %v", err)
	}
	if n := s.passwords.Load(); n != 1 {
		t.Errorf("muốn một lần, có %d", n)
	}
}

func TestInstallScript(t *testing.T) {
	line := "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOv ha@may xdev-hive 2026-10-17"
	script, err := InstallScript(line)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(script, "'"+line+"'") || !strings.Contains(script, "umask 077") {
		t.Errorf("script thiếu dòng khoá trong nháy đơn hoặc umask:\n%s", script)
	}
	for _, bad := range []string{
		"ssh-ed25519 AAAA it's",
		"ssh-ed25519 AAAA x\nrm -rf ~",
		"ssh-ed25519 AAAA $(id)",
		"ssh-ed25519 AAAA a;b",
		"--x AAAA",
		"",
	} {
		if _, err := InstallScript(bad); err == nil {
			t.Errorf("phải từ chối %q", bad)
		}
	}
}
