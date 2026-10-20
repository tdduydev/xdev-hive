package remoteauth

import (
	"crypto/ecdh"
	"crypto/rand"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func ephPub(t *testing.T) string {
	t.Helper()
	k, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return b64url.EncodeToString(k.PublicKey().Bytes())
}

func nonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return b64url.EncodeToString(b)
}

func totpRequest(t *testing.T, now time.Time, userID, c string) Request {
	return Request{
		MachineID: "may-cua-an",
		Action:    "control",
		Params:    ControlParams(userID, "totp", "5b0f8c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e", "conn-0001aa"),
		Auth:      Auth{Kind: KindTOTP, Code: c, EphPub: ephPub(t), TS: now.Unix(), Nonce: nonce()},
	}
}

func boolPtr(b bool) *bool { return &b }

func TestVerifyTOTPPolicy(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	httpHub := Policy{HubURL: "http://192.0.2.10:3000", OwnerUserID: "user-an"}
	cases := []struct {
		name string
		pol  Policy
		user string
		want string
	}{
		{"hub HTTP, chủ máy", httpHub, "user-an", ""},
		{"hub cũ không gửi chính sách", Policy{HubURL: "http://hub.local", OwnerUserID: "user-an"}, "user-an", ""},
		{"tổ chức tắt", Policy{HubURL: httpHub.HubURL, OwnerUserID: "user-an", TOTPFallback: boolPtr(false)}, "user-an", CodeTOTPNotAllowed},
		{"hub HTTPS", Policy{HubURL: "https://hive.example.com", OwnerUserID: "user-an", TOTPFallback: boolPtr(true)}, "user-an", CodeTOTPNotAllowed},
		{"hub HTTPS, chủ máy cho riêng", Policy{HubURL: "https://hive.example.com", OwnerUserID: "user-an", TOTPOnHTTPS: true}, "user-an", ""},
		{"người khác chủ máy", httpHub, "user-binh", CodeDeviceUserMismatch},
		{"chưa biết chủ máy", Policy{HubURL: httpHub.HubURL}, "user-an", CodeDeviceUserMismatch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := &Verifier{Now: func() time.Time { return now }, TOTP: enabledStore(t, now)}
			res, err := v.VerifyAuth(totpRequest(t, now, c.user, code(now)), c.pol)
			if got := Code(err); got != c.want {
				t.Fatalf("mã = %q (%v), cần %q", got, err, c.want)
			}
			if c.want == "" && (res.Kind != KindTOTP || res.KeyInfo != TOTPKeyInfoPrefix+code(now) || len(res.Challenge) != 32) {
				t.Fatalf("kết quả = %+v", res)
			}
		})
	}
}

// Yêu cầu bị chặn vì chính sách không được làm tăng bộ đếm sai, nếu không ai có phiên web cũng làm khoá được máy dù
// tổ chức đã tắt TOTP.
func TestVerifyTOTPPolicyDoesNotCountFailures(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	store := enabledStore(t, now)
	v := &Verifier{Now: func() time.Time { return now }, TOTP: store}
	off := Policy{HubURL: "http://hub.local", OwnerUserID: "user-an", TOTPFallback: boolPtr(false)}
	for range TOTPMaxFailures + 1 {
		_, _ = v.VerifyAuth(totpRequest(t, now, "user-an", "000000"), off)
	}
	if st, _ := store.Status(now); st.Locked {
		t.Fatal("yêu cầu bị chính sách chặn đã làm khoá máy")
	}
}

func TestVerifyTOTPLockedAndReplay(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	v := &Verifier{Now: func() time.Time { return now }, TOTP: enabledStore(t, now)}
	pol := Policy{HubURL: "http://hub.local", OwnerUserID: "user-an"}
	if _, err := v.VerifyAuth(totpRequest(t, now, "user-an", code(now)), pol); err != nil {
		t.Fatal(err)
	}
	// Cùng mã, nonce mới: TOTP_REPLAY (mỗi thao tác một mã mới).
	if _, err := v.VerifyAuth(totpRequest(t, now, "user-an", code(now)), pol); Code(err) != CodeTOTPReplay {
		t.Fatalf("mã dùng lại = %v", err)
	}
	// Không có mã (gửi yêu cầu TOTP rỗng) tính là sai.
	for range TOTPMaxFailures {
		if _, err := v.VerifyAuth(totpRequest(t, now, "user-an", ""), pol); Code(err) != CodeTOTPInvalid {
			t.Fatalf("không mã = %v", err)
		}
	}
	next := now.Add(TOTPPeriod * time.Second)
	if _, err := v.VerifyAuth(totpRequest(t, now, "user-an", code(next)), pol); Code(err) != CodeTOTPLocked {
		t.Fatalf("đang khoá = %v", err)
	}
}

func TestVerifyRequestChecks(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	v := &Verifier{Now: func() time.Time { return now }, TOTP: enabledStore(t, now)}
	pol := Policy{HubURL: "http://hub.local", OwnerUserID: "user-an"}

	r := totpRequest(t, now, "user-an", code(now))
	r.Auth.EphPub = b64url.EncodeToString(make([]byte, 65))
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthInvalid {
		t.Fatalf("ephPub không phải điểm P-256 = %v", err)
	}
	r = totpRequest(t, now, "user-an", code(now))
	r.Action = "enable"
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthInvalid {
		t.Fatalf("action lạ = %v", err)
	}
	r = totpRequest(t, now, "user-an", code(now))
	r.Auth.Kind = "password"
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthInvalid {
		t.Fatalf("kind lạ = %v", err)
	}
	r = totpRequest(t, now, "user-an", code(now))
	r.Auth.Kind = KindPasskey
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthInvalid {
		t.Fatalf("passkey thiếu assertion = %v", err)
	}
	r = totpRequest(t, now, "user-an", code(now))
	r.Auth.TS = now.Add(-3 * time.Minute).Unix()
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthStale {
		t.Fatalf("ts cũ = %v", err)
	}
	// Yêu cầu hỏng không đụng bộ đếm, mã vẫn dùng được.
	r = totpRequest(t, now, "user-an", code(now))
	if _, err := v.VerifyAuth(r, pol); err != nil {
		t.Fatal(err)
	}
	if _, err := v.VerifyAuth(r, pol); Code(err) != CodeAuthReplay {
		t.Fatalf("gửi lại nguyên yêu cầu = %v", err)
	}
}

func TestHubOrigin(t *testing.T) {
	for in, want := range map[string][2]string{
		"https://Hive.Example.com/":     {"https://hive.example.com", "hive.example.com"},
		"https://hive.example.com:443":  {"https://hive.example.com", "hive.example.com"},
		"https://hive.example.com:8443": {"https://hive.example.com:8443", "hive.example.com"},
		"http://192.0.2.10:3000":        {"http://192.0.2.10:3000", "192.0.2.10"},
		"http://hub.local:80/x":         {"http://hub.local", "hub.local"},
	} {
		o, rp, err := HubOrigin(in)
		if err != nil || o != want[0] || rp != want[1] {
			t.Errorf("HubOrigin(%q) = %q, %q, %v", in, o, rp, err)
		}
	}
	for _, bad := range []string{"", "ftp://x", "hub.local"} {
		if _, _, err := HubOrigin(bad); err == nil {
			t.Errorf("HubOrigin(%q) cần lỗi", bad)
		}
	}
}

func TestStoreAtomicAndPrivate(t *testing.T) {
	dir := t.TempDir()
	s := NewStore(dir)
	c, err := s.Load()
	if err != nil || c.Enabled || c.Idle() != 15*time.Minute || c.Detached() != 2*time.Hour || c.Max() != 12*time.Hour {
		t.Fatalf("mặc định = %+v, %v", c, err)
	}
	now := time.Unix(1_792_000_000, 0).UTC()
	if _, err := s.Update(func(c *Config) error {
		c.Enabled = true
		c.OwnerUserID = "user-an"
		c.Devices = append(c.Devices, Device{ID: "dev-1aaaaa", UserID: "user-an", CredentialID: "cred", SPKI: "x", CreatedAt: now})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkUsed("dev-1aaaaa", 9, now); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkUsed("dev-khac00", 1, now); Code(err) != CodeDeviceUnknown {
		t.Fatalf("thiết bị lạ = %v", err)
	}
	d, ok, err := NewStore(dir).DeviceByCredential("cred")
	if err != nil || !ok || d.SignCount != 9 || !d.LastUsedAt.Equal(now) || d.Synced() {
		t.Fatalf("đọc lại = %+v, %v, %v", d, ok, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatalf("còn file tạm: %v", entries)
	}
	if runtime.GOOS != "windows" {
		fi, _ := os.Stat(filepath.Join(dir, "remote.json"))
		if fi.Mode().Perm() != 0o600 {
			t.Fatalf("quyền remote.json = %v", fi.Mode().Perm())
		}
	}
	if err := os.WriteFile(s.Path, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Load(); err == nil {
		t.Fatal("remote.json hỏng mà không báo lỗi")
	}
}

func TestPairingBegin(t *testing.T) {
	p := &Pairings{}
	id, secret, exp, err := p.Begin()
	if err != nil || len(secret) != 16 || len(id) < 10 || time.Until(exp) > PairTTL {
		t.Fatalf("Begin = %q %x %v %v", id, secret, exp, err)
	}
	if r := p.Verify(id, "u", "c", "s", "khong-phai-tag"); r != PairBadTag {
		t.Fatalf("tag rác = %q", r)
	}
}
