package secretstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 23, 8, 0, 0, 0, time.UTC)

func catalogPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "secrets.json")
}

func TestCatalogRoundTripHasNoValueTrace(t *testing.T) {
	path := catalogPath(t)
	err := ModifyCatalog(path, func(c *Catalog) error {
		if _, err := c.Add("STRIPE_TEST_KEY", "Khoá Stripe môi trường test, quyền đọc", t0.Add(123*time.Millisecond)); err != nil {
			return err
		}
		_, err := c.Assign("STRIPE_TEST_KEY", "3f9a1c0e7b2d4a55")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// FR-002: file danh mục không có giá trị, băm hay độ dài giá trị; kiểm bằng danh sách khoá JSON đúng như data-model.
	var shape struct {
		Version int              `json:"version"`
		Secrets []map[string]any `json:"secrets"`
	}
	if err := json.Unmarshal(raw, &shape); err != nil {
		t.Fatal(err)
	}
	for k := range shape.Secrets[0] {
		switch k {
		case "name", "description", "createdAt", "valueChangedAt", "projects":
		default:
			t.Errorf("danh mục có khoá lạ %q", k)
		}
	}
	if shape.Version != CatalogVersion {
		t.Fatalf("danh mục sai: version %d", shape.Version)
	}
	if !strings.Contains(string(raw), `"createdAt": "2026-10-23T08:00:00Z"`) {
		t.Fatalf("thời điểm phải UTC tới giây:\n%s", raw)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(path)
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("quyền %v, muốn 0600", st.Mode().Perm())
		}
	}

	c, err := LoadCatalog(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.ForProject("3f9a1c0e7b2d4a55"); len(got) != 1 || got[0].Name != "STRIPE_TEST_KEY" {
		t.Fatalf("ForProject: %+v", got)
	}
}

func TestCatalogMissingFileIsEmpty(t *testing.T) {
	c, err := LoadCatalog(catalogPath(t))
	if err != nil || c.Version != CatalogVersion || len(c.Secrets) != 0 {
		t.Fatalf("file chưa có: %+v %v", c, err)
	}
	if err := DropProject(catalogPath(t), "abc"); err != nil {
		t.Fatalf("DropProject khi chưa có danh mục: %v", err)
	}
}

func TestCatalogNewerVersionIsReadOnly(t *testing.T) {
	path := catalogPath(t)
	orig := `{"version":2,"secrets":[{"name":"A_KEY","description":"","projects":["p1"],"future":true}]}`
	if err := os.WriteFile(path, []byte(orig), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err := LoadCatalog(path)
	if err != nil || c.Find("A_KEY") == nil {
		t.Fatalf("bản mới hơn vẫn phải đọc được: %v", err)
	}
	err = ModifyCatalog(path, func(c *Catalog) error { return c.Remove("A_KEY") })
	if !errors.Is(err, ErrCatalogNewer) || !strings.Contains(err.Error(), "bản mới hơn") {
		t.Fatalf("ghi danh mục bản mới hơn: %v", err)
	}
	if b, _ := os.ReadFile(path); string(b) != orig {
		t.Fatal("danh mục bản mới hơn bị ghi đè")
	}
}

func TestCatalogChangeErrorKeepsFile(t *testing.T) {
	path := catalogPath(t)
	if err := ModifyCatalog(path, func(c *Catalog) error { _, err := c.Add("A_KEY", "", t0); return err }); err != nil {
		t.Fatal(err)
	}
	err := ModifyCatalog(path, func(c *Catalog) error {
		if _, err := c.Add("B_KEY", "", t0); err != nil {
			return err
		}
		_, err := c.Add("A_KEY", "", t0)
		return err
	})
	if !errors.Is(err, &Error{Code: CodeDuplicateName}) {
		t.Fatalf("trùng tên: %v", err)
	}
	c, _ := LoadCatalog(path)
	if c.Find("B_KEY") != nil {
		t.Fatal("change lỗi mà danh mục vẫn được ghi")
	}
}

func TestCatalogOperations(t *testing.T) {
	var c Catalog
	if _, err := c.Add("path", "", t0); !errors.Is(err, &Error{Code: CodeInvalidName}) {
		t.Fatalf("tên viết thường: %v", err)
	}
	if _, err := c.Add("HIVE_TOKEN", "", t0); !errors.Is(err, &Error{Code: CodeReservedName}) {
		t.Fatalf("tên dành riêng: %v", err)
	}
	for _, n := range []string{"B_KEY", "A_KEY"} {
		if _, err := c.Add(n, "", t0); err != nil {
			t.Fatal(err)
		}
	}
	if c.Secrets[0].Name != "A_KEY" {
		t.Fatal("danh mục phải xếp theo tên")
	}

	if _, err := c.Rename("A_KEY", "B_KEY"); !errors.Is(err, &Error{Code: CodeDuplicateName}) {
		t.Fatalf("đổi sang tên đã có: %v", err)
	}
	if _, err := c.Rename("NOPE", "C_KEY"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("đổi tên không có: %v", err)
	}
	if s, err := c.Rename("A_KEY", "Z_KEY"); err != nil || s.Name != "Z_KEY" || c.Secrets[1].Name != "Z_KEY" {
		t.Fatalf("đổi tên: %v", err)
	}

	if _, err := c.Assign("Z_KEY", "p1"); err != nil {
		t.Fatal(err)
	}
	if s, _ := c.Assign("Z_KEY", "p1"); len(s.Projects) != 1 {
		t.Fatal("gán lại không được thêm localId trùng")
	}
	if s, _ := c.Unassign("Z_KEY", "p1"); len(s.Projects) != 0 {
		t.Fatal("bỏ gán")
	}

	later := t0.Add(time.Hour)
	if s, _ := c.ValueChanged("Z_KEY", later); !s.ValueChangedAt.Equal(later) || !s.CreatedAt.Equal(t0) {
		t.Fatal("ValueChanged chỉ đổi valueChangedAt")
	}

	if err := c.Remove("Z_KEY"); err != nil || c.Find("Z_KEY") != nil {
		t.Fatalf("xoá: %v", err)
	}
	if err := c.Remove("Z_KEY"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("xoá lần hai: %v", err)
	}
}

func TestCatalogMaxPerProject(t *testing.T) {
	var c Catalog
	for i := 0; i <= MaxPerProject; i++ {
		name := fmt.Sprintf("KEY_%02d", i)
		if _, err := c.Add(name, "", t0); err != nil {
			t.Fatal(err)
		}
		_, err := c.Assign(name, "p1")
		if i < MaxPerProject && err != nil {
			t.Fatalf("gán thứ %d: %v", i+1, err)
		}
		if i == MaxPerProject {
			if !errors.Is(err, &Error{Code: CodeTooMany}) || err.Error() != "Dự án đã có 64 bí mật." {
				t.Fatalf("gán thứ 65: %v", err)
			}
		}
	}
	if _, err := c.Assign("KEY_64", "p2"); err != nil {
		t.Fatalf("giới hạn tính theo từng dự án: %v", err)
	}
}

func TestCatalogDropAndRetainProjects(t *testing.T) {
	path := catalogPath(t)
	err := ModifyCatalog(path, func(c *Catalog) error {
		for _, n := range []string{"A_KEY", "B_KEY"} {
			if _, err := c.Add(n, "", t0); err != nil {
				return err
			}
			for _, p := range []string{"p1", "p2", "gone"} {
				if _, err := c.Assign(n, p); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := DropProject(path, "p1"); err != nil {
		t.Fatal(err)
	}
	c, _ := LoadCatalog(path)
	if len(c.ForProject("p1")) != 0 || len(c.ForProject("p2")) != 2 {
		t.Fatal("DropProject chỉ gỡ đúng localId")
	}
	c.RetainProjects(func(id string) bool { return id != "gone" })
	if s := c.Find("A_KEY"); len(s.Projects) != 1 || s.Projects[0] != "p2" {
		t.Fatalf("RetainProjects: %v", s.Projects)
	}
}

func TestValidDescription(t *testing.T) {
	if err := ValidDescription(""); err != nil {
		t.Fatalf("mô tả rỗng: %v", err)
	}
	if err := ValidDescription(strings.Repeat("ặ", MaxDescriptionLen)); err != nil {
		t.Fatalf("500 ký tự nhiều byte: %v", err)
	}
	if err := ValidDescription(strings.Repeat("a", MaxDescriptionLen+1)); !errors.Is(err, &Error{Code: CodeInvalidDescription}) {
		t.Fatalf("501 ký tự: %v", err)
	}
	err := ValidDescription("dùng password=hunter22x cho môi trường test")
	if !errors.Is(err, &Error{Code: CodeDescriptionSecret}) || strings.Contains(err.Error(), "hunter22x") {
		t.Fatalf("mô tả có bí mật: %v", err)
	}
	var c Catalog
	if _, err := c.Add("A_KEY", "password=hunter22x", t0); !errors.Is(err, &Error{Code: CodeDescriptionSecret}) || c.Find("A_KEY") != nil {
		t.Fatalf("Add phải chặn mô tả có bí mật: %v", err)
	}
}
