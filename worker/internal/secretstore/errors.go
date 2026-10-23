package secretstore

import (
	"fmt"
	"strings"
)

// Mã lỗi của lệnh sidecar (specs/031 contracts/sidecar-cli.md). Desktop dựa vào mã để chọn cách báo.
const (
	CodeInvalidName       = "invalid_name"
	CodeReservedName      = "reserved_name"
	CodeDuplicateName     = "duplicate_name"
	CodeInvalidValue      = "invalid_value"
	CodeTooMany           = "too_many"
	CodeDescriptionSecret = "description_looks_secret"
	CodeStoreUnavailable  = "store_unavailable"
	CodeStoreLocked       = "store_locked"
	CodeStoreMissing      = "store_missing"
	CodeStoreCorrupt      = "store_corrupt"
	CodeEnvTooLarge       = "env_too_large"
	CodeNotFound          = "not_found"
)

// Error là lỗi của gói: mã, thông báo tiếng Việt chỉ có tên (không bao giờ giá trị, FR-036), và tên liên quan. Lỗi gốc
// của kho không được giữ lại: chuỗi của nó do thư viện ngoài sinh, gói không kiểm được nó không chứa gì.
type Error struct {
	Code    string   `json:"code"`
	Message string   `json:"message"`
	Names   []string `json:"names,omitempty"`
}

func (e *Error) Error() string { return e.Message }

// Is cho errors.Is so theo mã, để bên gọi kiểm errors.Is(err, ErrLocked) với lỗi đã kèm tên.
func (e *Error) Is(target error) bool {
	t, ok := target.(*Error)
	return ok && t.Code == e.Code
}

// Lỗi mẫu để so bằng errors.Is; lỗi thật kèm thông báo và tên do các hàm dưới tạo.
var (
	ErrNotFound    = &Error{Code: CodeNotFound}
	ErrMissing     = &Error{Code: CodeStoreMissing}
	ErrLocked      = &Error{Code: CodeStoreLocked}
	ErrUnavailable = &Error{Code: CodeStoreUnavailable}
	ErrCorrupt     = &Error{Code: CodeStoreCorrupt}
	ErrEnvTooLarge = &Error{Code: CodeEnvTooLarge}
)

func notFound(name string) *Error {
	return &Error{Code: CodeNotFound, Message: fmt.Sprintf("Không tìm thấy bí mật `%s`.", name), Names: []string{name}}
}

func missing(names ...string) *Error {
	return &Error{
		Code:    CodeStoreMissing,
		Message: fmt.Sprintf("Kho thiếu giá trị của: %s. Hãy đặt lại giá trị.", strings.Join(names, ", ")),
		Names:   names,
	}
}

func corrupt(name string) *Error {
	return &Error{
		Code:    CodeStoreCorrupt,
		Message: fmt.Sprintf("Bí mật %s bị hỏng trong kho, hãy đặt lại giá trị.", name),
		Names:   []string{name},
	}
}

func locked(names ...string) *Error {
	return &Error{Code: CodeStoreLocked, Message: "Kho bí mật đang khoá. Mở khoá máy rồi chạy lại.", Names: names}
}

func unavailable(names ...string) *Error {
	return &Error{Code: CodeStoreUnavailable, Message: unavailableMessage, Names: names}
}
