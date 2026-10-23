// Package machinekey giữ khoá Ed25519 của máy (spec 027 US3, ADR 0033). Máy ký nonce của hub bằng khoá này để đổi lấy
// access token 15 phút, nên trên đĩa không còn token dài hạn nào: lộ worker.json không còn là lộ quyền vào hub.
package machinekey

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	// KeyringService tách khỏi `dev.xdev.hive` của token người dùng để `hive auth logout` không xoá nhầm khoá máy.
	KeyringService = "dev.xdev.hive.machine"

	StorageKeychain = "keychain"
	StorageFile     = "file"

	messagePrefix = "xdev-hive-machine-token"
)

// Keyring là phần keychain gói này cần; test thay bằng bản giả.
type Keyring interface {
	Get(service, user string) (string, error)
	Set(service, user, password string) error
	Delete(service, user string) error
}

type osKeyring struct{}

func (osKeyring) Get(s, u string) (string, error) { return keyring.Get(s, u) }
func (osKeyring) Set(s, u, p string) error        { return keyring.Set(s, u, p) }
func (osKeyring) Delete(s, u string) error        { return keyring.Delete(s, u) }

// Key là khoá riêng của máy và nơi đang giữ nó.
type Key struct {
	private ed25519.PrivateKey
	Storage string
}

// PublicKey là khoá công khai 32 byte dạng base64url không padding, như hub đòi.
func (k *Key) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(k.private.Public().(ed25519.PublicKey))
}

// Sign ký nonce cho một hub. Thông điệp gồm địa chỉ hub và id máy để chữ ký cho hub này không đem dùng được ở hub khác.
func (k *Key) Sign(hubURL, machineID, nonce string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.private, []byte(Message(hubURL, machineID, nonce))))
}

// Message trùng `machineTokenMessage` của hợp đồng. Hub ký `iss` không có dấu `/` cuối nên ở đây bỏ đi cho khớp.
func Message(hubURL, machineID, nonce string) string {
	return strings.Join([]string{messagePrefix, strings.TrimRight(hubURL, "/"), machineID, nonce}, "\n")
}

// Store tìm khoá theo hub và tên máy: chạy nhiều worker trên một máy (HIVE_WORKER_CONFIG) thì mỗi worker một khoá.
type Store struct {
	Keyring Keyring
	// File là nơi giữ khoá khi máy không có keychain (Linux không có Secret Service, máy chủ không giao diện).
	File string
	// Scope là id đăng ký (spec 034): hai tổ chức trên cùng hub, cùng tên máy thì mỗi đăng ký một khoá trong keychain.
	// Rỗng giữ tên cũ để máy cài trước đó còn tìm thấy khoá.
	Scope string
}

// NewStore dùng keychain của hệ điều hành và file cạnh worker.json.
func NewStore(configPath string) *Store {
	return &Store{Keyring: osKeyring{}, File: strings.TrimSuffix(configPath, filepath.Ext(configPath)) + ".key"}
}

func (s *Store) account(hubURL, machineID string) string {
	a := strings.TrimRight(hubURL, "/") + " " + machineID
	if s.Scope != "" {
		a += " " + s.Scope
	}
	return a
}

func (s *Store) keyring() Keyring {
	if s.Keyring == nil {
		return osKeyring{}
	}
	return s.Keyring
}

// ErrNoKey báo máy chưa có khoá cho hub này.
var ErrNoKey = errors.New("máy chưa có khoá")

// Load đọc keychain trước rồi tới file. Keychain lỗi (bị khoá, không có dịch vụ) thì vẫn thử file, vì khoá có thể đã
// được tạo lúc keychain không dùng được.
func (s *Store) Load(hubURL, machineID string) (*Key, error) {
	if v, err := s.keyring().Get(KeyringService, s.account(hubURL, machineID)); err == nil && v != "" {
		k, err := decode(v)
		if err != nil {
			return nil, fmt.Errorf("khoá máy trong keychain hỏng: %w", err)
		}
		return &Key{private: k, Storage: StorageKeychain}, nil
	}
	if s.File == "" {
		return nil, ErrNoKey
	}
	data, err := os.ReadFile(s.File)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNoKey
	}
	if err != nil {
		return nil, fmt.Errorf("đọc khoá máy %s: %w", s.File, err)
	}
	// Dòng đầu là hub và tên máy: file nằm cạnh worker.json nên còn sót lại khi máy đăng ký sang hub khác.
	owner, seed, _ := strings.Cut(strings.ReplaceAll(string(data), "\r", ""), "\n")
	if owner != s.account(hubURL, machineID) {
		return nil, ErrNoKey
	}
	k, err := decode(strings.TrimSpace(seed))
	if err != nil {
		return nil, fmt.Errorf("khoá máy %s hỏng: %w", s.File, err)
	}
	return &Key{private: k, Storage: StorageFile}, nil
}

// Create tạo khoá mới, cất vào keychain, không được thì vào file 0600. Khoá cũ của cùng hub và tên máy bị thay.
func (s *Store) Create(hubURL, machineID string) (*Key, error) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("tạo khoá máy: %w", err)
	}
	seed := base64.RawURLEncoding.EncodeToString(priv.Seed())
	if err := s.keyring().Set(KeyringService, s.account(hubURL, machineID), seed); err == nil {
		// Bỏ file cũ để Load không đọc nhầm khoá đã thay khi keychain sau này không mở được.
		if s.File != "" {
			_ = os.Remove(s.File)
		}
		return &Key{private: priv, Storage: StorageKeychain}, nil
	}
	if s.File == "" {
		return nil, errors.New("máy không có keychain và không có chỗ ghi file khoá")
	}
	if err := writeFile(s.File, s.account(hubURL, machineID)+"\n"+seed); err != nil {
		return nil, err
	}
	return &Key{private: priv, Storage: StorageFile}, nil
}

// Delete xoá khoá ở cả hai nơi, dùng khi máy đăng ký lại hay gỡ worker.
func (s *Store) Delete(hubURL, machineID string) error {
	var errs []error
	if err := s.keyring().Delete(KeyringService, s.account(hubURL, machineID)); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		errs = append(errs, fmt.Errorf("xoá khoá máy trong keychain: %w", err))
	}
	if s.File != "" {
		if err := os.Remove(s.File); err != nil && !errors.Is(err, os.ErrNotExist) {
			errs = append(errs, fmt.Errorf("xoá file khoá máy: %w", err))
		}
	}
	return errors.Join(errs...)
}

func decode(seed string) (ed25519.PrivateKey, error) {
	b, err := base64.RawURLEncoding.DecodeString(seed)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.SeedSize {
		return nil, fmt.Errorf("khoá dài %d byte, cần %d", len(b), ed25519.SeedSize)
	}
	return ed25519.NewKeyFromSeed(b), nil
}

// writeFile ghi file tạm 0600 rồi đổi tên như config.Save, để mất điện giữa chừng không để lại khoá cụt.
func writeFile(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("tạo thư mục khoá máy: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".machine-*.key")
	if err != nil {
		return fmt.Errorf("ghi khoá máy: %w", err)
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return fmt.Errorf("đặt quyền file khoá máy: %w", err)
	}
	if _, err := tmp.WriteString(content + "\n"); err != nil {
		tmp.Close()
		return fmt.Errorf("ghi khoá máy: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("ghi khoá máy: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("ghi khoá máy: %w", err)
	}
	return nil
}
