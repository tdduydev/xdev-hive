package accounts

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	// Giờ reset của Claude ghi theo múi giờ IANA (Asia/Saigon); Windows không có cơ sở dữ liệu múi giờ của hệ thống.
	_ "time/tzdata"
)

// Limit là một thanh quota của gói: phần trăm đã dùng và lúc reset (nil khi CLI không báo hoặc không đọc được).
type Limit struct {
	Percent  float64    `json:"percent"`
	ResetsAt *time.Time `json:"resetsAt"`
}

// Usage là quota của gói: phiên 5 giờ và tuần. Reason nói vì sao không có số, để app không phải đoán.
type Usage struct {
	Session   *Limit     `json:"session"`
	Week      *Limit     `json:"week"`
	CheckedAt *time.Time `json:"checkedAt"`
	Reason    *string    `json:"reason"`
	// Models là tuần riêng của từng model (Claude: "Current week (Sonnet only)", …); ngưỡng dừng chỉ xét Week.
	Models []ModelLimit `json:"models,omitempty"`
	// Groups là hạn mức của từng nhóm model (Antigravity); Session, Week là của nhóm worker dùng cho run code.
	Groups []Group `json:"groups,omitempty"`
}

// ModelLimit là thanh tuần riêng của một model.
type ModelLimit struct {
	Name     string     `json:"name"`
	Percent  float64    `json:"percent"`
	ResetsAt *time.Time `json:"resetsAt"`
}

// Group là một nhóm model của Antigravity: các model trong nhóm dùng chung hạn mức 5 giờ và tuần.
type Group struct {
	Name    string `json:"name"`
	Models  string `json:"models"`
	Session *Limit `json:"session"`
	Week    *Limit `json:"week"`
	// SessionDisabled: agy tạm bỏ hạn mức 5 giờ (thường vì đã hết tuần); Session khi đó là nil.
	SessionDisabled bool `json:"sessionDisabled"`
}

// Lý do không có số quota, hiện thẳng trên app.
const (
	reasonSignedOut   = "Chưa đăng nhập"
	reasonNoCLI       = "Chưa có CLI trên máy"
	reasonSilent      = "CLI không báo"
	reasonNoSession   = "Codex chưa có phiên nào trên máy"
	reasonUnsupported = "Worker chưa đọc quota của CLI này"
	reasonNotRead     = "Chưa đọc quota"
	reasonAgyDir      = "Antigravity chỉ đọc được đăng nhập mặc định của máy"
)

func reason(s string) *string { return &s }

func noUsage(why string) Usage { return Usage{Reason: reason(why)} }

// at trả quota như lúc now: thanh đã qua giờ reset thì đã về 0, dù lần đọc cuối còn số cũ (đọc 10 phút một lần; Codex
// chỉ ghi số khi có lượt chạy).
func (u Usage) at(now time.Time) Usage {
	fresh := func(l *Limit) *Limit {
		if l == nil || l.ResetsAt == nil || l.ResetsAt.After(now) {
			return l
		}
		return &Limit{}
	}
	u.Session, u.Week = fresh(u.Session), fresh(u.Week)
	// Chép mảng: Usage trong State dùng chung mảng với bản gốc, sửa tại chỗ sẽ đổi cả trạng thái đã đọc.
	if u.Models != nil {
		models := make([]ModelLimit, len(u.Models))
		for i, m := range u.Models {
			if m.ResetsAt != nil && !m.ResetsAt.After(now) {
				m = ModelLimit{Name: m.Name}
			}
			models[i] = m
		}
		u.Models = models
	}
	if u.Groups != nil {
		groups := make([]Group, len(u.Groups))
		for i, g := range u.Groups {
			g.Session, g.Week = fresh(g.Session), fresh(g.Week)
			groups[i] = g
		}
		u.Groups = groups
	}
	return u
}

// Test thay lệnh CLI và tìm CLI trên PATH để không chạy CLI thật.
var (
	lookPath = exec.LookPath
	runCLI   = func(ctx context.Context, name string, args []string, env map[string]string) ([]byte, error) {
		cmd := exec.CommandContext(ctx, name, args...)
		// Ngoài mọi repo: lệnh đọc quota không được nạp cấu hình của một dự án.
		cmd.Dir = os.TempDir()
		cmd.Env = usageEnv(os.Environ(), env)
		return cmd.Output()
	}
)

// usageEnv là môi trường của lệnh đọc quota: env của gói đặt trên env kế thừa đã bỏ biến chọn đăng nhập (xem
// loginVars), nên gói đăng nhập mặc định đọc đúng đăng nhập mặc định.
func usageEnv(base []string, env map[string]string) []string {
	out := WithoutLogin(base, "")
	for k, v := range env {
		out = append(out, k+"="+v)
	}
	return out
}

// claudeUsageArgs: /usage của Claude Code trả lời tại máy, không tốn lượt của gói. Chỉ cấu hình của người dùng, không
// MCP, để lệnh đọc không khởi động gì khác.
var claudeUsageArgs = []string{"-p", "/usage", "--output-format", "json", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`}

// usageTimeout chặn một lần đọc /usage: CLI treo (mạng, cập nhật) không được giữ vòng đọc của worker.
const usageTimeout = time.Minute

// agyUsageArgs: /usage của agy là lệnh tại máy (num_turns 0), không tốn lượt của gói.
var agyUsageArgs = []string{"-p", "/usage", "--output-format", "json"}

// ReadUsage đọc quota của một tài khoản: Claude và Antigravity qua /usage, Codex qua file phiên. Chỉ đọc khi đã đăng
// nhập (Antigravity không kiểm được đăng nhập từ file, xem loginOf).
func ReadUsage(ctx context.Context, a Account, home string, now time.Time) Usage {
	if !Supported(a.CLI) {
		return noUsage(reasonUnsupported)
	}
	if ok, _ := loginOf(a, home); ok != nil && !*ok {
		return noUsage(reasonSignedOut)
	}
	dir := expandHome(home, a.ConfigDir)
	switch a.CLI {
	case "antigravity":
		// agy giữ đăng nhập trong keyring của hệ điều hành và không có biến chọn thư mục cấu hình: thư mục riêng không
		// tách được tài khoản, đọc ra sẽ là số của đăng nhập mặc định.
		if dir != "" {
			return noUsage(reasonAgyDir)
		}
		bin, err := lookPath(binary(a.CLI))
		if err != nil {
			return noUsage(reasonNoCLI)
		}
		ctx, cancel := context.WithTimeout(ctx, usageTimeout)
		defer cancel()
		out, _ := runCLI(ctx, bin, agyUsageArgs, nil)
		u := parseAgyUsage(out, now)
		if u == nil {
			return noUsage(reasonSilent)
		}
		return *u
	case "claude":
		bin, err := lookPath("claude")
		if err != nil {
			return noUsage(reasonNoCLI)
		}
		var env map[string]string
		if dir != "" {
			env = map[string]string{envVar["claude"]: dir}
			if token := oauthToken(dir); token != "" {
				env[tokenEnv] = token
			}
		}
		ctx, cancel := context.WithTimeout(ctx, usageTimeout)
		defer cancel()
		// Lỗi thoát vẫn đọc stdout: CLI có thể in kết quả rồi mới thoát khác 0.
		out, _ := runCLI(ctx, bin, claudeUsageArgs, env)
		u := parseClaudeUsage(claudeText(out), now)
		if u == nil {
			return noUsage(reasonSilent)
		}
		return *u
	default:
		if dir == "" {
			dir = filepath.Join(home, ".codex")
		}
		u := readCodexUsage(dir, now)
		if u == nil {
			return noUsage(reasonNoSession)
		}
		return *u
	}
}

// claudeText là câu trả lời của /usage trong kết quả `--output-format json`; không phải JSON thì dùng nguyên văn.
func claudeText(out []byte) string {
	type result struct {
		Type   string  `json:"type"`
		Result *string `json:"result"`
	}
	var r result
	if json.Unmarshal(bytes.TrimSpace(out), &r) == nil && r.Result != nil {
		return *r.Result
	}
	lines := strings.Split(string(out), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if !strings.HasPrefix(line, "{") {
			continue
		}
		if json.Unmarshal([]byte(line), &r) == nil && r.Type == "result" && r.Result != nil {
			return *r.Result
		}
	}
	return string(out)
}

// limitLine: "Current session: 40% used · resets Oct 13 at 1:39pm (Asia/Saigon)", "Current week (all models): 47% used
// · resets …". Dòng phiên có thể không có "· resets"; tuần theo từng model (Opus, Sonnet only, …) không phải thanh tuần
// mà là Models.
var limitLine = regexp.MustCompile(`^Current (session|week(?: \(([^)]+)\))?):\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+))?$`)

// parseClaudeUsage đọc thanh phiên, tuần và tuần theo model trong câu trả lời của /usage; nil khi không có thanh phiên
// hay tuần nào (khoá API, CLI cũ).
func parseClaudeUsage(text string, now time.Time) *Usage {
	var u Usage
	for _, line := range strings.Split(text, "\n") {
		m := limitLine.FindStringSubmatch(strings.TrimLeft(strings.TrimSpace(line), "-*• "))
		if m == nil {
			continue
		}
		percent, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			continue
		}
		l := &Limit{Percent: percent, ResetsAt: parseResetAt(m[4], now)}
		switch {
		case m[1] == "session":
			u.Session = l
		case m[2] == "" || strings.EqualFold(m[2], "all models"):
			u.Week = l
		default:
			// "Sonnet only" là tuần của riêng Sonnet: app hiện "Sonnet".
			name := strings.TrimSpace(m[2])
			if len(name) > len(" only") && strings.EqualFold(name[len(name)-len(" only"):], " only") {
				name = strings.TrimSpace(name[:len(name)-len(" only")])
			}
			u.Models = append(u.Models, ModelLimit{Name: name, Percent: l.Percent, ResetsAt: l.ResetsAt})
		}
	}
	if u.Session == nil && u.Week == nil {
		return nil
	}
	checked := now.UTC()
	u.CheckedAt = &checked
	return &u
}

// agyCodeGroup là nhóm model của agy mà run code của worker dùng (Claude, GPT); hạn mức của nhóm là Session, Week.
const agyCodeGroup = "Claude and GPT models"

type agyBucket struct {
	Window            string   `json:"window"`
	RemainingFraction *float64 `json:"remaining_fraction"`
	ResetTime         string   `json:"reset_time"`
	Disabled          bool     `json:"disabled"`
}

type agyUsage struct {
	Status  string `json:"status"`
	Command *struct {
		Name string `json:"name"`
		Data struct {
			Groups []struct {
				Name        string      `json:"name"`
				Description string      `json:"description"`
				Buckets     []agyBucket `json:"buckets"`
			} `json:"groups"`
		} `json:"data"`
	} `json:"command"`
}

// parseAgyUsage đọc kết quả `agy -p /usage --output-format json`: mỗi nhóm model có bucket "5h" và "weekly" ghi phần
// CÒN LẠI (remaining_fraction), đổi thành phần đã dùng như Claude, Codex. Nil khi không có nhóm nào đọc được.
func parseAgyUsage(out []byte, now time.Time) *Usage {
	var r agyUsage
	if json.Unmarshal(bytes.TrimSpace(out), &r) != nil || r.Command == nil || (r.Status != "" && r.Status != "SUCCESS") {
		return nil
	}
	var u Usage
	for _, g := range r.Command.Data.Groups {
		group := Group{Name: g.Name, Models: strings.TrimSpace(strings.TrimPrefix(g.Description, "Models within this group:"))}
		for _, b := range g.Buckets {
			switch b.Window {
			case "5h":
				// Bucket tắt vẫn ghi remaining_fraction cũ, không còn ý nghĩa.
				if b.Disabled {
					group.SessionDisabled = true
					continue
				}
				group.Session = agyLimit(b, now)
			case "weekly":
				if !b.Disabled {
					group.Week = agyLimit(b, now)
				}
			}
		}
		if group.Session == nil && group.Week == nil && !group.SessionDisabled {
			continue
		}
		u.Groups = append(u.Groups, group)
	}
	if len(u.Groups) == 0 {
		return nil
	}
	// Không có nhóm của run code (agy đổi tên nhóm) thì lấy nhóm dùng nhiều nhất để ngưỡng dừng không bỏ sót.
	top := -1
	for i, g := range u.Groups {
		if g.Name == agyCodeGroup {
			top = i
			break
		}
		if top < 0 || groupPercent(g) > groupPercent(u.Groups[top]) {
			top = i
		}
	}
	u.Session, u.Week = u.Groups[top].Session, u.Groups[top].Week
	checked := now.UTC()
	u.CheckedAt = &checked
	return &u
}

func agyLimit(b agyBucket, now time.Time) *Limit {
	if b.RemainingFraction == nil {
		return nil
	}
	// Làm tròn như số nguyên Claude in: 0.9754 còn lại là 2% đã dùng.
	used := math.Round(100 - *b.RemainingFraction*100)
	l := &Limit{Percent: max(0, min(100, used))}
	if at, err := time.Parse(time.RFC3339, b.ResetTime); err == nil {
		at = at.UTC()
		if !at.After(now) {
			return &Limit{}
		}
		l.ResetsAt = &at
	}
	return l
}

func groupPercent(g Group) float64 {
	p := -1.0
	for _, l := range []*Limit{g.Session, g.Week} {
		if l != nil && l.Percent > p {
			p = l.Percent
		}
	}
	return p
}

// resetText: "Oct 13 at 1:39pm (Asia/Saigon)", "1:39pm (Asia/Saigon)", "Oct 8, 6pm (Asia/Ho_Chi_Minh)".
var resetText = regexp.MustCompile(`(?i)^(?:([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,|\s+at)?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([A-Za-z0-9_+\-/]+)\)$`)

var months = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}

// parseResetAt đọc giờ reset Claude in sau "resets". CLI bỏ năm (lấy năm hiện tại của múi giờ đó, sang năm sau khi
// ngày đã qua hơn một ngày: "Jan 2" đọc ngày 30/12) và bỏ ngày khi reset trong hôm nay. Nil khi không đọc được.
func parseResetAt(text string, now time.Time) *time.Time {
	m := resetText.FindStringSubmatch(strings.TrimSpace(text))
	if m == nil {
		return nil
	}
	loc, err := time.LoadLocation(m[6])
	if err != nil {
		return nil
	}
	hour, _ := strconv.Atoi(m[3])
	minute := 0
	if m[4] != "" {
		minute, _ = strconv.Atoi(m[4])
	}
	if m[5] != "" {
		if hour < 1 || hour > 12 {
			return nil
		}
		hour %= 12
		if strings.EqualFold(m[5], "pm") {
			hour += 12
		}
	}
	if hour > 23 || minute > 59 {
		return nil
	}
	local := now.In(loc)
	var at time.Time
	if m[1] != "" {
		month := 0
		for i, name := range months {
			if strings.EqualFold(m[1], name) {
				month = i + 1
			}
		}
		day, _ := strconv.Atoi(m[2])
		if month == 0 {
			return nil
		}
		at = time.Date(local.Year(), time.Month(month), day, hour, minute, 0, 0, loc)
		if at.Day() != day {
			return nil
		}
		// /usage có thể đã đọc vài phút trước: chỉ coi là năm sau khi ngày đã qua hơn một ngày.
		if at.Before(now.Add(-24 * time.Hour)) {
			at = at.AddDate(1, 0, 0)
		}
	} else {
		at = time.Date(local.Year(), local.Month(), local.Day(), hour, minute, 0, 0, loc)
		if !at.After(now) {
			at = at.AddDate(0, 0, 1)
		}
	}
	at = at.UTC()
	return &at
}

// codexFiles là số file phiên mới nhất được xem: lượt Codex gần nhất nằm trong vài file cuối.
const codexFiles = 6

// codexTails: đọc đuôi nhỏ trước (sự kiện quota ghi ở mỗi lượt nên thường ở cuối), rồi mới tới đuôi lớn.
var codexTails = []int64{256 << 10, 8 << 20}

// readCodexUsage đọc quota Codex từ file phiên của nó: mỗi lượt Codex ghi một event token_count kèm rate_limits vào
// <CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl, primary là phiên 5 giờ, secondary là tuần. Codex không có lệnh in
// các số này nên không chạy gì; số là của lượt cuối trên máy và CheckedAt là lúc đó. Nil khi không file nào có.
func readCodexUsage(home string, now time.Time) *Usage {
	for _, f := range codexSessionFiles(home) {
		if u := codexFileUsage(f.path, f.mtime, now); u != nil {
			return u
		}
	}
	return nil
}

type sessionFile struct {
	path  string
	mtime time.Time
}

// numbered là tên chỉ có chữ số trong dir (năm, tháng, ngày), lớn trước.
func numbered(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var names []string
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err == nil && e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Slice(names, func(i, j int) bool {
		a, _ := strconv.Atoi(names[i])
		b, _ := strconv.Atoi(names[j])
		return a > b
	})
	return names
}

func codexSessionFiles(home string) []sessionFile {
	root := filepath.Join(home, "sessions")
	var found []sessionFile
days:
	for _, y := range numbered(root) {
		for _, m := range numbered(filepath.Join(root, y)) {
			for _, d := range numbered(filepath.Join(root, y, m)) {
				if len(found) >= codexFiles {
					break days
				}
				dir := filepath.Join(root, y, m, d)
				entries, err := os.ReadDir(dir)
				if err != nil {
					continue
				}
				for _, e := range entries {
					if !strings.HasPrefix(e.Name(), "rollout-") || !strings.HasSuffix(e.Name(), ".jsonl") {
						continue
					}
					if info, err := e.Info(); err == nil {
						found = append(found, sessionFile{path: filepath.Join(dir, e.Name()), mtime: info.ModTime()})
					}
				}
			}
		}
	}
	// Phiên bắt đầu trước nửa đêm vẫn ghi vào thư mục hôm qua: thứ tự theo giờ sửa file.
	sort.SliceStable(found, func(i, j int) bool { return found[i].mtime.After(found[j].mtime) })
	if len(found) > codexFiles {
		found = found[:codexFiles]
	}
	return found
}

type codexWindow struct {
	UsedPercent     *float64 `json:"used_percent"`
	ResetsAt        *float64 `json:"resets_at"`
	ResetsInSeconds *float64 `json:"resets_in_seconds"`
}

type codexEvent struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   struct {
		Type       string `json:"type"`
		RateLimits *struct {
			LimitID   string       `json:"limit_id"`
			Primary   *codexWindow `json:"primary"`
			Secondary *codexWindow `json:"secondary"`
		} `json:"rate_limits"`
	} `json:"payload"`
}

func codexFileUsage(path string, mtime, now time.Time) *Usage {
	f, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil
	}
	for _, n := range codexTails {
		start := max(0, info.Size()-n)
		data := make([]byte, info.Size()-start)
		if _, err := f.ReadAt(data, start); err != nil && err != io.EOF {
			return nil
		}
		lines := bytes.Split(data, []byte("\n"))
		if start > 0 {
			// Dòng đầu bị cắt giữa chừng.
			lines = lines[1:]
		}
		for i := len(lines) - 1; i >= 0; i-- {
			if u := codexLineUsage(lines[i], mtime, now); u != nil {
				return u
			}
		}
		if start == 0 {
			break
		}
	}
	return nil
}

func codexLineUsage(line []byte, mtime, now time.Time) *Usage {
	// Phần lớn dòng là tin nhắn: chỉ giải mã dòng có thể là báo quota.
	if !bytes.Contains(line, []byte(`"rate_limits"`)) || !bytes.Contains(line, []byte(`"token_count"`)) {
		return nil
	}
	var e codexEvent
	if json.Unmarshal(line, &e) != nil || e.Type != "event_msg" || e.Payload.Type != "token_count" {
		return nil
	}
	limits := e.Payload.RateLimits
	// Id khác ("premium", …) đi kèm thanh rỗng; Codex cũ không ghi limit_id.
	if limits == nil || (limits.LimitID != "" && limits.LimitID != "codex") || (limits.Primary == nil && limits.Secondary == nil) {
		return nil
	}
	stamp, err := time.Parse(time.RFC3339Nano, e.Timestamp)
	if err != nil {
		stamp = mtime
	}
	stamp = stamp.UTC()
	u := Usage{Session: codexLimit(limits.Primary, stamp, now), Week: codexLimit(limits.Secondary, stamp, now), CheckedAt: &stamp}
	if u.Session == nil && u.Week == nil {
		return nil
	}
	return &u
}

// codexLimit đổi một cửa sổ của Codex thành Limit; cửa sổ đã qua giờ reset thì đã về 0.
func codexLimit(w *codexWindow, stamp, now time.Time) *Limit {
	if w == nil || w.UsedPercent == nil {
		return nil
	}
	var at *time.Time
	switch {
	case w.ResetsAt != nil:
		t := time.Unix(int64(*w.ResetsAt), 0).UTC()
		at = &t
	case w.ResetsInSeconds != nil:
		// Codex cũ ghi số giây còn lại, tính từ lúc ghi event.
		t := stamp.Add(time.Duration(*w.ResetsInSeconds) * time.Second).Truncate(time.Second)
		at = &t
	}
	if at != nil && !at.After(now) {
		return &Limit{}
	}
	return &Limit{Percent: *w.UsedPercent, ResetsAt: at}
}
