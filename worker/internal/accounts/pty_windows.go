//go:build windows

package accounts

import (
	"io"
	"os/exec"
)

func startPTY(*exec.Cmd) (io.ReadWriteCloser, error) { return nil, errNoPTY }

func killGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
