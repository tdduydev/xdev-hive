package secretstore

import (
	"errors"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

func mockStore(t *testing.T) *Store {
	t.Helper()
	keyring.MockInit()
	return NewStore()
}

// bigValue là giá trị 8 KiB nhiều dòng có nháy, $, Unicode, \r\n: đủ 5 khối và ký tự nhiều byte rơi đúng chỗ cắt khối.
func bigValue() string {
	line := "dòng 'nháy đơn' \"nháy kép\" $HOME `x` ặ\r\n"
	v := strings.Repeat(line, MaxValueLen/len(line)+1)
	v = v[:MaxValueLen]
	for !strings.HasSuffix(v, "\n") && len(v) > 0 {
		v = v[:len(v)-1]
	}
	return v
}

func TestStoreRoundTripBytes(t *testing.T) {
	s := mockStore(t)
	for _, v := range []string{"12345678", strings.Repeat("a", chunkSize), strings.Repeat("b", chunkSize+1), bigValue()} {
		if err := s.Set("API_TOKEN", v); err != nil {
			t.Fatalf("Set %d byte: %v", len(v), err)
		}
		got, err := s.Get("API_TOKEN")
		if err != nil {
			t.Fatalf("Get %d byte: %v", len(v), err)
		}
		if got != v {
			// Không in giá trị: chỉ độ dài, như mọi chỗ khác của gói.
			t.Fatalf("đọc lại %d byte, khác giá trị %d byte đã ghi", len(got), len(v))
		}
	}
}

func TestStoreChunksFitWindowsLimit(t *testing.T) {
	s := mockStore(t)
	if err := s.Set("BIG", strings.Repeat("\xe1\xba\xb7", MaxValueLen/3)); err != nil {
		t.Fatal(err)
	}
	for k := 0; k < maxChunks; k++ {
		raw, err := keyring.Get(Service, chunkAccount("BIG", k))
		if err != nil {
			t.Fatalf("khối %d: %v", k, err)
		}
		// Credential Manager giữ tối đa 2560 byte mỗi mục (research "Kết quả kiểm").
		if len(raw) > 2560 {
			t.Fatalf("khối %d dài %d byte, quá giới hạn Windows", k, len(raw))
		}
	}
}

func TestStoreShrinkDeletesExtraChunks(t *testing.T) {
	s := mockStore(t)
	if err := s.Set("API_TOKEN", bigValue()); err != nil {
		t.Fatal(err)
	}
	if _, err := keyring.Get(Service, "API_TOKEN#4"); err != nil {
		t.Fatalf("giá trị 8 KiB phải có khối #4: %v", err)
	}
	if err := s.Set("API_TOKEN", "short-but-valid"); err != nil {
		t.Fatal(err)
	}
	for k := 1; k < maxChunks; k++ {
		if _, err := keyring.Get(Service, chunkAccount("API_TOKEN", k)); !errors.Is(err, keyring.ErrNotFound) {
			t.Fatalf("khối #%d của giá trị cũ còn sót: %v", k, err)
		}
	}
	if got, err := s.Get("API_TOKEN"); err != nil || got != "short-but-valid" {
		t.Fatalf("đọc lại sau khi rút ngắn: lỗi %v", err)
	}
}

func TestStoreMissingAndCorrupt(t *testing.T) {
	s := mockStore(t)
	if _, err := s.Get("NOPE"); !errors.Is(err, ErrMissing) {
		t.Fatalf("mục không có: %v, muốn ErrMissing", err)
	}

	if err := s.Set("CUT", bigValue()); err != nil {
		t.Fatal(err)
	}
	if err := keyring.Delete(Service, "CUT#2"); err != nil {
		t.Fatal(err)
	}
	_, err := s.Get("CUT")
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeStoreCorrupt || !onlyName(e.Names, "CUT") {
		t.Fatalf("thiếu khối: %v, muốn ErrCorrupt có tên", err)
	}

	for _, head := range []string{"plain-value", "v2:1:abcd:QUJDREVGR0g=", "v1:9:abcd:QUJDREVGR0g=", "v1:1::QUJDREVGR0g=", "v1:1:abcd:%%%"} {
		if err := keyring.Set(Service, "BAD", head); err != nil {
			t.Fatal(err)
		}
		if _, err := s.Get("BAD"); !errors.Is(err, ErrCorrupt) {
			t.Errorf("mục đầu %q: %v, muốn ErrCorrupt", head, err)
		}
	}
}

// Ghi đè dừng sau khi ghi khối mới, trước mục đầu: mục đầu cũ không được ghép với khối mới thành giá trị sai.
func TestStoreInterruptedOverwriteIsCorrupt(t *testing.T) {
	s := mockStore(t)
	if err := s.Set("ROT", strings.Repeat("a", 3*chunkSize)); err != nil {
		t.Fatal(err)
	}
	oldHead, _ := keyring.Get(Service, "ROT")
	if err := s.Set("ROT", strings.Repeat("b", 3*chunkSize)); err != nil {
		t.Fatal(err)
	}
	if err := keyring.Set(Service, "ROT", oldHead); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get("ROT"); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("mục đầu cũ với khối mới: %v, muốn ErrCorrupt", err)
	}
}

func TestStoreDelete(t *testing.T) {
	s := mockStore(t)
	if err := s.Set("GONE", bigValue()); err != nil {
		t.Fatal(err)
	}
	if err := s.Delete("GONE"); err != nil {
		t.Fatal(err)
	}
	for k := 0; k < maxChunks; k++ {
		if _, err := keyring.Get(Service, chunkAccount("GONE", k)); !errors.Is(err, keyring.ErrNotFound) {
			t.Fatalf("khối %d còn sau khi xoá: %v", k, err)
		}
	}
	if err := s.Delete("GONE"); err != nil {
		t.Fatalf("xoá lại mục đã xoá phải không lỗi: %v", err)
	}
}

func TestStoreErrorsNeverCarryValue(t *testing.T) {
	const value = "super-secret-value-123"
	keyring.MockInitWithError(errors.New("backend failed for " + value))
	s := NewStore()
	err := s.Set("API_TOKEN", value)
	if err == nil || strings.Contains(err.Error(), value) {
		t.Fatalf("lỗi Set phải có và không chứa giá trị: %v", err == nil)
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("lỗi lạ của kho phải thành ErrUnavailable: %v", err)
	}
	if _, err := s.Get("API_TOKEN"); err == nil || strings.Contains(err.Error(), value) {
		t.Fatal("lỗi Get phải có và không chứa giá trị")
	}
	if err := s.Set("API_TOKEN", "short"); !errors.Is(err, &Error{Code: CodeInvalidValue}) {
		t.Fatalf("giá trị sai phải bị chặn trước khi tới kho: %v", err)
	}
}

func onlyName(names []string, want string) bool { return len(names) == 1 && names[0] == want }
