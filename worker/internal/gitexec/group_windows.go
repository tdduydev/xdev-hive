package gitexec

import "os/exec"

// Windows không có tín hiệu cho nhóm tiến trình: giữ mặc định của exec (giết git).
func interruptGroup(*exec.Cmd) {}
