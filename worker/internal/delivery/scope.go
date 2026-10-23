package delivery

import (
	"path/filepath"
	"regexp"
)

var scopeIDPattern = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// Scope là một đăng ký của máy với một tổ chức trên một hub. Một máy có thể phục vụ hai tổ chức cùng lúc (specs/034), nên
// credential, hàng việc, thư mục làm việc và log của delivery đều gắn với Scope và không bao giờ dùng chung giữa các
// Scope. Cấu hình một đăng ký của worker (internal/config) không đổi: nơi gọi truyền Scope vào khi tạo Executor.
type Scope struct {
	// RegistrationID định danh đăng ký, ổn định qua các lần khởi động; dùng làm tên thư mục và tiền tố kho bí mật.
	RegistrationID string
}

// Valid kiểm RegistrationID đủ an toàn để làm tên thư mục và tiền tố khoá.
func (s Scope) Valid() bool { return scopeIDPattern.MatchString(s.RegistrationID) }

// LogDir là thư mục log của đăng ký này dưới root: <root>/<registration>/delivery-logs.
func (s Scope) LogDir(root string) string {
	return filepath.Join(root, s.RegistrationID, "delivery-logs")
}

// WorkDir là thư mục làm việc của đăng ký này dưới root: <root>/<registration>/delivery-work.
func (s Scope) WorkDir(root string) string {
	return filepath.Join(root, s.RegistrationID, "delivery-work")
}

// ScopedCredentials thu hẹp một CredentialReader vào một Scope: tên "x" của đăng ký A không bao giờ trùng tên "x" của
// đăng ký B, kể cả khi hai tổ chức đặt cùng tên.
type ScopedCredentials struct {
	Scope Scope
	// Store đọc theo khoá đầy đủ "delivery/<registration>/<name>".
	Store CredentialReader
}

// Key là khoá đầy đủ trong kho bí mật.
func (c ScopedCredentials) Key(name string) string {
	return "delivery/" + c.Scope.RegistrationID + "/" + name
}

func (c ScopedCredentials) Read(name string) ([]byte, error) {
	if !c.Scope.Valid() {
		return nil, newError(CodeBadRequest, 0, "Đăng ký của máy chưa hợp lệ.")
	}
	if !credentialName.MatchString(name) {
		return nil, newError(CodeBadRequest, 0, "Tên credential %q không hợp lệ.", name)
	}
	if c.Store == nil {
		return nil, ErrCredentialNotFound
	}
	return c.Store.Read(c.Key(name))
}
