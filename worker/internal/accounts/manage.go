package accounts

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Save ghi accounts.json (0600, thay nguyên file) để worker đang chạy không bao giờ đọc phải file ghi dở.
func Save(path string, maxParallel int, list []Account) error {
	return writeJSON(path, file{MaxParallel: maxParallel, Accounts: list})
}

// modify đọc, sửa rồi ghi accounts.json trong lúc giữ khoá, để hai lệnh của app chạy cùng lúc không ghi đè nhau.
func modify(path string, change func(*file) error) error {
	return withLock(path, func() error {
		f, err := read(path)
		if err != nil {
			return err
		}
		if err := change(&f); err != nil {
			return err
		}
		return Save(path, f.MaxParallel, f.Accounts)
	})
}

func find(f *file, id string) (*Account, error) {
	for i := range f.Accounts {
		if f.Accounts[i].ID == id {
			return &f.Accounts[i], nil
		}
	}
	return nil, fmt.Errorf("không có tài khoản %q", id)
}

// SetEnabled bật hoặc tắt một tài khoản.
func SetEnabled(path, id string, enabled bool) error {
	return modify(path, func(f *file) error {
		a, err := find(f, id)
		if err == nil {
			a.Enabled = enabled
		}
		return err
	})
}

// legacyConfig là phần cần đọc trong ~/.xdev-hive/config.json của app v1.
type legacyConfig struct {
	Agents []struct {
		ID              string            `json:"id"`
		Label           string            `json:"label"`
		Kind            string            `json:"kind"`
		Env             map[string]string `json:"env"`
		Enabled         bool              `json:"enabled"`
		Priority        int               `json:"priority"`
		MaxConcurrent   int               `json:"maxConcurrent"`
		CooldownMinutes int               `json:"cooldownMinutes"`
		StopAtSession   int               `json:"stopAtSession"`
		StopAtWeek      int               `json:"stopAtWeek"`
		Roles           []string          `json:"roles"`
		TimeoutMinutes  int               `json:"timeoutMinutes"`
	} `json:"agents"`
	Runner struct {
		MaxParallel int `json:"maxParallel"`
	} `json:"runner"`
}

// LegacyPath là file cấu hình của app v1.
func LegacyPath(home string) string { return filepath.Join(home, ".xdev-hive", "config.json") }

// ImportLegacy chép danh sách tài khoản của app v1 sang accounts.json, một lần: accounts.json đã có thì không làm gì
// (trả 0) trừ khi force. Chỉ đọc nhãn, CLI, thư mục cấu hình, cách chọn, ngưỡng quota, vai trò và thời hạn run; biến
// môi trường khác của app v1 (có thể chứa khoá API) không được chép.
func ImportLegacy(legacy, dst string, force bool) (int, error) {
	if !force {
		if _, err := os.Stat(dst); err == nil {
			return 0, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return 0, err
		}
	}
	b, err := os.ReadFile(legacy)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var c legacyConfig
	if err := json.Unmarshal(b, &c); err != nil {
		return 0, fmt.Errorf("đọc %s: %w", legacy, err)
	}
	list := make([]Account, 0, len(c.Agents))
	for _, a := range c.Agents {
		if a.ID == "" {
			continue
		}
		dir := ""
		if v, ok := envVar[a.Kind]; ok {
			dir = a.Env[v]
		}
		// App v1 có vai trò research, classify… mà worker không giao: chỉ giữ ba vai trò của tài khoản.
		var roles []string
		for _, r := range a.Roles {
			if validRole(r) {
				roles = append(roles, r)
			}
		}
		list = append(list, Account{
			ID:              a.ID,
			Label:           a.Label,
			CLI:             a.Kind,
			ConfigDir:       dir,
			Enabled:         a.Enabled,
			Priority:        a.Priority,
			MaxConcurrent:   a.MaxConcurrent,
			CooldownMinutes: a.CooldownMinutes,
			StopAtSession:   a.StopAtSession,
			StopAtWeek:      a.StopAtWeek,
			Roles:           roles,
			TimeoutMinutes:  a.TimeoutMinutes,
		}.withDefaults())
	}
	if len(list) == 0 {
		return 0, nil
	}
	return len(list), Save(dst, c.Runner.MaxParallel, list)
}

func validRole(r string) bool {
	for _, x := range Roles {
		if x == r {
			return true
		}
	}
	return false
}

// emailPattern: email đi vào lệnh đăng nhập app chạy trong Terminal, nên không có khoảng trắng, dấu nháy hay ký tự shell.
var emailPattern = regexp.MustCompile("^[^\\s@\"'`$\\\\%^&|<>;()]{1,100}@[^\\s@\"'`$\\\\%^&|<>;()]{1,100}$")

// loginHows là cách đăng nhập mỗi CLI nhận; cách đầu tiên là mặc định.
var loginHows = map[string][]string{"claude": {"plan", "sso", "console"}, "codex": {"browser", "device"}}

// Add thêm một tài khoản cho CLI và trả lệnh đăng nhập cùng biến môi trường để app mở Terminal chạy. Id là <cli>-<n>
// nhỏ nhất còn trống. Tài khoản đầu tiên của CLI dùng thư mục mặc định (đăng nhập sẵn có của máy); các tài khoản sau
// có thư mục riêng ~/.xdev-hive/accounts/<id> như app v1.
func Add(path, home, cli, label, how, email string) (Account, string, map[string]string, error) {
	hows, ok := loginHows[cli]
	if !ok {
		return Account{}, "", nil, errors.New("CLI phải là claude hoặc codex")
	}
	label = strings.TrimSpace(label)
	if err := checkLabel(label); err != nil {
		return Account{}, "", nil, err
	}
	if how == "" {
		how = hows[0]
	}
	if !contains(hows, how) {
		return Account{}, "", nil, fmt.Errorf("%s không đăng nhập theo cách %q; chọn một trong: %s", cli, how, strings.Join(hows, ", "))
	}
	email = strings.TrimSpace(email)
	if email != "" && cli != "claude" {
		return Account{}, "", nil, errors.New("chỉ Claude nhận --email")
	}
	if email != "" && !emailPattern.MatchString(email) {
		return Account{}, "", nil, fmt.Errorf("email không hợp lệ: %s", email)
	}
	var added Account
	err := modify(path, func(f *file) error {
		taken := map[string]bool{}
		first := true
		for _, a := range f.Accounts {
			taken[a.ID] = true
			first = first && a.CLI != cli
		}
		n := 1
		for taken[cli+"-"+strconv.Itoa(n)] {
			n++
		}
		added = Account{ID: cli + "-" + strconv.Itoa(n), Label: label, CLI: cli, Enabled: true}.withDefaults()
		if !first {
			added.ConfigDir = "~/.xdev-hive/accounts/" + added.ID
			// CLI tự tạo thư mục cấu hình nhưng với quyền mặc định; thư mục giữ token đăng nhập chỉ chủ máy đọc được.
			if err := os.MkdirAll(expandHome(home, added.ConfigDir), 0o700); err != nil {
				return err
			}
		}
		f.Accounts = append(f.Accounts, added)
		return nil
	})
	if err != nil {
		return Account{}, "", nil, err
	}
	command := cli + " login"
	if cli == "claude" {
		command = "claude auth login"
	}
	switch how {
	case "sso", "console":
		command += " --" + how
	case "device":
		command += " --device-auth"
	}
	if email != "" {
		command += " --email " + email
	}
	env := map[string]string{}
	if added.ConfigDir != "" {
		env[envVar[cli]] = expandHome(home, added.ConfigDir)
	}
	return added, command, env, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func checkLabel(label string) error {
	if label == "" {
		return errors.New("cần tên tài khoản")
	}
	if utf8.RuneCountInString(label) > 80 {
		return errors.New("tên tài khoản tối đa 80 ký tự")
	}
	return nil
}

// Changes là các trường đổi của một tài khoản; nil là giữ nguyên.
type Changes struct {
	Label           *string
	Priority        *int
	MaxConcurrent   *int
	CooldownMinutes *int
	StopAtSession   *int
	StopAtWeek      *int
	TimeoutMinutes  *int
	Roles           []string
}

// Khoảng giá trị như app v1.
var ranges = []struct {
	field    func(*Changes) *int
	set      func(*Account, int)
	min, max int
	message  string
}{
	{func(c *Changes) *int { return c.Priority }, func(a *Account, v int) { a.Priority = v }, 0, 100, "ưu tiên phải từ 0 đến 100"},
	{func(c *Changes) *int { return c.MaxConcurrent }, func(a *Account, v int) { a.MaxConcurrent = v }, 1, 8, "số run cùng lúc phải từ 1 đến 8"},
	{func(c *Changes) *int { return c.CooldownMinutes }, func(a *Account, v int) { a.CooldownMinutes = v }, 1, 24 * 60, "thời gian nghỉ phải từ 1 đến 1440 phút"},
	{func(c *Changes) *int { return c.StopAtSession }, func(a *Account, v int) { a.StopAtSession = v }, 1, 100, "ngưỡng dừng phiên phải từ 1 đến 100%"},
	{func(c *Changes) *int { return c.StopAtWeek }, func(a *Account, v int) { a.StopAtWeek = v }, 1, 100, "ngưỡng dừng tuần phải từ 1 đến 100%"},
	{func(c *Changes) *int { return c.TimeoutMinutes }, func(a *Account, v int) { a.TimeoutMinutes = v }, 1, 12 * 60, "thời hạn run phải từ 1 đến 720 phút"},
}

// Update đổi các trường của một tài khoản sau khi kiểm khoảng giá trị; một trường sai thì không đổi gì.
func Update(path, id string, c Changes) error {
	if c.Label != nil {
		trimmed := strings.TrimSpace(*c.Label)
		if err := checkLabel(trimmed); err != nil {
			return err
		}
		c.Label = &trimmed
	}
	for _, r := range ranges {
		if v := r.field(&c); v != nil && (*v < r.min || *v > r.max) {
			return errors.New(r.message)
		}
	}
	var roles []string
	if c.Roles != nil {
		for _, r := range c.Roles {
			r = strings.TrimSpace(r)
			if r == "" || contains(roles, r) {
				continue
			}
			if !validRole(r) {
				return fmt.Errorf("vai trò %q không có; chọn trong: %s", r, strings.Join(Roles, ", "))
			}
			roles = append(roles, r)
		}
		if len(roles) == 0 {
			return errors.New("cần ít nhất một vai trò")
		}
	}
	return modify(path, func(f *file) error {
		a, err := find(f, id)
		if err != nil {
			return err
		}
		if c.Label != nil {
			a.Label = *c.Label
		}
		for _, r := range ranges {
			if v := r.field(&c); v != nil {
				r.set(a, *v)
			}
		}
		if roles != nil {
			a.Roles = roles
		}
		return nil
	})
}

// Remove bỏ tài khoản khỏi danh sách và trạng thái của nó. Thư mục đăng nhập giữ nguyên: thêm lại thì không phải đăng
// nhập lại, và worker không xoá dữ liệu của CLI.
func Remove(path, id string, now time.Time) error {
	err := modify(path, func(f *file) error {
		for i, a := range f.Accounts {
			if a.ID == id {
				f.Accounts = append(f.Accounts[:i], f.Accounts[i+1:]...)
				return nil
			}
		}
		return fmt.Errorf("không có tài khoản %q", id)
	})
	if err != nil {
		return err
	}
	return UpdateState(StatePath(path), now, func(s *State) {
		delete(s.CoolUntil, id)
		delete(s.ResumeUntil, id)
		delete(s.Usage, id)
	})
}

// resumeFallback: không biết giờ reset của thanh đang vượt thì "Dùng tiếp" giữ chừng một phiên 5 giờ.
const resumeFallback = 5 * time.Hour

// Resume là "Dùng tiếp" của app v1: bỏ nghỉ và tạm bỏ ngưỡng dừng tới lần reset muộn nhất trong các thanh đang vượt.
// Người dùng chấp nhận rủi ro; hết lượt thật thì CLI vẫn báo và tài khoản lại nghỉ.
func Resume(path, id string, now time.Time) error {
	list, err := Load(path)
	if err != nil {
		return err
	}
	var account *Account
	for i := range list {
		if list[i].ID == id {
			account = &list[i]
		}
	}
	if account == nil {
		return fmt.Errorf("không có tài khoản %q", id)
	}
	return UpdateState(StatePath(path), now, func(s *State) {
		delete(s.CoolUntil, id)
		delete(s.ResumeUntil, id)
		u := s.Usage[id].at(now)
		var until time.Time
		for _, bar := range []struct {
			limit *Limit
			stop  int
		}{{u.Session, account.StopAtSession}, {u.Week, account.StopAtWeek}} {
			if bar.limit == nil || bar.limit.Percent < float64(bar.stop) {
				continue
			}
			end := now.Add(resumeFallback)
			if bar.limit.ResetsAt != nil && bar.limit.ResetsAt.After(now) {
				end = *bar.limit.ResetsAt
			}
			if end.After(until) {
				until = end
			}
		}
		if !until.IsZero() {
			s.ResumeUntil[id] = until.UTC()
		}
	})
}

// Trạng thái một tài khoản hiện trên app; tài khoản ở trạng thái đầu tiên đúng theo thứ tự này, như app v1: việc máy
// đang làm quan trọng hơn việc nó chưa được bắt đầu.
const (
	StateDisabled  = "disabled"
	StateNoCLI     = "noCli"
	StateSignedOut = "signedOut"
	StateRunning   = "running"
	StateOverLimit = "overLimit"
	StateCooling   = "cooling"
	StateNear      = "near"
	StateReady     = "ready"
)

// nearPercent: một thanh quota từ mức này là "gần ngưỡng", như app v1.
const nearPercent = 85

// View là tài khoản kèm trạng thái đọc từ máy, cho app hiện danh sách.
type View struct {
	Account
	// Supported: worker chọn được tài khoản của CLI này.
	Supported bool `json:"supported"`
	// LoggedIn: thư mục cấu hình có đăng nhập của CLI; null khi không biết cách kiểm CLI này.
	LoggedIn *bool  `json:"loggedIn"`
	Email    string `json:"email,omitempty"`
	Usage    Usage  `json:"usage"`
	State    string `json:"state"`
	// CoolUntil, ResumeUntil: giờ hết nghỉ và hết "Dùng tiếp"; null khi không có hoặc đã qua.
	CoolUntil   *time.Time `json:"coolUntil"`
	Active      int        `json:"active"`
	ResumeUntil *time.Time `json:"resumeUntil"`
}

// Views đọc trạng thái đăng nhập, quota và trạng thái chạy của từng tài khoản. Chỉ đọc email để hiện; không đọc hay
// trả token.
func Views(list []Account, st State, home string, now time.Time) []View {
	out := make([]View, 0, len(list))
	for _, a := range list {
		v := View{Account: a, Supported: Supported(a.CLI), Active: st.Active[a.ID]}
		v.LoggedIn, v.Email = loginOf(a, home)
		if at, ok := st.CoolUntil[a.ID]; ok && at.After(now) {
			v.CoolUntil = &at
		}
		if at, ok := st.ResumeUntil[a.ID]; ok && at.After(now) {
			v.ResumeUntil = &at
		}
		signedOut := v.LoggedIn != nil && !*v.LoggedIn
		u, read := st.Usage[a.ID]
		switch {
		case !v.Supported:
			v.Usage = noUsage(reasonUnsupported)
		case signedOut:
			v.Usage = noUsage(reasonSignedOut)
		case !read:
			v.Usage = noUsage(reasonNotRead)
		default:
			v.Usage = u.at(now)
		}
		noCLI := false
		if v.Supported {
			_, err := lookPath(a.CLI)
			noCLI = err != nil
		}
		resume := time.Time{}
		if v.ResumeUntil != nil {
			resume = *v.ResumeUntil
		}
		switch {
		case !a.Enabled:
			v.State = StateDisabled
		case noCLI:
			v.State = StateNoCLI
		case signedOut:
			v.State = StateSignedOut
		case v.Active > 0:
			v.State = StateRunning
		case a.overLimit(v.Usage, resume, now) != "":
			v.State = StateOverLimit
		case v.CoolUntil != nil:
			v.State = StateCooling
		case near(v.Usage):
			v.State = StateNear
		default:
			v.State = StateReady
		}
		out = append(out, v)
	}
	return out
}

func near(u Usage) bool {
	return (u.Session != nil && u.Session.Percent >= nearPercent) || (u.Week != nil && u.Week.Percent >= nearPercent)
}

// loginOf đọc đăng nhập trong thư mục cấu hình của tài khoản: nil khi không biết cách kiểm CLI này.
func loginOf(a Account, home string) (*bool, string) {
	dir := expandHome(home, a.ConfigDir)
	var ok bool
	var email string
	switch a.CLI {
	case "claude":
		file := filepath.Join(home, ".claude.json")
		if dir != "" {
			file = filepath.Join(dir, ".claude.json")
		}
		ok, email = claudeLogin(file)
	case "codex":
		if dir == "" {
			dir = filepath.Join(home, ".codex")
		}
		ok, email = codexLogin(filepath.Join(dir, "auth.json"))
	default:
		return nil, ""
	}
	return &ok, email
}

func claudeLogin(path string) (bool, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, ""
	}
	var c struct {
		OAuthAccount *struct {
			EmailAddress string `json:"emailAddress"`
		} `json:"oauthAccount"`
	}
	if json.Unmarshal(b, &c) != nil || c.OAuthAccount == nil {
		return false, ""
	}
	return true, c.OAuthAccount.EmailAddress
}

func codexLogin(path string) (bool, string) {
	b, err := os.ReadFile(path)
	if err != nil {
		return false, ""
	}
	var c struct {
		APIKey *string `json:"OPENAI_API_KEY"`
		Tokens *struct {
			IDToken string `json:"id_token"`
		} `json:"tokens"`
	}
	if json.Unmarshal(b, &c) != nil {
		return false, ""
	}
	if c.Tokens == nil {
		return c.APIKey != nil && *c.APIKey != "", ""
	}
	return true, jwtEmail(c.Tokens.IDToken)
}

// jwtEmail đọc email trong phần thân id_token để hiện tên tài khoản; không kiểm chữ ký vì không dùng để xác thực.
func jwtEmail(token string) string {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return ""
	}
	var claims struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(raw, &claims) != nil {
		return ""
	}
	return claims.Email
}
