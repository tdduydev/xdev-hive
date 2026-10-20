package branches

import (
	"encoding/json"
	"os"
	"path/filepath"
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
// list cần mẫu ngay từ T004 nên phần đọc có ở đây; kiểm và ghi (settings-set) là của T009.
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

// Settings là lệnh `settings`. Khung của T004; T009 làm.
func Settings(env Env) (*BranchSettings, *Error) { return nil, notImplemented() }

// SetSettings là lệnh `settings-set`. Khung của T004; T009 làm.
func SetSettings(env Env, in *SettingsInput) (*BranchSettings, *Error) { return nil, notImplemented() }
