package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ClientEvent là body của `POST /api/v1/client-events` (spec 027, ADR 0036). Payload đã là JSON để người gọi giữ đúng
// byte khi gửi lại cùng khoá.
type ClientEvent struct {
	Key       string          `json:"key"`
	Kind      string          `json:"kind"`
	CreatedAt string          `json:"createdAt"`
	Payload   json.RawMessage `json:"payload"`
}

type ClientEventResult struct {
	Key        string `json:"key"`
	Outcome    string `json:"outcome"`
	Code       string `json:"code,omitempty"`
	Reason     string `json:"reason,omitempty"`
	ReceivedAt string `json:"receivedAt"`
}

const (
	OutcomeAccepted  = "accepted"
	OutcomeDuplicate = "duplicate"
	OutcomeRejected  = "rejected"
)

// StatusError là hub trả mã khác 200. Retryable cho biết gửi lại sau có thể được (hub lỗi, quá tải); 400 hay 401 thì
// gửi lại cùng body vẫn hỏng.
type StatusError struct {
	Status  int
	Message string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("hub trả mã %d: %s", e.Status, e.Message)
}

func (e *StatusError) Retryable() bool {
	return e.Status >= 500 || e.Status == http.StatusTooManyRequests || e.Status == http.StatusRequestTimeout
}

// PostClientEvent viết tay thay vì sinh từ openapi.json: sinh lại generated.go phình ra hàng trăm nghìn dòng. Danh tính
// là machine token, hub không đọc tổ chức hay máy từ body.
func PostClientEvent(ctx context.Context, hc *http.Client, baseURL, machineToken string, ev ClientEvent) (ClientEventResult, error) {
	var res ClientEventResult
	body, err := json.Marshal(ev)
	if err != nil {
		return res, err
	}
	url := strings.TrimRight(baseURL, "/") + "/api/v1/client-events"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return res, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+machineToken)
	resp, err := hc.Do(req)
	if err != nil {
		return res, fmt.Errorf("không gọi được hub %s: %w", strings.TrimRight(baseURL, "/"), err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return res, fmt.Errorf("không đọc được trả lời của hub: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return res, &StatusError{Status: resp.StatusCode, Message: errorMessage(data)}
	}
	if err := json.Unmarshal(data, &res); err != nil || res.Outcome == "" {
		// Proxy trả trang HTML với mã 200 thì coi như hub chưa nhận, để lần sau gửi lại.
		return ClientEventResult{}, &StatusError{Status: http.StatusBadGateway, Message: "trả lời của hub không đọc được"}
	}
	return res, nil
}
