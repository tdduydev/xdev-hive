//go:build !windows

package localipc

import (
	"errors"
	"net"
	"os"
	"path/filepath"
	"testing"
)

// sockPath trả đường dẫn socket ngắn: t.TempDir() trên macOS dài quá giới hạn 104 byte của sun_path.
func sockPath(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "hs")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return filepath.Join(dir, "run", "hive.sock")
}

func TestPermissions(t *testing.T) {
	path := start(t, &Server{})
	for p, want := range map[string]os.FileMode{filepath.Dir(path): 0o700, path: 0o600} {
		fi, err := os.Stat(p)
		if err != nil {
			t.Fatal(err)
		}
		if fi.Mode().Perm() != want {
			t.Fatalf("%s: quyền %o, muốn %o", p, fi.Mode().Perm(), want)
		}
	}
}

func TestDirTightened(t *testing.T) {
	path := sockPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if fi, _ := os.Stat(filepath.Dir(path)); fi.Mode().Perm() != 0o700 {
		t.Fatalf("thư mục còn quyền %o", fi.Mode().Perm())
	}
}

func TestStaleSocketRemoved(t *testing.T) {
	path := sockPath(t)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	old, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	// Như worker chết: file socket còn, không ai nghe.
	old.(*net.UnixListener).SetUnlinkOnClose(false)
	_ = old.Close()
	if _, _, err := Dial(path, "hive/test"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("socket cũ: %v", err)
	}
	ln, err := Listen(path)
	if err != nil {
		t.Fatalf("phải dọn socket cũ: %v", err)
	}
	defer ln.Close()
	// Còn worker đang nghe: không cướp socket.
	if _, err := Listen(path); !errors.Is(err, ErrInUse) {
		t.Fatalf("socket đang dùng: %v", err)
	}
	// File thường ở chỗ socket: không xoá.
	plain := filepath.Join(filepath.Dir(path), "plain")
	if err := os.WriteFile(plain, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Listen(plain); err == nil {
		t.Fatal("không được xoá file không phải socket")
	}
	if _, err := os.Stat(plain); err != nil {
		t.Fatalf("file thường bị xoá: %v", err)
	}
}
