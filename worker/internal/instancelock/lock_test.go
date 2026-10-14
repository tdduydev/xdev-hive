package instancelock

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

const holderEnv = "HIVE_INSTANCELOCK_HOLDER"

// Tiến trình con của TestLockSurvivesAcrossProcesses: giữ khoá cho tới khi cha đóng stdin.
func TestMain(m *testing.M) {
	if os.Getenv(holderEnv) == "1" {
		lock, err := Acquire()
		if err != nil {
			os.Stdout.WriteString("lỗi: " + err.Error() + "\n")
			os.Exit(1)
		}
		defer lock.Close()
		os.Stdout.WriteString("đã khoá\n")
		_, _ = bufio.NewReader(os.Stdin).ReadByte()
		return
	}
	os.Exit(m.Run())
}

func fakeHome(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
}

func TestSecondAcquireIsRejectedUntilFirstCloses(t *testing.T) {
	fakeHome(t)
	first, err := Acquire()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("lần mở thứ hai phải báo đã có worker đang chạy, được %v", err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatalf("Close lần hai phải là no-op, được %v", err)
	}
	again, err := Acquire()
	if err != nil {
		t.Fatalf("khoá phải nhả sau Close: %v", err)
	}
	_ = again.Close()
}

func TestLockSurvivesAcrossProcesses(t *testing.T) {
	fakeHome(t)
	cmd := exec.Command(os.Args[0])
	cmd.Env = append(os.Environ(), holderEnv+"=1")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "đã khoá\n" {
		t.Fatalf("tiến trình con không giữ được khoá: %q %v", line, err)
	}
	if _, err := Acquire(); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("tiến trình khác đang giữ khoá, được %v", err)
	}
	// Tiến trình con chết (kể cả bị giết) thì hệ điều hành nhả khoá, không cần dọn file.
	_ = stdin.Close()
	_ = cmd.Wait()
	deadline := time.Now().Add(5 * time.Second)
	for {
		lock, err := Acquire()
		if err == nil {
			_ = lock.Close()
			return
		}
		if !errors.Is(err, ErrAlreadyRunning) || time.Now().After(deadline) {
			t.Fatalf("khoá phải tự nhả khi tiến trình thoát: %v", err)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func TestLockFileLivesUnderHomeDirectory(t *testing.T) {
	fakeHome(t)
	lock, err := Acquire()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	home, _ := os.UserHomeDir()
	if _, err := os.Stat(filepath.Join(home, ".xdev-hive", "worker.lock")); err != nil {
		t.Fatal(err)
	}
}
