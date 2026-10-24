package secretstore

import (
	"errors"
	"fmt"
	"strings"
)

// DotenvEntry là một biến đọc được từ file .env (FR-069). Name đã chuẩn hoá và hợp lệ; giá trị chưa kiểm FR-005.
type DotenvEntry struct {
	Line  int
	Name  string
	Value string
}

// DotenvProblem là dòng không nhập được. Name chỉ có khi chắc chắn là tên (tên dành riêng, tên lặp): phần trước dấu =
// của dòng sai có thể là giá trị dán nhầm, nên chỉ báo số dòng.
type DotenvProblem struct {
	Line int
	Name string
	Err  *Error
}

// ParseDotenv đọc KEY=VALUE theo data-model §9. Dòng lỗi được liệt kê, không dừng cả file.
func ParseDotenv(b []byte) ([]DotenvEntry, []DotenvProblem) {
	text := strings.TrimPrefix(strings.ReplaceAll(string(b), "\r\n", "\n"), "\xef\xbb\xbf")
	lines := strings.Split(text, "\n")
	var entries []DotenvEntry
	var problems []DotenvProblem
	seen := map[string]bool{}
	for i := 0; i < len(lines); i++ {
		n := i + 1
		s := strings.TrimLeft(lines[i], " \t")
		if strings.TrimSpace(s) == "" || s[0] == '#' {
			continue
		}
		if rest, ok := strings.CutPrefix(s, "export"); ok && rest != "" && (rest[0] == ' ' || rest[0] == '\t') {
			s = strings.TrimLeft(rest, " \t")
		}
		key, raw, ok := strings.Cut(s, "=")
		key = strings.TrimSpace(key)
		if !ok || key == "" {
			problems = append(problems, DotenvProblem{Line: n, Err: badLine(n)})
			continue
		}
		value, used, ok := dotenvValue(strings.TrimLeft(raw, " \t"), lines[i+1:])
		i += used
		if !ok {
			problems = append(problems, DotenvProblem{Line: n, Err: badLine(n)})
			continue
		}
		name := NormalizeName(key)
		if err := ValidName(name); err != nil {
			p := DotenvProblem{Line: n, Err: err.(*Error)}
			if errors.Is(err, &Error{Code: CodeReservedName}) {
				p.Name = name
			}
			problems = append(problems, p)
			continue
		}
		if seen[name] {
			problems = append(problems, DotenvProblem{Line: n, Name: name, Err: &Error{
				Code:    CodeDuplicateName,
				Message: fmt.Sprintf("`%s` lặp lại trong file, chỉ nhập lần đầu.", name),
				Names:   []string{name},
			}})
			continue
		}
		seen[name] = true
		entries = append(entries, DotenvEntry{Line: n, Name: name, Value: value})
	}
	return entries, problems
}

// dotenvValue đọc giá trị sau dấu =; used là số dòng sau đó mà giá trị trong nháy đã kéo qua. ok false khi nháy không
// đóng hay có chữ thừa sau nháy đóng.
func dotenvValue(raw string, next []string) (value string, used int, ok bool) {
	if raw == "" || (raw[0] != '"' && raw[0] != '\'') {
		for i := 1; i < len(raw); i++ {
			if raw[i] == '#' && (raw[i-1] == ' ' || raw[i-1] == '\t') {
				raw = raw[:i]
				break
			}
		}
		return strings.TrimSpace(raw), 0, true
	}
	q := raw[0]
	body := raw[1:]
	var sb strings.Builder
	for {
		for i := 0; i < len(body); i++ {
			c := body[i]
			if q == '"' && c == '\\' && i+1 < len(body) {
				i++
				switch body[i] {
				case 'n':
					sb.WriteByte('\n')
				case 'r':
					sb.WriteByte('\r')
				case 't':
					sb.WriteByte('\t')
				case '"', '\\':
					sb.WriteByte(body[i])
				default:
					sb.WriteByte('\\')
					sb.WriteByte(body[i])
				}
				continue
			}
			if c == q {
				rest := strings.TrimSpace(body[i+1:])
				return sb.String(), used, rest == "" || rest[0] == '#'
			}
			sb.WriteByte(c)
		}
		if used == len(next) {
			return "", used, false
		}
		sb.WriteByte('\n')
		body = next[used]
		used++
	}
}

func badLine(n int) *Error {
	return &Error{Code: CodeFileFormat, Message: fmt.Sprintf("Dòng %d không đúng dạng KEY=VALUE.", n)}
}
