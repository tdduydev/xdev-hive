// Package redact che chuỗi tự do trước khi rời máy; hub vẫn phải che lại khi nhận.
package redact

import (
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const Mask = "[đã che]"

var patterns = []*regexp.Regexp{
	regexp.MustCompile(`(?s)-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----.*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)`),
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hive_pat_[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}`),
	regexp.MustCompile(`(?i)(://[^/\s:@]*:)[^/\s@]+@`),
	regexp.MustCompile(`(?i)\b([A-Z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)[A-Z0-9_.-]*["']?\s*[=:]\s*)(\[đã che\]|"[^"]*"|'[^']*'|\S+)`),
}

// Bỏ mã màu trước khi quét để escape chen vào giữa token không vô hiệu hoá mẫu.
var ansi = regexp.MustCompile("\x1b(?:\\[[0-?]*[ -/]*[@-~]|\\][^\x07\x1b]*(?:\x07|\x1b\\\\)|[@-Z\\-_])")

func Text(s string, exact []string) string {
	s = ansi.ReplaceAllString(s, "")
	values := append([]string(nil), exact...)
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	for _, v := range values {
		if len(v) >= 6 {
			s = strings.ReplaceAll(s, v, Mask)
		}
	}
	for i, re := range patterns {
		switch i {
		case 3:
			s = re.ReplaceAllString(s, "$1 "+Mask)
		case 4:
			s = re.ReplaceAllString(s, "${1}"+Mask+"@")
		case 5:
			s = re.ReplaceAllString(s, "${1}"+Mask)
		default:
			s = re.ReplaceAllString(s, Mask)
		}
	}
	return s
}

// JSON giữ nguyên kiểu số và khoá định danh, chỉ che các giá trị chữ lồng nhau.
func JSON(b []byte, exact []string) ([]byte, error) {
	var v any
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case string:
			return Text(x, exact)
		case []any:
			for i, value := range x {
				x[i] = walk(value)
			}
		case map[string]any:
			for k, value := range x {
				x[k] = walk(value)
			}
		}
		return v
	}
	return json.Marshal(walk(v))
}

// Stream giữ đuôi và lùi điểm cắt ra khỏi đoạn giống bí mật. Output thường, kể cả dòng dài không có newline, vẫn đi
// tiếp; chỉ đoạn giống bí mật quá dài mới bị bỏ để không giữ RAM không giới hạn.
type Stream struct {
	Exact      []string
	held       string
	dropping   bool
	privateKey bool
}

func (s *Stream) Push(p []byte) []byte {
	s.held += string(p)
	if s.privateKey {
		end := privateKeyEnd.FindStringIndex(s.held)
		if end == nil {
			if len(s.held) > 512 {
				s.held = s.held[len(s.held)-512:]
			}
			return nil
		}
		s.held = s.held[end[1]:]
		s.privateKey = false
	}
	if s.dropping {
		end := strings.IndexByte(s.held, '\n')
		if end < 0 {
			s.held = ""
			return nil
		}
		s.held = s.held[end+1:]
		s.dropping = false
	}
	raw := ansi.ReplaceAllString(s.held, "")
	keep := 512
	for _, v := range s.Exact {
		keep = max(keep, len(v))
	}
	cut := max(0, len(raw)-keep)
	var spans [][2]int
	for _, re := range patterns {
		for _, m := range re.FindAllStringIndex(raw, -1) {
			spans = append(spans, [2]int{m[0], m[1]})
		}
	}
	for _, v := range s.Exact {
		if len(v) < 6 {
			continue
		}
		for start := 0; start < len(raw); {
			i := strings.Index(raw[start:], v)
			if i < 0 {
				break
			}
			i += start
			spans = append(spans, [2]int{i, i + len(v)})
			start = i + 1
		}
	}
	for previous := -1; previous != cut; {
		previous = cut
		for _, span := range spans {
			if span[0] < cut && cut < span[1] {
				cut = span[0]
			}
		}
		for cut > 0 && cut < len(raw) && !utf8.RuneStart(raw[cut]) {
			cut--
		}
	}
	if len(raw)-cut > 64*1024 {
		for _, span := range spans {
			if span[0] != cut {
				continue
			}
			secret := raw[span[0]:span[1]]
			s.privateKey = strings.HasPrefix(secret, "-----BEGIN ") && !privateKeyEnd.MatchString(secret)
			s.dropping = !s.privateKey && span[1] == len(raw)
			s.held = raw[span[1]:]
			return []byte(Text(raw[:cut], s.Exact) + Mask)
		}
	}
	s.held = raw[cut:]
	return []byte(Text(raw[:cut], s.Exact))
}

var privateKeyEnd = regexp.MustCompile(`-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----`)

func (s *Stream) Flush() []byte {
	b := s.held
	s.held = ""
	if s.dropping || s.privateKey {
		return nil
	}
	return []byte(Text(b, s.Exact))
}
