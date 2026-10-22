package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/ctxsync"
	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

type contextEnv struct {
	home, repo string
}

// fakeContextEnv đặt HOME giả và một repo git tạm; git của máy dev (autocrlf, excludesFile toàn cục) không được lọt vào.
func fakeContextEnv(t *testing.T) contextEnv {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("không có git")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv("GIT_CONFIG_GLOBAL", filepath.Join(home, "no-gitconfig"))
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	for _, name := range []string{"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"} {
		t.Setenv(name, "")
		_ = os.Unsetenv(name)
	}
	oldHome, oldHas := contextHome, contextHasCLI
	contextHome = func() (string, error) { return home, nil }
	contextHasCLI = func(ctxsync.TargetID) bool { return true }
	t.Cleanup(func() { contextHome, contextHasCLI = oldHome, oldHas })

	repo := filepath.Join(home, "work", "app")
	if err := os.MkdirAll(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("git", "init", "-q", repo).CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	return contextEnv{home: home, repo: repo}
}

func (e contextEnv) file(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(e.home, name)
	writeTestFile(t, path, content)
	return path
}

func runContext(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := contextCommand(append(args, "--json"), &out, &errOut)
	return code, out.String(), errOut.String()
}

func contextProject(t *testing.T, args ...string) ctxsync.Project {
	t.Helper()
	code, out, errOut := runContext(t, args...)
	if code != 0 {
		t.Fatalf("context %v: %d\n%s%s", args, code, out, errOut)
	}
	var p ctxsync.Project
	decodeStrict(t, out, &p)
	return p
}

// decodeStrict giữ cho JSON đúng một đối tượng và không có trường lạ so với kiểu Go (hợp đồng sidecar-cli.md).
func decodeStrict(t *testing.T, out string, v any) {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(out))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		t.Fatalf("JSON: %v\n%s", err, out)
	}
	if dec.More() {
		t.Fatalf("JSON có hơn một giá trị:\n%s", out)
	}
}

type contextError struct {
	Error struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func expectContextError(t *testing.T, wantCode string, wantExit int, args ...string) contextError {
	t.Helper()
	code, out, errOut := runContext(t, args...)
	if code != wantExit {
		t.Fatalf("context %v: exit %d, muốn %d\n%s%s", args, code, wantExit, out, errOut)
	}
	var e contextError
	decodeStrict(t, out, &e)
	if e.Error.Code != wantCode || strings.TrimSpace(e.Error.Message) == "" {
		t.Fatalf("lỗi = %+v, muốn code %q và message tiếng Việt", e.Error, wantCode)
	}
	return e
}

func TestContextStatusEmpty(t *testing.T) {
	fakeContextEnv(t)
	code, out, _ := runContext(t, "status")
	if code != 0 || strings.TrimSpace(out) != `{"projects":[]}` {
		t.Fatalf("status = %d %q", code, out)
	}
}

func TestContextEnableSaveSourceSyncDisable(t *testing.T) {
	env := fakeContextEnv(t)
	p := contextProject(t, "enable", "--folder", env.repo, "--project-id", "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11")
	if !p.Enabled || p.Key != "p_7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11" || p.ProjectID == nil || len(p.Targets) != 4 {
		t.Fatalf("enable = %+v", p)
	}
	for _, tg := range p.Targets {
		if tg.Status != ctxsync.StatusOK {
			t.Errorf("%s = %+v", tg.ID, tg)
		}
	}

	src := env.file(t, "source.md", "# Quy ước\n\nChạy pnpm check trước khi mở PR.\n")
	p = contextProject(t, "save-source", "--project", p.Key, "--content-file", src)
	if p.SourceTokens == 0 {
		t.Errorf("save-source = %+v", p)
	}
	claude, err := os.ReadFile(filepath.Join(env.repo, "CLAUDE.local.md"))
	if err != nil || !strings.Contains(string(claude), "Chạy pnpm check trước khi mở PR.") {
		t.Fatalf("CLAUDE.local.md = %q, %v", claude, err)
	}

	hub := env.file(t, "hub.json", `{"projectId":"7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11","items":[`+
		`{"id":"m1","kind":"decision","pinned":true,"createdAt":"2026-10-20T00:00:00Z","content":"Dùng Hono cho hub."}]}`)
	policy := env.file(t, "policy.json", `{"contextBudgetTokens":500,"memoryAutoSync":true,"memorySyncMinutes":15}`)
	p = contextProject(t, "sync", "--project", p.Key, "--hub-file", hub, "--policy-file", policy)
	if p.Hub == nil || p.Hub.Items != 1 || !p.AutoSync.Enabled || p.AutoSync.Minutes != 15 || p.AutoSync.Source != "policy" {
		t.Fatalf("sync = %+v", p)
	}
	if claude, _ = os.ReadFile(filepath.Join(env.repo, "CLAUDE.local.md")); !strings.Contains(string(claude), "Dùng Hono cho hub.") {
		t.Errorf("khối chưa có memory hub: %q", claude)
	}

	list := struct {
		Projects []ctxsync.Project `json:"projects"`
	}{}
	code, out, _ := runContext(t, "status", "--project", p.Key)
	decodeStrict(t, out, &list)
	if code != 0 || len(list.Projects) != 1 || list.Projects[0].Key != p.Key {
		t.Fatalf("status --project = %d %s", code, out)
	}

	code, out, _ = runContext(t, "disable", "--project", p.Key)
	// Ngoài removed và trashed của hợp đồng, kết quả mang thêm entry (mã khôi phục) và warnings.
	var res ctxsync.DisableResult
	decodeStrict(t, out, &res)
	if code != 0 || res.Removed == nil || len(res.Trashed) == 0 || res.Entry == "" {
		t.Fatalf("disable = %d %s", code, out)
	}
	// CLAUDE.local.md do app tạo, nên tắt thì file chỉ còn khối đi vào thùng rác.
	if _, err := os.Stat(filepath.Join(env.repo, "CLAUDE.local.md")); !os.IsNotExist(err) {
		t.Errorf("CLAUDE.local.md còn sau khi tắt: %v", err)
	}
	if _, out, _ := runContext(t, "status", "--project", p.Key); !strings.Contains(out, `"enabled":false`) {
		t.Errorf("status sau khi tắt: %s", out)
	}
}

func TestContextResolveConflict(t *testing.T) {
	env := fakeContextEnv(t)
	path := filepath.Join(env.repo, "CLAUDE.local.md")
	p := contextProject(t, "enable", "--folder", env.repo)
	src := env.file(t, "source.md", "Bản nguồn A\n")
	p = contextProject(t, "save-source", "--project", p.Key, "--content-file", src)

	editBlock := func(from, to string) {
		t.Helper()
		raw, _ := os.ReadFile(path)
		edited := strings.Replace(string(raw), from, to, 1)
		if edited == string(raw) {
			t.Fatalf("không thấy %q trong file:\n%s", from, raw)
		}
		if err := os.WriteFile(path, []byte(edited), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	claude := func(p ctxsync.Project) ctxsync.Target {
		t.Helper()
		for _, tg := range p.Targets {
			if tg.ID == ctxsync.Claude {
				return tg
			}
		}
		t.Fatal("không có file đích claude")
		return ctxsync.Target{}
	}

	editBlock("Bản nguồn A", "Bản sửa tay B")
	p = contextProject(t, "sync", "--project", p.Key)
	if tg := claude(p); tg.Status != ctxsync.StatusConflict || tg.Conflict == nil || !strings.Contains(tg.Conflict.File, "Bản sửa tay B") {
		t.Fatalf("sync sau khi sửa tay = %+v", tg)
	}

	// Giữ nguồn: khối trở lại bản nguồn.
	p = contextProject(t, "resolve", "--project", p.Key, "--target", "claude", "--keep", "source")
	if tg := claude(p); tg.Status != ctxsync.StatusOK {
		t.Fatalf("resolve source = %+v", tg)
	}
	if raw, _ := os.ReadFile(path); !strings.Contains(string(raw), "Bản nguồn A") {
		t.Errorf("khối không về bản nguồn: %q", raw)
	}

	// Giữ file: bản sửa tay thành nguồn mới.
	editBlock("Bản nguồn A", "Bản sửa tay C")
	if tg := claude(contextProject(t, "sync", "--project", p.Key)); tg.Status != ctxsync.StatusConflict {
		t.Fatalf("lần hai = %+v", tg)
	}
	p = contextProject(t, "resolve", "--project", p.Key, "--target", "claude", "--keep", "file")
	if tg := claude(p); tg.Status != ctxsync.StatusOK {
		t.Fatalf("resolve file = %+v", tg)
	}
	source, err := os.ReadFile(filepath.Join(env.home, ".xdev-hive", "context", p.Key, "source.md"))
	if err != nil || !strings.Contains(string(source), "Bản sửa tay C") {
		t.Errorf("nguồn sau resolve file = %q, %v", source, err)
	}
}

func TestContextErrors(t *testing.T) {
	env := fakeContextEnv(t)
	t.Run("lệnh con lạ", func(t *testing.T) {
		expectContextError(t, "invalid_input", 2, "bogus")
	})
	t.Run("thiếu --folder", func(t *testing.T) {
		expectContextError(t, "invalid_input", 2, "enable")
	})
	t.Run("thiếu --project", func(t *testing.T) {
		expectContextError(t, "invalid_input", 2, "disable")
		expectContextError(t, "invalid_input", 2, "sync")
		expectContextError(t, "invalid_input", 2, "migrate")
		expectContextError(t, "invalid_input", 2, "resolve", "--target", "claude", "--keep", "file")
	})
	t.Run("thiếu --content-file", func(t *testing.T) {
		expectContextError(t, "invalid_input", 2, "save-source", "--project", "p_x")
	})
	t.Run("khoá hỏng", func(t *testing.T) {
		expectContextError(t, "invalid_input", 1, "sync", "--project", "../x")
	})
	t.Run("dự án chưa bật", func(t *testing.T) {
		expectContextError(t, "not_found", 1, "sync", "--project", "p_chua-bat")
		expectContextError(t, "not_found", 1, "disable", "--project", "p_chua-bat")
		expectContextError(t, "not_found", 1, "migrate", "--project", "p_chua-bat")
	})
	t.Run("thư mục không có", func(t *testing.T) {
		expectContextError(t, "invalid_input", 1, "enable", "--folder", filepath.Join(env.home, "khong-co"))
	})
	t.Run("đầu vào hỏng", func(t *testing.T) {
		p := contextProject(t, "enable", "--folder", env.repo)
		expectContextError(t, "invalid_input", 1, "save-source", "--project", p.Key, "--content-file", filepath.Join(env.home, "khong-co.md"))
		bad := env.file(t, "bad.json", "{không phải json")
		expectContextError(t, "invalid_input", 1, "sync", "--project", p.Key, "--hub-file", bad)
		expectContextError(t, "invalid_input", 1, "sync", "--project", p.Key, "--policy-file", bad)
		expectContextError(t, "invalid_input", 2, "resolve", "--project", p.Key, "--target", "claude", "--keep", "ca-hai")
		expectContextError(t, "invalid_input", 2, "resolve", "--project", p.Key, "--target", "vim", "--keep", "file")
	})
	t.Run("không --json thì lỗi ra stderr", func(t *testing.T) {
		var out, errOut bytes.Buffer
		if code := contextCommand([]string{"sync", "--project", "p_chua-bat"}, &out, &errOut); code != 1 || out.Len() != 0 || errOut.Len() == 0 {
			t.Fatalf("code = %d, out = %q, err = %q", code, out.String(), errOut.String())
		}
	})
}

// shareLegacyMemory dựng chia sẻ memory kiểu cũ bằng memstore.Share trên HOME giả, đúng nơi lệnh context tìm.
func shareLegacyMemory(t *testing.T, env contextEnv) memstore.SharedRecord {
	t.Helper()
	key := memstore.ProjectKey(env.repo)
	var roots []memstore.Root
	for _, id := range []string{"claude-1", "claude-2"} {
		root := memstore.Root{CLI: "claude", Profile: id, Path: filepath.Join(env.home, ".xdev-hive", "accounts", id)}
		roots = append(roots, root)
		dir := filepath.Join(root.Path, "projects", key, "memory")
		writeTestFile(t, filepath.Join(dir, "MEMORY.md"), "- [Triển khai](deploy.md)\n")
		writeTestFile(t, filepath.Join(dir, "deploy.md"), "---\nname: deploy\n---\nChạy migrate trước khi deploy.\n")
	}
	store := memstore.Store{Dir: filepath.Join(env.home, ".xdev-hive", "optimizer")}
	res, err := store.Share(memstore.ShareOptions{Key: key, ProjectPath: env.repo, Roots: roots,
		SharedRoot: filepath.Join(env.home, ".xdev-hive", "memory", "claude"), ClaudeVersion: "2.1.299"})
	if err != nil || !res.Applied {
		t.Fatalf("Share = %+v, %v", res, err)
	}
	return *res.Shared
}

func TestContextEnableOffersMigrationAndMigrateApplies(t *testing.T) {
	env := fakeContextEnv(t)
	rec := shareLegacyMemory(t, env)

	code, out, errOut := runContext(t, "enable", "--folder", env.repo)
	var enabled struct {
		ctxsync.Project
		Migration *ctxsync.Migration `json:"migration"`
	}
	decodeStrict(t, out, &enabled)
	if code != 0 || enabled.Migration == nil || !strings.Contains(enabled.Migration.Draft, "Chạy migrate trước khi deploy.") {
		t.Fatalf("enable = %d %s %s", code, out, errOut)
	}
	key := enabled.Key

	// Xem trước: chưa đổi gì.
	code, out, _ = runContext(t, "migrate", "--project", key)
	var preview ctxsync.Migration
	decodeStrict(t, out, &preview)
	if code != 0 || preview.Draft != enabled.Migration.Draft || len(preview.Files) != 1 {
		t.Fatalf("migrate = %d %s", code, out)
	}
	store := memstore.Store{Dir: filepath.Join(env.home, ".xdev-hive", "optimizer")}
	if records, _ := store.Shared(); len(records) != 1 {
		t.Fatalf("migrate không --apply đã đổi memory-shared.json: %+v", records)
	}

	code, out, errOut = runContext(t, "migrate", "--project", key, "--apply")
	var applied ctxsync.Migration
	decodeStrict(t, out, &applied)
	if code != 0 || applied.Draft != preview.Draft {
		t.Fatalf("migrate --apply = %d %s %s", code, out, errOut)
	}
	if records, _ := store.Shared(); len(records) != 0 {
		t.Errorf("còn bản ghi dùng chung sau --apply: %+v", records)
	}
	if _, err := os.Stat(rec.SharedDir); !os.IsNotExist(err) {
		t.Errorf("thư mục memory chung còn: %v", err)
	}
	if raw, _ := os.ReadFile(filepath.Join(env.repo, "CLAUDE.local.md")); !strings.Contains(string(raw), "Chạy migrate trước khi deploy.") {
		t.Errorf("nguồn mới chưa vào file đích: %q", raw)
	}

	// Không còn gì để chuyển: not_found, và enable lại không đề nghị chuyển nữa.
	expectContextError(t, "not_found", 1, "migrate", "--project", key, "--apply")
	if _, out, _ = runContext(t, "enable", "--folder", env.repo); strings.Contains(out, `"migration"`) {
		t.Errorf("enable báo migration khi không còn chia sẻ cũ: %s", out)
	}
}

func TestContextMigrateWithoutLegacySharingIsNotFound(t *testing.T) {
	env := fakeContextEnv(t)
	p := contextProject(t, "enable", "--folder", env.repo)
	expectContextError(t, "not_found", 1, "migrate", "--project", p.Key)
}
