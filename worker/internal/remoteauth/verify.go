package remoteauth

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	KindPasskey = "passkey"
	KindTOTP    = "totp"

	// Skew: ts của yêu cầu lệch đồng hồ worker tối đa chừng này (FR-016).
	Skew = 120 * time.Second
	// NonceTTL phủ cửa sổ ts hai phía; nonce cũ hơn thì ts đã quá hạn.
	NonceTTL = 10 * time.Minute
)

// Auth là bằng chứng của term_start/term_control (union passkey | totp của contracts).
type Auth struct {
	Kind      string
	Assertion *Assertion
	Code      string
	EphPub    string
	TS        int64
	Nonce     string
}

// Request là yêu cầu cần kiểm. Params là trường được ký (StartParams/ControlParams của contracts), dựng bằng
// StartParams/ControlParams bên dưới hoặc giải từ JSON; worker không tin trường nào ngoài Params.
type Request struct {
	MachineID string
	Action    string
	Params    map[string]any
	Auth      Auth
}

// StartParams dựng Params của term_start; trường rỗng là không có (contracts không cho chuỗi rỗng ở các trường này).
func StartParams(userID, deviceID, cli, accountID, rootID, subdir, projectID, taskID, prompt string, cols, rows int) map[string]any {
	p := map[string]any{"userId": userID, "deviceId": deviceID, "cli": cli, "rootId": rootID, "cols": cols, "rows": rows}
	for k, v := range map[string]string{"accountId": accountID, "subdir": subdir, "projectId": projectID, "taskId": taskID, "prompt": prompt} {
		if v != "" {
			p[k] = v
		}
	}
	return p
}

// ControlParams dựng Params của term_control: quyền gõ gắn với đúng một kết nối của một phiên.
func ControlParams(userID, deviceID, sessionID, connID string) map[string]any {
	return map[string]any{"userId": userID, "deviceId": deviceID, "sessionId": sessionID, "connId": connID}
}

// Challenge = SHA-256(JSON chuẩn hoá {action, ephPub, machineId, nonce, params, ts}), khớp challengeBytes của contracts.
func Challenge(r Request) ([]byte, error) {
	canon, err := Canonical(map[string]any{
		"machineId": r.MachineID, "action": r.Action, "params": r.Params,
		"ephPub": r.Auth.EphPub, "ts": r.Auth.TS, "nonce": r.Auth.Nonce,
	})
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(canon)
	return sum[:], nil
}

// Policy là điều kiện ngoài yêu cầu: URL hub từ worker.json (không tin hub báo), chính sách tổ chức từ welcome.policy và
// cài đặt tại máy.
type Policy struct {
	HubURL string
	// TOTPFallback từ welcome.policy; nil là hub không gửi (hub cũ) thì theo cài đặt tại máy.
	TOTPFallback *bool
	// TOTPOnHTTPS: chủ máy cho TOTP cả trên hub HTTPS (remote.json).
	TOTPOnHTTPS bool
	// OwnerUserID: chủ máy. Đường TOTP không có thiết bị ghép (trang HTTP không tạo được passkey) nên chỉ nhận chủ máy.
	OwnerUserID string
}

// Result: đủ để worker cấp quyền và suy ra khoá phiên bằng SessionKey(Auth.EphPub, Challenge, KeyInfo).
type Result struct {
	Kind      string
	DeviceID  string
	Challenge []byte
	KeyInfo   string
}

// Devices là nơi tra thiết bị đã ghép (Store hiện thực).
type Devices interface {
	DeviceByCredential(credentialID string) (Device, bool, error)
	MarkUsed(deviceID string, signCount uint32, at time.Time) error
}

// Verifier là điểm kiểm chung cho term_start và term_control (VerifyAuth trong plan.md).
type Verifier struct {
	Now     func() time.Time
	Devices Devices
	TOTP    *TOTPStore

	mu     sync.Mutex
	nonces map[string]time.Time
}

func (v *Verifier) now() time.Time {
	if v.Now != nil {
		return v.Now()
	}
	return time.Now()
}

// VerifyAuth kiểm một yêu cầu. Giữ khoá suốt lần kiểm để hai yêu cầu cùng nonce chạy song song không cùng lọt.
// Nonce chỉ được ghi nhớ khi yêu cầu qua, nên hub gửi rác không đốt được nonce của người dùng.
func (v *Verifier) VerifyAuth(req Request, pol Policy) (Result, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	now := v.now()
	a := req.Auth
	if req.Action != "start" && req.Action != "control" {
		return Result{}, deny(CodeAuthInvalid)
	}
	if d := now.Sub(time.Unix(a.TS, 0)); d > Skew || d < -Skew {
		return Result{}, deny(CodeAuthStale)
	}
	if raw, err := b64url.DecodeString(a.Nonce); err != nil || len(raw) != 16 {
		return Result{}, deny(CodeAuthInvalid)
	}
	if _, err := ParseEphPub(a.EphPub); err != nil {
		return Result{}, denyErr(CodeAuthInvalid, err)
	}
	v.pruneNonces(now)
	if _, seen := v.nonces[a.Nonce]; seen {
		return Result{}, deny(CodeAuthReplay)
	}
	userID, _ := req.Params["userId"].(string)
	deviceID, _ := req.Params["deviceId"].(string)
	if userID == "" || deviceID == "" {
		return Result{}, deny(CodeAuthInvalid)
	}
	challenge, err := Challenge(req)
	if err != nil {
		return Result{}, denyErr(CodeAuthInvalid, err)
	}
	res := Result{Kind: a.Kind, Challenge: challenge, KeyInfo: KeyInfo(a.Kind, a.Code)}
	switch a.Kind {
	case KindPasskey:
		if a.Assertion == nil {
			return Result{}, deny(CodeAuthInvalid)
		}
		if err := v.passkey(req, pol, userID, deviceID, challenge, now); err != nil {
			return Result{}, err
		}
		res.DeviceID = deviceID
	case KindTOTP:
		if err := v.totp(pol, userID, a.Code, now); err != nil {
			return Result{}, err
		}
	default:
		return Result{}, deny(CodeAuthInvalid)
	}
	v.nonces[a.Nonce] = now
	return res, nil
}

func (v *Verifier) passkey(req Request, pol Policy, userID, deviceID string, challenge []byte, now time.Time) error {
	if v.Devices == nil {
		return deny(CodeDeviceUnknown)
	}
	dev, ok, err := v.Devices.DeviceByCredential(req.Auth.Assertion.CredentialID)
	if err != nil {
		return err
	}
	if !ok || dev.ID != deviceID {
		return deny(CodeDeviceUnknown)
	}
	if dev.UserID != userID {
		return deny(CodeDeviceUserMismatch)
	}
	origin, rpID, err := HubOrigin(pol.HubURL)
	if err != nil {
		return denyErr(CodeAuthInvalid, err)
	}
	count, err := VerifyAssertion(dev, *req.Auth.Assertion, challenge, origin, rpID)
	if err != nil {
		return err
	}
	// Lưu bộ đếm trước khi cấp quyền: lưu hỏng thì từ chối, để không có assertion nào dùng được hai lần qua khởi động lại.
	return v.Devices.MarkUsed(dev.ID, count, now.UTC())
}

// totp: chỉ là đường lui khi hub HTTP (D15). Tổ chức tắt, hub HTTPS (chủ máy chưa cho riêng), hay khác chủ máy đều chặn
// trước khi đụng bộ đếm, nên những yêu cầu đó không làm khoá máy.
func (v *Verifier) totp(pol Policy, userID, code string, now time.Time) error {
	if pol.TOTPFallback != nil && !*pol.TOTPFallback {
		return deny(CodeTOTPNotAllowed)
	}
	if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(pol.HubURL)), "http://") && !pol.TOTPOnHTTPS {
		return deny(CodeTOTPNotAllowed)
	}
	if pol.OwnerUserID == "" || userID != pol.OwnerUserID {
		return deny(CodeDeviceUserMismatch)
	}
	if v.TOTP == nil {
		return deny(CodeTOTPDisabled)
	}
	if err := v.TOTP.Verify(code, now); err != nil {
		var d *DenyError
		if errors.As(err, &d) {
			return err
		}
		return fmt.Errorf("kiểm mã TOTP: %w", err)
	}
	return nil
}

func (v *Verifier) pruneNonces(now time.Time) {
	if v.nonces == nil {
		v.nonces = map[string]time.Time{}
	}
	for n, at := range v.nonces {
		if now.Sub(at) > NonceTTL {
			delete(v.nonces, n)
		}
	}
}
