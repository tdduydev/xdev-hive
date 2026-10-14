package main

import (
	"context"
	"errors"
	"log/slog"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// localStopWait là thời gian chờ các phiên `hive chat` dừng hẳn khi worker tắt.
const localStopWait = 10 * time.Second

// startLocalIPC mở socket nội bộ cho `hive` (specs/010 T004, T011) và trả hàm đóng. Không mở được (worker khác đang
// nghe, Windows chưa hỗ trợ) thì chỉ ghi log: run từ hub vẫn chạy, chỉ `hive chat` không dùng được.
func startLocalIPC(pool *accounts.Pool) func() {
	path, err := localipc.DefaultPath()
	if err != nil {
		slog.Warn("Không xác định được đường dẫn socket nội bộ", "error", err)
		return func() {}
	}
	ln, err := localipc.Listen(path)
	if err != nil {
		if errors.Is(err, localipc.ErrUnsupported) {
			slog.Info("Socket nội bộ chưa hỗ trợ trên hệ điều hành này; lệnh hive không dùng được")
		} else {
			slog.Warn("Không mở được socket nội bộ; lệnh hive không dùng được", "path", path, "error", err)
		}
		return func() {}
	}
	commands, err := runner.CommandsFromEnv()
	if err != nil {
		slog.Warn("Bỏ qua CLI ghi đè cho phiên tại máy", "error", err)
	}
	local := &terminal.Local{Accounts: pool, Commands: commands, Logger: slog.Default()}
	// Server không theo ctx của worker: lúc tắt phải báo các client đang gắn rằng phiên đã đóng trước khi ngắt kết nối.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv := &localipc.Server{Worker: version.Version, Handler: local.Handle, Logger: slog.Default()}
		if err := srv.Serve(ctx, ln); err != nil {
			slog.Warn("Socket nội bộ dừng", "error", err)
		}
	}()
	slog.Info("Đã mở socket nội bộ cho lệnh hive", "path", path)
	return func() {
		local.CloseAll("hive-worker đang tắt.")
		if !local.Wait(localStopWait) {
			slog.Warn("Còn phiên hive chưa dừng hẳn khi worker tắt")
		}
		cancel()
		<-done
	}
}
