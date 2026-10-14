//go:build windows

package localipc

import (
	"errors"
	"path/filepath"
	"testing"
)

// Windows chưa có named pipe có DACL: không được mở socket nào thay thế.
func TestUnsupportedOnWindows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hive.sock")
	if _, err := Listen(path); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Listen: %v", err)
	}
	if _, _, err := Dial(path, "hive/test"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Dial: %v", err)
	}
}
