//go:build windows

package pty

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// helperEnv bật chế độ CLI giả: chính file test chạy lại làm tiến trình trong ConPTY, không cần cmd.exe hay PowerShell.
const helperEnv = "HIVE_PTY_HELPER"

func TestMain(m *testing.M) {
	if mode := os.Getenv(helperEnv); mode != "" {
		os.Exit(helper(mode))
	}
	os.Exit(m.Run())
}

func helper(mode string) int {
	switch mode {
	case "echo":
		// Mỗi dòng nhập in lại "got:<dòng>"; "size" in cỡ console; "exit N" thoát mã N.
		sc := bufio.NewScanner(os.Stdin)
		fmt.Println("ready")
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			switch {
			case line == "size":
				var info windows.ConsoleScreenBufferInfo
				if err := windows.GetConsoleScreenBufferInfo(windows.Stdout, &info); err != nil {
					fmt.Println("size-err", err)
					continue
				}
				w := info.Window
				fmt.Printf("size=%dx%d\n", w.Right-w.Left+1, w.Bottom-w.Top+1)
			case strings.HasPrefix(line, "exit "):
				code, _ := strconv.Atoi(strings.TrimPrefix(line, "exit "))
				return code
			default:
				fmt.Println("got:" + line)
			}
		}
		return 0
	case "big":
		row := strings.Repeat("x", 99) + "\n"
		w := bufio.NewWriterSize(os.Stdout, 64<<10)
		for n := 0; n < 10<<20; n += len(row) {
			_, _ = w.WriteString(row)
		}
		_, _ = w.WriteString("big-done\n")
		_ = w.Flush()
		return 0
	case "spawn":
		child := exec.Command(os.Args[0], "-test.run=^$")
		child.Env = append(os.Environ(), helperEnv+"=sleep")
		if err := child.Start(); err != nil {
			fmt.Println("spawn-err", err)
			return 1
		}
		fmt.Printf("child=%d;\n", child.Process.Pid)
		_ = child.Wait()
		return 0
	case "sleep":
		time.Sleep(time.Minute)
		return 0
	}
	return 2
}

func helperCmd(mode string) *exec.Cmd {
	cmd := exec.Command(os.Args[0], "-test.run=^$")
	cmd.Env = append(os.Environ(), helperEnv+"="+mode)
	return cmd
}

func waitExit(t *testing.T, cmd *exec.Cmd) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-time.After(30 * time.Second):
		KillGroup(cmd)
		t.Fatal("tiến trình không thoát")
		return nil
	}
}

func TestSupportedOnWindows(t *testing.T) {
	// CI chạy Windows Server 2022 trở lên: luôn có ConPTY. Sai ở đây là dò ConPTY hỏng chứ không phải máy cũ.
	if !Supported {
		t.Fatal("không dò được CreatePseudoConsole")
	}
}

func TestConPTYEchoResizeExit(t *testing.T) {
	cmd := helperCmd("echo")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := readAll(f)
	r.waitFor(t, "ready")
	if _, err := io.WriteString(f, "xin-chao\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "got:xin-chao")
	if _, err := io.WriteString(f, "size\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "size=80x24")
	if err := f.Resize(100, 30); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(f, "size\r"); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "size=100x30")
	if _, err := io.WriteString(f, "exit 3\r"); err != nil {
		t.Fatal(err)
	}
	var ee *exec.ExitError
	if err := waitExit(t, cmd); !errors.As(err, &ee) || ee.ExitCode() != 3 {
		t.Fatalf("mã thoát: %v", err)
	}
	// Tiến trình thoát thì console đóng và Read nhận EOF, như PTY Unix.
	deadline := time.After(15 * time.Second)
	for {
		select {
		case _, ok := <-r.ch:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("output không kết thúc sau khi tiến trình thoát")
		}
	}
}

// 10 MB output không được làm ConPTY hay worker kẹt; chỉ giữ đuôi để không quét lại cả 10 MB mỗi lần đọc.
func TestConPTYLargeOutput(t *testing.T) {
	cmd := helperCmd("big")
	f, err := Start(cmd, 120, 40)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	got := make(chan bool, 1)
	go func() {
		var tail []byte
		buf := make([]byte, 32<<10)
		for {
			n, err := f.Read(buf)
			tail = append(tail, buf[:n]...)
			if strings.Contains(string(tail), "big-done") {
				got <- true
				_, _ = io.Copy(io.Discard, f)
				return
			}
			if len(tail) > 4096 {
				tail = append([]byte(nil), tail[len(tail)-4096:]...)
			}
			if err != nil {
				got <- false
				return
			}
		}
	}()
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("output đóng trước dòng cuối")
		}
	case <-time.After(2 * time.Minute):
		KillGroup(cmd)
		t.Fatal("không đọc hết 10 MB output")
	}
	if err := waitExit(t, cmd); err != nil {
		t.Fatal(err)
	}
}

// KillGroup phải dừng cả tiến trình con, không chỉ tiến trình chính.
func TestConPTYKillGroupStopsChildren(t *testing.T) {
	cmd := helperCmd("spawn")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := readAll(f)
	r.waitUntil(t, "child=<pid>;", func(s string) bool {
		_, after, ok := strings.Cut(s, "child=")
		return ok && strings.Contains(after, ";")
	})
	_, after, _ := strings.Cut(r.buf.String(), "child=")
	pid, err := strconv.Atoi(after[:strings.Index(after, ";")])
	if err != nil {
		t.Fatalf("pid con: %q", r.buf.String())
	}
	child, err := windows.OpenProcess(windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(child)
	KillGroup(cmd)
	_ = waitExit(t, cmd)
	if ev, err := windows.WaitForSingleObject(child, 15000); err != nil || ev != windows.WAIT_OBJECT_0 {
		t.Fatalf("tiến trình con %d còn sống sau KillGroup: %d %v", pid, ev, err)
	}
}

func TestConPTYHangupEnds(t *testing.T) {
	cmd := helperCmd("echo")
	f, err := Start(cmd, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	r := readAll(f)
	r.waitFor(t, "ready")
	HangupGroup(cmd)
	_ = waitExit(t, cmd)
	// Đã đóng console thì Resize báo lỗi chứ không dùng HPCON đã giải phóng.
	if err := f.Resize(90, 30); err == nil {
		t.Fatal("Resize sau khi đóng phải lỗi")
	}
}

func TestStartBadPath(t *testing.T) {
	cmd := exec.Command(`C:\khong-co\cli.exe`)
	if _, err := Start(cmd, 80, 24); err == nil {
		t.Fatal("phải lỗi khi không có tệp chạy")
	}
}
