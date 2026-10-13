// Package projects giữ danh sách dự án của hub đã gắn với thư mục repo trên máy (ADR 0020).
//
// Danh sách nằm ở projects.json cạnh worker.json, do app desktop ghi qua `hive-worker projects`. Run của dự án đã gắn
// tạo worktree từ repo đó thay vì repo cache bare, và chỉ chạy toàn quyền khi máy bật cho dự án đó và tổ chức cho
// phép. Mục có projectId rỗng là repo trên máy chưa có dự án trên hub (nhập từ app v1); run không bao giờ dùng mục đó.
package projects

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Project là một dự án của hub gắn với một thư mục repo trên máy.
type Project struct {
	// ProjectID là id dự án trên hub; rỗng là repo chưa gắn dự án nào.
	ProjectID string `json:"projectId"`
	Name      string `json:"name"`
	Folder    string `json:"folder"`
	// FullPermission: máy cho CLI toàn quyền (không sandbox, không hỏi duyệt) khi chạy run của dự án này.
	FullPermission bool `json:"fullPermission"`
}

type file struct {
	Projects []Project `json:"projects"`
}

// DefaultPath là projects.json cạnh file cấu hình worker.
func DefaultPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), "projects.json")
}

// LegacyPath là file cấu hình của app v1, nơi có projects[] {name, repo}.
func LegacyPath(home string) string { return filepath.Join(home, ".xdev-hive", "config.json") }

// Load đọc danh sách; file không có thì trả rỗng, không lỗi.
func Load(path string) ([]Project, error) {
	f, err := read(path)
	return f.Projects, err
}

// Find là mục đã gắn của dự án; nil khi máy chưa gắn dự án này (hoặc id rỗng).
func Find(list []Project, projectID string) *Project {
	if projectID == "" {
		return nil
	}
	for i := range list {
		if list[i].ProjectID == projectID {
			return &list[i]
		}
	}
	return nil
}

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// MaxReported là số id tối đa mỗi danh sách gửi hub, khớp giới hạn của hợp đồng giao thức.
const MaxReported = 256

// Report là id dự án đã gắn và id dự án máy cho toàn quyền, để báo hub trong hello và heartbeat. Chỉ gửi id dạng UUID:
// hub kiểm gói bằng zod và đóng kết nối khi gặp gói sai, nên một dòng sửa tay hỏng trong file không được làm rớt máy.
func Report(list []Project) (bound, full []string) {
	bound, full = []string{}, []string{}
	for _, p := range list {
		if !uuidPattern.MatchString(p.ProjectID) || len(bound) >= MaxReported {
			continue
		}
		id := strings.ToLower(p.ProjectID)
		bound = append(bound, id)
		if p.FullPermission {
			full = append(full, id)
		}
	}
	return bound, full
}

// Effective là quyền CLI thực dùng cho run code: máy đã gắn dự án thì toàn quyền khi và chỉ khi máy bật cho dự án đó
// và tổ chức cho phép; chưa gắn (máy dùng chung của đội) thì theo quyền hub gửi như trước.
func Effective(p *Project, hubMode string, fullAllowed bool) string {
	if p == nil {
		return hubMode
	}
	if p.FullPermission && fullAllowed {
		return "full"
	}
	return "workspace"
}

// Bind gắn dự án với thư mục (gốc work tree chứa nó). Mục chưa gắn cùng thư mục được thay bằng mục này; dự án đã gắn
// thư mục khác thì đổi thư mục và giữ công tắc toàn quyền. repoURL khác rỗng thì từ chối khi origin không khớp.
func Bind(path, projectID, folder, name, repoURL string) error {
	if projectID == "" {
		return errors.New("thiếu id dự án")
	}
	if !uuidPattern.MatchString(projectID) {
		return fmt.Errorf("id dự án %q không hợp lệ", projectID)
	}
	root, err := Toplevel(folder)
	if err != nil {
		return err
	}
	if repoURL != "" {
		origin, err := Origin(root)
		if err != nil {
			return err
		}
		if !SameRepo(origin, repoURL) {
			return fmt.Errorf("remote origin của %s là %s, không khớp repo của dự án %s", root, Redact(origin), Redact(repoURL))
		}
	}
	if name == "" {
		name = filepath.Base(root)
	}
	projectID = strings.ToLower(projectID)
	return modify(path, func(f *file) error {
		kept := f.Projects[:0]
		full := false
		for _, p := range f.Projects {
			switch {
			case strings.EqualFold(p.ProjectID, projectID):
				full = p.FullPermission
			case p.ProjectID == "" && samePath(p.Folder, root):
			default:
				kept = append(kept, p)
			}
		}
		f.Projects = append(kept, Project{ProjectID: projectID, Name: name, Folder: root, FullPermission: full})
		return nil
	})
}

// Unbind bỏ gắn dự án.
func Unbind(path, projectID string) error {
	return modify(path, func(f *file) error {
		for i, p := range f.Projects {
			if p.ProjectID != "" && strings.EqualFold(p.ProjectID, projectID) {
				f.Projects = append(f.Projects[:i], f.Projects[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("máy chưa gắn dự án %q", projectID)
	})
}

// UnbindFolder bỏ repo chưa gắn dự án (mục nhập từ app v1) theo thư mục.
func UnbindFolder(path, folder string) error {
	return modify(path, func(f *file) error {
		for i, p := range f.Projects {
			if p.ProjectID == "" && samePath(p.Folder, folder) {
				f.Projects = append(f.Projects[:i], f.Projects[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("không có repo chưa gắn ở %s", folder)
	})
}

// SetFull bật hoặc tắt toàn quyền của dự án đã gắn trên máy này.
func SetFull(path, projectID string, full bool) error {
	return modify(path, func(f *file) error {
		p := Find(f.Projects, strings.ToLower(projectID))
		if p == nil {
			return fmt.Errorf("máy chưa gắn dự án %q; gắn thư mục repo trước", projectID)
		}
		p.FullPermission = full
		return nil
	})
}

// Toplevel là gốc work tree chứa folder, đã làm sạch; lỗi tiếng Việt khi thư mục không có hay không phải repo git.
func Toplevel(folder string) (string, error) {
	folder = strings.TrimSpace(folder)
	if folder == "" {
		return "", errors.New("thiếu thư mục repo")
	}
	abs, err := filepath.Abs(folder)
	if err != nil {
		return "", err
	}
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return "", fmt.Errorf("không tìm thấy thư mục %s", abs)
	}
	if inside, _ := git(abs, "rev-parse", "--is-inside-work-tree"); inside != "true" {
		return "", fmt.Errorf("thư mục %s không phải repo git (không có work tree)", abs)
	}
	top, err := git(abs, "rev-parse", "--show-toplevel")
	if err != nil || top == "" {
		return "", fmt.Errorf("không đọc được gốc repo của %s", abs)
	}
	return filepath.Clean(filepath.FromSlash(top)), nil
}

// Origin là URL của remote origin; lỗi khi repo không có origin.
func Origin(folder string) (string, error) {
	url, err := git(folder, "remote", "get-url", "origin")
	if err != nil || url == "" {
		return "", fmt.Errorf("repo %s không có remote origin", folder)
	}
	return url, nil
}

// legacyConfig là phần cần đọc trong ~/.xdev-hive/config.json của app v1.
type legacyConfig struct {
	Projects []struct {
		Name string `json:"name"`
		Repo string `json:"repo"`
	} `json:"projects"`
}

// ImportLegacy chép projects[] của app v1 thành mục chưa gắn dự án, một lần: projects.json đã có thì không làm gì (trả
// 0) trừ khi force. Vẫn ghi file (có thể rỗng) để lần sau không nhập lại. App ghép từng repo với dự án hub sau đó.
func ImportLegacy(legacy, dst string, force bool) (int, error) {
	if !force {
		if _, err := os.Stat(dst); err == nil {
			return 0, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	var c legacyConfig
	b, err := os.ReadFile(legacy)
	switch {
	case errors.Is(err, os.ErrNotExist):
	case err != nil:
		return 0, err
	default:
		if err := jsonUnmarshal(b, &c); err != nil {
			return 0, fmt.Errorf("đọc %s: %w", legacy, err)
		}
	}
	n := 0
	err = modify(dst, func(f *file) error {
		for _, p := range c.Projects {
			folder := strings.TrimSpace(p.Repo)
			if folder == "" {
				continue
			}
			if abs, err := filepath.Abs(folder); err == nil {
				folder = abs
			}
			if containsFolder(f.Projects, folder) {
				continue
			}
			name := strings.TrimSpace(p.Name)
			if name == "" {
				name = filepath.Base(folder)
			}
			f.Projects = append(f.Projects, Project{Name: name, Folder: folder})
			n++
		}
		return nil
	})
	return n, err
}

func containsFolder(list []Project, folder string) bool {
	for _, p := range list {
		if samePath(p.Folder, folder) {
			return true
		}
	}
	return false
}

func samePath(a, b string) bool {
	return cleanPath(a) == cleanPath(b)
}

// View là một mục kèm trạng thái thư mục, cho `hive-worker projects --json`.
type View struct {
	Project
	Exists bool `json:"exists"`
	IsGit  bool `json:"isGit"`
	// Origin đã bỏ tên đăng nhập và mật khẩu nếu URL có.
	Origin string `json:"origin,omitempty"`
}

// Inspect đọc trạng thái thư mục của từng mục: còn không, có phải repo git không, origin là gì.
func Inspect(list []Project) []View {
	out := make([]View, 0, len(list))
	for _, p := range list {
		v := View{Project: p}
		if st, err := os.Stat(p.Folder); err == nil && st.IsDir() {
			v.Exists = true
			inside, _ := git(p.Folder, "rev-parse", "--is-inside-work-tree")
			v.IsGit = inside == "true"
			if v.IsGit {
				if o, err := Origin(p.Folder); err == nil {
					v.Origin = Redact(o)
				}
			}
		}
		out = append(out, v)
	}
	return out
}

// staleLock: khoá cũ hơn chừng này là của tiến trình đã chết giữa lúc ghi.
const staleLock = 30 * time.Second
