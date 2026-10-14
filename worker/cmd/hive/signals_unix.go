//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
)

// notifySignals: SIGWINCH đổi cỡ phiên; SIGTERM/SIGHUP (đóng cửa sổ terminal) là tách, để terminal được trả về chế
// độ cũ và phiên chạy tiếp.
func notifySignals() (<-chan os.Signal, <-chan os.Signal, func()) {
	resize := make(chan os.Signal, 1)
	quit := make(chan os.Signal, 1)
	signal.Notify(resize, syscall.SIGWINCH)
	signal.Notify(quit, syscall.SIGTERM, syscall.SIGHUP)
	return resize, quit, func() { signal.Stop(resize); signal.Stop(quit) }
}
