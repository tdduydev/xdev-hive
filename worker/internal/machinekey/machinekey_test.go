package machinekey

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/zalando/go-keyring"
)

const (
	hub     = "https://hive.example.test"
	machine = "mac-an"
)

type fakeKeyring struct {
	items map[string]string
	// broken giả máy không có keychain: Set và Get đều lỗi.
	broken bool
}

func (k *fakeKeyring) Get(service, user string) (string, error) {
	if k.broken {
		return "", errors.New("no secret service")
	}
	if v, ok := k.items[service+"|"+user]; ok {
		return v, nil
	}
	return "", keyring.ErrNotFound
}

func (k *fakeKeyring) Set(service, user, password string) error {
	if k.broken {
		return errors.New("no secret service")
	}
	if k.items == nil {
		k.items = map[string]string{}
	}
	k.items[service+"|"+user] = password
	return nil
}

func (k *fakeKeyring) Delete(service, user string) error {
	if _, ok := k.items[service+"|"+user]; !ok {
		return keyring.ErrNotFound
	}
	delete(k.items, service+"|"+user)
	return nil
}

func verify(t *testing.T, k *Key, nonce string) {
	t.Helper()
	pub, err := base64.RawURLEncoding.DecodeString(k.PublicKey())
	if err != nil || len(pub) != ed25519.PublicKeySize || len(k.PublicKey()) != 43 {
		t.Fatalf("khoá công khai %q: %v", k.PublicKey(), err)
	}
	sig := k.Sign(hub+"/", "0198a1b2-0000-7000-8000-000000000001", nonce)
	raw, err := base64.RawURLEncoding.DecodeString(sig)
	if err != nil || len(sig) != 86 {
		t.Fatalf("chữ ký %q: %v", sig, err)
	}
	msg := "xdev-hive-machine-token\n" + hub + "\n0198a1b2-0000-7000-8000-000000000001\n" + nonce
	if !ed25519.Verify(pub, []byte(msg), raw) {
		t.Fatal("chữ ký không khớp thông điệp của hợp đồng")
	}
}

func TestKeychainFirst(t *testing.T) {
	kr := &fakeKeyring{}
	s := &Store{Keyring: kr, File: filepath.Join(t.TempDir(), "worker.key")}
	if _, err := s.Load(hub, machine); !errors.Is(err, ErrNoKey) {
		t.Fatalf("chưa có khoá: %v", err)
	}
	k, err := s.Create(hub, machine)
	if err != nil || k.Storage != StorageKeychain {
		t.Fatalf("tạo khoá: %+v, %v", k, err)
	}
	if _, err := os.Stat(s.File); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("có keychain thì không ghi file: %v", err)
	}
	got, err := s.Load(hub+"/", machine)
	if err != nil || got.PublicKey() != k.PublicKey() || got.Storage != StorageKeychain {
		t.Fatalf("đọc lại: %+v, %v", got, err)
	}
	verify(t, got, "1761206400.salt.mac")
	if _, err := s.Load(hub, "mac-binh"); !errors.Is(err, ErrNoKey) {
		t.Fatalf("máy khác cùng hub phải có khoá riêng: %v", err)
	}
	if err := s.Delete(hub, machine); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(hub, machine); !errors.Is(err, ErrNoKey) {
		t.Fatalf("đã xoá: %v", err)
	}
}

// Hai tổ chức trên cùng hub, cùng tên máy: tạo khoá cho đăng ký sau không được thay khoá của đăng ký trước (spec 034).
func TestScopeSeparatesRegistrations(t *testing.T) {
	kr := &fakeKeyring{}
	legacy := &Store{Keyring: kr}
	orgA := &Store{Keyring: kr, Scope: "reg_aaaaaaaa"}
	orgB := &Store{Keyring: kr, Scope: "reg_bbbbbbbb"}
	old, err := legacy.Create(hub, machine)
	if err != nil {
		t.Fatal(err)
	}
	a, err := orgA.Create(hub, machine)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := orgB.Load(hub, machine); !errors.Is(err, ErrNoKey) {
		t.Fatalf("đăng ký B chưa có khoá: %v", err)
	}
	b, err := orgB.Create(hub, machine)
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		s    *Store
		want string
	}{{legacy, old.PublicKey()}, {orgA, a.PublicKey()}, {orgB, b.PublicKey()}} {
		got, err := c.s.Load(hub, machine)
		if err != nil || got.PublicKey() != c.want {
			t.Fatalf("phạm vi %q: %+v, %v", c.s.Scope, got, err)
		}
	}
	if err := orgA.Delete(hub, machine); err != nil {
		t.Fatal(err)
	}
	if _, err := orgB.Load(hub, machine); err != nil {
		t.Fatalf("gỡ đăng ký A không được xoá khoá của B: %v", err)
	}
	if _, err := legacy.Load(hub, machine); err != nil {
		t.Fatalf("gỡ đăng ký A không được xoá khoá cũ: %v", err)
	}
}

func TestFileWhenNoKeychain(t *testing.T) {
	s := &Store{Keyring: &fakeKeyring{broken: true}, File: filepath.Join(t.TempDir(), "sub", "worker.key")}
	k, err := s.Create(hub, machine)
	if err != nil || k.Storage != StorageFile {
		t.Fatalf("tạo khoá: %+v, %v", k, err)
	}
	got, err := s.Load(hub, machine)
	if err != nil || got.PublicKey() != k.PublicKey() || got.Storage != StorageFile {
		t.Fatalf("đọc lại: %+v, %v", got, err)
	}
	verify(t, got, "n")
	// File còn sót từ lần đăng ký với hub khác thì không dùng.
	if _, err := s.Load("https://other.example.test", machine); !errors.Is(err, ErrNoKey) {
		t.Fatalf("hub khác: %v", err)
	}
	if err := os.WriteFile(s.File, []byte(hub+" "+machine+"\r\nAAAA\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(hub, machine); err == nil || errors.Is(err, ErrNoKey) {
		t.Fatalf("khoá cụt phải báo hỏng: %v", err)
	}
	if err := s.Delete(hub, machine); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(s.File); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("file còn sau khi xoá: %v", err)
	}
}

func TestNewStorePutsFileBesideConfig(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(filepath.Join(dir, "worker.json"))
	if s.File != filepath.Join(dir, "worker.key") {
		t.Fatalf("file khoá %s", s.File)
	}
}
