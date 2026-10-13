//go:build !windows

package accounts

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// loginClaudeScript giả `claude auth login` không có trình duyệt: in URL đăng nhập và lời nhắc dán mã bằng chuỗi điều khiển như
// CLI dựng bằng Ink, chờ mã trên PTY; mã đúng thì ghi oauthAccount. `auth status` thoát 0 khi đã có file đó.
const loginClaudeScript = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then
  [ -f "$CLAUDE_CONFIG_DIR/.claude.json" ] && exit 0
  exit 1
fi
[ "$1" = auth ] && [ "$2" = login ] || exit 9
[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && exit 8
printf '\033[2mBrowser did not open? Use the url below to sign in\033[0m\r\n\r\n'
printf '\033]8;;https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\007https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\033]8;;\007\r\n\r\n'
printf 'Paste\033[1Ccode\033[1Chere\033[1Cif\033[1Cprompted\033[1C>\033[1C'
read code
if [ "$code" = "good-code" ]; then
  echo '{"oauthAccount":{"emailAddress":"a@example.com"}}' > "$CLAUDE_CONFIG_DIR/.claude.json"
  echo "Login successful."
  exit 0
fi
echo "OAuth error: invalid code"
exit 1
`

// loginCodexScript giả `codex login --device-auth`: in URL và mã thiết bị rồi chờ tới khi test tạo file $FAKE_APPROVED (người
// dùng duyệt trên trình duyệt), ghi auth.json rồi thoát.
const loginCodexScript = `#!/bin/sh
[ "$1" = login ] && [ "$2" = --device-auth ] || exit 9
printf 'Follow these steps to sign in with ChatGPT using device code authorization:\n\n'
printf '1. Open this link in your browser and sign in to your account\n   \033[94mhttps://auth.openai.com/codex/device\033[0m\n\n'
printf '2. Enter this one-time code \033[90m(expires in 15 minutes)\033[0m\n   \033[94mWXYZ-12345\033[0m\n\n'
i=0
while [ ! -f "$FAKE_APPROVED" ]; do
  i=$((i+1))
  [ $i -gt 200 ] && exit 1
  sleep 0.05
done
echo '{"OPENAI_API_KEY":"sk-test"}' > "$CODEX_HOME/auth.json"
echo "Successfully logged in"
`

type loginRecorder struct {
	mu     sync.Mutex
	events []loginStep
	ch     chan loginStep
}

type loginStep struct{ kind, text, accountID string }

func newRecorder() *loginRecorder { return &loginRecorder{ch: make(chan loginStep, 32)} }

func (r *loginRecorder) emit(kind, text, accountID string) {
	r.mu.Lock()
	r.events = append(r.events, loginStep{kind, text, accountID})
	r.mu.Unlock()
	r.ch <- loginStep{kind, text, accountID}
}

// next chờ bước kế có loại kind, bỏ qua các bước khác.
func (r *loginRecorder) next(t *testing.T, kind string) loginStep {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		select {
		case s := <-r.ch:
			if s.kind == kind {
				return s
			}
			if s.kind == LoginError || s.kind == LoginDone {
				t.Fatalf("chờ %s, nhận %+v", kind, s)
			}
		case <-deadline:
			t.Fatalf("không nhận bước %s", kind)
		}
	}
}

func newTestLogin(t *testing.T, scripts map[string]string) *Login {
	t.Helper()
	bin := t.TempDir()
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(body), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	l := NewLogin(filepath.Join(t.TempDir(), "accounts.json"), t.TempDir())
	l.lookup = func(name string) (string, error) {
		p := filepath.Join(bin, name)
		if _, err := os.Stat(p); err != nil {
			return "", err
		}
		return p, nil
	}
	// Token của dịch vụ worker không được lọt vào lệnh đăng nhập (loginClaudeScript thoát 8 nếu thấy).
	t.Setenv(tokenEnv, "sk-ant-oat01-cua-dich-vu")
	return l
}

// idle chờ phiên hiện tại nhả chỗ (bước cuối đã gửi hoặc huỷ xong).
func idle(t *testing.T, l *Login) {
	t.Helper()
	for range 200 {
		l.mu.Lock()
		cur := l.cur
		l.mu.Unlock()
		if cur == nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("phiên đăng nhập không kết thúc")
}

func TestLoginClaudePastesCode(t *testing.T) {
	l := newTestLogin(t, map[string]string{"claude": loginClaudeScript})
	rec := newRecorder()
	l.Start(context.Background(), "r1", "claude", "Gói Max", "plan", rec.emit)
	url := rec.next(t, LoginURL)
	if url.text != "https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz" {
		t.Fatalf("url = %q", url.text)
	}
	if p := rec.next(t, LoginPrompt); p.text != msgPasteCode {
		t.Fatalf("prompt = %q", p.text)
	}
	// Phiên khác không nhận được chữ dán.
	if l.Input("khac", "good-code") {
		t.Fatal("Input nhận requestId lạ")
	}
	// Ký tự điều khiển (Ctrl-C, Ctrl-D) trong chữ dán bị bỏ, không thì CLI bị ngắt.
	if !l.Input("r1", "\x03good-code\x04") {
		t.Fatal("Input không nhận")
	}
	done := rec.next(t, LoginDone)
	if done.accountID != "claude-1" {
		t.Fatalf("accountId = %q", done.accountID)
	}
	idle(t, l)
	list, _ := Load(l.path)
	if len(list) != 1 || list[0].Pending || !list[0].Enabled || list[0].Label != "Gói Max" || list[0].ConfigDir != "~/.xdev-hive/accounts/claude-1" {
		t.Fatalf("accounts = %+v", list)
	}
	st, err := os.Stat(filepath.Join(AccountsDir(l.home), "claude-1"))
	if err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("thư mục gói: %v %v", st, err)
	}
	// Không bước nào chép output thô của CLI.
	for _, e := range rec.events {
		if strings.Contains(e.text, "Login successful") || strings.Contains(e.text, "Browser") || strings.Contains(e.text, "good-code") {
			t.Fatalf("bước lộ output CLI: %+v", e)
		}
	}
}

func TestLoginClaudeWrongCodeCleansUp(t *testing.T) {
	l := newTestLogin(t, map[string]string{"claude": loginClaudeScript})
	rec := newRecorder()
	l.Start(context.Background(), "r1", "claude", "Gói", "plan", rec.emit)
	rec.next(t, LoginPrompt)
	l.Input("r1", "bad-code")
	if e := rec.next(t, LoginError); e.text != msgFailed {
		t.Fatalf("error = %q", e.text)
	}
	idle(t, l)
	if list, _ := Load(l.path); len(list) != 0 {
		t.Fatalf("còn gói dở: %+v", list)
	}
	if _, err := os.Stat(filepath.Join(AccountsDir(l.home), "claude-1")); !os.IsNotExist(err) {
		t.Fatalf("còn thư mục gói dở: %v", err)
	}
}

func TestLoginCodexDeviceCode(t *testing.T) {
	l := newTestLogin(t, map[string]string{"codex": loginCodexScript})
	approved := filepath.Join(t.TempDir(), "approved")
	t.Setenv("FAKE_APPROVED", approved)
	rec := newRecorder()
	l.Start(context.Background(), "r2", "codex", "Codex Pro", "device", rec.emit)
	if u := rec.next(t, LoginURL); u.text != "https://auth.openai.com/codex/device" {
		t.Fatalf("url = %q", u.text)
	}
	if c := rec.next(t, LoginCode); c.text != "WXYZ-12345" {
		t.Fatalf("code = %q", c.text)
	}
	_ = os.WriteFile(approved, nil, 0o600)
	if d := rec.next(t, LoginDone); d.accountID != "codex-1" {
		t.Fatalf("done = %+v", d)
	}
	idle(t, l)
	sum, _ := Summaries(l.path, l.home, t0)
	if len(sum) != 1 || sum[0].LoggedIn == nil || !*sum[0].LoggedIn || !sum[0].Enabled {
		t.Fatalf("summary = %+v", sum)
	}
}

func TestLoginCancelRemovesPendingAccount(t *testing.T) {
	l := newTestLogin(t, map[string]string{"claude": loginClaudeScript})
	rec := newRecorder()
	l.Start(context.Background(), "r1", "claude", "Gói", "plan", rec.emit)
	rec.next(t, LoginPrompt)
	// Trong lúc chờ: tài khoản dở có trong file nhưng không có trong tóm tắt hay pool.
	if list, _ := Load(l.path); len(list) != 1 || !list[0].Pending {
		t.Fatalf("accounts = %+v", list)
	}
	if sum, _ := Summaries(l.path, l.home, t0); len(sum) != 0 {
		t.Fatalf("tóm tắt có gói dở: %+v", sum)
	}
	// Mỗi máy một phiên.
	busy := newRecorder()
	l.Start(context.Background(), "r9", "codex", "Khác", "device", busy.emit)
	if e := busy.next(t, LoginError); e.text != msgBusy {
		t.Fatalf("busy = %q", e.text)
	}
	if l.Cancel("khac") {
		t.Fatal("huỷ nhầm phiên")
	}
	if !l.Cancel("r1") {
		t.Fatal("không huỷ được")
	}
	idle(t, l)
	if list, _ := Load(l.path); len(list) != 0 {
		t.Fatalf("còn gói dở: %+v", list)
	}
	if _, err := os.Stat(filepath.Join(AccountsDir(l.home), "claude-1")); !os.IsNotExist(err) {
		t.Fatalf("còn thư mục: %v", err)
	}
	// Huỷ thì hub đã biết, worker không báo bước cuối.
	for _, e := range rec.events {
		if e.kind == LoginDone || e.kind == LoginError {
			t.Fatalf("bước sau khi huỷ: %+v", e)
		}
	}
}

func TestLoginTimeout(t *testing.T) {
	l := newTestLogin(t, map[string]string{"claude": loginClaudeScript})
	l.timeout = 500 * time.Millisecond
	rec := newRecorder()
	l.Start(context.Background(), "r1", "claude", "Gói", "sso", rec.emit)
	if e := rec.next(t, LoginError); e.text != msgTimeout {
		t.Fatalf("error = %q", e.text)
	}
	idle(t, l)
	if list, _ := Load(l.path); len(list) != 0 {
		t.Fatalf("còn gói dở: %+v", list)
	}
}

func TestLoginTokenFlow(t *testing.T) {
	l := newTestLogin(t, nil)
	rec := newRecorder()
	l.Start(context.Background(), "r1", "claude", "Token", "token", rec.emit)
	if p := rec.next(t, LoginPrompt); p.text != msgPasteToken {
		t.Fatalf("prompt = %q", p.text)
	}
	l.Input("r1", "https://claude.ai/nham")
	if p := rec.next(t, LoginPrompt); !strings.HasPrefix(p.text, "Token không hợp lệ") || strings.Contains(p.text, "nham") {
		t.Fatalf("prompt = %q", p.text)
	}
	l.Input("r1", " sk-ant-oat01-abc \n")
	rec.next(t, LoginDone)
	idle(t, l)
	b, err := os.ReadFile(filepath.Join(AccountsDir(l.home), "claude-1", tokenFile))
	if err != nil || string(b) != "sk-ant-oat01-abc" {
		t.Fatalf("token file = %q, %v", b, err)
	}
}

func TestLoginRejectsBadRequest(t *testing.T) {
	l := newTestLogin(t, nil)
	for name, c := range map[string][3]string{
		"cli lạ":             {"gemini", "Gói", "plan"},
		"codex theo gói":     {"codex", "Gói", "plan"},
		"claude thiết bị":    {"claude", "Gói", "device"},
		"nhãn rỗng":          {"claude", "  ", "plan"},
		"chưa cài claude":    {"claude", "Gói", "plan"},
		"chưa cài codex cli": {"codex", "Gói", "device"},
	} {
		rec := newRecorder()
		l.Start(context.Background(), "r", c[0], c[1], c[2], rec.emit)
		rec.next(t, LoginError)
		idle(t, l)
		if list, _ := Load(l.path); len(list) != 0 {
			t.Fatalf("%s: còn gói: %+v", name, list)
		}
	}
}

func TestCleanupPending(t *testing.T) {
	home := t.TempDir()
	path := filepath.Join(t.TempDir(), "accounts.json")
	dir := filepath.Join(AccountsDir(home), "claude-2")
	_ = os.MkdirAll(dir, 0o700)
	// ConfigDir của tài khoản dở trỏ ra ngoài thư mục gói (file bị sửa tay) thì không xoá thư mục đó.
	outside := t.TempDir()
	_ = Save(path, 0, []Account{
		{ID: "claude-1", CLI: "claude", Enabled: true},
		{ID: "claude-2", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-2", Pending: true},
		{ID: "claude-3", CLI: "claude", ConfigDir: outside, Pending: true},
	})
	n, err := CleanupPending(path, home)
	if err != nil || n != 2 {
		t.Fatalf("n = %d, %v", n, err)
	}
	if list, _ := Load(path); len(list) != 1 || list[0].ID != "claude-1" {
		t.Fatalf("accounts = %+v", list)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("chưa xoá thư mục gói dở")
	}
	if _, err := os.Stat(outside); err != nil {
		t.Fatal("xoá nhầm thư mục ngoài ~/.xdev-hive/accounts")
	}
	if n, err := CleanupPending(path, home); err != nil || n != 0 {
		t.Fatalf("lần hai: %d, %v", n, err)
	}
}

func TestLoginScanner(t *testing.T) {
	var got []loginStep
	s := &loginScanner{cli: "codex", send: func(kind, text string) { got = append(got, loginStep{kind: kind, text: text}) }}
	// URL tới làm hai mảnh: chưa báo tới khi có ký tự kết thúc URL. Tham số trong URL không bị nhận nhầm là mã.
	s.feed([]byte("Open https://auth.openai.com/device?code=ABCD-EFGH"))
	if len(got) != 0 {
		t.Fatalf("báo URL dở: %+v", got)
	}
	s.feed([]byte("&x=1).\r\nEnter this one-time code: \x1b[94mQRST-6789\x1b[0m\r\n"))
	s.feed([]byte("https://khac.example.com \r\nPaste code here\r\n"))
	want := []loginStep{
		{kind: LoginURL, text: "https://auth.openai.com/device?code=ABCD-EFGH&x=1"},
		{kind: LoginCode, text: "QRST-6789"},
		{kind: LoginPrompt, text: msgPasteCode},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("bước %d = %+v, muốn %+v", i, got[i], want[i])
		}
	}
}
