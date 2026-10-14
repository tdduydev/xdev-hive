package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/gitgroups"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

func gitgroupsJSON(t *testing.T, stdin string, args ...string) (gitgroupsView, string, string, int) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := gitgroupsCommand(args, strings.NewReader(stdin), &out, &errOut)
	var v gitgroupsView
	if code == 0 && args[0] != "sync" {
		if err := json.Unmarshal(out.Bytes(), &v); err != nil {
			t.Fatalf("JSON: %v\n%s", err, out.String())
		}
	}
	return v, out.String(), errOut.String(), code
}

func TestGitgroupsCommand(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, ".gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	dir := t.TempDir()
	bare := filepath.Join(dir, "api.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", bare).CombinedOutput(); err != nil {
		t.Fatalf("%s %v", out, err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("PRIVATE-TOKEN") != "glpat-ok" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/v4/user":
			_, _ = w.Write([]byte(`{"username":"ha"}`))
		case "/api/v4/groups":
			_, _ = w.Write([]byte(`[{"full_path":"acme"}]`))
		default:
			_, _ = fmt.Fprintf(w, `[{"name":"api","path_with_namespace":"acme/api","http_url_to_repo":%q},{"name":"x","path_with_namespace":"acme/x","archived":true,"http_url_to_repo":"https://h/x.git"}]`, bare)
		}
	}))
	defer srv.Close()
	cfg := filepath.Join(dir, "worker.json")
	root := filepath.Join(dir, "code")

	t.Setenv(gitgroups.TokenEnv, "sai")
	if _, _, stderr, code := gitgroupsJSON(t, "", "host-add", "--config", cfg, "--kind", "gitlab", "--url", srv.URL, "--json"); code != 1 || !strings.Contains(stderr, "Token không dùng được") {
		t.Fatalf("token sai = %d %q", code, stderr)
	}
	if _, err := os.Stat(gitgroups.DefaultPath(cfg)); !os.IsNotExist(err) {
		t.Fatal("token sai mà vẫn ghi cấu hình")
	}
	t.Setenv(gitgroups.TokenEnv, "glpat-ok")
	v, _, _, code := gitgroupsJSON(t, "", "host-add", "--config", cfg, "--kind", "gitlab", "--url", srv.URL, "--name", "GitLab công ty", "--json")
	if code != 0 || v.Host == nil || v.Host.Username != "ha" || len(v.Hosts) != 1 {
		t.Fatalf("host-add = %+v (%d)", v, code)
	}
	if os.Getenv(gitgroups.TokenEnv) != "" {
		t.Fatal("biến token còn trong tiến trình")
	}
	host := v.Host.ID
	if b, _ := os.ReadFile(gitgroups.DefaultPath(cfg)); bytes.Contains(b, []byte("glpat-ok")) {
		t.Fatal("token nằm trong gitgroups.json")
	}

	t.Setenv(gitgroups.TokensEnv, fmt.Sprintf(`{%q:"glpat-ok"}`, host))
	if v, _, _, code = gitgroupsJSON(t, "", "suggest", "--config", cfg, "--host", host, "--json"); code != 0 || strings.Join(v.Items, ",") != "acme" {
		t.Fatalf("suggest = %+v (%d)", v, code)
	}
	t.Setenv(gitgroups.TokensEnv, fmt.Sprintf(`{%q:"glpat-ok"}`, host))
	v, _, stderr, code := gitgroupsJSON(t, "", "group-add", "--config", cfg, "--host", host, "--path", "acme", "--root", root, "--json")
	if code != 0 || v.Group == nil || len(v.Group.Repos) != 2 || v.Group.Protocol != "https" {
		t.Fatalf("group-add = %+v (%d) %s", v, code, stderr)
	}
	group := v.Group.ID

	if v, _, _, code = gitgroupsJSON(t, "", "status", "--config", cfg, "--id", group, "--json"); code != 0 || len(v.Status) != 1 || v.Status[0].State != gitgroups.StateMissing {
		t.Fatalf("status = %+v (%d)", v.Status, code)
	}
	_, out, stderr, code := gitgroupsJSON(t, "", "sync", "--config", cfg, "--id", group, "--action", "clone", "--json")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if code != 0 || len(lines) != 3 || !strings.Contains(lines[1], `"result":"done"`) || !strings.Contains(lines[2], `"type":"done"`) {
		t.Fatalf("sync clone = %d %s %s", code, out, stderr)
	}
	list, _ := projects.Load(projects.DefaultPath(cfg))
	if len(list) != 1 || list[0].Folder != filepath.Join(root, "acme", "api") {
		t.Fatalf("Dự án trên máy = %+v", list)
	}

	if _, _, stderr, code = gitgroupsJSON(t, "", "host-remove", "--config", cfg, "--id", host, "--json"); code != 1 || !strings.Contains(stderr, "acme") {
		t.Fatalf("xoá kết nối còn nhóm = %d %q", code, stderr)
	}
	v, _, _, code = gitgroupsJSON(t, "", "group-update", "--config", cfg, "--id", group, "--auto-fetch", "15", "--excluded", `["acme/api"]`, "--json")
	if code != 0 || v.Group.AutoFetchMinutes != 15 || len(v.Group.Excluded) != 1 || v.Group.Root != root {
		t.Fatalf("group-update = %+v (%d)", v.Group, code)
	}
	if _, _, _, code = gitgroupsJSON(t, "", "group-update", "--config", cfg, "--id", group, "--auto-fetch", "1", "--json"); code != 1 {
		t.Fatal("tự fetch mỗi phút không bị từ chối")
	}
	if v, _, _, _ = gitgroupsJSON(t, "", "due", "--config", cfg, "--json"); len(v.Due) != 1 || v.Due[0].HostID != host {
		t.Fatalf("due = %+v", v.Due)
	}
	if _, _, _, code = gitgroupsJSON(t, "", "auto-fetch", "--config", cfg, "--json"); code != 0 {
		t.Fatal("auto-fetch lỗi")
	}
	if v, _, _, _ = gitgroupsJSON(t, "", "due", "--config", cfg, "--json"); len(v.Due) != 0 || v.Groups[0].LastAutoFetchAt == "" {
		t.Fatalf("due sau auto-fetch = %+v", v.Due)
	}
	if _, _, _, code = gitgroupsJSON(t, "", "group-remove", "--config", cfg, "--id", group, "--json"); code != 0 {
		t.Fatal("group-remove lỗi")
	}
	if v, _, _, code = gitgroupsJSON(t, "", "host-remove", "--config", cfg, "--id", host, "--json"); code != 0 || len(v.Hosts) != 0 {
		t.Fatalf("host-remove = %+v (%d)", v, code)
	}
	if _, err := os.Stat(filepath.Join(root, "acme", "api", ".git")); err != nil {
		t.Fatal("bỏ theo dõi đã xoá thư mục đã clone")
	}
}
