package procattr

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// Hide đặt CREATE_NO_WINDOW và HideWindow, giữ các cờ đã có (vd. CREATE_NEW_PROCESS_GROUP để gửi Ctrl+Break).
func Hide(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_NO_WINDOW
}
