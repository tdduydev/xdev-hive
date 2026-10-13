package accounts

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFile ghi file cấu hình CLI (không có token) cho test, tạo thư mục cha nếu cần.
func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func claudeJSON(email string) string {
	return `{"oauthAccount":{"emailAddress":"` + email + `"}}`
}

// discoverHome dựng máy có: claude-3 (đã trong danh sách, ghi đường dẫn tuyệt đối như app v1), claude-8 (mới, trùng
// email claude-3), codex-2 (đã đăng xuất, còn config.toml), "work" (đoán Claude theo file), "rong" (rỗng), "notes"
// (không đoán được), đăng nhập mặc định của Claude, Codex (đã trong danh sách dạng "~/.codex") và agy.
func discoverHome(t *testing.T) (home, path string) {
	t.Helper()
	home = t.TempDir()
	acc := AccountsDir(home)
	writeFile(t, filepath.Join(acc, "claude-3", ".claude.json"), claudeJSON("duy@example.com"))
	writeFile(t, filepath.Join(acc, "claude-8", ".claude.json"), claudeJSON("DUY@example.com"))
	writeFile(t, filepath.Join(acc, "codex-2", "config.toml"), "model = \"gpt-5\"\n")
	writeFile(t, filepath.Join(acc, "work", ".claude.json"), claudeJSON("work@example.com"))
	writeFile(t, filepath.Join(acc, "notes", "readme.txt"), "x")
	writeFile(t, filepath.Join(acc, "loose.json"), "{}")
	if err := os.MkdirAll(filepath.Join(acc, "rong"), 0o700); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(home, ".claude.json"), claudeJSON("me@gmail.com"))
	writeFile(t, filepath.Join(home, ".codex", "auth.json"), `{"OPENAI_API_KEY":"sk-bimat"}`)
	if err := os.MkdirAll(agyHome(home), 0o700); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "accounts.json")
	list := []Account{
		Account{ID: "claude-3", Label: "duy", CLI: "claude", ConfigDir: filepath.Join(acc, "claude-3"), Enabled: true}.withDefaults(),
		Account{ID: "codex-1", Label: "codex", CLI: "codex", ConfigDir: "~/.codex", Enabled: true}.withDefaults(),
		Account{ID: "claude-1", Label: "khác", CLI: "claude", ConfigDir: "~/khac", Enabled: true}.withDefaults(),
	}
	if err := Save(path, 0, list); err != nil {
		t.Fatal(err)
	}
	return home, path
}

func str(p *string) string {
	if p == nil {
		return "<nil>"
	}
	return *p
}

func TestDiscoverFindsLoginsNotInList(t *testing.T) {
	home, path := discoverHome(t)
	found, err := Discover(path, home)
	if err != nil {
		t.Fatal(err)
	}
	type row struct{ cli, dir, email, id, note string }
	var got []row
	for _, f := range found {
		got = append(got, row{f.CLI, str(f.ConfigDir), str(f.Email), f.SuggestedID, str(f.Note)})
	}
	want := []row{
		{"claude", "~/.xdev-hive/accounts/claude-8", "DUY@example.com", "claude-8", "Trùng email với claude-3"},
		{"codex", "~/.xdev-hive/accounts/codex-2", "<nil>", "codex-2", "<nil>"},
		// Tên không theo <cli>-<n>: id mới, bỏ qua tên đang dùng (claude-1, claude-3) và tên thư mục (claude-8).
		{"claude", "~/.xdev-hive/accounts/work", "work@example.com", "claude-2", "<nil>"},
		{"claude", "<nil>", "me@gmail.com", "claude-4", "<nil>"},
		{"antigravity", "<nil>", "<nil>", "antigravity-1", "Antigravity giữ đăng nhập trong keyring, worker không kiểm được"},
	}
	if len(got) != len(want) {
		t.Fatalf("found = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("[%d] = %+v, muốn %+v", i, got[i], want[i])
		}
	}
	if !*found[0].LoggedIn || *found[1].LoggedIn || found[4].LoggedIn != nil {
		t.Fatalf("loggedIn = %v %v %v", *found[0].LoggedIn, *found[1].LoggedIn, found[4].LoggedIn)
	}
	// Không in token hay khoá API.
	b, _ := json.Marshal(map[string]any{"found": found})
	if strings.Contains(string(b), "bimat") || !strings.Contains(string(b), `"configDir":null`) || !strings.Contains(string(b), `"suggestedId":"claude-8"`) {
		t.Fatalf("json = %s", b)
	}
}

func TestDiscoverEmptyMachine(t *testing.T) {
	found, err := Discover(filepath.Join(t.TempDir(), "accounts.json"), t.TempDir())
	if err != nil || len(found) != 0 {
		t.Fatalf("found = %+v, %v", found, err)
	}
}

func TestAddFoundAddsWithoutLogin(t *testing.T) {
	home, path := discoverHome(t)
	// Thư mục ghi tuyệt đối hay "~/" đều nhận; tên rỗng thì lấy email.
	a, err := AddFound(path, home, filepath.Join(AccountsDir(home), "claude-8"), "")
	if err != nil || a.ID != "claude-8" || a.Label != "DUY@example.com" || a.ConfigDir != "~/.xdev-hive/accounts/claude-8" || !a.Enabled || a.StopAtWeek != DefaultStopAtWeek {
		t.Fatalf("thêm claude-8 = %+v, %v", a, err)
	}
	if a, err = AddFound(path, home, "~/.xdev-hive/accounts/work", "Công việc"); err != nil || a.ID != "claude-2" || a.Label != "Công việc" {
		t.Fatalf("thêm work = %+v, %v", a, err)
	}
	if a, err = AddFound(path, home, "default:antigravity", ""); err != nil || a.ID != "antigravity-1" || a.Label != "antigravity-1" || a.ConfigDir != "" {
		t.Fatalf("thêm agy = %+v, %v", a, err)
	}
	if a, err = AddFound(path, home, "default:claude", ""); err != nil || a.ID != "claude-4" || a.ConfigDir != "" {
		t.Fatalf("thêm claude mặc định = %+v, %v", a, err)
	}
	// Đã thêm, đã có từ trước, không tìm thấy hay thư mục rỗng: báo lỗi, không thêm.
	for _, source := range []string{"~/.xdev-hive/accounts/claude-8", "default:codex", "~/.xdev-hive/accounts/claude-3", "~/.xdev-hive/accounts/rong", "default:gemini", "", "~/khong-co"} {
		if _, err := AddFound(path, home, source, ""); err == nil {
			t.Fatalf("%q phải báo lỗi", source)
		}
	}
	if _, err := AddFound(path, home, "~/.xdev-hive/accounts/codex-2", strings.Repeat("x", 81)); err == nil {
		t.Fatal("tên quá dài phải báo lỗi")
	}
	list, _ := Load(path)
	if len(list) != 7 {
		t.Fatalf("danh sách = %d", len(list))
	}
	found, _ := Discover(path, home)
	if len(found) != 1 || found[0].SuggestedID != "codex-2" {
		t.Fatalf("còn lại = %+v", found)
	}
}
