//go:build !windows

package accounts

import (
	"io"
	"os/exec"
	"syscall"

	"github.com/creack/pty"
)

// startPTY chạy cmd trong một PTY. Cột rộng để CLI không tự ngắt dòng giữa URL đăng nhập (URL bị ngắt thì web nhận URL
// cụt). pty.Start đặt Setsid nên tiến trình là chủ nhóm riêng, killGroup dừng được cả cây con.
func startPTY(cmd *exec.Cmd) (io.ReadWriteCloser, error) {
	return pty.StartWithSize(cmd, &pty.Winsize{Rows: 50, Cols: 500})
}

// killGroup dừng cả nhóm tiến trình của cmd: CLI đăng nhập có thể đã sinh tiến trình con (mở trình duyệt, máy chủ callback).
func killGroup(cmd *exec.Cmd) {
	if cmd.Process == nil {
		return
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil {
		_ = cmd.Process.Kill()
	}
}
