package remoteauth

import (
	"bytes"
	"crypto/ecdh"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// Vector dùng chung với test TypeScript (packages/contracts/src/terminal-auth.test.ts), sinh bằng WebCrypto như trình
// duyệt thật: test này kiểm worker cho cùng kết quả trên đúng byte trình duyệt gửi.
const fixturePath = "../../../packages/contracts/fixtures/terminal-auth.json"

type fixture struct {
	HubOrigin string `json:"hubOrigin"`
	RPID      string `json:"rpId"`
	MachineID string `json:"machineId"`
	Now       int64  `json:"now"`
	Device    struct {
		DeviceID     string `json:"deviceId"`
		UserID       string `json:"userId"`
		CredentialID string `json:"credentialId"`
		SPKI         string `json:"spki"`
		SignCount    uint32 `json:"signCount"`
	} `json:"device"`
	Canonical []struct {
		Input    any    `json:"input"`
		Expected string `json:"expected"`
	} `json:"canonical"`
	Assertions []struct {
		Name     string `json:"name"`
		Expect   string `json:"expect"`
		ReplayOf string `json:"replayOf"`
		Request  struct {
			MachineID string         `json:"machineId"`
			Action    string         `json:"action"`
			Params    map[string]any `json:"params"`
			EphPub    string         `json:"ephPub"`
			TS        int64          `json:"ts"`
			Nonce     string         `json:"nonce"`
		} `json:"request"`
		Canonical string    `json:"canonical"`
		Challenge string    `json:"challenge"`
		Assertion Assertion `json:"assertion"`
	} `json:"assertions"`
	Pairing struct {
		Secret       string `json:"secret"`
		PairID       string `json:"pairId"`
		UserID       string `json:"userId"`
		CredentialID string `json:"credentialId"`
		SPKI         string `json:"spki"`
		Tag          string `json:"tag"`
		WrongUserTag string `json:"wrongUserTag"`
	} `json:"pairing"`
	ECDH struct {
		Challenge     string `json:"challenge"`
		EphPub        string `json:"ephPub"`
		WorkerPrivate string `json:"workerPrivate"`
		WorkerEphPub  string `json:"workerEphPub"`
		TOTPCode      string `json:"totpCode"`
		Keys          []struct {
			Kind string `json:"kind"`
			Info string `json:"info"`
			Key  string `json:"key"`
			Macs []struct {
				Input struct {
					SessionID string `json:"sessionId"`
					ConnID    string `json:"connId"`
					Seq       int64  `json:"seq"`
					Kind      string `json:"kind"`
					Data      string `json:"data"`
					Cols      int    `json:"cols"`
					Rows      int    `json:"rows"`
				} `json:"input"`
				Payload string `json:"payload"`
				MAC     string `json:"mac"`
			} `json:"macs"`
		} `json:"keys"`
	} `json:"ecdh"`
	TOTP struct {
		SecretBase32 string `json:"secretBase32"`
		Vectors      []struct {
			T    int64  `json:"t"`
			Code string `json:"code"`
		} `json:"vectors"`
	} `json:"totp"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	// UseNumber để số trong params giữ dạng nguyên như JS in, không qua float64.
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var f fixture
	if err := dec.Decode(&f); err != nil {
		t.Fatal(err)
	}
	return f
}

// memDevices là Devices trong bộ nhớ cho test.
type memDevices struct{ devs []Device }

func (m *memDevices) DeviceByCredential(id string) (Device, bool, error) {
	for _, d := range m.devs {
		if d.CredentialID == id {
			return d, true, nil
		}
	}
	return Device{}, false, nil
}

func (m *memDevices) MarkUsed(id string, n uint32, at time.Time) error {
	for i := range m.devs {
		if m.devs[i].ID == id {
			m.devs[i].SignCount = n
			m.devs[i].LastUsedAt = at
			return nil
		}
	}
	return deny(CodeDeviceUnknown)
}

func TestFixtureCanonical(t *testing.T) {
	for _, c := range loadFixture(t).Canonical {
		got, err := Canonical(c.Input)
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != c.Expected {
			t.Errorf("Canonical = %s\n  cần %s", got, c.Expected)
		}
	}
}

func TestFixtureAssertions(t *testing.T) {
	f := loadFixture(t)
	byName := map[string]int{}
	for i, a := range f.Assertions {
		byName[a.Name] = i
	}
	verifier := func() *Verifier {
		d := f.Device
		return &Verifier{
			Now: func() time.Time { return time.Unix(f.Now, 0) },
			Devices: &memDevices{devs: []Device{{
				ID: d.DeviceID, UserID: d.UserID, CredentialID: d.CredentialID, SPKI: d.SPKI, SignCount: d.SignCount,
			}}},
		}
	}
	request := func(i int) Request {
		r := f.Assertions[i].Request
		a := f.Assertions[i].Assertion
		return Request{MachineID: r.MachineID, Action: r.Action, Params: r.Params, Auth: Auth{
			Kind: KindPasskey, Assertion: &a, EphPub: r.EphPub, TS: r.TS, Nonce: r.Nonce,
		}}
	}
	pol := Policy{HubURL: f.HubOrigin + "/"}
	for i, c := range f.Assertions {
		t.Run(c.Name, func(t *testing.T) {
			req := request(i)
			canon, _ := Canonical(map[string]any{
				"machineId": req.MachineID, "action": req.Action, "params": req.Params,
				"ephPub": req.Auth.EphPub, "ts": req.Auth.TS, "nonce": req.Auth.Nonce,
			})
			if string(canon) != c.Canonical {
				t.Fatalf("JSON chuẩn hoá khác TS:\n Go %s\n TS %s", canon, c.Canonical)
			}
			ch, err := Challenge(req)
			if err != nil || b64url.EncodeToString(ch) != c.Challenge {
				t.Fatalf("challenge = %x, %v", ch, err)
			}
			v := verifier()
			if c.ReplayOf != "" {
				if _, err := v.VerifyAuth(request(byName[c.ReplayOf]), pol); err != nil {
					t.Fatalf("lần đầu: %v", err)
				}
			}
			res, err := v.VerifyAuth(req, pol)
			if c.Expect == "ok" {
				if err != nil {
					t.Fatalf("cần qua, bị %v", err)
				}
				if res.DeviceID != f.Device.DeviceID || res.KeyInfo != PasskeyKeyInfo {
					t.Fatalf("kết quả = %+v", res)
				}
				return
			}
			if got := Code(err); got != c.Expect {
				t.Fatalf("mã = %q (%v), cần %q", got, err, c.Expect)
			}
		})
	}
}

func TestFixtureSignCountSaved(t *testing.T) {
	f := loadFixture(t)
	devs := &memDevices{devs: []Device{{
		ID: f.Device.DeviceID, UserID: f.Device.UserID, CredentialID: f.Device.CredentialID, SPKI: f.Device.SPKI,
		SignCount: f.Device.SignCount,
	}}}
	v := &Verifier{Now: func() time.Time { return time.Unix(f.Now, 0) }, Devices: devs}
	a := f.Assertions[0]
	if a.Name != "ok_control" {
		t.Fatal("vector đầu phải là ok_control")
	}
	if _, err := v.VerifyAuth(Request{MachineID: a.Request.MachineID, Action: a.Request.Action, Params: a.Request.Params, Auth: Auth{
		Kind: KindPasskey, Assertion: &a.Assertion, EphPub: a.Request.EphPub, TS: a.Request.TS, Nonce: a.Request.Nonce,
	}}, Policy{HubURL: f.HubOrigin}); err != nil {
		t.Fatal(err)
	}
	if devs.devs[0].SignCount != f.Device.SignCount+1 || devs.devs[0].LastUsedAt.IsZero() {
		t.Fatalf("thiết bị sau khi dùng = %+v", devs.devs[0])
	}
}

func TestFixturePairing(t *testing.T) {
	p := loadFixture(t).Pairing
	secret, _ := b64url.DecodeString(p.Secret)
	now := time.Unix(1_792_000_000, 0)
	pairs := &Pairings{Now: func() time.Time { return now }}

	pairs.put(p.PairID, secret, now.Add(PairTTL))
	if r := pairs.Verify(p.PairID, p.UserID, p.CredentialID, p.SPKI, p.Tag); r != "" {
		t.Fatalf("tag đúng bị từ chối: %s", r)
	}
	if r := pairs.Verify(p.PairID, p.UserID, p.CredentialID, p.SPKI, p.Tag); r != PairExpired {
		t.Fatalf("dùng lại mã ghép = %q", r)
	}

	pairs.put(p.PairID, secret, now.Add(PairTTL))
	if r := pairs.Verify(p.PairID, "user-binh", p.CredentialID, p.SPKI, p.Tag); r != PairBadTag {
		t.Fatalf("hub đổi userId = %q", r)
	}
	// Một lần thử sai là mất mã ghép, kể cả tag sau đó đúng.
	if r := pairs.Verify(p.PairID, p.UserID, p.CredentialID, p.SPKI, p.Tag); r != PairExpired {
		t.Fatalf("thử lại sau tag sai = %q", r)
	}

	pairs.put(p.PairID, secret, now.Add(PairTTL))
	if r := pairs.Verify(p.PairID, "user-binh", p.CredentialID, p.SPKI, p.WrongUserTag); r != "" {
		t.Fatalf("tag của user khác ký đúng cho user đó phải qua bước tag (hub kiểm chủ máy riêng): %s", r)
	}

	pairs.put(p.PairID, secret, now.Add(-time.Second))
	if r := pairs.Verify(p.PairID, p.UserID, p.CredentialID, p.SPKI, p.Tag); r != PairExpired {
		t.Fatalf("mã hết hạn = %q", r)
	}
}

func TestFixtureInputKeys(t *testing.T) {
	e := loadFixture(t).ECDH
	d, _ := b64url.DecodeString(e.WorkerPrivate)
	priv, err := ecdh.P256().NewPrivateKey(d)
	if err != nil {
		t.Fatal(err)
	}
	if got := b64url.EncodeToString(priv.PublicKey().Bytes()); got != e.WorkerEphPub {
		t.Fatalf("workerEphPub = %s", got)
	}
	challenge, _ := b64url.DecodeString(e.Challenge)
	for _, k := range e.Keys {
		info := KeyInfo(k.Kind, e.TOTPCode)
		if info != k.Info {
			t.Fatalf("info = %q, cần %q", info, k.Info)
		}
		key, err := DeriveInputKey(priv, e.EphPub, challenge, info)
		if err != nil {
			t.Fatal(err)
		}
		if b64url.EncodeToString(key) != k.Key {
			t.Fatalf("%s: khoá khác WebCrypto", k.Kind)
		}
		v := NewInputVerifier(key)
		for _, m := range k.Macs {
			in := m.Input
			var payload []byte
			if in.Kind == "in" {
				data, _ := base64.StdEncoding.DecodeString(in.Data)
				payload, err = InputPayload(in.SessionID, in.ConnID, in.Seq, data)
			} else {
				payload, err = ResizePayload(in.SessionID, in.ConnID, in.Seq, in.Cols, in.Rows)
			}
			if err != nil || string(payload) != m.Payload {
				t.Fatalf("payload = %s, cần %s (%v)", payload, m.Payload, err)
			}
			if err := v.Verify(in.Seq, payload, m.MAC); err != nil {
				t.Fatalf("%s seq %d: %v", k.Kind, in.Seq, err)
			}
		}
		// Gói cuối gửi lại: seq không tăng.
		last := k.Macs[len(k.Macs)-1]
		if err := v.Verify(last.Input.Seq, []byte(last.Payload), last.MAC); Code(err) != CodeInputRejected {
			t.Fatalf("phát lại gói nhập = %v", err)
		}
	}
}

func TestFixtureTOTPVectors(t *testing.T) {
	f := loadFixture(t).TOTP
	secret, err := totpBase32.DecodeString(f.SecretBase32)
	if err != nil {
		t.Fatal(err)
	}
	if string(secret) != "12345678901234567890" {
		t.Fatalf("khoá RFC = %q", secret)
	}
	for _, v := range f.Vectors {
		if got := TOTPCode(secret, v.T/TOTPPeriod); got != v.Code {
			t.Errorf("t=%d: %s, cần %s", v.T, got, v.Code)
		}
	}
}
