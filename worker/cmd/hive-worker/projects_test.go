package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const projectID = "0a0a0a0a-0000-4000-8000-000000000003"

func projectsJSON(t *testing.T, args ...string) (projectsView, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := projectsCommand(args, &out, &errOut)
	var v projectsView
	if code == 0 && strings.Contains(strings.Join(args, " "), "--json") {
		if err := json.Unmarshal(out.Bytes(), &v); err != nil {
			t.Fatalf("JSON: %v\n%s", err, out.String())
		}
	}
	return v, errOut.String(), code
}

func TestProjectsCommand(t *testing.T) {
	dir := t.TempDir()
	cfg := filepath.Join(dir, "worker.json")
	repo := filepath.Join(dir, "app")
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	if out, err := exec.Command("git", "-C", repo, "remote", "add", "origin", "https://x-access-token:secret@github.com/acme/app.git").CombinedOutput(); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	legacy := filepath.Join(dir, "legacy.json")
	if err := os.WriteFile(legacy, []byte(`{"projects":[{"name":"app","repo":`+string(mustJSON(repo))+`}]}`), 0o600); err != nil {
		t.Fatal(err)
	}

	v, _, code := projectsJSON(t, "--config", cfg, "--json")
	if code != 0 || v.Exists || len(v.Projects) != 0 || v.Path != filepath.Join(dir, "projects.json") {
		t.Fatalf("list rỗng = %+v (%d)", v, code)
	}
	v, _, code = projectsJSON(t, "import-legacy", "--config", cfg, "--from", legacy, "--json")
	if code != 0 || !v.Exists || v.Imported != 1 || len(v.Projects) != 1 || v.Projects[0].ProjectID != "" {
		t.Fatalf("import-legacy = %+v (%d)", v, code)
	}
	// Origin in ra đã bỏ token.
	if p := v.Projects[0]; !p.IsGit || p.Origin != "https://github.com/acme/app.git" {
		t.Fatalf("mục nhập = %+v", p)
	}
	if _, stderr, code := projectsJSON(t, "bind", "--config", cfg, "--id", projectID, "--folder", repo, "--repo-url", "https://github.com/acme/khac", "--json"); code != 1 || !strings.Contains(stderr, "không khớp") {
		t.Fatalf("bind remote sai: %d %q", code, stderr)
	}
	v, _, code = projectsJSON(t, "bind", "--config", cfg, "--id", projectID, "--folder", repo, "--repo-url", "git@github.com:acme/app.git", "--json")
	if code != 0 || len(v.Projects) != 1 || v.Projects[0].ProjectID != projectID || v.Projects[0].FullPermission {
		t.Fatalf("bind = %+v (%d)", v, code)
	}
	v, _, code = projectsJSON(t, "set", "--config", cfg, "--id", projectID, "--full=true", "--json")
	if code != 0 || !v.Projects[0].FullPermission {
		t.Fatalf("set = %+v (%d)", v, code)
	}
	if _, _, code := projectsJSON(t, "set", "--config", cfg, "--id", projectID, "--full=có"); code != 2 {
		t.Fatalf("set sai cờ: %d", code)
	}
	v, _, code = projectsJSON(t, "unbind", "--config", cfg, "--id", projectID, "--json")
	if code != 0 || len(v.Projects) != 0 {
		t.Fatalf("unbind = %+v (%d)", v, code)
	}
	if _, _, code := projectsJSON(t, "unbind", "--config", cfg); code != 2 {
		t.Fatalf("unbind thiếu cờ: %d", code)
	}
	if _, _, code := projectsJSON(t, "lam-gi", "--config", cfg); code != 2 {
		t.Fatalf("lệnh lạ: %d", code)
	}
	var out bytes.Buffer
	if code := projectsCommand([]string{"--config", cfg}, &out, &bytes.Buffer{}); code != 0 || !strings.Contains(out.String(), "Chưa gắn dự án nào") {
		t.Fatalf("list chữ: %d %q", code, out.String())
	}
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
