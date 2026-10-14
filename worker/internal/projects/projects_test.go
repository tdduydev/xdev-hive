package projects

import (
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	idA = "0a0a0a0a-0000-4000-8000-00000000000a"
	idB = "0a0a0a0a-0000-4000-8000-00000000000b"
)

func must(t *testing.T, args ...string) {
	t.Helper()
	if b, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %s: %v", args, b, err)
	}
}

// repo tạo một repo git có origin trỏ tới origin, trả thư mục gốc của nó.
func repo(t *testing.T, origin string) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "app")
	must(t, "git", "init", "-q", dir)
	if origin != "" {
		must(t, "git", "-C", dir, "remote", "add", "origin", origin)
	}
	return dir
}

func TestSameRepo(t *testing.T) {
	dir := t.TempDir()
	fileURL := (&url.URL{Scheme: "file", Path: filepath.ToSlash(dir)}).String()
	for _, tc := range []struct {
		a, b string
		want bool
	}{
		{"https://github.com/acme/payment-api.git", "git@github.com:acme/payment-api.git", true},
		{"https://github.com/acme/payment-api", "ssh://git@github.com:22/acme/payment-api.git", true},
		{"https://x-access-token:secret@github.com/Acme/Payment-API.git", "https://github.com/acme/payment-api", true},
		{"https://gitlab.example.com/group/sub/app.git/", "git@gitlab.example.com:group/sub/app", true},
		{"https://github.com/acme/payment-api", "https://github.com/acme/payment-api-v2", false},
		{"https://github.com/acme/app", "https://gitlab.com/acme/app", false},
		{fileURL, dir, true},
		{dir, filepath.Join(dir, "other"), false},
		{"", "", false},
		{"https://github.com/acme/app", "", false},
	} {
		if got := SameRepo(tc.a, tc.b); got != tc.want {
			t.Errorf("SameRepo(%q, %q) = %v, muốn %v", tc.a, tc.b, got, tc.want)
		}
	}
	// Ổ đĩa của Windows không bị hiểu nhầm thành máy chủ một chữ của dạng scp.
	if k := repoKey(`C:\Users\ha\app`); !strings.HasPrefix(k, "file:") {
		t.Fatalf("repoKey ổ đĩa = %q", k)
	}
}

func TestRedact(t *testing.T) {
	for in, want := range map[string]string{
		"https://x-access-token:secret@github.com/acme/app.git": "https://github.com/acme/app.git",
		"https://token@github.com/acme/app.git":                 "https://github.com/acme/app.git",
		"ssh://git@github.com/acme/app.git":                     "ssh://git@github.com/acme/app.git",
		"git@github.com:acme/app.git":                           "git@github.com:acme/app.git",
	} {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, muốn %q", in, got, want)
		}
	}
}

// Bốn ca quyền thực dùng của ADR 0020, cộng máy chưa gắn dự án (theo hub như cũ).
func TestEffective(t *testing.T) {
	on, off := &Project{FullPermission: true}, &Project{}
	for _, tc := range []struct {
		name    string
		p       *Project
		hub     string
		allowed bool
		want    string
	}{
		{"máy bật, tổ chức cho", on, "workspace", true, "full"},
		{"máy bật, tổ chức cấm", on, "full", false, "workspace"},
		{"máy tắt, tổ chức cho", off, "full", true, "workspace"},
		{"máy tắt, tổ chức cấm", off, "workspace", false, "workspace"},
		{"chưa gắn: theo hub full", nil, "full", true, "full"},
		{"chưa gắn: theo hub workspace", nil, "workspace", true, "workspace"},
		{"chưa gắn: hub cũ không gửi", nil, "", false, ""},
	} {
		if got := Effective(tc.p, tc.hub, tc.allowed); got != tc.want {
			t.Errorf("%s: %q, muốn %q", tc.name, got, tc.want)
		}
	}
}

func TestBindSetUnbind(t *testing.T) {
	file := filepath.Join(t.TempDir(), "projects.json")
	if list, err := Load(file); err != nil || len(list) != 0 {
		t.Fatalf("file chưa có: %v, %v", list, err)
	}
	dir := repo(t, "git@github.com:acme/payment-api.git")
	sub := filepath.Join(dir, "src")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	// Remote không khớp thì không ghi gì.
	err := Bind(file, idA, dir, "", "https://github.com/acme/other")
	if err == nil || !strings.Contains(err.Error(), "không khớp") {
		t.Fatalf("Bind remote sai: %v", err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("Bind lỗi mà vẫn ghi file")
	}
	// Chọn thư mục con thì gắn gốc repo; id viết hoa vẫn lưu chữ thường như hub gửi.
	if err := Bind(file, strings.ToUpper(idA), sub, "", "https://github.com/acme/payment-api"); err != nil {
		t.Fatal(err)
	}
	list, _ := Load(file)
	p := Find(list, idA)
	if p == nil || !samePath(p.Folder, dir) || p.Name != "app" || p.FullPermission {
		t.Fatalf("mục sau Bind = %+v", list)
	}
	if err := SetFull(file, idA, true); err != nil {
		t.Fatal(err)
	}
	// Gắn lại (đổi tên) giữ công tắc toàn quyền.
	if err := Bind(file, idA, dir, "payment-api", ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if p := Find(list, idA); len(list) != 1 || p == nil || !p.FullPermission || p.Name != "payment-api" {
		t.Fatalf("gắn lại = %+v", list)
	}
	if err := SetFull(file, idB, true); err == nil {
		t.Fatal("bật toàn quyền cho dự án chưa gắn")
	}
	if err := Bind(file, "khong-phai-uuid", dir, "", ""); err == nil {
		t.Fatal("nhận id không phải UUID")
	}
	if err := Bind(file, idB, filepath.Join(t.TempDir(), "mat"), "", ""); err == nil || !strings.Contains(err.Error(), "không tìm thấy") {
		t.Fatalf("thư mục không có: %v", err)
	}
	if err := Bind(file, idB, t.TempDir(), "", ""); err == nil || !strings.Contains(err.Error(), "không phải repo git") {
		t.Fatalf("thư mục không phải repo: %v", err)
	}
	if err := Unbind(file, idA); err != nil {
		t.Fatal(err)
	}
	if err := Unbind(file, idA); err == nil {
		t.Fatal("bỏ gắn lần hai không báo lỗi")
	}
	if list, _ := Load(file); len(list) != 0 {
		t.Fatalf("còn mục: %+v", list)
	}
	if runtime.GOOS != "windows" {
		if st, err := os.Stat(file); err != nil || st.Mode().Perm() != 0o600 {
			t.Fatalf("quyền file: %v, %v", st, err)
		}
	}
	// Ghi qua file tạm rồi đổi tên: không để lại file tạm hay khoá.
	entries, _ := os.ReadDir(filepath.Dir(file))
	if len(entries) != 1 {
		t.Fatalf("thư mục còn file khác: %v", entries)
	}
}

func TestImportLegacyThenBindReplacesUnlinked(t *testing.T) {
	home := t.TempDir()
	dir := repo(t, "https://github.com/acme/app.git")
	legacy := LegacyPath(home)
	if err := os.MkdirAll(filepath.Dir(legacy), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := `{"projects":[{"name":"app","repo":` + quote(dir) + `},{"name":"cu","repo":` + quote(filepath.Join(home, "cu")) + `},{"name":"trung","repo":` + quote(dir) + `},{"name":"rong","repo":""}],"agents":[{"id":"x","env":{"ANTHROPIC_API_KEY":"bi-mat"}}]}`
	if err := os.WriteFile(legacy, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "projects.json")
	n, err := ImportLegacy(legacy, file, false)
	if err != nil || n != 2 {
		t.Fatalf("nhập = %d, %v", n, err)
	}
	if b, _ := os.ReadFile(file); strings.Contains(string(b), "bi-mat") {
		t.Fatal("chép cả biến môi trường của app v1")
	}
	list, _ := Load(file)
	if len(list) != 2 || list[0].ProjectID != "" || list[0].Name != "app" {
		t.Fatalf("mục nhập = %+v", list)
	}
	// Lần sau không nhập lại.
	if n, err := ImportLegacy(legacy, file, false); err != nil || n != 0 {
		t.Fatalf("nhập lần hai = %d, %v", n, err)
	}
	// Không có báo cáo nào cho repo chưa gắn dự án.
	if bound, full := Report(list); len(bound) != 0 || len(full) != 0 {
		t.Fatalf("Report = %v, %v", bound, full)
	}
	if err := Bind(file, idA, dir, "", ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if len(list) != 2 || Find(list, idA) == nil {
		t.Fatalf("gắn không thay mục chưa gắn: %+v", list)
	}
	if err := UnbindFolder(file, filepath.Join(home, "cu")); err != nil {
		t.Fatal(err)
	}
	if list, _ := Load(file); len(list) != 1 {
		t.Fatalf("bỏ repo chưa gắn: %+v", list)
	}
	// File app v1 không có: vẫn ghi file rỗng để không hỏi lại.
	empty := filepath.Join(t.TempDir(), "projects.json")
	if n, err := ImportLegacy(filepath.Join(home, "khong-co.json"), empty, false); err != nil || n != 0 {
		t.Fatalf("không có app v1: %d, %v", n, err)
	}
	if _, err := os.Stat(empty); err != nil {
		t.Fatal("chưa ghi file rỗng")
	}
}

func quote(s string) string { return `"` + strings.ReplaceAll(s, `\`, `\\`) + `"` }

func TestReportSkipsInvalidIDs(t *testing.T) {
	list := []Project{
		{ProjectID: strings.ToUpper(idA), FullPermission: true},
		{ProjectID: idB},
		{ProjectID: "sua-tay-hong", FullPermission: true},
		{Name: "chưa gắn", FullPermission: true},
	}
	bound, full := Report(list)
	if strings.Join(bound, ",") != idA+","+idB || strings.Join(full, ",") != idA {
		t.Fatalf("Report = %v, %v", bound, full)
	}
	many := make([]Project, MaxReported+5)
	for i := range many {
		many[i] = Project{ProjectID: idA, FullPermission: true}
	}
	if bound, full := Report(many); len(bound) != MaxReported || len(full) != MaxReported {
		t.Fatalf("không chặn số mục: %d, %d", len(bound), len(full))
	}
}

func TestInspect(t *testing.T) {
	dir := repo(t, "https://x-access-token:secret@github.com/acme/app.git")
	plain := t.TempDir()
	views := Inspect([]Project{{ProjectID: idA, Folder: dir}, {ProjectID: idB, Folder: plain}, {Folder: filepath.Join(plain, "mat")}})
	if v := views[0]; !v.Exists || !v.IsGit || v.Origin != "https://github.com/acme/app.git" {
		t.Fatalf("repo = %+v", v)
	}
	if v := views[1]; !v.Exists || v.IsGit || v.Origin != "" {
		t.Fatalf("thư mục thường = %+v", v)
	}
	if v := views[2]; v.Exists {
		t.Fatalf("thư mục mất = %+v", v)
	}
}

func TestAddFolderSkipsKnownFolders(t *testing.T) {
	dir := repo(t, "https://gitlab.com/acme/api.git")
	file := filepath.Join(t.TempDir(), "projects.json")
	if err := Bind(file, idA, dir, "api", ""); err != nil {
		t.Fatal(err)
	}
	if added, err := AddFolder(file, dir, "api"); err != nil || added {
		t.Fatalf("thêm thư mục đã gắn = %v, %v", added, err)
	}
	other := repo(t, "https://gitlab.com/acme/web.git")
	if added, err := AddFolder(file, other, ""); err != nil || !added {
		t.Fatalf("thêm repo mới = %v, %v", added, err)
	}
	if added, _ := AddFolder(file, other+string(filepath.Separator), "web"); added {
		t.Fatal("thêm trùng thư mục")
	}
	list, _ := Load(file)
	if len(list) != 2 || list[1].ProjectID != "" || list[1].Name != filepath.Base(other) {
		t.Fatalf("danh sách = %+v", list)
	}
}
