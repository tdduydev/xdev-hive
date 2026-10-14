package terminal

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Điều khiển từ xa phía máy (specs/010 T020): bật/tắt, thư mục cho mở phiên, ghép và gỡ thiết bị. Chỉ người ở máy (qua
// socket nội bộ, cùng người dùng hệ điều hành với worker) bật, thêm thư mục hay ghép được; gói từ hub chỉ tắt, gỡ thiết
// bị hoặc xin ghép mà chủ máy phải bấm Cho phép tại máy (FR-012, FR-014). Runner host không mở socket nội bộ nên không có
// đường bật.

const (
	maxRoots   = 32
	maxDevices = 32
	maxLabel80 = 80
	// DefaultConfirmWait: chờ chủ máy bấm Cho phép; ngắn hơn REMOTE_LIMITS.confirmSec (60 s) để máy tự trả `timeout`
	// trước khi hub bỏ chờ.
	DefaultConfirmWait = 50 * time.Second
)

// Remote giữ remote.json và các yêu cầu đang chờ chủ máy. Mọi thay đổi gọi onChange để Recorder gửi term_state mới.
type Remote struct {
	Store    *remoteauth.Store
	Pairings *remoteauth.Pairings
	// TOTP nil là máy chưa có TOTP (T025 thêm phần tạo khoá); term_state.totp báo tắt.
	TOTP  *remoteauth.TOTPStore
	Audit *Audit
	// HubURL, Machine dựng địa chỉ QR ghép; Machine là tên máy trong hello (hub tra ra id máy của chủ).
	HubURL, Machine string
	// CLIs là CLI có trên máy để điện thoại chọn khi mở phiên.
	CLIs        []string
	ConfirmWait time.Duration
	Logger      *slog.Logger
	Now         func() time.Time

	mu        sync.Mutex
	owner     *WelcomeOwner
	watchers  map[*watcher]struct{}
	decisions map[string]*decision
	onChange  func()
}

func (r *Remote) log() *slog.Logger {
	if r.Logger == nil {
		return slog.Default()
	}
	return r.Logger
}

func (r *Remote) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// OnChange đặt hàm gọi khi trạng thái đổi (Recorder.StateChanged).
func (r *Remote) OnChange(fn func()) {
	r.mu.Lock()
	r.onChange = fn
	r.mu.Unlock()
}

func (r *Remote) changed() {
	r.mu.Lock()
	fn := r.onChange
	r.mu.Unlock()
	if fn != nil {
		fn()
	}
	if st, err := r.Status(); err == nil {
		r.broadcast(watchEvent{Event: "state", State: &st})
	}
}

func (r *Remote) audit(action, by string, data map[string]any) {
	if err := r.Audit.Write(action, by, data); err != nil {
		r.log().Warn("Không ghi được remote-audit.log", "action", action, "error", err)
	}
}

func randomID(prefix string, n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return prefix + base64.RawURLEncoding.EncodeToString(b)
}

// cleanLabel bỏ ký tự điều khiển (nhãn hiện trên terminal và điện thoại) và cắt theo giới hạn của hợp đồng.
func cleanLabel(s string) string {
	s = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	return clip(strings.TrimSpace(s), maxLabel80)
}

// ---- Trạng thái ----

// RemoteStatus là trạng thái cho người ở máy (`hive remote status`, app): có đường dẫn root, không có khoá thiết bị.
type RemoteStatus struct {
	Enabled          bool              `json:"enabled"`
	Shared           bool              `json:"shared"`
	OwnerUserID      string            `json:"ownerUserId,omitempty"`
	Roots            []remoteauth.Root `json:"roots"`
	Devices          []DeviceInfo      `json:"devices"`
	ConfirmOnMachine bool              `json:"confirmOnMachine"`
	IdleMinutes      int               `json:"idleMinutes"`
	DetachedHours    int               `json:"detachedHours"`
	MaxHours         int               `json:"maxHours"`
	AllowFullAccess  bool              `json:"allowFullAccess"`
	TOTPOnHTTPS      bool              `json:"totpOnHttps"`
	TOTP             TOTPInfo          `json:"totp"`
}

type DeviceInfo struct {
	ID         string    `json:"id"`
	Label      string    `json:"label"`
	UserID     string    `json:"userId"`
	Synced     bool      `json:"synced"`
	CreatedAt  time.Time `json:"createdAt"`
	LastUsedAt time.Time `json:"lastUsedAt,omitzero"`
}

type TOTPInfo struct {
	Enabled     bool      `json:"enabled"`
	Locked      bool      `json:"locked"`
	LockedUntil time.Time `json:"lockedUntil,omitzero"`
}

func (r *Remote) totpInfo() TOTPInfo {
	if r.TOTP == nil {
		return TOTPInfo{}
	}
	st, err := r.TOTP.Status(r.now())
	if err != nil {
		r.log().Warn("Không đọc được totp.json", "error", err)
		return TOTPInfo{}
	}
	return TOTPInfo{Enabled: st.Enabled, Locked: st.Locked, LockedUntil: st.LockedUntil}
}

func (r *Remote) Status() (RemoteStatus, error) {
	c, err := r.Store.Load()
	if err != nil {
		return RemoteStatus{}, err
	}
	r.mu.Lock()
	shared := r.owner != nil && r.owner.Shared
	r.mu.Unlock()
	st := RemoteStatus{Enabled: c.Enabled, Shared: shared, OwnerUserID: c.OwnerUserID, Roots: c.Roots,
		ConfirmOnMachine: c.ConfirmOnMachine, IdleMinutes: int(c.Idle() / time.Minute), DetachedHours: int(c.Detached() / time.Hour),
		MaxHours: int(c.Max() / time.Hour), AllowFullAccess: c.AllowFullAccess, TOTPOnHTTPS: c.TOTPOnHTTPS, TOTP: r.totpInfo(),
		Devices: []DeviceInfo{}}
	if st.Roots == nil {
		st.Roots = []remoteauth.Root{}
	}
	for _, d := range c.Devices {
		st.Devices = append(st.Devices, DeviceInfo{ID: d.ID, Label: d.Label, UserID: d.UserID, Synced: d.Synced(),
			CreatedAt: d.CreatedAt, LastUsedAt: d.LastUsedAt})
	}
	return st, nil
}

// State là phần term_state ngoài danh sách phiên (Recorder.BaseState): chỉ nhãn root, không đường dẫn hay khoá.
func (r *Remote) State() State {
	c, err := r.Store.Load()
	if err != nil {
		// remote.json hỏng: báo tắt để hub không mời mở phiên; người ở máy thấy lỗi qua hive remote status.
		r.log().Warn("Không đọc được remote.json; báo hub là đang tắt điều khiển từ xa", "error", err)
		return State{CLIs: slices.Clone(r.CLIs)}
	}
	t := r.totpInfo()
	st := State{Enabled: c.Enabled, ConfirmOnMachine: c.ConfirmOnMachine, CLIs: slices.Clone(r.CLIs),
		TOTP: StateTOTP{Enabled: t.Enabled, Locked: t.Locked}}
	if t.Locked {
		st.TOTP.LockedUntil = t.LockedUntil.UTC().Format("2006-01-02T15:04:05.000Z")
	}
	for _, root := range c.Roots {
		st.Roots = append(st.Roots, StateRoot{ID: root.ID, Label: root.Label})
	}
	for _, d := range c.Devices {
		st.Devices = append(st.Devices, StateDevice{ID: d.ID, Label: d.Label, UserID: d.UserID, Synced: d.Synced()})
	}
	return st
}

// ---- Từ hub ----

// OnWelcome áp chủ máy theo hub: máy dùng chung thì tắt; đổi chủ thì xoá thiết bị đã ghép của chủ cũ.
func (r *Remote) OnWelcome(info WelcomeInfo) {
	if info.Owner == nil {
		return
	}
	owner := *info.Owner
	r.mu.Lock()
	r.owner = &owner
	r.mu.Unlock()
	var actions []func()
	_, err := r.Store.Update(func(c *remoteauth.Config) error {
		if owner.Shared && c.Enabled {
			c.Enabled = false
			actions = append(actions, func() { r.audit("remote_disable", "hub", map[string]any{"reason": "shared"}) })
		}
		if c.OwnerUserID != "" && c.OwnerUserID != owner.UserID {
			from, n := c.OwnerUserID, len(c.Devices)
			c.Devices = nil
			c.OwnerUserID = owner.UserID
			actions = append(actions, func() {
				r.audit("owner_changed", "hub", map[string]any{"from": from, "to": owner.UserID, "devicesRemoved": n})
			})
		}
		if len(actions) == 0 {
			return errNoChange
		}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return
	}
	if err != nil {
		r.log().Warn("Không cập nhật được remote.json theo chủ máy của hub", "error", err)
		return
	}
	for _, a := range actions {
		a()
	}
	r.changed()
}

// errNoChange: fn của Store.Update trả lỗi này để khỏi ghi lại file khi không đổi gì.
var errNoChange = errors.New("không đổi")

// HubDisable là term_disable: tắt khẩn cấp từ điện thoại hay quản trị đội. Chỉ tắt; không có gói bật.
func (r *Remote) HubDisable(req DisableRequest) {
	if r.disable(byHub(req.By)) {
		r.log().Info("Hub tắt điều khiển từ xa", "by", req.By)
	}
}

// HubDeviceRevoke là term_device_revoke: gỡ thiết bị từ web (chủ máy đã đăng nhập).
func (r *Remote) HubDeviceRevoke(req DeviceRevokeRequest) {
	if r.removeDevice(req.DeviceID, byHub(req.By)) {
		r.log().Info("Hub gỡ thiết bị đã ghép", "device", req.DeviceID, "by", req.By)
	}
}

func (r *Remote) disable(by string) bool {
	_, err := r.Store.Update(func(c *remoteauth.Config) error {
		if !c.Enabled {
			return errNoChange
		}
		c.Enabled = false
		return nil
	})
	if err != nil {
		if !errors.Is(err, errNoChange) {
			r.log().Warn("Không tắt được điều khiển từ xa", "error", err)
		}
		return false
	}
	r.audit("remote_disable", by, nil)
	r.changed()
	return true
}

func (r *Remote) removeDevice(id, by string) bool {
	var label string
	_, err := r.Store.Update(func(c *remoteauth.Config) error {
		i := slices.IndexFunc(c.Devices, func(d remoteauth.Device) bool { return d.ID == id })
		if i < 0 {
			return errNoChange
		}
		label = c.Devices[i].Label
		c.Devices = slices.Delete(c.Devices, i, i+1)
		return nil
	})
	if err != nil {
		if !errors.Is(err, errNoChange) {
			r.log().Warn("Không gỡ được thiết bị", "device", id, "error", err)
		}
		return false
	}
	r.audit("device_revoke", by, map[string]any{"deviceId": id, "label": label})
	r.changed()
	return true
}

// ---- Socket nội bộ (người ở máy) ----

// Handle xử lý remote.* và watch của socket nội bộ.
func (r *Remote) Handle(ctx context.Context, c *localipc.Conn, req localipc.Request) error {
	switch req.Op {
	case "watch":
		return r.watch(ctx, c)
	case "remote.status":
		return r.replyStatus(c, nil)
	case "remote.enable":
		return r.enable(c)
	case "remote.disable":
		r.disable(byMachine)
		return r.replyStatus(c, nil)
	case "remote.roots.add":
		var p struct{ Path, Label string }
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		root, code, msg := r.addRoot(p.Path, p.Label)
		if code != "" {
			return c.Fail(code, msg)
		}
		return r.replyStatus(c, map[string]any{"root": root})
	case "remote.roots.remove":
		var p struct{ ID string }
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		if !r.removeRoot(p.ID) {
			return c.Fail(localipc.CodeNotFound, "Không có thư mục "+clip(p.ID, 40)+".")
		}
		return r.replyStatus(c, nil)
	case "remote.devices.remove":
		var p struct{ ID string }
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		if !r.removeDevice(p.ID, byMachine) {
			return c.Fail(localipc.CodeNotFound, "Không có thiết bị "+clip(p.ID, 40)+".")
		}
		return r.replyStatus(c, nil)
	case "remote.settings":
		var p SettingsParams
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		if msg := r.settings(p); msg != "" {
			return c.Fail(localipc.CodeBadRequest, msg)
		}
		return r.replyStatus(c, nil)
	case "remote.pair.begin":
		return r.pairBegin(c)
	case "remote.pair.decide":
		var p struct {
			PairID string `json:"pairId"`
			Allow  bool   `json:"allow"`
		}
		if err := req.Decode(&p); err != nil {
			return c.Fail(localipc.CodeBadRequest, err.Error())
		}
		if !r.decide(p.PairID, p.Allow) {
			return c.Fail(localipc.CodeNotFound, "Không có yêu cầu ghép nào đang chờ với mã này.")
		}
		return c.OK(nil)
	}
	return c.Fail(localipc.CodeUnsupported, "hive-worker chưa nhận thao tác "+clip(req.Op, 40)+".")
}

func (r *Remote) replyStatus(c *localipc.Conn, extra map[string]any) error {
	st, err := r.Status()
	if err != nil {
		return c.Fail(localipc.CodeFailed, err.Error())
	}
	m := map[string]any{"status": st}
	for k, v := range extra {
		m[k] = v
	}
	return c.OK(m)
}

func (r *Remote) enable(c *localipc.Conn) error {
	r.mu.Lock()
	shared := r.owner != nil && r.owner.Shared
	r.mu.Unlock()
	if shared {
		return c.Fail(localipc.CodeDenied, "Máy dùng chung không bật được điều khiển từ xa: máy không có chủ riêng để ghép điện thoại.")
	}
	_, err := r.Store.Update(func(cfg *remoteauth.Config) error {
		if cfg.Enabled {
			return errNoChange
		}
		cfg.Enabled = true
		return nil
	})
	if err == nil {
		r.audit("remote_enable", byMachine, nil)
		r.changed()
	} else if !errors.Is(err, errNoChange) {
		return c.Fail(localipc.CodeFailed, "Không ghi được remote.json: "+err.Error())
	}
	return r.replyStatus(c, nil)
}

// addRoot nhận đường dẫn tuyệt đối của thư mục có thật; lưu dạng đã giải symlink để so trùng và để T050 kiểm thư mục con
// không thoát ra ngoài root.
func (r *Remote) addRoot(path, label string) (remoteauth.Root, string, string) {
	if path == "" || !filepath.IsAbs(path) {
		return remoteauth.Root{}, localipc.CodeBadRequest, "Cần đường dẫn tuyệt đối của thư mục."
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return remoteauth.Root{}, localipc.CodeNotFound, "Không có thư mục " + path + "."
	}
	if st, err := os.Stat(real); err != nil || !st.IsDir() {
		return remoteauth.Root{}, localipc.CodeBadRequest, path + " không phải thư mục."
	}
	if filepath.Dir(real) == real {
		return remoteauth.Root{}, localipc.CodeBadRequest, "Không cho mở phiên từ xa trên cả ổ đĩa; chọn thư mục dự án."
	}
	if label = cleanLabel(label); label == "" {
		label = cleanLabel(filepath.Base(real))
	}
	root := remoteauth.Root{ID: randomID("root-", 6), Label: label, Path: real}
	code, msg := "", ""
	_, err = r.Store.Update(func(c *remoteauth.Config) error {
		for _, x := range c.Roots {
			if x.Path == real {
				code, msg = localipc.CodeBadRequest, "Thư mục đã có trong danh sách ("+x.Label+")."
				return errNoChange
			}
		}
		if len(c.Roots) >= maxRoots {
			code, msg = localipc.CodeBadRequest, fmt.Sprintf("Tối đa %d thư mục.", maxRoots)
			return errNoChange
		}
		c.Roots = append(c.Roots, root)
		return nil
	})
	if code != "" {
		return root, code, msg
	}
	if err != nil {
		return root, localipc.CodeFailed, "Không ghi được remote.json: " + err.Error()
	}
	r.audit("root_add", byMachine, map[string]any{"id": root.ID, "label": root.Label, "path": root.Path})
	r.changed()
	return root, "", ""
}

func (r *Remote) removeRoot(id string) bool {
	var root remoteauth.Root
	_, err := r.Store.Update(func(c *remoteauth.Config) error {
		i := slices.IndexFunc(c.Roots, func(x remoteauth.Root) bool { return x.ID == id })
		if i < 0 {
			return errNoChange
		}
		root = c.Roots[i]
		c.Roots = slices.Delete(c.Roots, i, i+1)
		return nil
	})
	if err != nil {
		return false
	}
	r.audit("root_remove", byMachine, map[string]any{"id": root.ID, "label": root.Label})
	r.changed()
	return true
}

// SettingsParams là remote.settings; trường nil giữ nguyên.
type SettingsParams struct {
	ConfirmOnMachine *bool `json:"confirmOnMachine"`
	IdleMinutes      *int  `json:"idleMinutes"`
	DetachedHours    *int  `json:"detachedHours"`
	MaxHours         *int  `json:"maxHours"`
	AllowFullAccess  *bool `json:"allowFullAccess"`
	TOTPOnHTTPS      *bool `json:"totpOnHttps"`
}

func (r *Remote) settings(p SettingsParams) string {
	inRange := func(v *int, lo, hi int, name string) string {
		if v != nil && (*v < lo || *v > hi) {
			return fmt.Sprintf("%s phải từ %d tới %d.", name, lo, hi)
		}
		return ""
	}
	for _, msg := range []string{
		inRange(p.IdleMinutes, 1, 1440, "idleMinutes"),
		inRange(p.DetachedHours, 1, 72, "detachedHours"),
		inRange(p.MaxHours, 1, 72, "maxHours"),
	} {
		if msg != "" {
			return msg
		}
	}
	changes := map[string]any{}
	_, err := r.Store.Update(func(c *remoteauth.Config) error {
		set := func(dst *bool, v *bool, key string) {
			if v != nil && *dst != *v {
				*dst = *v
				changes[key] = *v
			}
		}
		setInt := func(dst *int, v *int, key string) {
			if v != nil && *dst != *v {
				*dst = *v
				changes[key] = *v
			}
		}
		set(&c.ConfirmOnMachine, p.ConfirmOnMachine, "confirmOnMachine")
		set(&c.AllowFullAccess, p.AllowFullAccess, "allowFullAccess")
		set(&c.TOTPOnHTTPS, p.TOTPOnHTTPS, "totpOnHttps")
		setInt(&c.IdleMinutes, p.IdleMinutes, "idleMinutes")
		setInt(&c.DetachedHours, p.DetachedHours, "detachedHours")
		setInt(&c.MaxHours, p.MaxHours, "maxHours")
		if len(changes) == 0 {
			return errNoChange
		}
		return nil
	})
	if errors.Is(err, errNoChange) {
		return ""
	}
	if err != nil {
		return "Không ghi được remote.json: " + err.Error()
	}
	r.audit("settings", byMachine, changes)
	r.changed()
	return ""
}
