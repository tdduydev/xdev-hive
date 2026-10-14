package memstore

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

func TestDuplicateNamesAndJaccardThreshold(t *testing.T) {
	now := time.Now()
	files := []scannedFile{
		{File: File{CLI: "claude", Profile: "one", ProjectKey: "repo", Path: filepath.Join("one", "a.md"), Name: "a.md", ModifiedAt: now}, content: "one two three four five six seven eight"},
		{File: File{CLI: "claude", Profile: "two", ProjectKey: "repo", Path: filepath.Join("two", "b.md"), Name: "b.md", ModifiedAt: now}, content: "ONE two three four five six seven nine"},
		{File: File{CLI: "claude", Profile: "three", ProjectKey: "repo", Path: filepath.Join("three", "a.md"), Name: "a.md", ModifiedAt: now}, content: "different note"},
		{File: File{CLI: "claude", Profile: "four", ProjectKey: "other-repo", Path: filepath.Join("four", "a.md"), Name: "a.md", ModifiedAt: now}, content: "different note"},
		{File: File{CLI: "claude", Profile: "one", ProjectKey: "repo", Path: filepath.Join("one", "c.md"), Name: "c.md", ModifiedAt: now}, content: "one two three four five six seven eight"},
	}
	if score := jaccard(wordShingles(files[0].content), wordShingles(files[1].content)); score != 0.6 {
		t.Fatalf("score = %f, want 0.6", score)
	}
	applyFlags(files, now)
	for i, want := range [][]string{{Duplicate}, {Duplicate}, {Duplicate}, {}, {Duplicate}} {
		if got := flagCodes(files[i].File); !reflect.DeepEqual(got, want) {
			t.Errorf("file %d: flags %v, want %v", i, got, want)
		}
	}
	if contains(files[0].Flags[0].Related, files[4].Path) {
		t.Fatal("same profile must not count as cross-profile duplicate")
	}
	if jaccard(wordShingles("short note"), wordShingles("short note")) != 0 {
		t.Fatal("short notes have no five-word shingles")
	}
}

func TestMarkdownLinksAndOrphans(t *testing.T) {
	home := fakeHome(t)
	root := Root{CLI: "claude", Profile: "one", Path: filepath.Join(home, "claude")}
	dir := filepath.Join(root.Path, "projects", "repo", "memory")
	index := "[plain](plain.md#section) [[wiki|label]] [space](<a file.md>) [encoded](encoded%20file.md)\n[reference]: ref.md\n`inline.md`\n"
	index += "[gone](gone.md) [[lost]] [web](https://example.com) [mail](mailto:a@example.com) [anchor](#here) [network](//example.com)"
	writeFixture(t, filepath.Join(dir, "MEMORY.md"), index)
	for _, name := range []string{"plain.md", "wiki.md", "a file.md", "encoded file.md", "ref.md", "inline.md", "unlisted.md"} {
		writeFixture(t, filepath.Join(dir, name), "a note")
	}
	got := Scan([]Root{root}, nil)
	indexFile := fileAt(t, got, "one", filepath.Join(dir, "MEMORY.md"))
	if !reflect.DeepEqual(flagCodes(indexFile), []string{BrokenLink}) || len(indexFile.Flags[0].Related) != 2 {
		t.Fatalf("broken links = %+v", indexFile.Flags)
	}
	for _, file := range got.Files {
		if file.Name == "MEMORY.md" {
			continue
		}
		want := []string{}
		if file.Name == "unlisted.md" {
			want = []string{Orphan}
		}
		if !reflect.DeepEqual(flagCodes(file), want) {
			t.Errorf("%s: flags = %+v", file.Name, file.Flags)
		}
	}
}

func TestStaleReferencesAndThresholds(t *testing.T) {
	home := fakeHome(t)
	repo := filepath.Join(home, "repo")
	writeFixture(t, filepath.Join(repo, "src", "current.go"), "package current\nfunc stillPresent() {}\n")
	gitFixture(t, repo, "init", "-q")
	gitFixture(t, repo, "add", ".")
	writeFixture(t, filepath.Join(repo, "src", "untracked.go"), "package newfile")
	root := Root{CLI: "claude", Profile: "one", Path: filepath.Join(home, "claude")}
	dir := filepath.Join(root.Path, "projects", ProjectKey(repo), "memory")
	writeFixture(t, filepath.Join(dir, "MEMORY.md"), "[note](note.md)\n`note.md`")
	writeFixture(t, filepath.Join(dir, "note.md"), "Use `src/current.go`, `src/untracked.go`, `src/gone.go`, `stillPresent()`, `removedFunction()`. `balanced`, `https://example.com`.")
	writeFixture(t, filepath.Join(repo, "CLAUDE.md"), strings.Repeat("x", 8001))
	got := Scan([]Root{root}, []projects.Project{{Folder: repo}})
	note := fileAt(t, got, "one", filepath.Join(dir, "note.md"))
	if !reflect.DeepEqual(flagCodes(note), []string{Stale}) || !reflect.DeepEqual(note.Flags[0].Related, []string{"removedFunction", "src/gone.go"}) {
		t.Fatalf("stale refs = %+v", note.Flags)
	}
	if flags := fileAt(t, got, "one", filepath.Join(dir, "MEMORY.md")).Flags; len(flags) != 0 {
		t.Fatalf("memory links are not stale repo paths: %+v", flags)
	}
	if codes := flagCodes(fileAt(t, got, "one", filepath.Join(repo, "CLAUDE.md"))); !reflect.DeepEqual(codes, []string{OverLimit}) {
		t.Fatalf("instruction flags = %v", codes)
	}
	now := time.Now()
	files := []scannedFile{
		{File: File{Name: "MEMORY.md", Tokens: 1500, ModifiedAt: now.Add(-30 * 24 * time.Hour)}},
		{File: File{Name: "CLAUDE.md", Tokens: 2000, ModifiedAt: now.Add(-30*24*time.Hour - time.Second)}},
	}
	applyFlags(files, now)
	if len(files[0].Flags) != 0 || !reflect.DeepEqual(flagCodes(files[1].File), []string{Stale}) {
		t.Fatalf("threshold flags = %+v, %+v", files[0].Flags, files[1].Flags)
	}
}

func TestRepoGrepBudgetCacheAndFailure(t *testing.T) {
	folder := fakeHome(t)
	calls := 0
	p := &repoProbe{folder: folder, valid: true, cache: make(map[string]bool), run: func(args ...string) ([]byte, error) {
		calls++
		if !reflect.DeepEqual(args[:5], []string{"grep", "-q", "-F", "-w", "-e"}) {
			t.Fatalf("unsafe grep args: %v", args)
		}
		return nil, errors.New("git unavailable")
	}}
	for range 3 {
		if p.missing(reference{value: "sameSymbol"}) {
			t.Fatal("git failure must not mark stale")
		}
	}
	for i := range 100 {
		p.missing(reference{value: fmt.Sprintf("symbol%d", i)})
	}
	if calls != MaxGitGreps {
		t.Fatalf("grep calls = %d, want %d", calls, MaxGitGreps)
	}
	p.greps = 0
	p.deadline = time.Now().Add(-time.Second)
	p.missing(reference{value: "anotherSymbol"})
	if calls != MaxGitGreps {
		t.Fatal("elapsed time budget must also stop grep")
	}
	p.valid = false
	if p.missing(reference{value: "src/gone.go", path: true}) {
		t.Fatal("non-git folders must not mark repo references stale")
	}
}

func TestMemoryDirectorySymlinkAndDanglingFile(t *testing.T) {
	home := fakeHome(t)
	root := Root{CLI: "claude", Profile: "one", Path: filepath.Join(home, "claude")}
	shared := filepath.Join(home, "shared")
	writeFixture(t, filepath.Join(shared, "MEMORY.md"), "[note](note.md) [gone](gone.md)")
	writeFixture(t, filepath.Join(shared, "note.md"), "a note")
	dir := filepath.Join(root.Path, "projects", "repo")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, filepath.Join(dir, "memory")); err != nil {
		if runtime.GOOS == "windows" {
			t.Skipf("symlink permission unavailable: %v", err)
		}
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(home, "missing.md"), filepath.Join(shared, "gone.md")); err != nil {
		t.Fatal(err)
	}
	got := Scan([]Root{root}, nil)
	if len(got.Files) != 3 || len(got.Warnings) != 0 {
		t.Fatalf("symlink inventory = %+v", got)
	}
	missing := fileAt(t, got, "one", filepath.Join(dir, "memory", "gone.md"))
	if !contains(flagCodes(missing), BrokenLink) || missing.Tokens != 0 {
		t.Fatalf("dangling file = %+v", missing)
	}
	other := Root{CLI: "claude", Profile: "two", Path: filepath.Join(home, "claude-two")}
	otherDir := filepath.Join(other.Path, "projects", "repo")
	if err := os.MkdirAll(otherDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(shared, filepath.Join(otherDir, "memory")); err != nil {
		t.Fatal(err)
	}
	got = Scan([]Root{root, other}, nil)
	for _, file := range got.Files {
		if file.Name != "gone.md" && contains(flagCodes(file), Duplicate) {
			t.Fatalf("shared file should not need merging: %+v", file)
		}
	}
}
