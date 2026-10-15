// Package pty chạy tiến trình trong một pseudo-terminal, dùng chung cho đăng nhập gói từ web (accounts), terminal
// Leader và phiên `hive` (terminal). Unix dùng creack/pty; Windows dùng ConPTY (Windows 10 1809 trở lên), bản cũ hơn
// thì Start trả ErrUnsupported.
package pty

import (
	"errors"
	"io"
)

// ErrUnsupported: hệ điều hành chưa có PTY trong worker (Windows trước 10 1809, không có ConPTY).
var ErrUnsupported = errors.New("hệ điều hành này chưa hỗ trợ PTY trong worker")

// Terminal là đầu điều khiển của PTY: Read đọc output của tiến trình, Write gửi phím. Read trả io.EOF khi tiến trình
// và mọi tiến trình con còn giữ terminal đã thoát.
type Terminal interface {
	io.ReadWriteCloser
	// Resize đổi cỡ terminal; tiến trình được báo (SIGWINCH trên Unix) và vẽ lại.
	Resize(cols, rows int) error
}
