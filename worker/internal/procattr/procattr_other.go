//go:build !windows

package procattr

import "os/exec"

// Hide không làm gì: ngoài Windows tiến trình con không tự có cửa sổ.
func Hide(*exec.Cmd) {}
