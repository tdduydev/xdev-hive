package memstore

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

func fakeHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, "no-gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, name := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"} {
		t.Setenv(name, "")
		if err := os.Unsetenv(name); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func writeFixture(t testing.TB, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func gitFixture(t *testing.T, folder string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "core.autocrlf=false"}, args...)...)
	cmd.Dir = folder
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func fileAt(t *testing.T, inventory Inventory, profile, path string) File {
	t.Helper()
	for _, file := range inventory.Files {
		if file.Profile == profile && file.Path == path {
			return file
		}
	}
	t.Fatalf("missing %s: %s", profile, path)
	return File{}
}

func flagCodes(file File) []string {
	codes := []string{}
	for _, flag := range file.Flags {
		codes = append(codes, flag.Code)
	}
	return codes
}

func TestScanThreeProfilesFlagCountsAndReadOnly(t *testing.T) {
	home := fakeHome(t)
	repo := filepath.Join(home, "repo")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	key := ProjectKey(repo)
	roots := []Root{}
	before := make(map[string]string)
	for i := 1; i <= 3; i++ {
		root := Root{CLI: "claude", Profile: fmt.Sprintf("claude-%d", i), Path: filepath.Join(home, "accounts", fmt.Sprintf("claude-%d", i))}
		roots = append(roots, root)
		dir := filepath.Join(root.Path, "projects", key, "memory")
		index := "[common](common.md)"
		if i == 1 {
			index += "\n" + strings.Repeat("x", 6001)
		}
		if i == 3 {
			index += "\n[missing](missing.md)"
		}
		writeFixture(t, filepath.Join(dir, "MEMORY.md"), index)
		writeFixture(t, filepath.Join(dir, "common.md"), fmt.Sprintf("short note %d", i))
		before[filepath.Join(dir, "MEMORY.md")] = index
		before[filepath.Join(dir, "common.md")] = fmt.Sprintf("short note %d", i)
		if i == 1 {
			old := time.Now().Add(-31 * 24 * time.Hour)
			if err := os.Chtimes(filepath.Join(dir, "common.md"), old, old); err != nil {
				t.Fatal(err)
			}
		}
		if i == 2 {
			writeFixture(t, filepath.Join(dir, "orphan.md"), "isolated note")
			before[filepath.Join(dir, "orphan.md")] = "isolated note"
		}
	}
	got := Scan(roots, []projects.Project{{Name: "Repo", Folder: repo}})
	if len(got.Warnings) != 0 || len(got.Files) != 7 || len(got.Sessions) != 3 {
		t.Fatalf("inventory = %+v", got)
	}
	counts := make(map[string]int)
	for _, file := range got.Files {
		if file.ProjectKey != key || file.ProjectPath != repo {
			t.Fatalf("project association = %+v", file)
		}
		for _, flag := range file.Flags {
			counts[flag.Code]++
		}
	}
	want := map[string]int{Duplicate: 6, Stale: 1, BrokenLink: 1, Orphan: 1, OverLimit: 1}
	if !reflect.DeepEqual(counts, want) {
		t.Fatalf("flags = %v, want %v", counts, want)
	}
	for _, session := range got.Sessions {
		index := filepath.Join(roots[0].Path, "projects", key, "memory", "MEMORY.md")
		for _, root := range roots {
			if root.Profile == session.Profile {
				index = filepath.Join(root.Path, "projects", key, "memory", "MEMORY.md")
			}
		}
		if session.SessionTokens != EstimateTokens(before[index]) || !reflect.DeepEqual(session.Paths, []string{index}) {
			t.Fatalf("session should only load index: %+v", session)
		}
	}
	for path, content := range before {
		if after, err := os.ReadFile(path); err != nil || string(after) != content {
			t.Fatalf("scan changed %s: %v", path, err)
		}
	}
	encoded, err := json.Marshal(got)
	if err != nil || strings.Contains(string(encoded), strings.Repeat("x", 100)) {
		t.Fatalf("inventory must only contain metadata: %s, %v", encoded, err)
	}
}

func TestScanCLIsInstructionsAndDatabase(t *testing.T) {
	home := fakeHome(t)
	parent := filepath.Join(home, "workspace")
	repo := filepath.Join(parent, "repo")
	claude := Root{CLI: "claude", Profile: "claude-default", Path: filepath.Join(home, ".claude")}
	codex := Root{CLI: "codex", Profile: "codex-default", Path: filepath.Join(home, ".codex")}
	gemini := Root{CLI: "gemini", Profile: "gemini-default", Path: filepath.Join(home, ".gemini")}
	paths := map[string]string{
		filepath.Join(claude.Path, "CLAUDE.md"):        "cccc",
		filepath.Join(parent, "CLAUDE.md"):             "cccccccc",
		filepath.Join(repo, "CLAUDE.md"):               "cccccccccccc",
		filepath.Join(repo, ".claude", "CLAUDE.md"):    "cccccccccccccccc",
		filepath.Join(repo, "AGENTS.md"):               "aaaa",
		filepath.Join(codex.Path, "AGENTS.md"):         "aaaaaaaa",
		filepath.Join(parent, "AGENTS.md"):             "aaaaaaaaaaaa",
		filepath.Join(gemini.Path, "GEMINI.md"):        "gggg",
		filepath.Join(repo, "GEMINI.md"):               "gggggggg",
		filepath.Join(parent, "GEMINI.md"):             "gggggggggggg",
		filepath.Join(codex.Path, "memories_1.sqlite"): "\x00binary sqlite contents",
	}
	for path, content := range paths {
		writeFixture(t, path, content)
	}
	got := Scan([]Root{gemini, codex, claude}, []projects.Project{{Folder: repo}})
	if len(got.Warnings) != 0 || len(got.Sessions) != 3 {
		t.Fatalf("inventory = %+v", got)
	}
	want := map[string]int{"claude": 10, "codex": 6, "gemini": 6}
	for _, session := range got.Sessions {
		if session.SessionTokens != want[session.CLI] {
			t.Errorf("%s session = %+v, want %d tokens", session.CLI, session, want[session.CLI])
		}
	}
	db := fileAt(t, got, codex.Profile, filepath.Join(codex.Path, "memories_1.sqlite"))
	if db.Kind != "database" || db.Size != int64(len(paths[db.Path])) || db.Tokens != 0 || len(db.Flags) != 0 {
		t.Fatalf("database should only report size: %+v", db)
	}
	fileAt(t, got, claude.Profile, filepath.Join(repo, "AGENTS.md"))
}

func TestScanUnknownProjectAndMissingSources(t *testing.T) {
	home := fakeHome(t)
	root := Root{CLI: "claude", Profile: "claude-1", Path: filepath.Join(home, "claude")}
	dir := filepath.Join(root.Path, "projects", "-old-project", "memory")
	writeFixture(t, filepath.Join(dir, "MEMORY.md"), "no links")
	writeFixture(t, filepath.Join(dir, "forgotten.md"), "a note")
	got := Scan([]Root{root, {CLI: "codex", Profile: "missing", Path: filepath.Join(home, "missing")}}, nil)
	if len(got.Files) != 2 || len(got.Sessions) != 1 || got.Sessions[0].ProjectPath != "" || len(got.Warnings) != 0 {
		t.Fatalf("unknown project = %+v", got)
	}
	if codes := flagCodes(fileAt(t, got, root.Profile, filepath.Join(dir, "forgotten.md"))); !reflect.DeepEqual(codes, []string{Orphan}) {
		t.Fatalf("unknown project flags = %v", codes)
	}
	got = Scan([]Root{{CLI: "claude"}, {CLI: "unknown", Path: home}}, nil)
	if len(got.Warnings) != 2 || got.Files == nil || got.Sessions == nil {
		t.Fatalf("invalid roots = %+v", got)
	}
}

func TestProjectKey(t *testing.T) {
	for folder, want := range map[string]string{
		"/work/my.repo": "-work-my-repo", `/work/my repo`: "-work-my-repo",
		`C:\Users\dev\repo`: "C--Users-dev-repo",
	} {
		if got := ProjectKey(folder); got != want {
			t.Errorf("ProjectKey(%q) = %q, want %q", folder, got, want)
		}
	}
}

// Giới hạn "100 file dưới 1 giây" đo bằng ms tuyệt đối thì vỡ trên runner dùng chung và dưới -race (đã thấy ~780 ms), còn
// so tỉ lệ thời gian giữa hai cỡ cũng nhiễu khi máy tải. Cái cần giữ là Scan không đắt thêm theo từng file (vd chạy một
// git cho mỗi file), nên đếm số lần gọi git thay cho đo giờ; ngân sách thời gian của git được nới để máy chậm không
// làm git bị cắt giữa chừng.
func TestScan100FilesGitCallsBounded(t *testing.T) {
	home := fakeHome(t)
	repo := filepath.Join(home, "repo")
	writeFixture(t, filepath.Join(repo, "src", "current.go"), "package current\nfunc liveSymbol() {}\n")
	gitFixture(t, repo, "init", "-q")
	gitFixture(t, repo, "add", ".")
	root := Root{CLI: "claude", Profile: "claude-1", Path: filepath.Join(home, "claude")}
	dir := filepath.Join(root.Path, "projects", ProjectKey(repo), "memory")
	var index strings.Builder
	for i := range 99 {
		name := fmt.Sprintf("note-%03d.md", i)
		fmt.Fprintf(&index, "[note %d](%s)\n", i, name)
		writeFixture(t, filepath.Join(dir, name), "Memory for `src/current.go` and `liveSymbol()`. "+strings.Repeat(fmt.Sprintf("context%d ", i), 20))
	}
	writeFixture(t, filepath.Join(dir, "MEMORY.md"), index.String())
	oldTotal, oldCall := gitTotalBudget, gitCallBudget
	t.Cleanup(func() { gitTotalBudget, gitCallBudget = oldTotal, oldCall })
	gitTotalBudget, gitCallBudget = time.Minute, time.Minute
	calls := countGitCalls(t)
	got := Scan([]Root{root}, []projects.Project{{Folder: repo}})
	if len(got.Files) != 100 || len(got.Warnings) != 0 {
		t.Fatalf("inventory = %d files, warnings %v", len(got.Files), got.Warnings)
	}
	for _, file := range got.Files {
		if len(file.Flags) > 0 {
			t.Fatalf("valid reference or index flagged: %+v", file)
		}
	}
	if n := calls(); n > 10 {
		t.Fatalf("100 files made %d git calls; cost must not grow per file", n)
	}
}

// countGitCalls đặt một "git" bọc ở đầu PATH, ghi mỗi lần gọi rồi chạy git thật; trả hàm đọc số lần gọi. Chỉ trên
// Unix (script sh); Windows trả hàm 0 để test vẫn kiểm phần còn lại.
func countGitCalls(t *testing.T) func() int {
	t.Helper()
	if runtime.GOOS == "windows" {
		return func() int { return 0 }
	}
	real, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	log := filepath.Join(dir, "calls")
	script := "#!/bin/sh\necho x >> '" + log + "'\nexec '" + real + "' \"$@\"\n"
	if err := os.WriteFile(filepath.Join(dir, "git"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return func() int {
		b, _ := os.ReadFile(log)
		return strings.Count(string(b), "\n")
	}
}
