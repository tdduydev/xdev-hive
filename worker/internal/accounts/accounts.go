// Package accounts chọn tài khoản CLI cho từng run khi máy có nhiều đăng nhập của cùng một CLI (spec 008 US13, US14).
//
// Danh sách nằm ở accounts.json cạnh worker.json, do app desktop ghi (nhập từ app v1, thêm, sửa, xoá, bật tắt). File
// không chứa bí mật: mỗi tài khoản trỏ tới thư mục cấu hình của CLI (CLAUDE_CONFIG_DIR, CODEX_HOME), nơi CLI tự giữ
// đăng nhập. Không có file, hoặc không có tài khoản nào của CLI cần chạy, thì CLI dùng đăng nhập mặc định như trước.
// Giờ nghỉ, "Dùng tiếp" và quota đọc được nằm ở accounts-state.json (xem State).
package accounts

import (
	"context"
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

// Vai trò của run mà một tài khoản nhận, như app v1.
const (
	RolePlan      = "plan"
	RoleImplement = "implement"
	RoleReview    = "review"
)

// Roles là mọi vai trò, cũng là mặc định của tài khoản.
var Roles = []string{RolePlan, RoleImplement, RoleReview}

// Mặc định của app v1 cho trường tài khoản không ghi.
const (
	DefaultStopAtSession   = 95
	DefaultStopAtWeek      = 90
	DefaultTimeoutMinutes  = 60
	DefaultCooldownMinutes = 60
)

// Account là một đăng nhập của một CLI trên máy.
type Account struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	// CLI là CLI hub giao run ("claude", "codex", "antigravity", "gemini"); CLI worker không đọc được quota (xem
	// Supported) được giữ để app hiện nhưng worker không bao giờ chọn.
	CLI string `json:"cli"`
	// ConfigDir là thư mục cấu hình của CLI; rỗng là đăng nhập mặc định (~/.claude, ~/.codex). Nhận "~/".
	ConfigDir       string `json:"configDir,omitempty"`
	Enabled         bool   `json:"enabled"`
	Priority        int    `json:"priority"`
	MaxConcurrent   int    `json:"maxConcurrent"`
	CooldownMinutes int    `json:"cooldownMinutes"`
	// StopAtSession, StopAtWeek: phần trăm quota phiên 5 giờ và tuần mà tới đó worker thôi giao run mới cho tài khoản,
	// để phần còn lại cho người làm tay.
	StopAtSession int `json:"stopAtSession"`
	StopAtWeek    int `json:"stopAtWeek"`
	// Roles là vai trò run tài khoản nhận (plan, implement, review).
	Roles []string `json:"roles"`
	// TimeoutMinutes chặn thời gian một run trên tài khoản; run vẫn dừng sớm hơn nếu hub đặt thời hạn ngắn hơn.
	TimeoutMinutes int `json:"timeoutMinutes"`
	// Pending: đang đăng nhập từ web (login.go) nên chưa là tài khoản dùng được. Pool không tính nó, và worker khởi động
	// lại thì xoá (CleanupPending), để phiên đăng nhập dở không để lại tài khoản chưa đăng nhập.
	Pending bool `json:"pending,omitempty"`
}

// withDefaults điền trường file cũ (US13) hay app v1 không ghi, để worker và app thấy cùng một giá trị.
func (a Account) withDefaults() Account {
	if a.MaxConcurrent <= 0 {
		a.MaxConcurrent = 1
	}
	if a.CooldownMinutes <= 0 {
		a.CooldownMinutes = DefaultCooldownMinutes
	}
	if a.StopAtSession <= 0 {
		a.StopAtSession = DefaultStopAtSession
	}
	if a.StopAtWeek <= 0 {
		a.StopAtWeek = DefaultStopAtWeek
	}
	if len(a.Roles) == 0 {
		a.Roles = append([]string(nil), Roles...)
	}
	if a.TimeoutMinutes <= 0 {
		a.TimeoutMinutes = DefaultTimeoutMinutes
	}
	return a
}

// RoleOf là vai trò tài khoản cần nhận cho run loại kind: run plan và brief là "plan" (brief chỉ đọc, rẻ như plan),
// review là "review", còn lại "implement".
func RoleOf(kind string) string {
	switch kind {
	case RolePlan, RoleReview:
		return kind
	case "brief":
		return RolePlan
	}
	return RoleImplement
}

func (a Account) takes(role string) bool {
	for _, r := range a.Roles {
		if r == role {
			return true
		}
	}
	return false
}

// overLimit là thanh quota đã chạm ngưỡng dừng ("session", "week"), rỗng khi chưa; "Dùng tiếp" còn hạn thì bỏ qua.
func (a Account) overLimit(u Usage, resumeUntil, now time.Time) string {
	if resumeUntil.After(now) {
		return ""
	}
	u = u.at(now)
	if u.Session != nil && u.Session.Percent >= float64(a.StopAtSession) {
		return "session"
	}
	if u.Week != nil && u.Week.Percent >= float64(a.StopAtWeek) {
		return "week"
	}
	return ""
}

// headroom là số điểm phần trăm còn lại trước ngưỡng dừng gần nhất; ok false khi chưa biết quota.
func (a Account) headroom(u Usage, now time.Time) (left float64, ok bool) {
	u = u.at(now)
	left = 101
	if u.Session != nil {
		left, ok = min(left, float64(a.StopAtSession)-u.Session.Percent), true
	}
	if u.Week != nil {
		left, ok = min(left, float64(a.StopAtWeek)-u.Week.Percent), true
	}
	return left, ok
}

type file struct {
	// MaxParallel là số run máy nhận cùng lúc (runner.maxParallel của app v1); 0 là theo tài khoản (Slots).
	MaxParallel int       `json:"maxParallel,omitempty"`
	Accounts    []Account `json:"accounts"`
}

// envVar là biến môi trường chọn thư mục cấu hình của CLI.
var envVar = map[string]string{"claude": "CLAUDE_CONFIG_DIR", "codex": "CODEX_HOME"}

// Supported cho biết worker đọc được quota của CLI này và chọn tài khoản theo ngưỡng dừng. Antigravity không có biến
// chọn thư mục cấu hình nên chỉ có đăng nhập mặc định, nhưng ngưỡng vẫn giữ run lại khi gói gần hết.
func Supported(cli string) bool { _, ok := envVar[cli]; return ok || cli == "antigravity" }

// binary là tên lệnh của CLI trên PATH.
func binary(cli string) string {
	if cli == "antigravity" {
		return "agy"
	}
	return cli
}

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
	for i := range f.Accounts {
		f.Accounts[i] = f.Accounts[i].withDefaults()
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

// ErrBusy: CLI có tài khoản nhưng không tài khoản nào nhận được run lúc này (tắt, chưa đăng nhập, sai vai trò, chạm
// ngưỡng quota, đang nghỉ hoặc đang chạy đủ số run). Lỗi trả về bọc ErrBusy kèm lý do cho log.
var ErrBusy = errors.New("mọi tài khoản của CLI đang bận hoặc đang nghỉ")

// Pool giữ số run đang chạy của từng tài khoản. Đọc lại accounts.json và accounts-state.json mỗi lần chọn để thay đổi
// trong app (bật tắt, ngưỡng, Dùng tiếp) có hiệu lực ngay, không cần khởi động lại worker.
type Pool struct {
	path  string
	state string
	home  string
	now   func() time.Time

	mu     sync.Mutex
	active map[string]int
	// reread nhận id tài khoản vừa xong run để Watch đọc lại quota của nó.
	reread chan string

	loginOnce sync.Once
	login     *Login
}

func NewPool(path string) *Pool {
	home, _ := os.UserHomeDir()
	return &Pool{path: path, state: StatePath(path), home: home, now: time.Now, active: map[string]int{}, reread: make(chan string, 16)}
}

// Path là accounts.json; Home là thư mục nhà dùng để mở rộng "~/" trong ConfigDir. Kênh worker cần cả hai để báo tóm
// tắt tài khoản và đăng nhập từ web mà không giữ bản sao cấu hình.
func (p *Pool) Path() string { return p.path }
func (p *Pool) Home() string { return p.home }

// Login là phiên đăng nhập gói từ web của máy này; mỗi máy chỉ một phiên nên chỉ có một Login cho mỗi Pool.
func (p *Pool) Login() *Login {
	p.loginOnce.Do(func() { p.login = NewLogin(p.path, p.home) })
	return p.login
}

// Lease là tài khoản đã giữ cho một run; nil là chạy bằng đăng nhập mặc định.
type Lease struct {
	pool    *Pool
	account Account
	dir     string
	once    sync.Once
}

// ID là id tài khoản trong accounts.json; rỗng với đăng nhập mặc định.
func (l *Lease) ID() string {
	if l == nil {
		return ""
	}
	return l.account.ID
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
	v, ok := "", false
	if l != nil {
		v, ok = envVar[l.account.CLI]
	}
	if !ok || l.dir == "" {
		return nil
	}
	env := map[string]string{v: l.dir}
	// Gói đăng nhập bằng token `claude setup-token` không có oauthAccount trong thư mục cấu hình; CLI chỉ biết token qua
	// biến này.
	if l.account.CLI == "claude" {
		if token := oauthToken(l.dir); token != "" {
			env[tokenEnv] = token
		}
	}
	return env
}

// Timeout là thời gian tối đa của một run trên tài khoản; 0 khi không có tài khoản.
func (l *Lease) Timeout() time.Duration {
	if l == nil {
		return 0
	}
	return time.Duration(l.account.TimeoutMinutes) * time.Minute
}

// Release trả chỗ của run; gọi nhiều lần cũng chỉ trả một lần. Run vừa xong đã dùng quota nên đọc lại quota của tài
// khoản, để lần chọn sau và ngưỡng dừng thấy phần run đó vừa dùng.
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		p := l.pool
		p.mu.Lock()
		if p.active[l.account.ID] > 0 {
			p.active[l.account.ID]--
		}
		p.syncActive()
		p.mu.Unlock()
		select {
		case p.reread <- l.account.ID:
		default:
		}
	})
}

// Cooldown cho tài khoản nghỉ sau khi CLI báo hết lượt dùng; run sau chọn tài khoản khác. Biết giờ reset của thanh
// quota đang chặn thì nghỉ tới đó, không thì cooldownMinutes. Giờ nghỉ ghi vào file trạng thái nên còn sau khi worker
// khởi động lại.
func (l *Lease) Cooldown() {
	if l == nil {
		return
	}
	p := l.pool
	now := p.now()
	_ = UpdateState(p.state, now, func(s *State) {
		s.CoolUntil[l.account.ID] = coolUntil(l.account, s.Usage[l.account.ID], now)
	})
}

// coolUntil: giờ reset của thanh còn ít chỗ nhất trước ngưỡng (thanh vừa vượt), nếu biết và còn ở tương lai.
func coolUntil(a Account, u Usage, now time.Time) time.Time {
	fallback := now.Add(time.Duration(a.CooldownMinutes) * time.Minute)
	type bar struct {
		left float64
		at   *time.Time
	}
	var bars []bar
	if u.Session != nil {
		bars = append(bars, bar{float64(a.StopAtSession) - u.Session.Percent, u.Session.ResetsAt})
	}
	if u.Week != nil {
		bars = append(bars, bar{float64(a.StopAtWeek) - u.Week.Percent, u.Week.ResetsAt})
	}
	if len(bars) == 0 {
		return fallback
	}
	binding := bars[0]
	for _, b := range bars[1:] {
		if b.left < binding.left {
			binding = b
		}
	}
	if binding.at == nil || !binding.at.After(now) {
		return fallback
	}
	return *binding.at
}

func expandHome(home, dir string) string {
	if dir == "~" {
		return home
	}
	if strings.HasPrefix(dir, "~/") {
		return filepath.Join(home, dir[2:])
	}
	return dir
}

func (p *Pool) expand(dir string) string { return expandHome(p.home, dir) }

// syncActive ghi số run đang chạy vào file trạng thái cho app hiện; gọi khi giữ p.mu. Lỗi ghi chỉ làm app hiện số
// cũ, không ảnh hưởng việc chọn tài khoản (worker đếm bằng bộ nhớ).
func (p *Pool) syncActive() {
	active := make(map[string]int, len(p.active))
	for id, n := range p.active {
		active[id] = n
	}
	_ = UpdateState(p.state, p.now(), func(s *State) { s.Active = active })
}

// candidates là tài khoản bật của CLI, ưu tiên cao trước; cùng ưu tiên thì tài khoản đang ít run hơn trước, rồi tài
// khoản còn nhiều quota hơn trước ngưỡng (đã biết quota trước chưa biết).
func (p *Pool) candidates(list []Account, cli string, st State, now time.Time) []Account {
	var out []Account
	for _, a := range list {
		if a.CLI == cli && a.Enabled && !a.Pending {
			out = append(out, a)
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Priority != b.Priority {
			return a.Priority > b.Priority
		}
		if p.active[a.ID] != p.active[b.ID] {
			return p.active[a.ID] < p.active[b.ID]
		}
		la, oka := a.headroom(st.Usage[a.ID], now)
		lb, okb := b.headroom(st.Usage[b.ID], now)
		if oka != okb {
			return oka
		}
		return la > lb
	})
	return out
}

// skip là lý do tài khoản không nhận run lúc này, rỗng khi nhận được.
func (p *Pool) skip(a Account, role string, st State, now time.Time) string {
	loggedIn, _ := loginOf(a, p.home)
	switch {
	case !a.takes(role):
		return "không nhận vai trò " + role
	case loggedIn != nil && !*loggedIn:
		return "chưa đăng nhập"
	case st.CoolUntil[a.ID].After(now):
		return "đang nghỉ tới " + st.CoolUntil[a.ID].Local().Format("15:04 02/01")
	}
	switch a.overLimit(st.Usage[a.ID], st.ResumeUntil[a.ID], now) {
	case "session":
		return fmt.Sprintf("chạm ngưỡng phiên %d%%", a.StopAtSession)
	case "week":
		return fmt.Sprintf("chạm ngưỡng tuần %d%%", a.StopAtWeek)
	}
	if p.active[a.ID] >= a.MaxConcurrent {
		return "đang chạy đủ run"
	}
	return ""
}

// Acquire giữ một tài khoản cho run của CLI ở vai trò role (xem RoleOf). Trả (nil, nil) khi CLI không có tài khoản
// nào trong danh sách (dùng đăng nhập mặc định), lỗi bọc ErrBusy khi có mà không tài khoản nào nhận được.
func (p *Pool) Acquire(cli, role string) (*Lease, error) {
	if p == nil || !Supported(cli) {
		return nil, nil
	}
	list, err := Load(p.path)
	if err != nil {
		return nil, err
	}
	hasAny := false
	for _, a := range list {
		// Tài khoản đang đăng nhập dở không tính: CLI chưa có tài khoản nào dùng được thì chạy bằng đăng nhập mặc định.
		if a.CLI == cli && !a.Pending {
			hasAny = true
			break
		}
	}
	if !hasAny {
		return nil, nil
	}
	st, err := LoadState(p.state)
	if err != nil {
		return nil, err
	}
	if role == "" {
		role = RoleImplement
	}
	now := p.now()
	p.mu.Lock()
	defer p.mu.Unlock()
	var why []string
	for _, a := range p.candidates(list, cli, st, now) {
		if reason := p.skip(a, role, st, now); reason != "" {
			why = append(why, a.ID+" "+reason)
			continue
		}
		p.active[a.ID]++
		p.syncActive()
		return &Lease{pool: p, account: a, dir: p.expand(a.ConfigDir)}, nil
	}
	if len(why) == 0 {
		return nil, fmt.Errorf("%w: không tài khoản %s nào đang bật", ErrBusy, cli)
	}
	return nil, fmt.Errorf("%w: %s", ErrBusy, strings.Join(why, "; "))
}

// usageEvery là chu kỳ worker đọc lại quota của các tài khoản bật, như app v1.
var usageEvery = 10 * time.Minute

// Watch chạy cùng worker tới khi ctx xong: ghi lại số run đang chạy (số trong file có thể còn của lần worker trước chết
// giữa chừng), đọc quota của mọi tài khoản bật ngay, rồi 10 phút một lần và sau mỗi run của một tài khoản.
func (p *Pool) Watch(ctx context.Context) {
	if p == nil {
		return
	}
	if _, err := os.Stat(p.state); err == nil {
		p.mu.Lock()
		p.syncActive()
		p.mu.Unlock()
	}
	enabled := func(a Account) bool { return a.Enabled }
	_ = RefreshUsage(ctx, p.path, p.home, p.now, enabled)
	tick := time.NewTicker(usageEvery)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			_ = RefreshUsage(ctx, p.path, p.home, p.now, enabled)
		case id := <-p.reread:
			_ = RefreshUsage(ctx, p.path, p.home, p.now, func(a Account) bool { return a.ID == id })
		}
	}
}

// RefreshUsage đọc lại quota của các tài khoản pick chọn rồi ghi vào file trạng thái. CLI chạy ngoài khoá file, từng
// tài khoản một, để lệnh khác không phải chờ CLI.
func RefreshUsage(ctx context.Context, path, home string, now func() time.Time, pick func(Account) bool) error {
	list, err := Load(path)
	if err != nil {
		return err
	}
	read := map[string]Usage{}
	for _, a := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if pick(a) {
			read[a.ID] = ReadUsage(ctx, a, home, now())
		}
	}
	if len(read) == 0 {
		return nil
	}
	return UpdateState(StatePath(path), now(), func(s *State) {
		for id, u := range read {
			s.Usage[id] = u
		}
	})
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
