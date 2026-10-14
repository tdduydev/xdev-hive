package terminal

import (
	"encoding/base32"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/remoteauth"
)

type totpReply struct {
	TOTP   TOTPEnroll   `json:"totp"`
	Status RemoteStatus `json:"status"`
}

// codeFor tính mã như app Authenticator từ URI otpauth:// đã quét.
func codeFor(t *testing.T, uri string, at time.Time) string {
	t.Helper()
	u, err := url.Parse(uri)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := base32.StdEncoding.WithPadding(base32.NoPadding).DecodeString(u.Query().Get("secret"))
	if err != nil {
		t.Fatal(err)
	}
	return remoteauth.TOTPCode(secret, at.Unix()/remoteauth.TOTPPeriod)
}

func totpCall(t *testing.T, r *Remote, req map[string]any) (totpReply, error) {
	t.Helper()
	var out totpReply
	err := pipe(t, r).Call(req, &out)
	return out, err
}

func wrongCode(right string) string {
	if right == "000000" {
		return "111111"
	}
	return "000000"
}

func TestTOTPEnrollConfirm(t *testing.T) {
	r := newRemote(t)
	now := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return now }
	changes := 0
	r.OnChange(func() { changes++ })

	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": "123456"}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("xác nhận khi chưa begin: %v", err)
	}
	begin, err := totpCall(t, r, map[string]any{"op": "remote.totp.begin"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(begin.TOTP.URI, "otpauth://totp/Hive:mac-lan?") || len(begin.TOTP.Secret) != 32 ||
		!begin.TOTP.ExpiresAt.Equal(now.Add(10*time.Minute)) || begin.TOTP.HubURL != "https://hive.example.vn" {
		t.Fatalf("begin = %+v", begin.TOTP)
	}
	if r.State().TOTP.Enabled {
		t.Fatal("chưa xác nhận thì chưa bật")
	}
	right := codeFor(t, begin.TOTP.URI, now)
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": wrongCode(right)}); failCode(t, err) != localipc.CodeBadRequest {
		t.Fatalf("mã sai: %v", err)
	}
	out, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": right})
	if err != nil || !out.Status.TOTP.Enabled || !r.State().TOTP.Enabled || changes != 1 {
		t.Fatalf("xác nhận = %+v %v (đổi %d)", out.Status.TOTP, err, changes)
	}
	// Mã đã dùng để xác nhận không mở được phiên.
	if err := r.TOTP.Verify(right, now); remoteauth.Code(err) != remoteauth.CodeTOTPReplay {
		t.Fatalf("dùng lại mã xác nhận: %v", err)
	}
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": right}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("khoá chờ phải bị bỏ sau khi lưu: %v", err)
	}

	// Đổi khoá: khoá cũ hết hiệu lực ngay khi khoá mới được xác nhận.
	later := now.Add(5 * time.Minute)
	r.Now = func() time.Time { return later }
	again, _ := totpCall(t, r, map[string]any{"op": "remote.totp.begin"})
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": codeFor(t, again.TOTP.URI, later)}); err != nil {
		t.Fatal(err)
	}
	if err := r.TOTP.Verify(codeFor(t, begin.TOTP.URI, later.Add(time.Minute)), later.Add(time.Minute)); remoteauth.Code(err) != remoteauth.CodeTOTPInvalid {
		t.Fatalf("khoá cũ phải hết hiệu lực: %v", err)
	}

	if out, err := totpCall(t, r, map[string]any{"op": "remote.totp.disable"}); err != nil || out.Status.TOTP.Enabled {
		t.Fatalf("tắt = %+v %v", out.Status.TOTP, err)
	}
	if got := strings.Join(auditActions(t, r), ","); got != "totp_enroll/machine,totp_enroll/machine,totp_disable/machine" {
		t.Fatalf("audit = %s", got)
	}
	data, _ := os.ReadFile(r.Audit.Path)
	if strings.Contains(string(data), begin.TOTP.Secret) || strings.Contains(string(data), right) {
		t.Fatal("audit không được có khoá hay mã")
	}
}

func TestTOTPEnrollExpiresAndLimitsTries(t *testing.T) {
	r := newRemote(t)
	now := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	r.Now = func() time.Time { return now }
	begin, _ := totpCall(t, r, map[string]any{"op": "remote.totp.begin"})
	r.Now = func() time.Time { return now.Add(11 * time.Minute) }
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": codeFor(t, begin.TOTP.URI, now.Add(11*time.Minute))}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("quá 10 phút: %v", err)
	}

	r.Now = func() time.Time { return now }
	begin, _ = totpCall(t, r, map[string]any{"op": "remote.totp.begin"})
	bad := wrongCode(codeFor(t, begin.TOTP.URI, now))
	for i := range totpEnrollTries {
		_, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": bad})
		want := localipc.CodeBadRequest
		if i == totpEnrollTries-1 {
			want = localipc.CodeDenied
		}
		if failCode(t, err) != want {
			t.Fatalf("lần %d: %v", i+1, err)
		}
	}
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": codeFor(t, begin.TOTP.URI, now)}); failCode(t, err) != localipc.CodeNotFound {
		t.Fatalf("sai đủ lần thì phải bắt đầu lại: %v", err)
	}
	if r.State().TOTP.Enabled {
		t.Fatal("không được bật")
	}
}

func TestTOTPUnlockAndShared(t *testing.T) {
	r := newRemote(t)
	now := time.Now()
	begin, _ := totpCall(t, r, map[string]any{"op": "remote.totp.begin"})
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.confirm", "code": codeFor(t, begin.TOTP.URI, now)}); err != nil {
		t.Fatal(err)
	}
	bad := wrongCode(codeFor(t, begin.TOTP.URI, now))
	for range remoteauth.TOTPMaxFailures {
		_ = r.TOTP.Verify(bad, now)
	}
	if st := r.State(); !st.TOTP.Locked || st.TOTP.LockedUntil == "" {
		t.Fatalf("phải khoá sau %d lần sai: %+v", remoteauth.TOTPMaxFailures, st.TOTP)
	}
	if out, err := totpCall(t, r, map[string]any{"op": "remote.totp.unlock"}); err != nil || out.Status.TOTP.Locked {
		t.Fatalf("mở khoá = %+v %v", out.Status.TOTP, err)
	}

	r.OnWelcome(WelcomeInfo{Terminal: true, Owner: &WelcomeOwner{UserID: "u1", Shared: true}})
	if _, err := totpCall(t, r, map[string]any{"op": "remote.totp.begin"}); failCode(t, err) != localipc.CodeDenied {
		t.Fatalf("máy dùng chung: %v", err)
	}
}
