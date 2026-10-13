package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// fakeAccountsHome đặt thư mục nhà, giờ và file cấu hình worker của lệnh accounts vào thư mục tạm, để test không đụng
// tài khoản thật của máy.
func fakeAccountsHome(t *testing.T) (home, config string) {
	t.Helper()
	home = t.TempDir()
	config = filepath.Join(t.TempDir(), "worker.json")
	oldHome, oldNow := accountsHome, accountsNow
	accountsHome = func() (string, error) { return home, nil }
	accountsNow = func() time.Time { return time.Date(2026, 10, 13, 3, 0, 0, 0, time.UTC) }
	t.Cleanup(func() { accountsHome, accountsNow = oldHome, oldNow })
	return home, config
}

func runAccounts(t *testing.T, config string, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := accountsCommand(append(args, "--config", config), &out, &errOut)
	return code, out.String(), errOut.String()
}

type listed struct {
	Accounts []struct {
		ID            string   `json:"id"`
		Label         string   `json:"label"`
		StopAtSession int      `json:"stopAtSession"`
		Roles         []string `json:"roles"`
		State         string   `json:"state"`
		Usage         struct {
			Reason *string `json:"reason"`
		} `json:"usage"`
	} `json:"accounts"`
}

func TestAccountsCommandAddUpdateRemove(t *testing.T) {
	home, config := fakeAccountsHome(t)

	code, out, errOut := runAccounts(t, config, "add", "--cli", "claude", "--label", "Duy", "--how", "sso", "--json")
	if code != 0 {
		t.Fatalf("add mã %d: %s", code, errOut)
	}
	var added struct {
		Account struct {
			ID        string `json:"id"`
			ConfigDir string `json:"configDir"`
		} `json:"account"`
		LoginCommand string            `json:"loginCommand"`
		Env          map[string]string `json:"env"`
	}
	if err := json.Unmarshal([]byte(out), &added); err != nil {
		t.Fatal(err)
	}
	if added.Account.ID != "claude-1" || added.Account.ConfigDir != "" || added.LoginCommand != "claude auth login --sso" || len(added.Env) != 0 {
		t.Fatalf("tài khoản đầu tiên dùng thư mục mặc định: %+v", added)
	}

	code, out, errOut = runAccounts(t, config, "add", "--cli", "claude", "--label", "Phụ", "--json")
	if code != 0 {
		t.Fatalf("add lần hai mã %d: %s", code, errOut)
	}
	if err := json.Unmarshal([]byte(out), &added); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(home, ".xdev-hive", "accounts", "claude-2")
	if added.Account.ID != "claude-2" || added.Env["CLAUDE_CONFIG_DIR"] != dir || added.LoginCommand != "claude auth login" {
		t.Fatalf("tài khoản sau có thư mục riêng: %+v", added)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("add phải tạo thư mục đăng nhập: %v", err)
	}

	if code, _, errOut = runAccounts(t, config, "update", "--id", "claude-2", "--stop-at-session", "150"); code != 1 || !strings.Contains(errOut, "ngưỡng dừng phiên") {
		t.Fatalf("ngưỡng ngoài khoảng phải báo lỗi: %d %q", code, errOut)
	}
	code, out, errOut = runAccounts(t, config, "update", "--id", "claude-2", "--label", "Phụ 2", "--stop-at-session", "80", "--roles", "plan,review", "--json")
	if code != 0 {
		t.Fatalf("update mã %d: %s", code, errOut)
	}
	var list listed
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatal(err)
	}
	got := list.Accounts[1]
	if got.Label != "Phụ 2" || got.StopAtSession != 80 || strings.Join(got.Roles, ",") != "plan,review" {
		t.Fatalf("update chưa đổi: %+v", got)
	}
	// Máy CI không cài claude thì trạng thái là noCli; máy dev có claude thì signedOut. Cả hai đều không có số quota.
	if got.State != "signedOut" && got.State != "noCli" {
		t.Fatalf("tài khoản chưa đăng nhập: %+v", got)
	}
	if got.State == "signedOut" && (got.Usage.Reason == nil || *got.Usage.Reason != "Chưa đăng nhập") {
		t.Fatalf("lý do khi chưa đăng nhập: %+v", got)
	}

	// Chưa đăng nhập: đọc quota không chạy CLI, chỉ ghi lý do.
	if code, _, errOut = runAccounts(t, config, "usage", "--id", "claude-2", "--json"); code != 0 {
		t.Fatalf("usage mã %d: %s", code, errOut)
	}
	if code, _, errOut = runAccounts(t, config, "resume", "--id", "claude-2", "--json"); code != 0 {
		t.Fatalf("resume mã %d: %s", code, errOut)
	}

	code, out, errOut = runAccounts(t, config, "remove", "--id", "claude-2", "--json")
	if code != 0 {
		t.Fatalf("remove mã %d: %s", code, errOut)
	}
	list = listed{}
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Accounts) != 1 || list.Accounts[0].ID != "claude-1" {
		t.Fatalf("remove phải bỏ claude-2: %+v", list)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Fatalf("remove không xoá thư mục đăng nhập: %v", err)
	}
	if code, _, _ = runAccounts(t, config, "remove", "--id", "claude-9"); code != 1 {
		t.Fatalf("xoá tài khoản không có phải lỗi, mã %d", code)
	}
}

func TestAccountsCommandRejectsBadInput(t *testing.T) {
	_, config := fakeAccountsHome(t)
	for _, c := range []struct {
		args []string
		code int
	}{
		{[]string{"add", "--cli", "claude"}, 2},
		{[]string{"add", "--cli", "gemini", "--label", "x"}, 1},
		{[]string{"add", "--cli", "codex", "--label", "x", "--email", "a@b.c"}, 1},
		{[]string{"update"}, 2},
		{[]string{"resume"}, 2},
		{[]string{"usage", "--id", "khong-co"}, 1},
		{[]string{"lam-gi"}, 2},
	} {
		if code, _, _ := runAccounts(t, config, c.args...); code != c.code {
			t.Errorf("%v: mã %d, muốn %d", c.args, code, c.code)
		}
	}
}

// discover in đăng nhập trên máy chưa có trong danh sách; --add thêm như add nhưng không trả lệnh đăng nhập.
func TestAccountsCommandDiscover(t *testing.T) {
	home, config := fakeAccountsHome(t)
	dir := filepath.Join(home, ".xdev-hive", "accounts", "claude-8")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte(`{"oauthAccount":{"emailAddress":"duy@example.com"}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	code, out, errOut := runAccounts(t, config, "discover", "--json")
	if code != 0 {
		t.Fatalf("discover mã %d: %s", code, errOut)
	}
	var found struct {
		Found []struct {
			CLI         string  `json:"cli"`
			ConfigDir   *string `json:"configDir"`
			LoggedIn    *bool   `json:"loggedIn"`
			Email       *string `json:"email"`
			SuggestedID string  `json:"suggestedId"`
		} `json:"found"`
	}
	if err := json.Unmarshal([]byte(out), &found); err != nil {
		t.Fatal(err)
	}
	if len(found.Found) != 1 || found.Found[0].SuggestedID != "claude-8" || *found.Found[0].ConfigDir != "~/.xdev-hive/accounts/claude-8" || !*found.Found[0].LoggedIn || *found.Found[0].Email != "duy@example.com" {
		t.Fatalf("found = %s", out)
	}
	if code, out, _ = runAccounts(t, config, "discover"); code != 0 || !strings.Contains(out, "claude-8") || !strings.Contains(out, "đã đăng nhập duy@example.com") {
		t.Fatalf("discover chữ: %d %q", code, out)
	}

	code, out, errOut = runAccounts(t, config, "discover", "--add", "~/.xdev-hive/accounts/claude-8", "--label", "Duy 8", "--json")
	if code != 0 {
		t.Fatalf("discover --add mã %d: %s", code, errOut)
	}
	var list listed
	if err := json.Unmarshal([]byte(out), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Accounts) != 1 || list.Accounts[0].ID != "claude-8" || list.Accounts[0].Label != "Duy 8" {
		t.Fatalf("sau --add = %s", out)
	}

	// Đã thêm thì không còn gì để tìm; JSON vẫn là mảng rỗng, không phải null.
	if code, out, _ = runAccounts(t, config, "discover", "--json"); code != 0 || strings.TrimSpace(out) != `{"found":[]}` {
		t.Fatalf("hết: %d %q", code, out)
	}
	if code, _, errOut = runAccounts(t, config, "discover", "--add", "default:codex"); code != 1 || !strings.Contains(errOut, "không tìm thấy") {
		t.Fatalf("không có đăng nhập: %d %q", code, errOut)
	}
}
