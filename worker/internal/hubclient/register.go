package hubclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
)

type RegisterRequest struct {
	RegistrationToken string
	MachineID         string
	OS                string
	Version           string
	CLIs              []string
	Capacity          int
	// PublicKey là khoá Ed25519 của máy (base64url); có thì hub cấp access token ngắn hạn thay cho machine token.
	PublicKey  string
	KeyStorage string
}

type Registration struct {
	ID           string
	OrgID        string
	OrgName      string
	TeamID       string
	MachineID    string
	MachineToken string
}

// Register đổi mã đăng ký (dùng một lần) lấy machine token. Hub chỉ trả token này một lần. Viết tay vì generated.go sinh
// từ hợp đồng cũ, chưa có `keyStorage`.
func (c *HealthClient) Register(ctx context.Context, req RegisterRequest) (Registration, error) {
	body := map[string]any{
		"registrationToken": req.RegistrationToken,
		"machineId":         req.MachineID,
		"os":                req.OS,
		"version":           req.Version,
		"clis":              nonNil(req.CLIs),
		"capacity":          req.Capacity,
	}
	if req.PublicKey != "" {
		body["publicKey"] = req.PublicKey
		body["keyStorage"] = req.KeyStorage
	}
	var r struct {
		ID           string `json:"id"`
		OrgID        string `json:"orgId"`
		OrgName      string `json:"orgName"`
		TeamID       string `json:"teamId"`
		MachineID    string `json:"machineId"`
		MachineToken string `json:"machineToken"`
	}
	if err := c.postJSON(ctx, "/api/v1/worker/register", "", body, &r); err != nil {
		var se *StatusError
		if errors.As(err, &se) {
			return Registration{}, fmt.Errorf("hub từ chối đăng ký (mã %d): %s", se.Status, se.Message)
		}
		return Registration{}, err
	}
	return Registration{ID: r.ID, OrgID: r.OrgID, OrgName: r.OrgName, TeamID: r.TeamID, MachineID: r.MachineID, MachineToken: r.MachineToken}, nil
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// postJSON gửi body JSON, đọc trả lời 200 vào out. Mã khác 200 là StatusError mang message tiếng Việt của hub.
func (c *HealthClient) postJSON(ctx context.Context, path, bearer string, in, out any) error {
	data, err := json.Marshal(in)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return c.do(req, bearer, out)
}

func (c *HealthClient) do(req *http.Request, bearer string, out any) error {
	req.Header.Set("Accept", "application/json")
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	hc := c.hc
	if hc == nil {
		hc = http.DefaultClient
	}
	resp, err := hc.Do(req)
	if err != nil {
		return fmt.Errorf("không gọi được hub %s: %w", c.base, err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return fmt.Errorf("không đọc được trả lời của hub: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return &StatusError{Status: resp.StatusCode, Message: errorMessage(data)}
	}
	if err := json.Unmarshal(data, out); err != nil {
		return &StatusError{Status: http.StatusBadGateway, Message: "trả lời của hub không đọc được"}
	}
	return nil
}

// errorMessage lấy message tiếng Việt hub gửi trong lỗi oRPC; body lạ thì trả nguyên văn để người dùng còn có manh mối.
func errorMessage(body []byte) string {
	var e struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && e.Message != "" {
		return e.Message
	}
	return string(body)
}
