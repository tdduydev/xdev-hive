package main

import (
	"context"
	"log/slog"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/terminal"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// localStopWait là thời gian chờ các phiên `hive chat` dừng hẳn khi worker tắt.
const localStopWait = 10 * time.Second

// Người đang giữ worker, để cửa sổ VS Code biết worker ở máy là của app desktop, của cửa sổ khác hay chạy tay
// (specs/017 mục 7). Giá trị lạ bị từ chối ngay ở cờ --owner thay vì lọt ra client.
const (
	ownerDesktop = "desktop"
	ownerVSCode  = "vscode"
	ownerCLI     = "cli"
)

func validOwner(s string) bool { return s == ownerDesktop || s == ownerVSCode || s == ownerCLI }

// workerStatus là nguồn của op `worker.status` (specs/017 T006): trạng thái kênh tới hub do channel báo qua OnStatus,
// còn lại là thông tin cố định lúc worker khởi động.
type workerStatus struct {
	owner      string
	machineID  string
	registered bool
	// activeDir chứa marker của run đang chạy (channel ghi lúc bắt đầu, xoá lúc xong); đếm marker để khỏi mở kênh
	// nội bộ giữa channel và socket chỉ để lấy một con số.
	activeDir string

	mu    sync.Mutex
	state string
}

func newWorkerStatus(cfg config.Config, owner, dataDir string) *workerStatus {
	return &workerStatus{
		owner:      owner,
		machineID:  cfg.MachineID,
		registered: cfg.Registered(),
		activeDir:  filepath.Join(dataDir, "xdev-hive", "worker", "active"),
		state:      "starting",
	}
}

// observe trả callback OnStatus ghi lại trạng thái rồi chuyển tiếp cho next (có thể nil, ví dụ không có --status-json).
func (w *workerStatus) observe(next func(channel.Status)) func(channel.Status) {
	return func(s channel.Status) {
		w.mu.Lock()
		w.state = s.State
		w.mu.Unlock()
		if next != nil {
			next(s)
		}
	}
}

func (w *workerStatus) reply(c *localipc.Conn) error {
	w.mu.Lock()
	state := w.state
	w.mu.Unlock()
	markers, _ := filepath.Glob(filepath.Join(w.activeDir, "*.json"))
	return c.OK(map[string]any{
		"state":        state,
		"hubConnected": state == "online",
		"registered":   w.registered,
		"machineId":    w.machineID,
		"version":      version.Version,
		"runs":         len(markers),
		"owner":        w.owner,
	})
}

// startLocalIPC mở socket nội bộ cho `hive` (specs/010 T004, T011), trả hàm đóng và Handler ghi phiên lên hub (đệm
// trong recordDir). Không mở được (worker khác đang nghe) thì chỉ ghi log và Handler nil: run từ
// hub vẫn chạy, worker không khai `terminal` với hub vì không có phiên nào để ghi. status nil thì socket không nhận
// op worker.status; ob nil thì không nhận op `outbox.*`.
func startLocalIPC(pool *accounts.Pool, recordDir string, remote *terminal.Remote, status *workerStatus, ob *outboxService) (func(), terminal.Handler) {
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
	if remote != nil {
		ctl := &terminal.Controller{Local: local, Remote: remote, Recorder: recorder, Logger: slog.Default(),
			Verifier: &remoteauth.Verifier{Devices: remote.Store, TOTP: remote.TOTP}}
		recorder.Controller, local.Controller, remote.Controller = ctl, ctl, ctl
		if ob != nil {
			ob.setNotify(remote.Notify)
		}
	}
	handle := func(ctx context.Context, c *localipc.Conn, req localipc.Request) error {
		switch {
		case req.Op == "worker.status" && status != nil:
			return status.reply(c)
		case strings.HasPrefix(req.Op, "outbox.") && ob != nil:
			return ob.handle(ctx, c, req)
		}
		return local.Handle(ctx, c, req)
	}
	// Server không theo ctx của worker: lúc tắt phải báo các client đang gắn rằng phiên đã đóng trước khi ngắt kết nối.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv := &localipc.Server{Worker: version.Version, Handler: handle, Logger: slog.Default()}
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
