package remoteauth

import "errors"

// Mã từ chối, trùng enum termDenyCode của contracts để hub đổi ra câu tiếng Việt.
const (
	CodeAuthInvalid        = "AUTH_INVALID"
	CodeAuthStale          = "AUTH_STALE"
	CodeAuthReplay         = "AUTH_REPLAY"
	CodeDeviceUnknown      = "DEVICE_UNKNOWN"
	CodeDeviceUserMismatch = "DEVICE_USER_MISMATCH"
	CodeAssertionOrigin    = "ASSERTION_ORIGIN"
	CodeAssertionRPID      = "ASSERTION_RP_ID"
	CodeAssertionFlags     = "ASSERTION_FLAGS"
	CodeAssertionSignature = "ASSERTION_SIGNATURE"
	CodeAssertionCounter   = "ASSERTION_COUNTER"
	CodeTOTPDisabled       = "TOTP_DISABLED"
	CodeTOTPNotAllowed     = "TOTP_NOT_ALLOWED"
	CodeTOTPInvalid        = "TOTP_INVALID"
	CodeTOTPReplay         = "TOTP_REPLAY"
	CodeTOTPLocked         = "TOTP_LOCKED"
	CodeInputRejected      = "INPUT_REJECTED"
)

// DenyError là lời từ chối có mã gửi được cho hub. Err (nếu có) chỉ để ghi log tại máy, không gửi đi.
type DenyError struct {
	Code string
	Err  error
}

func (e *DenyError) Error() string {
	if e.Err != nil {
		return e.Code + ": " + e.Err.Error()
	}
	return e.Code
}

func (e *DenyError) Unwrap() error { return e.Err }

func deny(code string) error { return &DenyError{Code: code} }

func denyErr(code string, err error) error { return &DenyError{Code: code, Err: err} }

// Code lấy mã từ chối của err. Lỗi khác (đọc ghi đĩa…) thành AUTH_INVALID để luôn từ chối khi không chắc.
func Code(err error) string {
	if err == nil {
		return ""
	}
	var d *DenyError
	if errors.As(err, &d) {
		return d.Code
	}
	return CodeAuthInvalid
}
