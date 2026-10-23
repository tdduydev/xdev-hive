package main

import (
	"errors"
	"fmt"
	"io"
	"os/exec"
)

func launchSecretProcess(argv, env []string, stdin io.Reader, stdout, stderr io.Writer) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = env
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintln(stderr, "Không chạy được lệnh trong phiên. Kiểm tra CLI đã cài và thử lại.")
		return 127
	}
	return 0
}
