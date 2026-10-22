package ctxsync

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

type fixture struct {
	m      Manager
	folder string
}

// isolateGit để git của máy dev (autocrlf, excludesFile toàn cục) không đổi kết quả test.
func isolateGit(t *testing.T) {
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
}

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	isolateGit(t)
	base := t.TempDir()
	folder := filepath.Join(base, "app")
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, folder, "init", "-q")
	now := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	return fixture{folder: folder, m: Manager{Root: filepath.Join(base, "context"),
		Store: memstore.Store{Dir: filepath.Join(base, "optimizer"), Now: func() time.Time { return now }},
		Now:   func() time.Time { return now }}}
}

func (fx fixture) write(t *testing.T, rel, content string) {
	t.Helper()
	path := filepath.Join(fx.folder, rel)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (fx fixture) read(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(fx.folder, rel))
	if err != nil {
		t.Fatalf("đọc %s: %v", rel, err)
	}
	return string(raw)
}

func (fx fixture) exists(rel string) bool {
	_, err := os.Stat(filepath.Join(fx.folder, rel))
	return err == nil
}

func (fx fixture) enable(t *testing.T, source string) Project {
	t.Helper()
	p, err := fx.m.Enable(fx.folder, "")
	if err != nil {
		t.Fatal(err)
	}
	if source != "" {
		if p, err = fx.m.SaveSource(p.Key, source); err != nil {
			t.Fatal(err)
		}
	}
	return p
}

func target(t *testing.T, p Project, id TargetID) Target {
	t.Helper()
	for _, tg := range p.Targets {
		if tg.ID == id {
			return tg
		}
	}
	t.Fatalf("không có file đích %s trong %+v", id, p.Targets)
	return Target{}
}

func blockOf(t *testing.T, content string) Block {
	t.Helper()
	blocks, err := ParseBlocks(content)
	if err != nil || len(blocks) != 1 {
		t.Fatalf("blocks = %+v, err = %v trong %q", blocks, err, content)
	}
	return blocks[0]
}

func outside(content string, b Block) string { return content[:b.Start] + "|" + content[b.End:] }

func status(t *testing.T, m Manager, key string) Project {
	t.Helper()
	list, err := m.Status(key)
	if err != nil || len(list) != 1 {
		t.Fatalf("Status = %+v, %v", list, err)
	}
	return list[0]
}

// SC-002: chữ người dùng ngoài khối không đổi byte nào sau bật, sửa nguồn, tắt.
func TestUserBytesUntouchedThroughEnableEditDisable(t *testing.T) {
	cases := map[string]string{
		"LF":               "# Ghi chú của tôi\n\nKhông đụng vào.\n",
		"CRLF + BOM":       bom + "# Ghi chú\r\nKhông đụng.\r\n",
		"không xuống dòng": "# Ghi chú\nkết thúc không xuống dòng",
	}
	for name, orig := range cases {
		t.Run(name, func(t *testing.T) {
			fx := newFixture(t)
			fx.write(t, "CLAUDE.local.md", orig)
			fx.write(t, "GEMINI.local.md", orig)
			p := fx.enable(t, "Nguồn một\n")
			for _, rel := range []string{"CLAUDE.local.md", "GEMINI.local.md"} {
				got := fx.read(t, rel)
				if !strings.HasPrefix(got, orig) {
					t.Fatalf("%s: phần đầu đổi: %q", rel, got)
				}
				if strings.Contains(orig, "\r\n") && strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
					t.Fatalf("%s: trộn LF vào file CRLF: %q", rel, got)
				}
			}
			before := outside(fx.read(t, "CLAUDE.local.md"), blockOf(t, fx.read(t, "CLAUDE.local.md")))
			if _, err := fx.m.SaveSource(p.Key, "Nguồn hai\ncó hai dòng\n"); err != nil {
				t.Fatal(err)
			}
			after := fx.read(t, "CLAUDE.local.md")
			b := blockOf(t, after)
			if outside(after, b) != before {
				t.Fatalf("byte ngoài khối đổi sau khi sửa nguồn:\n%q\n%q", before, outside(after, b))
			}
			if !strings.Contains(b.Body, "Nguồn hai\ncó hai dòng") {
				t.Fatalf("khối chưa theo nguồn: %q", b.Body)
			}
			res, err := fx.m.Disable(p.Key)
			if err != nil {
				t.Fatal(err)
			}
			for _, rel := range []string{"CLAUDE.local.md", "GEMINI.local.md"} {
				if got := fx.read(t, rel); got != orig {
					t.Fatalf("%s sau khi tắt = %q, muốn %q", rel, got, orig)
				}
			}
			if len(res.Removed) < 2 {
				t.Fatalf("removed = %v", res.Removed)
			}
		})
	}
}

func TestEnableCreatesAllTargetsAndExcludesThem(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "AGENTS.md", "# Quy ước đội\n")
	runGit(t, fx.folder, "add", "AGENTS.md")
	runGit(t, fx.folder, "commit", "-q", "-m", "init")
	p := fx.enable(t, "Chạy pnpm check trước khi mở PR.\n")
	for _, id := range Targets {
		if tg := target(t, p, id); tg.Status != StatusOK {
			t.Fatalf("%s = %+v", id, tg)
		}
	}
	claude := fx.read(t, "CLAUDE.local.md")
	if !strings.Contains(claude, "\n@AGENTS.md\n") {
		t.Fatalf("thiếu @AGENTS.md khi không có CLAUDE.md: %q", claude)
	}
	codex := fx.read(t, "AGENTS.override.md")
	if !strings.HasPrefix(codex, "# Quy ước đội\n\n<!-- xdev-hive:context v1 sha=") {
		t.Fatalf("gương Codex = %q", codex)
	}
	if strings.Contains(codex, "@AGENTS.md") {
		t.Fatalf("gương Codex không cần import: %q", codex)
	}
	rule := fx.read(t, filepath.Join(".agents", "rules", "xdev-hive.md"))
	if !strings.HasPrefix(rule, "---\ntrigger: always_on\n---\n\n<!-- xdev-hive:context") {
		t.Fatalf("rule Antigravity = %q", rule)
	}
	settings := fx.read(t, filepath.Join(".gemini", "settings.json"))
	if !strings.Contains(settings, `"fileName":["GEMINI.md","GEMINI.local.md"]`) && !strings.Contains(settings, `"GEMINI.local.md"`) {
		t.Fatalf("settings = %q", settings)
	}
	if st := runGit(t, fx.folder, "status", "--porcelain", "--untracked-files=all"); strings.TrimSpace(st) != "" {
		t.Fatalf("git status phải sạch sau khi bật:\n%s", st)
	}
	if p.BlockTokens == 0 || p.SourceTokens == 0 {
		t.Fatalf("tokens = %d/%d", p.SourceTokens, p.BlockTokens)
	}
}

func TestClaudeWithClaudeMDHasNoImport(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "CLAUDE.md", "# của đội\n")
	fx.write(t, "AGENTS.md", "# của đội\n")
	fx.enable(t, "x\n")
	if strings.Contains(fx.read(t, "CLAUDE.local.md"), "@AGENTS.md") {
		t.Fatal("có CLAUDE.md thì không nhập AGENTS.md")
	}
}

func TestConflictThenResolveKeepFile(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "bản nguồn\n")
	edited := strings.Replace(fx.read(t, "CLAUDE.local.md"), "bản nguồn", "bản sửa tay", 1)
	fx.write(t, "CLAUDE.local.md", edited)

	if tg := target(t, status(t, fx.m, p.Key), Claude); tg.Status != StatusConflict || tg.Conflict == nil ||
		tg.Conflict.File != "bản sửa tay" || tg.Conflict.Source != "bản nguồn\n" {
		t.Fatalf("claude = %+v", tg)
	}
	p, err := fx.m.SaveSource(p.Key, "bản nguồn mới\n")
	if err != nil {
		t.Fatal(err)
	}
	if target(t, p, Claude).Status != StatusConflict || fx.read(t, "CLAUDE.local.md") != edited {
		t.Fatal("xung đột thì không được ghi đè")
	}
	if target(t, p, Codex).Status != StatusOK || !strings.Contains(fx.read(t, "AGENTS.override.md"), "bản nguồn mới") {
		t.Fatal("file đích khác vẫn phải được ghi")
	}
	p, err = fx.m.Resolve(p.Key, Claude, "file")
	if err != nil {
		t.Fatal(err)
	}
	if src, _ := fx.m.Source(p.Key); src != "bản sửa tay" {
		t.Fatalf("nguồn = %q", src)
	}
	for _, id := range Targets {
		if tg := target(t, p, id); tg.Status != StatusOK {
			t.Fatalf("%s = %+v", id, tg)
		}
	}
	if !strings.Contains(fx.read(t, "AGENTS.override.md"), "bản sửa tay") || blockOf(t, fx.read(t, "CLAUDE.local.md")).Edited() {
		t.Fatal("giữ bản file phải ghi lại mọi file đích")
	}
	if _, err := fx.m.Resolve(p.Key, Claude, "file"); err == nil {
		t.Fatal("hết xung đột thì Resolve phải báo lỗi")
	}
}

func TestResolveKeepSource(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "nguồn\n")
	rule := filepath.Join(".agents", "rules", "xdev-hive.md")
	fx.write(t, rule, strings.Replace(fx.read(t, rule), "nguồn", "sửa", 1))
	if target(t, status(t, fx.m, p.Key), Antigravity).Status != StatusConflict {
		t.Fatal("muốn xung đột")
	}
	p, err := fx.m.Resolve(p.Key, Antigravity, "source")
	if err != nil {
		t.Fatal(err)
	}
	if target(t, p, Antigravity).Status != StatusOK || !strings.Contains(fx.read(t, rule), "\nnguồn\n") {
		t.Fatalf("rule = %q", fx.read(t, rule))
	}
}

func TestCodexMirrorFollowsAgents(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "AGENTS.md", "bản một\r\n")
	p := fx.enable(t, "nguồn\n")
	if got := fx.read(t, "AGENTS.override.md"); !strings.HasPrefix(got, "bản một\r\n\r\n<!--") || strings.Contains(strings.ReplaceAll(got, "\r\n", ""), "\n") {
		t.Fatalf("gương = %q", got)
	}
	fx.write(t, "AGENTS.md", "bản hai\r\n")
	if tg := target(t, status(t, fx.m, p.Key), Codex); tg.Status != StatusStale {
		t.Fatalf("AGENTS.md đổi thì gương phải stale: %+v", tg)
	}
	p, _, err := fx.m.Sync(p.Key, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(fx.read(t, "AGENTS.override.md"), "bản hai\r\n") || target(t, p, Codex).Status != StatusOK {
		t.Fatalf("gương = %q", fx.read(t, "AGENTS.override.md"))
	}
	if target(t, status(t, fx.m, p.Key), Codex).Status != StatusOK {
		t.Fatal("đã đồng bộ thì ok")
	}
}

func TestUserWrittenOverrideIsSkipped(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "AGENTS.override.md", "của người dùng\n")
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Codex); tg.Status != StatusSkipped || tg.Reason == nil || !strings.Contains(*tg.Reason, "tự viết") {
		t.Fatalf("codex = %+v", tg)
	}
	if fx.read(t, "AGENTS.override.md") != "của người dùng\n" {
		t.Fatal("không được sửa file của người dùng")
	}
	if _, err := fx.m.Disable(p.Key); err != nil {
		t.Fatal(err)
	}
	if fx.read(t, "AGENTS.override.md") != "của người dùng\n" {
		t.Fatal("tắt cũng không được đụng file của người dùng")
	}
}

func TestTrackedTargetIsSkipped(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "CLAUDE.local.md", "lỡ commit\n")
	runGit(t, fx.folder, "add", "CLAUDE.local.md")
	runGit(t, fx.folder, "commit", "-q", "-m", "x")
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Claude); tg.Status != StatusSkipped || tg.Reason == nil || !strings.Contains(*tg.Reason, "git rm --cached CLAUDE.local.md") {
		t.Fatalf("claude = %+v", tg)
	}
	if fx.read(t, "CLAUDE.local.md") != "lỡ commit\n" {
		t.Fatal("file bị theo dõi không được ghi")
	}
}

func TestTrackedGeminiSettingsSkipsGemini(t *testing.T) {
	fx := newFixture(t)
	settings := filepath.Join(".gemini", "settings.json")
	fx.write(t, settings, "{\"theme\": \"dark\"}\n")
	runGit(t, fx.folder, "add", ".gemini")
	runGit(t, fx.folder, "commit", "-q", "-m", "x")
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Gemini); tg.Status != StatusSkipped || tg.Reason == nil || !strings.Contains(*tg.Reason, "settings.json") {
		t.Fatalf("gemini = %+v", tg)
	}
	if fx.exists("GEMINI.local.md") || fx.read(t, settings) != "{\"theme\": \"dark\"}\n" {
		t.Fatal("Gemini bị bỏ qua thì không ghi gì")
	}
}

func TestGeminiSettingsRestoredByteForByte(t *testing.T) {
	fx := newFixture(t)
	settings := filepath.Join(".gemini", "settings.json")
	orig := "{\n    \"theme\": \"dark\",\n    \"context\": {\"fileName\": \"AGENTS.md\"}\n}"
	fx.write(t, settings, orig)
	p := fx.enable(t, "nguồn\n")
	got := fx.read(t, settings)
	if !strings.Contains(got, `"AGENTS.md","GEMINI.local.md"`) && !strings.Contains(got, `"AGENTS.md",`) {
		t.Fatalf("settings = %q", got)
	}
	if !strings.Contains(got, `"theme": "dark"`) {
		t.Fatalf("mất khoá khác: %q", got)
	}
	if _, err := fx.m.Disable(p.Key); err != nil {
		t.Fatal(err)
	}
	if fx.read(t, settings) != orig {
		t.Fatalf("settings sau khi tắt = %q", fx.read(t, settings))
	}
}

func TestGeminiSettingsEditedLaterOnlyLosesOurName(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "nguồn\n")
	settings := filepath.Join(".gemini", "settings.json")
	fx.write(t, settings, "{\"theme\":\"light\",\"context\":{\"fileName\":[\"GEMINI.md\",\"GEMINI.local.md\"]}}\n")
	res, err := fx.m.Disable(p.Key)
	if err != nil {
		t.Fatal(err)
	}
	got := fx.read(t, settings)
	if strings.Contains(got, "GEMINI.local.md") || !strings.Contains(got, `"theme": "light"`) || strings.Contains(got, "context") {
		t.Fatalf("settings = %q (res %+v)", got, res)
	}
}

func TestDisableTrashesCreatedFilesAndRestores(t *testing.T) {
	fx := newFixture(t)
	exclude := filepath.Join(fx.folder, ".git", "info", "exclude")
	beforeExclude, _ := os.ReadFile(exclude)
	p := fx.enable(t, "nguồn\n")
	created := map[string]string{}
	for _, rel := range []string{"CLAUDE.local.md", "AGENTS.override.md", "GEMINI.local.md",
		filepath.Join(".agents", "rules", "xdev-hive.md"), filepath.Join(".gemini", "settings.json")} {
		created[rel] = fx.read(t, rel)
	}
	res, err := fx.m.Disable(p.Key)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Trashed) != len(created) || res.Entry == "" {
		t.Fatalf("res = %+v", res)
	}
	for rel := range created {
		if fx.exists(rel) {
			t.Fatalf("%s còn sau khi tắt", rel)
		}
	}
	for _, dir := range []string{".agents", ".gemini"} {
		if fx.exists(dir) {
			t.Fatalf("thư mục %s app tạo còn sau khi tắt", dir)
		}
	}
	if afterExclude, _ := os.ReadFile(exclude); string(afterExclude) != string(beforeExclude) {
		t.Fatalf("exclude sau khi tắt = %q, muốn %q", afterExclude, beforeExclude)
	}
	if got := status(t, fx.m, p.Key); got.Enabled || len(got.Targets) != 0 {
		t.Fatalf("status = %+v", got)
	}
	if _, err := fx.m.Store.Restore(res.Entry); err != nil {
		t.Fatal(err)
	}
	for rel, want := range created {
		if fx.read(t, rel) != want {
			t.Fatalf("%s khôi phục sai", rel)
		}
	}
	if src, _ := fx.m.Source(p.Key); src != "nguồn\n" {
		t.Fatalf("tắt phải giữ nguồn: %q", src)
	}
}

func TestSyncEntryRestoresPreviousBlock(t *testing.T) {
	fx := newFixture(t)
	fx.write(t, "CLAUDE.local.md", "của tôi\n")
	p := fx.enable(t, "một\n")
	before := fx.read(t, "CLAUDE.local.md")
	if err := os.WriteFile(fx.m.sourcePath(p.Key), []byte("hai\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, entry, err := fx.m.Sync(p.Key, nil, nil)
	if err != nil || entry == "" {
		t.Fatalf("entry = %q, err = %v", entry, err)
	}
	if _, entry2, _ := fx.m.Sync(p.Key, nil, nil); entry2 != "" {
		t.Fatal("không đổi gì thì không tạo bản lưu")
	}
	if _, err := fx.m.Store.Restore(entry); err != nil {
		t.Fatal(err)
	}
	if fx.read(t, "CLAUDE.local.md") != before {
		t.Fatal("khôi phục bản lưu context.sync phải trả khối cũ")
	}
}

func TestBrokenMarkersAreSkipped(t *testing.T) {
	fx := newFixture(t)
	broken := "chữ\n<!-- xdev-hive:context v1 sha=0123456789ab -->\nkhông đóng\n"
	fx.write(t, "CLAUDE.local.md", broken)
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Claude); tg.Status != StatusSkipped || tg.Reason == nil || !strings.Contains(*tg.Reason, "dòng 2") {
		t.Fatalf("claude = %+v", tg)
	}
	if fx.read(t, "CLAUDE.local.md") != broken {
		t.Fatal("dấu hỏng thì không ghi")
	}
}

func TestNotInstalledCLIGetsNoFile(t *testing.T) {
	fx := newFixture(t)
	fx.m.Installed = func(id TargetID) bool { return id != Antigravity }
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Antigravity); tg.Status != StatusSkipped || fx.exists(".agents") {
		t.Fatalf("antigravity = %+v", tg)
	}
}

func TestUnreadableCLIIsSkipped(t *testing.T) {
	fx := newFixture(t)
	Readable[Gemini] = false
	t.Cleanup(func() { Readable[Gemini] = true })
	p := fx.enable(t, "nguồn\n")
	if tg := target(t, p, Gemini); tg.Status != StatusSkipped || tg.Reason == nil || !strings.Contains(*tg.Reason, "chưa hỗ trợ") {
		t.Fatalf("gemini = %+v", tg)
	}
}

func TestHubItemsGoToHubSection(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	hub := &HubSnapshot{ProjectID: "x", Items: []HubItem{{ID: "1", Content: "Bài học từ đội", Pinned: true}}}
	p, _, err := fx.m.Sync(p.Key, hub, &Policy{MemoryAutoSync: true, MemorySyncMinutes: 30})
	if err != nil {
		t.Fatal(err)
	}
	body := blockOf(t, fx.read(t, "CLAUDE.local.md")).Body
	if strings.Contains(body, headLocal) || !strings.Contains(body, headHub+"\n\n- Bài học từ đội") {
		t.Fatalf("body = %q", body)
	}
	if p.Hub == nil || p.Hub.Items != 1 || p.Hub.SyncedAt == nil || p.AutoSync != (AutoSync{Enabled: true, Minutes: 30, Source: "policy"}) {
		t.Fatalf("project = %+v", p)
	}
	// Hub gỡ memory thì lần đồng bộ sau mục đó biến mất.
	if _, _, err := fx.m.Sync(p.Key, &HubSnapshot{ProjectID: "x"}, nil); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fx.read(t, "CLAUDE.local.md"), "Bài học") {
		t.Fatal("mục bị gỡ trên hub vẫn còn")
	}
}

func TestProjectKeyFollowsHubProject(t *testing.T) {
	fx := newFixture(t)
	p, err := fx.m.Enable(fx.folder, "0b6c6a3e-1f7e-4c55-9a64-1c8d0f2b9a10")
	if err != nil {
		t.Fatal(err)
	}
	if p.Key != "p_0b6c6a3e-1f7e-4c55-9a64-1c8d0f2b9a10" || p.ProjectID == nil {
		t.Fatalf("project = %+v", p)
	}
	if _, err := fx.m.SaveSource(p.Key, "giữ khi chuyển thư mục\n"); err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(filepath.Dir(fx.folder), "moved")
	if err := os.MkdirAll(moved, 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, moved, "init", "-q")
	p2, err := fx.m.Enable(moved, *p.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	if p2.Key != p.Key || !strings.Contains(readFile(t, filepath.Join(moved, "CLAUDE.local.md")), "giữ khi chuyển thư mục") {
		t.Fatal("nguồn phải đi theo dự án hub")
	}
	if fx.exists("CLAUDE.local.md") {
		t.Fatal("thư mục cũ phải được gỡ khối")
	}
	if _, err := KeyFor("../x", ""); err == nil {
		t.Fatal("id dự án lạ phải bị từ chối")
	}
	if _, err := fx.m.Status("../x"); err == nil {
		t.Fatal("khoá lạ phải bị từ chối")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
