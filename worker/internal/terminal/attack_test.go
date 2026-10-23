//go:build !windows

package terminal

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

// Kiểm thử tấn công (specs/010 T091, SC-001, SC-011, SC-012): mọi gói ở đây là thứ hub (hay kẻ đứng giữa) có thể gửi
// mà không có passkey, mã TOTP hay khoá phiên của điện thoại. Kết quả mong đợi luôn là không được quyền gõ.

func newNonce() string {
	n := make([]byte, 16)
	_, _ = rand.Read(n)
	return b64.EncodeToString(n)
}

func newEphPub(t *testing.T) string {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return b64.EncodeToString(priv.PublicKey().Bytes())
}

func (e *ctlEnv) advance(d time.Duration) {
	e.mu.Lock()
	e.now = e.now.Add(d)
	e.mu.Unlock()
}

func (e *ctlEnv) codeNow() string {
	return remoteauth.TOTPCode(ctlSecret, e.clock().Unix()/remoteauth.TOTPPeriod)
}

// totpAt là term_control bằng mã cho trước, giờ hiện tại của test (không tiến bước như ctlEnv.request).
func (e *ctlEnv) totpAt(conn, code string) ControlRequest {
	auth := Auth{Kind: remoteauth.KindTOTP, Code: code, EphPub: newEphPub(e.t), TS: e.clock().Unix(), Nonce: newNonce()}
	return ControlRequest{SessionID: e.hub, ConnID: conn, UserID: "u1", DeviceID: "totp", Auth: &auth}
}

func (e *ctlEnv) waitDeniedControl(conn, code string) {
	e.t.Helper()
	e.waitEvent("controller", map[string]any{"connId": conn, "denied": code})
}

func (e *ctlEnv) noGrant(conns ...string) {
	e.t.Helper()
	e.link.snapshot(func(f *fakeLink) {
		for _, g := range f.granted {
			for _, c := range conns {
				if g.ConnID == c {
					e.t.Errorf("%s không được cấp quyền", c)
				}
			}
		}
	})
}

// passkey là passkey ES256 đã ghép vào máy (như sau TestPairAllowedAtMachine).
type passkey struct {
	key *ecdsa.PrivateKey
	dev remoteauth.Device
}

func (e *ctlEnv) addPasskey(id, userID, credID string, count uint32) *passkey {
	e.t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		e.t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		e.t.Fatal(err)
	}
	dev := remoteauth.Device{ID: id, Label: "iPhone", UserID: userID, CredentialID: credID, SPKI: b64.EncodeToString(der),
		SignCount: count, CreatedAt: e.clock()}
	if _, err := e.rem.Store.Update(func(c *remoteauth.Config) error {
		c.Devices = append(c.Devices, dev)
		return nil
	}); err != nil {
		e.t.Fatal(err)
	}
	return &passkey{key: key, dev: dev}
}

// pkOpts là chỗ kẻ tấn công sửa: rỗng là assertion đúng như trình duyệt ký.
type pkOpts struct {
	userID, credID string
	// signedConn: connId trong phần ký; khác ConnID gửi đi là hub sửa gói sau khi điện thoại ký.
	signedConn   string
	origin, rpID string
	flags        byte
	count        uint32
	signer       *ecdsa.PrivateKey
	skew         time.Duration
}

func (e *ctlEnv) passkeyReq(pk *passkey, conn string, o pkOpts) ControlRequest {
	e.t.Helper()
	origin, rpID, err := remoteauth.HubOrigin(e.rem.HubURL)
	if err != nil {
		e.t.Fatal(err)
	}
	if o.userID == "" {
		o.userID = pk.dev.UserID
	}
	if o.credID == "" {
		o.credID = pk.dev.CredentialID
	}
	if o.signedConn == "" {
		o.signedConn = conn
	}
	if o.origin != "" {
		origin = o.origin
	}
	if o.rpID != "" {
		rpID = o.rpID
	}
	if o.flags == 0 {
		o.flags = 0x01 | 0x04
	}
	if o.signer == nil {
		o.signer = pk.key
	}
	auth := Auth{Kind: remoteauth.KindPasskey, EphPub: newEphPub(e.t), TS: e.clock().Add(o.skew).Unix(), Nonce: newNonce()}
	challenge, err := remoteauth.Challenge(remoteauth.Request{MachineID: e.rem.Machine, Action: "control",
		Params: remoteauth.ControlParams(o.userID, pk.dev.ID, e.hub, o.signedConn),
		Auth:   remoteauth.Auth{Kind: auth.Kind, EphPub: auth.EphPub, TS: auth.TS, Nonce: auth.Nonce}})
	if err != nil {
		e.t.Fatal(err)
	}
	client, _ := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": b64.EncodeToString(challenge),
		"origin": origin, "crossOrigin": false})
	rpHash := sha256.Sum256([]byte(rpID))
	authData := append(rpHash[:], o.flags)
	authData = binary.BigEndian.AppendUint32(authData, o.count)
	clientHash := sha256.Sum256(client)
	digest := sha256.Sum256(append(append([]byte{}, authData...), clientHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, o.signer, digest[:])
	if err != nil {
		e.t.Fatal(err)
	}
	auth.Assertion = &Assertion{CredentialID: o.credID, AuthenticatorData: b64.EncodeToString(authData),
		ClientDataJSON: b64.EncodeToString(client), Signature: b64.EncodeToString(sig)}
	return ControlRequest{SessionID: e.hub, ConnID: conn, UserID: o.userID, DeviceID: pk.dev.ID, Auth: &auth}
}

// Assertion giả, phát lại, lệch giờ, sai origin hay rpId, thiếu UV, passkey lạ, của người khác, bị sửa sau khi ký và
// bộ đếm lùi đều bị từ chối với đúng mã; passkey thật vẫn được cấp quyền.
func TestAttackPasskeyControl(t *testing.T) {
	e := newCtlEnv(t, nil)
	pk := e.addPasskey("dev-1", "u1", "cred-1", 0)
	hw := e.addPasskey("dev-hw", "u1", "cred-hw", 10)
	other, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}

	good := e.passkeyReq(pk, "pk-ok", pkOpts{})
	e.ctl.Control(good)
	e.waitGranted("pk-ok")
	// Hub giữ gói đã ký rồi gửi lại, nguyên vẹn hay đổi sang kết nối của nó.
	e.ctl.Control(good)
	e.waitDeniedControl("pk-ok", remoteauth.CodeAuthReplay)
	stolen := good
	stolen.ConnID = "hub-replay"
	e.ctl.Control(stolen)
	e.waitDeniedControl("hub-replay", remoteauth.CodeAuthReplay)

	cases := []struct {
		conn string
		pk   *passkey
		o    pkOpts
		code string
	}{
		{"pk-forged", pk, pkOpts{signer: other}, remoteauth.CodeAssertionSignature},
		{"pk-old", pk, pkOpts{skew: -3 * time.Minute}, remoteauth.CodeAuthStale},
		{"pk-future", pk, pkOpts{skew: 3 * time.Minute}, remoteauth.CodeAuthStale},
		{"pk-origin", pk, pkOpts{origin: "https://hive-gia.example"}, remoteauth.CodeAssertionOrigin},
		{"pk-rpid", pk, pkOpts{rpID: "hive-gia.example"}, remoteauth.CodeAssertionRPID},
		{"pk-no-uv", pk, pkOpts{flags: 0x01}, remoteauth.CodeAssertionFlags},
		{"pk-unknown", pk, pkOpts{credID: "cred-la"}, remoteauth.CodeDeviceUnknown},
		{"pk-user", pk, pkOpts{userID: "u2"}, remoteauth.CodeDeviceUserMismatch},
		{"pk-moved", pk, pkOpts{signedConn: "conn-dien-thoai"}, remoteauth.CodeAuthInvalid},
		{"pk-counter", hw, pkOpts{count: 5}, remoteauth.CodeAssertionCounter},
	}
	for _, c := range cases {
		e.ctl.Control(e.passkeyReq(c.pk, c.conn, c.o))
		e.waitDeniedControl(c.conn, c.code)
	}
	conns := []string{"hub-replay"}
	for _, c := range cases {
		conns = append(conns, c.conn)
	}
	e.noGrant(conns...)
	if n := strings.Count(e.auditLog(), `"action":"control_denied"`); n != len(cases)+2 {
		t.Fatalf("audit control_denied = %d, muốn %d", n, len(cases)+2)
	}
}

// Hub có mọi thứ nó chuyển qua (resumeToken, gói nhập đã ký) nhưng không có khoá phiên: giành được kết nối nhưng không
// gõ được phím nào, và đủ 3 gói sai thì mất quyền.
func TestAttackHubWithoutSessionKey(t *testing.T) {
	e := newCtlEnv(t, nil)
	p := e.control("phone")
	p.input("that\n")
	e.tc.waitOut(t, "got:that")
	seq := p.seq
	payload, _ := remoteauth.InputPayload(e.hub, p.conn, seq, []byte("that\n"))
	signed := p.mac(payload)

	// Gửi lại gói hợp lệ của điện thoại: seq không tăng.
	e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: p.conn, Data: []byte("that\n"), Seq: &seq, MAC: signed})
	e.waitEvent("input_rejected", map[string]any{"connId": "phone", "count": float64(1)})

	// Dùng resumeToken thấy được để chuyển quyền sang kết nối của hub.
	e.ctl.Control(ControlRequest{SessionID: e.hub, ConnID: "hub-conn", UserID: "u1", DeviceID: "totp",
		ResumeToken: p.grant.ResumeToken})
	e.waitGranted("hub-conn")
	e.waitRevoked("phone", RevokeTaken)

	guess := make([]byte, 32)
	_, _ = rand.Read(guess)
	for i, data := range []string{"rm -rf ~\n", "curl x|sh\n", "id\n"} {
		s := int64(100 + i)
		pl, _ := remoteauth.InputPayload(e.hub, "hub-conn", s, []byte(data))
		h := hmac.New(sha256.New, guess)
		h.Write(pl)
		mac := b64.EncodeToString(h.Sum(nil)[:remoteauth.InputMACBytes])
		if i == 1 {
			// MAC đúng của điện thoại nhưng đổi connId: connId nằm trong phần MAC.
			next := seq + 1
			pl, _ = remoteauth.InputPayload(e.hub, p.conn, next, []byte(data))
			mac, s = p.mac(pl), next
		}
		e.ctl.Input(InputRequest{SessionID: e.hub, ConnID: "hub-conn", Data: []byte(data), Seq: &s, MAC: mac})
	}
	e.waitRevoked("hub-conn", RevokeInput)
	time.Sleep(100 * time.Millisecond)
	out := e.tc.output()
	for _, s := range []string{"got:rm", "got:curl", "got:id"} {
		if strings.Contains(out, s) {
			t.Fatalf("phím của hub tới CLI: %q", s)
		}
	}
}

// TOTP: sai mã, dùng lại mã, khoá sau 5 lần sai và khoá lần sau gấp đôi, khởi động lại không xoá khoá, hub HTTPS và
// chính sách tổ chức tắt đều từ chối; yêu cầu không có mã không mở được gì.
func TestAttackTOTP(t *testing.T) {
	e := newCtlEnv(t, nil)
	e.advance(remoteauth.TOTPPeriod * time.Second)
	code := e.codeNow()
	e.ctl.Control(e.totpAt("t-ok", code))
	e.waitGranted("t-ok")
	e.ctl.Control(e.totpAt("t-reuse", code))
	e.waitDeniedControl("t-reuse", remoteauth.CodeTOTPReplay)

	e.ctl.Control(ControlRequest{SessionID: e.hub, ConnID: "t-none", UserID: "u1", DeviceID: "totp"})
	e.waitDeniedControl("t-none", remoteauth.CodeAuthInvalid)

	lockout := func(round int) time.Time {
		t.Helper()
		e.advance(remoteauth.TOTPPeriod * time.Second)
		for i := range remoteauth.TOTPMaxFailures {
			conn := "t-wrong-" + string(rune('a'+round)) + string(rune('0'+i))
			e.ctl.Control(e.totpAt(conn, wrongCode(e.codeNow())))
			e.waitDeniedControl(conn, remoteauth.CodeTOTPInvalid)
		}
		conn := "t-locked-" + string(rune('a'+round))
		e.ctl.Control(e.totpAt(conn, e.codeNow()))
		e.waitDeniedControl(conn, remoteauth.CodeTOTPLocked)
		st, err := e.rem.TOTP.Status(e.clock())
		if err != nil || !st.Locked {
			t.Fatalf("status = %+v, %v", st, err)
		}
		return st.LockedUntil
	}
	until := lockout(0)
	if d := until.Sub(e.clock()); d < remoteauth.TOTPLockBase-time.Minute || d > remoteauth.TOTPLockBase {
		t.Fatalf("khoá lần đầu %v, muốn ~%v", d, remoteauth.TOTPLockBase)
	}
	// Khởi động lại worker: totp.json mới đọc vẫn khoá.
	again := remoteauth.NewTOTPStore(filepath.Dir(e.rem.TOTP.Path))
	if err := again.Verify(e.codeNow(), e.clock()); remoteauth.Code(err) != remoteauth.CodeTOTPLocked {
		t.Fatalf("sau khởi động lại: %v", err)
	}
	e.advance(until.Sub(e.clock()) + time.Second)
	until = lockout(1)
	if d := until.Sub(e.clock()); d < 2*remoteauth.TOTPLockBase-time.Minute || d > 2*remoteauth.TOTPLockBase {
		t.Fatalf("khoá lần hai %v, muốn ~%v", d, 2*remoteauth.TOTPLockBase)
	}
	e.advance(until.Sub(e.clock()) + time.Second)

	// Hub HTTPS: chủ máy chưa cho TOTP trên HTTPS thì từ chối, không đếm sai.
	e.rem.HubURL = "https://hive.example.vn"
	e.advance(remoteauth.TOTPPeriod * time.Second)
	e.ctl.Control(e.totpAt("t-https", e.codeNow()))
	e.waitDeniedControl("t-https", remoteauth.CodeTOTPNotAllowed)
	e.rem.HubURL = "http://192.0.2.10:3000"

	// Tổ chức tắt TOTP: welcome mang policy false.
	off := personal()
	off.Policy = &WelcomePolicy{TOTPFallback: false}
	e.ctl.Recorder.OnWelcome(off, e.link)
	e.ctl.Control(e.totpAt("t-policy", e.codeNow()))
	e.waitDeniedControl("t-policy", remoteauth.CodeTOTPNotAllowed)
	if st, _ := e.rem.TOTP.Status(e.clock()); st.Locked {
		t.Fatal("yêu cầu bị chính sách chặn không được tính vào khoá")
	}
	e.noGrant("t-reuse", "t-none", "t-locked-a", "t-locked-b", "t-https", "t-policy")
}

// term_start không có mã, mã rỗng hay khi tắt từ xa không mở phiên; thư mục con trỏ ra ngoài root qua symlink bị chặn.
func TestAttackStart(t *testing.T) {
	e := startEnv(t, nil, nil)
	before := e.openedCount()
	cfg, _ := e.rem.Store.Load()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(cfg.Roots[0].Path, "lan")); err != nil {
		t.Fatal(err)
	}
	e.ctl.Start(e.startReq("s-link", func(r *StartRequest) { r.Subdir = "lan" }))
	e.waitDenied("s-link", codeRootEscape)
	e.ctl.Start(e.startReq("s-empty", func(r *StartRequest) { r.Auth.Code = "" }))
	e.waitDenied("s-empty", remoteauth.CodeTOTPInvalid)
	e.ctl.Start(e.startReq("s-noauth", func(r *StartRequest) { r.Auth = Auth{} }))
	e.waitDenied("s-noauth", remoteauth.CodeAuthStale)
	e.rem.HubDisable(DisableRequest{By: "u1"})
	e.ctl.Start(e.startReq("s-off", nil))
	e.waitDenied("s-off", codeRemoteDisabled)
	if n := e.openedCount() - before; n != 0 {
		t.Fatalf("mở %d phiên, muốn 0", n)
	}
}

// Hub tự nhận chủ máy mới rồi thử vào: thiết bị của chủ cũ bị xoá, mã TOTP đoán không qua, không gói nào bật lại máy.
func TestAttackHubClaimsOwner(t *testing.T) {
	e := newCtlEnv(t, nil)
	pk := e.addPasskey("dev-1", "u1", "cred-1", 0)
	e.ctl.Recorder.OnWelcome(WelcomeInfo{Features: []string{"terminal"}, Terminal: true,
		Owner: &WelcomeOwner{UserID: "u9"}}, e.link)
	e.ctl.Control(e.passkeyReq(pk, "own-pk", pkOpts{}))
	e.waitDeniedControl("own-pk", remoteauth.CodeDeviceUnknown)
	e.advance(remoteauth.TOTPPeriod * time.Second)
	req := e.totpAt("own-totp", wrongCode(e.codeNow()))
	req.UserID = "u9"
	e.ctl.Control(req)
	e.waitDeniedControl("own-totp", remoteauth.CodeTOTPInvalid)

	e.ctl.Recorder.OnWelcome(WelcomeInfo{Features: []string{"terminal"}, Terminal: true,
		Owner: &WelcomeOwner{UserID: "u9", Shared: true}}, e.link)
	e.ctl.Recorder.OnWelcome(WelcomeInfo{Features: []string{"terminal"}, Terminal: true,
		Owner: &WelcomeOwner{UserID: "u9"}}, e.link)
	if e.rem.State().Enabled {
		t.Fatal("máy đã tắt vì dùng chung thì welcome sau không được bật lại")
	}
	e.noGrant("own-pk", "own-totp")
}
