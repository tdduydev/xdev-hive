//go:build windows

package localipc

import (
	"errors"
	"net"
	"time"
)

// Supported: Windows chưa có socket nội bộ. Bản dự định là named pipe \\.\pipe\xdev-hive-<SID> với DACL chỉ SID hiện
// tại và kiểm SID của client; chưa làm thì không mở gì, vì pipe thiếu DACL cho mọi người dùng trên máy điều khiển phiên.
const Supported = false

// ErrUnsupported: Windows chưa có socket nội bộ.
var ErrUnsupported = errors.New("socket nội bộ của hive-worker chưa hỗ trợ trên Windows")

func Listen(string) (net.Listener, error) { return nil, ErrUnsupported }

func dialSocket(string, time.Duration) (net.Conn, error) { return nil, ErrUnsupported }
