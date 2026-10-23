//go:build !windows

package main

import (
	"fmt"
	"io"
	"os/exec"
	"syscall"
)

func launchSecretProcess(argv, env []string, _ io.Reader, _ io.Writer, stderr io.Writer) int {
	path, err := exec.LookPath(argv[0])
	if err == nil {
		err = syscall.Exec(path, argv, env)
	}
	if err != nil {
		fmt.Fprintln(stderr, "Không chạy được lệnh trong phiên. Kiểm tra CLI đã cài và thử lại.")
	}
	return 127
}
