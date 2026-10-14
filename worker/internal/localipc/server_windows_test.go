//go:build windows

package localipc

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

// sockPath trả đường dẫn file như trên Unix; pipeName băm ra pipe riêng cho mỗi test.
func sockPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "run", "hive.sock")
}

func TestPipeName(t *testing.T) {
	if got := pipeName(`\\.\pipe\xdev-hive-x`); got != `\\.\pipe\xdev-hive-x` {
		t.Fatalf("tên pipe giữ nguyên: %q", got)
	}
	a, b := pipeName(`C:\a\hive.sock`), pipeName(`C:\b\hive.sock`)
	if a == b || !strings.HasPrefix(a, pipePrefix+"xdev-hive-") {
		t.Fatalf("pipe theo đường dẫn: %q %q", a, b)
	}
	if pipeName(`C:\A\HIVE.SOCK`) != a {
		t.Fatal("đường dẫn Windows không phân biệt hoa thường")
	}
	t.Setenv("HIVE_SOCKET", "")
	def, err := DefaultPath()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	if def != pipePrefix+"xdev-hive-"+sid.String() {
		t.Fatalf("pipe mặc định: %q", def)
	}
}

func TestPipeDACLOnlyCurrentUser(t *testing.T) {
	sid, err := currentSID()
	if err != nil {
		t.Fatal(err)
	}
	if got, want := pipeSDDL(sid), "D:P(A;;GA;;;"+sid.String()+")"; got != want {
		t.Fatalf("SDDL = %q, muốn %q", got, want)
	}
}

func TestSecondListenInUse(t *testing.T) {
	path := sockPath(t)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if _, err := Listen(path); !errors.Is(err, ErrInUse) {
		t.Fatalf("pipe đang dùng: %v", err)
	}
}

// Sau khi worker đóng, pipe biến mất nên worker mới mở lại được ngay (không có file cũ cần dọn như Unix socket).
func TestListenAfterClose(t *testing.T) {
	path := sockPath(t)
	ln, err := Listen(path)
	if err != nil {
		t.Fatal(err)
	}
	_ = ln.Close()
	if _, _, err := Dial(path, "hive/test"); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("pipe đã đóng: %v", err)
	}
	ln, err = Listen(path)
	if err != nil {
		t.Fatalf("mở lại: %v", err)
	}
	_ = ln.Close()
}
