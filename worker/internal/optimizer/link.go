package optimizer

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Link dùng symlink trên Unix và bản sao trên Windows vì symlink cần quyền quản trị hoặc Developer Mode.
// hiveSrc có thể rỗng hoặc chưa tồn tại để bundle cũ vẫn đặt được hive-worker.
func (o *Optimizer) Link(src, hiveSrc string) (string, error) {
	dest, err := linkBinary(src, o.LinkPath())
	if err != nil {
		return "", err
	}
	if hiveSrc == "" {
		return dest, nil
	}
	if _, err := os.Stat(hiveSrc); os.IsNotExist(err) {
		return dest, nil
	} else if err != nil {
		return "", err
	}
	name := "hive"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if _, err := linkBinary(hiveSrc, filepath.Join(filepath.Dir(dest), name)); err != nil {
		return "", fmt.Errorf("không đặt được liên kết hive: %w", err)
	}
	return dest, nil
}

func linkBinary(src, dest string) (string, error) {
	if src == "" {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		src = exe
	}
	src, err := filepath.Abs(src)
	if err != nil {
		return "", err
	}
	if real, err := filepath.EvalSymlinks(src); err == nil {
		src = real
	}
	// Lệnh link chạy từ chính liên kết thì src đã là đích: tạo lại sẽ thành liên kết vòng.
	if samePath(src, dest) {
		return dest, nil
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		return dest, copyBinary(src, dest)
	}
	if cur, err := os.Readlink(dest); err == nil && cur == src {
		return dest, nil
	}
	// Tạo liên kết ở tên tạm rồi rename để hook đang chạy không bao giờ thấy đường dẫn trống.
	tmp := fmt.Sprintf("%s.tmp-%d", dest, time.Now().UnixNano())
	if err := os.Symlink(src, tmp); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return dest, nil
}

// copyBinary chép src sang dest khi nội dung khác. Windows không ghi đè được file .exe đang chạy (hook đang chạy) nhưng
// đổi tên được, nên bản cũ được đổi tên sang .old rồi mới đặt bản mới.
func copyBinary(src, dest string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if cur, err := os.ReadFile(dest); err == nil && bytes.Equal(cur, data) {
		return nil
	}
	tmp, err := os.CreateTemp(filepath.Dir(dest), ".hive-worker-*")
	if err != nil {
		return err
	}
	_, err = io.Copy(tmp, bytes.NewReader(data))
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), 0o755)
	}
	if err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), dest); err == nil {
		return nil
	}
	old := dest + ".old"
	_ = os.Remove(old)
	if err := os.Rename(dest, old); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), dest); err != nil {
		_ = os.Rename(old, dest)
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
