// Package instancelock ngăn nhiều worker cùng nhận việc và ghi dữ liệu của một người dùng.
package instancelock

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

var ErrAlreadyRunning = errors.New("đã có worker đang chạy")

// Lock giữ file mở suốt đời worker. Không xoá file khi nhả khoá: tiến trình khác có thể đã mở cùng inode.
type Lock struct {
	file *os.File
}

func Acquire() (*Lock, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("không tìm được thư mục nhà để khoá worker: %w", err)
	}
	// Dùng chung khoá dù app dev, app cài đặt hoặc --config trỏ tới đường dẫn khác nhau.
	path := filepath.Join(home, ".xdev-hive", "worker.lock")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("không tạo được thư mục khoá worker: %w", err)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("không mở được khoá worker: %w", err)
	}
	if err := tryLock(f); err != nil {
		_ = f.Close()
		if errors.Is(err, ErrAlreadyRunning) {
			return nil, err
		}
		return nil, fmt.Errorf("không khoá được worker: %w", err)
	}
	return &Lock{file: f}, nil
}

func (l *Lock) Close() error {
	if l.file == nil {
		return nil
	}
	// Hệ điều hành nhả khoá cả khi Close lẫn khi tiến trình bị giết, không cần dọn file khoá cũ.
	err := l.file.Close()
	l.file = nil
	return err
}
