package accounts

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Save ghi accounts.json (0600, thay nguyên file) để worker đang chạy không bao giờ đọc phải file ghi dở.
func Save(path string, maxParallel int, list []Account) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(file{MaxParallel: maxParallel, Accounts: list}, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".accounts-*.json")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// SetEnabled bật hoặc tắt một tài khoản.
func SetEnabled(path, id string, enabled bool) error {
	f, err := read(path)
	if err != nil {
		return err
	}
	for i := range f.Accounts {
		if f.Accounts[i].ID == id {
			f.Accounts[i].Enabled = enabled
			return Save(path, f.MaxParallel, f.Accounts)
		}
	}
	return fmt.Errorf("không có tài khoản %q", id)
}

// legacyConfig là phần cần đọc trong ~/.xdev-hive/config.json của app v1.
type legacyConfig struct {
	Agents []struct {
		ID              string            `json:"id"`
		Label           string            `json:"label"`
		Kind            string            `json:"kind"`
		Env             map[string]string `json:"env"`
		Enabled         bool              `json:"enabled"`
		Priority        int               `json:"priority"`
		MaxConcurrent   int               `json:"maxConcurrent"`
		CooldownMinutes int               `json:"cooldownMinutes"`
	} `json:"agents"`
	Runner struct {
		MaxParallel int `json:"maxParallel"`
	} `json:"runner"`
}

// LegacyPath là file cấu hình của app v1.
func LegacyPath(home string) string { return filepath.Join(home, ".xdev-hive", "config.json") }

// ImportLegacy chép danh sách tài khoản của app v1 sang accounts.json, một lần: accounts.json đã có thì không làm gì
// (trả 0) trừ khi force. Chỉ đọc nhãn, CLI, thư mục cấu hình và cách chọn; biến môi trường khác của app v1 (có thể
// chứa khoá API) không được chép.
func ImportLegacy(legacy, dst string, force bool) (int, error) {
	if !force {
		if _, err := os.Stat(dst); err == nil {
			return 0, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	b, err := os.ReadFile(legacy)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var c legacyConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return 0, fmt.Errorf("đọc %s: %w", legacy, err)
	}
	list := make([]Account, 0, len(c.Agents))
	for _, a := range c.Agents {
		if a.ID == "" {
			continue
		}
		dir := ""
		if v, ok := envVar[a.Kind]; ok {
			dir = a.Env[v]
		}
		list = append(list, Account{
			ID:              a.ID,
			Label:           a.Label,
			CLI:             a.Kind,
			ConfigDir:       dir,
			Enabled:         a.Enabled,
			Priority:        a.Priority,
			MaxConcurrent:   a.MaxConcurrent,
			CooldownMinutes: a.CooldownMinutes,
		})
	}
	if len(list) == 0 {
		return 0, nil
	}
	return len(list), Save(dst, c.Runner.MaxParallel, list)
}

// View là tài khoản kèm trạng thái đọc từ máy, cho app hiện danh sách.
type View struct {
	Account
	// Supported: worker chọn được tài khoản của CLI này.
	Supported bool `json:"supported"`
	// LoggedIn: thư mục cấu hình có đăng nhập của CLI; null khi không biết cách kiểm CLI này.
	LoggedIn *bool  `json:"loggedIn"`
	Email    string `json:"email,omitempty"`
}

// Views đọc trạng thái đăng nhập của từng tài khoản. Chỉ đọc email để hiện; không đọc hay trả token.
func Views(list []Account, home string) []View {
	p := &Pool{home: home}
	out := make([]View, 0, len(list))
	for _, a := range list {
		v := View{Account: a, Supported: Supported(a.CLI)}
		dir := p.expand(a.ConfigDir)
		switch a.CLI {
		case "claude":
			file := filepath.Join(home, ".claude.json")
			if dir != "" {
				file = filepath.Join(dir, ".claude.json")
			}
			ok, email := claudeLogin(file)
			v.LoggedIn, v.Email = &ok, email
		case "codex":
			if dir == "" {
				dir = filepath.Join(home, ".codex")
			}
			ok, email := codexLogin(filepath.Join(dir, "auth.json"))
			v.LoggedIn, v.Email = &ok, email
		}
		out = append(out, v)
	}
	return out
}

func claudeLogin(path string) (bool, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, ""
	}
	var c struct {
		OAuthAccount *struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(b, &c) != nil || c.OAuthAccount == nil {
		return false, ""
	}
	return true, c.OAuthAccount.EmailAddress
}

func codexLogin(path string) (bool, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, ""
	}
	var c struct {
		APIKey *string `json:"OPENAI_API_KEY"`
		Tokens *struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(b, &c) != nil {
		return false, ""
	}
	if c.Tokens == nil {
		return c.APIKey != nil && *c.APIKey != "", ""
	}
	return true, jwtEmail(c.Tokens.IDToken)
}

// jwtEmail đọc email trong phần thân id_token để hiện tên tài khoản; không kiểm chữ ký vì không dùng để xác thực.
func jwtEmail(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	return claims.Email
}
