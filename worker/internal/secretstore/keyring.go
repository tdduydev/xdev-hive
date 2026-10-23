package secretstore

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"runtime"
	"strconv"
	"strings"

	"github.com/zalando/go-keyring"
)

// Service là dịch vụ kho riêng của bí mật cho agent, khác dev.xdev.hive (token Hive) và dev.xdev.hive.git, để xoá hay
// liệt kê mục của bên này không đụng mục của bên kia.
const Service = "dev.xdev.hive.secrets"

// Credential Manager của Windows giữ tối đa 2560 byte mỗi mục, go-keyring trên macOS chặn dòng lệnh security quá 4096
// byte (specs/031 research "Kết quả kiểm"). Khối 1800 byte gốc thành 2400 ký tự base64 cộng tiền tố "v1:5:<gen>:", vừa
// cả hai; 8 KiB cần 5 khối.
const (
	chunkSize = 1800
	maxChunks = (MaxValueLen + chunkSize - 1) / chunkSize
	headerTag = "v1"
)

// backend là phần kho của hệ điều hành mà gói dùng; test dùng keyring.MockInit() qua osKeyring hay thay bằng bản giả.
type backend interface {
	Get(service, user string) (string, error)
	Set(service, user, secret string) error
	Delete(service, user string) error
}

type osKeyring struct{}

func (osKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }
func (osKeyring) Set(s, u, p string) error        { return keyring.Set(s, u, p) }
func (osKeyring) Delete(s, u string) error        { return keyring.Delete(s, u) }

// classify đổi lỗi của kho (trừ ErrNotFound) thành lỗi của gói. File theo hệ điều hành (T035) thay biến này để tách kho
// khoá khỏi kho không có; mặc định coi mọi lỗi là kho không dùng được.
var classify = func(error) *Error { return unavailable() }

var unavailableMessage = func() string {
	if runtime.GOOS == "linux" {
		return "Máy không có kho bí mật (Secret Service). Cài gnome-keyring hoặc KWallet rồi thử lại."
	}
	return "Không dùng được kho bí mật của hệ điều hành. Thử lại sau khi đăng nhập lại máy."
}()

// Store đọc, ghi giá trị trong kho theo định dạng khối của data-model §1: mục <NAME> là "v1:<n>:<gen>:<base64 khối 0>",
// các khối sau ở <NAME>#1 … <NAME>#<n-1> dạng "<gen>:<base64>". gen đổi mỗi lần ghi, để lần ghi dở (khối mới, mục đầu
// cũ) bị báo hỏng thay vì trả về giá trị ghép từ hai lần ghi.
type Store struct {
	kr backend
}

// NewStore dùng kho của hệ điều hành.
func NewStore() *Store { return &Store{kr: osKeyring{}} }

func chunkAccount(name string, k int) string {
	if k == 0 {
		return name
	}
	return name + "#" + strconv.Itoa(k)
}

// Get đọc giá trị của name. Mục đầu không có → ErrMissing; khối thiếu hay sai định dạng → ErrCorrupt.
func (s *Store) Get(name string) (string, error) {
	head, err := s.kr.Get(Service, name)
	if err != nil {
		return "", s.storeErr(err, name)
	}
	n, gen, first, ok := parseHead(head)
	if !ok {
		return "", corrupt(name)
	}
	var b strings.Builder
	b.Grow(n * chunkSize)
	for k := 0; k < n; k++ {
		enc := first
		if k > 0 {
			part, err := s.kr.Get(Service, chunkAccount(name, k))
			if err != nil {
				if errors.Is(err, keyring.ErrNotFound) {
					return "", corrupt(name)
				}
				return "", s.storeErr(err, name)
			}
			g, rest, found := strings.Cut(part, ":")
			if !found || g != gen {
				return "", corrupt(name)
			}
			enc = rest
		}
		raw, err := base64.StdEncoding.DecodeString(enc)
		if err != nil || len(raw) == 0 || len(raw) > chunkSize {
			return "", corrupt(name)
		}
		b.Write(raw)
	}
	return b.String(), nil
}

func parseHead(head string) (n int, gen, first string, ok bool) {
	parts := strings.SplitN(head, ":", 4)
	if len(parts) != 4 || parts[0] != headerTag || parts[2] == "" {
		return 0, "", "", false
	}
	n, err := strconv.Atoi(parts[1])
	if err != nil || n < 1 || n > maxChunks {
		return 0, "", "", false
	}
	return n, parts[2], parts[3], true
}

func newGen() string {
	var b [4]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// Set ghi giá trị đã qua ValidValue. Khối cuối ghi trước, mục đầu ghi sau cùng, để mục đầu chỉ trỏ tới khối đã ghi
// xong.
func (s *Store) Set(name, value string) error {
	if err := ValidValue(value); err != nil {
		return err
	}
	var chunks []string
	for i := 0; i < len(value); i += chunkSize {
		chunks = append(chunks, base64.StdEncoding.EncodeToString([]byte(value[i:min(i+chunkSize, len(value))])))
	}
	n, gen := len(chunks), newGen()
	for k := n - 1; k >= 1; k-- {
		if err := s.kr.Set(Service, chunkAccount(name, k), gen+":"+chunks[k]); err != nil {
			return s.storeErr(err, name)
		}
	}
	if err := s.kr.Set(Service, name, fmt.Sprintf("%s:%d:%s:%s", headerTag, n, gen, chunks[0])); err != nil {
		return s.storeErr(err, name)
	}
	return s.deleteChunks(name, n)
}

// Delete xoá mọi khối của name. Mục không có thì không lỗi, để xoá lại sau lần xoá dở vẫn chạy được.
func (s *Store) Delete(name string) error {
	if err := s.kr.Delete(Service, name); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		return s.storeErr(err, name)
	}
	return s.deleteChunks(name, 1)
}

// deleteChunks xoá khối từ from trở đi còn sót của giá trị cũ dài hơn.
func (s *Store) deleteChunks(name string, from int) error {
	for k := max(from, 1); k < maxChunks; k++ {
		if err := s.kr.Delete(Service, chunkAccount(name, k)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
			return s.storeErr(err, name)
		}
	}
	return nil
}

func (s *Store) storeErr(err error, name string) error {
	if errors.Is(err, keyring.ErrNotFound) {
		return missing(name)
	}
	e := classify(err)
	e.Names = []string{name}
	return e
}
