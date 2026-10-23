package secretstore

import (
	"errors"
	"syscall"
	"testing"
)

func TestWindowsKeyringErrorClassification(t *testing.T) {
	for _, code := range []syscall.Errno{5, 1312} {
		if !errors.Is(classify(code), ErrLocked) {
			t.Fatal("kho bị chặn hoặc thiếu phiên đăng nhập phải báo khoá")
		}
	}
	if !errors.Is(classify(syscall.Errno(1060)), ErrUnavailable) {
		t.Fatal("dịch vụ không có phải báo kho không dùng được")
	}
}
