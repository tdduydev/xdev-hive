package terminal

import (
	"encoding/base32"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Tạo và quản lý khoá TOTP tại máy (specs/010 T025, D15): chỉ qua socket nội bộ, không có gói hub nào bật hay đổi
// khoá. Khoá mới chỉ được lưu khi chủ máy nhập đúng một mã từ app Authenticator, nên quét hỏng QR không làm máy nhận mã
// từ một khoá không ai giữ. Sổ audit và log không bao giờ có khoá hay mã.

const (
	totpEnrollTTL = 10 * time.Minute
	// totpEnrollTries: nhập sai chừng này lần thì bỏ khoá đang chờ, phải bắt đầu lại (không cho đoán dần).
	totpEnrollTries = 5
)

type totpPending struct {
	secret  []byte
	expires time.Time
	tries   int
}

// TOTPEnroll là trả lời của remote.totp.begin. Secret (base32) để nhập tay khi không quét được QR.
type TOTPEnroll struct {
	URI       string    `json:"uri"`
	Secret    string    `json:"secret"`
	ExpiresAt time.Time `json:"expiresAt"`
	// HubURL để lệnh cảnh báo khi hub chạy HTTP (mã đi trên đường không mã hoá).
	HubURL string `json:"hubUrl,omitempty"`
}

func (r *Remote) handleTOTP(c *localipc.Conn, req localipc.Request) error {
	if r.TOTP == nil {
		return c.Fail(localipc.CodeUnsupported, "Máy này chưa hỗ trợ mã Authenticator.")
	}
	switch req.Op {
	case "remote.totp.begin":
		r.mu.Lock()
		shared := r.owner != nil && r.owner.Shared
		r.mu.Unlock()
		if shared {
			return c.Fail(localipc.CodeDenied, "Máy dùng chung không bật được mã Authenticator.")
		}
		secret, err := remoteauth.NewTOTPSecret()
		if err != nil {
			return c.Fail(localipc.CodeFailed, err.Error())
		}
		p := &totpPending{secret: secret, expires: r.now().Add(totpEnrollTTL)}
		r.mu.Lock()
		// Bắt đầu lại thay khoá đang chờ: QR cũ trên màn hình không còn xác nhận được.
		r.totpPending = p
		r.mu.Unlock()
		enc := base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(secret)
		return c.OK(map[string]any{"totp": TOTPEnroll{URI: remoteauth.TOTPURI(r.Machine, secret), Secret: enc, ExpiresAt: p.expires.UTC(), HubURL: r.HubURL}})
	case "remote.totp.confirm":
		var in struct{ Code string }
		if err := req.Decode(&in); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		return r.totpConfirm(c, in.Code)
	case "remote.totp.disable":
		if err := r.TOTP.Disable(); err != nil {
			return c.Fail(localipc.CodeFailed, "Không xoá được totp.json: "+err.Error())
		}
		r.audit("totp_disable", byMachine, nil)
		r.changed()
		return r.replyStatus(c, nil)
	case "remote.totp.unlock":
		if err := r.TOTP.Unlock(); err != nil {
			return c.Fail(localipc.CodeFailed, "Không ghi được totp.json: "+err.Error())
		}
		r.audit("totp_unlock", byMachine, nil)
		r.changed()
		return r.replyStatus(c, nil)
	}
	return c.Fail(localipc.CodeUnsupported, "hive-worker chưa nhận thao tác "+clip(req.Op, 40)+".")
}

func (r *Remote) totpConfirm(c *localipc.Conn, code string) error {
	now := r.now()
	r.mu.Lock()
	p := r.totpPending
	if p != nil && now.After(p.expires) {
		r.totpPending, p = nil, nil
	}
	r.mu.Unlock()
	if p == nil {
		return c.Fail(localipc.CodeNotFound, "Không có khoá nào đang chờ xác nhận hoặc đã quá 10 phút. Chạy lại hive remote totp enroll.")
	}
	if err := r.TOTP.Enable(p.secret, code, now); err != nil {
		if remoteauth.Code(err) != remoteauth.CodeTOTPInvalid {
			return c.Fail(localipc.CodeFailed, "Không ghi được totp.json: "+err.Error())
		}
		r.mu.Lock()
		p.tries++
		left := totpEnrollTries - p.tries
		if left <= 0 && r.totpPending == p {
			r.totpPending = nil
		}
		r.mu.Unlock()
		if left <= 0 {
			return c.Fail(localipc.CodeDenied, "Sai mã quá nhiều lần; khoá chưa lưu. Chạy lại hive remote totp enroll.")
		}
		return c.Fail(localipc.CodeBadRequest, "Mã không đúng. Kiểm tra giờ trên điện thoại và nhập mã mới nhất.")
	}
	r.mu.Lock()
	if r.totpPending == p {
		r.totpPending = nil
	}
	r.mu.Unlock()
	r.audit("totp_enroll", byMachine, nil)
	r.changed()
	return r.replyStatus(c, nil)
}
