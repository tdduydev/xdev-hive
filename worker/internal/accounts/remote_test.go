package accounts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplySetRefusesPending(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.json")
	_ = Save(path, 0, []Account{{ID: "claude-1", CLI: "claude", Enabled: true}, {ID: "claude-2", CLI: "claude", Pending: true}})
	if err := ApplySet(path, "claude-1", false); err != nil {
		t.Fatal(err)
	}
	if list, _ := Load(path); list[0].Enabled {
		t.Fatal("chưa tắt")
	}
	if err := ApplySet(path, "claude-2", true); err == nil {
		t.Fatal("tài khoản đang đăng nhập dở không được bật")
	}
	if err := ApplySet(path, "khong-co", true); err == nil {
		t.Fatal("tài khoản lạ phải báo lỗi")
	}
}

func TestCheckToken(t *testing.T) {
	good := "sk-ant-oat01-abcDEF_123"
	if got, err := CheckToken("  " + good + "\n"); err != nil || got != good {
		t.Fatalf("got %q, %v", got, err)
	}
	for name, in := range map[string]string{
		"rỗng":         "",
		"sai tiền tố":  "https://claude.ai/oauth",
		"có khoảng":    good + " " + good,
		"nhiều dòng":   good + "\n" + good,
		"quá dài":      good + strings.Repeat("a", 4100),
		"chỉ khoảng":   "   ",
		"mã xác nhận ": "abc#def",
	} {
		_, err := CheckToken(in)
		if err == nil {
			t.Errorf("%s: phải bị từ chối", name)
		} else if strings.Contains(err.Error(), in) && in != "" {
			t.Errorf("%s: lỗi lộ nội dung dán: %v", name, err)
		}
	}
}

func TestTokenFileLoginAndLeaseEnv(t *testing.T) {
	noCLIs(t)
	p := pool(t, `{"accounts":[{"id":"claude-7","label":"Token","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-7","enabled":true}]}`)
	dir := filepath.Join(p.home, ".xdev-hive", "accounts", "claude-7")
	_ = os.MkdirAll(dir, 0o700)
	if _, err := p.Acquire("claude", RoleImplement); err == nil || !strings.Contains(err.Error(), "chưa đăng nhập") {
		t.Fatalf("chưa có token thì chưa đăng nhập: %v", err)
	}
	token := "sk-ant-oat01-abc"
	if err := WriteToken(dir, token); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(filepath.Join(dir, tokenFile))
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("quyền %v", st.Mode().Perm())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("file tạm còn sót: %v", entries)
	}
	lease, err := p.Acquire("claude", RoleImplement)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Release()
	env := lease.Env()
	if env["CLAUDE_CODE_OAUTH_TOKEN"] != token || env["CLAUDE_CONFIG_DIR"] != dir {
		t.Fatalf("env = %v", env)
	}
	// Token chỉ có ở môi trường của CLI, không ở bản tóm tắt gửi hub.
	sum, _ := Summaries(p.path, p.home, t0)
	if len(sum) != 1 || sum[0].LoggedIn == nil || !*sum[0].LoggedIn {
		t.Fatalf("summary = %+v", sum)
	}
}
