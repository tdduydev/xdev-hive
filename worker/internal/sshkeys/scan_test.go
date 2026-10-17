package sshkeys

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/sshkeys/sshtest"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func TestScanUnknownPrefersEd25519(t *testing.T) {
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	got, err := Scan(context.Background(), s.Host, s.Port, filepath.Join(t.TempDir(), "known_hosts"))
	if err != nil {
		t.Fatal(err)
	}
	want := ssh.FingerprintSHA256(s.Keys[ssh.KeyAlgoED25519].PublicKey())
	if got.Algorithm != ssh.KeyAlgoED25519 || got.Fingerprint != want || got.Known != "unknown" ||
		got.AdminCommand != "ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" {
		t.Errorf("có %+v, muốn ed25519 %s", got, want)
	}
	if n := s.Auths(); n != 0 {
		t.Errorf("quét khoá không được thử xác thực, máy chủ thấy %d lần", n)
	}
}

func TestScanUsesKnownKeyType(t *testing.T) {
	s := sshtest.New(t, sshtest.Options{Password: "pw"})
	known := writeKnown(t, knownhosts.Line([]string{knownhosts.Normalize(s.Addr())}, s.Keys[ssh.KeyAlgoECDSA256].PublicKey()))
	got, err := Scan(context.Background(), s.Host, s.Port, known)
	if err != nil {
		t.Fatal(err)
	}
	if got.Known != "known" || got.Algorithm != ssh.KeyAlgoECDSA256 ||
		got.AdminCommand != "ssh-keygen -lf /etc/ssh/ssh_host_ecdsa_key.pub" {
		t.Errorf("known_hosts có ECDSA thì phải xin ECDSA và báo known, có %+v", got)
	}
}

func TestScanChanged(t *testing.T) {
	s := sshtest.New(t, sshtest.Options{Password: "pw", Algos: []string{ssh.KeyAlgoED25519}})
	known := writeKnown(t, knownhosts.Line([]string{knownhosts.Normalize(s.Addr())}, edKey(t)))
	got, err := Scan(context.Background(), s.Host, s.Port, known)
	if err != nil {
		t.Fatal(err)
	}
	if got.Known != "changed" {
		t.Errorf("khoá khác known_hosts phải là changed, có %+v", got)
	}
}

func TestScanUnreachable(t *testing.T) {
	s := sshtest.New(t, sshtest.Options{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Scan(ctx, s.Host, s.Port, filepath.Join(t.TempDir(), "kh")); err == nil {
		t.Error("ctx đã huỷ thì phải lỗi")
	}
}
