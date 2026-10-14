package main

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// localStopWait là thời gian chờ các phiên `hive chat` dừng hẳn khi worker tắt.
const localStopWait = 10 * time.Second

// startLocalIPC mở socket nội bộ cho `hive` (specs/010 T004, T011), trả hàm đóng và Handler ghi phiên lên hub (đệm
// trong recordDir). Không mở được (worker khác đang nghe) thì chỉ ghi log và Handler nil: run từ
// hub vẫn chạy, worker không khai `terminal` với hub vì không có phiên nào để ghi.
func startLocalIPC(pool *accounts.Pool, recordDir string, remote *terminal.Remote) (func(), terminal.Handler) {
	path, err := localipc.DefaultPath()
	if err != nil {
		slog.Warn("Không xác định được đường dẫn socket nội bộ", "error", err)
		return func() {}, nil
	}
	ln, err := localipc.Listen(path)
	if err != nil {
		slog.Warn("Không mở được socket nội bộ; lệnh hive không dùng được", "path", path, "error", err)
		return func() {}, nil
	}
	commands, err := runner.CommandsFromEnv()
	if err != nil {
		slog.Warn("Bỏ qua CLI ghi đè cho phiên tại máy", "error", err)
	}
	recorder := &terminal.Recorder{Dir: recordDir, Logger: slog.Default(), Remote: remote}
	local := &terminal.Local{Accounts: pool, Commands: commands, Logger: slog.Default(), Recorder: recorder, Remote: remote}
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
		recorder.Close()
	}, recorder
}

// newRemote dựng phần điều khiển từ xa của máy: remote.json, totp.json và remote-audit.log nằm cạnh worker.json (thư mục
// của người dùng, không phải thư mục cache) vì đó là quyết định của chủ máy, xoá cache không được làm mất.
func newRemote(cfg config.Config, configPath string, clis []string) *terminal.Remote {
	dir := filepath.Dir(configPath)
	local := []string{}
	for _, c := range clis {
		if slices.Contains(terminal.LocalCLIs, c) {
			local = append(local, c)
		}
	}
	return &terminal.Remote{
		Store:    remoteauth.NewStore(dir),
		Pairings: &remoteauth.Pairings{},
		TOTP:     remoteauth.NewTOTPStore(dir),
		Audit:    &terminal.Audit{Path: filepath.Join(dir, "remote-audit.log")},
		HubURL:   cfg.HubURL,
		Machine:  cfg.MachineID,
		CLIs:     local,
		Logger:   slog.Default(),
	}
}
