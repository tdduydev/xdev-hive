package config

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSaveLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "worker.json")
	want := Config{HubURL: "https://hub.example", MachineID: "build-01", MachineToken: "hwm_secret", TeamID: "t"}
	if err := Save(path, want); err != nil {
		t.Fatal(err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	want.Path = path
	if got != want {
		t.Fatalf("got %+v", got)
	}
	// Windows không có bit quyền kiểu Unix; ở đó quyền theo ACL của thư mục người dùng.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("quyền file = %o, cần 600", perm)
		}
	}
}

func TestSaveOverwrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker.json")
	if err := Save(path, Config{MachineToken: "cu"}); err != nil {
		t.Fatal(err)
	}
	if err := Save(path, Config{MachineToken: "moi"}); err != nil {
		t.Fatal(err)
	}
	got, _ := Load(path)
	if got.MachineToken != "moi" {
		t.Fatalf("token = %q", got.MachineToken)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("còn file tạm: %v", entries)
	}
}

func TestSaveKeepsPathOutOfFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "worker.json")
	if err := Save(path, Config{HubURL: "https://hub.example", Path: "/khac/worker.json"}); err != nil {
		t.Fatal(err)
	}
	got, _ := Load(path)
	if got.Path != path {
		t.Fatalf("Path = %q, cần file vừa đọc", got.Path)
	}
}

func TestRegistered(t *testing.T) {
	base := Config{HubURL: "https://hub.example", MachineID: "may-1"}
	cases := []struct {
		name string
		cfg  func(Config) Config
		want bool
	}{
		{"chỉ có địa chỉ", func(c Config) Config { return c }, false},
		{"machine token", func(c Config) Config { c.MachineToken = "hwm_x"; return c }, true},
		{"khoá máy", func(c Config) Config { c.ID, c.KeyStorage = "id", "file"; return c }, true},
		{"khoá máy thiếu id", func(c Config) Config { c.KeyStorage = "file"; return c }, false},
		{"thiếu hub", func(c Config) Config { c.HubURL, c.MachineToken = "", "hwm_x"; return c }, false},
	}
	for _, tc := range cases {
		if got := tc.cfg(base).Registered(); got != tc.want {
			t.Errorf("%s: Registered() = %v", tc.name, got)
		}
	}
}

func TestLoadMissing(t *testing.T) {
	_, err := Load(filepath.Join(t.TempDir(), "khong-co.json"))
	if !errors.Is(err, ErrNotRegistered) {
		t.Fatalf("err = %v", err)
	}
}

func TestDefaultPathEnv(t *testing.T) {
	t.Setenv("HIVE_WORKER_CONFIG", "/tmp/x.json")
	if p, _ := DefaultPath(); p != "/tmp/x.json" {
		t.Fatalf("path = %q", p)
	}
}
