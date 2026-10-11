package hubclient

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
)

type RegisterRequest struct {
	RegistrationToken string
	MachineID         string
	OS                string
	Version           string
	CLIs              []string
	Capacity          int
}

type Registration struct {
	ID           string
	OrgID        string
	TeamID       string
	MachineID    string
	MachineToken string
}

// Register đổi mã đăng ký (dùng một lần) lấy machine token. Hub chỉ trả token này một lần.
func (c *HealthClient) Register(ctx context.Context, req RegisterRequest) (Registration, error) {
	clis := make([]WorkerRegisterJSONBodyClis, len(req.CLIs))
	for i, cli := range req.CLIs {
		clis[i] = WorkerRegisterJSONBodyClis(cli)
	}
	capacity := req.Capacity
	response, err := c.client.WorkerRegisterWithResponse(ctx, WorkerRegisterJSONRequestBody{
		RegistrationToken: req.RegistrationToken,
		MachineId:         req.MachineID,
		Os:                WorkerRegisterJSONBodyOs(req.OS),
		Version:           req.Version,
		Clis:              &clis,
		Capacity:          &capacity,
	})
	if err != nil {
		return Registration{}, fmt.Errorf("không gọi được hub %s: %w", c.base, err)
	}
	if response.StatusCode() != http.StatusOK || response.JSON200 == nil {
		return Registration{}, fmt.Errorf("hub từ chối đăng ký (mã %d): %s", response.StatusCode(), errorMessage(response.Body))
	}
	r := response.JSON200
	return Registration{ID: r.Id.String(), OrgID: r.OrgId.String(), TeamID: r.TeamId.String(), MachineID: r.MachineId, MachineToken: r.MachineToken}, nil
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
