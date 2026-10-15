// Package gitgroups clone, fetch và pull mọi repo của một group GitLab (gồm subgroup) hay một org GitHub vào thư mục
// gốc trên máy, theo đường dẫn của repo trên máy chủ (specs/016-desktop-git-groups).
//
// Cấu hình nằm ở gitgroups.json cạnh worker.json, do app desktop ghi qua `hive-worker gitgroups`. File không bao giờ
// chứa token: app chỉ đưa credential cho API qua môi trường của lần chạy đó; Git dùng helper của máy hoặc askpass.
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

// Host chỉ lưu cách xác thực để token của helper được đọc lại sau mỗi lần xoay vòng.
type Host struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	// URL là địa chỉ web của máy chủ (https://gitlab.com, https://git.acme.vn), không có đường dẫn API.
	URL  string `json:"url"`
	Name string `json:"name"`
	// Username là tài khoản của token, đọc từ API lúc thêm; chỉ để hiển thị.
	Username string `json:"username,omitempty"`
	// AuthMode rỗng giữ tương thích với kết nối token đã lưu trước đây.
	AuthMode string `json:"authMode,omitempty"`
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

// AddHost thêm kết nối; đã có kết nối cùng loại, cùng máy chủ và cùng tài khoản thì cập nhật tên của kết nối đó (token
// mới ghi đè token cũ trong keychain theo id).
func (c *Config) AddHost(h Host) Host {
	for i, cur := range c.Hosts {
		if cur.Kind == h.Kind && strings.EqualFold(cur.URL, h.URL) && strings.EqualFold(cur.Username, h.Username) {
			c.Hosts[i].Name = h.Name
			c.Hosts[i].AuthMode = h.AuthMode
			return c.Hosts[i]
		}
	}
	h.ID = newID()
	c.Hosts = append(c.Hosts, h)
	return h
}

// RemoveHost xoá kết nối; còn nhóm dùng thì từ chối và nêu tên nhóm.
func (c *Config) RemoveHost(id string) error {
	var used []string
	for _, g := range c.Groups {
		if g.HostID == id {
			used = append(used, g.Path)
		}
	}
	if len(used) > 0 {
		return fmt.Errorf("kết nối đang được nhóm %s dùng; xoá nhóm trước", strings.Join(used, ", "))
	}
	for i, h := range c.Hosts {
		if h.ID == id {
			c.Hosts = append(c.Hosts[:i], c.Hosts[i+1:]...)
			return nil
		}
	}
	return errors.New("không có kết nối này")
}

// AddGroup thêm nhóm; cùng kết nối, cùng group và cùng thư mục gốc thì từ chối vì sẽ clone trùng.
func (c *Config) AddGroup(g Group) (Group, error) {
	for _, cur := range c.Groups {
		if cur.HostID == g.HostID && strings.EqualFold(cur.Path, g.Path) && strings.EqualFold(filepath.Clean(cur.Root), filepath.Clean(g.Root)) {
			return g, fmt.Errorf("đã theo dõi group %s vào %s", g.Path, g.Root)
		}
	}
	g.ID = newID()
	if g.Repos == nil {
		g.Repos = []Repo{}
	}
	c.Groups = append(c.Groups, g)
	return g, nil
}

// RemoveGroup bỏ theo dõi; thư mục đã clone và mục trong Dự án trên máy giữ nguyên.
func (c *Config) RemoveGroup(id string) error {
	for i, g := range c.Groups {
		if g.ID == id {
			c.Groups = append(c.Groups[:i], c.Groups[i+1:]...)
			return nil
		}
	}
	return errors.New("không có nhóm này")
}

// maxAutoFetch: tự fetch thưa hơn một ngày thì không còn là "định kỳ" nữa.
const maxAutoFetch = 24 * 60

// Check kiểm nhóm trước khi lưu và điền cách clone mặc định.
func (g *Group) Check() error {
	g.Root = strings.TrimSpace(g.Root)
	if g.Root == "" || !filepath.IsAbs(g.Root) {
		return fmt.Errorf("thư mục gốc %q phải là đường dẫn tuyệt đối", g.Root)
	}
	g.Root = filepath.Clean(g.Root)
	switch g.Protocol {
	case "":
		g.Protocol = ProtocolHTTPS
	case ProtocolHTTPS, ProtocolSSH:
	default:
		return fmt.Errorf("cách clone %q không hỗ trợ (https hoặc ssh)", g.Protocol)
	}
	g.Filter = strings.TrimSpace(g.Filter)
	if g.Filter != "" {
		if len(g.Filter) > 500 {
			return errors.New("bộ lọc quá dài")
		}
		if _, err := regexp.Compile(g.Filter); err != nil {
			return fmt.Errorf("bộ lọc %q không phải regex hợp lệ", g.Filter)
		}
	}
	if g.AutoFetchMinutes < 0 || (g.AutoFetchMinutes > 0 && g.AutoFetchMinutes < 5) || g.AutoFetchMinutes > maxAutoFetch {
		return fmt.Errorf("tự fetch mỗi 5 tới %d phút, hoặc 0 để tắt", maxAutoFetch)
	}
	if len(g.Excluded) > 10000 {
		return errors.New("danh sách bỏ chọn quá dài")
	}
	return nil
}
