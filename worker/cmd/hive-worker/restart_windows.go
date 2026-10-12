package main

import (
	"os"
	"os/exec"
)

// restartSelf: Windows không có exec thay tiến trình, nên chạy bản mới với cùng tham số và để tiến trình này thoát.
// Bản mới kế thừa stdout, stderr nên log vẫn ghi vào file của tác vụ.
func restartSelf(exe string) error {
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Start()
}
