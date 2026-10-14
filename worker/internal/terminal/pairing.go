package terminal

import (
	"encoding/base64"
	"net/url"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Ghép điện thoại (specs/010 plan "Luồng: ghép điện thoại"): người ở máy xin mã (pair.begin), bí mật chỉ nằm trong
// fragment của QR nên hub không biết; term_pair tới thì kiểm tag, rồi hỏi người ở máy qua watch và chỉ lưu khi họ bấm
// Cho phép.

// Lý do của term_pair_result ngoài PairExpired/PairBadTag của remoteauth.
const (
	pairDenied       = "denied"
	pairTimeout      = "timeout"
	pairUserMismatch = "user_mismatch"
	pairDisabled     = "disabled"
)

// PairInfo là trả lời của remote.pair.begin. Secret là base64url; URL đã có sẵn để in QR.
type PairInfo struct {
	PairID    string    `json:"pairId"`
	Secret    string    `json:"secret"`
	ExpiresAt time.Time `json:"expiresAt"`
	URL       string    `json:"url,omitempty"`
}

// pairURL: `m` là tên máy (machineId của hello), trang web tra ra id máy trong các máy của người đang đăng nhập.
func pairURL(hub, machine, pairID string, secret []byte) string {
	if hub == "" {
		return ""
	}
	q := url.Values{}
	q.Set("m", machine)
	q.Set("p", pairID)
	return strings.TrimRight(hub, "/") + "/remote/pair?" + q.Encode() + "#s=" + base64.RawURLEncoding.EncodeToString(secret)
}

func (r *Remote) pairBegin(c *localipc.Conn) error {
	cfg, err := r.Store.Load()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	r.mu.Lock()
	shared := r.owner != nil && r.owner.Shared
	r.mu.Unlock()
	switch {
	case shared:
		return c.Fail(localipc.CodeDenied, "Máy dùng chung không ghép được điện thoại.")
	case !cfg.Enabled:
		return c.Fail(localipc.CodeBadRequest, "Bật điều khiển từ xa trước khi ghép: hive remote on.")
	case len(cfg.Devices) >= maxDevices:
		return c.Fail(localipc.CodeBadRequest, "Đã đủ 32 thiết bị; gỡ bớt bằng hive remote devices rm <id>.")
	}
	id, secret, expires, err := r.Pairings.Begin()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	info := PairInfo{PairID: id, Secret: base64.RawURLEncoding.EncodeToString(secret), ExpiresAt: expires,
		URL: pairURL(r.HubURL, r.Machine, id, secret)}
	return c.OK(map[string]any{"pair": info})
}

// HandlePair xử lý term_pair; chặn tới khi người ở máy trả lời hoặc hết giờ, nên người gọi chạy trong goroutine riêng.
func (r *Remote) HandlePair(req PairRequest) PairResult {
	res := PairResult{PairID: req.PairID}
	deny := func(reason string) PairResult {
		res.Reason = reason
		r.audit("pair_denied", byHub(req.UserID), map[string]any{"pairId": req.PairID, "label": cleanLabel(req.Label), "reason": reason})
		r.broadcast(watchEvent{Event: "pair_done", PairID: req.PairID, Reason: reason})
		return res
	}
	cfg, err := r.Store.Load()
	if err != nil || !cfg.Enabled {
		// Không thử tag khi đang tắt: mã ghép vẫn còn để bật lại rồi quét tiếp trong hạn.
		return deny(pairDisabled)
	}
	if reason := r.Pairings.Verify(req.PairID, req.UserID, req.CredentialID, req.SPKI, req.Tag); reason != "" {
		return deny(reason)
	}
	r.mu.Lock()
	owner := r.owner
	r.mu.Unlock()
	// Hub đã kiểm người gọi là chủ máy; máy kiểm lại theo welcome để hub lỗi không ghép được người khác.
	if owner == nil || owner.Shared || owner.UserID != req.UserID {
		return deny(pairUserMismatch)
	}
	label := cleanLabel(req.Label)
	if label == "" {
		label = "Thiết bị"
	}
	allow, answered := r.ask(req.PairID, label, req.UserID)
	if !answered {
		return deny(pairTimeout)
	}
	if !allow {
		return deny(pairDenied)
	}
	dev := remoteauth.Device{ID: randomID("dev-", 9), Label: label, UserID: req.UserID, CredentialID: req.CredentialID,
		SPKI: req.SPKI, CreatedAt: r.now().UTC()}
	reason := ""
	_, err = r.Store.Update(func(c *remoteauth.Config) error {
		if !c.Enabled {
			reason = pairDisabled
			return errNoChange
		}
		// Cùng passkey ghép lại (xoá trên web rồi quét lại) thay bản cũ thay vì thêm bản trùng.
		kept := c.Devices[:0]
		for _, d := range c.Devices {
			if d.CredentialID != dev.CredentialID {
				kept = append(kept, d)
			}
		}
		if len(kept) >= maxDevices {
			reason = pairDenied
			return errNoChange
		}
		c.Devices = append(kept, dev)
		c.OwnerUserID = req.UserID
		return nil
	})
	if reason != "" {
		return deny(reason)
	}
	if err != nil {
		r.log().Warn("Không lưu được thiết bị đã ghép", "error", err)
		return deny(pairDenied)
	}
	r.audit("pair", byMachine, map[string]any{"deviceId": dev.ID, "label": dev.Label, "userId": dev.UserID})
	r.broadcast(watchEvent{Event: "pair_done", PairID: req.PairID, OK: true, DeviceID: dev.ID})
	r.changed()
	res.OK, res.DeviceID = true, dev.ID
	return res
}

// ask phát yêu cầu xác nhận cho mọi người đang watch và chờ remote.pair.decide.
func (r *Remote) ask(pairID, label, userID string) (allow, answered bool) {
	wait := r.ConfirmWait
	if wait <= 0 {
		wait = DefaultConfirmWait
	}
	d := &decision{ch: make(chan bool, 1),
		ev: watchEvent{Event: "pair_request", PairID: pairID, Label: label, UserID: userID, ExpiresAt: r.now().Add(wait).UTC()}}
	r.mu.Lock()
	if r.decisions == nil {
		r.decisions = map[string]*decision{}
	}
	r.decisions[pairID] = d
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.decisions, pairID)
		r.mu.Unlock()
	}()
	r.broadcast(d.ev)
	select {
	case allow = <-d.ch:
		return allow, true
	case <-time.After(wait):
		return false, false
	}
}

func (r *Remote) decide(pairID string, allow bool) bool {
	r.mu.Lock()
	d, ok := r.decisions[pairID]
	if ok {
		// Câu trả lời đầu tiên thắng: hai cửa sổ watch cùng bấm thì cái sau không đổi được kết quả.
		delete(r.decisions, pairID)
	}
	r.mu.Unlock()
	if ok {
		d.ch <- allow
	}
	return ok
}

// decision là một yêu cầu ghép đang chờ người ở máy; ev để phát lại cho watch mở sau.
type decision struct {
	ch chan bool
	ev watchEvent
}
