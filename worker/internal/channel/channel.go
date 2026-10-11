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
	"runtime"
	"strings"
	"time"

	"github.com/coder/websocket"
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
	Heartbeat time.Duration
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

// session giữ phiên sau welcome: gửi heartbeat theo chu kỳ hub yêu cầu (hub đóng kết nối nếu ba chu kỳ không nhận gói
// nào) và đọc gói từ hub. Xử lý job (job_offer, cancel…) do module chạy job gắn vào sau.
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
			if conn.Write(ctx, websocket.MessageText, mustJSON(Heartbeat{Type: "heartbeat", V: protocolVersion, ID: id, Runs: []HeartbeatRun{}})) != nil {
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
