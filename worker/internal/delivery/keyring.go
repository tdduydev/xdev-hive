package delivery

import (
	"errors"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

// KeyringCredentials là CredentialReader thật: đọc kho của hệ điều hành ở dịch vụ secretstore.DeliveryService ngay lúc
// cần, không giữ bản sao, không ghi ra đĩa hay log (FR-063). Linux không có Secret Service thì báo lỗi, không có kho
// file thay thế (FR-102). Bọc trong ScopedCredentials để khoá có dạng "delivery/<registration>/<name>".
type KeyringCredentials struct {
	Store *secretstore.Store
}

func NewKeyringCredentials() KeyringCredentials {
	return KeyringCredentials{Store: secretstore.NewSystemDeliveryStore()}
}

func (k KeyringCredentials) Read(key string) ([]byte, error) {
	if k.Store == nil {
		return nil, ErrCredentialNotFound
	}
	v, err := k.Store.Get(key)
	if err == nil {
		return []byte(v), nil
	}
	if errors.Is(err, secretstore.ErrMissing) {
		return nil, ErrCredentialNotFound
	}
	// Thông báo của secretstore có khoá đầy đủ trong kho; lỗi lên hub chỉ cần biết kho hỏng hay khoá, nên viết lại.
	switch {
	case errors.Is(err, secretstore.ErrCorrupt):
		return nil, newError(CodeMissingCredential, 0, "Giá trị trong kho bị hỏng. Đặt lại ở màn Bí mật.")
	case errors.Is(err, secretstore.ErrLocked):
		return nil, newError(CodeUnavailable, 0, "Kho bí mật đang khoá. Mở khoá máy rồi chạy lại.")
	}
	var se *secretstore.Error
	if errors.As(err, &se) {
		return nil, newError(CodeUnavailable, 0, "%s", se.Message)
	}
	return nil, newError(CodeUnavailable, 0, "Không đọc được kho bí mật của máy.")
}

// Available báo kho có dùng được không mà không đọc credential nào, để worker báo sớm khi Linux thiếu Secret Service.
func (k KeyringCredentials) Available() (bool, string) {
	if k.Store == nil {
		return false, "Máy này chưa có kho credential."
	}
	st := k.Store.Status()
	if st.Reason != nil {
		return st.Available, *st.Reason
	}
	return st.Available, ""
}
