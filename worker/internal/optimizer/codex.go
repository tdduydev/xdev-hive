package optimizer

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// Dấu khối của bộ tối ưu, khác khối "# >>> xdev-hive >>>" (MCP) đã có trong config.toml của gói.
const (
	codexBegin   = "# >>> xdev-hive optimizer >>>"
	codexEnd     = "# <<< xdev-hive optimizer <<<"
	codexComment = "# Hive thêm khối này khi bật tối ưu token; tắt trong app để gỡ."
)

var (
	tomlKeyLine = regexp.MustCompile(`^((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$`)
	tomlHeader  = regexp.MustCompile(`^\[\[?\s*[^\[\]]+?\s*\]\]?\s*(?:#.*)?$`)
	tomlScalar  = regexp.MustCompile(`^(?:[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?|true|false)$`)
)

// tomlFile là config.toml tách dòng, giữ nguyên ký tự xuống dòng của từng dòng để ghi lại đúng từng byte.
type tomlFile struct {
	lines []string
	eol   string
	// topKeys là khoá cấp gốc ngoài khối của Hive (phần đầu của khoá có dấu chấm).
	topKeys map[string]bool
	// begin, end là chỉ số dòng dấu mở và đóng khối của Hive; -1 khi không có.
	begin, end int
}

func splitLines(s string) []string {
	parts := strings.SplitAfter(s, "\n")
	if len(parts) > 0 && parts[len(parts)-1] == "" {
		parts = parts[:len(parts)-1]
	}
	return parts
}

func lineText(l string) string { return strings.TrimRight(l, "\r\n") }

// parseTOML không phải bộ đọc TOML đầy đủ (worker không có thư viện TOML): nó chỉ đủ để biết khoá cấp gốc nào đã có,
// khối của Hive nằm đâu, và từ chối file có dòng không phải TOML để không ghi thêm vào file đang hỏng.
func parseTOML(data []byte) (*tomlFile, error) {
	s := string(data)
	f := &tomlFile{lines: splitLines(s), eol: "\n", topKeys: map[string]bool{}, begin: -1, end: -1}
	if strings.Contains(s, "\r\n") {
		f.eol = "\r\n"
	}
	inTable := false
	multiline := "" // dấu đóng của chuỗi nhiều dòng đang mở
	depth := 0      // mảng hay inline table chưa đóng
	for i, l := range f.lines {
		text := lineText(l)
		if multiline != "" {
			if strings.Contains(text, multiline) {
				multiline = ""
			}
			continue
		}
		if depth > 0 {
			var err error
			if depth, multiline, err = scanValue(text, depth); err != nil {
				return nil, fmt.Errorf("dòng %d: %v", i+1, err)
			}
			continue
		}
		t := strings.TrimSpace(text)
		switch {
		case t == codexBegin:
			if f.begin >= 0 {
				return nil, fmt.Errorf("dòng %d: khối xdev-hive optimizer lặp lại", i+1)
			}
			f.begin = i
		case t == codexEnd:
			if f.begin < 0 || f.end >= 0 {
				return nil, fmt.Errorf("dòng %d: dấu đóng khối xdev-hive optimizer không có dấu mở", i+1)
			}
			f.end = i
		case t == "" || strings.HasPrefix(t, "#"):
		case strings.HasPrefix(t, "["):
			if !tomlHeader.MatchString(t) {
				return nil, fmt.Errorf("dòng %d: tên bảng không hợp lệ", i+1)
			}
			inTable = true
		default:
			m := tomlKeyLine.FindStringSubmatch(t)
			if m == nil || strings.TrimSpace(m[2]) == "" {
				return nil, fmt.Errorf("dòng %d: không phải khoá = giá trị", i+1)
			}
			inBlock := f.begin >= 0 && f.end < 0
			if !inTable && !inBlock {
				f.topKeys[firstKey(m[1])] = true
			}
			var err error
			if depth, multiline, err = scanValue(m[2], 0); err != nil {
				return nil, fmt.Errorf("dòng %d: %v", i+1, err)
			}
		}
	}
	if multiline != "" || depth > 0 {
		return nil, fmt.Errorf("chuỗi hoặc mảng chưa đóng ở cuối file")
	}
	if f.begin >= 0 && f.end < 0 {
		return nil, fmt.Errorf("khối xdev-hive optimizer thiếu dấu đóng")
	}
	return f, nil
}

func firstKey(k string) string {
	k = strings.TrimSpace(k)
	if k != "" && (k[0] == '"' || k[0] == '\'') {
		if end := strings.IndexByte(k[1:], k[0]); end >= 0 {
			return k[1 : end+1]
		}
	}
	if i := strings.IndexByte(k, '.'); i >= 0 {
		return strings.TrimSpace(k[:i])
	}
	return k
}

// scanValue đi qua phần giá trị, bỏ qua chuỗi và comment, đếm ngoặc mảng/inline table để biết giá trị có kéo sang dòng
// sau không. Trả độ sâu mới và dấu đóng nếu dòng mở một chuỗi nhiều dòng.
func scanValue(s string, depth int) (int, string, error) {
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '#':
			return depth, "", nil
		case '[', '{':
			depth++
		case ']', '}':
			depth--
			if depth < 0 {
				return 0, "", fmt.Errorf("thừa dấu đóng ngoặc")
			}
		case '"', '\'':
			if strings.HasPrefix(s[i:], strings.Repeat(string(c), 3)) {
				delim := strings.Repeat(string(c), 3)
				end := strings.Index(s[i+3:], delim)
				if end < 0 {
					return depth, delim, nil
				}
				i += 3 + end + 2
				continue
			}
			j := i + 1
			for ; j < len(s); j++ {
				if c == '"' && s[j] == '\\' {
					j++
					continue
				}
				if s[j] == c {
					break
				}
			}
			if j >= len(s) {
				return 0, "", fmt.Errorf("chuỗi chưa đóng")
			}
			i = j
		}
	}
	return depth, "", nil
}

// tomlValue: giá trị preset đã là chữ TOML (số, true/false, chuỗi có ngoặc) thì giữ, không thì bọc thành chuỗi.
func tomlValue(v string) string {
	v = strings.TrimSpace(v)
	if tomlScalar.MatchString(v) || strings.HasPrefix(v, `"`) || strings.HasPrefix(v, "'") {
		return v
	}
	return strconv.Quote(v)
}

// stripBlock bỏ khối của Hive. Dòng khoá trong khối mà người dùng đã sửa, hay khoá người dùng tự thêm vào khối, được
// giữ lại tại chỗ.
func stripBlock(f *tomlFile, entry *Entry) (string, []string, []Warning) {
	if f.begin < 0 {
		var warnings []Warning
		if entry != nil {
			for _, kv := range entry.Codex {
				warnings = append(warnings, Warning{Key: "codex." + kv.Key, Kind: "user_removed",
					Message: fmt.Sprintf("%s đã bị người dùng xoá khỏi config.toml", kv.Key)})
			}
		}
		return strings.Join(f.lines, ""), nil, warnings
	}
	ours := map[string]string{}
	if entry != nil {
		for _, kv := range entry.Codex {
			ours[kv.Key] = kv.Key + " = " + kv.Value
		}
	}
	var out strings.Builder
	var removed []string
	var warnings []Warning
	seen := map[string]bool{}
	for _, l := range f.lines[:f.begin] {
		out.WriteString(l)
	}
	for _, l := range f.lines[f.begin+1 : f.end] {
		t := strings.TrimSpace(lineText(l))
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		m := tomlKeyLine.FindStringSubmatch(t)
		key := ""
		if m != nil {
			key = firstKey(m[1])
		}
		want, mine := ours[key]
		switch {
		case mine && t == want:
			seen[key] = true
			removed = append(removed, "codex."+key)
			continue
		case mine:
			seen[key] = true
			warnings = append(warnings, Warning{Key: "codex." + key, Kind: "user_changed",
				Message: fmt.Sprintf("%s người dùng đã đổi sau khi bật, giữ nguyên", key)})
		case entry == nil && m != nil:
			// Không có manifest: khoá trong khối là của Hive.
			removed = append(removed, "codex."+key)
			continue
		}
		out.WriteString(l)
	}
	rest := f.lines[f.end+1:]
	separator := entry == nil && f.begin == 0 || entry != nil && entry.CodexSeparator
	if separator && len(rest) > 0 && strings.TrimSpace(rest[0]) == "" {
		rest = rest[1:]
	}
	for _, l := range rest {
		out.WriteString(l)
	}
	if entry != nil {
		for _, kv := range entry.Codex {
			if !seen[kv.Key] {
				warnings = append(warnings, Warning{Key: "codex." + kv.Key, Kind: "user_removed",
					Message: fmt.Sprintf("%s đã bị người dùng xoá khỏi config.toml", kv.Key)})
			}
		}
	}
	return out.String(), removed, warnings
}

func enableCodex(old snapshot, prev, entry *Entry, preset Preset) ([]byte, []string, []Warning, error) {
	f, err := parseTOML(old.data)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("%w: config.toml: %v", ErrInvalidConfig, err)
	}
	if f.begin >= 0 {
		// Đổi mức (hoặc khối còn sót khi manifest mất): bỏ khối cũ rồi dựng lại.
		body, _, _ := stripBlock(f, prev)
		eol := f.eol
		if f, err = parseTOML([]byte(body)); err != nil {
			return nil, nil, nil, fmt.Errorf("%w: config.toml: %v", ErrInvalidConfig, err)
		}
		f.eol = eol
	}
	keys := make([]string, 0, len(preset.Codex))
	for k := range preset.Codex {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var added []string
	var warnings []Warning
	var block strings.Builder
	for _, k := range keys {
		if f.topKeys[k] {
			// TOML không cho khoá trùng: Codex sẽ không đọc được file.
			entry.UserSet = append(entry.UserSet, k)
			warnings = append(warnings, Warning{Key: "codex." + k, Kind: "user_set",
				Message: fmt.Sprintf("%s đã có trong config.toml, giữ giá trị của người dùng", k)})
			continue
		}
		v := tomlValue(preset.Codex[k])
		block.WriteString(k + " = " + v + f.eol)
		entry.Codex = append(entry.Codex, KeyValue{Key: k, Value: v})
		added = append(added, "codex."+k)
	}
	body := strings.Join(f.lines, "")
	if len(added) == 0 {
		return []byte(body), nil, warnings, nil
	}
	// Khoá cấp gốc phải đứng trước bảng đầu tiên, nên khối luôn ở đầu file.
	head := codexBegin + f.eol + codexComment + f.eol + block.String() + codexEnd + f.eol
	if body != "" {
		head += f.eol
		entry.CodexSeparator = true
	}
	return []byte(head + body), added, warnings, nil
}

func disableCodex(old snapshot, entry *Entry) ([]byte, bool, []string, []Warning, error) {
	if !old.exists {
		return nil, false, nil, nil, nil
	}
	f, err := parseTOML(old.data)
	if err != nil {
		return nil, false, nil, nil, fmt.Errorf("%w: config.toml: %v", ErrInvalidConfig, err)
	}
	body, removed, warnings := stripBlock(f, entry)
	if body == "" && entry != nil && !entry.Existed {
		return nil, true, removed, warnings, nil
	}
	return []byte(body), false, removed, warnings, nil
}
