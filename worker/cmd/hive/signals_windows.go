//go:build windows

package main

import (
	"os"
	"os/signal"
)

// notifySignals: Windows không có SIGWINCH nên chưa đổi cỡ theo cửa sổ (cỡ chỉ gửi lúc gắn); đóng console là tách.
func notifySignals() (<-chan os.Signal, <-chan os.Signal, func()) {
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt)
	return nil, quit, func() { signal.Stop(quit) }
}
