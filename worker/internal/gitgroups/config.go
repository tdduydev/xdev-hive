// Package gitgroups clone, fetch và pull mọi repo của một group GitLab (gồm subgroup) hay một org GitHub vào thư mục
// gốc trên máy, theo đường dẫn của repo trên máy chủ (specs/016-desktop-git-groups).
//
// Cấu hình nằm ở gitgroups.json cạnh worker.json, do app desktop ghi qua `hive-worker gitgroups`. File không bao giờ
// chứa token: app giữ token trong keychain và chỉ đưa cho sidecar qua biến môi trường của lần chạy đó.
package gitgroups

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const (
	KindGitLab = "gitlab"
	KindGitHub = "github"

	ProtocolHTTPS = "https"
	ProtocolSSH   = "ssh"
)

// Host là một máy chủ Git người dùng kết nối bằng token cá nhân.
type Host struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// URL là địa chỉ web của máy chủ (https://gitlab.com, https://git.acme.vn), không có đường dẫn API.
	URL  string `json:"url"`
	Name string `json:"name"`
	// Username là tài khoản của token, đọc từ API lúc thêm; chỉ để hiển thị.
	Username string `json:"username,omitempty"`
}

// Repo là một repo của group như API trả về lần đọc gần nhất.
type Repo struct {
	// Path là đường dẫn đầy đủ trên máy chủ (acme/payments/api), cũng là đường dẫn dưới thư mục gốc.
	Path          string `json:"path"`
	Name          string `json:"name"`
	DefaultBranch string `json:"defaultBranch,omitempty"`
	Archived      bool   `json:"archived,omitempty"`
	Empty         bool   `json:"empty,omitempty"`
	HTTPURL       string `json:"httpUrl"`
	SSHURL        string `json:"sshUrl,omitempty"`
	WebURL        string `json:"webUrl,omitempty"`
}

// Group là một nhóm theo dõi: group GitLab hoặc org/tài khoản GitHub, clone vào Root.
type Group struct {
	ID       string `json:"id"`
	HostID   string `json:"hostId"`
	Path     string `json:"path"`
	Root     string `json:"root"`
	Protocol string `json:"protocol"`
	// Filter là regex trên đường dẫn đầy đủ của repo; rỗng là mọi repo.
	Filter          string `json:"filter,omitempty"`
	IncludeArchived bool   `json:"includeArchived,omitempty"`
	// Excluded là repo người dùng bỏ chọn. Lưu phần bỏ thay vì phần chọn để repo mới của group tự được chọn.
	Excluded         []string `json:"excluded,omitempty"`
	AutoFetchMinutes int      `json:"autoFetchMinutes,omitempty"`
	LastAutoFetchAt  string   `json:"lastAutoFetchAt,omitempty"`
	ListedAt         string   `json:"listedAt,omitempty"`
	Repos            []Repo   `json:"repos"`
}

// Config là nội dung gitgroups.json.
type Config struct {
	Hosts  []Host  `json:"hosts"`
	Groups []Group `json:"groups"`
}

// DefaultPath là gitgroups.json cạnh file cấu hình worker.
func DefaultPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), "gitgroups.json")
}

// Load đọc cấu hình; file không có thì trả rỗng.
func Load(path string) (Config, error) {
	var c Config
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{Hosts: []Host{}, Groups: []Group{}}, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("đọc %s: %w", path, err)
	}
	if c.Hosts == nil {
		c.Hosts = []Host{}
	}
	if c.Groups == nil {
		c.Groups = []Group{}
	}
	return c, nil
}

// Modify đọc, sửa rồi ghi cấu hình trong lúc giữ khoá, để lệnh của app và lượt tự fetch không ghi đè nhau.
func Modify(path string, change func(*Config) error) error {
	return projects.WithLock(path, func() error {
		c, err := Load(path)
		if err != nil {
			return err
		}
		if err := change(&c); err != nil {
			return err
		}
		return projects.WriteJSON(path, c)
	})
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (c *Config) Host(id string) *Host {
	for i := range c.Hosts {
		if c.Hosts[i].ID == id {
			return &c.Hosts[i]
		}
	}
	return nil
}

func (c *Config) Group(id string) *Group {
	for i := range c.Groups {
		if c.Groups[i].ID == id {
			return &c.Groups[i]
		}
	}
	return nil
}

// NormalizeHost kiểm loại và URL; URL rỗng là gitlab.com hay github.com.
func NormalizeHost(kind, raw, name string) (Host, error) {
	h := Host{Kind: kind, Name: strings.TrimSpace(name)}
	raw = strings.TrimSpace(raw)
	switch kind {
	case KindGitLab:
		if raw == "" {
			raw = "https://gitlab.com"
		}
	case KindGitHub:
		if raw == "" {
			raw = "https://github.com"
		}
	default:
		return h, fmt.Errorf("loại máy chủ %q không hỗ trợ (gitlab hoặc github)", kind)
	}
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" {
		return h, fmt.Errorf("địa chỉ máy chủ %q không hợp lệ", raw)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return h, errors.New("địa chỉ máy chủ không được chứa tên đăng nhập, token hay tham số")
	}
	h.URL = strings.TrimRight(u.Scheme+"://"+u.Host+u.EscapedPath(), "/")
	if h.Name == "" {
		h.Name = u.Host
	}
	if len(h.Name) > 100 {
		return h, errors.New("tên kết nối quá dài")
	}
	return h, nil
}

// groupPath: GitLab cho chữ, số, `_`, `-`, `.` trong từng đoạn; GitHub chỉ một đoạn (tên org hay tài khoản).
var groupSegment = regexp.MustCompile(`^[A-Za-z0-9_.][A-Za-z0-9_.-]*$`)

// NormalizeGroupPath kiểm đường dẫn group người dùng gõ (bỏ / đầu cuối, chấp nhận dán cả URL của group).
func NormalizeGroupPath(h Host, raw string) (string, error) {
	p := strings.TrimSpace(raw)
	if base := h.URL + "/"; strings.HasPrefix(strings.ToLower(p), strings.ToLower(base)) {
		p = p[len(base):]
	}
	p = strings.Trim(p, "/")
	if p == "" {
		return "", errors.New("thiếu đường dẫn group")
	}
	segs := strings.Split(p, "/")
	if h.Kind == KindGitHub && len(segs) != 1 {
		return "", fmt.Errorf("GitHub chỉ theo dõi được cả org hay tài khoản, không phải %q", p)
	}
	for _, s := range segs {
		if !groupSegment.MatchString(s) || s == "." || s == ".." {
			return "", fmt.Errorf("đường dẫn group %q không hợp lệ", p)
		}
	}
	return p, nil
}

// Selected là repo của nhóm sẽ được clone, fetch, pull: bỏ archived (trừ khi bật), lọc regex, bỏ repo đã bỏ chọn.
func Selected(g Group) ([]Repo, error) {
	var re *regexp.Regexp
	if g.Filter != "" {
		var err error
		if re, err = regexp.Compile(g.Filter); err != nil {
			return nil, fmt.Errorf("bộ lọc %q không phải regex hợp lệ: %w", g.Filter, err)
		}
	}
	excluded := map[string]bool{}
	for _, p := range g.Excluded {
		excluded[strings.ToLower(p)] = true
	}
	out := []Repo{}
	for _, r := range g.Repos {
		if (r.Archived && !g.IncludeArchived) || excluded[strings.ToLower(r.Path)] || (re != nil && !re.MatchString(r.Path)) {
			continue
		}
		out = append(out, r)
	}
	return out, nil
}

// CloneURL là URL clone theo cách nhóm chọn; nhóm SSH mà repo không có URL SSH thì dùng HTTPS.
func CloneURL(g Group, r Repo) string {
	if g.Protocol == ProtocolSSH && r.SSHURL != "" {
		return r.SSHURL
	}
	return r.HTTPURL
}

// Due cho biết nhóm đến lượt tự fetch chưa.
func Due(g Group, now time.Time) bool {
	if g.AutoFetchMinutes <= 0 {
		return false
	}
	last, err := time.Parse(time.RFC3339, g.LastAutoFetchAt)
	return err != nil || now.Sub(last) >= time.Duration(g.AutoFetchMinutes)*time.Minute
}
