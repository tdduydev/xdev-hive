package accounts

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"

	"golang.org/x/text/unicode/norm"
)

// Test thay hệ điều hành và lệnh ngoài (security, codex) để không chạm keychain hay CLI thật.
var (
	logoutGOOS = runtime.GOOS
	runLogout  = func(ctx context.Context, name string, args, env []string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		// Ngoài mọi repo, không stdin: lệnh đăng xuất không được nạp cấu hình dự án hay chờ người gõ.
		cmd.Dir = os.TempDir()
		cmd.Env = env
		return cmd.CombinedOutput()
	}
)

// logoutTimeout chặn mỗi lệnh ngoài: CLI treo không được giữ lệnh của app.
const logoutTimeout = 30 * time.Second

// ErrLogoutUnsupported: CLI này worker không biết cách đăng xuất (Antigravity giữ đăng nhập trong keyring chung của máy,
// không tách theo gói được).
var ErrLogoutUnsupported = errors.New("Chưa hỗ trợ đăng xuất cho CLI này.")

// codexKeyVars là khoá API Codex đọc từ môi trường; bỏ khỏi env của `codex logout` để lệnh chỉ thấy đăng nhập trong
// CODEX_HOME của gói, không thấy khoá kế thừa từ shell của người khác (cùng lý do với loginVars, #331).
var codexKeyVars = []string{"OPENAI_API_KEY", "CODEX_API_KEY"}

// keychainBase là tên dịch vụ keychain Claude Code dùng cho đăng nhập mặc định (không đặt CLAUDE_CONFIG_DIR).
const keychainBase = "Claude Code-credentials"

// claudeKeychainService là tên mục keychain macOS giữ đăng nhập Claude của thư mục cấu hình dir: đăng nhập mặc định (dir
// rỗng) dùng tên gốc; thư mục riêng thêm "-" và 8 ký tự hex đầu của SHA-256 đường dẫn, nên mỗi gói một mục. Claude Code
// băm giá trị CLAUDE_CONFIG_DIR đã chuẩn hoá NFC, đúng chuỗi ta đặt vào env khi chạy gói, nên băm chính chuỗi đó.
func claudeKeychainService(dir string) string {
	if dir == "" {
		return keychainBase
	}
	sum := sha256.Sum256([]byte(norm.NFC.String(dir)))
	return keychainBase + "-" + hex.EncodeToString(sum[:])[:8]
}

// Logout đăng xuất đúng một gói: chỉ đụng thư mục cấu hình (và mục keychain) của gói đó, không bao giờ của gói khác.
// accounts.json giữ nguyên (gói vẫn còn trong danh sách, chỉ chưa đăng nhập) và quota đã đọc của gói bị bỏ vì thuộc về
// danh tính cũ.
func Logout(path, home, id string) error {
	list, err := Load(path)
	if err != nil {
		return err
	}
	i := slices.IndexFunc(list, func(a Account) bool { return a.ID == id })
	if i < 0 {
		return fmt.Errorf("không có tài khoản %q", id)
	}
	a := list[i]
	dir := expandHome(home, a.ConfigDir)
	ctx, cancel := context.WithTimeout(context.Background(), logoutTimeout)
	defer cancel()
	switch a.CLI {
	case "claude":
		err = logoutClaude(ctx, home, dir)
	case "codex":
		err = logoutCodex(ctx, home, dir)
	default:
		return ErrLogoutUnsupported
	}
	if err != nil {
		return err
	}
	statePath := StatePath(path)
	if !exists(statePath) {
		return nil
	}
	return UpdateState(statePath, time.Now(), func(s *State) { delete(s.Usage, id) })
}

// logoutClaude xoá đăng nhập Claude của thư mục dir (rỗng là đăng nhập mặc định). `claude /logout` là lệnh trong phiên
// tương tác, không chạy không người ngồi được, nên xoá đúng chỗ CLI giữ đăng nhập.
func logoutClaude(ctx context.Context, home, dir string) error {
	configJSON := filepath.Join(home, ".claude.json")
	credDir := filepath.Join(home, ".claude")
	if dir != "" {
		configJSON, credDir = filepath.Join(dir, ".claude.json"), dir
	}
	// Keychain trước: lỗi thật ở đây thì chưa đổi gì, thử lại được; xoá file trước rồi mới lỗi sẽ để gói nửa đăng nhập.
	if logoutGOOS == "darwin" {
		if err := deleteKeychain(ctx, claudeKeychainService(dir)); err != nil {
			return err
		}
	}
	if err := removeFile(filepath.Join(credDir, ".credentials.json")); err != nil {
		return err
	}
	// Token `claude setup-token` của gói (remote.go): loginOf coi file này là đã đăng nhập.
	if dir != "" {
		if err := removeFile(filepath.Join(dir, tokenFile)); err != nil {
			return err
		}
	}
	return dropOAuthAccount(configJSON)
}

// deleteKeychain xoá mục keychain theo tên dịch vụ; mục không có (đã đăng xuất, hoặc Claude ghi vào file) không là lỗi.
func deleteKeychain(ctx context.Context, service string) error {
	out, err := runLogout(ctx, "security", []string{"delete-generic-password", "-s", service}, os.Environ())
	if err == nil || errors.Is(err, exec.ErrNotFound) {
		return nil
	}
	// security thoát 44 khi mục không có (errSecItemNotFound).
	var exit *exec.ExitError
	if (errors.As(err, &exit) && exit.ExitCode() == 44) || strings.Contains(string(out), "could not be found") {
		return nil
	}
	return fmt.Errorf("không xoá được đăng nhập Claude trong keychain: %w", err)
}

func removeFile(path string) error {
	err := retryTransient(func() error { return os.Remove(path) })
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("không xoá được %s: %w", path, err)
	}
	return nil
}

// dropOAuthAccount bỏ đúng khoá oauthAccount khỏi file cấu hình của Claude; các khoá khác (lịch sử, dự án, cài đặt) giữ
// nguyên giá trị. File không có, không đọc được hay không có khoá đó thì không ghi gì.
func dropOAuthAccount(path string) error {
	b, err := readFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	var doc map[string]json.RawMessage
	if json.Unmarshal(b, &doc) != nil {
		return nil
	}
	if _, ok := doc["oauthAccount"]; !ok {
		return nil
	}
	delete(doc, "oauthAccount")
	return writeJSON(path, doc)
}

// logoutCodex chạy `codex logout` với CODEX_HOME của gói. Máy không có codex thì xoá auth.json, nơi Codex giữ đăng nhập.
func logoutCodex(ctx context.Context, home, dir string) error {
	if dir == "" {
		dir = filepath.Join(home, ".codex")
	}
	auth := filepath.Join(dir, "auth.json")
	bin, err := lookPath("codex")
	if err != nil {
		return removeFile(auth)
	}
	env := WithoutLogin(os.Environ(), "codex")
	env = slices.DeleteFunc(env, func(kv string) bool {
		name, _, _ := strings.Cut(kv, "=")
		return slices.Contains(codexKeyVars, name)
	})
	env = append(env, envVar["codex"]+"="+dir)
	if out, err := runLogout(ctx, bin, []string{"logout"}, env); err != nil {
		msg := string(bytes.TrimSpace(out))
		if len(msg) > 300 {
			msg = msg[:300]
		}
		if msg != "" {
			return fmt.Errorf("codex logout lỗi: %w: %s", err, msg)
		}
		return fmt.Errorf("codex logout lỗi: %w", err)
	}
	// CLI cũ có thể thoát 0 mà để lại file: xoá nốt để gói thật sự chưa đăng nhập.
	return removeFile(auth)
}
