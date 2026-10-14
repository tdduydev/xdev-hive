//go:build !windows

package localipc

import (
	"fmt"
	"net"
	"os"
)

func checkSameUser(c net.Conn) error {
	uid, err := peerUID(c)
	if err != nil {
		return fmt.Errorf("không đọc được người gọi: %w", err)
	}
	if want := os.Getuid(); uid != want {
		return fmt.Errorf("người gọi có uid %d, worker chạy bằng uid %d", uid, want)
	}
	return nil
}
