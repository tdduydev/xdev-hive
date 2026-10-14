package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

type memoryEnv struct {
	home, config, project, key string
}

// fakeMemoryEnv đặt HOME giả có hai gói Claude (accounts.json) và một dự án local; không đụng gói thật của máy.
func fakeMemoryEnv(t *testing.T) memoryEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	oldHome, oldVersion, oldStdin := memoryHome, memoryClaudeVersion, memoryStdin
	memoryHome = func() (string, error) { return home, nil }
	memoryClaudeVersion = func(context.Context) string { return "2.1.299" }
	t.Cleanup(func() { memoryHome, memoryClaudeVersion, memoryStdin = oldHome, oldVersion, oldStdin })

	env := memoryEnv{home: home, config: filepath.Join(home, ".xdev-hive", "worker.json"), project: filepath.Join(home, "work", "app")}
	if err := os.MkdirAll(env.project, 0o755); err != nil {
		t.Fatal(err)
	}
	env.key = memstore.ProjectKey(env.project)
	writeTestFile(t, filepath.Join(home, ".xdev-hive", "accounts.json"),
		`{"accounts":[{"id":"claude-1","label":"a","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-1","enabled":true},`+
			`{"id":"claude-2","label":"b","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2","enabled":true}]}`)
	writeTestFile(t, filepath.Join(home, ".xdev-hive", "projects.json"),
		`{"projects":[{"projectId":"","name":"app","folder":`+string(mustJSON(env.project))+`,"fullPermission":false}]}`)
	for id, body := range map[string]string{"claude-1": "bản 1\n", "claude-2": "bản 2\n"} {
		dir := env.memDir(id)
		writeTestFile(t, filepath.Join(dir, "MEMORY.md"), "- [Chung](shared.md) — chung\n- ["+id+"](only-"+id+".md)\n")
		writeTestFile(t, filepath.Join(dir, "shared.md"), body)
		writeTestFile(t, filepath.Join(dir, "only-"+id+".md"), "riêng "+id+"\n")
	}
	return env
}

func (e memoryEnv) memDir(profile string) string {
	return filepath.Join(e.home, ".xdev-hive", "accounts", profile, "projects", e.key, "memory")
}

func writeTestFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func runMemory(t *testing.T, env memoryEnv, stdin string, args ...string) (int, string, string) {
	t.Helper()
	memoryStdin = strings.NewReader(stdin)
	var out, errOut bytes.Buffer
	code := memoryCommand(append(args, "--config", env.config, "--json"), &out, &errOut)
	return code, out.String(), errOut.String()
}

func scanView(t *testing.T, env memoryEnv) memoryView {
	t.Helper()
	code, out, errOut := runMemory(t, env, "", "scan")
	if code != 0 {
		t.Fatalf("scan: %d %s", code, errOut)
	}
	var v memoryView
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("scan JSON: %v\n%s", err, out)
	}
	return v
}

func TestMemoryScanGroupsProfilesAndLeavesDiskAlone(t *testing.T) {
	env := fakeMemoryEnv(t)
	v := scanView(t, env)
	var memory, sessions int
	for _, f := range v.Files {
		if f.Kind == "memory" {
			memory++
		}
	}
	for _, s := range v.Sessions {
		if s.ProjectKey == env.key {
			sessions++
		}
	}
	if memory != 6 || sessions != 2 || v.Files == nil || v.Shared == nil || v.Entries == nil {
		t.Fatalf("memory = %d, sessions = %d, view = %+v", memory, sessions, v)
	}
}

func TestMemoryEditDeleteRestore(t *testing.T) {
	env := fakeMemoryEnv(t)
	file := filepath.Join(env.memDir("claude-1"), "only-claude-1.md")

	code, out, errOut := runMemory(t, env, "nội dung mới\n", "edit", "--path", file, "--stdin")
	if code != 0 {
		t.Fatalf("edit: %d %s", code, errOut)
	}
	var res memoryOutput
	if err := json.Unmarshal([]byte(out), &res); err != nil || res.Entry == "" {
		t.Fatalf("edit JSON: %v %s", err, out)
	}
	if got, _ := os.ReadFile(file); string(got) != "nội dung mới\n" {
		t.Fatalf("file = %q", got)
	}

	if code, _, errOut := runMemory(t, env, "", "delete", "--path", file); code != 0 {
		t.Fatalf("delete: %d %s", code, errOut)
	}
	if _, err := os.Stat(file); err == nil {
		t.Fatal("file still there after delete")
	}
	v := scanView(t, env)
	var trash string
	for _, e := range v.Entries {
		if e.Trash && e.Op == "delete" {
			trash = e.ID
		}
	}
	if trash == "" {
		t.Fatalf("scan lists no trash entry: %+v", v.Entries)
	}
	if code, _, errOut := runMemory(t, env, "", "restore", "--id", trash); code != 0 {
		t.Fatalf("restore: %d %s", code, errOut)
	}
	if got, _ := os.ReadFile(file); string(got) != "nội dung mới\n" {
		t.Fatalf("restored file = %q", got)
	}
	index, _ := os.ReadFile(filepath.Join(env.memDir("claude-1"), "MEMORY.md"))
	if !strings.Contains(string(index), "(only-claude-1.md)") {
		t.Fatalf("index after restore:\n%s", index)
	}
}

func TestMemoryRefusesFilesTheScanDoesNotKnow(t *testing.T) {
	env := fakeMemoryEnv(t)
	outside := filepath.Join(env.home, "secret.md")
	writeTestFile(t, outside, "đừng đụng\n")
	for _, args := range [][]string{
		{"edit", "--path", outside, "--stdin"},
		{"delete", "--path", outside},
		{"merge", "--source", outside, "--target", filepath.Join(env.memDir("claude-1"), "shared.md"), "--stdin"},
		{"merge", "--source", filepath.Join(env.memDir("claude-1"), "shared.md"), "--target", filepath.Join(env.home, "new.md"), "--stdin"},
		{"edit", "--path", "tuong-doi.md", "--stdin"},
	} {
		if code, _, errOut := runMemory(t, env, "x", args...); code == 0 || errOut == "" {
			t.Errorf("%v: code %d, stderr %q", args, code, errOut)
		}
	}
	if got, _ := os.ReadFile(outside); string(got) != "đừng đụng\n" {
		t.Fatalf("outside file changed: %q", got)
	}
	if code, _, _ := runMemory(t, env, "", "edit", "--path", outside); code != 2 && code != 1 {
		t.Fatalf("edit without content: %d", code)
	}
}

func TestMemoryMergeTwoFiles(t *testing.T) {
	env := fakeMemoryEnv(t)
	dir := env.memDir("claude-1")
	writeTestFile(t, filepath.Join(dir, "other.md"), "xem [chung](shared.md)\n")
	code, _, errOut := runMemory(t, env, "gộp\n", "merge",
		"--source", filepath.Join(dir, "shared.md"), "--source", filepath.Join(dir, "only-claude-1.md"),
		"--target", filepath.Join(dir, "merged.md"), "--stdin")
	if code != 0 {
		t.Fatalf("merge: %d %s", code, errOut)
	}
	index, _ := os.ReadFile(filepath.Join(dir, "MEMORY.md"))
	other, _ := os.ReadFile(filepath.Join(dir, "other.md"))
	if strings.Contains(string(index), "shared.md") || strings.Contains(string(index), "only-claude-1.md") ||
		strings.Count(string(index), "(merged.md)") != 1 || !strings.Contains(string(other), "(merged.md)") {
		t.Fatalf("index:\n%s\nother:\n%s", index, other)
	}
	for _, name := range []string{"shared.md", "only-claude-1.md"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			t.Fatalf("%s not moved to trash", name)
		}
	}
	for _, f := range scanView(t, env).Files {
		for _, flag := range f.Flags {
			if flag.Code == memstore.BrokenLink {
				t.Errorf("broken link after merge: %s", f.Path)
			}
		}
	}
}

func TestMemoryShareThenUnshare(t *testing.T) {
	env := fakeMemoryEnv(t)

	code, out, errOut := runMemory(t, env, "", "share", "--project", env.key)
	if code != 0 {
		t.Fatalf("share: %d %s", code, errOut)
	}
	var res memoryOutput
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatal(err)
	}
	if res.Applied || len(res.Conflicts) != 1 || res.Conflicts[0].Name != "shared.md" {
		t.Fatalf("expected one conflict, got %+v", res)
	}
	if _, err := os.Stat(env.memDir("claude-1")); err != nil {
		t.Fatal("share with conflicts changed the profile memory")
	}

	code, out, errOut = runMemory(t, env, "", "share", "--project", env.key, "--pick", "shared.md=claude-2")
	if code != 0 {
		t.Fatalf("share --pick: %d %s", code, errOut)
	}
	res = memoryOutput{}
	if err := json.Unmarshal([]byte(out), &res); err != nil || !res.Applied || res.Shared == nil {
		t.Fatalf("share result: %v %s", err, out)
	}
	if got, _ := os.ReadFile(filepath.Join(res.Shared.SharedDir, "shared.md")); string(got) != "bản 2\n" {
		t.Fatalf("shared.md = %q", got)
	}
	settings, _ := os.ReadFile(filepath.Join(env.project, ".claude", "settings.local.json"))
	if !strings.Contains(string(settings), "autoMemoryDirectory") {
		t.Fatalf("settings.local.json = %s", settings)
	}
	v := scanView(t, env)
	var sharedFiles int
	for _, f := range v.Files {
		if f.Profile == "shared" && f.Kind == "memory" {
			sharedFiles++
		}
	}
	if sharedFiles != 4 || len(v.Shared) != 1 {
		t.Fatalf("shared files = %d, records = %d", sharedFiles, len(v.Shared))
	}

	if code, _, errOut := runMemory(t, env, "", "unshare", "--project", env.key); code != 0 {
		t.Fatalf("unshare: %d %s", code, errOut)
	}
	for _, id := range []string{"claude-1", "claude-2"} {
		got, err := os.ReadFile(filepath.Join(env.memDir(id), "shared.md"))
		if err != nil || string(got) != "bản 2\n" {
			t.Fatalf("%s shared.md = %q (%v)", id, got, err)
		}
		if _, err := os.Stat(filepath.Join(env.memDir(id), "only-"+id+".md")); err != nil {
			t.Fatalf("%s lost its own file: %v", id, err)
		}
	}
	if _, err := os.Stat(filepath.Join(env.project, ".claude", "settings.local.json")); err == nil {
		t.Fatal("settings.local.json left behind")
	}
}

func TestMemoryShareNeedsKnownProjectFolder(t *testing.T) {
	env := fakeMemoryEnv(t)
	code, _, errOut := runMemory(t, env, "", "share", "--project", "-khong-co-du-an", "--pick", "x=y")
	if code == 0 || errOut == "" {
		t.Fatalf("share of unknown project: %d %q", code, errOut)
	}
	memoryClaudeVersion = func(context.Context) string { return "2.1.100" }
	code, _, errOut = runMemory(t, env, "", "share", "--project", env.key, "--pick", "shared.md=claude-1")
	if code == 0 || !strings.Contains(errOut, "Claude Code") {
		t.Fatalf("share with old claude: %d %q", code, errOut)
	}
}

func TestMemoryUsage(t *testing.T) {
	env := fakeMemoryEnv(t)
	for _, args := range [][]string{{"nope"}, {"edit"}, {"delete"}, {"restore"}, {"merge"}, {"share"}, {"unshare"}} {
		if code, _, errOut := runMemory(t, env, "", args...); code != 2 || !strings.Contains(errOut, "Cách dùng") {
			t.Errorf("%v: code %d stderr %q", args, code, errOut)
		}
	}
}
