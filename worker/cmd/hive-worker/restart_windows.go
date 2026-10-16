package main

import (
	"os"
	"os/exec"
)

// restartSelf: Windows không có exec thay tiến trình, nên chạy bản mới với cùng tham số và để tiến trình này thoát.
// Bản mới kế thừa stdout, stderr nên log vẫn ghi vào file của tác vụ. Không qua procattr: bản mới dùng chung console
// (nếu có) với tiến trình này như cũ, worker chạy dưới app không tự khởi động lại.
func restartSelf(exe string) error {
	cmd := exec.Command(exe, os.Args[1:]...) // procattr:allow
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Start()
}
