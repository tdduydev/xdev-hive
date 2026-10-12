//go:build !windows

package main

import (
	"os"
	"syscall"
)

// restartSelf thay tiến trình hiện tại bằng binary mới, giữ PID nên systemd và launchd vẫn coi là cùng một dịch vụ.
func restartSelf(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}
