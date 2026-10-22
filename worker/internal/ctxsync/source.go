package ctxsync

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

var projectIDRe = regexp.MustCompile(`^[A-Za-z0-9-]{1,128}$`)

// KeyFor là khoá nguồn của dự án: theo id dự án hub khi đã gắn, để đổi tên hay chuyển thư mục vẫn giữ nguồn; chưa gắn
// thì theo thư mục như memstore.ProjectKey.
func KeyFor(projectID, folder string) (string, error) {
	if projectID != "" {
		if !projectIDRe.MatchString(projectID) {
			return "", fmt.Errorf("id dự án không hợp lệ: %q", projectID)
		}
		return "p_" + projectID, nil
	}
	if folder == "" {
		return "", errors.New("thiếu thư mục dự án")
	}
	abs, err := filepath.Abs(folder)
	if err != nil {
		return "", err
	}
	return "f_" + memstore.ProjectKey(filepath.Clean(abs)), nil
}

func (m Manager) sourcePath(key string) string { return filepath.Join(m.dir(key), "source.md") }

// Source là chữ người dùng soạn cho dự án; chưa có file là nguồn rỗng.
func (m Manager) Source(key string) (string, error) {
	if err := checkKey(key); err != nil {
		return "", err
	}
	raw, err := os.ReadFile(m.sourcePath(key))
	if os.IsNotExist(err) {
		return "", nil
	}
	return string(raw), err
}

// SaveSource lưu nguồn mới rồi ghi lại mọi file đích.
func (m Manager) SaveSource(key, content string) (Project, error) {
	if _, err := m.loadState(key); err != nil {
		return Project{}, err
	}
	if err := writeFile(m.sourcePath(key), []byte(content), 0o600); err != nil {
		return Project{}, err
	}
	p, _, err := m.Sync(key, nil, nil)
	return p, err
}
