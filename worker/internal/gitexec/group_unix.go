//go:build !windows

package gitexec

import (
	"os/exec"
	"syscall"
)

// git chạy trong nhóm tiến trình riêng để Interrupt tới cả git-remote-http con; chỉ báo git cha thì con vẫn giữ ống
// stderr và Run phải đợi hết WaitDelay.
func interruptGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGINT) }
}
