package branches

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
	"unicode/utf8"
)

// BranchSettings là cấu hình dọn nhánh trong branches.json (FR-033).
type BranchSettings struct {
	Path        string          `json:"path"`
	Patterns    []string        `json:"patterns"`
	Rebuildable []string        `json:"rebuildable"`
	Defaults    SettingsDefault `json:"defaults"`
}

type SettingsDefault struct {
	Patterns    []string `json:"patterns"`
	Rebuildable []string `json:"rebuildable"`
}

// SettingsInput là settings của dòng đầu stdin (settings-set).
type SettingsInput struct {
	Patterns    []string `json:"patterns"`
	Rebuildable []string `json:"rebuildable"`
}

// Mặc định của chủ dự án (Q8, Q15). Hàm trả bản sao để bên gọi sửa không đổi mặc định.
func DefaultPatterns() []string { return []string{"ai/*", "claude/*"} }

func DefaultRebuildable() []string {
	return []string{"node_modules", "dist", "build", "target", ".turbo", ".next", ".venv", "__pycache__", "coverage"}
}

// SettingsPath là branches.json cạnh worker.json.
func SettingsPath(configDir string) string { return filepath.Join(configDir, "branches.json") }

// LoadSettings đọc branches.json; file không có hay hỏng thì dùng mặc định, không ghi đè file hỏng (hợp đồng mục 2.5).
func LoadSettings(configDir string) BranchSettings {
	s := BranchSettings{
		Path:        SettingsPath(configDir),
		Patterns:    DefaultPatterns(),
		Rebuildable: DefaultRebuildable(),
		Defaults:    SettingsDefault{Patterns: DefaultPatterns(), Rebuildable: DefaultRebuildable()},
	}
	if configDir == "" {
		return s
	}
	b, err := os.ReadFile(s.Path)
	if err != nil {
		return s
	}
	var f struct {
		Patterns    *[]string `json:"patterns"`
		Rebuildable *[]string `json:"rebuildable"`
	}
	if json.Unmarshal(b, &f) != nil {
		return s
	}
	// Mảng rỗng là lựa chọn của người dùng (không dọn nhánh nào), khác với thiếu trường.
	if f.Patterns != nil {
		s.Patterns = append([]string{}, *f.Patterns...)
	}
	if f.Rebuildable != nil {
		s.Rebuildable = append([]string{}, *f.Rebuildable...)
	}
	return s
}

// Match so tên nhánh với mẫu: * khớp mọi chuỗi kể cả "/", ký tự khác khớp đúng, phân biệt hoa thường (FR-033).
func Match(pattern, name string) bool {
	// Quy hoạch động trên byte: * không có lớp ký tự nên không cần giải mã UTF-8.
	p, n := pattern, name
	pi, ni, star, mark := 0, 0, -1, 0
	for ni < len(n) {
		switch {
		case pi < len(p) && p[pi] == '*':
			star, mark = pi, ni
			pi++
		case pi < len(p) && p[pi] == n[ni]:
			pi++
			ni++
		case star >= 0:
			pi, mark = star+1, mark+1
			ni = mark
		default:
			return false
		}
	}
	for pi < len(p) && p[pi] == '*' {
		pi++
	}
	return pi == len(p)
}

// MatchAny là nhánh khớp ít nhất một mẫu.
func MatchAny(patterns []string, name string) bool {
	for _, p := range patterns {
		if Match(p, name) {
			return true
		}
	}
	return false
}

// Settings là lệnh `settings`: cấu hình đang dùng, file hỏng thì trả mặc định.
func Settings(env Env) (*BranchSettings, *Error) {
	s := LoadSettings(env.ConfigDir)
	return &s, nil
}

// Giới hạn của settings-set (hợp đồng mục 1.6, invalid_settings).
const (
	maxSettingsItems = 50
	maxSettingsLen   = 200
)

// SetSettings là lệnh `settings-set`: kiểm cả hai danh sách rồi ghi cả file. Lỗi thì không ghi gì.
func SetSettings(env Env, in *SettingsInput) (*BranchSettings, *Error) {
	if in == nil || in.Patterns == nil || in.Rebuildable == nil {
		return nil, invalidSettings("Thiếu danh sách mẫu dọn hoặc danh sách thư mục dựng lại được.")
	}
	if e := checkList("Mẫu dọn", in.Patterns, false); e != nil {
		return nil, e
	}
	if e := checkList("Thư mục dựng lại được", in.Rebuildable, true); e != nil {
		return nil, e
	}
	if env.ConfigDir == "" {
		return nil, &Error{Code: CodeGit, Message: "Không tìm được thư mục cấu hình."}
	}
	body, err := json.MarshalIndent(SettingsInput{Patterns: in.Patterns, Rebuildable: in.Rebuildable}, "", "  ")
	if err != nil {
		return nil, &Error{Code: CodeGit, Message: "Không ghi được cấu hình dọn nhánh.", Detail: err.Error()}
	}
	if err := writeAtomic(SettingsPath(env.ConfigDir), append(body, '\n')); err != nil {
		return nil, &Error{Code: CodeGit, Message: "Không ghi được cấu hình dọn nhánh.", Detail: err.Error()}
	}
	s := LoadSettings(env.ConfigDir)
	return &s, nil
}

func invalidSettings(detail string) *Error {
	return &Error{Code: CodeInvalidSettings, Message: "Cấu hình dọn nhánh không hợp lệ.", Detail: detail}
}

// checkList kiểm một danh sách của settings-set. Tên thư mục dựng lại được so theo từng đoạn đường dẫn, nên tên có dấu
// phân cách không bao giờ khớp; báo lỗi thay vì lưu một mục vô dụng mà người dùng tưởng là có tác dụng.
func checkList(label string, items []string, segment bool) *Error {
	if len(items) > maxSettingsItems {
		return invalidSettings(fmt.Sprintf("%s: tối đa %d mục.", label, maxSettingsItems))
	}
	for _, it := range items {
		switch {
		case strings.TrimSpace(it) == "":
			return invalidSettings(label + ": có mục rỗng.")
		case utf8.RuneCountInString(it) > maxSettingsLen:
			return invalidSettings(fmt.Sprintf("%s: mục dài quá %d ký tự.", label, maxSettingsLen))
		case !utf8.ValidString(it) || strings.IndexFunc(it, unicode.IsControl) >= 0:
			return invalidSettings(fmt.Sprintf("%s: mục %q có ký tự điều khiển.", label, it))
		case segment && strings.ContainsAny(it, `/\`):
			return invalidSettings(fmt.Sprintf("%s: %q phải là tên một thư mục, không có dấu / hay \\.", label, it))
		case segment && (it == "." || it == ".."):
			return invalidSettings(fmt.Sprintf("%s: %q không phải tên thư mục.", label, it))
		}
	}
	return nil
}

// writeAtomic ghi file tạm cùng thư mục rồi đổi tên: app đọc branches.json giữa chừng không gặp file nửa vời.
func writeAtomic(path string, body []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".branches-*.json")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err == nil {
		err = os.Rename(tmp, path)
	}
	if err != nil {
		_ = os.Remove(tmp)
	}
	return err
}
