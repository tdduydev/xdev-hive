package secretstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const (
	CatalogVersion    = 1
	MaxPerProject     = 64
	MaxDescriptionLen = 500
	catalogFile       = "secrets.json"
)

// Mã lỗi thêm ngoài bảng của contracts/sidecar-cli.md: desktop chưa biết mã thì vẫn hiện message.
const (
	CodeInvalidDescription = "invalid_description"
	CodeCatalogNewer       = "catalog_newer"
)

var ErrCatalogNewer = &Error{Code: CodeCatalogNewer}

// Secret là một mục của secrets.json. Không có trường nào suy ra được giá trị: không giá trị, không băm, không độ dài
// (FR-002), để file danh mục lộ ra cũng không giúp đoán bí mật.
type Secret struct {
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	CreatedAt      time.Time `json:"createdAt"`
	ValueChangedAt time.Time `json:"valueChangedAt"`
	Projects       []string  `json:"projects"`
}

type Catalog struct {
	Version int      `json:"version"`
	Secrets []Secret `json:"secrets"`
}

// CatalogPath đặt secrets.json cạnh projects.json, trong thư mục cấu hình worker.
func CatalogPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), catalogFile)
}

// LoadCatalog đọc danh mục; chưa có file là danh mục rỗng. File của bản mới hơn vẫn đọc được để liệt kê và cấp, chỉ
// không được ghi (ModifyCatalog).
func LoadCatalog(path string) (Catalog, error) {
	c := Catalog{Version: CatalogVersion}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("đọc %s: %w", path, err)
	}
	return c, nil
}

// ModifyCatalog đọc, sửa rồi ghi danh mục trong lúc giữ khoá, như projects.json: app và lệnh terminal có thể sửa cùng
// lúc. change trả lỗi thì file giữ nguyên.
func ModifyCatalog(path string, change func(*Catalog) error) error {
	return projects.WithLock(path, func() error {
		c, err := LoadCatalog(path)
		if err != nil {
			return err
		}
		// Bản cũ ghi đè file của bản mới sẽ làm mất trường nó không biết.
		if c.Version > CatalogVersion {
			return &Error{Code: CodeCatalogNewer, Message: "Danh mục bí mật do bản mới hơn tạo. Hãy cập nhật xDev Hive để sửa."}
		}
		if err := change(&c); err != nil {
			return err
		}
		c.Version = CatalogVersion
		if c.Secrets == nil {
			c.Secrets = []Secret{}
		}
		for i := range c.Secrets {
			if c.Secrets[i].Projects == nil {
				c.Secrets[i].Projects = []string{}
			}
		}
		return projects.WriteJSON(path, c)
	})
}

// DropProject gỡ localId khỏi mọi bí mật khi dự án bị gỡ khỏi projects.json (FR-063). Không đụng kho: bí mật vẫn còn
// để gán cho dự án khác.
func DropProject(path, localID string) error {
	if localID == "" {
		return nil
	}
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return ModifyCatalog(path, func(c *Catalog) error {
		c.DropProject(localID)
		return nil
	})
}

// Find trả con trỏ vào mục để sửa tại chỗ; nil khi không có.
func (c *Catalog) Find(name string) *Secret {
	for i := range c.Secrets {
		if c.Secrets[i].Name == name {
			return &c.Secrets[i]
		}
	}
	return nil
}

func (c *Catalog) get(name string) (*Secret, error) {
	if s := c.Find(name); s != nil {
		return s, nil
	}
	return nil, notFound(name)
}

// Add thêm mục mới. Giá trị ghi vào kho do bên gọi làm trước, để danh mục không bao giờ có tên mà kho chưa có.
func (c *Catalog) Add(name, description string, now time.Time) (*Secret, error) {
	if err := ValidName(name); err != nil {
		return nil, err
	}
	if c.Find(name) != nil {
		return nil, duplicate(name)
	}
	if err := ValidDescription(description); err != nil {
		return nil, err
	}
	now = stamp(now)
	c.Secrets = append(c.Secrets, Secret{Name: name, Description: description, CreatedAt: now, ValueChangedAt: now, Projects: []string{}})
	c.sort()
	return c.Find(name), nil
}

// ValueChanged ghi thời điểm đặt giá trị mới; desktop dùng để nhắc thay khoá cũ.
func (c *Catalog) ValueChanged(name string, now time.Time) (*Secret, error) {
	s, err := c.get(name)
	if err != nil {
		return nil, err
	}
	s.ValueChangedAt = stamp(now)
	return s, nil
}

func (c *Catalog) Rename(from, to string) (*Secret, error) {
	if err := ValidName(to); err != nil {
		return nil, err
	}
	s, err := c.get(from)
	if err != nil {
		return nil, err
	}
	if from == to {
		return s, nil
	}
	if c.Find(to) != nil {
		return nil, duplicate(to)
	}
	s.Name = to
	c.sort()
	return c.Find(to), nil
}

func (c *Catalog) Describe(name, description string) (*Secret, error) {
	s, err := c.get(name)
	if err != nil {
		return nil, err
	}
	if err := ValidDescription(description); err != nil {
		return nil, err
	}
	s.Description = description
	return s, nil
}

// Assign gán bí mật cho dự án. Gán lại là không làm gì, để desktop bấm hai lần không báo lỗi.
func (c *Catalog) Assign(name, localID string) (*Secret, error) {
	s, err := c.get(name)
	if err != nil {
		return nil, err
	}
	if slices.Contains(s.Projects, localID) {
		return s, nil
	}
	if len(c.ForProject(localID)) >= MaxPerProject {
		return nil, &Error{Code: CodeTooMany, Message: fmt.Sprintf("Dự án đã có %d bí mật.", MaxPerProject), Names: []string{name}}
	}
	s.Projects = append(s.Projects, localID)
	return s, nil
}

func (c *Catalog) Unassign(name, localID string) (*Secret, error) {
	s, err := c.get(name)
	if err != nil {
		return nil, err
	}
	s.Projects = slices.DeleteFunc(s.Projects, func(id string) bool { return id == localID })
	return s, nil
}

// Remove gỡ mục khỏi danh mục. Bên gọi xoá trong kho trước (data-model §1): dừng giữa chừng thì còn mục danh mục báo
// thiếu giá trị, không còn giá trị mồ côi không ai thấy.
func (c *Catalog) Remove(name string) error {
	n := len(c.Secrets)
	c.Secrets = slices.DeleteFunc(c.Secrets, func(s Secret) bool { return s.Name == name })
	if len(c.Secrets) == n {
		return notFound(name)
	}
	return nil
}

// ForProject trả các bí mật gán cho localId, theo thứ tự tên.
func (c *Catalog) ForProject(localID string) []Secret {
	var out []Secret
	for _, s := range c.Secrets {
		if slices.Contains(s.Projects, localID) {
			out = append(out, s)
		}
	}
	return out
}

func (c *Catalog) DropProject(localID string) {
	for i := range c.Secrets {
		c.Secrets[i].Projects = slices.DeleteFunc(c.Secrets[i].Projects, func(id string) bool { return id == localID })
	}
}

// RetainProjects bỏ khi đọc các localId không còn trong projects.json (data-model §2), ví dụ dự án bị gỡ bằng bản worker
// cũ không gọi DropProject.
func (c *Catalog) RetainProjects(live func(localID string) bool) {
	for i := range c.Secrets {
		c.Secrets[i].Projects = slices.DeleteFunc(c.Secrets[i].Projects, func(id string) bool { return !live(id) })
	}
}

func (c *Catalog) sort() {
	slices.SortFunc(c.Secrets, func(a, b Secret) int { return strings.Compare(a.Name, b.Name) })
}

// ValidDescription: mô tả nằm trong file thường và hiện trên UI, nên không được chứa thứ trông như bí mật (FR-021).
func ValidDescription(d string) error {
	if !utf8.ValidString(d) || utf8.RuneCountInString(d) > MaxDescriptionLen {
		return &Error{Code: CodeInvalidDescription, Message: fmt.Sprintf("Mô tả tối đa %d ký tự.", MaxDescriptionLen)}
	}
	if looksSecret(d) {
		return &Error{Code: CodeDescriptionSecret, Message: "Mô tả có chuỗi giống bí mật. Hãy bỏ chuỗi đó trước khi lưu."}
	}
	return nil
}

func duplicate(name string) *Error {
	return &Error{Code: CodeDuplicateName, Message: fmt.Sprintf("Đã có bí mật tên `%s`.", name), Names: []string{name}}
}

// stamp giữ thời điểm ở UTC, tới giây, như mẫu trong data-model.
func stamp(t time.Time) time.Time { return t.UTC().Truncate(time.Second) }
