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
