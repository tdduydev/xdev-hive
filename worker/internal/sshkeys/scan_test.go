package sshkeys

import (
	"context"
	"path/filepath"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestScanUnknownPrefersEd25519(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw"})
	got, err := Scan(context.Background(), s.host, s.port, filepath.Join(t.TempDir(), "known_hosts"))
	if err != nil {
		t.Fatal(err)
	}
	want := ssh.FingerprintSHA256(s.keys[ssh.KeyAlgoED25519].PublicKey())
	if got.Algorithm != ssh.KeyAlgoED25519 || got.Fingerprint != want || got.Known != "unknown" ||
		got.AdminCommand != "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" {
		t.Errorf("có %+v, muốn ed25519 %s", got, want)
	}
	if n := s.auths.Load(); n != 0 {
		t.Errorf("quét khoá không được thử xác thực, máy chủ thấy %d lần", n)
	}
}

func TestScanUsesKnownKeyType(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw"})
	known := writeKnown(t, knownhosts.Line([]string{knownhosts.Normalize(s.addr())}, s.keys[ssh.KeyAlgoECDSA256].PublicKey()))
	got, err := Scan(context.Background(), s.host, s.port, known)
	if err != nil {
		t.Fatal(err)
	}
	if got.Known != "known" || got.Algorithm != ssh.KeyAlgoECDSA256 ||
		got.AdminCommand != "ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub" {
		t.Errorf("known_hosts có ECDSA thì phải xin ECDSA và báo known, có %+v", got)
	}
}

func TestScanChanged(t *testing.T) {
	s := newTestServer(t, serverOpts{password: "pw", algos: []string{ssh.KeyAlgoED25519}})
	known := writeKnown(t, knownhosts.Line([]string{knownhosts.Normalize(s.addr())}, edKey(t)))
	got, err := Scan(context.Background(), s.host, s.port, known)
	if err != nil {
		t.Fatal(err)
	}
	if got.Known != "changed" {
		t.Errorf("khoá khác known_hosts phải là changed, có %+v", got)
	}
}

func TestScanUnreachable(t *testing.T) {
	s := newTestServer(t, serverOpts{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, s.host, s.port, filepath.Join(t.TempDir(), "kh")); err == nil {
		t.Error("ctx đã huỷ thì phải lỗi")
	}
}
