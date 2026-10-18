// Package sshkeys chuyển đăng nhập SSH của máy dev từ mật khẩu sang khoá (specs/023-desktop-ssh-keys): đọc và sửa
// ~/.ssh/config, known_hosts, tạo khoá ed25519, cài khoá công khai lên máy chủ bằng mật khẩu gõ một lần, rồi kiểm tra
// bằng ssh của máy.
package sshkeys

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Host là một khối `Host` có tên cụ thể trong ~/.ssh/config.
type Host struct {
	Alias        string `json:"alias"`
	HostName     string `json:"hostName"`
	User         string `json:"user"`
	Port         int    `json:"port"`
	IdentityFile string `json:"identityFile,omitempty"`
	// Managed: khối nằm giữa hai dòng đánh dấu của app; app chỉ sửa và xoá khối này.
	Managed bool `json:"managed"`
	// Proxy: khối đi qua máy trung gian; bước cài khoá nối thẳng nên không làm được.
	Proxy bool `json:"proxy"`
	// KeyUsable: ssh sẽ đưa khoá của máy khi nối alias này (Resolve.Uses).
	KeyUsable bool `json:"keyUsable"`
}

const (
	beginMarker = "# >>> xdev-hive "
	endMarker   = "# <<< xdev-hive"
)

var (
	ErrAliasExists   = errors.New("tên gợi nhớ đã có trong ~/.ssh/config, chọn tên khác")
	ErrNotManaged    = errors.New("khối này không do app tạo nên app không sửa hay xoá")
	ErrUnclosedBlock = errors.New("khối của app trong ~/.ssh/config thiếu dòng đóng \"# <<< xdev-hive\"; sửa tay rồi thử lại")
)

var (
	aliasRe = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`)
	userRe  = regexp.MustCompile(`^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$`)
	// Tên DNS, IPv4 hay IPv6 không ngoặc: chỉ ký tự an toàn cho dòng config và tham số ssh.
	hostRe = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,253}$`)
)

// ValidAlias, ValidUser, ValidHost kiểm giá trị trước khi ghi vào config hay đưa cho ssh: không bắt đầu bằng `-` để ssh
// không đọc thành cờ, không ký tự đại diện hay xuống dòng để không chèn được dòng config khác.
func ValidAlias(s string) bool { return aliasRe.MatchString(s) }
func ValidUser(s string) bool  { return userRe.MatchString(s) }
func ValidHost(s string) bool  { return hostRe.MatchString(s) && s[0] != '-' }

type configLine struct {
	raw     string // gồm cả ký tự xuống dòng
	key     string // từ khoá viết thường; rỗng với dòng trống và comment
	args    []string
	trimmed string
}

func splitLines(data []byte) []configLine {
	var lines []configLine
	for len(data) > 0 {
		i := bytes.IndexByte(data, '\n')
		var raw []byte
		if i < 0 {
			raw, data = data, nil
		} else {
			raw, data = data[:i+1], data[i+1:]
		}
		lines = append(lines, parseLine(string(raw)))
	}
	return lines
}

func parseLine(raw string) configLine {
	l := configLine{raw: raw, trimmed: strings.TrimSpace(raw)}
	if l.trimmed == "" || strings.HasPrefix(l.trimmed, "#") {
		return l
	}
	// ssh_config cho phép `Key value`, `Key=value` và `Key = value`.
	i := strings.IndexAny(l.trimmed, " \t=")
	if i < 0 {
		l.key = strings.ToLower(l.trimmed)
		return l
	}
	key, rest := l.trimmed[:i], strings.TrimLeft(l.trimmed[i:], " \t")
	rest = strings.TrimPrefix(rest, "=")
	l.key = strings.ToLower(key)
	l.args = splitArgs(rest)
	return l
}

// splitArgs tách giá trị theo khoảng trắng, giữ nguyên phần trong dấu nháy kép (đường dẫn có dấu cách).
func splitArgs(s string) []string {
	var args []string
	for s = strings.TrimSpace(s); s != ""; s = strings.TrimSpace(s) {
		if s[0] == '"' {
			if end := strings.IndexByte(s[1:], '"'); end >= 0 {
				args = append(args, s[1:end+1])
				s = s[end+2:]
				continue
			}
		}
		i := strings.IndexAny(s, " \t")
		if i < 0 {
			args = append(args, s)
			break
		}
		args = append(args, s[:i])
		s = s[i:]
	}
	return args
}

func concrete(pattern string) bool { return !strings.ContainsAny(pattern, "*?!") }

// ParseConfig trả các khối `Host` có ít nhất một tên cụ thể. Không đọc file được Include: app chỉ hiện và sửa chính
// ~/.ssh/config. Giá trị đầu tiên của mỗi từ khoá thắng, như ssh.
func ParseConfig(data []byte) []Host {
	var hosts []Host
	var cur *Host
	managed := ""
	flush := func() {
		if cur != nil {
			if cur.HostName == "" {
				cur.HostName = cur.Alias
			}
			if cur.Port == 0 {
				cur.Port = 22
			}
			hosts = append(hosts, *cur)
			cur = nil
		}
	}
	for _, l := range splitLines(data) {
		switch {
		case strings.HasPrefix(l.trimmed, beginMarker):
			managed = strings.TrimSpace(strings.TrimPrefix(l.trimmed, beginMarker))
			continue
		case l.trimmed == endMarker:
			flush()
			managed = ""
			continue
		}
		switch l.key {
		case "host":
			flush()
			for _, p := range l.args {
				if concrete(p) {
					cur = &Host{Alias: p, Managed: managed != "" && managed == p}
					break
				}
			}
		case "match":
			flush()
		case "":
		default:
			if cur == nil || len(l.args) == 0 {
				continue
			}
			v := l.args[0]
			switch l.key {
			case "hostname":
				if cur.HostName == "" {
					cur.HostName = v
				}
			case "user":
				if cur.User == "" {
					cur.User = v
				}
			case "port":
				if cur.Port == 0 {
					cur.Port, _ = strconv.Atoi(v)
				}
			case "identityfile":
				if cur.IdentityFile == "" {
					cur.IdentityFile = v
				}
			case "proxyjump", "proxycommand":
				if !strings.EqualFold(v, "none") {
					cur.Proxy = true
				}
			}
		}
	}
	flush()
	return hosts
}

func newline(data []byte) string {
	if bytes.Contains(data, []byte("\r\n")) {
		return "\r\n"
	}
	return "\n"
}

// AddBlock thêm khối của app cho h. Khối đặt trước `Host *` hay `Match all` đầu tiên (giá trị đầu tiên thắng, nên khối
// riêng phải đứng trước khối chung), không thì cuối file; luôn kèm đúng một dòng trống cạnh khối để RemoveBlock trả lại
// đúng file cũ.
func AddBlock(data []byte, h Host, identityFile string) ([]byte, error) {
	switch {
	case !ValidAlias(h.Alias):
		return nil, fmt.Errorf("tên gợi nhớ %q không hợp lệ: chỉ chữ, số, dấu chấm, gạch dưới, gạch ngang", h.Alias)
	case !ValidHost(h.HostName):
		return nil, fmt.Errorf("địa chỉ máy chủ %q không hợp lệ", h.HostName)
	case !ValidUser(h.User):
		return nil, fmt.Errorf("tên đăng nhập %q không hợp lệ", h.User)
	case h.Port < 1 || h.Port > 65535:
		return nil, fmt.Errorf("cổng %d không hợp lệ", h.Port)
	case identityFile == "" || strings.ContainsAny(identityFile, "\r\n\""):
		return nil, fmt.Errorf("đường dẫn khoá %q không hợp lệ", identityFile)
	}
	lines := splitLines(data)
	for _, l := range lines {
		if l.key != "host" {
			continue
		}
		for _, p := range l.args {
			if strings.EqualFold(p, h.Alias) {
				return nil, ErrAliasExists
			}
		}
	}
	nl := newline(data)
	block := strings.Join([]string{
		beginMarker + h.Alias,
		"Host " + h.Alias,
		"    HostName " + h.HostName,
		"    User " + h.User,
		"    Port " + strconv.Itoa(h.Port),
		"    IdentityFile " + quoteArg(identityFile),
		"    IdentitiesOnly yes",
		endMarker,
	}, nl) + nl
	var out strings.Builder
	inserted := false
	for _, l := range lines {
		if !inserted && ((l.key == "host" && len(l.args) == 1 && l.args[0] == "*") ||
			(l.key == "match" && len(l.args) == 1 && strings.EqualFold(l.args[0], "all"))) {
			out.WriteString(block + nl)
			inserted = true
		}
		out.WriteString(l.raw)
	}
	if !inserted {
		if len(data) > 0 {
			if !bytes.HasSuffix(data, []byte("\n")) {
				out.WriteString(nl)
			}
			out.WriteString(nl)
		}
		out.WriteString(block)
	}
	return []byte(out.String()), nil
}

func quoteArg(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

// RemoveBlock gỡ khối của app cho alias, kèm dòng trống AddBlock đã thêm (sau khối, hoặc trước khối nếu khối ở cuối).
func RemoveBlock(data []byte, alias string) ([]byte, error) {
	lines := splitLines(data)
	begin := -1
	for i, l := range lines {
		if l.trimmed == beginMarker+alias {
			begin = i
			break
		}
	}
	if begin < 0 {
		return nil, ErrNotManaged
	}
	end := -1
	for j := begin + 1; j < len(lines); j++ {
		if strings.HasPrefix(lines[j].trimmed, beginMarker) {
			break
		}
		if lines[j].trimmed == endMarker {
			end = j
			break
		}
	}
	if end < 0 {
		return nil, ErrUnclosedBlock
	}
	switch {
	case end+1 < len(lines) && lines[end+1].trimmed == "":
		end++
	case end+1 == len(lines) && begin > 0 && lines[begin-1].trimmed == "":
		begin--
	}
	var out strings.Builder
	for i, l := range lines {
		if i < begin || i > end {
			out.WriteString(l.raw)
		}
	}
	return []byte(out.String()), nil
}

const keepBackups = 5

// WriteFileSafe ghi file qua file tạm rồi đổi tên đè, để ssh không bao giờ đọc thấy file ghi dở. Quyền của file cũ được
// chép sang (Windows: owner và DACL), vì OpenSSH từ chối config người khác sửa được. backup: giữ bản cũ thành
// `<tên>.xdev-hive-YYYYMMDD-HHMMSS.bak`, chỉ giữ 5 bản mới nhất.
func WriteFileSafe(path string, data []byte, backup bool, now time.Time) error {
	// ~/.ssh/config hay là symlink tới repo dotfiles: ghi vào file đích, không thay symlink bằng file thường.
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	dir, base := filepath.Dir(path), filepath.Base(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	_, statErr := os.Stat(path)
	exists := statErr == nil
	if exists && backup {
		if err := backupFile(path, now); err != nil {
			return fmt.Errorf("không sao lưu được %s: %w", path, err)
		}
	}
	tmp, err := os.CreateTemp(dir, base+".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if exists {
		err = copySecurity(path, tmpName)
	} else {
		err = newFileMode(tmpName, 0o600)
	}
	if err != nil {
		return fmt.Errorf("không đặt được quyền cho %s: %w", path, err)
	}
	return os.Rename(tmpName, path)
}

func backupFile(path string, now time.Time) error {
	old, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	prefix := path + ".xdev-hive-"
	name := prefix + now.Format("20060102-150405") + ".bak"
	// Hai lần ghi trong cùng một giây không được đè bản sao lưu của lần trước. `_` xếp sau `.` nên tên vẫn theo thứ tự.
	for i := 2; fileExists(name); i++ {
		name = prefix + now.Format("20060102-150405") + "_" + strconv.Itoa(i) + ".bak"
	}
	if err := os.WriteFile(name, old, 0o600); err != nil {
		return err
	}
	if err := copySecurity(path, name); err != nil {
		return err
	}
	all, _ := filepath.Glob(prefix + "*.bak")
	sort.Strings(all)
	for len(all) > keepBackups {
		_ = os.Remove(all[0])
		all = all[1:]
	}
	return nil
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
