package hubclient

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type Health struct {
	Status  string
	Version string
	Time    time.Time
}

type HealthClient struct {
	client *ClientWithResponses
	base   string
}

func New(baseURL string) *HealthClient {
	baseURL = strings.TrimRight(baseURL, "/")
	client, _ := NewClientWithResponses(baseURL+"/api", WithHTTPClient(&http.Client{Timeout: 10 * time.Second}))
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
	return health, nil
}
