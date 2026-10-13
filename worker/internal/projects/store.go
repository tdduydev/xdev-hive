package projects

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }

func read(path string) (file, error) {
	var f file
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("đọc %s: %w", path, err)
	}
	return f, nil
}

// modify đọc, sửa rồi ghi projects.json trong lúc giữ khoá, để hai lệnh của app chạy cùng lúc không ghi đè nhau.
func modify(path string, change func(*file) error) error {
	return withLock(path, func() error {
		f, err := read(path)
		if err != nil {
			return err
		}
		if err := change(&f); err != nil {
			return err
		}
		if f.Projects == nil {
			f.Projects = []Project{}
		}
		return writeJSON(path, f)
	})
}

// withLock giữ path+".lock" trong lúc chạy fn. Tạo file với O_EXCL chạy được trên mọi hệ điều hành worker hỗ trợ;
// khoá bỏ lại quá staleLock là của tiến trình đã chết.
func withLock(path string, fn func() error) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	lock := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = f.Close()
			break
		}
		if !errors.Is(err, os.ErrExist) {
			return err
		}
		if st, err := os.Stat(lock); err == nil && time.Since(st.ModTime()) > staleLock {
			_ = os.Remove(lock)
			continue
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("%s đang bị tiến trình khác giữ, thử lại sau", path)
		}
		time.Sleep(20 * time.Millisecond)
	}
	defer func() { _ = os.Remove(lock) }()
	return fn()
}

// writeJSON ghi file (0600, thay nguyên file) để worker đang chạy không bao giờ đọc phải file ghi dở. os.Rename thay
// được file đích có sẵn trên cả Windows (MoveFileEx với REPLACE_EXISTING).
func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+"-*")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(append(b, '\n')); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// git chạy lệnh đọc trong dir, trả stdout đã cắt khoảng trắng.
func git(dir string, args ...string) (string, error) {
	c := exec.Command("git", append([]string{"-C", dir}, args...)...)
	b, err := c.Output()
	return strings.TrimSpace(string(b)), err
}

// SameRepo: hai URL repo trỏ cùng một repo khi trùng máy chủ và đường dẫn, bỏ qua giao thức (https, ssh, git@host:),
// tên đăng nhập, mật khẩu, cổng, đuôi .git và chữ hoa thường (GitHub, GitLab không phân biệt). URL file:// và đường
// dẫn thường so theo đường dẫn tuyệt đối đã làm sạch.
func SameRepo(a, b string) bool {
	ka, kb := repoKey(a), repoKey(b)
	return ka != "" && ka == kb
}

func repoKey(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		// Dạng scp của ssh: [user@]host:đường/dẫn. "C:\..." của Windows là đường dẫn, không phải máy chủ một chữ.
		if i := strings.Index(s, ":"); i > 1 && !strings.ContainsAny(s[:i], `/\`) {
			host := s[:i]
			if at := strings.LastIndex(host, "@"); at >= 0 {
				host = host[at+1:]
			}
			return hostPath(host, s[i+1:])
		}
		return "file:" + cleanPath(s)
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	if u.Scheme == "file" {
		p := u.Path
		// file:///C:/x của Windows có Path "/C:/x".
		if runtime.GOOS == "windows" && len(p) > 2 && p[0] == '/' && p[2] == ':' {
			p = p[1:]
		}
		return "file:" + cleanPath(filepath.FromSlash(p))
	}
	if u.Hostname() == "" {
		return ""
	}
	return hostPath(u.Hostname(), u.Path)
}

func hostPath(host, path string) string {
	path = strings.Trim(strings.ReplaceAll(path, `\`, "/"), "/")
	path = strings.TrimSuffix(path, ".git")
	if host == "" || path == "" {
		return ""
	}
	return strings.ToLower(host) + "/" + strings.ToLower(path)
}

// cleanPath là đường dẫn tuyệt đối đã làm sạch và đi qua symlink nếu có (thư mục tạm của macOS là /private/var qua
// /var); Windows không phân biệt hoa thường.
func cleanPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	if abs, err := filepath.Abs(p); err == nil {
		p = abs
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	}
	p = filepath.Clean(p)
	if runtime.GOOS == "windows" {
		p = strings.ToLower(p)
	}
	return p
}

// Redact bỏ tên đăng nhập và mật khẩu khỏi URL https (token hay nằm ở đó) trước khi in ra log hay giao diện.
func Redact(raw string) string {
	if !strings.Contains(raw, "://") {
		return raw
	}
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.User == nil {
		return raw
	}
	if _, has := u.User.Password(); !has && u.Scheme == "ssh" {
		return raw
	}
	u.User = nil
	return u.String()
}
