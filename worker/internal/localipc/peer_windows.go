//go:build windows

package localipc

import (
	"errors"
	"fmt"
	"net"

	"golang.org/x/sys/windows"
)

func checkSameUser(c net.Conn) error {
	h, err := pipeHandle(c)
	if err != nil {
		return err
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(h, &pid); err != nil {
		return fmt.Errorf("không đọc được người gọi: %w", err)
	}
	return samePIDUser(pid, "người gọi")
}

func pipeHandle(c net.Conn) (windows.Handle, error) {
	f, ok := c.(interface{ Fd() uintptr })
	if !ok {
		return 0, errors.New("không phải named pipe")
	}
	return windows.Handle(f.Fd()), nil
}

func currentSID() (*windows.SID, error) {
	u, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, fmt.Errorf("không đọc được người dùng hiện tại: %w", err)
	}
	return u.User.Sid, nil
}

// samePIDUser so SID trong token của tiến trình pid với SID hiện tại. Không mở được tiến trình (thường vì thuộc người
// khác) thì coi là khác người dùng.
func samePIDUser(pid uint32, who string) error {
	want, err := currentSID()
	if err != nil {
		return err
	}
	p, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return fmt.Errorf("không mở được %s (pid %d): %w", who, pid, err)
	}
	defer windows.CloseHandle(p)
	var tok windows.Token
	if err := windows.OpenProcessToken(p, windows.TOKEN_QUERY, &tok); err != nil {
		return fmt.Errorf("không đọc được token của %s (pid %d): %w", who, pid, err)
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return fmt.Errorf("không đọc được người dùng của %s (pid %d): %w", who, pid, err)
	}
	if !u.User.Sid.Equals(want) {
		return fmt.Errorf("%s chạy bằng %s, worker chạy bằng %s", who, u.User.Sid, want)
	}
	return nil
}
