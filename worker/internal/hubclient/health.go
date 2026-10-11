// Package hubclient gọi API OpenAPI của hub. Ở M3 phần này được sinh từ packages/contracts/openapi.json bằng oapi-codegen.
package hubclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Health là kết quả của GET /api/v1/health.
type Health struct {
	Status  string    `json:"status"`
	Version string    `json:"version"`
	Time    time.Time `json:"time"`
}

// Client gọi hub qua HTTP.
type Client struct {
	BaseURL string
	HTTP    *http.Client
}

// New tạo client với timeout ngắn: kiểm tra sức khoẻ không được treo dịch vụ nền.
func New(baseURL string) *Client {
	return &Client{BaseURL: strings.TrimRight(baseURL, "/"), HTTP: &http.Client{Timeout: 10 * time.Second}}
}

// Health hỏi trạng thái hub.
func (c *Client) Health(ctx context.Context) (Health, error) {
	var h Health
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.BaseURL+"/api/v1/health", nil)
	if err != nil {
		return h, err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return h, fmt.Errorf("không gọi được hub %s: %w", c.BaseURL, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return h, fmt.Errorf("hub trả mã %d", res.StatusCode)
	}
	if err := json.NewDecoder(res.Body).Decode(&h); err != nil {
		return h, fmt.Errorf("đọc phản hồi của hub: %w", err)
	}
	if h.Status != "ok" {
		return h, fmt.Errorf("hub báo trạng thái %q", h.Status)
	}
	return h, nil
}
