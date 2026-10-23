// Package delivery chạy việc CI/CD và triển khai trên worker (specs/032). Hub chỉ giữ cấu hình, duyệt và lịch sử; gói này
// gọi Jenkins và Argo CD từ trong mạng nội bộ và đọc credential từ kho bí mật của máy.
package delivery

import (
	"errors"
	"fmt"
)

// Code là mã lỗi gửi cho hub trong sự kiện finished. Hub chỉ nhận mã và một dòng thông điệp đã che, không nhận stderr.
type Code string

const (
	CodeMissingCredential Code = "missing_credential"
	CodeAuthFailed        Code = "auth_failed"
	CodeForbidden         Code = "forbidden"
	CodeNotFound          Code = "not_found"
	CodeUnavailable       Code = "unavailable"
	CodeTimeout           Code = "timeout"
	CodeBadRequest        Code = "bad_request"
	CodeUnsupported       Code = "unsupported"
	CodeCanceled          Code = "canceled"
)

// Error là lỗi nghiệp vụ của gói. Message viết tiếng Việt và không bao giờ chứa credential.
type Error struct {
	Code    Code
	Message string
	// Status là mã HTTP của hệ ngoài, 0 nếu không có.
	Status int
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

func newError(code Code, status int, format string, args ...any) *Error {
	return &Error{Code: code, Status: status, Message: fmt.Sprintf(format, args...)}
}

// CodeOf lấy mã lỗi; lỗi không phải *Error được coi là unavailable.
func CodeOf(err error) Code {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return CodeUnavailable
}

// httpError đổi mã HTTP của hệ ngoài thành lỗi nghiệp vụ. system là tên hệ ngoài để đưa vào thông điệp.
func httpError(system string, status int) *Error {
	switch {
	case status == 401:
		return newError(CodeAuthFailed, status, "%s không nhận credential. Cập nhật credential trên máy chạy.", system)
	case status == 403:
		return newError(CodeForbidden, status, "Credential không có quyền làm việc này trên %s.", system)
	case status == 404:
		return newError(CodeNotFound, status, "Không tìm thấy đối tượng trên %s.", system)
	case status == 400 || status == 409 || status == 422:
		return newError(CodeBadRequest, status, "%s từ chối yêu cầu (HTTP %d).", system, status)
	default:
		return newError(CodeUnavailable, status, "%s không trả lời đúng (HTTP %d).", system, status)
	}
}
