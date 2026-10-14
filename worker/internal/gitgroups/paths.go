package gitgroups

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

// windowsReserved là tên thiết bị Windows không cho đặt tên thư mục, kể cả kèm đuôi (con.txt).
var windowsReserved = map[string]bool{"CON": true, "PRN": true, "AUX": true, "NUL": true}

func init() {
	for i := '1'; i <= '9'; i++ {
		windowsReserved["COM"+string(i)] = true
		windowsReserved["LPT"+string(i)] = true
	}
}

// checkSegment kiểm một đoạn đường dẫn từ API theo luật chặt nhất của các hệ điều hành, để cùng group clone ra cây thư
// mục giống nhau trên macOS, Linux và Windows, và máy chủ trả dữ liệu lạ cũng không ghi được ra ngoài thư mục gốc.
func checkSegment(s string) error {
	switch {
	case s == "" || s == "." || s == "..":
		return fmt.Errorf("đoạn %q", s)
	case len(s) > 255:
		return errors.New("đoạn quá dài")
	case strings.ContainsAny(s, `<>:"|?*\`):
		return fmt.Errorf("ký tự cấm trong %q", s)
	case strings.HasSuffix(s, ".") || strings.HasSuffix(s, " ") || strings.HasPrefix(s, " "):
		return fmt.Errorf("%q kết thúc bằng dấu chấm hay khoảng trắng", s)
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return fmt.Errorf("ký tự điều khiển trong %q", s)
		}
	}
	base := strings.ToUpper(s)
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	if windowsReserved[base] {
		return fmt.Errorf("%q là tên dành riêng của Windows", s)
	}
	return nil
}

// RepoDir là thư mục của repo dưới thư mục gốc: <root>/<đường dẫn đầy đủ trên máy chủ>.
func RepoDir(root, repoPath string) (string, error) {
	root = strings.TrimSpace(root)
	if root == "" || !filepath.IsAbs(root) {
		return "", fmt.Errorf("thư mục gốc %q phải là đường dẫn tuyệt đối", root)
	}
	segs := strings.Split(repoPath, "/")
	for _, s := range segs {
		if err := checkSegment(s); err != nil {
			return "", fmt.Errorf("đường dẫn repo %q không dùng được làm thư mục: %w", repoPath, err)
		}
	}
	root = filepath.Clean(root)
	dir := filepath.Join(append([]string{root}, segs...)...)
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("đường dẫn repo %q ra ngoài thư mục gốc", repoPath)
	}
	return dir, nil
}
