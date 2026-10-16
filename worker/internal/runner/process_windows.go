//go:build windows

package runner

import (
	"context"
	"os/exec"
	"strconv"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

func startProcess(c *exec.Cmd) error { return c.Start() }
func waitProcess(ctx context.Context, c *exec.Cmd, grace func() time.Duration) error {
	done := make(chan error, 1)
	go func() { done <- c.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
	}
	_ = procattr.Command("taskkill", "/PID", itoa(c.Process.Pid), "/T").Run()
	t := time.NewTimer(grace())
	defer t.Stop()
	select {
	case err := <-done:
		return err
	case <-t.C:
		_ = procattr.Command("taskkill", "/F", "/PID", itoa(c.Process.Pid), "/T").Run()
		return <-done
	}
}
func itoa(n int) string { return strconv.Itoa(n) }
