//go:build !windows

package localipc

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func defaultPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "xdev-hive", "run", "hive.sock"), nil
}

// Listen mở Unix socket ở path: thư mục 0700 của người dùng hiện tại, socket 0600. Socket cũ không còn ai nghe (worker
// trước chết) thì xoá; còn worker khác nghe thì trả ErrInUse.
func Listen(path string) (net.Listener, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	if err := ownDir(dir); err != nil {
		return nil, err
	}
	if err := removeStale(path); err != nil {
		return nil, err
	}
	ln, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	// Thư mục 0700 đã chặn người khác; chmod là lớp thứ hai cho khi thư mục bị đổi quyền sau này.
	if err := os.Chmod(path, 0o600); err != nil {
		_ = ln.Close()
		return nil, err
	}
	return ln, nil
}

// ownDir: thư mục chứa socket phải là thư mục thật (không phải symlink người khác đặt) của chính người dùng, quyền 0700.
func ownDir(dir string) error {
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !fi.IsDir() {
		return fmt.Errorf("%s không phải thư mục", dir)
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok && int(st.Uid) != os.Getuid() {
		return fmt.Errorf("thư mục %s thuộc người dùng khác", dir)
	}
	if fi.Mode().Perm() != 0o700 {
		return os.Chmod(dir, 0o700)
	}
	return nil
}

func removeStale(path string) error {
	fi, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSocket == 0 {
		// Không xoá file lạ: đường dẫn sai cấu hình không được làm mất dữ liệu.
		return fmt.Errorf("%s đã có và không phải socket", path)
	}
	nc, err := net.DialTimeout("unix", path, time.Second)
	if err == nil {
		_ = nc.Close()
		return ErrInUse
	}
	if !errors.Is(err, syscall.ECONNREFUSED) && !errors.Is(err, syscall.ENOENT) {
		return fmt.Errorf("không kiểm được socket cũ %s: %w", path, err)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func dialSocket(path string, timeout time.Duration) (net.Conn, error) {
	nc, err := net.DialTimeout("unix", path, timeout)
	if err != nil {
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOTDIR) {
			return nil, fmt.Errorf("%w: %w", ErrNotRunning, err)
		}
		return nil, err
	}
	return nc, nil
}
