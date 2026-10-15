//go:build !windows

package pty

import (
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestStartEchoAndResize(t *testing.T) {
	cmd := exec.Command("/bin/sh")
	cmd.Env = append(os.Environ(), "PS1=$ ")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	defer func() { KillGroup(cmd); _ = cmd.Wait() }()
	r := readAll(f)
	if _, err := io.WriteString(f, "echo xin-$((40+2))\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "xin-42")
	if _, err := io.WriteString(f, "stty size\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "24 80")
	if err := f.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(f, "stty size\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "30 100")
}

// KillGroup phải dừng cả tiến trình con chạy nền của shell, không chỉ shell.
func TestKillGroupStopsChildren(t *testing.T) {
	cmd := exec.Command("/bin/sh", "-c", "sleep 60 & echo child=$!; wait")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := readAll(f)
	r.waitUntil(t, "dòng child=", func(s string) bool {
		_, after, found := strings.Cut(s, "child=")
		return found && strings.Contains(after, "\n")
	})
	var pid int
	for _, line := range strings.Split(r.buf.String(), "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "child="); ok {
			for _, c := range v {
				if c >= '0' && c <= '9' {
					pid = pid*10 + int(c-'0')
				}
			}
		}
	}
	if pid == 0 {
		t.Fatalf("không đọc được pid con: %q", r.buf.String())
	}
	KillGroup(cmd)
	_ = cmd.Wait()
	deadline := time.Now().Add(15 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			t.Fatalf("tiến trình con %d còn sống sau KillGroup", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestHangupGroupEndsShell(t *testing.T) {
	cmd := exec.Command("/bin/sh")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	_ = readAll(f)
	HangupGroup(cmd)
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		KillGroup(cmd)
		t.Fatal("shell không thoát sau SIGHUP")
	}
}
