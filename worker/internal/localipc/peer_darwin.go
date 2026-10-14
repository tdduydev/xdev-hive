//go:build darwin

package localipc

import (
	"errors"
	"net"

	"golang.org/x/sys/unix"
)

// peerUID đọc UID của tiến trình đầu kia bằng LOCAL_PEERCRED (cùng nguồn với getpeereid): nhân ghi lúc connect, client
// không giả được.
func peerUID(c net.Conn) (int, error) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, errors.New("không phải unix socket")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, err
	}
	var cred *unix.Xucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
	}); err != nil {
		return 0, err
	}
	if credErr != nil {
		return 0, credErr
	}
	return int(cred.Uid), nil
}
