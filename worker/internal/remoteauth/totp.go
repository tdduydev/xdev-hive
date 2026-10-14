package remoteauth

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base32"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Tham số TOTP đúng mặc định của app Authenticator (RFC 6238): HMAC-SHA1, 6 số, bước 30 giây, lệch ±1 bước.
const (
	TOTPDigits      = 6
	TOTPPeriod      = 30
	TOTPSkewSteps   = 1
	TOTPMaxFailures = 5
	TOTPLockBase    = 5 * time.Minute
	TOTPLockMax     = time.Hour
	// Một ngày không sai thì hạ một mức khoá, để lần khoá sau lại bắt đầu ngắn.
	totpLockDecay = 24 * time.Hour
)

var totpBase32 = base32.StdEncoding.WithPadding(base32.NoPadding)

// TOTPCode tính mã của một bước thời gian (RFC 4226 với bộ đếm = bước).
func TOTPCode(secret []byte, step int64) string {
	var counter [8]byte
	binary.BigEndian.PutUint64(counter[:], uint64(step))
	h := hmac.New(sha1.New, secret)
	h.Write(counter[:])
	sum := h.Sum(nil)
	off := sum[len(sum)-1] & 0x0f
	bin := binary.BigEndian.Uint32(sum[off:off+4]) & 0x7fffffff
	return fmt.Sprintf("%06d", bin%1_000_000)
}

// NewTOTPSecret sinh khoá 160 bit tại máy; khoá không rời máy ngoài QR cho app Authenticator (FR-033).
func NewTOTPSecret() ([]byte, error) {
	s := make([]byte, 20)
	_, err := rand.Read(s)
	return s, err
}

// TOTPURI là URI otpauth:// để in QR. machine là tên máy hiện trong app Authenticator.
func TOTPURI(machine string, secret []byte) string {
	q := url.Values{}
	q.Set("secret", totpBase32.EncodeToString(secret))
	q.Set("issuer", "Hive")
	q.Set("algorithm", "SHA1")
	q.Set("digits", "6")
	q.Set("period", "30")
	return "otpauth://totp/" + url.PathEscape("Hive:"+machine) + "?" + q.Encode()
}

// totpState là totp.json. Bộ đếm và bước cuối nằm trên đĩa để khởi động lại không đặt lại khoá hay cho dùng lại mã.
type totpState struct {
	Secret      string    `json:"secret"`
	LastStep    int64     `json:"lastStep"`
	Failures    int       `json:"failures"`
	LockedUntil time.Time `json:"lockedUntil,omitzero"`
	LockLevel   int       `json:"lockLevel"`
	LastFailure time.Time `json:"lastFailure,omitzero"`
	EnabledAt   time.Time `json:"enabledAt"`
}

// TOTPStore kiểm mã TOTP với trạng thái bền trong totp.json (0600). Bộ đếm sai tính theo máy, không theo kết nối hay
// người dùng (FR-035).
type TOTPStore struct {
	Path string
	mu   sync.Mutex
}

func NewTOTPStore(dir string) *TOTPStore { return &TOTPStore{Path: filepath.Join(dir, "totp.json")} }

func (s *TOTPStore) load() (*totpState, error) {
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("đọc totp.json: %w", err)
	}
	var st totpState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil, fmt.Errorf("totp.json hỏng: %w", err)
	}
	return &st, nil
}

// TOTPStatus là phần hub được biết (term_state.totp); không có khoá.
type TOTPStatus struct {
	Enabled     bool
	Locked      bool
	LockedUntil time.Time
}

func (s *TOTPStore) Status(now time.Time) (TOTPStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil || st == nil {
		return TOTPStatus{}, err
	}
	locked := now.Before(st.LockedUntil)
	out := TOTPStatus{Enabled: true, Locked: locked}
	if locked {
		out.LockedUntil = st.LockedUntil
	}
	return out, nil
}

// match trả bước khớp trong cửa sổ ±1, hoặc -1. So sánh hằng thời gian và luôn thử đủ ba bước.
func match(secret []byte, code string, now time.Time) int64 {
	cur := now.Unix() / TOTPPeriod
	found := int64(-1)
	for d := int64(-TOTPSkewSteps); d <= TOTPSkewSteps; d++ {
		if subtle.ConstantTimeCompare([]byte(code), []byte(TOTPCode(secret, cur+d))) == 1 {
			found = cur + d
		}
	}
	return found
}

// Enable lưu khoá mới chỉ khi code đúng với khoá đó (chủ máy đã quét vào app). Bước của mã xác nhận được tính là đã
// dùng, nên không dùng lại được để mở phiên. Khoá cũ (nếu có) mất hiệu lực ngay.
func (s *TOTPStore) Enable(secret []byte, code string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	step := match(secret, code, now)
	if step < 0 {
		return deny(CodeTOTPInvalid)
	}
	return writeJSONAtomic(s.Path, totpState{
		Secret:    totpBase32.EncodeToString(secret),
		LastStep:  step,
		EnabledAt: now.UTC(),
	})
}

// Disable xoá khoá; chỉ gọi từ thao tác tại máy.
func (s *TOTPStore) Disable() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.Remove(s.Path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Unlock mở khoá tạm tại máy. Giữ mức khoá để kẻ cố tình làm khoá vẫn bị khoá lâu dần.
func (s *TOTPStore) Unlock() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil || st == nil {
		return err
	}
	st.LockedUntil = time.Time{}
	st.Failures = 0
	return writeJSONAtomic(s.Path, st)
}

// Verify kiểm mã cho một lần mở phiên hay xin quyền gõ (FR-034, FR-035). Trạng thái mới được ghi ra đĩa trước khi trả
// kết quả; ghi lỗi thì từ chối.
func (s *TOTPStore) Verify(code string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, err := s.load()
	if err != nil {
		return err
	}
	if st == nil {
		return deny(CodeTOTPDisabled)
	}
	if now.Before(st.LockedUntil) {
		return deny(CodeTOTPLocked)
	}
	secret, err := totpBase32.DecodeString(st.Secret)
	if err != nil {
		return fmt.Errorf("totp.json hỏng: %w", err)
	}
	if st.LockLevel > 0 && !st.LastFailure.IsZero() {
		if days := int(now.Sub(st.LastFailure) / totpLockDecay); days > 0 {
			st.LockLevel = max(0, st.LockLevel-days)
		}
	}
	step := match(secret, code, now)
	if step < 0 {
		st.Failures++
		st.LastFailure = now.UTC()
		if st.Failures >= TOTPMaxFailures {
			st.LockedUntil = now.Add(min(TOTPLockBase<<min(st.LockLevel, 8), TOTPLockMax)).UTC()
			st.LockLevel++
			st.Failures = 0
		}
		if err := writeJSONAtomic(s.Path, st); err != nil {
			return err
		}
		return deny(CodeTOTPInvalid)
	}
	// Mã đúng nhưng không mới hơn mã đã nhận: phát lại hoặc người nghe đường truyền dùng lại (T15). Không tính là đoán sai.
	if step <= st.LastStep {
		return deny(CodeTOTPReplay)
	}
	st.LastStep = step
	st.Failures = 0
	return writeJSONAtomic(s.Path, st)
}
