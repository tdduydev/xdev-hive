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

	"nhooyr.io/websocket"
)

const protocolVersion = 1

type Config struct {
	HubURL     string
	Machine    string
	Version    string
	CLIs       []string
	Capacity   int
	Resume     []string
	Logger     *slog.Logger
	HTTP       *http.Client
	MinBackoff time.Duration
	MaxBackoff time.Duration
}

type UpgradeError struct{ Message UpgradeRequired }

func (e *UpgradeError) Error() string {
	return fmt.Sprintf("hub yêu cầu nâng cấp worker: %s", e.Message.URL)
}

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
		if errors.As(err, &upgrade) {
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
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPClient: c.HTTP})
	if err != nil {
		return fmt.Errorf("kết nối WSS tới hub: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "worker ngắt kết nối")
	id, err := messageID()
	if err != nil {
		return err
	}
	hello := Hello{Type: "hello", V: protocolVersion, ID: id, MachineID: c.Machine, Version: c.Version, ProtoRange: [2]int{protocolVersion, protocolVersion}, OS: runtime.GOOS, CLIs: c.CLIs, Capacity: c.Capacity, ResumeRuns: c.Resume}
	if err := conn.Write(ctx, websocket.MessageText, mustJSON(hello)); err != nil {
		return fmt.Errorf("gửi hello: %w", err)
	}
	_, payload, err := conn.Read(ctx)
	if err != nil {
		return fmt.Errorf("chờ phản hồi hub: %w", err)
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
		_, _, err = conn.Read(ctx)
		return fmt.Errorf("hub đã đóng kênh: %w", err)
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
