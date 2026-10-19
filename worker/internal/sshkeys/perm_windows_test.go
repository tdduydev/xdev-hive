//go:build windows

package sshkeys

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func daclOf(t *testing.T, path string) (protected bool, aces uint16) {
	t.Helper()
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	return control&windows.SE_DACL_PROTECTED != 0, dacl.AceCount
}

func TestRestrictPrivateWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := restrictPrivate(path); err != nil {
		t.Fatal(err)
	}
	protected, aces := daclOf(t, path)
	if !protected || aces != 3 {
		t.Errorf("muốn DACL bảo vệ với 3 ACE (người dùng, SYSTEM, Administrators), có protected=%v aces=%d", protected, aces)
	}
}

func TestCopySecurityKeepsProtectedDACL(t *testing.T) {
	dir := t.TempDir()
	from, to := filepath.Join(dir, "config"), filepath.Join(dir, "config.tmp")
	for _, p := range []string{from, to} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := restrictPrivate(from); err != nil {
		t.Fatal(err)
	}
	if protected, _ := daclOf(t, to); protected {
		t.Fatal("file tạm mới tạo không được có DACL bảo vệ sẵn")
	}
	if err := copySecurity(from, to); err != nil {
		t.Fatal(err)
	}
	if protected, aces := daclOf(t, to); !protected || aces != 3 {
		t.Errorf("file tạm phải nhận DACL của file cũ, có protected=%v aces=%d", protected, aces)
	}
}
