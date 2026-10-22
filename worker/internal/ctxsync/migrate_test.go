package ctxsync

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

// shareLegacy dựng một dự án đang dùng chung memory kiểu cũ bằng chính memstore.Share, để test bám đúng
// memory-shared.json thật thay vì một bản tự chế.
func (fx fixture) shareLegacy(t *testing.T) memstore.SharedRecord {
	t.Helper()
	base := filepath.Dir(fx.folder)
	key := memstore.ProjectKey(fx.folder)
	var roots []memstore.Root
	for _, id := range []string{"claude-1", "claude-2"} {
		root := memstore.Root{CLI: "claude", Profile: id, Path: filepath.Join(base, "accounts", id)}
		roots = append(roots, root)
		dir := filepath.Join(root.Path, "projects", key, "memory")
		write := func(name, body string) {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		write("MEMORY.md", "- [Triển khai](deploy.md)\n")
		write("deploy.md", "---\nname: deploy\ntype: project\n---\nChạy migrate trước khi deploy.\r\n")
		write("only-"+id+".md", "riêng "+id+"\n")
	}
	res, err := fx.m.Store.Share(memstore.ShareOptions{Key: key, ProjectPath: fx.folder, Roots: roots,
		SharedRoot: filepath.Join(base, "memory", "claude"), ClaudeVersion: "2.1.299"})
	if err != nil || !res.Applied {
		t.Fatalf("Share = %+v, %v", res, err)
	}
	return *res.Shared
}

func TestMigrationDraftIsNilWithoutLegacySharing(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	mig, err := fx.m.MigrationDraft(p.Key)
	if err != nil || mig != nil {
		t.Fatalf("MigrationDraft = %+v, %v", mig, err)
	}
	if _, _, err := fx.m.ApplyMigration(p.Key); !IsNoShared(err) {
		t.Fatalf("ApplyMigration err = %v, muốn IsNoShared", err)
	}
}

func TestMigrationDraftMergesSourceAndSharedFiles(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "# Của nhóm\n")
	rec := fx.shareLegacy(t)

	mig, err := fx.m.MigrationDraft(p.Key)
	if err != nil || mig == nil {
		t.Fatalf("MigrationDraft = %+v, %v", mig, err)
	}
	for _, want := range []string{"# Của nhóm", "### deploy\n\nChạy migrate trước khi deploy.", "### only-claude-1", "### only-claude-2"} {
		if !strings.Contains(mig.Draft, want) {
			t.Errorf("draft thiếu %q:\n%s", want, mig.Draft)
		}
	}
	// MEMORY.md là mục lục, frontmatter chỉ là siêu dữ liệu, CRLF đã chuẩn hoá.
	for _, bad := range []string{"MEMORY", "name: deploy", "\r", "[Triển khai]"} {
		if strings.Contains(mig.Draft, bad) {
			t.Errorf("draft không được chứa %q:\n%s", bad, mig.Draft)
		}
	}
	if len(mig.Files) != 3 {
		t.Errorf("Files = %v, muốn 3 file (không tính MEMORY.md)", mig.Files)
	}
	// Chỉ xem trước: chưa đổi gì.
	if got, _ := fx.m.Source(p.Key); got != "# Của nhóm\n" {
		t.Errorf("nguồn đổi khi chỉ xem trước: %q", got)
	}
	if records, _ := fx.m.Store.Shared(); len(records) != 1 || records[0].Key != rec.Key {
		t.Errorf("Shared sau khi xem trước = %+v", records)
	}
}

func TestApplyMigrationSavesSourceAndUnshares(t *testing.T) {
	fx := newFixture(t)
	p := fx.enable(t, "")
	rec := fx.shareLegacy(t)

	mig, got, err := fx.m.ApplyMigration(p.Key)
	if err != nil {
		t.Fatal(err)
	}
	source, _ := fx.m.Source(p.Key)
	if source != mig.Draft || !strings.Contains(source, "Chạy migrate trước khi deploy.") {
		t.Errorf("nguồn = %q, draft = %q", source, mig.Draft)
	}
	if blk := fx.read(t, "CLAUDE.local.md"); !strings.Contains(blk, "Chạy migrate trước khi deploy.") {
		t.Errorf("file đích chưa có nguồn mới:\n%s", blk)
	}
	if target(t, got, Claude).Status != StatusOK {
		t.Errorf("Claude = %+v", target(t, got, Claude))
	}
	if records, _ := fx.m.Store.Shared(); len(records) != 0 {
		t.Errorf("vẫn còn bản ghi dùng chung: %+v", records)
	}
	if _, err := os.Stat(rec.SharedDir); !os.IsNotExist(err) {
		t.Errorf("thư mục memory chung còn: %v", err)
	}
	// Mỗi gói nhận lại bản sao memory (Unshare), không mất file nào.
	for _, p := range rec.Profiles {
		if _, err := os.Stat(filepath.Join(p.MemoryDir, "deploy.md")); err != nil {
			t.Errorf("gói %s mất deploy.md: %v", p.Profile, err)
		}
	}
	// Chạy lại: không còn gì để chuyển, không ghép trùng.
	if _, _, err := fx.m.ApplyMigration(p.Key); !IsNoShared(err) {
		t.Errorf("lần hai err = %v", err)
	}
	if again, _ := fx.m.Source(p.Key); again != source {
		t.Errorf("nguồn đổi ở lần hai")
	}
}

func TestMigrationNeedsEnabledProject(t *testing.T) {
	fx := newFixture(t)
	fx.shareLegacy(t)
	key, _ := KeyFor("", fx.folder)
	if _, err := fx.m.MigrationDraft(key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("err = %v", err)
	}
}

func TestDraftFromSkipsEmptyFilesAndMissingDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "rong.md"), []byte("---\nname: x\n---\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	mig, err := draftFrom("", dir)
	if err != nil || mig.Draft != "" || len(mig.Files) != 1 {
		t.Fatalf("draftFrom = %+v, %v", mig, err)
	}
	mig, err = draftFrom("nguồn\n", filepath.Join(dir, "khong-co"))
	if err != nil || mig.Draft != "nguồn\n" || len(mig.Files) != 0 {
		t.Fatalf("thiếu thư mục: %+v, %v", mig, err)
	}
}

// goldenProject là một ContextProject đủ mọi trường (xung đột, bỏ qua, hub, khoá bận). T007 so kiểu TS với file JSON sinh
// từ đây, nên đổi hình của Project mà quên cập nhật file thì test này hỏng.
func goldenProject() Project {
	id, reason, syncedAt := "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11", "Chưa cài Codex.", "2026-10-22T10:00:00Z"
	return Project{
		Key: "p_" + id, ProjectID: &id, Folder: "/work/app", Enabled: true, SourceTokens: 120, BlockTokens: 340,
		Targets: []Target{
			{ID: Claude, Path: "CLAUDE.local.md", Status: StatusOK},
			{ID: Codex, Path: "AGENTS.override.md", Status: StatusSkipped, Reason: &reason},
			{ID: Gemini, Path: "GEMINI.local.md", Status: StatusConflict,
				Conflict: &Conflict{File: "# Tại máy (sửa tay)\n", Source: "# Nguồn\n"}},
			{ID: Antigravity, Path: filepath.ToSlash(filepath.Join(".agents", "rules", "xdev-hive.md")), Status: StatusStale},
		},
		Hub:      &HubView{SyncedAt: &syncedAt, Items: 4, Omitted: Omitted{Budget: 2, Secret: 1}},
		AutoSync: AutoSync{Enabled: true, Minutes: 60, Source: "policy"},
		Locked:   true,
	}
}

func TestContextProjectFixtureMatchesGoType(t *testing.T) {
	raw, err := json.MarshalIndent(goldenProject(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	path := filepath.Join("testdata", "context-project.json")
	if os.Getenv("CTXSYNC_UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("thiếu fixture (chạy lại với CTXSYNC_UPDATE_GOLDEN=1): %v", err)
	}
	// git autocrlf trên Windows đổi xuống dòng của file đã checkout, nên so sau khi chuẩn hoá.
	if normalize(string(want)) != string(raw) {
		t.Fatalf("fixture lệch kiểu Go; chạy lại với CTXSYNC_UPDATE_GOLDEN=1 rồi cập nhật kiểu TS.\ncó:\n%s\nmuốn:\n%s", want, raw)
	}
}
