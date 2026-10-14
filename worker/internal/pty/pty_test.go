//go:build !windows

package pty

import (
	"bytes"
	"io"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

// reader gom output của PTY trong nền để test chờ một chuỗi xuất hiện.
type reader struct {
	ch  chan []byte
	buf bytes.Buffer
}

func readAll(f *os.File) *reader {
	r := &reader{ch: make(chan []byte, 64)}
	go func() {
		defer close(r.ch)
		b := make([]byte, 4096)
		for {
			n, err := f.Read(b)
			if n > 0 {
				r.ch <- append([]byte(nil), b[:n]...)
			}
			if err != nil {
				return
			}
		}
	}()
	return r
}

func (r *reader) waitFor(t *testing.T, want string) {
	t.Helper()
	r.waitUntil(t, want, func(s string) bool { return strings.Contains(s, want) })
}

func (r *reader) waitUntil(t *testing.T, want string, done func(string) bool) {
	t.Helper()
	deadline := time.After(10 * time.Second)
	for !done(r.buf.String()) {
		select {
		case b, ok := <-r.ch:
			if !ok {
				t.Fatalf("PTY đóng trước khi thấy %q; output: %q", want, r.buf.String())
			}
			r.buf.Write(b)
		case <-deadline:
			t.Fatalf("không thấy %q; output: %q", want, r.buf.String())
		}
	}
}

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
	if err := Resize(f, 100, 30); err != nil {
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
	deadline := time.Now().Add(5 * time.Second)
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
	case <-time.After(5 * time.Second):
		KillGroup(cmd)
		t.Fatal("shell không thoát sau SIGHUP")
	}
}
