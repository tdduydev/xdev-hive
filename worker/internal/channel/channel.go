package channel

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const protocolVersion = 1

type Config struct {
	HubURL  string
	Machine string
	// Token là machine token nhận khi đăng ký, gửi trong header Authorization lúc mở WSS.
	Token      string
	Version    string
	CLIs       []string
	Capacity   int
	Logger     *slog.Logger
	HTTP       *http.Client
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// Heartbeat ghi đè chu kỳ heartbeat hub gửi trong welcome; 0 là theo hub. Chỉ dùng trong test.
	Heartbeat time.Duration
	// DataDir chứa repo cache, worktree của run, gói chờ ack (pending) và marker run đang chạy (active).
	DataDir string
	// Project là project key mặc định cho HIVE_PROJECT khi spec của job không có.
	Project     string
	CLICommands map[string]runner.Command
	// StopTimeout là thời gian chờ run đang chạy dừng hẳn khi worker tắt; 0 là 30 giây.
	StopTimeout time.Duration
	// OnStatus nhận trạng thái kết nối, để app desktop hiện trên khay hệ thống (hive-worker run --status-json).
	OnStatus func(Status)
}

// Status là trạng thái kết nối tới hub. Error chỉ có khi State là "disconnected" hoặc "stopped" vì lỗi.
type Status struct {
	State string `json:"status"`
	Error string `json:"error,omitempty"`
}

func (c Config) status(state string, err error) {
	if c.OnStatus == nil {
		return
	}
	s := Status{State: state}
	if err != nil {
		s.Error = err.Error()
	}
	c.OnStatus(s)
}

type jobSpec struct {
	Repo        string `json:"repo"`
	RepoURL     string `json:"repoUrl"`
	Project     string `json:"project"`
	ProjectKey  string `json:"projectKey"`
	CLI         string `json:"cli"`
	Prompt      string `json:"prompt"`
	BaseBranch  string `json:"baseBranch"`
	Branch      string `json:"branch"`
	TimeoutSec  int    `json:"timeoutSec"`
	SetupScript string `json:"setupScript"`
}

func decodeJob(o *JobOffer, l Lease, hub, project string) (runner.Job, error) {
	var s jobSpec
	if err := json.Unmarshal(o.Spec, &s); err != nil {
		return runner.Job{}, err
	}
	repo := s.RepoURL
	if repo == "" {
		repo = s.Repo
	}
	if repo != "" && !strings.Contains(repo, "://") && !strings.HasPrefix(repo, "git@") {
		repo = "https://github.com/" + strings.Trim(repo, "/") + ".git"
	}
	switch {
	case s.ProjectKey != "":
		project = s.ProjectKey
	case s.Project != "":
		project = s.Project
	}
	// Template .mcp.json của dự án đọc HIVE_MCP_TOKEN; hub và tài liệu gọi là HIVE_RUN_TOKEN. Đặt cả hai.
	env := map[string]string{"HIVE_RUN_TOKEN": l.RunToken, "HIVE_MCP_TOKEN": l.RunToken, "HIVE_HUB_URL": hub, "HIVE_PROJECT": project}
	j := runner.Job{RunID: o.RunID, Attempt: o.Attempt, RepoURL: repo, BaseBranch: s.BaseBranch, Branch: s.Branch, CLI: s.CLI, Prompt: s.Prompt, Timeout: time.Duration(s.TimeoutSec) * time.Second, SetupScript: s.SetupScript, Env: env}
	if j.BaseBranch == "" {
		j.BaseBranch = "main"
	}
	if j.Branch == "" {
		j.Branch = "ai/" + o.RunID
	}
	return j, nil
}

type UpgradeError struct{ Message UpgradeRequired }

func (e *UpgradeError) Error() string {
	return fmt.Sprintf("hub yêu cầu nâng cấp worker: %s", e.Message.URL)
}

// RejectedError là khi hub từ chối máy theo cách nối lại cũng không khỏi (token sai, máy bị thu hồi, giao thức lệch).
// Run dừng thay vì thử lại mãi.
type RejectedError struct {
	Code   int
	Reason string
}

func (e *RejectedError) Error() string {
	return fmt.Sprintf("hub từ chối máy (mã %d): %s", e.Code, e.Reason)
}

// Mã đóng kết nối hub dùng khi nối lại vô ích (apps/hub/src/modules/fleet/gateway.ts).
var fatalCloseCodes = map[websocket.StatusCode]bool{4401: true, 4403: true, 4426: true}

func (c Config) Run(ctx context.Context) error {
	if c.Machine == "" {
		return errors.New("machine ID không được để trống")
	}
	if c.Logger == nil {
		c.Logger = slog.Default()
	}
	if c.DataDir == "" {
		d, err := os.UserCacheDir()
		if err != nil {
			return err
		}
		c.DataDir = filepath.Join(d, "xdev-hive", "worker")
	}
	if err := os.MkdirAll(filepath.Join(c.DataDir, "pending"), 0700); err != nil {
		return err
	}
	if err := recoverInterrupted(c.DataDir, c.Logger); err != nil {
		return fmt.Errorf("khôi phục run bị ngắt: %w", err)
	}
	// Vừa khởi động thì không còn CLI nào chạy: mọi worktree còn lại là của run đã chết.
	if err := runner.ReapOrphans(c.DataDir, nil); err != nil {
		return fmt.Errorf("dọn run cũ: %w", err)
	}
	if c.MinBackoff <= 0 {
		c.MinBackoff = time.Second
	}
	if c.MaxBackoff <= 0 {
		c.MaxBackoff = 30 * time.Second
	}
	if c.MaxBackoff < c.MinBackoff {
		c.MaxBackoff = c.MinBackoff
	}
	if c.StopTimeout <= 0 {
		c.StopTimeout = 30 * time.Second
	}
	jobs := newJobs(ctx, c)
	// Worker tắt (Ctrl-C, dịch vụ dừng): run nhận lệnh huỷ theo ctx, chờ chúng ghi kết quả xuống đĩa rồi mới thoát.
	defer jobs.wait(c.StopTimeout)
	backoff := c.MinBackoff
	for {
		if ctx.Err() != nil || jobs.finished() {
			return nil
		}
		c.status("connecting", nil)
		err := c.connect(ctx, jobs)
		var upgrade *UpgradeError
		var rejected *RejectedError
		if errors.As(err, &upgrade) || errors.As(err, &rejected) {
			c.status("stopped", err)
			return err
		}
		if ctx.Err() != nil || jobs.finished() {
			c.status("stopped", nil)
			return nil
		}
		c.status("disconnected", err)
		c.Logger.Warn("Kênh worker mất kết nối, sẽ thử lại", "error", err)
		delay := time.Duration(rand.Int64N(int64(backoff) + 1))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-jobs.done:
			timer.Stop()
			return nil
		case <-timer.C:
		}
		backoff *= 2
		if backoff > c.MaxBackoff {
			backoff = c.MaxBackoff
		}
	}
}

func (c Config) connect(ctx context.Context, jobs *jobs) error {
	url, err := websocketURL(c.HubURL)
	if err != nil {
		return err
	}
	header := http.Header{}
	if c.Token != "" {
		header.Set("Authorization", "Bearer "+c.Token)
	}
	conn, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: c.HTTP, HTTPHeader: header})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return &RejectedError{Code: resp.StatusCode, Reason: "machine token không hợp lệ hoặc đã bị thu hồi; chạy lại `hive-worker register`"}
		}
		return fmt.Errorf("kết nối WSS tới hub: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "worker ngắt kết nối")
	id, err := messageID()
	if err != nil {
		return err
	}
	// Hub đòi mảng, không nhận null; slice nil của Go mã hoá thành null.
	hello := Hello{Type: "hello", V: protocolVersion, ID: id, MachineID: c.Machine, Version: c.Version, ProtoRange: [2]int{protocolVersion, protocolVersion}, OS: runtime.GOOS, CLIs: nonNil(c.CLIs), Capacity: c.Capacity, ResumeRuns: jobs.runIDs()}
	if err := conn.Write(ctx, websocket.MessageText, mustJSON(hello)); err != nil {
		return fmt.Errorf("gửi hello: %w", err)
	}
	_, payload, err := conn.Read(ctx)
	if err != nil {
		return closeError("chờ phản hồi hub", err)
	}
	var envelope struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return fmt.Errorf("đọc phản hồi hub: %w", err)
	}
	switch envelope.Type {
	case "welcome":
		var welcome Welcome
		if err := json.Unmarshal(payload, &welcome); err != nil {
			return err
		}
		c.Logger.Info("Đã kết nối hub", "sessionId", welcome.SessionID, "heartbeatSec", welcome.HeartbeatSec)
		c.status("online", nil)
		return c.session(ctx, conn, welcome, jobs)
	case "upgrade_required":
		var upgrade UpgradeRequired
		if err := json.Unmarshal(payload, &upgrade); err != nil {
			return err
		}
		return &UpgradeError{Message: upgrade}
	default:
		return fmt.Errorf("hub gửi gói không hỗ trợ %q", envelope.Type)
	}
}

func (c Config) session(ctx context.Context, conn *websocket.Conn, welcome Welcome, jobs *jobs) error {
	interval := c.Heartbeat
	if interval <= 0 {
		interval = time.Duration(welcome.HeartbeatSec) * time.Second
	}
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		// Drain xong thì đóng phiên để Run thoát.
		select {
		case <-jobs.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	if err := jobs.attach(ctx, conn); err != nil {
		return err
	}
	defer jobs.detach(conn)
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			// Lỗi ghi sẽ hiện ra ở conn.Read bên dưới, nên không cần báo riêng.
			if jobs.write(jobs.heartbeat()) != nil {
				return
			}
		}
	}()
	for {
		_, payload, err := conn.Read(ctx)
		if err != nil {
			return closeError("hub đã đóng kênh", err)
		}
		msg, err := Decode(payload)
		if err != nil {
			c.Logger.Warn("Bỏ qua gói không đọc được từ hub", "error", err)
			continue
		}
		switch m := msg.(type) {
		case *HeartbeatAck:
			c.Logger.Debug("Hub xác nhận heartbeat", "renewed", m.Renewed, "cancel", m.Cancel)
			// Lease không còn (hết hạn, run đã giao máy khác, đang huỷ): dừng run, kết quả của nó hub sẽ bỏ.
			for _, runID := range m.Cancel {
				jobs.cancel(runID, defaultGrace)
			}
		case *JobOffer:
			jobs.onOffer(m)
		case *Lease:
			jobs.onLease(m)
		case *Ack:
			ackPending(jobs.pending, m.RunID, m.UptoSeq)
		case *Cancel:
			jobs.cancel(m.RunID, time.Duration(m.GraceSec)*time.Second)
		case *Drain:
			c.Logger.Info("Hub yêu cầu thoát: không nhận job mới, chờ run đang chạy xong")
			jobs.drain()
		case *Steer:
			// CLI chạy không tương tác (-p, exec) nên chưa nhận thêm chỉ dẫn giữa chừng; hub đưa chỉ dẫn vào lần chạy sau.
			c.Logger.Info("Chưa hỗ trợ chỉ dẫn cho run đang chạy", "run", m.RunID)
		default:
			c.Logger.Info("Chưa xử lý gói từ hub", "type", fmt.Sprintf("%T", m))
		}
	}
}

// closeError đổi lỗi đọc thành RejectedError khi hub đóng bằng mã cho biết nối lại vô ích.
func closeError(what string, err error) error {
	var ce websocket.CloseError
	if errors.As(err, &ce) && fatalCloseCodes[ce.Code] {
		return &RejectedError{Code: int(ce.Code), Reason: ce.Reason}
	}
	return fmt.Errorf("%s: %w", what, err)
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func websocketURL(base string) (string, error) {
	base = strings.TrimRight(base, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	case strings.HasPrefix(base, "ws://"), strings.HasPrefix(base, "wss://"):
	default:
		return "", fmt.Errorf("địa chỉ hub không hợp lệ: %s", base)
	}
	return base + "/ws/worker", nil
}

func messageID() (string, error) {
	var b [16]byte
	if _, err := cryptorand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func mustJSON(v any) []byte { b, _ := json.Marshal(v); return b }
