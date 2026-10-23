// Package projects giữ danh sách dự án của hub đã gắn với thư mục repo trên máy (ADR 0020).
//
// Danh sách nằm ở projects.json cạnh worker.json, do app desktop ghi qua `hive-worker projects`. Run của dự án đã gắn
// tạo worktree từ repo đó thay vì repo cache bare, và chỉ chạy toàn quyền khi máy bật cho dự án đó và tổ chức cho
// phép. Mục có projectId rỗng là repo trên máy chưa có dự án trên hub (nhập từ app v1); run không bao giờ dùng mục đó.
package projects

import (
	"crypto/rand"
	"encoding/hex"
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
	// LocalID là id của mục trên máy này, không đổi khi gắn dự án hay dời thư mục; bí mật tại máy gán theo nó (specs/031
	// FR-010) vì repo chưa gắn dự án không có ProjectID.
	LocalID string `json:"localId"`
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

// Load đọc danh sách; file không có thì trả rỗng, không lỗi. Dòng do bản cũ ghi chưa có LocalID thì được sinh và ghi lại
// một lần, trong khoá, để hai tiến trình đọc cùng lúc không sinh hai id khác nhau cho một dòng. Không ghi được thì trả
// LocalID rỗng chứ không trả id mới mỗi lần đọc: bí mật gán theo id đó sẽ mất ở lần đọc sau.
func Load(path string) ([]Project, error) {
	f, err := read(path)
	if err != nil || !missingLocalID(f.Projects) {
		return f.Projects, err
	}
	var filled *file
	if modify(path, func(nf *file) error { filled = nf; return nil }) != nil || filled == nil {
		return f.Projects, nil
	}
	return filled.Projects, nil
}

// FindLocal là mục có localID; nil khi không có (hoặc id rỗng).
func FindLocal(list []Project, localID string) *Project {
	if localID == "" {
		return nil
	}
	for i := range list {
		if list[i].LocalID == localID {
			return &list[i]
		}
	}
	return nil
}

// FindFolder là mục có thư mục chứa dir (dir là thư mục đó hay thư mục con). Repo lồng nhau thì lấy mục sâu nhất, như
// cách cmd/hive chọn dự án theo thư mục đang đứng.
func FindFolder(list []Project, dir string) *Project {
	dir = cleanPath(dir)
	if dir == "" {
		return nil
	}
	var found *Project
	longest := -1
	for i := range list {
		folder := cleanPath(list[i].Folder)
		if folder == "" {
			continue
		}
		rel, err := filepath.Rel(folder, dir)
		if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
			continue
		}
		if len(folder) > longest {
			found, longest = &list[i], len(folder)
		}
	}
	return found
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
		// Gắn dự án cho repo chưa gắn giữ LocalID của repo đó, để bí mật đã gán cho repo vẫn theo nó.
		localID, unlinkedID := "", ""
		for _, p := range f.Projects {
			switch {
			case strings.EqualFold(p.ProjectID, projectID):
				full = p.FullPermission
				localID = p.LocalID
			case p.ProjectID == "" && samePath(p.Folder, root):
				if unlinkedID == "" {
					unlinkedID = p.LocalID
				}
			default:
				kept = append(kept, p)
			}
		}
		if localID == "" {
			localID = unlinkedID
		}
		if localID == "" {
			localID = newLocalID()
		}
		f.Projects = append(kept, Project{LocalID: localID, ProjectID: projectID, Name: name, Folder: root, FullPermission: full})
		return nil
	})
}

// Unbind bỏ gắn dự án và trả LocalID của mục đã gỡ, để bên gọi gỡ bí mật đã gán (secretstore.DropProject).
func Unbind(path, projectID string) (string, error) {
	var localID string
	err := modify(path, func(f *file) error {
		for i, p := range f.Projects {
			if p.ProjectID != "" && strings.EqualFold(p.ProjectID, projectID) {
				localID = p.LocalID
				f.Projects = append(f.Projects[:i], f.Projects[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("máy chưa gắn dự án %q", projectID)
	})
	return localID, err
}

// UnbindFolder bỏ repo chưa gắn dự án (mục nhập từ app v1) theo thư mục và trả LocalID của mục đã gỡ.
func UnbindFolder(path, folder string) (string, error) {
	var localID string
	err := modify(path, func(f *file) error {
		for i, p := range f.Projects {
			if p.ProjectID == "" && samePath(p.Folder, folder) {
				localID = p.LocalID
				f.Projects = append(f.Projects[:i], f.Projects[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("không có repo chưa gắn ở %s", folder)
	})
	return localID, err
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
			f.Projects = append(f.Projects, Project{LocalID: newLocalID(), Name: name, Folder: folder})
			n++
		}
		return nil
	})
	return n, err
}

// AddFolder thêm repo chưa gắn dự án (repo app vừa clone theo nhóm Git). Thư mục đã có trong danh sách, kể cả đã gắn
// dự án, thì không làm gì và trả false.
func AddFolder(path, folder, name string) (bool, error) {
	if abs, err := filepath.Abs(strings.TrimSpace(folder)); err == nil {
		folder = abs
	}
	if name = strings.TrimSpace(name); name == "" {
		name = filepath.Base(folder)
	}
	added := false
	err := modify(path, func(f *file) error {
		if containsFolder(f.Projects, folder) {
			return nil
		}
		f.Projects = append(f.Projects, Project{LocalID: newLocalID(), Name: name, Folder: folder})
		added = true
		return nil
	})
	return added, err
}

// WithLock và WriteJSON cho file JSON khác nằm cạnh projects.json (gitgroups.json) dùng cùng cách khoá và ghi.
func WithLock(path string, fn func() error) error { return withLock(path, fn) }

func WriteJSON(path string, v any) error { return writeJSON(path, v) }

// newLocalID: 16 hex ngẫu nhiên. Không suy từ thư mục hay ProjectID, vì cả hai đổi được mà gán bí mật phải giữ nguyên.
func newLocalID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func missingLocalID(list []Project) bool {
	for _, p := range list {
		if p.LocalID == "" {
			return true
		}
	}
	return false
}

// fillLocalIDs sinh LocalID cho dòng thiếu (do bản cũ ghi, hay sửa tay), và cho dòng trùng id của dòng trước: hai mục
// chung một id thì bí mật gán cho mục này lộ sang mục kia.
func fillLocalIDs(list []Project) {
	seen := map[string]bool{}
	for i := range list {
		if list[i].LocalID == "" || seen[list[i].LocalID] {
			list[i].LocalID = newLocalID()
		}
		seen[list[i].LocalID] = true
	}
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
