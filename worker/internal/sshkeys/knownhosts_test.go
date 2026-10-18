package sshkeys

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func edKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(rand.Reader)
	k, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func ecKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	k, err := ssh.NewPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func writeKnown(t *testing.T, lines ...string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "known_hosts")
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestHostKeyStatus(t *testing.T) {
	ed, ec, other := edKey(t), ecKey(t), edKey(t)
	path := writeKnown(t,
		knownhosts.Line([]string{"10.0.0.1"}, ed),
		knownhosts.Line([]string{knownhosts.HashHostname("hashed.example")}, ed),
		knownhosts.Line([]string{knownhosts.Normalize("10.0.0.2:2222")}, ec),
	)
	for _, c := range []struct {
		host string
		port int
		key  ssh.PublicKey
		want string
	}{
		{"10.0.0.1", 22, ed, "known"},
		{"hashed.example", 22, ed, "known"},
		{"10.0.0.2", 2222, ec, "known"},
		{"10.0.0.2", 22, ec, "unknown"},
		{"10.0.0.9", 22, ed, "unknown"},
		{"10.0.0.1", 22, other, "changed"},
		// Máy chủ đã biết bằng khoá loại khác: không phải "đã đổi", như ssh hỏi lại thay vì báo giả mạo.
		{"10.0.0.2", 2222, ed, "unknown"},
	} {
		got, err := HostKeyStatus(path, c.host, c.port, c.key)
		if err != nil || got != c.want {
			t.Errorf("%s:%d %s: muốn %s, có %s %v", c.host, c.port, c.key.Type(), c.want, got, err)
		}
	}
}

func TestHostKeyStatusSkipsBadLines(t *testing.T) {
	ed := edKey(t)
	path := writeKnown(t, "bad line without key", "@cert-authority *.example ssh-ed25519 AAAA-broken",
		knownhosts.Line([]string{"10.0.0.1"}, ed))
	got, err := HostKeyStatus(path, "10.0.0.1", 22, ed)
	if err != nil || got != "known" {
		t.Errorf("dòng hỏng phải bị bỏ qua như ssh, có %s %v", got, err)
	}
}

func TestHostKeyStatusMissingFile(t *testing.T) {
	got, err := HostKeyStatus(filepath.Join(t.TempDir(), "known_hosts"), "h", 22, edKey(t))
	if err != nil || got != "unknown" {
		t.Errorf("chưa có known_hosts: muốn unknown, có %s %v", got, err)
	}
}

func TestKnownKeyTypes(t *testing.T) {
	path := writeKnown(t, knownhosts.Line([]string{"h"}, ecKey(t)), knownhosts.Line([]string{"h"}, edKey(t)))
	got := KnownKeyTypes(path, "h", 22)
	slices.Sort(got)
	if !slices.Equal(got, []string{"ecdsa-sha2-nistp256", "ssh-ed25519"}) {
		t.Errorf("có %v", got)
	}
	if got := KnownKeyTypes(path, "khác", 22); len(got) != 0 {
		t.Errorf("máy chủ chưa biết: muốn rỗng, có %v", got)
	}
}

func TestHostKeyAlgorithms(t *testing.T) {
	if got := hostKeyAlgorithms(nil); got[0] != ssh.KeyAlgoED25519 {
		t.Errorf("máy chủ chưa biết phải xin ed25519 trước, có %v", got)
	}
	if got := hostKeyAlgorithms([]string{"ecdsa-sha2-nistp256"}); !slices.Equal(got, []string{"ecdsa-sha2-nistp256"}) {
		t.Errorf("có %v", got)
	}
	if got := hostKeyAlgorithms([]string{"ssh-rsa"}); !slices.Equal(got, []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}) {
		t.Errorf("có %v", got)
	}
}

func TestAppendKnownHost(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(path, []byte(knownhosts.Line([]string{"old"}, edKey(t))), 0o644); err != nil {
		t.Fatal(err)
	}
	k := edKey(t)
	for range 2 {
		if err := AppendKnownHost(path, "192.0.2.10", 22, k); err != nil {
			t.Fatal(err)
		}
	}
	if err := AppendKnownHost(path, "192.0.2.10", 2222, k); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	if len(lines) != 3 || !strings.HasPrefix(lines[0], "old ") || !strings.HasPrefix(lines[1], "192.0.2.10 ssh-ed25519 ") ||
		!strings.HasPrefix(lines[2], "[192.0.2.10]:2222 ssh-ed25519 ") {
		t.Errorf("known_hosts sai:\n%s", data)
	}
	if got, _ := HostKeyStatus(path, "192.0.2.10", 22, k); got != "known" {
		t.Errorf("dòng vừa thêm phải đọc lại được, có %s", got)
	}
	fresh := filepath.Join(dir, "sub", "known_hosts")
	if err := AppendKnownHost(fresh, "h", 22, k); err != nil {
		t.Fatalf("known_hosts chưa có thì tạo: %v", err)
	}
}
