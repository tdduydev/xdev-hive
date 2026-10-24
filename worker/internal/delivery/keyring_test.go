package delivery

import (
	"errors"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

const keyringValue = "bot:fake-jenkins-token-never-print"

func keyringScope(t *testing.T) (ScopedCredentials, *secretstore.Store) {
	t.Helper()
	keyring.MockInit()
	store := secretstore.NewDeliveryStore()
	return ScopedCredentials{Scope: Scope{RegistrationID: "reg_legacy"}, Store: KeyringCredentials{Store: store}}, store
}

func TestKeyringCredentialsReadsDeliveryNamespace(t *testing.T) {
	c, store := keyringScope(t)
	if err := store.Set(secretstore.DeliveryAccount("reg_legacy", "jenkins-prod"), keyringValue); err != nil {
		t.Fatal(err)
	}
	v, err := readCredential(c, "jenkins-prod")
	if err != nil || string(v) != keyringValue {
		t.Fatalf("đọc credential: lỗi %v", err)
	}
	// Đăng ký khác cùng máy không thấy credential này.
	other := ScopedCredentials{Scope: Scope{RegistrationID: "reg_abcd2345"}, Store: c.Store}
	if _, err := readCredential(other, "jenkins-prod"); CodeOf(err) != CodeMissingCredential {
		t.Fatalf("got %v", err)
	}
}

func TestKeyringCredentialsIgnoreProjectSecrets(t *testing.T) {
	c, _ := keyringScope(t)
	// Cùng khoá nhưng ở kho bí mật dự án (FR-062): delivery không được đọc sang.
	if err := secretstore.NewStore().Set(c.Key("jenkins-prod"), keyringValue); err != nil {
		t.Fatal(err)
	}
	_, err := readCredential(c, "jenkins-prod")
	if CodeOf(err) != CodeMissingCredential || !strings.Contains(err.Error(), "Thêm ở màn Bí mật") {
		t.Fatalf("got %v", err)
	}
}

func TestKeyringCredentialsCorruptAndBrokenStore(t *testing.T) {
	c, _ := keyringScope(t)
	if err := keyring.Set(secretstore.DeliveryService, c.Key("argocd"), "not-a-chunk-header"); err != nil {
		t.Fatal(err)
	}
	_, err := readCredential(c, "argocd")
	if CodeOf(err) != CodeMissingCredential || !strings.Contains(err.Error(), "bị hỏng") {
		t.Fatalf("got %v", err)
	}
	// Thông báo không lộ khoá trong kho của đăng ký.
	if strings.Contains(err.Error(), "delivery/") {
		t.Fatalf("thông báo lộ khoá kho: %v", err)
	}

	keyring.MockInitWithError(errors.New("backend failed for " + keyringValue))
	_, err = readCredential(c, "argocd")
	if CodeOf(err) != CodeUnavailable || strings.Contains(err.Error(), keyringValue) {
		t.Fatalf("got %v", err)
	}
	// macOS không thử đọc để khỏi bật hộp thoại Keychain, nên chỉ kiểm: đã báo không dùng được thì phải có lý do.
	if ok, reason := (KeyringCredentials{Store: secretstore.NewDeliveryStore()}).Available(); !ok && reason == "" {
		t.Fatal("kho không dùng được phải có lý do")
	}
}

func TestKeyringCredentialsAvailable(t *testing.T) {
	keyring.MockInit()
	if ok, reason := (KeyringCredentials{Store: secretstore.NewDeliveryStore()}).Available(); !ok || reason != "" {
		t.Fatalf("Available = %v, %q", ok, reason)
	}
	if ok, reason := (KeyringCredentials{}).Available(); ok || reason == "" {
		t.Fatalf("không có kho phải báo, got %v %q", ok, reason)
	}
}
