package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

const (
	hashA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hashB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	hashC = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
)

type fakeSkillHub struct {
	mu    sync.Mutex
	haves [][]string
	auth  []string
}

func (h *fakeSkillHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/api/v1/run/skills" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	var req struct {
		Have []string `json:"have"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	h.mu.Lock()
	h.haves = append(h.haves, req.Have)
	h.auth = append(h.auth, r.Header.Get("Authorization"))
	h.mu.Unlock()
	has := map[string]bool{}
	for _, x := range req.Have {
		has[x] = true
	}
	skill := func(name, hash, source string, files map[string]string) map[string]any {
		s := map[string]any{"name": name, "hash": hash, "source": source}
		if !has[hash] {
			list := []map[string]string{}
			for p, t := range files {
				list = append(list, map[string]string{"path": p, "text": t})
			}
			s["files"] = list
		}
		return s
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"skills": []any{
		skill("ui-ux-pro-max", hashA, "hive", map[string]string{
			"SKILL.md":          "---\nname: ui-ux-pro-max\n---\n",
			"scripts/search.py": "#!/usr/bin/env python3\nprint(1)\n",
			"data/styles.csv":   "a,b\n",
		}),
		skill("tao-hoa-don", hashB, "project", map[string]string{"SKILL.md": "---\nname: tao-hoa-don\n---\nCác bước.\n"}),
		// Repo đã có skill này: worker giữ bản của repo.
		skill("repo-own", hashC, "org", map[string]string{"SKILL.md": "bản của hub"}),
		skill("../thoat", hashC, "org", nil),
	}})
}

func gitInit(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	for _, args := range [][]string{
		{"init", "-q"},
		{"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"},
	} {
		if out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return dir
}

func TestInstallSkillsCopiesIntoWorktreeWithoutDirtyingGit(t *testing.T) {
	hub := &fakeSkillHub{}
	srv := httptest.NewServer(hub)
	defer srv.Close()
	work := gitInit(t)
	own := filepath.Join(work, ".claude", "skills", "repo-own")
	if err := os.MkdirAll(own, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(own, "SKILL.md"), []byte("bản của repo"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "-C", work, "add", "-A").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	if out, err := exec.Command("git", "-C", work, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "own").CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	cache := t.TempDir()
	job := Job{CLI: "claude", Env: map[string]string{"HIVE_HUB_URL": srv.URL + "/", "HIVE_RUN_TOKEN": "tok"}}

	got, err := installSkills(context.Background(), srv.Client(), cache, job, work)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "ui-ux-pro-max,tao-hoa-don" {
		t.Fatalf("installed = %v", got)
	}
	b, err := os.ReadFile(filepath.Join(work, ".claude", "skills", "ui-ux-pro-max", "data", "styles.csv"))
	if err != nil || string(b) != "a,b\n" {
		t.Fatalf("file kèm theo: %q %v", b, err)
	}
	info, err := os.Stat(filepath.Join(work, ".claude", "skills", "ui-ux-pro-max", "scripts", "search.py"))
	if err != nil {
		t.Fatal(err)
	}
	// Windows không có bit thực thi, Mode().Perm() ở đó không phản ánh quyền chạy.
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o100 == 0 {
		t.Fatalf("script phải chạy được: %v", info.Mode())
	}
	if b, _ := os.ReadFile(filepath.Join(own, "SKILL.md")); string(b) != "bản của repo" {
		t.Fatalf("ghi đè skill của repo: %q", b)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(work), "thoat")); err == nil {
		t.Fatal("tên skill thoát ra ngoài .claude/skills")
	}
	status, err := exec.Command("git", "-C", work, "status", "--porcelain", "--untracked-files=all").CombinedOutput()
	if err != nil || len(status) != 0 {
		t.Fatalf("skill chép vào làm bẩn git: %q %v", status, err)
	}
	if hub.auth[0] != "Bearer tok" {
		t.Fatalf("auth = %q", hub.auth[0])
	}

	// Run sau: gửi hash đã có, hub bỏ files, worker chép từ cache.
	work2 := gitInit(t)
	if _, err := installSkills(context.Background(), srv.Client(), cache, job, work2); err != nil {
		t.Fatal(err)
	}
	if strings.Join(hub.haves[1], ",") != hashA+","+hashB+","+hashC {
		t.Fatalf("have = %v", hub.haves[1])
	}
	if _, err := os.Stat(filepath.Join(work2, ".claude", "skills", "tao-hoa-don", "SKILL.md")); err != nil {
		t.Fatal(err)
	}
}

func TestInstallSkillsRejectsEscapingPathsAndOldHub(t *testing.T) {
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"skills": []any{map[string]any{
			"name": "xau", "hash": hashA, "source": "hive",
			"files": []map[string]string{{"path": "../../ngoai.txt", "text": "x"}},
		}}})
	}))
	defer bad.Close()
	work := t.TempDir()
	job := Job{CLI: "claude", Env: map[string]string{"HIVE_HUB_URL": bad.URL, "HIVE_RUN_TOKEN": "tok"}}
	if _, err := installSkills(context.Background(), bad.Client(), t.TempDir(), job, work); err == nil {
		t.Fatal("đường dẫn thoát khỏi thư mục skill phải bị từ chối")
	}
	if _, err := os.Stat(filepath.Join(work, "..", "ngoai.txt")); err == nil {
		t.Fatal("đã ghi ra ngoài")
	}

	old := httptest.NewServer(http.NotFoundHandler())
	defer old.Close()
	job.Env["HIVE_HUB_URL"] = old.URL
	if got, err := installSkills(context.Background(), old.Client(), t.TempDir(), job, work); err != nil || got != nil {
		t.Fatalf("hub cũ: %v %v", got, err)
	}
}

func TestWantsSkillsOnlyForClaudeCodeAndReview(t *testing.T) {
	cases := []struct {
		cli, kind string
		want      bool
	}{
		{"claude", "", true},
		{"claude", "code", true},
		{"claude", KindReview, true},
		{"claude", KindLeader, false},
		{"claude", KindPlan, false},
		{"codex", "", false},
		{"agy", "", false},
	}
	for _, c := range cases {
		if got := wantsSkills(Job{CLI: c.cli, Kind: c.kind}); got != c.want {
			t.Errorf("wantsSkills(%s/%s) = %v", c.cli, c.kind, got)
		}
	}
}
