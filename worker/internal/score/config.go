package score

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"unicode/utf8"
)

// ClaudeSettings là settings.json của một gói Claude Code. OK false: file có mà không đọc được (JSON hỏng); thiếu file
// là cấu hình rỗng.
type ClaudeSettings struct {
	OK   bool
	Path string
	raw  map[string]any
}

func ReadClaudeSettings(dir string) ClaudeSettings {
	st := ClaudeSettings{Path: filepath.Join(dir, "settings.json"), raw: map[string]any{}}
	b, err := os.ReadFile(st.Path)
	if errors.Is(err, fs.ErrNotExist) {
		st.OK = true
		return st
	}
	if err != nil || json.Unmarshal(b, &st.raw) != nil {
		return st
	}
	if st.raw == nil {
		st.raw = map[string]any{}
	}
	st.OK = true
	return st
}

func text(v any) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	}
	return fmt.Sprint(v)
}

// EnvMap là khối env của settings.json; giá trị không phải chuỗi được đổi sang chuỗi.
func (s ClaudeSettings) EnvMap() map[string]string {
	out := map[string]string{}
	if env, ok := s.raw["env"].(map[string]any); ok {
		for k, v := range env {
			out[k] = text(v)
		}
	}
	return out
}

func (s ClaudeSettings) Env(key string) string { return s.EnvMap()[key] }

func number(v string) (float64, bool) {
	v = strings.ReplaceAll(strings.TrimSpace(v), "_", "")
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseFloat(v, 64)
	return n, err == nil
}

// Number đọc một biến env dạng số.
func (s ClaudeSettings) Number(key string) (float64, bool) {
	v, ok := s.EnvMap()[key]
	if !ok {
		return 0, false
	}
	return number(v)
}

// TopNumber đọc một khoá cấp đầu dạng số (vd autoCompactWindow, bashOutputMaxChars).
func (s ClaudeSettings) TopNumber(key string) (float64, bool) {
	v, ok := s.raw[key]
	if !ok {
		return 0, false
	}
	return number(text(v))
}

func (s ClaudeSettings) TopString(key string) string { return text(s.raw[key]) }

// Hooks trả JSON của mảng hook một event, để tìm lệnh theo chuỗi mà không phụ thuộc cấu trúc lồng của Claude Code.
func (s ClaudeSettings) Hooks(event string) string {
	hooks, ok := s.raw["hooks"].(map[string]any)
	if !ok {
		return ""
	}
	b, _ := json.Marshal(hooks[event])
	return string(b)
}

// ClaudeJSON là ~/.claude.json (gói mặc định) hay <thư mục gói>/.claude.json: MCP cấp người dùng và theo dự án.
type ClaudeJSON struct {
	raw map[string]any
}

func ReadClaudeJSON(home string, p Profile) ClaudeJSON {
	path := filepath.Join(p.Dir, ".claude.json")
	if p.Default {
		path = filepath.Join(home, ".claude.json")
	}
	c := ClaudeJSON{raw: map[string]any{}}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &c.raw)
	}
	return c
}

// servers là các bảng mcpServers: cấp người dùng và của các dự án trong dirs.
func (c ClaudeJSON) servers(dirs []string) []map[string]any {
	var out []map[string]any
	if m, ok := c.raw["mcpServers"].(map[string]any); ok {
		out = append(out, m)
	}
	projects, _ := c.raw["projects"].(map[string]any)
	for key, v := range projects {
		for _, d := range dirs {
			if !samePath(key, d) {
				continue
			}
			if p, ok := v.(map[string]any); ok {
				if m, ok := p["mcpServers"].(map[string]any); ok {
					out = append(out, m)
				}
			}
		}
	}
	return out
}

func (c ClaudeJSON) HasServer(name string, dirs []string) bool {
	for _, m := range c.servers(dirs) {
		if _, ok := m[name]; ok {
			return true
		}
	}
	return false
}

func alwaysLoad(m map[string]any) bool {
	for _, v := range m {
		if s, ok := v.(map[string]any); ok && s["alwaysLoad"] == true {
			return true
		}
	}
	return false
}

// AlwaysLoad: có server ép nạp định nghĩa tool từ đầu, bỏ qua việc hoãn nạp của Claude Code.
func (c ClaudeJSON) AlwaysLoad(dirs []string) bool {
	for _, m := range c.servers(dirs) {
		if alwaysLoad(m) {
			return true
		}
	}
	for _, d := range dirs {
		if m := mcpJSONServers(filepath.Join(d, ".mcp.json")); alwaysLoad(m) {
			return true
		}
	}
	return false
}

func mcpJSONServers(path string) map[string]any {
	var raw struct {
		MCPServers map[string]any `json:"mcpServers"`
	}
	if b, err := os.ReadFile(path); err == nil {
		_ = json.Unmarshal(b, &raw)
	}
	return raw.MCPServers
}

func hasMCPJSONServer(path, name string) bool {
	_, ok := mcpJSONServers(path)[name]
	return ok
}

// samePath so đường dẫn do Claude Code ghi với cwd của transcript; Windows không phân biệt hoa thường và dấu gạch.
func samePath(a, b string) bool {
	a, b = filepath.Clean(filepath.FromSlash(a)), filepath.Clean(filepath.FromSlash(b))
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

// CodexConfig là phần config.toml mà điểm cần: khoá cấp đầu và bảng [mcp_servers.<tên>]. Chỉ đọc dạng đơn giản
// `khoá = giá trị`; không cần đủ TOML.
type CodexConfig struct {
	OK      bool
	top     map[string]string
	servers map[string]bool
}

func ReadCodexConfig(path string) CodexConfig {
	c := CodexConfig{top: map[string]string{}, servers: map[string]bool{}}
	b, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		c.OK = true
		return c
	}
	if err != nil {
		return c
	}
	section, server := "", ""
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 1<<16), 1<<22)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(stripComment(line), "[] ")
			server = ""
			if name, ok := strings.CutPrefix(section, "mcp_servers."); ok && !strings.Contains(strings.Trim(name, `"`), ".") {
				server = strings.Trim(name, `"`)
				c.servers[server] = true
			}
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), tomlValue(value)
		switch {
		case section == "":
			c.top[key] = value
		case server != "" && key == "enabled":
			c.servers[server] = value != "false"
		}
	}
	c.OK = sc.Err() == nil
	return c
}

func stripComment(s string) string {
	inQuote := false
	for i, r := range s {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == '#' && !inQuote:
			return strings.TrimSpace(s[:i])
		}
	}
	return strings.TrimSpace(s)
}

func tomlValue(v string) string {
	v = stripComment(v)
	if len(v) >= 2 && (v[0] == '"' || v[0] == '\'') && v[len(v)-1] == v[0] {
		return v[1 : len(v)-1]
	}
	return v
}

func (c CodexConfig) String(key string) string { return c.top[key] }

func (c CodexConfig) Number(key string) (float64, bool) {
	v, ok := c.top[key]
	if !ok {
		return 0, false
	}
	return number(v)
}

// Top là các khoá cấp đầu (để xem trước sửa nhanh so giá trị cũ).
func (c CodexConfig) Top() map[string]string { return c.top }

func (c CodexConfig) EnabledServers() int {
	n := 0
	for _, on := range c.servers {
		if on {
			n++
		}
	}
	return n
}

func (c CodexConfig) HasServer(name string) bool { return c.servers[name] }

// fileStats trả số dòng và cỡ byte; file không đọc được là 0, 0.
func fileStats(path string) (int, int64) {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0, 0
	}
	lines := bytes.Count(b, []byte("\n"))
	if len(b) > 0 && b[len(b)-1] != '\n' {
		lines++
	}
	return lines, int64(len(b))
}

func runeCount(path string) int {
	b, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	return utf8.RuneCount(b)
}
