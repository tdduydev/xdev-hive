package remoteauth

import (
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

var rfcSecret = []byte("12345678901234567890")

// enabledStore bật TOTP bằng mã của bước trước `at`, để mã của bước `at` còn mới.
func enabledStore(t *testing.T, at time.Time) *TOTPStore {
	t.Helper()
	s := NewTOTPStore(t.TempDir())
	prev := at.Add(-TOTPPeriod * time.Second)
	if err := s.Enable(rfcSecret, TOTPCode(rfcSecret, prev.Unix()/TOTPPeriod), prev); err != nil {
		t.Fatal(err)
	}
	return s
}

func code(at time.Time) string { return TOTPCode(rfcSecret, at.Unix()/TOTPPeriod) }

func TestTOTPEnableNeedsCorrectCode(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := NewTOTPStore(t.TempDir())
	if err := s.Enable(rfcSecret, "000000", now); Code(err) != CodeTOTPInvalid {
		t.Fatalf("bật bằng mã sai = %v", err)
	}
	if _, err := os.Stat(s.Path); !os.IsNotExist(err) {
		t.Fatal("mã sai mà khoá đã được lưu")
	}
	if err := s.Verify(code(now), now); Code(err) != CodeTOTPDisabled {
		t.Fatalf("chưa bật = %v", err)
	}
	if err := s.Enable(rfcSecret, code(now), now); err != nil {
		t.Fatal(err)
	}
	// Mã vừa dùng để xác nhận không mở được phiên.
	if err := s.Verify(code(now), now); Code(err) != CodeTOTPReplay {
		t.Fatalf("mã xác nhận dùng lại = %v", err)
	}
	if runtime.GOOS != "windows" {
		if fi, _ := os.Stat(s.Path); fi.Mode().Perm() != 0o600 {
			t.Fatalf("quyền totp.json = %v", fi.Mode().Perm())
		}
	}
}

func TestTOTPSkewAndReplay(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := enabledStore(t, now.Add(-time.Minute))
	// Mã của bước trước vẫn nhận (lệch đồng hồ điện thoại).
	if err := s.Verify(code(now.Add(-TOTPPeriod*time.Second)), now); err != nil {
		t.Fatalf("lệch -1 bước: %v", err)
	}
	if err := s.Verify(code(now.Add(-TOTPPeriod*time.Second)), now); Code(err) != CodeTOTPReplay {
		t.Fatalf("dùng lại = %v", err)
	}
	if err := s.Verify(code(now.Add(2*TOTPPeriod*time.Second)), now); Code(err) != CodeTOTPInvalid {
		t.Fatalf("lệch +2 bước = %v", err)
	}
	if err := s.Verify(code(now.Add(TOTPPeriod*time.Second)), now); err != nil {
		t.Fatalf("lệch +1 bước: %v", err)
	}
	// Mã của bước hiện tại cũ hơn bước vừa nhận: phát lại.
	if err := s.Verify(code(now), now); Code(err) != CodeTOTPReplay {
		t.Fatalf("mã cũ hơn mã đã nhận = %v", err)
	}
}

func TestTOTPRestartKeepsState(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := enabledStore(t, now)
	if err := s.Verify(code(now), now); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		_ = s.Verify("000000", now)
	}
	// Worker khởi động lại: store mới cùng file.
	again := &TOTPStore{Path: s.Path}
	if err := again.Verify(code(now), now); Code(err) != CodeTOTPReplay {
		t.Fatalf("sau khởi động lại mã cũ = %v", err)
	}
	for range 2 {
		_ = again.Verify("000000", now)
	}
	st, _ := again.Status(now)
	if !st.Locked {
		t.Fatal("bộ đếm sai bị đặt lại khi khởi động lại")
	}
}

func TestTOTPLockDoublesAndUnlock(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := enabledStore(t, now)
	fail := func(at time.Time, n int) {
		for range n {
			if err := s.Verify("000000", at); Code(err) != CodeTOTPInvalid {
				t.Fatalf("mã sai = %v", err)
			}
		}
	}
	fail(now, TOTPMaxFailures)
	// Lần thứ 6, mã đúng vẫn bị khoá (SC-012).
	if err := s.Verify(code(now), now); Code(err) != CodeTOTPLocked {
		t.Fatalf("lần 6 = %v", err)
	}
	st, _ := s.Status(now)
	if got := st.LockedUntil.Sub(now); got != 5*time.Minute {
		t.Fatalf("khoá lần đầu = %v", got)
	}

	later := now.Add(6 * time.Minute)
	fail(later, TOTPMaxFailures)
	st, _ = s.Status(later)
	if got := st.LockedUntil.Sub(later); got != 10*time.Minute {
		t.Fatalf("khoá lần hai = %v, cần gấp đôi", got)
	}

	// Khoá nhiều lần không vượt 1 giờ.
	at := later
	for range 6 {
		at = at.Add(2 * time.Hour)
		fail(at, TOTPMaxFailures)
	}
	st, _ = s.Status(at)
	if got := st.LockedUntil.Sub(at); got != TOTPLockMax {
		t.Fatalf("khoá tối đa = %v", got)
	}

	// Chủ máy mở khoá tại máy.
	if err := s.Unlock(); err != nil {
		t.Fatal(err)
	}
	if err := s.Verify(code(at), at); err != nil {
		t.Fatalf("sau mở khoá: %v", err)
	}
}

func TestTOTPLockLevelDecays(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := enabledStore(t, now)
	for range TOTPMaxFailures {
		_ = s.Verify("000000", now)
	}
	// Hai ngày không sai: mức khoá hạ, lần khoá sau lại 5 phút.
	later := now.Add(48 * time.Hour)
	for range TOTPMaxFailures {
		_ = s.Verify("000000", later)
	}
	st, _ := s.Status(later)
	if got := st.LockedUntil.Sub(later); got != 5*time.Minute {
		t.Fatalf("khoá sau hai ngày yên = %v", got)
	}
}

func TestTOTPDisableInvalidatesOldSecret(t *testing.T) {
	now := time.Unix(1_792_000_000, 0)
	s := enabledStore(t, now)
	if err := s.Disable(); err != nil {
		t.Fatal(err)
	}
	if err := s.Verify(code(now), now); Code(err) != CodeTOTPDisabled {
		t.Fatalf("sau khi tắt = %v", err)
	}
	other, _ := NewTOTPSecret()
	if err := s.Enable(other, TOTPCode(other, now.Unix()/TOTPPeriod-1), now); err != nil {
		t.Fatal(err)
	}
	if err := s.Verify(code(now.Add(TOTPPeriod*time.Second)), now); Code(err) != CodeTOTPInvalid {
		t.Fatalf("khoá cũ sau khi đổi = %v", err)
	}
}

func TestTOTPURI(t *testing.T) {
	uri := TOTPURI("Mac của An", rfcSecret)
	for _, want := range []string{"otpauth://totp/Hive:Mac%20c%E1%BB%A7a%20An?", "secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", "issuer=Hive", "period=30", "digits=6"} {
		if !strings.Contains(uri, want) {
			t.Errorf("URI %s thiếu %s", uri, want)
		}
	}
}
