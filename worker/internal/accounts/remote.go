package accounts

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

// tokenEnv là biến CLI Claude đọc token của `claude setup-token`; tokenFile là nơi worker giữ token đó cho một tài khoản.
const (
	tokenEnv  = "CLAUDE_CODE_OAUTH_TOKEN"
	tokenFile = ".oauth-token"
	// tokenPrefix: token `claude setup-token` bắt đầu bằng sk-ant-oat. Chỉ kiểm lỏng để dán nhầm (URL, mã xác nhận) bị
	// báo ngay; token thật hợp lệ hay không do CLI quyết.
	tokenPrefix = "sk-ant-oat"
	maxToken    = 4096
)

// ApplySet bật hoặc tắt một tài khoản theo lệnh account_set của hub. Tài khoản đang đăng nhập dở không thuộc về máy
// nên không bật được.
func ApplySet(path, id string, enabled bool) error {
	list, err := Load(path)
	if err != nil {
		return err
	}
	for _, a := range list {
		if a.ID == id && a.Pending {
			return fmt.Errorf("tài khoản %q đang đăng nhập dở", id)
		}
	}
	return SetEnabled(path, id, enabled)
}

// CheckToken chuẩn hoá và kiểm lỏng token dán từ web: bỏ khoảng trắng hai đầu, không còn khoảng trắng hay xuống dòng ở
// giữa (tránh dán nhầm cả đoạn văn), đúng tiền tố, không quá dài. Thông báo lỗi không chứa token.
func CheckToken(raw string) (string, error) {
	token := strings.TrimSpace(raw)
	if strings.IndexFunc(token, unicode.IsSpace) >= 0 {
		return "", errors.New("token không được có khoảng trắng hay xuống dòng")
	}
	if len(token) > maxToken {
		return "", errors.New("token quá dài")
	}
	if !strings.HasPrefix(token, tokenPrefix) {
		return "", fmt.Errorf("token phải bắt đầu bằng %s (lấy bằng `claude setup-token`)", tokenPrefix)
	}
	return token, nil
}

// WriteToken ghi token vào thư mục cấu hình của tài khoản (0600, thay nguyên file) để lần đọc đồng thời không bao giờ
// thấy file ghi dở.
func WriteToken(dir, token string) error {
	if dir == "" {
		return errors.New("tài khoản không có thư mục cấu hình riêng")
	}
	tmp, err := os.CreateTemp(dir, "."+tokenFile+"-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.WriteString(token); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(dir, tokenFile))
}

// oauthToken là token trong thư mục cấu hình; rỗng khi không có file hay file rỗng.
func oauthToken(dir string) string {
	b, err := os.ReadFile(filepath.Join(dir, tokenFile))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
