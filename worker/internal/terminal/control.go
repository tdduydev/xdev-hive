package terminal

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Cấp quyền gõ từ xa cho phiên tại máy (specs/010 T031; FR-016, FR-017, FR-021). Mỗi phiên có một người điều khiển: một
// terminal tại máy hoặc một kết nối từ xa. Quyền từ xa gắn với khoá phiên suy ra lúc xác thực; nối lại trong ResumeTTL
// bằng resumeToken dùng tiếp khoá và seq cũ nên điện thoại mất sóng không phải quét Face ID lại. Terminal tại máy luôn
// giành lại được (Ctrl-] t), vì người ngồi trước máy là chủ thật của phiên.

const (
	DefaultResumeTTL  = 2 * time.Minute
	DefaultMaxRejects = 3
	// grantQueue: phím từ xa chờ ghi PTY. Đầy là CLI không đọc nữa; bỏ gói thay vì chặn vòng đọc của kênh.
	grantQueue = 256
	// controlQueue: gói gửi hub của Controller, đi theo đúng thứ tự (granted trước event, revoked trước grant mới).
	controlQueue = 256
)

const (
	ControllerLocal  = "local"
	ControllerRemote = "remote"
)

// Lý do thu quyền của term_revoked.
const (
	RevokeTaken    = "taken"
	RevokeIdle     = "idle"
	RevokeDisabled = "disabled"
	RevokeDevice   = "device_revoked"
	RevokeInput    = "input_rejected"
	RevokeClosed   = "closed"
	RevokeExpired  = "expired"
)

// Mã từ chối riêng của Controller; các mã còn lại lấy từ remoteauth.
const (
	codeRemoteDisabled = "REMOTE_DISABLED"
	codeMachineShared  = "MACHINE_SHARED"
	codeSessionUnknown = "SESSION_UNKNOWN"
)

// Controller hiện thực term_control, term_detach, term_input, term_resize cho phiên tại máy. Recorder chuyển gói tới
// đây; Local báo khi người ở máy giành lại hay phiên kết thúc; Remote báo khi tắt từ xa hay gỡ thiết bị.
type Controller struct {
	Local    *Local
	Remote   *Remote
	Verifier *remoteauth.Verifier
	// Recorder là đường gửi về hub (kết nối hiện tại của kênh).
	Recorder *Recorder
	Logger   *slog.Logger
	// Idle ghi đè IdleMinutes của remote.json (test); 0 là theo remote.json.
	Idle       time.Duration
	ResumeTTL  time.Duration
	MaxRejects int

	once sync.Once
	out  chan func(Sender) error
	// grantMu xếp hàng các term_control, để hai thiết bị xin cùng lúc không cùng được trao một phiên.
	grantMu sync.Mutex
	mu      sync.Mutex
	policy  *bool
	grants  map[string]*grant
}

// grant là quyền gõ của một kết nối từ xa trên một phiên. Trường đổi được giữ bởi Controller.mu.
type grant struct {
	c    *Controller
	sess *localSession

	sessionID, userID, deviceID, kind, label string
	token, workerEphPub                      string
	verifier                                 *remoteauth.InputVerifier
	idle                                     time.Duration

	connID   string
	rejects  int
	detached bool
	active   time.Time
	// gen tăng mỗi lần đặt lại hẹn giờ; hẹn giờ cũ đã bắn muộn thấy gen khác thì thôi.
	gen   int
	timer *time.Timer
	work  chan func()
	ended bool
}

func (c *Controller) log() *slog.Logger {
	if c.Logger == nil {
		return slog.Default()
	}
	return c.Logger
}

func (c *Controller) init() {
	c.once.Do(func() {
		c.out = make(chan func(Sender) error, controlQueue)
		go func() {
			for fn := range c.out {
				if link := c.Recorder.sender(); link != nil {
					_ = fn(link)
				}
			}
		}()
	})
}

// send xếp gói gửi hub; hàng đầy (hub treo) thì bỏ, vì hub nối lại sẽ nhận term_state và trình duyệt xin lại.
func (c *Controller) send(fn func(Sender) error) {
	c.init()
	select {
	case c.out <- fn:
	default:
		c.log().Warn("Hàng gói điều khiển gửi hub đã đầy; bỏ gói")
	}
}

func (c *Controller) event(g *grant, kind string, data map[string]any) {
	b, _ := json.Marshal(data)
	e := SessionEvent{SessionID: g.sessionID, Seq: g.sess.rec.Seq(), Event: kind, Data: b}
	c.send(func(l Sender) error { return l.Event(e) })
}

func (c *Controller) resumeTTL() time.Duration { return orDefault(c.ResumeTTL, DefaultResumeTTL) }
func (c *Controller) maxRejects() int          { return orDefault(c.MaxRejects, DefaultMaxRejects) }

// onWelcome giữ chính sách TOTP của tổ chức cho các lần kiểm sau.
func (c *Controller) onWelcome(info WelcomeInfo) {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.policy = nil
	if info.Policy != nil {
		v := info.Policy.TOTPFallback
		c.policy = &v
	}
}

// onDisconnect: mọi kết nối từ xa đã mất cùng hub; giữ quyền ResumeTTL để điện thoại nối lại khi hub về.
func (c *Controller) onDisconnect() {
	if c == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, g := range c.grants {
		if !g.detached {
			g.detached = true
			c.armLocked(g)
		}
	}
}

// ---- term_control ----

func (c *Controller) Control(req ControlRequest) {
	// Kiểm chữ ký, đọc remote.json và chờ PTY không được chặn vòng đọc của kênh.
	go c.control(req)
}

func (c *Controller) control(req ControlRequest) {
	c.grantMu.Lock()
	defer c.grantMu.Unlock()
	cfg, code := c.allowed()
	if code != "" {
		c.deny(req, code)
		return
	}
	s := c.Local.byHubID(req.SessionID)
	if s == nil {
		c.deny(req, codeSessionUnknown)
		return
	}
	if req.ResumeToken != "" {
		c.resume(req)
		return
	}
	if req.Auth == nil {
		c.deny(req, remoteauth.CodeAuthInvalid)
		return
	}
	a := req.Auth
	auth := remoteauth.Auth{Kind: a.Kind, Code: a.Code, EphPub: a.EphPub, TS: a.TS, Nonce: a.Nonce}
	if a.Assertion != nil {
		auth.Assertion = &remoteauth.Assertion{CredentialID: a.Assertion.CredentialID,
			AuthenticatorData: a.Assertion.AuthenticatorData, ClientDataJSON: a.Assertion.ClientDataJSON,
			Signature: a.Assertion.Signature, UserHandle: a.Assertion.UserHandle}
	}
	c.mu.Lock()
	policy := c.policy
	c.mu.Unlock()
	owner := cfg.OwnerUserID
	if o := c.Remote.welcomeOwner(); o != nil && o.UserID != "" {
		owner = o.UserID
	}
	res, err := c.Verifier.VerifyAuth(remoteauth.Request{
		MachineID: c.Remote.Machine, Action: "control",
		Params: remoteauth.ControlParams(req.UserID, req.DeviceID, req.SessionID, req.ConnID), Auth: auth,
	}, remoteauth.Policy{HubURL: c.Remote.HubURL, TOTPFallback: policy, TOTPOnHTTPS: cfg.TOTPOnHTTPS, OwnerUserID: owner})
	if auth.Kind == remoteauth.KindTOTP {
		// Đếm sai và khoá TOTP nằm trong term_state; báo hub để điện thoại hiện "đã khoá" đúng lúc.
		c.Remote.changed()
	}
	if err != nil {
		c.log().Info("Từ chối quyền điều khiển từ xa", "session", req.SessionID, "code", remoteauth.Code(err), "error", err)
		c.Remote.audit("control_denied", byHub(req.UserID), map[string]any{"sessionId": req.SessionID,
			"deviceId": req.DeviceID, "code": remoteauth.Code(err)})
		c.deny(req, remoteauth.Code(err))
		return
	}
	pub, key, err := remoteauth.SessionKey(a.EphPub, res.Challenge, res.KeyInfo)
	if err != nil {
		c.deny(req, remoteauth.CodeAuthInvalid)
		return
	}
	g := &grant{c: c, sess: s, sessionID: req.SessionID, connID: req.ConnID, userID: req.UserID, deviceID: req.DeviceID,
		kind: res.Kind, label: deviceLabel(cfg, res), token: randomID("", 24), workerEphPub: pub,
		verifier: remoteauth.NewInputVerifier(key), idle: c.idleFor(cfg), active: time.Now(),
		work: make(chan func(), grantQueue)}
	go func() {
		for fn := range g.work {
			fn()
		}
	}()

	c.mu.Lock()
	if c.grants == nil {
		c.grants = map[string]*grant{}
	}
	old := c.grants[g.sessionID]
	c.mu.Unlock()
	if old != nil {
		// Thiết bị khác (hay chính nó trên tab khác) xin quyền: người cũ chỉ còn xem.
		c.drop(old, RevokeTaken)
	}
	if !s.giveRemote(g) {
		c.closeWork(g)
		c.deny(req, codeSessionUnknown)
		return
	}
	c.mu.Lock()
	c.grants[g.sessionID] = g
	c.armLocked(g)
	c.mu.Unlock()
	c.granted(g, false)
}

// resume nối lại bằng resumeToken: cùng người, cùng thiết bị, trong ResumeTTL kể từ khi mất kết nối.
func (c *Controller) resume(req ControlRequest) {
	c.mu.Lock()
	g := c.grants[req.SessionID]
	ok := g != nil && !g.ended && g.userID == req.UserID && g.deviceID == req.DeviceID &&
		subtle.ConstantTimeCompare([]byte(g.token), []byte(req.ResumeToken)) == 1
	if !ok {
		c.mu.Unlock()
		c.deny(req, remoteauth.CodeAuthStale)
		return
	}
	oldConn, attached := g.connID, !g.detached
	g.connID, g.detached, g.active = req.ConnID, false, time.Now()
	c.armLocked(g)
	c.mu.Unlock()
	if attached && oldConn != req.ConnID {
		// Kết nối cũ chưa kịp báo tách (tab cũ còn mở): chỉ một kết nối giữ khoá được gõ.
		c.send(func(l Sender) error {
			return l.Revoked(Revoked{SessionID: g.sessionID, ConnID: oldConn, Reason: RevokeTaken})
		})
	}
	c.granted(g, true)
}

func (c *Controller) granted(g *grant, resumed bool) {
	c.mu.Lock()
	gr := Granted{SessionID: g.sessionID, ConnID: g.connID, WorkerEphPub: g.workerEphPub, ResumeToken: g.token}
	c.mu.Unlock()
	c.send(func(l Sender) error { return l.Granted(gr) })
	c.event(g, "controller", map[string]any{"connId": gr.ConnID, "controller": ControllerRemote, "label": g.label})
	action := "control_grant"
	if resumed {
		action = "control_resume"
	}
	c.Remote.audit(action, byHub(g.userID), map[string]any{"sessionId": g.sessionID, "deviceId": g.deviceID,
		"kind": g.kind, "label": g.label})
	c.log().Info("Cấp quyền điều khiển từ xa", "session", g.sessionID, "device", g.deviceID, "resume", resumed)
}

// allowed: chỉ cấp quyền khi máy bật từ xa và không dùng chung (FR-012, D13).
func (c *Controller) allowed() (remoteauth.Config, string) {
	if c.Remote == nil || c.Verifier == nil || c.Local == nil {
		return remoteauth.Config{}, codeRemoteDisabled
	}
	if o := c.Remote.welcomeOwner(); o != nil && o.Shared {
		return remoteauth.Config{}, codeMachineShared
	}
	cfg, err := c.Remote.Store.Load()
	if err != nil || !cfg.Enabled {
		return remoteauth.Config{}, codeRemoteDisabled
	}
	return cfg, ""
}

func (c *Controller) idleFor(cfg remoteauth.Config) time.Duration {
	if c.Idle > 0 {
		return c.Idle
	}
	return cfg.Idle()
}

func deviceLabel(cfg remoteauth.Config, res remoteauth.Result) string {
	if res.Kind == remoteauth.KindTOTP {
		return "mã TOTP"
	}
	if i := slices.IndexFunc(cfg.Devices, func(d remoteauth.Device) bool { return d.ID == res.DeviceID }); i >= 0 {
		if l := cleanLabel(cfg.Devices[i].Label); l != "" {
			return l
		}
	}
	return "thiết bị đã ghép"
}

var errNoSeq = errors.New("gói nhập thiếu seq")

var controlDenyText = map[string]string{
	codeRemoteDisabled:        remoteDisabledText,
	codeMachineShared:         "Máy dùng chung không cho điều khiển từ xa.",
	codeSessionUnknown:        "Phiên không còn chạy trên máy.",
	remoteauth.CodeAuthStale:  "Quyền điều khiển cũ đã hết hạn; xác thực lại để điều khiển.",
	remoteauth.CodeAuthReplay: "Yêu cầu đã được dùng; thử lại.",
}

// deny: term_denied cần requestId của term_start nên quyền điều khiển bị từ chối đi bằng sự kiện controller của phiên,
// kèm connId để hub chuyển đúng trình duyệt.
func (c *Controller) deny(req ControlRequest, code string) {
	text, ok := controlDenyText[code]
	if !ok {
		text = "Máy từ chối quyền điều khiển (" + code + ")."
	}
	data, _ := json.Marshal(map[string]any{"connId": req.ConnID, "denied": code, "reason": text})
	var seq int64
	if c.Local != nil {
		if s := c.Local.byHubID(req.SessionID); s != nil {
			seq = s.rec.Seq()
		}
	}
	e := SessionEvent{SessionID: req.SessionID, Seq: seq, Event: "controller", Data: data}
	c.send(func(l Sender) error { return l.Event(e) })
}

// ---- Gói của kết nối đã được cấp ----

func (c *Controller) Detach(req DetachRequest) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if g := c.grants[req.SessionID]; g != nil && !g.ended && !g.detached && g.connID == req.ConnID {
		g.detached = true
		c.armLocked(g)
	}
}

func (c *Controller) Input(req InputRequest) {
	data := req.Data
	c.accept(req.SessionID, req.ConnID, req.Seq, req.MAC, func(seq int64) ([]byte, error) {
		return remoteauth.InputPayload(req.SessionID, req.ConnID, seq, data)
	}, func(g *grant) { g.sess.remoteWrite(g, data) })
}

// Resize: PTY theo cỡ màn của người điều khiển, nên chỉ kết nối đang giữ quyền đổi được.
func (c *Controller) Resize(req ResizeRequest) {
	cols, rows := req.Cols, req.Rows
	c.accept(req.SessionID, req.ConnID, req.Seq, req.MAC, func(seq int64) ([]byte, error) {
		return remoteauth.ResizePayload(req.SessionID, req.ConnID, seq, cols, rows)
	}, func(g *grant) { g.sess.remoteResize(g, cols, rows) })
}

func (c *Controller) accept(sessionID, connID string, seq *int64, mac string, payload func(int64) ([]byte, error),
	apply func(*grant)) {
	c.mu.Lock()
	g := c.grants[sessionID]
	if g == nil || g.ended || g.detached || g.connID != connID {
		// Gói muộn của kết nối đã mất quyền: bỏ, không tính lỗi (không phải giả mạo).
		c.mu.Unlock()
		return
	}
	err := errNoSeq
	if seq != nil {
		var p []byte
		if p, err = payload(*seq); err == nil {
			err = g.verifier.Verify(*seq, p, mac)
		}
	}
	if err != nil {
		g.rejects++
		n := g.rejects
		c.mu.Unlock()
		c.log().Warn("Bỏ gói nhập từ xa sai HMAC hoặc seq", "session", sessionID, "count", n, "error", err)
		c.event(g, "input_rejected", map[string]any{"connId": connID, "count": n})
		c.Remote.audit("input_rejected", byHub(g.userID), map[string]any{"sessionId": sessionID, "deviceId": g.deviceID,
			"count": n})
		if n >= c.maxRejects() {
			c.revoke(g, RevokeInput, nil)
		}
		return
	}
	g.active = time.Now()
	select {
	case g.work <- func() { apply(g) }:
	default:
		c.log().Warn("PTY không đọc kịp phím từ xa; bỏ gói", "session", sessionID)
	}
	c.mu.Unlock()
}

// ---- Thu quyền ----

// armLocked đặt hẹn giờ: hết idle khi đang nối, hết ResumeTTL khi đã tách.
func (c *Controller) armLocked(g *grant) {
	if g.timer != nil {
		g.timer.Stop()
	}
	g.gen++
	gen := g.gen
	d := g.idle
	if g.detached {
		d = c.resumeTTL()
	}
	g.timer = time.AfterFunc(d, func() { c.expire(g, gen) })
}

func (c *Controller) expire(g *grant, gen int) {
	c.mu.Lock()
	if g.ended || g.gen != gen {
		c.mu.Unlock()
		return
	}
	if !g.detached {
		// Hẹn giờ không đặt lại mỗi phím (tốn với gõ nhanh); bắn thì tính phần còn lại theo phím cuối.
		if rest := g.idle - time.Since(g.active); rest > 0 {
			g.timer = time.AfterFunc(rest, func() { c.expire(g, gen) })
			c.mu.Unlock()
			return
		}
	}
	reason := RevokeIdle
	if g.detached {
		reason = RevokeExpired
	}
	c.mu.Unlock()
	c.revoke(g, reason, nil)
}

// drop thu quyền g và báo kết nối của nó; false khi g đã bị thu.
func (c *Controller) drop(g *grant, reason string) bool {
	c.mu.Lock()
	if g.ended {
		c.mu.Unlock()
		return false
	}
	g.ended = true
	if c.grants[g.sessionID] == g {
		delete(c.grants, g.sessionID)
	}
	if g.timer != nil {
		g.timer.Stop()
	}
	close(g.work)
	rv := Revoked{SessionID: g.sessionID, ConnID: g.connID, Reason: reason}
	c.mu.Unlock()
	g.sess.releaseRemote(g)
	c.send(func(l Sender) error { return l.Revoked(rv) })
	c.Remote.audit("control_revoke", byHub(g.userID), map[string]any{"sessionId": g.sessionID, "deviceId": g.deviceID,
		"reason": reason})
	c.log().Info("Thu quyền điều khiển từ xa", "session", g.sessionID, "reason", reason)
	return true
}

func (c *Controller) closeWork(g *grant) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !g.ended {
		g.ended = true
		close(g.work)
	}
}

// revoke thu quyền rồi báo mọi người xem ai đang điều khiển (now nil là không ai).
func (c *Controller) revoke(g *grant, reason string, now *string) {
	if !c.drop(g, reason) {
		return
	}
	c.mu.Lock()
	conn := g.connID
	c.mu.Unlock()
	data := map[string]any{"connId": conn, "controller": nil, "reason": reason}
	if now != nil {
		data["controller"] = *now
	}
	c.event(g, "controller", data)
}

// localTook: người ở máy giành lại (Ctrl-] t hay hive attach); trình duyệt hiện "Máy đã lấy lại quyền điều khiển".
func (c *Controller) localTook(g *grant) {
	local := ControllerLocal
	c.revoke(g, RevokeTaken, &local)
}

// sessionClosed: phiên kết thúc thì quyền của nó hết theo.
func (c *Controller) sessionClosed(hubID string) {
	if c == nil || hubID == "" {
		return
	}
	c.mu.Lock()
	g := c.grants[hubID]
	c.mu.Unlock()
	if g != nil {
		c.drop(g, RevokeClosed)
	}
}

// RevokeAll thu mọi quyền từ xa (tắt từ xa, máy thành dùng chung).
func (c *Controller) RevokeAll(reason string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	list := make([]*grant, 0, len(c.grants))
	for _, g := range c.grants {
		list = append(list, g)
	}
	c.mu.Unlock()
	for _, g := range list {
		c.revoke(g, reason, nil)
	}
}

// RevokeDevice thu quyền của thiết bị vừa bị gỡ. Quyền cấp bằng TOTP không gắn thiết bị nên giữ nguyên.
func (c *Controller) RevokeDevice(deviceID string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	var list []*grant
	for _, g := range c.grants {
		if g.kind == remoteauth.KindPasskey && g.deviceID == deviceID {
			list = append(list, g)
		}
	}
	c.mu.Unlock()
	for _, g := range list {
		c.revoke(g, RevokeDevice, nil)
	}
}
