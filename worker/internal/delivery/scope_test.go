package delivery

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestScopedCredentialsDoNotCrossRegistrations(t *testing.T) {
	store := MapCredentials{"delivery/reg-a/jenkins": "a:tokenA", "delivery/reg-b/jenkins": "b:tokenB"}
	a := ScopedCredentials{Scope: Scope{RegistrationID: "reg-a"}, Store: store}
	b := ScopedCredentials{Scope: Scope{RegistrationID: "reg-b"}, Store: store}
	va, err := a.Read("jenkins")
	if err != nil || string(va) != "a:tokenA" {
		t.Fatalf("a = %q, %v", va, err)
	}
	vb, err := b.Read("jenkins")
	if err != nil || string(vb) != "b:tokenB" {
		t.Fatalf("b = %q, %v", vb, err)
	}
	c := ScopedCredentials{Scope: Scope{RegistrationID: "reg-c"}, Store: store}
	if _, err := c.Read("jenkins"); !errors.Is(err, ErrCredentialNotFound) {
		t.Fatalf("reg-c phải không thấy credential của tổ chức khác, got %v", err)
	}
}

func TestScopedCredentialsRejectBadNames(t *testing.T) {
	c := ScopedCredentials{Scope: Scope{RegistrationID: "reg-a"}, Store: MapCredentials{}}
	if _, err := c.Read("../reg-b/jenkins"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
	bad := ScopedCredentials{Scope: Scope{RegistrationID: "../x"}, Store: MapCredentials{}}
	if _, err := bad.Read("jenkins"); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
}

func TestScopeDirsAreSeparate(t *testing.T) {
	root := t.TempDir()
	a, b := Scope{RegistrationID: "reg-a"}, Scope{RegistrationID: "reg-b"}
	if a.LogDir(root) == b.LogDir(root) || a.WorkDir(root) == b.WorkDir(root) {
		t.Fatal("thư mục của hai đăng ký phải khác nhau")
	}
	if !strings.HasPrefix(a.LogDir(root), filepath.Join(root, "reg-a")) {
		t.Fatalf("LogDir = %s", a.LogDir(root))
	}
}
