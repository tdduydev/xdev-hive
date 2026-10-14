//go:build !linux && !darwin

package localipc

import (
	"errors"
	"net"
)

// peerUID: hệ điều hành chưa có cách đọc người gọi thì từ chối mọi kết nối, không mở cửa cho người dùng khác.
func peerUID(net.Conn) (int, error) {
	return 0, errors.New("chưa kiểm được người gọi trên hệ điều hành này")
}
