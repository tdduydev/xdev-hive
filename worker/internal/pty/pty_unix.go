//go:build !windows

package pty

import (
	"os"
	"os/exec"
	"syscall"

	cpty "github.com/creack/pty"
)

// Supported: hệ điều hành có PTY trong worker.
const Supported = true

// Start chạy cmd trong một PTY cỡ cols×rows. pty.Start đặt Setsid nên tiến trình là chủ nhóm riêng, KillGroup dừng
// được cả cây con.
func Start(cmd *exec.Cmd, cols, rows int) (Terminal, error) {
	f, err := cpty.StartWithSize(cmd, &cpty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return file{f}, nil
}

type file struct{ *os.File }

func (f file) Resize(cols, rows int) error {
	return cpty.Setsize(f.File, &cpty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}

// HangupGroup gửi SIGHUP cho cả nhóm tiến trình, như khi đóng cửa sổ terminal: CLI tương tác tự dọn rồi thoát.
func HangupGroup(cmd *exec.Cmd) { signalGroup(cmd, syscall.SIGHUP) }

// KillGroup dừng cả nhóm tiến trình của cmd: CLI có thể đã sinh tiến trình con (mở trình duyệt, máy chủ callback, lệnh
// Bash của agent).
func KillGroup(cmd *exec.Cmd) { signalGroup(cmd, syscall.SIGKILL) }

func signalGroup(cmd *exec.Cmd, sig syscall.Signal) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
		_ = cmd.Process.Signal(sig)
	}
}
