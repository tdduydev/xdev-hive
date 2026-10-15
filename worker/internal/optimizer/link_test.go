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

	dest, err := o.Link(v1, "")
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
	if _, err := o.Link(v1, ""); err != nil {
		t.Fatal(err)
	}
	check("v1")
	// App cập nhật: sidecar đổi chỗ, liên kết theo bản mới.
	if _, err := o.Link(v2, ""); err != nil {
		t.Fatal(err)
	}
	check("v2")
	// Lệnh chạy từ chính liên kết không được tạo liên kết vòng.
	if _, err := o.Link(dest, ""); err != nil {
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

func TestLinkHive(t *testing.T) {
	o, home := fakeHome(t)
	name := "hive"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.MkdirAll(filepath.Join(home, "bundle"), 0o755); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(home, "bundle", "hive-worker")
	var hive string
	write(t, worker, "worker-v1")
	dest := filepath.Join(filepath.Dir(o.LinkPath()), name)
	for _, version := range []string{"hive-v1", "hive-v2"} {
		bundle := filepath.Join(home, version)
		if err := os.MkdirAll(bundle, 0o755); err != nil {
			t.Fatal(err)
		}
		hive = filepath.Join(bundle, name)
		write(t, hive, version)
		if _, err := o.Link(worker, hive); err != nil {
			t.Fatal(err)
		}
		if got := readString(t, dest); got != version {
			t.Fatalf("hive: %q, muốn %q", got, version)
		}
		st, err := os.Lstat(dest)
		if err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS == "windows" == (st.Mode()&os.ModeSymlink != 0) {
			t.Fatalf("Unix dùng symlink, Windows dùng bản sao: %v", st.Mode())
		}
	}
	if _, err := o.Link(o.LinkPath(), dest); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, dest); got != "hive-v2" {
		t.Fatalf("chạy từ liên kết: %q", got)
	}
	// Bundle cũ không có hive không được làm mất binary đã đặt trước đó.
	if _, err := o.Link(worker, filepath.Join(home, "missing", name)); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, dest); got != "hive-v2" {
		t.Fatalf("mất hive đã đặt: %q", got)
	}
	entries, err := os.ReadDir(filepath.Dir(dest))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() != name && e.Name() != filepath.Base(o.LinkPath()) && e.Name() != name+".old" {
			t.Fatalf("còn file tạm: %s", e.Name())
		}
	}
}

func TestLinkMissingHive(t *testing.T) {
	o, home := fakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, "bundle"), 0o755); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(home, "bundle", "hive-worker")
	write(t, worker, "worker")
	if _, err := o.Link(worker, filepath.Join(home, "bundle", "missing-hive")); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, o.LinkPath()); got != "worker" {
		t.Fatalf("worker: %q", got)
	}
	entries, err := os.ReadDir(filepath.Dir(o.LinkPath()))
	if err != nil || len(entries) != 1 {
		t.Fatalf("thiếu hive vẫn tạo file: %v, %v", entries, err)
	}
}

func TestLinkHiveFailure(t *testing.T) {
	o, home := fakeHome(t)
	if err := os.MkdirAll(filepath.Join(home, "bundle"), 0o755); err != nil {
		t.Fatal(err)
	}
	worker := filepath.Join(home, "bundle", "hive-worker")
	hive := filepath.Join(home, "bundle", "hive")
	write(t, worker, "worker")
	write(t, hive, "hive")
	name := "hive"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if err := os.MkdirAll(filepath.Join(filepath.Dir(o.LinkPath()), name), 0o755); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(filepath.Dir(o.LinkPath()), name, "occupied"), "giữ thư mục")
	if runtime.GOOS == "windows" {
		// Chặn cả tên dự phòng vì Windows thử đổi tên đích đang bận trước khi chép.
		old := filepath.Join(filepath.Dir(o.LinkPath()), name+".old")
		if err := os.MkdirAll(old, 0o755); err != nil {
			t.Fatal(err)
		}
		write(t, filepath.Join(old, "occupied"), "giữ thư mục")
	}
	if _, err := o.Link(worker, hive); err == nil {
		t.Fatal("phải báo lỗi khi không đặt được hive")
	}
}
