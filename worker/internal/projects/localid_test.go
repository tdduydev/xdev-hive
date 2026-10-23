package projects

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var localIDForm = regexp.MustCompile(`^[0-9a-f]{16}$`)

// FR-010: bí mật gán theo LocalID, nên id phải giữ qua Load, qua gắn lại sang thư mục khác và qua gắn repo chưa gắn.
func TestLocalIDStable(t *testing.T) {
	file := filepath.Join(t.TempDir(), "projects.json")
	dir := repo(t, "https://github.com/acme/app.git")
	if added, err := AddFolder(file, dir, ""); err != nil || !added {
		t.Fatalf("AddFolder: %v, %v", added, err)
	}
	list, _ := Load(file)
	if len(list) != 1 || !localIDForm.MatchString(list[0].LocalID) {
		t.Fatalf("AddFolder không sinh LocalID: %+v", list)
	}
	id := list[0].LocalID
	if again, _ := Load(file); again[0].LocalID != id {
		t.Fatal("LocalID đổi giữa hai lần Load")
	}
	// Gắn dự án cho repo chưa gắn: giữ id của repo.
	if err := Bind(file, idA, dir, "", ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if p := Find(list, idA); len(list) != 1 || p == nil || p.LocalID != id {
		t.Fatalf("gắn dự án đổi LocalID: %+v", list)
	}
	// Dời repo sang thư mục khác rồi gắn lại: vẫn id cũ.
	moved := repo(t, "https://github.com/acme/app.git")
	if err := Bind(file, idA, moved, "", ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if p := Find(list, idA); p == nil || p.LocalID != id || !samePath(p.Folder, moved) {
		t.Fatalf("đổi thư mục đổi LocalID: %+v", list)
	}
	if FindLocal(list, id) != Find(list, idA) || FindLocal(list, "") != nil || FindLocal(list, "ffffffffffffffff") != nil {
		t.Fatal("FindLocal sai")
	}
	// Dự án khác có id riêng.
	other := repo(t, "https://github.com/acme/other.git")
	if err := Bind(file, idB, other, "", ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if b := Find(list, idB); b == nil || b.LocalID == id || !localIDForm.MatchString(b.LocalID) {
		t.Fatalf("dự án mới: %+v", list)
	}
	got, err := Unbind(file, idA)
	if err != nil || got != id {
		t.Fatalf("Unbind trả %q, %v; muốn id đã gỡ", got, err)
	}
	if _, err := AddFolder(file, dir, ""); err != nil {
		t.Fatal(err)
	}
	list, _ = Load(file)
	if p := FindFolder(list, dir); p == nil || p.LocalID == id {
		t.Fatalf("thêm lại thư mục đã gỡ phải có id mới, không nhận lại bí mật cũ: %+v", list)
	}
	if got, err := UnbindFolder(file, dir); err != nil || got == "" || got == id {
		t.Fatalf("UnbindFolder trả %q, %v", got, err)
	}
}

// File do bản cũ ghi: Load sinh id cho dòng thiếu, cho dòng trùng, rồi ghi lại để lần đọc sau ra cùng id.
func TestLoadFillsMissingLocalID(t *testing.T) {
	file := filepath.Join(t.TempDir(), "projects.json")
	old := `{"projects":[{"projectId":"` + idA + `","name":"a","folder":"/a"},` +
		`{"localId":"0123456789abcdef","name":"b","folder":"/b"},` +
		`{"localId":"0123456789abcdef","name":"c","folder":"/c"}]}`
	if err := os.WriteFile(file, []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	list, err := Load(file)
	if err != nil || len(list) != 3 {
		t.Fatalf("Load: %+v, %v", list, err)
	}
	if !localIDForm.MatchString(list[0].LocalID) || list[1].LocalID != "0123456789abcdef" ||
		!localIDForm.MatchString(list[2].LocalID) || list[2].LocalID == list[1].LocalID {
		t.Fatalf("id sau Load: %+v", list)
	}
	again, _ := Load(file)
	for i := range list {
		if again[i].LocalID != list[i].LocalID {
			t.Fatalf("lần Load sau ra id khác: %+v / %+v", list, again)
		}
	}
	if b, _ := os.ReadFile(file); strings.Count(string(b), `"localId"`) != 3 {
		t.Fatal("chưa ghi id vào file")
	}
}

func TestFindFolderPicksDeepest(t *testing.T) {
	root := t.TempDir()
	outer := filepath.Join(root, "mono")
	inner := filepath.Join(outer, "services", "api")
	list := []Project{
		{LocalID: "1", Folder: outer},
		{LocalID: "2", Folder: inner},
		{LocalID: "3", Folder: filepath.Join(root, "mono-v2")},
	}
	for _, tc := range []struct{ dir, want string }{
		{outer, "1"},
		{filepath.Join(outer, "web", "src"), "1"},
		{inner, "2"},
		{filepath.Join(inner, "cmd"), "2"},
		{filepath.Join(root, "mono-v2", "x"), "3"},
		{root, ""},
		{filepath.Join(root, "monolith"), ""},
		{"", ""},
	} {
		got := ""
		if p := FindFolder(list, tc.dir); p != nil {
			got = p.LocalID
		}
		if got != tc.want {
			t.Errorf("FindFolder(%q) = %q, muốn %q", tc.dir, got, tc.want)
		}
	}
}
