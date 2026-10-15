package terminal

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

var b64 = base64.RawURLEncoding

// phone giả điện thoại: tạo passkey ES256 và ký tag bằng bí mật đọc từ fragment của QR.
func phonePair(t *testing.T, info PairInfo, userID, credID string) PairRequest {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	spki := b64.EncodeToString(der)
	u, err := url.Parse(info.URL)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := b64.DecodeString(strings.TrimPrefix(u.Fragment, "s="))
	if err != nil {
		t.Fatal(err)
	}
	payload, err := remoteauth.PairTagPayload(info.PairID, userID, credID, spki)
	if err != nil {
		t.Fatal(err)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	return PairRequest{PairID: info.PairID, UserID: userID, Label: "iPhone của Lan", CredentialID: credID, SPKI: spki,
		Tag: b64.EncodeToString(mac.Sum(nil))}
}

func readyToPair(t *testing.T) (*Remote, PairInfo) {
	t.Helper()
	r := newRemote(t)
	r.ConfirmWait = 2 * time.Second
	r.OnWelcome(WelcomeInfo{Terminal: true, Owner: &WelcomeOwner{UserID: "u1"}})
	if _, err := call(t, r, map[string]any{"op": "remote.pair.begin"}); failCode(t, err) != localipc.CodeBadRequest {
		t.Fatalf("ghép khi chưa bật phải bị từ chối: %v", err)
	}
	mustCall(t, r, map[string]any{"op": "remote.enable"})
	info := mustCall(t, r, map[string]any{"op": "remote.pair.begin"}).Pair
	u, err := url.Parse(info.URL)
	if err != nil || u.Host != "hive.example.vn" || u.Path != "/remote/pair" || u.Query().Get("m") != "mac-lan" ||
		u.Query().Get("p") != info.PairID || !strings.HasPrefix(u.Fragment, "s=") {
		t.Fatalf("QR = %q", info.URL)
	}
	return r, info
}

// watchConn mở watch và trả hàm đọc sự kiện kế tiếp.
func watchConn(t *testing.T, r *Remote) (*localipc.Conn, func() watchEvent) {
	t.Helper()
	c := pipe(t, r)
	var first statusReply
	if err := c.Call(map[string]any{"op": "watch"}, &first); err != nil {
		t.Fatal(err)
	}
	next := func() watchEvent {
		t.Helper()
		var e watchEvent
		_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
		if err := c.ReadJSON(&e); err != nil {
			t.Fatalf("đọc sự kiện: %v", err)
		}
		return e
	}
	return c, next
}

func nextOf(t *testing.T, next func() watchEvent, kind string) watchEvent {
	t.Helper()
	for range 10 {
		if e := next(); e.Event == kind {
			return e
		}
	}
	t.Fatalf("không thấy sự kiện %s", kind)
	return watchEvent{}
}

func TestPairAllowedAtMachine(t *testing.T) {
	r, info := readyToPair(t)
	c, next := watchConn(t, r)
	req := phonePair(t, info, "u1", "cred-1")
	got := make(chan PairResult, 1)
	go func() { got <- r.HandlePair(req) }()

	ask := nextOf(t, next, "pair_request")
	if ask.PairID != info.PairID || ask.Label != "iPhone của Lan" || ask.UserID != "u1" {
		t.Fatalf("hỏi = %+v", ask)
	}
	// Trả lời trên chính kết nối watch, như app desktop.
	if err := c.WriteJSON(map[string]any{"op": "remote.pair.decide", "pairId": info.PairID, "allow": true}); err != nil {
		t.Fatal(err)
	}
	res := <-got
	if !res.OK || !strings.HasPrefix(res.DeviceID, "dev-") || res.Reason != "" {
		t.Fatalf("kết quả = %+v", res)
	}
	st := r.State()
	if len(st.Devices) != 1 || st.Devices[0].ID != res.DeviceID || st.Devices[0].UserID != "u1" || !st.Devices[0].Synced {
		t.Fatalf("term_state.devices = %+v", st.Devices)
	}
	cfg, _ := r.Store.Load()
	if cfg.OwnerUserID != "u1" || cfg.Devices[0].SPKI != req.SPKI || cfg.Devices[0].CredentialID != "cred-1" {
		t.Fatalf("remote.json = %+v", cfg)
	}
	// Mã ghép chỉ dùng một lần.
	if again := r.HandlePair(req); again.OK || again.Reason != "expired" {
		t.Fatalf("dùng lại mã ghép = %+v", again)
	}
	if got := auditActions(t, r); got[len(got)-2] != "pair/machine" || got[len(got)-1] != "pair_denied/hub:u1" {
		t.Fatalf("audit = %v", got)
	}

	// Gỡ từ web (term_device_revoke) và tại máy.
	r.HubDeviceRevoke(DeviceRevokeRequest{DeviceID: res.DeviceID, By: "u1"})
	if len(r.State().Devices) != 0 {
		t.Fatal("term_device_revoke phải gỡ thiết bị")
	}
	if _, err := call(t, r, map[string]any{"op": "remote.devices.remove", "id": res.DeviceID}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("gỡ lần hai: %v", err)
	}
}

func TestPairRejected(t *testing.T) {
	for _, tt := range []struct {
		name   string
		reason string
		setup  func(t *testing.T, r *Remote, info PairInfo) PairRequest
	}{
		{"tag sai", "bad_tag", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			req := phonePair(t, info, "u1", "cred-1")
			req.CredentialID = "cred-khac"
			return req
		}},
		{"hết hạn", "expired", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			r.Pairings.Now = func() time.Time { return time.Now().Add(11 * time.Minute) }
			return phonePair(t, info, "u1", "cred-1")
		}},
		{"mã lạ", "expired", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			req := phonePair(t, info, "u1", "cred-1")
			req.PairID = "pair-khongco"
			return req
		}},
		{"người khác", "user_mismatch", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			return phonePair(t, info, "u2", "cred-1")
		}},
		{"đang tắt", "disabled", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			r.HubDisable(DisableRequest{By: "u1"})
			return phonePair(t, info, "u1", "cred-1")
		}},
		{"hết giờ chờ máy", "timeout", func(t *testing.T, r *Remote, info PairInfo) PairRequest {
			r.ConfirmWait = 30 * time.Millisecond
			return phonePair(t, info, "u1", "cred-1")
		}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r, info := readyToPair(t)
			res := r.HandlePair(tt.setup(t, r, info))
			if res.OK || res.Reason != tt.reason || res.PairID == "" {
				t.Fatalf("kết quả = %+v", res)
			}
			if len(r.State().Devices) != 0 {
				t.Fatal("không được lưu thiết bị")
			}
		})
	}
}

func TestPairDeniedAtMachine(t *testing.T) {
	r, info := readyToPair(t)
	got := make(chan PairResult, 1)
	go func() { got <- r.HandlePair(phonePair(t, info, "u1", "cred-1")) }()
	// Watch mở sau khi yêu cầu tới vẫn thấy yêu cầu đang chờ.
	waitRec(t, "yêu cầu chờ", func() bool {
		r.mu.Lock()
		defer r.mu.Unlock()
		return len(r.decisions) == 1
	})
	_, next := watchConn(t, r)
	if e := nextOf(t, next, "pair_request"); e.PairID != info.PairID {
		t.Fatalf("hỏi = %+v", e)
	}
	mustCall(t, r, map[string]any{"op": "remote.pair.decide", "pairId": info.PairID, "allow": false})
	if res := <-got; res.OK || res.Reason != "denied" {
		t.Fatalf("kết quả = %+v", res)
	}
	if e := nextOf(t, next, "pair_done"); e.OK || e.Reason != "denied" {
		t.Fatalf("pair_done = %+v", e)
	}
	if _, err := call(t, r, map[string]any{"op": "remote.pair.decide", "pairId": info.PairID, "allow": true}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("trả lời muộn: %v", err)
	}
}

// Máy đổi chủ trên hub: thiết bị của chủ cũ bị xoá để họ không còn vào được máy.
func TestOwnerChangeRemovesDevices(t *testing.T) {
	r, info := readyToPair(t)
	go func() {
		waitRec(t, "yêu cầu chờ", func() bool {
			r.mu.Lock()
			defer r.mu.Unlock()
			return len(r.decisions) == 1
		})
		r.decide(info.PairID, eventPairRequest, true)
	}()
	if res := r.HandlePair(phonePair(t, info, "u1", "cred-1")); !res.OK {
		t.Fatalf("ghép = %+v", res)
	}
	r.OnWelcome(WelcomeInfo{Terminal: true, Owner: &WelcomeOwner{UserID: "u1"}})
	if len(r.State().Devices) != 1 {
		t.Fatal("cùng chủ thì giữ thiết bị")
	}
	r.OnWelcome(WelcomeInfo{Terminal: true, Owner: &WelcomeOwner{UserID: "u9"}})
	cfg, _ := r.Store.Load()
	if len(cfg.Devices) != 0 || cfg.OwnerUserID != "u9" {
		t.Fatalf("sau đổi chủ = %+v", cfg)
	}
	if got := auditActions(t, r); got[len(got)-1] != "owner_changed/hub" {
		t.Fatalf("audit = %v", got)
	}
}

// Recorder chuyển term_pair cho Remote và gửi kết quả qua kết nối hiện tại.
func TestRecorderForwardsPair(t *testing.T) {
	r, info := readyToPair(t)
	r.ConfirmWait = 30 * time.Millisecond
	rec := &Recorder{Dir: t.TempDir(), Remote: r}
	link := newFakeLink()
	rec.OnWelcome(personal(), link)
	rec.Pair(phonePair(t, info, "u1", "cred-1"))
	waitRec(t, "term_pair_result", func() bool {
		n := 0
		link.snapshot(func(f *fakeLink) { n = len(f.pairs) })
		return n == 1
	})
	link.snapshot(func(f *fakeLink) {
		if p := f.pairs[0]; p.PairID != info.PairID || p.OK || p.Reason != "timeout" {
			t.Fatalf("kết quả = %+v", p)
		}
	})
}
