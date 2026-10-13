package accounts

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Found là một đăng nhập CLI có trên máy mà accounts.json chưa có, cho app gợi ý thêm.
type Found struct {
	CLI string `json:"cli"`
	// ConfigDir viết dạng "~/…" như accounts.json; nil là đăng nhập mặc định của CLI.
	ConfigDir *string `json:"configDir"`
	// LoggedIn: nil khi không kiểm được từ file (Antigravity giữ đăng nhập trong keyring).
	LoggedIn    *bool   `json:"loggedIn"`
	Email       *string `json:"email"`
	SuggestedID string  `json:"suggestedId"`
	Note        *string `json:"note"`
}

// AccountsDir là thư mục app v1 và lệnh add tạo thư mục cấu hình riêng cho từng tài khoản.
func AccountsDir(home string) string { return filepath.Join(home, ".xdev-hive", "accounts") }

// configFiles là file CLI ghi vào thư mục cấu hình; thư mục không có file nào là chưa từng dùng, không gợi ý.
var configFiles = map[string][]string{
	"claude": {".claude.json", ".credentials.json", "settings.json"},
	"codex":  {"auth.json", "config.toml"},
}

// agyHome là thư mục cấu hình của agy; agy luôn dùng thư mục này trong HOME.
func agyHome(home string) string { return filepath.Join(home, ".gemini", "antigravity-cli") }

var numberedID = regexp.MustCompile(`^(claude|codex)-[0-9]+$`)

// guessCLI đoán CLI của một thư mục trong AccountsDir: theo tên (claude-3, codex-2) như app v1 đặt, không thì theo file
// bên trong. Rỗng khi không đoán được.
func guessCLI(dir string) string {
	name := filepath.Base(dir)
	for _, cli := range []string{"claude", "codex"} {
		if strings.HasPrefix(name, cli+"-") {
			return cli
		}
	}
	switch {
	case exists(filepath.Join(dir, ".claude.json")):
		return "claude"
	case exists(filepath.Join(dir, "auth.json")):
		return "codex"
	}
	return ""
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func hasConfig(cli, dir string) bool {
	for _, f := range configFiles[cli] {
		if exists(filepath.Join(dir, f)) {
			return true
		}
	}
	return false
}

// samePath so hai thư mục sau khi mở "~" và symlink (macOS có /var → /private/var).
func samePath(a, b string) bool {
	clean := func(p string) string {
		p = filepath.Clean(p)
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return p
	}
	return clean(a) == clean(b)
}

// defaultDir là thư mục cấu hình mặc định của CLI, để so tài khoản ghi rỗng với tài khoản ghi "~/.codex".
func defaultDir(home, cli string) string {
	switch cli {
	case "claude":
		return filepath.Join(home, ".claude")
	case "codex":
		return filepath.Join(home, ".codex")
	}
	return ""
}

// tildePath viết dir dạng "~/…" khi nằm trong home để accounts.json dùng được khi đổi tên người dùng máy.
func tildePath(home, dir string) string {
	rel, err := filepath.Rel(home, dir)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return dir
	}
	return "~/" + filepath.ToSlash(rel)
}

// candidate là một đăng nhập tìm thấy, kèm đường dẫn thật để so với tài khoản đã có.
type candidate struct {
	cli  string
	dir  string // đường dẫn thật; rỗng là mặc định
	name string // tên thư mục trong AccountsDir, để giữ id cũ của app v1
}

func (c candidate) path(home string) string {
	if c.dir != "" {
		return c.dir
	}
	return defaultDir(home, c.cli)
}

// candidates là mọi đăng nhập CLI trên máy: thư mục trong AccountsDir rồi đăng nhập mặc định của Claude, Codex,
// Antigravity.
func candidates(home string) []candidate {
	var out []candidate
	entries, _ := os.ReadDir(AccountsDir(home))
	for _, e := range entries {
		dir := filepath.Join(AccountsDir(home), e.Name())
		if !e.IsDir() {
			continue
		}
		cli := guessCLI(dir)
		if cli == "" || !hasConfig(cli, dir) {
			continue
		}
		out = append(out, candidate{cli: cli, dir: dir, name: e.Name()})
	}
	// Claude mặc định ghi đăng nhập vào ~/.claude.json, cấu hình vào ~/.claude.
	if exists(filepath.Join(home, ".claude.json")) || exists(filepath.Join(home, ".claude")) {
		out = append(out, candidate{cli: "claude"})
	}
	if hasConfig("codex", defaultDir(home, "codex")) {
		out = append(out, candidate{cli: "codex"})
	}
	if exists(agyHome(home)) {
		out = append(out, candidate{cli: "antigravity"})
	}
	return out
}

// known cho biết đăng nhập đã có trong danh sách: cùng thư mục cấu hình, hay với Antigravity là đã có tài khoản nào
// (agy chỉ có đăng nhập mặc định).
func known(list []Account, home string, c candidate) bool {
	for _, a := range list {
		if c.cli == "antigravity" {
			if a.CLI == "antigravity" {
				return true
			}
			continue
		}
		dir := expandHome(home, a.ConfigDir)
		if dir == "" {
			dir = defaultDir(home, a.CLI)
		}
		if dir != "" && samePath(dir, c.path(home)) {
			return true
		}
	}
	return false
}

// Discover tìm đăng nhập CLI trên máy mà accounts.json chưa có. Chỉ đọc file cấu hình để biết đã đăng nhập chưa và
// email; không đọc hay trả token.
func Discover(path, home string) ([]Found, error) {
	list, err := Load(path)
	if err != nil {
		return nil, err
	}
	found, _ := discover(list, home)
	return found, nil
}

func discover(list []Account, home string) ([]Found, []candidate) {
	taken := map[string]bool{}
	for _, a := range list {
		taken[a.ID] = true
	}
	// Tên thư mục trong AccountsDir để dành cho chính thư mục đó: id gợi ý cho đăng nhập mặc định không trùng.
	entries, _ := os.ReadDir(AccountsDir(home))
	for _, e := range entries {
		if numberedID.MatchString(e.Name()) {
			taken[e.Name()] = true
		}
	}
	// Cùng email ở hai CLI khác nhau (gói Claude và gói Codex của một người) là hai gói thật, nên chỉ so trong cùng CLI.
	emails := map[string]string{}
	for _, a := range list {
		if _, email := loginOf(a, home); email != "" {
			key := a.CLI + "\x00" + strings.ToLower(email)
			if _, ok := emails[key]; !ok {
				emails[key] = a.ID
			}
		}
	}
	var found []Found
	var cands []candidate
	for _, c := range candidates(home) {
		if known(list, home, c) {
			continue
		}
		f := Found{CLI: c.cli}
		account := Account{CLI: c.cli}
		if c.dir != "" {
			dir := tildePath(home, c.dir)
			f.ConfigDir, account.ConfigDir = &dir, dir
		}
		if ok, email := loginOf(account, home); ok != nil {
			f.LoggedIn = ok
			if email != "" {
				f.Email = &email
				if id, dup := emails[c.cli+"\x00"+strings.ToLower(email)]; dup {
					note := "Trùng email với " + id
					f.Note = &note
				}
			}
		} else if c.cli == "antigravity" {
			note := "Antigravity giữ đăng nhập trong keyring, worker không kiểm được"
			f.Note = &note
		}
		if c.name != "" && numberedID.MatchString(c.name) && strings.HasPrefix(c.name, c.cli+"-") && !idUsed(list, c.name) {
			f.SuggestedID = c.name
		} else {
			f.SuggestedID = nextID(taken, c.cli)
		}
		taken[f.SuggestedID] = true
		found = append(found, f)
		cands = append(cands, c)
	}
	return found, cands
}

func idUsed(list []Account, id string) bool {
	for _, a := range list {
		if a.ID == id {
			return true
		}
	}
	return false
}

func nextID(taken map[string]bool, cli string) string {
	n := 1
	for taken[cli+"-"+strconv.Itoa(n)] {
		n++
	}
	return cli + "-" + strconv.Itoa(n)
}

// AddFound thêm một đăng nhập Discover tìm thấy, như Add nhưng không mở đăng nhập: source là thư mục cấu hình (nhận
// "~/") hoặc "default:<cli>" cho đăng nhập mặc định. Tên rỗng thì lấy email, không có email thì id.
func AddFound(path, home, source, label string) (Account, error) {
	source = strings.TrimSpace(source)
	label = strings.TrimSpace(label)
	if label != "" {
		if err := checkLabel(label); err != nil {
			return Account{}, err
		}
	}
	var added Account
	err := modify(path, func(f *file) error {
		found, cands := discover(f.Accounts, home)
		for i, c := range cands {
			if !matches(home, source, c) {
				continue
			}
			added = Account{ID: found[i].SuggestedID, Label: label, CLI: c.cli, Enabled: true}.withDefaults()
			if found[i].ConfigDir != nil {
				added.ConfigDir = *found[i].ConfigDir
			}
			if added.Label == "" && found[i].Email != nil {
				added.Label = *found[i].Email
			}
			if added.Label == "" {
				added.Label = added.ID
			}
			f.Accounts = append(f.Accounts, added)
			return nil
		}
		return fmt.Errorf("không tìm thấy đăng nhập %s trên máy, hoặc đã có trong danh sách", source)
	})
	return added, err
}

func matches(home, source string, c candidate) bool {
	if cli, ok := strings.CutPrefix(source, "default:"); ok {
		return c.dir == "" && cli == c.cli
	}
	if source == "" || c.dir == "" {
		return false
	}
	return samePath(expandHome(home, source), c.dir)
}
