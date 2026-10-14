package remoteauth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Root là thư mục chủ máy cho mở phiên từ xa. Path chỉ nằm ở máy; hub chỉ thấy ID và Label (term_state).
type Root struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Path  string `json:"path"`
}

// Device là điện thoại đã ghép bằng passkey. SPKI là khoá công khai ES256; SignCount để phát hiện passkey bị sao chép.
type Device struct {
	ID           string    `json:"id"`
	Label        string    `json:"label"`
	UserID       string    `json:"userId"`
	CredentialID string    `json:"credentialId"`
	SPKI         string    `json:"spki"`
	SignCount    uint32    `json:"signCount"`
	CreatedAt    time.Time `json:"createdAt"`
	LastUsedAt   time.Time `json:"lastUsedAt,omitzero"`
}

// Synced: passkey đồng bộ (iCloud, Google) luôn báo bộ đếm 0, nên còn trên thiết bị khác cùng tài khoản nền tảng.
func (d Device) Synced() bool { return d.SignCount == 0 }

// Config là remote.json cạnh worker.json. Mặc định (file không có) là tắt: chỉ người ở máy bật được (FR-012).
type Config struct {
	Enabled          bool     `json:"enabled"`
	Roots            []Root   `json:"roots"`
	Devices          []Device `json:"devices"`
	ConfirmOnMachine bool     `json:"confirmOnMachine"`
	IdleMinutes      int      `json:"idleMinutes,omitempty"`
	DetachedHours    int      `json:"detachedHours,omitempty"`
	MaxHours         int      `json:"maxHours,omitempty"`
	AllowFullAccess  bool     `json:"allowFullAccess"`
	// OwnerUserID là chủ máy theo hub lúc ghép; welcome.owner khác thì xoá thiết bị (máy đổi chủ).
	OwnerUserID string `json:"ownerUserId,omitempty"`
	// TOTPOnHTTPS: chủ máy cho dùng mã TOTP cả khi hub chạy HTTPS (FR-016); mặc định chỉ HTTP.
	TOTPOnHTTPS bool `json:"totpOnHttps,omitempty"`
}

func (c Config) Idle() time.Duration     { return minutes(c.IdleMinutes, 15) }
func (c Config) Detached() time.Duration { return hours(c.DetachedHours, 2) }
func (c Config) Max() time.Duration      { return hours(c.MaxHours, 12) }

func minutes(v, def int) time.Duration {
	if v <= 0 {
		v = def
	}
	return time.Duration(v) * time.Minute
}

func hours(v, def int) time.Duration {
	if v <= 0 {
		v = def
	}
	return time.Duration(v) * time.Hour
}

// DefaultDir là thư mục cấu hình của worker (cùng chỗ worker.json, accounts.json).
func DefaultDir() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "xdev-hive"), nil
}

// Store đọc ghi remote.json. Mọi thay đổi đi qua Update để hai luồng (socket nội bộ, gói từ hub) không ghi đè nhau.
type Store struct {
	Path string
	mu   sync.Mutex
}

func NewStore(dir string) *Store { return &Store{Path: filepath.Join(dir, "remote.json")} }

func (s *Store) Load() (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.load()
}

func (s *Store) load() (Config, error) {
	var c Config
	data, err := os.ReadFile(s.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, fmt.Errorf("đọc remote.json: %w", err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("remote.json hỏng: %w", err)
	}
	return c, nil
}

// Update đọc, sửa, ghi nguyên tử. fn trả lỗi thì không ghi.
func (s *Store) Update(fn func(*Config) error) (Config, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, err := s.load()
	if err != nil {
		return c, err
	}
	if err := fn(&c); err != nil {
		return c, err
	}
	return c, writeJSONAtomic(s.Path, c)
}

// DeviceByCredential tìm thiết bị đã ghép theo credentialId của passkey.
func (s *Store) DeviceByCredential(credentialID string) (Device, bool, error) {
	c, err := s.Load()
	if err != nil {
		return Device{}, false, err
	}
	for _, d := range c.Devices {
		if d.CredentialID == credentialID {
			return d, true, nil
		}
	}
	return Device{}, false, nil
}

// MarkUsed lưu signCount mới trước khi cấp quyền, để assertion cũ không dùng lại được sau khi worker khởi động lại.
func (s *Store) MarkUsed(deviceID string, signCount uint32, at time.Time) error {
	_, err := s.Update(func(c *Config) error {
		for i := range c.Devices {
			if c.Devices[i].ID == deviceID {
				c.Devices[i].SignCount = signCount
				c.Devices[i].LastUsedAt = at
				return nil
			}
		}
		return deny(CodeDeviceUnknown)
	})
	return err
}

// writeJSONAtomic ghi file 0600 qua file tạm + fsync + đổi tên: trạng thái chống phát lại (lastStep, signCount) phải
// nằm trên đĩa trước khi worker trả kết quả, mất điện giữa chừng không được làm mất hay hỏng nó.
func writeJSONAtomic(path string, v any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}
