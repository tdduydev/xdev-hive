//go:build !windows

package terminal

import (
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Vector cố định: khoá TOTP của RFC 6238 và mốc giờ cố định; mỗi lần xin quyền tiến một bước TOTP để mã không bị coi
// là dùng lại.
var (
	ctlSecret = []byte("12345678901234567890")
	ctlStart  = time.Unix(1_792_000_000, 0)
)

type ctlEnv struct {
	t    *testing.T
	ctl  *Controller
	rem  *Remote
	link *fakeLink
	tc   *tclient
	hub  string
	path string

	mu  sync.Mutex
	now time.Time
}

func (e *ctlEnv) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now
}

// newCtlEnv dựng máy đã bật từ xa (hub HTTP nên nhận TOTP, chủ máy u1) với một phiên `hive chat` đang được terminal tại
// máy điều khiển.
func newCtlEnv(t *testing.T, tune func(*Controller)) *ctlEnv {
	t.Helper()
	e := &ctlEnv{t: t, link: newFakeLink(), now: ctlStart}
	e.rem = newRemote(t)
	e.rem.HubURL = "http://192.0.2.10:3000"
	if _, err := e.rem.Store.Update(func(c *remoteauth.Config) error {
		c.Enabled, c.OwnerUserID = true, "u1"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	prev := ctlStart.Add(-remoteauth.TOTPPeriod * time.Second)
	if err := e.rem.TOTP.Enable(ctlSecret, remoteauth.TOTPCode(ctlSecret, prev.Unix()/remoteauth.TOTPPeriod), prev); err != nil {
		t.Fatal(err)
	}
	rec := newRecorder(t)
	rec.Remote = e.rem
	l := &Local{Recorder: rec, Remote: e.rem}
	e.ctl = &Controller{Local: l, Remote: e.rem, Recorder: rec,
		Verifier: &remoteauth.Verifier{Now: e.clock, Devices: e.rem.Store, TOTP: e.rem.TOTP}}
	if tune != nil {
		tune(e.ctl)
	}
	rec.Controller, l.Controller, e.rem.Controller = e.ctl, e.ctl, e.ctl
	rec.OnWelcome(personal(), e.link)
	e.path = startLocal(t, l)
	e.tc, _ = gate(t, e.path, createReq(t, nil))
	e.tc.waitCtl(t, localipc.CtlControl)
	e.tc.waitOut(t, "READY")
	e.hub = l.List()[0].HubID
	if e.hub == "" {
		t.Fatal("phiên phải được ghi lên hub")
	}
	return e
}

// phone là trình duyệt trên điện thoại: giữ khoá phiên và seq như input-mac.ts.
type phone struct {
	e      *ctlEnv
	conn   string
	key    []byte
	seq    int64
	grant  Granted
	userID string
}

func (e *ctlEnv) request(userID, conn string) (ControlRequest, *ecdh.PrivateKey, remoteauth.Request) {
	e.t.Helper()
	e.mu.Lock()
	e.now = e.now.Add(remoteauth.TOTPPeriod * time.Second)
	now := e.now
	e.mu.Unlock()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		e.t.Fatal(err)
	}
	n := make([]byte, 16)
	_, _ = rand.Read(n)
	code := remoteauth.TOTPCode(ctlSecret, now.Unix()/remoteauth.TOTPPeriod)
	auth := Auth{Kind: remoteauth.KindTOTP, Code: code, EphPub: base64.RawURLEncoding.EncodeToString(priv.PublicKey().Bytes()),
		TS: now.Unix(), Nonce: base64.RawURLEncoding.EncodeToString(n)}
	req := ControlRequest{SessionID: e.hub, ConnID: conn, UserID: userID, DeviceID: "totp", Auth: &auth}
	signed := remoteauth.Request{MachineID: e.rem.Machine, Action: "control",
		Params: remoteauth.ControlParams(userID, "totp", e.hub, conn),
		Auth:   remoteauth.Auth{Kind: auth.Kind, Code: auth.Code, EphPub: auth.EphPub, TS: auth.TS, Nonce: auth.Nonce}}
	return req, priv, signed
}

// control xin quyền và chờ term_granted.
func (e *ctlEnv) control(conn string) *phone {
	e.t.Helper()
	req, priv, signed := e.request("u1", conn)
	e.ctl.Control(req)
	g := e.waitGranted(conn)
	challenge, err := remoteauth.Challenge(signed)
	if err != nil {
		e.t.Fatal(err)
	}
	key, err := remoteauth.DeriveInputKey(priv, g.WorkerEphPub, challenge, remoteauth.KeyInfo(remoteauth.KindTOTP, req.Auth.Code))
	if err != nil {
		e.t.Fatal(err)
	}
	return &phone{e: e, conn: conn, key: key, grant: g, userID: "u1"}
}

func (e *ctlEnv) waitGranted(conn string) Granted {
	e.t.Helper()
	var got Granted
	waitRec(e.t, "term_granted cho "+conn, func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, g := range f.granted {
				if g.ConnID == conn {
					got, ok = g, true
				}
			}
		})
		return ok
	})
	return got
}

func (e *ctlEnv) waitRevoked(conn, reason string) {
	e.t.Helper()
	waitRec(e.t, "term_revoked "+reason, func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, r := range f.revoked {
				if r.ConnID == conn && r.Reason == reason && r.SessionID == e.hub {
					ok = true
				}
			}
		})
		return ok
	})
}

// waitEvent chờ sự kiện kind có data chứa đủ các cặp trong want.
func (e *ctlEnv) waitEvent(kind string, want map[string]any) {
	e.t.Helper()
	waitRec(e.t, "term_event "+kind, func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, ev := range f.events {
				if ev.Event != kind || ev.SessionID != e.hub {
					continue
				}
				var d map[string]any
				_ = json.Unmarshal(ev.Data, &d)
				match := true
				for k, v := range want {
					if d[k] != v {
						match = false
					}
				}
				ok = ok || match
			}
		})
		return ok
	})
}

func (p *phone) mac(payload []byte) string {
	h := hmac.New(sha256.New, p.key)
	h.Write(payload)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil)[:remoteauth.InputMACBytes])
}

func (p *phone) input(s string) {
	p.seq++
	seq := p.seq
	payload, err := remoteauth.InputPayload(p.e.hub, p.conn, seq, []byte(s))
	if err != nil {
		p.e.t.Fatal(err)
	}
	p.e.ctl.Input(InputRequest{SessionID: p.e.hub, ConnID: p.conn, Data: []byte(s), Seq: &seq, MAC: p.mac(payload)})
}

func (p *phone) resize(cols, rows int) {
	p.seq++
	seq := p.seq
	payload, err := remoteauth.ResizePayload(p.e.hub, p.conn, seq, cols, rows)
	if err != nil {
		p.e.t.Fatal(err)
	}
	p.e.ctl.Resize(ResizeRequest{SessionID: p.e.hub, ConnID: p.conn, Cols: cols, Rows: rows, Seq: &seq, MAC: p.mac(payload)})
}

func (e *ctlEnv) stateController() *string {
	var who *string
	e.link.snapshot(func(f *fakeLink) {
		if n := len(f.states); n > 0 {
			for _, s := range f.states[n-1].Sessions {
				if s.ID == e.hub {
					who = s.Controller
				}
			}
		}
	})
	return who
}

func (e *ctlEnv) waitController(want string) {
	e.t.Helper()
	waitRec(e.t, "term_state controller "+want, func() bool {
		who := e.stateController()
		if want == "" {
			return who == nil
		}
		return who != nil && *who == want
	})
}

// US3 kịch bản 2: cấp quyền, terminal tại máy chỉ còn xem kèm dòng báo, phím từ xa tới CLI, phím tại máy bị bỏ.
func TestControlGrant(t *testing.T) {
	e := newCtlEnv(t, nil)
	e.waitController(ControllerLocal)
	p := e.control("conn-a1")
	if p.grant.SessionID != e.hub || p.grant.ResumeToken == "" || p.grant.WorkerEphPub == "" {
		t.Fatalf("granted = %+v", p.grant)
	}
	taken := e.tc.waitCtl(t, localipc.CtlTaken)
	if taken.Message != "Đang điều khiển từ xa bởi mã TOTP." {
		t.Fatalf("dòng báo tại máy = %q", taken.Message)
	}
	e.waitEvent("controller", map[string]any{"connId": "conn-a1", "controller": ControllerRemote})
	e.waitController(ControllerRemote)

	e.tc.send(t, "tai-may\n")
	p.resize(60, 20)
	p.input("tu-xa\n")
	e.tc.waitOut(t, "got:tu-xa")
	if strings.Contains(e.tc.output(), "got:tai-may") {
		t.Fatal("phím của terminal chỉ xem không được tới CLI")
	}
	e.link.snapshot(func(f *fakeLink) {
		for _, ev := range f.events {
			if ev.Event == "input_rejected" {
				t.Fatalf("gói đúng bị từ chối: %s", ev.Data)
			}
		}
	})
	if a := auditActions(t, e.rem); !containsAll(a, "control_grant") {
		t.Fatalf("audit = %v", a)
	}
}

// US3 kịch bản 3: người ở máy giành lại, điện thoại bị thu quyền "taken" và thấy máy đang điều khiển.
func TestControlLocalTakesBack(t *testing.T) {
	e := newCtlEnv(t, nil)
	p := e.control("conn-b1")
	e.tc.waitCtl(t, localipc.CtlTaken)
	e.tc.ctl(t, localipc.CtlTake)
	e.waitRevoked("conn-b1", RevokeTaken)
	e.waitEvent("controller", map[string]any{"connId": "conn-b1", "controller": ControllerLocal, "reason": RevokeTaken})
	e.waitController(ControllerLocal)

	p.input("muon\n")
	e.tc.send(t, "lai-may\n")
	e.tc.waitOut(t, "got:lai-may")
	if strings.Contains(e.tc.output(), "got:muon") {
		t.Fatal("phím của kết nối đã bị thu quyền không được tới CLI")
	}
}

// Thiết bị thứ hai xin quyền: người đang điều khiển từ xa bị thu "taken", người mới gõ được.
func TestControlSecondRemoteTakes(t *testing.T) {
	e := newCtlEnv(t, nil)
	e.control("conn-c1")
	p2 := e.control("conn-c2")
	e.waitRevoked("conn-c1", RevokeTaken)
	p2.input("thu-hai\n")
	e.tc.waitOut(t, "got:thu-hai")
}

// US3 kịch bản 4: HMAC sai, seq không tăng, thiếu seq đều bị bỏ và đếm; đủ 3 thì thu quyền.
func TestControlRejectsBadInput(t *testing.T) {
	e := newCtlEnv(t, nil)
	p := e.control("conn-d1")
	p.input("dung\n")
	e.tc.waitOut(t, "got:dung")

	seq := int64(2)
	payload, _ := remoteauth.InputPayload(e.hub, p.conn, seq, []byte("sai\n"))
	bad := p.mac(append(payload, '!'))
	e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: p.conn, Data: []byte("sai\n"), Seq: &seq, MAC: bad})
	e.waitEvent("input_rejected", map[string]any{"connId": "conn-d1", "count": float64(1)})

	old := int64(1)
	payload, _ = remoteauth.InputPayload(e.hub, p.conn, old, []byte("lap\n"))
	e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: p.conn, Data: []byte("lap\n"), Seq: &old, MAC: p.mac(payload)})
	e.waitEvent("input_rejected", map[string]any{"count": float64(2)})

	// Gói đúng xen giữa không xoá bộ đếm: kẻ giả gói không được thử mãi.
	p.input("van-dung\n")
	e.tc.waitOut(t, "got:van-dung")

	e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: p.conn, Data: []byte("khong-seq\n")})
	e.waitEvent("input_rejected", map[string]any{"count": float64(3)})
	e.waitRevoked("conn-d1", RevokeInput)
	e.waitController("")

	// Gói của kết nối khác (không giữ quyền) bị bỏ mà không tính lỗi.
	e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: "conn-khac", Data: []byte("x")})
	p.input("sau-thu\n")
	time.Sleep(100 * time.Millisecond)
	out := e.tc.output()
	for _, s := range []string{"got:sai", "got:lap", "got:khong-seq", "got:sau-thu"} {
		if strings.Contains(out, s) {
			t.Fatalf("gói bị từ chối vẫn tới CLI: %q", s)
		}
	}
	if a := auditActions(t, e.rem); !containsAll(a, "input_rejected", "control_revoke") {
		t.Fatalf("audit = %v", a)
	}
}

// US3 kịch bản 5: mất kết nối rồi nối lại trong hạn dùng lại khoá và seq cũ, không xác thực lại; quá hạn phải xin lại.
func TestControlResume(t *testing.T) {
	e := newCtlEnv(t, func(c *Controller) { c.ResumeTTL = 300 * time.Millisecond })
	p := e.control("conn-e1")
	p.input("truoc\n")
	e.tc.waitOut(t, "got:truoc")

	e.ctl.Detach(DetachRequest{SessionID: e.hub, ConnID: "conn-e1"})
	e.ctl.Control(ControlRequest{SessionID: e.hub, ConnID: "conn-e2", UserID: "u1", DeviceID: "totp",
		ResumeToken: p.grant.ResumeToken})
	g := e.waitGranted("conn-e2")
	if g.WorkerEphPub != p.grant.WorkerEphPub || g.ResumeToken != p.grant.ResumeToken {
		t.Fatalf("nối lại phải giữ khoá cũ: %+v vs %+v", g, p.grant)
	}
	p.conn = "conn-e2"
	p.input("sau\n")
	e.tc.waitOut(t, "got:sau")

	// Token đúng nhưng người khác: không nối được.
	e.ctl.Control(ControlRequest{SessionID: e.hub, ConnID: "conn-e3", UserID: "u2", DeviceID: "totp",
		ResumeToken: p.grant.ResumeToken})
	e.waitEvent("controller", map[string]any{"connId": "conn-e3", "denied": remoteauth.CodeAuthStale})

	// Hub mất kết nối: quyền chờ ResumeTTL rồi hết.
	e.ctl.Recorder.OnDisconnect()
	e.ctl.Recorder.OnWelcome(personal(), e.link)
	e.waitRevoked("conn-e2", RevokeExpired)
	e.ctl.Control(ControlRequest{SessionID: e.hub, ConnID: "conn-e4", UserID: "u1", DeviceID: "totp",
		ResumeToken: p.grant.ResumeToken})
	e.waitEvent("controller", map[string]any{"connId": "conn-e4", "denied": remoteauth.CodeAuthStale})
}

// US3 kịch bản 6: không gõ quá Idle thì thu quyền; phím đều đặn giữ quyền.
func TestControlIdle(t *testing.T) {
	e := newCtlEnv(t, func(c *Controller) { c.Idle = 300 * time.Millisecond })
	p := e.control("conn-f1")
	for i := 0; i < 4; i++ {
		time.Sleep(150 * time.Millisecond)
		p.input("x")
	}
	e.link.snapshot(func(f *fakeLink) {
		if len(f.revoked) != 0 {
			t.Fatalf("đang gõ mà bị thu quyền: %+v", f.revoked)
		}
	})
	e.waitRevoked("conn-f1", RevokeIdle)
	e.waitController("")
}

// Tắt từ xa thu mọi quyền; máy đang tắt, người khác chủ máy, phiên lạ đều bị từ chối kèm mã.
func TestControlDeniedAndDisabled(t *testing.T) {
	e := newCtlEnv(t, nil)
	req, _, _ := e.request("u2", "conn-g0")
	e.ctl.Control(req)
	e.waitEvent("controller", map[string]any{"connId": "conn-g0", "denied": remoteauth.CodeDeviceUserMismatch})

	req, _, _ = e.request("u1", "conn-g1")
	req.SessionID = "5b0f8c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e"
	e.ctl.Control(req)
	waitRec(t, "SESSION_UNKNOWN", func() bool {
		ok := false
		e.link.snapshot(func(f *fakeLink) {
			for _, ev := range f.events {
				ok = ok || (ev.SessionID == req.SessionID && strings.Contains(string(ev.Data), codeSessionUnknown))
			}
		})
		return ok
	})

	e.control("conn-g2")
	e.rem.HubDisable(DisableRequest{By: "u1"})
	e.waitRevoked("conn-g2", RevokeDisabled)

	req, _, _ = e.request("u1", "conn-g3")
	e.ctl.Control(req)
	e.waitEvent("controller", map[string]any{"connId": "conn-g3", "denied": codeRemoteDisabled})
}

// Phiên kết thúc thì quyền hết theo.
func TestControlSessionExit(t *testing.T) {
	e := newCtlEnv(t, nil)
	p := e.control("conn-h1")
	p.input("quit\n")
	e.waitRevoked("conn-h1", RevokeClosed)
}

// containsAll: list là "action/by" của auditActions; chỉ so phần action.
func containsAll(list []string, want ...string) bool {
	for _, w := range want {
		found := false
		for _, a := range list {
			action, _, _ := strings.Cut(a, "/")
			found = found || action == w
		}
		if !found {
			return false
		}
	}
	return true
}
