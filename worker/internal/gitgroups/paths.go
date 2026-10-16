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

// levels là số cách xếp repo dưới thư mục gốc: gốc ứng với 0, 1, … tới hết các đoạn của đường dẫn group.
func levels(g Group) int {
	if g.Path == "" {
		return 1
	}
	return strings.Count(g.Path, "/") + 2
}

// repoDir là thư mục của repo khi thư mục gốc ứng với level đoạn đầu của đường dẫn group: level 0 là <gốc>/acme/pay/api
// (gốc chứa cả group, như spec), level bằng số đoạn của group là <gốc>/pay/api (gốc là thư mục của chính group, cách
// người dùng hay xếp khi đã clone tay trước khi theo dõi). Repo không nằm dưới group thì theo đường dẫn đầy đủ.
func repoDir(g Group, repoPath string, level int) (string, error) {
	group := strings.Split(g.Path, "/")
	segs := strings.Split(repoPath, "/")
	if g.Path != "" && level > 0 && level <= len(group) && len(segs) > len(group) &&
		strings.EqualFold(strings.Join(segs[:len(group)], "/"), g.Path) {
		repoPath = strings.Join(segs[level:], "/")
	}
	return RepoDir(g.Root, repoPath)
}
