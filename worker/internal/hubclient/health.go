package hubclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/hubtls"
)

// LegacyCLIs là CLI mọi hub đều nhận. Hub chưa trả `clis` trong health kiểm hello và đăng ký máy bằng enum chỉ có
// những CLI này, nên khai CLI khác với hub đó thì máy bị từ chối.
var LegacyCLIs = []string{"claude", "codex", "gemini"}

type Health struct {
	Status  string
	Version string
	Time    time.Time
	// CLIs là CLI hub giao run được; nil khi hub cũ không trả.
	CLIs []string
}

type HealthClient struct {
	client *ClientWithResponses
	base   string
}

func New(baseURL string) *HealthClient {
	return NewWithHTTP(baseURL, hubtls.NewClient(10*time.Second))
}

// NewWithHTTP dùng http.Client của người gọi (vd. kênh WSS dùng chung client với cấu hình TLS riêng).
func NewWithHTTP(baseURL string, hc *http.Client) *HealthClient {
	baseURL = strings.TrimRight(baseURL, "/")
	client, _ := NewClientWithResponses(baseURL+"/api", WithHTTPClient(hc))
	return &HealthClient{client: client, base: baseURL}
}

func (c *HealthClient) Health(ctx context.Context) (Health, error) {
	var health Health
	response, err := c.client.SystemHealthWithResponse(ctx)
	if err != nil {
		return health, fmt.Errorf("không gọi được hub %s: %w", c.base, err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil {
		return health, fmt.Errorf("hub trả mã %d", response.StatusCode())
	}
	status, _ := response.JSON200.Status.(string)
	health = Health{Status: status, Version: response.JSON200.Version, Time: response.JSON200.Time}
	if health.Status != "ok" {
		return Health{}, fmt.Errorf("hub báo trạng thái %q", health.Status)
	}
	// generated.go sinh từ openapi.json trước khi health có `clis`, nên đọc trường này từ body.
	var extra struct {
		CLIs []string `json:"clis"`
	}
	if json.Unmarshal(response.Body, &extra) == nil {
		health.CLIs = extra.CLIs
	}
	return health, nil
}

// SupportedCLIs tách CLI máy có thành CLI hub nhận (kept, không bao giờ nil) và CLI hub chưa biết (dropped). Chỉ hỏi
// health khi máy có CLI ngoài LegacyCLIs; hub cũ hay không gọi được hub thì chỉ giữ LegacyCLIs.
func (c *HealthClient) SupportedCLIs(ctx context.Context, detected []string) (kept, dropped []string) {
	known := LegacyCLIs
	if slices.ContainsFunc(detected, func(cli string) bool { return !slices.Contains(LegacyCLIs, cli) }) {
		if h, err := c.Health(ctx); err == nil && h.CLIs != nil {
			known = h.CLIs
		}
	}
	kept = []string{}
	for _, cli := range detected {
		if slices.Contains(known, cli) {
			kept = append(kept, cli)
		} else {
			dropped = append(dropped, cli)
		}
	}
	return kept, dropped
}
