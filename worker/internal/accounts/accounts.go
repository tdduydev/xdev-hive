// Package accounts chọn tài khoản CLI cho từng run khi máy có nhiều đăng nhập của cùng một CLI (spec 008 US13).
//
// Danh sách nằm ở accounts.json cạnh worker.json, do app desktop ghi (nhập từ app v1 hoặc người dùng bật tắt). File
// không chứa bí mật: mỗi tài khoản trỏ tới thư mục cấu hình của CLI (CLAUDE_CONFIG_DIR, CODEX_HOME), nơi CLI tự giữ
// đăng nhập. Không có file, hoặc không có tài khoản nào của CLI cần chạy, thì CLI dùng đăng nhập mặc định như trước.
package accounts

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Account là một đăng nhập của một CLI trên máy.
type Account struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// CLI là CLI hub giao run ("claude", "codex", "gemini"); CLI khác (vd. antigravity) được giữ để app hiện nhưng
	// worker không bao giờ chọn.
	CLI string `json:"cli"`
	// ConfigDir là thư mục cấu hình của CLI; rỗng là đăng nhập mặc định (~/.claude, ~/.codex). Nhận "~/".
	ConfigDir       string `json:"configDir,omitempty"`
	Enabled         bool   `json:"enabled"`
	Priority        int    `json:"priority"`
	MaxConcurrent   int    `json:"maxConcurrent"`
	CooldownMinutes int    `json:"cooldownMinutes"`
}

type file struct {
	// MaxParallel là số run máy nhận cùng lúc (runner.maxParallel của app v1); 0 là theo tài khoản (Slots).
	MaxParallel int       `json:"maxParallel,omitempty"`
	Accounts    []Account `json:"accounts"`
}

// envVar là biến môi trường chọn thư mục cấu hình của CLI; CLI không có trong bảng thì worker không chọn tài khoản.
var envVar = map[string]string{"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}

// Supported cho biết worker có chọn được tài khoản của CLI này không.
func Supported(cli string) bool { _, ok := envVar[cli]; return ok }

// DefaultPath là accounts.json cạnh file cấu hình worker.
func DefaultPath(workerConfig string) string {
	return filepath.Join(filepath.Dir(workerConfig), "accounts.json")
}

// Load đọc danh sách; file không có thì trả rỗng, không lỗi.
func Load(path string) ([]Account, error) {
	f, err := read(path)
	return f.Accounts, err
}

func read(path string) (file, error) {
	var f file
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return f, nil
	}
	if err != nil {
		return f, err
	}
	if err := json.Unmarshal(b, &f); err != nil {
		return f, fmt.Errorf("đọc %s: %w", path, err)
	}
	return f, nil
}

// Capacity là số run máy nhận cùng lúc theo accounts.json: maxParallel nếu có, không thì tổng số run các tài khoản
// bật cho phép, chặn trong [1, limit]. Không có tài khoản nào thì 1, như mặc định của worker.
func Capacity(path string, limit int) (int, error) {
	f, err := read(path)
	if err != nil {
		return 0, err
	}
	n := f.MaxParallel
	if n <= 0 {
		n = Slots(f.Accounts)
	}
	return max(1, min(n, limit)), nil
}

// ErrBusy: CLI có tài khoản nhưng tài khoản nào cũng đang tắt, đang chạy đủ số run hoặc đang nghỉ.
var ErrBusy = errors.New("mọi tài khoản của CLI đang bận hoặc đang nghỉ")

// Pool giữ số run đang chạy và giờ hết nghỉ của từng tài khoản. Đọc lại file mỗi lần chọn để bật tắt trong app có
// hiệu lực ngay, không cần khởi động lại worker.
type Pool struct {
	path string
	home string
	now  func() time.Time

	mu        sync.Mutex
	active    map[string]int
	coolUntil map[string]time.Time
}

func NewPool(path string) *Pool {
	home, _ := os.UserHomeDir()
	return &Pool{path: path, home: home, now: time.Now, active: map[string]int{}, coolUntil: map[string]time.Time{}}
}

// Lease là tài khoản đã giữ cho một run; nil là chạy bằng đăng nhập mặc định.
type Lease struct {
	pool    *Pool
	account Account
	dir     string
	once    sync.Once
}

func (l *Lease) Label() string {
	if l == nil {
		return ""
	}
	if l.account.Label != "" {
		return l.account.Label
	}
	return l.account.ID
}

// Env là biến môi trường cần đặt cho tiến trình CLI; rỗng với đăng nhập mặc định.
func (l *Lease) Env() map[string]string {
	if l == nil || l.dir == "" {
		return nil
	}
	return map[string]string{envVar[l.account.CLI]: l.dir}
}

// Release trả chỗ của run; gọi nhiều lần cũng chỉ trả một lần.
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		l.pool.mu.Lock()
		defer l.pool.mu.Unlock()
		if l.pool.active[l.account.ID] > 0 {
			l.pool.active[l.account.ID]--
		}
	})
}

// Cooldown cho tài khoản nghỉ sau khi CLI báo hết lượt dùng; run sau chọn tài khoản khác.
func (l *Lease) Cooldown() {
	if l == nil {
		return
	}
	minutes := l.account.CooldownMinutes
	if minutes <= 0 {
		minutes = 60
	}
	l.pool.mu.Lock()
	defer l.pool.mu.Unlock()
	l.pool.coolUntil[l.account.ID] = l.pool.now().Add(time.Duration(minutes) * time.Minute)
}

func (p *Pool) expand(dir string) string {
	if dir == "~" {
		return p.home
	}
	if strings.HasPrefix(dir, "~/") {
		return filepath.Join(p.home, dir[2:])
	}
	return dir
}

// candidates là tài khoản bật của CLI, ưu tiên cao trước; cùng ưu tiên thì tài khoản đang ít run hơn trước.
func (p *Pool) candidates(list []Account, cli string) []Account {
	var out []Account
	for _, a := range list {
		if a.CLI == cli && a.Enabled {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Priority != out[j].Priority {
			return out[i].Priority > out[j].Priority
		}
		return p.active[out[i].ID] < p.active[out[j].ID]
	})
	return out
}

func (p *Pool) free(a Account) bool {
	limit := a.MaxConcurrent
	if limit <= 0 {
		limit = 1
	}
	return p.active[a.ID] < limit && !p.now().Before(p.coolUntil[a.ID])
}

// Acquire giữ một tài khoản cho run của CLI. Trả (nil, nil) khi CLI không có tài khoản nào trong danh sách (dùng
// đăng nhập mặc định), ErrBusy khi có mà không tài khoản nào rảnh.
func (p *Pool) Acquire(cli string) (*Lease, error) {
	if p == nil || !Supported(cli) {
		return nil, nil
	}
	list, err := Load(p.path)
	if err != nil {
		return nil, err
	}
	hasAny := false
	for _, a := range list {
		if a.CLI == cli {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return nil, nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, a := range p.candidates(list, cli) {
		if p.free(a) {
			p.active[a.ID]++
			return &Lease{pool: p, account: a, dir: p.expand(a.ConfigDir)}, nil
		}
	}
	return nil, ErrBusy
}

// Slots là tổng số run chạy cùng lúc của mọi tài khoản bật mà worker chọn được; 0 khi không có tài khoản nào.
func Slots(list []Account) int {
	n := 0
	for _, a := range list {
		if a.Enabled && Supported(a.CLI) {
			n += max(a.MaxConcurrent, 1)
		}
	}
	return n
}

// limitMarkers là câu CLI in ra khi tài khoản hết lượt dùng (gói Claude, ChatGPT). So khớp không phân biệt hoa thường.
var limitMarkers = []string{
	"usage limit reached",
	"you've hit your usage limit",
	"you have hit your usage limit",
	"usage_limit_reached",
	"5-hour limit reached",
	"weekly limit reached",
}

// LimitWatcher đọc output của CLI và ghi nhận khi thấy câu báo hết lượt dùng. Chỉ giữ đuôi ngắn của lần ghi trước
// để câu bị cắt giữa hai lần ghi vẫn khớp.
type LimitWatcher struct {
	mu   sync.Mutex
	tail string
	hit  bool
}

func (w *LimitWatcher) Write(b []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.hit {
		return len(b), nil
	}
	text := strings.ToLower(w.tail + string(b))
	for _, m := range limitMarkers {
		if strings.Contains(text, m) {
			w.hit = true
			return len(b), nil
		}
	}
	if len(text) > 64 {
		text = text[len(text)-64:]
	}
	w.tail = text
	return len(b), nil
}

// Hit cho biết CLI đã báo hết lượt dùng.
func (w *LimitWatcher) Hit() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.hit
}
