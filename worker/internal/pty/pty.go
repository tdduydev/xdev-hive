// Package pty chạy tiến trình trong một pseudo-terminal, dùng chung cho đăng nhập gói từ web (accounts) và terminal
// Leader (terminal). Windows chưa có PTY trong worker: Start trả ErrUnsupported.
package pty

import "errors"

// ErrUnsupported: hệ điều hành chưa có PTY trong worker (Windows).
var ErrUnsupported = errors.New("hệ điều hành này chưa hỗ trợ PTY trong worker")
