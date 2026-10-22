// Package gitexclude giữ file cục bộ của máy (cài đặt, ngữ cảnh) ngoài git bằng .git/info/exclude: file riêng của bản
// clone, không bao giờ được commit, nên không làm bẩn .gitignore của cả đội.
package gitexclude

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

func git(repo string, args ...string) ([]byte, error) {
	return procattr.Command("git", append([]string{"-C", repo}, args...)...).Output()
}

func inWorkTree(repo string) bool {
	out, err := git(repo, "rev-parse", "--is-inside-work-tree")
	return err == nil && strings.TrimSpace(string(out)) == "true"
}

// Line là dòng exclude cho đường dẫn tương đối rel; dấu / đầu dòng neo vào gốc repo để không bỏ qua file trùng tên ở
// thư mục con.
func Line(rel string) string { return "/" + filepath.ToSlash(rel) }

// Path là file exclude của repo. Trong worktree, git đặt info/exclude ở thư mục chung (--git-common-dir), nên phải hỏi
// git thay vì ghép .git/info/exclude.
func Path(repo string) (string, error) {
	out, err := git(repo, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
	if err != nil {
		return "", err
	}
	return filepath.FromSlash(strings.TrimSpace(string(out))), nil
}

// Add thêm rel vào exclude nếu git chưa bỏ qua nó. added=true khi đã thêm dòng Line(rel), để bên gọi ghi lại và gỡ đúng
// dòng đó khi tắt. warn không rỗng khi không làm được; không phải repo git thì không cảnh báo.
func Add(repo, rel string) (added bool, warn string) {
	if !inWorkTree(repo) {
		return false, ""
	}
	if _, err := git(repo, "check-ignore", "-q", filepath.ToSlash(rel)); err == nil {
		return false, ""
	}
	hint := "; thêm " + filepath.ToSlash(rel) + " vào .gitignore để khỏi commit nhầm"
	path, err := Path(repo)
	if err != nil {
		return false, "không tìm được .git/info/exclude" + hint
	}
	line := Line(rel)
	cur, _ := os.ReadFile(path)
	text := string(cur)
	for _, l := range strings.Split(text, "\n") {
		if strings.TrimRight(l, "\r") == line {
			// Dòng đã có mà git vẫn không bỏ qua (có dòng ! phía sau): thêm lần nữa cũng vô ích.
			return false, ""
		}
	}
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if err := writeFile(path, []byte(text+line+"\n")); err != nil {
		return false, "không ghi được " + path + hint
	}
	return true, ""
}

// Remove gỡ đúng dòng line (do Add thêm) khỏi exclude; các dòng khác giữ nguyên. Trả cảnh báo khi không ghi được.
func Remove(repo, line string) string {
	if line == "" || !inWorkTree(repo) {
		return ""
	}
	path, err := Path(repo)
	if err != nil {
		return ""
	}
	cur, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	lines := strings.Split(string(cur), "\n")
	kept := lines[:0:0]
	for _, l := range lines {
		if strings.TrimRight(l, "\r") != line {
			kept = append(kept, l)
		}
	}
	if len(kept) == len(lines) {
		return ""
	}
	if err := writeFile(path, []byte(strings.Join(kept, "\n"))); err != nil {
		return "không gỡ được dòng " + line + " khỏi " + path
	}
	return ""
}

// Tracked cho biết rel đang được git theo dõi. File bị theo dõi thì exclude không có tác dụng, nên bên gọi không được
// ghi nội dung riêng của máy vào đó.
func Tracked(repo, rel string) bool {
	if !inWorkTree(repo) {
		return false
	}
	_, err := git(repo, "ls-files", "--error-unmatch", "--", filepath.ToSlash(rel))
	return err == nil
}

// writeFile ghi nguyên tử để git đang chạy song song không đọc phải file ghi dở.
func writeFile(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, werr := tmp.Write(data)
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil && runtime.GOOS != "windows" {
		werr = os.Chmod(name, 0o644)
	}
	if werr == nil {
		werr = os.Rename(name, path)
	}
	if werr != nil {
		_ = os.Remove(name)
	}
	return werr
}
