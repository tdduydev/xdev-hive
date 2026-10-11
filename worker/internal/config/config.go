// Package config đọc và ghi file cấu hình của worker: địa chỉ hub, tên máy và machine token nhận khi đăng ký.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type Config struct {
	HubURL       string `json:"hubUrl"`
	MachineID    string `json:"machineId"`
	MachineToken string `json:"machineToken"`
	// TeamID chỉ để hiển thị; hub xác định đội từ token.
	TeamID string `json:"teamId,omitempty"`
}

// DefaultPath là file cấu hình theo hệ điều hành: ~/.config trên Linux, ~/Library/Application Support trên macOS,
// %AppData% trên Windows. HIVE_WORKER_CONFIG ghi đè, để chạy nhiều worker trên một máy hoặc trong test.
func DefaultPath() (string, error) {
	if p := os.Getenv("HIVE_WORKER_CONFIG"); p != "" {
		return p, nil
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("không tìm được thư mục cấu hình: %w", err)
	}
	return filepath.Join(dir, "xdev-hive", "worker.json"), nil
}

// ErrNotRegistered báo máy chưa chạy `hive-worker register`.
var ErrNotRegistered = errors.New("máy chưa đăng ký với hub; chạy `hive-worker register --hub URL --token MÃ` trước")

func Load(path string) (Config, error) {
	var c Config
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, ErrNotRegistered
	}
	if err != nil {
		return c, fmt.Errorf("đọc %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &c); err != nil {
		return c, fmt.Errorf("file cấu hình %s hỏng: %w", path, err)
	}
	return c, nil
}

// Save ghi cấu hình với quyền 0600 vì file chứa machine token. Ghi vào file tạm rồi đổi tên, để mất điện giữa chừng
// không làm hỏng token đang dùng.
func Save(path string, c Config) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("tạo thư mục cấu hình: %w", err)
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".worker-*.json")
	if err != nil {
		return fmt.Errorf("ghi cấu hình: %w", err)
	}
	defer os.Remove(tmp.Name())
	// CreateTemp đã tạo file 0600; Chmod thêm cho chắc khi umask lạ.
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return fmt.Errorf("đặt quyền file cấu hình: %w", err)
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("ghi cấu hình: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("ghi cấu hình: %w", err)
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fmt.Errorf("ghi cấu hình: %w", err)
	}
	return nil
}
