//go:build !windows

package sshkeys

import "os"

// restrictPrivate: OpenSSH bỏ qua khoá riêng mà người khác đọc được.
func restrictPrivate(path string) error { return os.Chmod(path, 0o600) }

// newFileMode đặt quyền cho file app tạo mới; os.WriteFile bị umask cắt bớt nên đặt lại cho chắc.
func newFileMode(path string, mode os.FileMode) error { return os.Chmod(path, mode) }

// copySecurity chép quyền của file cũ sang file mới cùng chủ (file tạm sắp đổi tên đè lên file cũ).
func copySecurity(from, to string) error {
	st, err := os.Stat(from)
	if err != nil {
		return err
	}
	return os.Chmod(to, st.Mode().Perm())
}
