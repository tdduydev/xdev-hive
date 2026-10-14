package memstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func readText(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// memoryFixture dựng một thư mục memory có chỉ mục và hai file hay link tới nhau.
func memoryFixture(t *testing.T) (Store, string) {
	t.Helper()
	fakeHome(t)
	dir := filepath.Join(t.TempDir(), "cfg", "projects", "-work-app", "memory")
	writeFixture(t, filepath.Join(dir, "MEMORY.md"),
		"# Memory\n\n- [Deploy](deploy.md) — cách deploy\n- [Deploy cũ](deploy-old.md) — bản cũ\n- [Style](style.md) — quy ước\n")
	writeFixture(t, filepath.Join(dir, "deploy.md"), "deploy bằng pnpm\n")
	writeFixture(t, filepath.Join(dir, "deploy-old.md"), "deploy bằng npm\n")
	writeFixture(t, filepath.Join(dir, "style.md"), "Xem [deploy cũ](deploy-old.md) và [[deploy-old]], hay [web](https://example.com/deploy-old.md).\n")
	return Store{Dir: filepath.Join(t.TempDir(), "optimizer")}, dir
}

func TestEditBacksUpAndRestores(t *testing.T) {
	store, dir := memoryFixture(t)
	path := filepath.Join(dir, "style.md")
	before := readText(t, path)
	res, err := store.Edit(path, "mới\n")
	if err != nil {
		t.Fatal(err)
	}
	if got := readText(t, path); got != "mới\n" {
		t.Fatalf("content = %q", got)
	}
	if res.Entry == "" {
		t.Fatal("edit without backup entry")
	}
	if _, err := store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, path); got != before {
		t.Fatalf("restored = %q, want %q", got, before)
	}
}

func TestEditRejectsUnsafePaths(t *testing.T) {
	store, dir := memoryFixture(t)
	for _, path := range []string{"relative.md", filepath.Join(dir, "notes.txt"), filepath.Join(dir, "missing.md"), dir} {
		if _, err := store.Edit(path, "x"); err == nil {
			t.Errorf("Edit(%q) succeeded", path)
		}
	}
	if _, err := store.Delete(filepath.Join(dir, "MEMORY.md")); err == nil {
		t.Error("Delete(MEMORY.md) succeeded")
	}
	entries, _ := store.Entries()
	if len(entries) != 0 {
		t.Fatalf("failed operations left %d entries", len(entries))
	}
}

func TestDeleteTrashesAndRestoresWithIndexLine(t *testing.T) {
	store, dir := memoryFixture(t)
	path := filepath.Join(dir, "deploy.md")
	res, err := store.Delete(path)
	if err != nil {
		t.Fatal(err)
	}
	if exists(path) {
		t.Fatal("file still there after delete")
	}
	index := readText(t, filepath.Join(dir, "MEMORY.md"))
	if strings.Contains(index, "(deploy.md)") || !strings.Contains(index, "(style.md)") {
		t.Fatalf("index after delete:\n%s", index)
	}
	entries, err := store.Entries()
	if err != nil || len(entries) != 1 || !entries[0].Trash || entries[0].ID != res.Entry {
		t.Fatalf("entries = %+v, %v", entries, err)
	}
	// Người dùng sửa chỉ mục sau khi xoá: khôi phục theo dòng không được đè mất chỗ đó.
	writeFixture(t, filepath.Join(dir, "MEMORY.md"), index+"- [Mới](new.md) — thêm sau\n")
	if _, err := store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, path); got != "deploy bằng pnpm\n" {
		t.Fatalf("restored file = %q", got)
	}
	index = readText(t, filepath.Join(dir, "MEMORY.md"))
	for _, want := range []string{"(deploy.md)", "(new.md)", "(style.md)"} {
		if !strings.Contains(index, want) {
			t.Fatalf("index lost %s:\n%s", want, index)
		}
	}
}

func TestMergeTwoFilesIntoOne(t *testing.T) {
	store, dir := memoryFixture(t)
	target, old := filepath.Join(dir, "deploy.md"), filepath.Join(dir, "deploy-old.md")
	styleBefore := readText(t, filepath.Join(dir, "style.md"))
	res, err := store.Merge([]string{old, target}, target, "deploy bằng pnpm (gộp)\n")
	if err != nil {
		t.Fatal(err)
	}
	if exists(old) {
		t.Fatal("source still on disk")
	}
	if got := readText(t, target); got != "deploy bằng pnpm (gộp)\n" {
		t.Fatalf("target = %q", got)
	}
	index := readText(t, filepath.Join(dir, "MEMORY.md"))
	if strings.Count(index, "(deploy.md)") != 1 || strings.Contains(index, "deploy-old") {
		t.Fatalf("index after merge:\n%s", index)
	}
	style := readText(t, filepath.Join(dir, "style.md"))
	if !strings.Contains(style, "[deploy cũ](deploy.md)") || !strings.Contains(style, "[[deploy]]") ||
		!strings.Contains(style, "https://example.com/deploy-old.md") {
		t.Fatalf("links after merge: %s", style)
	}
	// Không còn link chết nào trong thư mục.
	inv := Scan([]Root{{CLI: "claude", Profile: "p", Path: filepath.Dir(filepath.Dir(filepath.Dir(dir)))}}, nil)
	for _, f := range inv.Files {
		for _, flag := range f.Flags {
			if flag.Code == BrokenLink {
				t.Errorf("broken link in %s: %+v", f.Path, flag)
			}
		}
	}

	if _, err := store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, old); got != "deploy bằng npm\n" {
		t.Fatalf("restored source = %q", got)
	}
	if got := readText(t, target); got != "deploy bằng pnpm\n" {
		t.Fatalf("restored target = %q", got)
	}
	if got := readText(t, filepath.Join(dir, "style.md")); got != styleBefore {
		t.Fatalf("restored style = %q", got)
	}
	index = readText(t, filepath.Join(dir, "MEMORY.md"))
	if !strings.Contains(index, "(deploy-old.md)") || strings.Count(index, "(deploy.md)") != 1 {
		t.Fatalf("restored index:\n%s", index)
	}
}

func TestMergeIntoNewFileIndexesIt(t *testing.T) {
	store, dir := memoryFixture(t)
	target := filepath.Join(dir, "deploy-all.md")
	res, err := store.Merge([]string{filepath.Join(dir, "deploy.md"), filepath.Join(dir, "deploy-old.md")}, target, "tất cả\n")
	if err != nil {
		t.Fatal(err)
	}
	index := readText(t, filepath.Join(dir, "MEMORY.md"))
	if strings.Count(index, "(deploy-all.md)") != 1 || strings.Contains(index, "(deploy.md)") || strings.Contains(index, "deploy-old") {
		t.Fatalf("index:\n%s", index)
	}
	if !strings.Contains(readText(t, filepath.Join(dir, "style.md")), "[deploy cũ](deploy-all.md)") {
		t.Fatal("links to the sources not retargeted")
	}
	// Khôi phục xoá cả file đích mới tạo.
	if _, err := store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	if exists(target) || !exists(filepath.Join(dir, "deploy.md")) {
		t.Fatal("restore did not undo the merge")
	}
	if strings.Contains(readText(t, filepath.Join(dir, "MEMORY.md")), "deploy-all") {
		t.Fatal("restore left the merged index line")
	}
}

func TestEntriesPurgedAfterRetention(t *testing.T) {
	store, dir := memoryFixture(t)
	now := time.Now()
	store.Now = func() time.Time { return now.Add(-TrashRetention - time.Hour) }
	res, err := store.Delete(filepath.Join(dir, "style.md"))
	if err != nil {
		t.Fatal(err)
	}
	store.Now = func() time.Time { return now }
	if entries, _ := store.Entries(); len(entries) != 0 {
		t.Fatalf("entries after retention = %+v", entries)
	}
	if _, err := store.Restore(res.Entry); err == nil {
		t.Fatal("restore of purged entry succeeded")
	}
}

func TestRestoreRejectsPathTraversal(t *testing.T) {
	store, _ := memoryFixture(t)
	for _, id := range []string{"", "..", "../x", `a\b`} {
		if _, err := store.Restore(id); err == nil {
			t.Errorf("Restore(%q) succeeded", id)
		}
	}
}

func TestEditWritesThroughSymlink(t *testing.T) {
	store, dir := memoryFixture(t)
	link := filepath.Join(dir, "link.md")
	if err := os.Symlink(filepath.Join(dir, "style.md"), link); err != nil {
		t.Skip("không tạo được symlink:", err)
	}
	if _, err := store.Edit(link, "qua link\n"); err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Lstat(link); st.Mode()&os.ModeSymlink == 0 {
		t.Fatal("edit replaced the symlink with a file")
	}
	if got := readText(t, filepath.Join(dir, "style.md")); got != "qua link\n" {
		t.Fatalf("target = %q", got)
	}
}
