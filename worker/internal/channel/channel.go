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
	"sync"
	"sync/atomic"
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
	Resume     []string
	Logger     *slog.Logger
	HTTP       *http.Client
	MinBackoff time.Duration
	MaxBackoff time.Duration
	// Heartbeat ghi đè chu kỳ heartbeat hub gửi trong welcome; 0 là theo hub. Chỉ dùng trong test.
	Heartbeat   time.Duration
	DataDir     string
	Project     string
	CLICommands map[string]runner.Command
}

type activeRun struct {
	runID   string
	attempt int
	leaseID string
	cancel  context.CancelFunc
}

func (c Config) sendReject(ctx context.Context, conn *websocket.Conn, mu *sync.Mutex, offer *JobOffer, reason string) {
	id, _ := messageID()
	mu.Lock()
	defer mu.Unlock()
	_ = conn.Write(ctx, websocket.MessageText, mustJSON(JobReject{Type: "job_reject", V: protocolVersion, ID: id, RunID: offer.RunID, Attempt: offer.Attempt, Reason: reason}))
}
func cancelRun(runs map[string]activeRun, mu *sync.Mutex, id string, grace time.Duration) {
	mu.Lock()
	run, ok := runs[id]
	mu.Unlock()
	if ok && run.cancel != nil {
		run.cancel()
		_ = grace
	}
}
func activeCount(runs map[string]activeRun, mu *sync.Mutex) int {
	mu.Lock()
	defer mu.Unlock()
	return len(runs)
}

type jobSpec struct {
	Repo        string `json:"repo"`
	RepoURL     string `json:"repoUrl"`
	Project     string `json:"project"`
	CLI         string `json:"cli"`
	Prompt      string `json:"prompt"`
	BaseBranch  string `json:"baseBranch"`
	Branch      string `json:"branch"`
	TimeoutSec  int    `json:"timeoutSec"`
	SetupScript string `json:"setupScript"`
}

func cliInSpec(raw json.RawMessage, available []string) (string, bool) {
	var s jobSpec
	_ = json.Unmarshal(raw, &s)
	for _, cli := range available {
		if cli == s.CLI {
			return s.CLI, true
		}
	}
	return s.CLI, false
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
	if s.Project != "" {
		project = s.Project
	}
	j := runner.Job{RunID: o.RunID, Attempt: o.Attempt, RepoURL: repo, BaseBranch: s.BaseBranch, Branch: s.Branch, CLI: s.CLI, Prompt: s.Prompt, Timeout: time.Duration(s.TimeoutSec) * time.Second, SetupScript: s.SetupScript, Env: map[string]string{"HIVE_RUN_TOKEN": l.RunToken, "HIVE_HUB_URL": hub, "HIVE_PROJECT": project}}
	if j.BaseBranch == "" {
		j.BaseBranch = "main"
	}
	if j.Branch == "" {
		j.Branch = "ai/" + o.RunID
	}
	return j, nil
}

type durableSink struct {
	mu          sync.Mutex
	dir, hubURL string
	write       func(any) error
	seq         int64
	offset      int64
}

func (s *durableSink) Emit(e runner.Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e.Type == "log" {
		s.offset = e.Offset
	}
	s.seq++
	id, err := messageID()
	if err != nil {
		return err
	}
	var msg any
	switch e.Type {
	case "log":
		msg = LogChunk{Type: "log_chunk", V: protocolVersion, ID: id, RunID: e.RunID, Attempt: e.Attempt, Seq: s.seq, Offset: e.Offset, Bytes: e.Data}
	case "result":
		b, _ := json.Marshal(e.Result)
		var report json.RawMessage = b
		var sha *string
		exit := 1
		if e.Result != nil {
			if e.Result.HeadSHA != "" {
				v := e.Result.HeadSHA
				sha = &v
			}
			if e.Result.Status == "succeeded" || e.Result.Status == "no_changes" {
				exit = 0
			}
		}
		msg = RunResult{Type: "run_result", V: protocolVersion, ID: id, RunID: e.RunID, Attempt: e.Attempt, Seq: s.seq, Exit: exit, HeadSHA: sha, Report: report}
	default:
		data, _ := json.Marshal(map[string]any{"phase": e.Phase, "event": e.Type})
		msg = RunEvent{Type: "run_event", V: protocolVersion, ID: id, RunID: e.RunID, Attempt: e.Attempt, Seq: s.seq, Event: e.Type, Data: data}
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	file := filepath.Join(s.dir, fmt.Sprintf("%s-%d-%020d.json", safeID(e.RunID), e.Attempt, s.seq))
	if err = os.WriteFile(file, b, 0600); err != nil {
		return err
	}
	return s.write(msg)
}
func safeID(s string) string { return strings.ReplaceAll(s, "/", "_") }
func pendingMessages(dir string) []json.RawMessage {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	out := make([]json.RawMessage, 0, len(files))
	for _, f := range files {
		b, e := os.ReadFile(f)
		if e == nil {
			out = append(out, b)
		}
	}
	return out
}
func queuedRunIDs(dir string) []string {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	set := map[string]bool{}
	for _, f := range files {
		var e Envelope
		b, _ := os.ReadFile(f)
		_ = json.Unmarshal(b, &e)
		var v struct {
			RunID string `json:"runId"`
		}
		_ = json.Unmarshal(b, &v)
		if v.RunID != "" {
			set[v.RunID] = true
		}
	}
	out := []string{}
	for id := range set {
		out = append(out, id)
	}
	return out
}
func ackPending(dir, run string, upto int64) {
	files, _ := filepath.Glob(filepath.Join(dir, fmt.Sprintf("%s-*-*.json", safeID(run))))
	for _, f := range files {
		var m struct {
			Seq int64 `json:"seq"`
		}
		b, _ := os.ReadFile(f)
		_ = json.Unmarshal(b, &m)
		if m.Seq <= upto {
			_ = os.Remove(f)
		}
	}
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
	if err := runner.ReapOrphans(c.DataDir, queuedRunIDs(c.DataDir)); err != nil {
		return fmt.Errorf("dọn run cũ: %w", err)
	}
	c.Resume = queuedRunIDs(c.DataDir)
	if c.MinBackoff <= 0 {
		c.MinBackoff = time.Second
	}
	if c.MaxBackoff <= 0 {
		c.MaxBackoff = 30 * time.Second
	}
	if c.MaxBackoff < c.MinBackoff {
		c.MaxBackoff = c.MinBackoff
	}
	backoff := c.MinBackoff
	for {
		if err := ctx.Err(); err != nil {
			return nil
		}
		err := c.connect(ctx)
		var upgrade *UpgradeError
		var rejected *RejectedError
		if errors.As(err, &upgrade) || errors.As(err, &rejected) {
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		c.Logger.Warn("Kênh worker mất kết nối, sẽ thử lại", "error", err)
		delay := time.Duration(rand.Int64N(int64(backoff) + 1))
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
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

func (c Config) connect(ctx context.Context) error {
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
	hello := Hello{Type: "hello", V: protocolVersion, ID: id, MachineID: c.Machine, Version: c.Version, ProtoRange: [2]int{protocolVersion, protocolVersion}, OS: runtime.GOOS, CLIs: nonNil(c.CLIs), Capacity: c.Capacity, ResumeRuns: nonNil(c.Resume)}
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
		return c.session(ctx, conn, welcome)
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

func (c Config) session(ctx context.Context, conn *websocket.Conn, welcome Welcome) error {
	interval := c.Heartbeat
	if interval <= 0 {
		interval = time.Duration(welcome.HeartbeatSec) * time.Second
	}
	if interval <= 0 {
		interval = 30 * time.Second
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var writeMu sync.Mutex
	write := func(v any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		return conn.Write(ctx, websocket.MessageText, mustJSON(v))
	}
	active := map[string]activeRun{}
	var activeMu sync.Mutex
	pendingLease := map[string]func(Lease){}
	var drainingNow atomic.Bool
	for _, p := range pendingMessages(c.DataDir) {
		if err := write(p); err != nil {
			return fmt.Errorf("gửi lại gói chờ ack: %w", err)
		}
	}
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
			id, err := messageID()
			if err != nil {
				return
			}
			// Lỗi ghi sẽ hiện ra ở conn.Read bên dưới, nên không cần báo riêng.
			activeMu.Lock()
			runs := make([]HeartbeatRun, 0, len(active))
			for _, a := range active {
				runs = append(runs, HeartbeatRun{RunID: a.runID, Attempt: a.attempt, LeaseID: a.leaseID})
			}
			load := len(runs)
			activeMu.Unlock()
			if write(Heartbeat{Type: "heartbeat", V: protocolVersion, ID: id, Load: load, Runs: runs}) != nil {
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
			for _, runID := range m.Cancel {
				cancelRun(active, &activeMu, runID, 10*time.Second)
			}
		case *JobOffer:
			if drainingNow.Load() {
				c.sendReject(ctx, conn, &writeMu, m, "máy đang thoát")
				continue
			}
			activeMu.Lock()
			available := len(active)+len(pendingLease) < c.Capacity
			_, hasCLI := cliInSpec(m.Spec, c.CLIs)
			activeMu.Unlock()
			if !available {
				c.sendReject(ctx, conn, &writeMu, m, "máy đã đầy")
				continue
			}
			if !hasCLI {
				c.sendReject(ctx, conn, &writeMu, m, "không có CLI được yêu cầu")
				continue
			}
			id, _ := messageID()
			if err := write(JobAccept{Type: "job_accept", V: protocolVersion, ID: id, RunID: m.RunID, Attempt: m.Attempt}); err != nil {
				return err
			}
			pendingLease[m.RunID] = func(lease Lease) {
				runCtx, runCancel := context.WithCancel(ctx)
				activeMu.Lock()
				active[m.RunID] = activeRun{runID: m.RunID, attempt: m.Attempt, leaseID: lease.LeaseID, cancel: runCancel}
				activeMu.Unlock()
				job, err := decodeJob(m, lease, c.HubURL, c.Project)
				if err != nil {
					c.Logger.Error("Job không hợp lệ", "run", m.RunID, "error", err)
					runCancel()
					return
				}
				sink := &durableSink{dir: filepath.Join(c.DataDir, "pending"), hubURL: c.HubURL, write: write}
				_ = (runner.Runner{DataDir: c.DataDir, CLICommands: c.CLICommands}).Run(runCtx, job, sink)
				activeMu.Lock()
				delete(active, m.RunID)
				activeMu.Unlock()
				runCancel()
				if drainingNow.Load() && activeCount(active, &activeMu) == 0 {
					cancel()
				}
			}
		case *Lease:
			if run := pendingLease[m.RunID]; run != nil {
				delete(pendingLease, m.RunID)
				go run(*m)
			}
		case *Ack:
			ackPending(c.DataDir, m.RunID, m.UptoSeq)
		case *Cancel:
			cancelRun(active, &activeMu, m.RunID, time.Duration(m.GraceSec)*time.Second)
		case *Drain:
			drainingNow.Store(true)
			if activeCount(active, &activeMu) == 0 {
				cancel()
			}
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
