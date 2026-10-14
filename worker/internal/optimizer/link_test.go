package optimizer

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestLink(t *testing.T) {
	o, home := fakeHome(t)
	app := filepath.Join(home, "app")
	if err := os.MkdirAll(app, 0o755); err != nil {
		t.Fatal(err)
	}
	v1 := filepath.Join(app, "hive-worker-v1")
	v2 := filepath.Join(app, "hive-worker-v2")
	write(t, v1, "v1")
	write(t, v2, "v2")

	dest, err := o.Link(v1)
	if err != nil {
		t.Fatal(err)
	}
	if dest != o.LinkPath() || filepath.Dir(dest) != filepath.Join(home, ".xdev-hive", "bin") {
		t.Fatalf("đường dẫn: %s", dest)
	}
	check := func(want string) {
		t.Helper()
		if got := readString(t, dest); got != want {
			t.Fatalf("liên kết trỏ sai: %q", got)
		}
		st, err := os.Lstat(dest)
		if err != nil {
			t.Fatal(err)
		}
		isLink := st.Mode()&os.ModeSymlink != 0
		if runtime.GOOS == "windows" == isLink {
			t.Fatalf("Unix dùng symlink, Windows dùng bản sao: mode %v", st.Mode())
		}
	}
	check("v1")
	if _, err := o.Link(v1); err != nil {
		t.Fatal(err)
	}
	check("v1")
	// App cập nhật: sidecar đổi chỗ, liên kết theo bản mới.
	if _, err := o.Link(v2); err != nil {
		t.Fatal(err)
	}
	check("v2")
	// Lệnh chạy từ chính liên kết không được tạo liên kết vòng.
	if _, err := o.Link(dest); err != nil {
		t.Fatal(err)
	}
	check("v2")
	entries, _ := os.ReadDir(filepath.Dir(dest))
	for _, e := range entries {
		if e.Name() != filepath.Base(dest) && e.Name() != filepath.Base(dest)+".old" {
			t.Fatalf("còn file tạm: %s", e.Name())
		}
	}
}
