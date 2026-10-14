package memstore

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

type shareFixture struct {
	store   Store
	roots   []Root
	project string
	shared  string
	key     string
}

func newShareFixture(t *testing.T) shareFixture {
	t.Helper()
	fakeHome(t)
	base := t.TempDir()
	project := filepath.Join(base, "app")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatal(err)
	}
	key := ProjectKey(project)
	fx := shareFixture{store: Store{Dir: filepath.Join(base, "optimizer")}, project: project, key: key,
		shared: filepath.Join(base, "memory", "claude")}
	for _, id := range []string{"claude-3", "claude-6"} {
		fx.roots = append(fx.roots, Root{CLI: "claude", Profile: id, Path: filepath.Join(base, "accounts", id)})
	}
	mem := func(i int, name string) string {
		return filepath.Join(fx.roots[i].Path, "projects", key, "memory", name)
	}
	writeFixture(t, mem(0, "MEMORY.md"), "# Memory\n- [Deploy](deploy.md) — deploy\n- [Only3](only3.md) — chỉ gói 3\n")
	writeFixture(t, mem(0, "deploy.md"), "bản gói 3\n")
	writeFixture(t, mem(0, "only3.md"), "một\n")
	writeFixture(t, mem(0, "same.md"), "giống nhau\n")
	writeFixture(t, mem(1, "MEMORY.md"), "- [Deploy](deploy.md) — deploy khác mô tả\n- [Only6](only6.md) — chỉ gói 6\n")
	writeFixture(t, mem(1, "deploy.md"), "bản gói 6\n")
	writeFixture(t, mem(1, "only6.md"), "sáu\n")
	writeFixture(t, mem(1, "same.md"), "giống nhau\n")
	return fx
}

func (fx shareFixture) opts(picks map[string]string) ShareOptions {
	return ShareOptions{Key: fx.key, ProjectPath: fx.project, Roots: fx.roots, SharedRoot: fx.shared,
		ClaudeVersion: "2.1.299", Picks: picks}
}

func (fx shareFixture) memDir(i int) string {
	return filepath.Join(fx.roots[i].Path, "projects", fx.key, "memory")
}

func TestShareNeedsPickForConflictingFile(t *testing.T) {
	fx := newShareFixture(t)
	res, err := fx.store.Share(fx.opts(nil))
	if err != nil {
		t.Fatal(err)
	}
	if res.Applied || len(res.Conflicts) != 1 || res.Conflicts[0].Name != "deploy.md" || len(res.Conflicts[0].Candidates) != 2 {
		t.Fatalf("result = %+v", res)
	}
	// Chưa chọn thì không đụng gì.
	if !exists(filepath.Join(fx.memDir(0), "deploy.md")) || exists(SharedMemoryDir(fx.shared, fx.key)) ||
		exists(filepath.Join(fx.project, ".claude", localSettingsName)) {
		t.Fatal("share without picks changed the disk")
	}
}

func TestShareThenUnshareGivesEachProfileACopy(t *testing.T) {
	fx := newShareFixture(t)
	res, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-6"}))
	if err != nil || !res.Applied {
		t.Fatalf("share: %+v, %v", res, err)
	}
	shared := SharedMemoryDir(fx.shared, fx.key)
	if got := readText(t, filepath.Join(shared, "deploy.md")); got != "bản gói 6\n" {
		t.Fatalf("deploy.md = %q", got)
	}
	for _, name := range []string{"only3.md", "only6.md", "same.md"} {
		if !exists(filepath.Join(shared, name)) {
			t.Fatalf("shared dir lacks %s", name)
		}
	}
	index := readText(t, filepath.Join(shared, "MEMORY.md"))
	if strings.Count(index, "(deploy.md)") != 1 || !strings.Contains(index, "(only3.md)") || !strings.Contains(index, "(only6.md)") {
		t.Fatalf("merged index:\n%s", index)
	}
	for i := range fx.roots {
		if exists(fx.memDir(i)) {
			t.Fatalf("profile %d still has its own memory dir", i)
		}
	}
	// CLI được trỏ tới thư mục chung bằng cài đặt của dự án.
	settings := filepath.Join(fx.project, ".claude", localSettingsName)
	var parsed map[string]string
	if err := json.Unmarshal([]byte(readText(t, settings)), &parsed); err != nil || parsed[autoMemorySetting] != shared {
		t.Fatalf("settings = %s (%v)", readText(t, settings), err)
	}
	records, _ := fx.store.Shared()
	if len(records) != 1 || records[0].Key != fx.key || len(records[0].Profiles) != 2 {
		t.Fatalf("records = %+v", records)
	}
	// Màn Memory quét được thư mục chung như một gói.
	inv := Scan([]Root{{CLI: "claude", Profile: "shared", Path: fx.shared}}, nil)
	var seen int
	for _, f := range inv.Files {
		if f.Kind == "memory" && f.Profile == "shared" {
			seen++
		}
	}
	if seen != 5 {
		t.Fatalf("scan of shared root found %d memory files, want 5", seen)
	}
	if _, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-6"})); err == nil {
		t.Fatal("second share of the same project succeeded")
	}

	out, err := fx.store.Unshare(fx.key)
	if err != nil || !out.Applied {
		t.Fatalf("unshare: %+v, %v", out, err)
	}
	for i := range fx.roots {
		for _, name := range []string{"MEMORY.md", "deploy.md", "only3.md", "only6.md", "same.md"} {
			if !exists(filepath.Join(fx.memDir(i), name)) {
				t.Fatalf("profile %d lacks %s after unshare", i, name)
			}
		}
		if got := readText(t, filepath.Join(fx.memDir(i), "deploy.md")); got != "bản gói 6\n" {
			t.Fatalf("profile %d deploy.md = %q", i, got)
		}
	}
	if exists(shared) || exists(settings) {
		t.Fatal("unshare left the shared dir or the settings file")
	}
	if records, _ := fx.store.Shared(); len(records) != 0 {
		t.Fatalf("records after unshare = %+v", records)
	}
}

func TestSharePreservesProjectSettingsByteForByte(t *testing.T) {
	fx := newShareFixture(t)
	settings := filepath.Join(fx.project, ".claude", localSettingsName)
	original := "{\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(ls)\"\n    ]\n  },\n  \"model\": \"opus\"\n}\n"
	writeFixture(t, settings, original)
	if _, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-3"})); err != nil {
		t.Fatal(err)
	}
	got := readText(t, settings)
	if strings.Index(got, "permissions") > strings.Index(got, "model") || strings.Index(got, "model") > strings.Index(got, autoMemorySetting) {
		t.Fatalf("key order lost:\n%s", got)
	}
	if _, err := fx.store.Unshare(fx.key); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, settings); got != original {
		t.Fatalf("settings after unshare:\n%s\nwant:\n%s", got, original)
	}
}

func TestShareKeepsUserMemoryDirectory(t *testing.T) {
	fx := newShareFixture(t)
	settings := filepath.Join(fx.project, ".claude", localSettingsName)
	writeFixture(t, settings, `{"autoMemoryDirectory": "~/mine"}`)
	if _, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-3"})); err == nil {
		t.Fatal("share overrode the user's autoMemoryDirectory")
	}
	if !exists(filepath.Join(fx.memDir(0), "deploy.md")) {
		t.Fatal("failed share touched the profile memory")
	}
	// File hỏng cũng không bị đè.
	writeFixture(t, settings, `{"autoMemoryDirectory": `)
	if _, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-3"})); err == nil {
		t.Fatal("share accepted a corrupt settings file")
	}
	if got := readText(t, settings); got != `{"autoMemoryDirectory": ` {
		t.Fatalf("corrupt settings rewritten: %q", got)
	}
}

func TestShareRequiresSupportedClaude(t *testing.T) {
	fx := newShareFixture(t)
	for _, version := range []string{"", "2.1.200", "1.9.0"} {
		opts := fx.opts(map[string]string{"deploy.md": "claude-3"})
		opts.ClaudeVersion = version
		if _, err := fx.store.Share(opts); err == nil {
			t.Errorf("share accepted claude %q", version)
		}
	}
	if !versionAtLeast("2.1.300", "2.1.299") || !versionAtLeast("2.2", "2.1.299") || versionAtLeast("2.1", "2.1.299") {
		t.Fatal("versionAtLeast compares wrongly")
	}
}

func TestShareExcludesSettingsFromGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
	fx := newShareFixture(t)
	gitFixture(t, fx.project, "init", "-q")
	exclude := filepath.Join(fx.project, ".git", "info", "exclude")
	if _, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-3"})); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(readText(t, exclude), "/.claude/settings.local.json") {
		t.Fatalf("exclude = %q", readText(t, exclude))
	}
	if _, err := fx.store.Unshare(fx.key); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(readText(t, exclude), "settings.local.json") {
		t.Fatalf("exclude after unshare = %q", readText(t, exclude))
	}
}

func TestShareRejectsBadInput(t *testing.T) {
	fx := newShareFixture(t)
	bad := fx.opts(map[string]string{"deploy.md": "claude-3"})
	bad.Key = "../x"
	if _, err := fx.store.Share(bad); err == nil {
		t.Error("share accepted a key with a path separator")
	}
	bad = fx.opts(nil)
	bad.ProjectPath = filepath.Join(fx.project, "missing")
	if _, err := fx.store.Share(bad); err == nil {
		t.Error("share accepted a missing project folder")
	}
	bad = fx.opts(nil)
	bad.Roots = []Root{{CLI: "claude", Profile: "empty", Path: filepath.Join(t.TempDir(), "none")}}
	if _, err := fx.store.Share(bad); err == nil {
		t.Error("share with no memory anywhere succeeded")
	}
}

func TestShareBackupRestoresProfileMemory(t *testing.T) {
	fx := newShareFixture(t)
	res, err := fx.store.Share(fx.opts(map[string]string{"deploy.md": "claude-6"}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fx.store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	if got := readText(t, filepath.Join(fx.memDir(0), "deploy.md")); got != "bản gói 3\n" {
		t.Fatalf("restored deploy.md = %q", got)
	}
}
