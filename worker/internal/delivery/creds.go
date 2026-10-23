package delivery

import (
	"errors"
	"regexp"
)

// CredentialReader đọc giá trị credential theo tên tham chiếu. Bản thật bọc kho bí mật của hệ điều hành, không gian tên
// riêng cho delivery (FR-062); bản thử là MapCredentials. Giá trị chỉ nằm trong bộ nhớ (FR-063).
//
// Quy ước giá trị: Jenkins "user:token"; Argo CD là token trần.
type CredentialReader interface {
	// Read trả ErrCredentialNotFound khi không có tên đó.
	Read(name string) ([]byte, error)
}

// ErrCredentialNotFound để bản đọc kho báo thiếu credential mà không phụ thuộc kiểu lỗi của kho.
var ErrCredentialNotFound = errors.New("credential not found")

var credentialName = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)

// MapCredentials là CredentialReader trong bộ nhớ, dùng cho test.
type MapCredentials map[string]string

func (m MapCredentials) Read(name string) ([]byte, error) {
	v, ok := m[name]
	if !ok {
		return nil, ErrCredentialNotFound
	}
	return []byte(v), nil
}

// readCredential kiểm tên rồi đọc. Thiếu thì trả missing_credential và không thử đường khác (FR-066).
func readCredential(r CredentialReader, name string) ([]byte, error) {
	if !credentialName.MatchString(name) {
		return nil, newError(CodeBadRequest, 0, "Tên credential %q không hợp lệ.", name)
	}
	if r == nil {
		return nil, newError(CodeMissingCredential, 0, "Máy này chưa có kho credential.")
	}
	v, err := r.Read(name)
	if err != nil {
		if errors.Is(err, ErrCredentialNotFound) {
			return nil, newError(CodeMissingCredential, 0, "Máy này chưa có credential %q. Thêm ở màn Bí mật.", name)
		}
		return nil, newError(CodeUnavailable, 0, "Không đọc được credential %q từ kho bí mật.", name)
	}
	if len(v) == 0 {
		return nil, newError(CodeMissingCredential, 0, "Credential %q đang rỗng.", name)
	}
	return v, nil
}
