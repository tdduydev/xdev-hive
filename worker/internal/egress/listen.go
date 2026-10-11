package egress

import (
	"fmt"
	"net"
	"os"
)

// Listen never unlinks an existing socket: it may belong to another run's proxy.
func Listen(tcpAddress, socketPath string) ([]net.Listener, error) {
	var listeners []net.Listener
	cleanup := func() {
		for _, listener := range listeners {
			_ = listener.Close()
		}
	}
	if tcpAddress != "" {
		listener, err := net.Listen("tcp", tcpAddress)
		if err != nil {
			return nil, fmt.Errorf("không nghe được TCP: %w", err)
		}
		listeners = append(listeners, listener)
	}
	if socketPath != "" {
		listener, err := net.Listen("unix", socketPath)
		if err != nil {
			cleanup()
			return nil, fmt.Errorf("không nghe được unix socket: %w", err)
		}
		listeners = append(listeners, listener)
		if err := os.Chmod(socketPath, 0o600); err != nil {
			cleanup()
			return nil, fmt.Errorf("không đặt được quyền unix socket: %w", err)
		}
	}
	if len(listeners) == 0 {
		return nil, fmt.Errorf("cần --listen hoặc --unix-socket")
	}
	return listeners, nil
}
