package hubclient

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"sync"
	"time"
)

// RefreshBefore là khoảng đổi access token trước khi hết hạn: đủ cho một lần thử lại khi hub chậm, mà kết nối vẫn
// không bị đóng 4401 (spec 027 US3).
const RefreshBefore = 2 * time.Minute

// RegisterKey gửi khoá của máy đã đăng ký bằng machine token (máy cài trước spec 027). Hub trả id máy; từ đó machine
// token không dùng được nữa.
func (c *HealthClient) RegisterKey(ctx context.Context, machineToken, publicKey, keyStorage string) (string, error) {
	var r struct {
		MachineID string `json:"machineId"`
	}
	err := c.postJSON(ctx, "/api/v1/worker/key", machineToken, map[string]string{"publicKey": publicKey, "keyStorage": keyStorage}, &r)
	return r.MachineID, err
}

// Challenge xin nonce 60 giây để ký.
func (c *HealthClient) Challenge(ctx context.Context, machineID string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/api/v1/worker/challenge?machine="+url.QueryEscape(machineID), nil)
	if err != nil {
		return "", err
	}
	var r struct {
		Nonce string `json:"nonce"`
	}
	if err := c.do(req, "", &r); err != nil {
		return "", err
	}
	if r.Nonce == "" {
		return "", &StatusError{Status: http.StatusBadGateway, Message: "hub không trả nonce"}
	}
	return r.Nonce, nil
}

// AccessToken đổi chữ ký trên nonce lấy access token.
func (c *HealthClient) AccessToken(ctx context.Context, machineID, nonce, signature string) (string, time.Time, error) {
	var r struct {
		AccessToken string `json:"accessToken"`
		ExpiresAt   string `json:"expiresAt"`
	}
	if err := c.postJSON(ctx, "/api/v1/worker/token", "", map[string]string{"machineId": machineID, "nonce": nonce, "signature": signature}, &r); err != nil {
		return "", time.Time{}, err
	}
	exp, err := time.Parse(time.RFC3339Nano, r.ExpiresAt)
	if err != nil || r.AccessToken == "" {
		return "", time.Time{}, &StatusError{Status: http.StatusBadGateway, Message: "trả lời token của hub không đọc được"}
	}
	return r.AccessToken, exp, nil
}

// Signer là khoá máy (machinekey.Key); tách interface để hubclient không phụ thuộc nơi giữ khoá.
type Signer interface {
	Sign(hubURL, machineID, nonce string) string
}

// TokenSource giữ access token của máy, đổi token mới khi còn dưới RefreshBefore. Dùng chung cho kênh WSS và các lời
// gọi HTTP của worker để mỗi 15 phút chỉ ký một lần.
type TokenSource struct {
	Client    *HealthClient
	HubURL    string
	MachineID string
	Key       Signer
	Now       func() time.Time

	mu    sync.Mutex
	token string
	exp   time.Time
}

func (s *TokenSource) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// Token trả token đang giữ khi còn hạn, fresh thì luôn đổi token mới (hub vừa đóng 4401, sắp tới hạn reauth).
func (s *TokenSource) Token(ctx context.Context, fresh bool) (string, time.Time, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !fresh && s.token != "" && s.exp.Sub(s.now()) > RefreshBefore {
		return s.token, s.exp, nil
	}
	nonce, err := s.Client.Challenge(ctx, s.MachineID)
	if err != nil {
		return "", time.Time{}, err
	}
	token, exp, err := s.Client.AccessToken(ctx, s.MachineID, nonce, s.Key.Sign(s.HubURL, s.MachineID, nonce))
	if err != nil {
		return "", time.Time{}, err
	}
	s.token, s.exp = token, exp
	return token, exp, nil
}

// IsAuthFailed cho biết hub từ chối khoá máy (máy bị thu hồi, khoá đã thay): thử lại cũng vô ích.
func IsAuthFailed(err error) bool {
	var se *StatusError
	return errors.As(err, &se) && (se.Status == http.StatusUnauthorized || se.Status == http.StatusForbidden)
}

// ErrNoMachineID báo worker.json chưa có id máy để xin token, khi máy cũ chưa gửi khoá lần nào.
var ErrNoMachineID = errors.New("worker.json chưa có id máy; chạy lại `hive-worker register`")
