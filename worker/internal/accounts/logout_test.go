package accounts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

type logoutCall struct {
	name string
	args []string
	env  []string
}

// fakeLogout thay lệnh ngoài và hệ điều hành; err là kết quả mọi lệnh giả trả về.
func fakeLogout(t *testing.T, goos string, err error, out string) *[]logoutCall {
	t.Helper()
	savedGOOS, savedRun := logoutGOOS, runLogout
	t.Cleanup(func() { logoutGOOS, runLogout = savedGOOS, savedRun })
	logoutGOOS = goos
	var calls []logoutCall
	runLogout = func(_ context.Context, name string, args, env []string) ([]byte, error) {
		calls = append(calls, logoutCall{name, args, env})
		return []byte(out), err
	}
	return &calls
}

// logoutHome đặt HOME giả (cả USERPROFILE cho Windows) và accounts.json có hai gói Claude, một gói Codex.
func logoutHome(t *testing.T) (home, accountsFile string) {
	t.Helper()
	home = t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	accountsFile = filepath.Join(t.TempDir(), "accounts.json")
	body, _ := json.Marshal(file{Accounts: []Account{
		{ID: "claude-1", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-1", Enabled: true},
		{ID: "claude-2", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-2", Enabled: true},
		{ID: "claude-def", CLI: "claude", Enabled: true},
		{ID: "codex-1", CLI: "codex", ConfigDir: "~/.xdev-hive/accounts/codex-1", Enabled: true},
		{ID: "antigravity-1", CLI: "antigravity", Enabled: true},
	}})
	if err := os.WriteFile(accountsFile, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return home, accountsFile
}

func writeClaudeLogin(t *testing.T, dir, email string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := `{"numStartups":7,"projects":{"/x":{"allowedTools":[]}},"oauthAccount":{"emailAddress":"` + email + `"},"theme":"dark"}`
	for name, body := range map[string]string{".claude.json": cfg, ".credentials.json": `{"claudeAiOauth":{"accessToken":"bimat"}}`} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func loggedIn(t *testing.T, a Account, home string) bool {
	t.Helper()
	ok, _ := loginOf(a, home)
	return ok != nil && *ok
}

func TestLogoutClaudeOnlyThatAccountDir(t *testing.T) {
	home, path := logoutHome(t)
	dir1 := filepath.Join(home, ".xdev-hive", "accounts", "claude-1")
	dir2 := filepath.Join(home, ".xdev-hive", "accounts", "claude-2")
	writeClaudeLogin(t, dir1, "a@example.com")
	writeClaudeLogin(t, dir2, "b@example.com")
	if err := WriteToken(dir1, "sk-ant-oat-bimat"); err != nil {
		t.Fatal(err)
	}
	// Quota đã đọc của gói bị xoá, của gói khác giữ.
	if err := UpdateState(StatePath(path), t0, func(s *State) {
		s.Usage["claude-1"] = Usage{Session: &Limit{Percent: 10}}
		s.Usage["claude-2"] = Usage{Session: &Limit{Percent: 20}}
	}); err != nil {
		t.Fatal(err)
	}
	// Linux: không đụng keychain.
	calls := fakeLogout(t, "linux", nil, "")

	if err := Logout(path, home, "claude-1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("linux không được gọi lệnh ngoài: %+v", *calls)
	}
	list, _ := Load(path)
	if loggedIn(t, list[0], home) {
		t.Fatal("claude-1 vẫn đăng nhập")
	}
	if !loggedIn(t, list[1], home) {
		t.Fatal("claude-2 bị đăng xuất theo")
	}
	for _, name := range []string{".credentials.json", tokenFile} {
		if exists(filepath.Join(dir1, name)) {
			t.Fatalf("claude-1 còn %s", name)
		}
	}
	if !exists(filepath.Join(dir2, ".credentials.json")) {
		t.Fatal("claude-2 mất .credentials.json")
	}
	var kept map[string]json.RawMessage
	b, _ := os.ReadFile(filepath.Join(dir1, ".claude.json"))
	if err := json.Unmarshal(b, &kept); err != nil {
		t.Fatal(err)
	}
	if _, has := kept["oauthAccount"]; has || len(kept) != 3 || string(kept["theme"]) != `"dark"` || string(kept["numStartups"]) != "7" {
		t.Fatalf(".claude.json sau đăng xuất = %s", b)
	}
	b2, _ := os.ReadFile(filepath.Join(dir2, ".claude.json"))
	if !strings.Contains(string(b2), "b@example.com") {
		t.Fatalf("claude-2 mất oauthAccount: %s", b2)
	}
	st, _ := LoadState(StatePath(path))
	if _, has := st.Usage["claude-1"]; has {
		t.Fatal("quota cũ của claude-1 còn")
	}
	if _, has := st.Usage["claude-2"]; !has {
		t.Fatal("quota của claude-2 bị xoá")
	}
	// Đăng xuất lần nữa khi đã sạch không lỗi.
	if err := Logout(path, home, "claude-1"); err != nil {
		t.Fatal(err)
	}
}

func TestLogoutClaudeDeletesKeychainOfThatDirOnMac(t *testing.T) {
	home, path := logoutHome(t)
	dir := filepath.Join(home, ".xdev-hive", "accounts", "claude-2")
	writeClaudeLogin(t, dir, "b@example.com")
	calls := fakeLogout(t, "darwin", nil, "")

	if err := Logout(path, home, "claude-2"); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(dir))
	want := "Claude Code-credentials-" + hex.EncodeToString(sum[:])[:8]
	if len(*calls) != 1 || (*calls)[0].name != "security" || !slices.Equal((*calls)[0].args, []string{"delete-generic-password", "-s", want}) {
		t.Fatalf("lệnh = %+v, muốn security delete-generic-password -s %q", *calls, want)
	}
}

func TestLogoutClaudeDefaultLoginUsesDefaultService(t *testing.T) {
	home, path := logoutHome(t)
	if err := os.MkdirAll(filepath.Join(home, ".claude"), 0o700); err != nil {
		t.Fatal(err)
	}
	// Đăng nhập mặc định: ~/.claude.json và ~/.claude/.credentials.json; thư mục gói khác không đụng.
	writeClaudeLogin(t, filepath.Join(home, ".claude"), "x@example.com")
	if err := os.Rename(filepath.Join(home, ".claude", ".claude.json"), filepath.Join(home, ".claude.json")); err != nil {
		t.Fatal(err)
	}
	other := filepath.Join(home, ".xdev-hive", "accounts", "claude-1")
	writeClaudeLogin(t, other, "a@example.com")
	calls := fakeLogout(t, "darwin", nil, "")

	if err := Logout(path, home, "claude-def"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].args[2] != "Claude Code-credentials" {
		t.Fatalf("lệnh = %+v", *calls)
	}
	list, _ := Load(path)
	if loggedIn(t, list[2], home) || !loggedIn(t, list[0], home) {
		t.Fatal("chỉ gói mặc định được đăng xuất")
	}
	if exists(filepath.Join(home, ".claude", ".credentials.json")) || !exists(filepath.Join(other, ".credentials.json")) {
		t.Fatal("file đăng nhập bị xoá sai chỗ")
	}
}

func TestLogoutKeychainErrors(t *testing.T) {
	home, path := logoutHome(t)
	dir := filepath.Join(home, ".xdev-hive", "accounts", "claude-1")
	writeClaudeLogin(t, dir, "a@example.com")

	// Mục không có (security báo không tìm thấy) hay máy không có security: coi như đã xoá.
	fakeLogout(t, "darwin", errors.New("exit status 44"), "The specified item could not be found in the keychain.")
	if err := Logout(path, home, "claude-1"); err != nil {
		t.Fatal(err)
	}
	writeClaudeLogin(t, dir, "a@example.com")
	fakeLogout(t, "darwin", exec.ErrNotFound, "")
	if err := Logout(path, home, "claude-1"); err != nil {
		t.Fatal(err)
	}

	// Lỗi thật: báo lỗi và chưa đổi gì.
	writeClaudeLogin(t, dir, "a@example.com")
	fakeLogout(t, "darwin", errors.New("exit status 1"), "denied")
	if err := Logout(path, home, "claude-1"); err == nil {
		t.Fatal("lỗi keychain phải báo ra")
	}
	list, _ := Load(path)
	if !loggedIn(t, list[0], home) {
		t.Fatal("lỗi keychain mà vẫn xoá file")
	}
}

func TestClaudeKeychainServiceName(t *testing.T) {
	if got := claudeKeychainService(""); got != "Claude Code-credentials" {
		t.Fatal(got)
	}
	// sha256("/Users/test/.xdev-hive/accounts/claude-1") bắt đầu bằng a9f51c4c.
	if got := claudeKeychainService("/Users/test/.xdev-hive/accounts/claude-1"); got != "Claude Code-credentials-a9f51c4c" {
		t.Fatal(got)
	}
}

func TestLogoutCodexRunsWithThatHomeAndNoInheritedLogin(t *testing.T) {
	home, path := logoutHome(t)
	dir := filepath.Join(home, ".xdev-hive", "accounts", "codex-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"OPENAI_API_KEY":"sk-bimat"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "sk-ke-thua")
	t.Setenv("CODEX_API_KEY", "sk-ke-thua")
	t.Setenv("CODEX_HOME", "/gói/khác")
	t.Setenv("XDEV_GIU_LAI", "co")
	noCLIs(t)
	calls := fakeLogout(t, "linux", nil, "")

	if err := Logout(path, home, "codex-1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].name != "/usr/local/bin/codex" || !slices.Equal((*calls)[0].args, []string{"logout"}) {
		t.Fatalf("lệnh = %+v", *calls)
	}
	env := (*calls)[0].env
	var homes []string
	for _, kv := range env {
		name, val, _ := strings.Cut(kv, "=")
		switch name {
		case "OPENAI_API_KEY", "CODEX_API_KEY":
			t.Fatalf("env kế thừa %s", name)
		case "CODEX_HOME":
			homes = append(homes, val)
		}
	}
	if !slices.Equal(homes, []string{dir}) {
		t.Fatalf("CODEX_HOME = %v, muốn %s", homes, dir)
	}
	if !slices.Contains(env, "XDEV_GIU_LAI=co") {
		t.Fatal("env khác bị mất")
	}
	list, _ := Load(path)
	if loggedIn(t, list[3], home) {
		t.Fatal("codex-1 vẫn đăng nhập")
	}
}

func TestLogoutCodexWithoutBinaryRemovesAuthJSON(t *testing.T) {
	home, path := logoutHome(t)
	dir := filepath.Join(home, ".xdev-hive", "accounts", "codex-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"OPENAI_API_KEY":"sk-bimat"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte("model = \"x\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	noCLIs(t, "codex")
	calls := fakeLogout(t, "linux", nil, "")

	if err := Logout(path, home, "codex-1"); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 || exists(filepath.Join(dir, "auth.json")) || !exists(filepath.Join(dir, "config.toml")) {
		t.Fatalf("calls=%+v", *calls)
	}
}

func TestLogoutCodexFailureIsReported(t *testing.T) {
	home, path := logoutHome(t)
	noCLIs(t)
	fakeLogout(t, "linux", errors.New("exit status 1"), "lỗi keyring")
	err := Logout(path, home, "codex-1")
	if err == nil || !strings.Contains(err.Error(), "lỗi keyring") {
		t.Fatalf("err = %v", err)
	}
}

func TestLogoutUnsupportedAndUnknown(t *testing.T) {
	home, path := logoutHome(t)
	calls := fakeLogout(t, "darwin", nil, "")
	if err := Logout(path, home, "antigravity-1"); err == nil || err.Error() != "Chưa hỗ trợ đăng xuất cho CLI này." {
		t.Fatalf("err = %v", err)
	}
	if err := Logout(path, home, "khong-co"); err == nil || err.Error() != `không có tài khoản "khong-co"` {
		t.Fatalf("err = %v", err)
	}
	if len(*calls) != 0 {
		t.Fatalf("không được chạy lệnh nào: %+v", *calls)
	}
}
