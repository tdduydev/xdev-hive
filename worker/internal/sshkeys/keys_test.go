package sshkeys

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestDefaultKeyPath(t *testing.T) {
	if got := DefaultKeyPath("/home/ha"); got != filepath.Join("/home/ha", ".ssh", "id_ed25519") {
		t.Errorf("có %s", got)
	}
}

func TestGenerateKeyAndInspect(t *testing.T) {
	home := t.TempDir()
	path := DefaultKeyPath(home)
	info, err := GenerateKey(path, "ha@MAY xdev-hive 2026-10-17")
	if err != nil {
		t.Fatal(err)
	}
	if !info.Exists || info.Type != "ssh-ed25519" || !strings.HasPrefix(info.Fingerprint, "SHA256:") ||
		info.Comment != "ha@MAY xdev-hive 2026-10-17" || info.Encrypted {
		t.Fatalf("thông tin khoá sai: %+v", info)
	}
	if !strings.HasPrefix(info.PublicKey, "ssh-ed25519 AAAA") || !strings.HasSuffix(info.PublicKey, " ha@MAY xdev-hive 2026-10-17") {
		t.Errorf("dòng khoá công khai sai: %q", info.PublicKey)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.HasPrefix(raw, []byte("-----BEGIN OPENSSH PRIVATE KEY-----")) {
		t.Error("khoá riêng phải ở định dạng OpenSSH")
	}
	if _, err := ssh.ParseRawPrivateKey(raw); err != nil {
		t.Errorf("ssh không đọc lại được khoá riêng: %v", err)
	}
	again, err := InspectKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if again != info {
		t.Errorf("InspectKey khác kết quả lúc tạo:\n%+v\n%+v", again, info)
	}
	if runtime.GOOS != "windows" {
		for p, want := range map[string]os.FileMode{filepath.Dir(path): 0o700, path: 0o600, path + ".pub": 0o644} {
			if st, _ := os.Stat(p); st.Mode().Perm() != want {
				t.Errorf("%s: muốn %v, có %v", p, want, st.Mode().Perm())
			}
		}
	}
}

func TestGenerateKeyRefusesExisting(t *testing.T) {
	path := DefaultKeyPath(t.TempDir())
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := GenerateKey(path, "x"); !errors.Is(err, ErrKeyExists) {
		t.Fatalf("muốn ErrKeyExists, có %v", err)
	}
	if got, _ := os.ReadFile(path); string(got) != "keep" {
		t.Error("không được ghi đè khoá có sẵn")
	}
}

func TestInspectKeyMissing(t *testing.T) {
	info, err := InspectKey(filepath.Join(t.TempDir(), "id_ed25519"))
	if err != nil || info.Exists {
		t.Fatalf("khoá chưa có: muốn Exists=false, không lỗi; có %+v %v", info, err)
	}
}

func writeKey(t *testing.T, passphrase string, withPub bool) (string, ssh.PublicKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(priv, "c")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "c", []byte(passphrase))
	}
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	pk, _ := ssh.NewPublicKey(pub)
	if withPub {
		if err := os.WriteFile(path+".pub", ssh.MarshalAuthorizedKey(pk), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return path, pk
}

func TestInspectKeyEncrypted(t *testing.T) {
	for _, withPub := range []bool{true, false} {
		path, pk := writeKey(t, "bí mật", withPub)
		info, err := InspectKey(path)
		if err != nil {
			t.Fatal(err)
		}
		if !info.Encrypted || info.Fingerprint != ssh.FingerprintSHA256(pk) {
			t.Errorf("withPub=%v: khoá có passphrase phải có Encrypted và dấu vân tay; có %+v", withPub, info)
		}
	}
}

func TestInspectKeyWithoutPub(t *testing.T) {
	path, pk := writeKey(t, "", false)
	info, err := InspectKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Encrypted || info.Fingerprint != ssh.FingerprintSHA256(pk) || !strings.HasPrefix(info.PublicKey, "ssh-ed25519 ") {
		t.Errorf("thiếu .pub: phải dựng khoá công khai từ khoá riêng; có %+v", info)
	}
}

func TestKeyComment(t *testing.T) {
	day := time.Date(2026, 10, 17, 23, 0, 0, 0, time.UTC)
	for _, c := range []struct{ user, host, want string }{
		{"ha", "MAY 1", "ha@MAY_1 xdev-hive 2026-10-17"},
		{"duytd20", "DESKTOP-ABC", "duytd20@DESKTOP-ABC xdev-hive 2026-10-17"},
		{"Dư'y", "m;rm", "D__y@m_rm xdev-hive 2026-10-17"},
	} {
		if got := KeyComment(c.user, c.host, day); got != c.want {
			t.Errorf("KeyComment(%q, %q) = %q, muốn %q", c.user, c.host, got, c.want)
		}
	}
}

func TestAuthorizedLine(t *testing.T) {
	path, _ := writeKey(t, "", true)
	info, err := InspectKey(path)
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(info.PublicKey)
	info.Comment = "ha@x xdev-hive 2026-10-17"
	info.PublicKey = fields[0] + " " + fields[1] + " " + info.Comment
	line, err := AuthorizedLine(info)
	if err != nil || line != info.PublicKey {
		t.Errorf("giữ comment an toàn: có %q %v", line, err)
	}
	info.PublicKey = fields[0] + " " + fields[1] + " it's $(rm)"
	line, err = AuthorizedLine(info)
	if err != nil || line != fields[0]+" "+fields[1] {
		t.Errorf("comment có ký tự lạ phải bị bỏ: có %q %v", line, err)
	}
	if _, err := AuthorizedLine(KeyInfo{}); err == nil {
		t.Error("không có khoá công khai thì phải lỗi")
	}
}
