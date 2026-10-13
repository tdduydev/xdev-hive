package accounts

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const legacy = `{"runner":{"maxParallel":4},"agents":[
 {"id":"claude-3","label":"claude-3","kind":"claude","env":{"CLAUDE_CONFIG_DIR":"~/.xdev-hive/accounts/claude-3","ANTHROPIC_API_KEY":"sk-ant-bimat"},"enabled":true,"priority":30,"maxConcurrent":1,"cooldownMinutes":60},
 {"id":"codex-3","label":"duy@xdev.asia","kind":"codex","env":{"CODEX_HOME":"~/.xdev-hive/accounts/codex-3"},"enabled":false,"priority":5,"maxConcurrent":1},
 {"id":"antigravity-1","label":"anti","kind":"antigravity","env":{},"enabled":true,"priority":35}
]}`

func TestImportLegacyOnceWithoutSecrets(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "config.json")
	dst := filepath.Join(dir, "xdev-hive", "accounts.json")
	_ = os.WriteFile(src, []byte(legacy), 0o600)
	n, err := ImportLegacy(src, dst, false)
	if err != nil || n != 3 {
		t.Fatalf("import = %d, %v", n, err)
	}
	b, _ := os.ReadFile(dst)
	if strings.Contains(string(b), "sk-ant") || strings.Contains(string(b), "API_KEY") {
		t.Fatalf("biến môi trường khác của app v1 bị chép: %s", b)
	}
	if st, _ := os.Stat(dst); st.Mode().Perm() != 0o600 {
		t.Fatalf("quyền file = %v", st.Mode().Perm())
	}
	list, _ := Load(dst)
	if list[0].ConfigDir != "~/.xdev-hive/accounts/claude-3" || list[1].ConfigDir != "~/.xdev-hive/accounts/codex-3" || list[2].CLI != "antigravity" {
		t.Fatalf("list = %+v", list)
	}
	if n, _ := Capacity(dst, 8); n != 4 {
		t.Fatalf("maxParallel của app v1 = %d", n)
	}
	// Lần sau không nhập lại, để bật tắt trong app mới không bị app v1 ghi đè.
	_ = SetEnabled(dst, "codex-3", true)
	if n, _ := ImportLegacy(src, dst, false); n != 0 {
		t.Fatalf("nhập lại khi đã có accounts.json: %d", n)
	}
	list, _ = Load(dst)
	if !list[1].Enabled {
		t.Fatal("SetEnabled không giữ")
	}
	if err := SetEnabled(dst, "khong-co", true); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
	if n, _ := ImportLegacy(filepath.Join(dir, "khong-co.json"), filepath.Join(dir, "x.json"), false); n != 0 {
		t.Fatal("không có app v1 thì không nhập gì")
	}
}

func TestViewsReadLoginWithoutTokens(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".xdev-hive", "accounts", "claude-3")
	codexDir := filepath.Join(home, ".xdev-hive", "accounts", "codex-3")
	_ = os.MkdirAll(claudeDir, 0o700)
	_ = os.MkdirAll(codexDir, 0o700)
	_ = os.WriteFile(filepath.Join(claudeDir, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"duy@fpt.com"}}`), 0o600)
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"email":"duy@xdev.asia"}`))
	_ = os.WriteFile(filepath.Join(codexDir, "auth.json"), []byte(`{"tokens":{"id_token":"h.`+payload+`.s","access_token":"bimat"}}`), 0o600)
	views := Views([]Account{
		{ID: "claude-3", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-3"},
		{ID: "codex-3", CLI: "codex", ConfigDir: "~/.xdev-hive/accounts/codex-3"},
		{ID: "claude-9", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-9"},
		{ID: "antigravity-1", CLI: "antigravity"},
	}, home)
	if !*views[0].LoggedIn || views[0].Email != "duy@fpt.com" {
		t.Fatalf("claude = %+v", views[0])
	}
	if !*views[1].LoggedIn || views[1].Email != "duy@xdev.asia" {
		t.Fatalf("codex = %+v", views[1])
	}
	if *views[2].LoggedIn {
		t.Fatal("thư mục chưa đăng nhập")
	}
	if views[3].LoggedIn != nil || views[3].Supported {
		t.Fatalf("antigravity = %+v", views[3])
	}
}
