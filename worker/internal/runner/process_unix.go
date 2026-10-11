//go:build !windows

package runner

import (
	"context"
	"os/exec"
	"syscall"
	"time"
)

func startProcess(c *exec.Cmd) error {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	return c.Start()
}
func waitProcess(ctx context.Context, c *exec.Cmd, grace time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
	}
	_ = syscall.Kill(-c.Process.Pid, syscall.SIGINT)
	t := time.NewTimer(grace)
	defer t.Stop()
	select {
	case err := <-done:
		return err
	case <-t.C:
		_ = syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
		return <-done
	}
}
