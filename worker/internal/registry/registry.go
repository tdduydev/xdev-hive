// Package registry là sổ đăng ký của máy (spec 034): một máy đăng ký riêng với từng tổ chức, mỗi lượt đăng ký có
// worker.json, khoá máy và thư mục dữ liệu riêng để token, repo và worktree của tổ chức này không lẫn sang tổ chức kia.
//
// Máy cài trước spec 034 có đúng một worker.json ở chỗ cũ; nó là đăng ký `reg_legacy` và giữ nguyên mọi đường dẫn cũ,
// nên máy không có sổ chạy y như trước. Mỗi tiến trình worker chạy một đăng ký: chọn bằng `--registration`,
// HIVE_REGISTRATION, hoặc đăng ký đang chọn trong sổ.
package registry

import (
	"crypto/rand"
	"encoding/base32"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/config"
)

const (
	// LegacyID là worker.json cài trước spec 034, nằm ở đường dẫn cũ.
	LegacyID = "reg_legacy"
	// EnvRegistration chọn đăng ký cho một lệnh mà không đổi đăng ký đang chọn trong sổ (app desktop, service).
	EnvRegistration = "HIVE_REGISTRATION"
	// EnvWorkerConfig là đường dẫn worker.json đặt tay; có nó thì bỏ qua sổ (FR-082), như trước spec 034.
	EnvWorkerConfig = "HIVE_WORKER_CONFIG"
	// MaxRegistrations chặn sổ phình vô hạn khi script gọi `registrations add` lặp lại.
	MaxRegistrations = 8
)

// Registration là một lượt đăng ký của máy với một tổ chức trên một hub.
type Registration struct {
	ID      string `json:"id"`
	HubURL  string `json:"hubUrl"`
	OrgID   string `json:"orgId,omitempty"`
	OrgName string `json:"orgName,omitempty"`
	// Label là tên người dùng tự đặt để phân biệt hai tổ chức trùng tên.
	Label     string    `json:"label,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
}

// Index là nội dung registrations.json.
type Index struct {
	Active        string         `json:"active,omitempty"`
	Registrations []Registration `json:"registrations"`
}

// Find trả đăng ký theo id.
func (ix *Index) Find(id string) (*Registration, bool) {
	for i := range ix.Registrations {
		if ix.Registrations[i].ID == id {
			return &ix.Registrations[i], true
		}
	}
	return nil, false
}

// FindOrg trả đăng ký đã có cho cùng hub và tổ chức (FR-004): đăng ký lần nữa thì thay đăng ký đó, không thêm dòng.
func (ix *Index) FindOrg(hubURL, orgID string) (*Registration, bool) {
	if orgID == "" {
		return nil, false
	}
	for i := range ix.Registrations {
		r := &ix.Registrations[i]
		if r.OrgID == orgID && sameHub(r.HubURL, hubURL) {
			return r, true
		}
	}
	return nil, false
}

// Remove bỏ đăng ký khỏi sổ; bỏ đăng ký đang chọn thì không còn đăng ký nào được chọn.
func (ix *Index) Remove(id string) bool {
	n := len(ix.Registrations)
	ix.Registrations = slices.DeleteFunc(ix.Registrations, func(r Registration) bool { return r.ID == id })
	if ix.Active == id {
		ix.Active = ""
	}
	return len(ix.Registrations) != n
}

func sameHub(a, b string) bool { return strings.TrimRight(a, "/") == strings.TrimRight(b, "/") }

// Book là sổ đăng ký trên đĩa. ConfigRoot là UserConfigDir/xdev-hive (worker.json cũ nằm ở đây), CacheRoot là
// UserCacheDir/xdev-hive (repo cache, worktree của run).
type Book struct {
	ConfigRoot string
	CacheRoot  string
}

// Default là sổ theo thư mục của hệ điều hành.
func Default() (Book, error) {
	cfg, err := os.UserConfigDir()
	if err != nil {
		return Book{}, fmt.Errorf("không tìm được thư mục cấu hình: %w", err)
	}
	cache, err := os.UserCacheDir()
	if err != nil {
		return Book{}, fmt.Errorf("không tìm được thư mục cache: %w", err)
	}
	return Book{ConfigRoot: filepath.Join(cfg, "xdev-hive"), CacheRoot: filepath.Join(cache, "xdev-hive")}, nil
}

func (b Book) IndexPath() string { return filepath.Join(b.ConfigRoot, "registrations.json") }

// ConfigDir là thư mục của đăng ký: worker.json, khoá máy dạng file, projects.json, gitgroups.json, remote.json.
func (b Book) ConfigDir(id string) string {
	if id == LegacyID {
		return b.ConfigRoot
	}
	return filepath.Join(b.ConfigRoot, "orgs", id)
}

func (b Book) ConfigPath(id string) string { return filepath.Join(b.ConfigDir(id), "worker.json") }

// DataDir là repo cache, worktree và khoá repo của đăng ký. Hai tổ chức clone cùng một repo vẫn mỗi bên một bản, để
// worktree và nhánh của run tổ chức này không hiện ra ở tổ chức kia.
func (b Book) DataDir(id string) string {
	if id == LegacyID {
		return filepath.Join(b.CacheRoot, "worker")
	}
	return filepath.Join(b.CacheRoot, "orgs", id, "worker")
}

// Load đọc sổ. Chưa có sổ mà có worker.json cũ thì trả sổ chỉ có `reg_legacy` (chưa ghi ra đĩa); không có gì thì
// sổ rỗng.
func (b Book) Load() (Index, error) {
	var ix Index
	data, err := os.ReadFile(b.IndexPath())
	switch {
	case errors.Is(err, os.ErrNotExist):
		return b.legacyIndex()
	case err != nil:
		return ix, fmt.Errorf("đọc sổ đăng ký %s: %w", b.IndexPath(), err)
	}
	if err := json.Unmarshal(data, &ix); err != nil {
		return ix, fmt.Errorf("sổ đăng ký %s hỏng: %w", b.IndexPath(), err)
	}
	return ix, nil
}

func (b Book) legacyIndex() (Index, error) {
	cfg, err := config.Load(b.ConfigPath(LegacyID))
	if errors.Is(err, config.ErrNotRegistered) {
		return Index{}, nil
	}
	if err != nil {
		return Index{}, err
	}
	reg := Registration{ID: LegacyID, HubURL: cfg.HubURL, OrgID: cfg.OrgID, OrgName: cfg.OrgName}
	return Index{Active: LegacyID, Registrations: []Registration{reg}}, nil
}

// Update đọc sổ, sửa, rồi ghi lại. Không khoá giữa tiến trình: sổ chỉ đổi khi người dùng chạy lệnh `registrations`
// hay đăng ký, không đổi trong lúc worker chạy.
func (b Book) Update(fn func(*Index) error) error {
	ix, err := b.Load()
	if err != nil {
		return err
	}
	if err := fn(&ix); err != nil {
		return err
	}
	return b.save(ix)
}

// save ghi file tạm 0600 rồi đổi tên như config.Save: sổ trỏ tới worker.json chứa token nên không để người khác đọc.
func (b Book) save(ix Index) error {
	if ix.Registrations == nil {
		ix.Registrations = []Registration{}
	}
	data, err := json.MarshalIndent(ix, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(b.ConfigRoot, 0o700); err != nil {
		return fmt.Errorf("tạo thư mục cấu hình: %w", err)
	}
	tmp, err := os.CreateTemp(b.ConfigRoot, ".registrations-*.json")
	if err != nil {
		return fmt.Errorf("ghi sổ đăng ký: %w", err)
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return fmt.Errorf("đặt quyền sổ đăng ký: %w", err)
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("ghi sổ đăng ký: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("ghi sổ đăng ký: %w", err)
	}
	if err := os.Rename(tmp.Name(), b.IndexPath()); err != nil {
		return fmt.Errorf("ghi sổ đăng ký: %w", err)
	}
	return nil
}

// Selected là đăng ký lệnh này dùng: id truyền vào (cờ `--registration`), rồi HIVE_REGISTRATION, rồi đăng ký đang
// chọn trong sổ, rồi `reg_legacy`. Id không có trong sổ là lỗi, không lặng lẽ rơi về đăng ký khác, vì chạy nhầm tổ
// chức thì run của tổ chức này nhận lệnh của tổ chức kia.
func (b Book) Selected(id string) (string, error) {
	if id == "" {
		id = os.Getenv(EnvRegistration)
	}
	ix, err := b.Load()
	if err != nil {
		return "", err
	}
	if id == "" {
		id = ix.Active
	}
	if id == "" || id == LegacyID {
		return LegacyID, nil
	}
	if !ValidID(id) {
		return "", fmt.Errorf("id đăng ký %q không hợp lệ", id)
	}
	if _, ok := ix.Find(id); !ok {
		return "", fmt.Errorf("máy không có đăng ký %s; xem `hive-worker registrations list`", id)
	}
	return id, nil
}

// Paths là worker.json và thư mục dữ liệu lệnh này dùng. HIVE_WORKER_CONFIG bỏ qua sổ và giữ thư mục dữ liệu cũ.
func Paths(id string) (configPath, dataDir string, err error) {
	b, err := Default()
	if err != nil {
		return "", "", err
	}
	if p := os.Getenv(EnvWorkerConfig); p != "" && id == "" {
		return p, b.DataDir(LegacyID), nil
	}
	sel, err := b.Selected(id)
	if err != nil {
		return "", "", err
	}
	return b.ConfigPath(sel), b.DataDir(sel), nil
}

// KeyScope tách khoá máy trong keychain theo đăng ký: hai tổ chức trên cùng hub, cùng tên máy không ghi đè khoá của
// nhau. Đăng ký cũ không có phạm vi để giữ khoá đã cất.
func KeyScope(id string) string {
	if id == LegacyID {
		return ""
	}
	return id
}

var idEncoding = base32.StdEncoding.WithPadding(base32.NoPadding)

// NewID sinh `reg_` + 8 ký tự base32 thường.
func NewID() (string, error) {
	var buf [5]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("sinh id đăng ký: %w", err)
	}
	return "reg_" + strings.ToLower(idEncoding.EncodeToString(buf[:])), nil
}

// ValidID chặn id lạ trước khi ghép vào đường dẫn: id đi vào tên thư mục nên không được chứa `..` hay dấu gạch.
func ValidID(id string) bool {
	if id == LegacyID {
		return true
	}
	rest, ok := strings.CutPrefix(id, "reg_")
	if !ok || len(rest) != 8 {
		return false
	}
	for _, c := range rest {
		if (c < 'a' || c > 'z') && (c < '2' || c > '7') {
			return false
		}
	}
	return true
}
