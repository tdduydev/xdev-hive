//go:build windows

package pty

import (
	"os"
	"os/exec"
)

// Supported: Windows chưa có PTY trong worker (ConPTY chưa làm).
const Supported = false

func Start(*exec.Cmd, int, int) (*os.File, error) { return nil, ErrUnsupported }

func Resize(*os.File, int, int) error { return ErrUnsupported }

func HangupGroup(cmd *exec.Cmd) { KillGroup(cmd) }

func KillGroup(cmd *exec.Cmd) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
