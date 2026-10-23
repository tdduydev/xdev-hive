package registry

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
)

func newBook(t *testing.T) Book {
	t.Helper()
	dir := t.TempDir()
	return Book{ConfigRoot: filepath.Join(dir, "config", "xdev-hive"), CacheRoot: filepath.Join(dir, "cache", "xdev-hive")}
}

// fakeHome trỏ thư mục nhà, cấu hình và cache của mọi hệ điều hành vào thư mục tạm cho Default().
func fakeHome(t *testing.T) Book {
	t.Helper()
	dir := t.TempDir()
	for _, k := range []string{"HOME", "USERPROFILE"} {
		t.Setenv(k, dir)
	}
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(dir, ".cache"))
	t.Setenv("AppData", filepath.Join(dir, "AppData", "Roaming"))
	t.Setenv("LocalAppData", filepath.Join(dir, "AppData", "Local"))
	t.Setenv(EnvWorkerConfig, "")
	t.Setenv(EnvRegistration, "")
	b, err := Default()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestEmptyMachineUsesLegacyPaths(t *testing.T) {
	b := newBook(t)
	ix, err := b.Load()
	if err != nil || len(ix.Registrations) != 0 {
		t.Fatalf("máy mới: %+v, %v", ix, err)
	}
	id, err := b.Selected("")
	if err != nil || id != LegacyID {
		t.Fatalf("máy chưa có sổ phải dùng đường dẫn cũ: %q, %v", id, err)
	}
	if got, want := b.ConfigPath(LegacyID), filepath.Join(b.ConfigRoot, "worker.json"); got != want {
		t.Fatalf("worker.json cũ: %s, muốn %s", got, want)
	}
	if got, want := b.DataDir(LegacyID), filepath.Join(b.CacheRoot, "worker"); got != want {
		t.Fatalf("thư mục dữ liệu cũ: %s, muốn %s", got, want)
	}
}

func TestLegacyConfigBecomesRegistration(t *testing.T) {
	b := newBook(t)
	if err := config.Save(b.ConfigPath(LegacyID), config.Config{HubURL: "https://hub.a", MachineID: "may", MachineToken: "hwm_x", OrgID: "org-a"}); err != nil {
		t.Fatal(err)
	}
	ix, err := b.Load()
	if err != nil {
		t.Fatal(err)
	}
	if ix.Active != LegacyID || len(ix.Registrations) != 1 || ix.Registrations[0].HubURL != "https://hub.a" {
		t.Fatalf("worker.json cũ phải thành reg_legacy: %+v", ix)
	}
	if _, err := os.Stat(b.IndexPath()); !os.IsNotExist(err) {
		t.Fatalf("chỉ đọc thì không ghi sổ: %v", err)
	}
	if r, ok := ix.FindOrg("https://hub.a/", "org-a"); !ok || r.ID != LegacyID {
		t.Fatalf("đăng ký cũ có orgId thì nhận ra trùng tổ chức: %+v", r)
	}
}

func TestAddSelectRemove(t *testing.T) {
	b := newBook(t)
	id, err := NewID()
	if err != nil || !ValidID(id) {
		t.Fatalf("id %q: %v", id, err)
	}
	other, _ := NewID()
	err = b.Update(func(ix *Index) error {
		ix.Registrations = append(ix.Registrations,
			Registration{ID: id, HubURL: "https://hub.a", OrgID: "org-a"},
			Registration{ID: other, HubURL: "https://hub.a", OrgID: "org-b"})
		ix.Active = id
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(b.IndexPath()); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("sổ phải 0600: %v, %v", info, err)
		}
	}
	if sel, err := b.Selected(""); err != nil || sel != id {
		t.Fatalf("đăng ký đang chọn: %q, %v", sel, err)
	}
	t.Setenv(EnvRegistration, other)
	if sel, err := b.Selected(""); err != nil || sel != other {
		t.Fatalf("HIVE_REGISTRATION thắng đăng ký đang chọn: %q, %v", sel, err)
	}
	if sel, err := b.Selected(id); err != nil || sel != id {
		t.Fatalf("cờ --registration thắng HIVE_REGISTRATION: %q, %v", sel, err)
	}
	if _, err := b.Selected("reg_zzzzzzzz"); err == nil {
		t.Fatal("id không có trong sổ phải báo lỗi, không rơi về đăng ký khác")
	}
	if _, err := b.Selected("../../etc"); err == nil {
		t.Fatal("id lạ phải bị chặn trước khi ghép đường dẫn")
	}
	if b.ConfigPath(id) == b.ConfigPath(other) || b.DataDir(id) == b.DataDir(other) {
		t.Fatal("hai đăng ký phải có cấu hình và dữ liệu riêng")
	}
	if !strings.HasPrefix(b.DataDir(id), b.CacheRoot) || strings.HasPrefix(b.DataDir(id), b.DataDir(LegacyID)) {
		t.Fatalf("dữ liệu đăng ký mới không nằm trong thư mục của đăng ký cũ: %s", b.DataDir(id))
	}
	if err := b.Update(func(ix *Index) error { ix.Remove(id); return nil }); err != nil {
		t.Fatal(err)
	}
	ix, _ := b.Load()
	if ix.Active != "" || len(ix.Registrations) != 1 {
		t.Fatalf("gỡ đăng ký đang chọn: %+v", ix)
	}
}

func TestPathsHonorWorkerConfigOverride(t *testing.T) {
	b := fakeHome(t)
	id, _ := NewID()
	if err := b.Update(func(ix *Index) error {
		ix.Registrations = append(ix.Registrations, Registration{ID: id, HubURL: "https://hub.a"})
		ix.Active = id
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	cfg, data, err := Paths("")
	if err != nil || cfg != b.ConfigPath(id) || data != b.DataDir(id) {
		t.Fatalf("đăng ký đang chọn: %s %s %v", cfg, data, err)
	}
	manual := filepath.Join(t.TempDir(), "w.json")
	t.Setenv(EnvWorkerConfig, manual)
	cfg, data, err = Paths("")
	if err != nil || cfg != manual || data != b.DataDir(LegacyID) {
		t.Fatalf("HIVE_WORKER_CONFIG bỏ qua sổ (FR-082): %s %s %v", cfg, data, err)
	}
	if cfg, _, _ = Paths(id); cfg != b.ConfigPath(id) {
		t.Fatalf("chọn đăng ký rõ ràng thì dùng sổ: %s", cfg)
	}
}

func TestKeyScope(t *testing.T) {
	if KeyScope(LegacyID) != "" || KeyScope("reg_abcdefgh") != "reg_abcdefgh" {
		t.Fatal("đăng ký cũ giữ khoá không phạm vi; đăng ký mới có phạm vi riêng")
	}
}
