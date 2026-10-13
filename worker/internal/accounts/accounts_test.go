package accounts

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// signIn ghi file đăng nhập CLI tạo ra (không có token) vào thư mục cấu hình của tài khoản.
func signIn(t *testing.T, home, configDir, cli string) {
	t.Helper()
	dir := expandHome(home, configDir)
	name, body := ".claude.json", `{"oauthAccount":{"emailAddress":"duy@fpt.com"}}`
	if cli == "codex" {
		if dir == "" {
			dir = filepath.Join(home, ".codex")
		}
		name, body = "auth.json", `{"tokens":{"id_token":"h.e30.s"}}`
	}
	if dir == "" {
		dir = home
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func pool(t *testing.T, body string) *Pool {
	t.Helper()
	path := filepath.Join(t.TempDir(), "accounts.json")
	if body != "" {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	p := NewPool(path)
	p.home = t.TempDir()
	signIn(t, p.home, "~/.xdev-hive/accounts/claude-3", "claude")
	signIn(t, p.home, "~/.xdev-hive/accounts/claude-4", "claude")
	return p
}

// fixed đặt giờ của pool và trả hàm dời giờ.
func fixed(p *Pool, at time.Time) func(time.Duration) {
	now := at
	p.now = func() time.Time { return now }
	return func(d time.Duration) { now = now.Add(d) }
}

const three = `{"accounts":[
 {"id":"claude-3","label":"claude-3","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-3","enabled":true,"priority":30,"maxConcurrent":1,"cooldownMinutes":60},
 {"id":"claude-4","label":"vudd7","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-4","enabled":true,"priority":0,"maxConcurrent":2},
 {"id":"claude-5","cli":"claude","configDir":"/x","enabled":false,"priority":99,"maxConcurrent":1},
 {"id":"antigravity-1","cli":"antigravity","enabled":true,"priority":50}
]}`

var t0 = time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)

func TestAcquirePriorityConcurrencyAndDisabled(t *testing.T) {
	p := pool(t, three)
	first, err := p.Acquire("claude", RoleImplement)
	if err != nil || first.Label() != "claude-3" {
		t.Fatalf("ưu tiên cao nhất phải là claude-3: %v %v", first.Label(), err)
	}
	if got := first.Env()["CLAUDE_CONFIG_DIR"]; got != filepath.Join(p.home, ".xdev-hive", "accounts", "claude-3") {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q", got)
	}
	// claude-3 đủ một run; claude-5 tắt dù ưu tiên cao: hai run sau vào claude-4 (cho phép 2).
	second, _ := p.Acquire("claude", RoleImplement)
	third, _ := p.Acquire("claude", RoleImplement)
	if second.Label() != "vudd7" || third.Label() != "vudd7" {
		t.Fatalf("got %q, %q", second.Label(), third.Label())
	}
	if _, err := p.Acquire("claude", RoleImplement); !errors.Is(err, ErrBusy) {
		t.Fatalf("hết chỗ phải ErrBusy, got %v", err)
	}
	first.Release()
	first.Release() // trả hai lần cũng chỉ trả một chỗ
	again, _ := p.Acquire("claude", RoleImplement)
	if again.Label() != "claude-3" {
		t.Fatalf("trả chỗ xong phải chọn lại claude-3, got %q", again.Label())
	}
	if _, err := p.Acquire("claude", RoleImplement); !errors.Is(err, ErrBusy) {
		t.Fatalf("Release hai lần không được tạo thêm chỗ: %v", err)
	}
}

// Số run đang chạy nằm trong file trạng thái để lệnh `accounts` (tiến trình khác) hiện được.
func TestActiveRunsInStateFile(t *testing.T) {
	p := pool(t, three)
	l, _ := p.Acquire("claude", RoleImplement)
	st, _ := LoadState(p.state)
	if st.Active["claude-3"] != 1 {
		t.Fatalf("active = %v", st.Active)
	}
	l.Release()
	st, _ = LoadState(p.state)
	if st.Active["claude-3"] != 0 {
		t.Fatalf("trả chỗ xong active = %v", st.Active)
	}
}

func TestCooldownSkipsAccountUntilItEndsAcrossRestart(t *testing.T) {
	p := pool(t, three)
	advance := fixed(p, t0)
	l, _ := p.Acquire("claude", RoleImplement)
	l.Cooldown()
	l.Release()
	next, _ := p.Acquire("claude", RoleImplement)
	if next.Label() != "vudd7" {
		t.Fatalf("tài khoản đang nghỉ vẫn được chọn: %q", next.Label())
	}
	next.Release()
	// Worker khởi động lại: pool mới đọc giờ nghỉ từ file trạng thái.
	restarted := NewPool(p.path)
	restarted.home = p.home
	restarted.now = p.now
	if again, _ := restarted.Acquire("claude", RoleImplement); again.Label() != "vudd7" {
		t.Fatalf("giờ nghỉ mất sau khởi động lại: %q", again.Label())
	} else {
		again.Release()
	}
	advance(61 * time.Minute)
	back, _ := restarted.Acquire("claude", RoleImplement)
	if back.Label() != "claude-3" {
		t.Fatalf("hết nghỉ phải chọn lại claude-3, got %q", back.Label())
	}
}

func setUsage(t *testing.T, p *Pool, id string, u Usage) {
	t.Helper()
	if err := UpdateState(p.state, p.now(), func(s *State) { s.Usage[id] = u }); err != nil {
		t.Fatal(err)
	}
}

func ptr(t time.Time) *time.Time { return &t }

// Biết giờ reset của thanh vừa vượt thì nghỉ tới đó, không thì cooldownMinutes.
func TestCooldownUntilResetOfBindingBar(t *testing.T) {
	p := pool(t, three)
	fixed(p, t0)
	sessionReset, weekReset := t0.Add(2*time.Hour), t0.Add(72*time.Hour)
	setUsage(t, p, "claude-3", Usage{Session: &Limit{Percent: 100, ResetsAt: &sessionReset}, Week: &Limit{Percent: 40, ResetsAt: &weekReset}})
	// claude-4 dưới ngưỡng nhưng thanh tuần còn ít chỗ nhất (5 điểm): hết lượt thì nghỉ tới giờ reset tuần.
	setUsage(t, p, "claude-4", Usage{Session: &Limit{Percent: 30, ResetsAt: &sessionReset}, Week: &Limit{Percent: 85, ResetsAt: &weekReset}})
	cases := []struct {
		account Account
		usage   Usage
		want    time.Time
	}{
		{Account{CooldownMinutes: 60, StopAtSession: 95, StopAtWeek: 90}, Usage{Session: &Limit{Percent: 100, ResetsAt: &sessionReset}, Week: &Limit{Percent: 40, ResetsAt: &weekReset}}, sessionReset},
		{Account{CooldownMinutes: 60, StopAtSession: 95, StopAtWeek: 90}, Usage{Session: &Limit{Percent: 30, ResetsAt: &sessionReset}, Week: &Limit{Percent: 95, ResetsAt: &weekReset}}, weekReset},
		{Account{CooldownMinutes: 45, StopAtSession: 95, StopAtWeek: 90}, Usage{Session: &Limit{Percent: 100}}, t0.Add(45 * time.Minute)},
		{Account{CooldownMinutes: 45, StopAtSession: 95, StopAtWeek: 90}, Usage{}, t0.Add(45 * time.Minute)},
		// Giờ reset đã qua: số cũ, không dùng được.
		{Account{CooldownMinutes: 45, StopAtSession: 95, StopAtWeek: 90}, Usage{Session: &Limit{Percent: 100, ResetsAt: ptr(t0.Add(-time.Minute))}}, t0.Add(45 * time.Minute)},
	}
	for i, c := range cases {
		if got := coolUntil(c.account, c.usage, t0); !got.Equal(c.want) {
			t.Fatalf("case %d: coolUntil = %v, muốn %v", i, got, c.want)
		}
	}
	l, _ := p.Acquire("claude", RoleImplement)
	if l == nil || l.Label() != "vudd7" {
		t.Fatalf("claude-3 chạm ngưỡng phiên, phải chọn claude-4: %v", l.Label())
	}
	l.Cooldown()
	st, _ := LoadState(p.state)
	if !st.CoolUntil["claude-4"].Equal(weekReset) {
		t.Fatalf("claude-4 nghỉ tới %v, muốn giờ reset tuần %v", st.CoolUntil["claude-4"], weekReset)
	}
}

func TestAcquireSkipsOverLimitUnlessResumed(t *testing.T) {
	p := pool(t, three)
	advance := fixed(p, t0)
	sessionReset := t0.Add(2 * time.Hour)
	setUsage(t, p, "claude-3", Usage{Session: &Limit{Percent: 95, ResetsAt: &sessionReset}, Week: &Limit{Percent: 10}})
	setUsage(t, p, "claude-4", Usage{Session: &Limit{Percent: 10}, Week: &Limit{Percent: 90}})
	if _, err := p.Acquire("claude", RoleImplement); !errors.Is(err, ErrBusy) || !strings.Contains(err.Error(), "chạm ngưỡng phiên 95%") || !strings.Contains(err.Error(), "chạm ngưỡng tuần 90%") {
		t.Fatalf("cả hai chạm ngưỡng phải ErrBusy kèm lý do: %v", err)
	}
	if err := Resume(p.path, "claude-3", p.now()); err != nil {
		t.Fatal(err)
	}
	l, err := p.Acquire("claude", RoleImplement)
	if err != nil || l.Label() != "claude-3" {
		t.Fatalf("Dùng tiếp phải cho claude-3 chạy: %v %v", l.Label(), err)
	}
	l.Release()
	// Qua giờ reset: Dùng tiếp hết hạn, nhưng thanh phiên cũng đã về 0 dù chưa đọc lại quota.
	advance(2*time.Hour + time.Minute)
	if l, err := p.Acquire("claude", RoleImplement); err != nil || l.Label() != "claude-3" {
		t.Fatalf("qua giờ reset phải chọn claude-3: %v %v", l.Label(), err)
	}
}

func TestAcquireSkipsSignedOutAndWrongRole(t *testing.T) {
	p := pool(t, `{"accounts":[
 {"id":"claude-3","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-3","enabled":true,"priority":30,"roles":["review"]},
 {"id":"claude-4","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-4","enabled":true,"priority":0,"roles":["plan","implement"]},
 {"id":"claude-6","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-6","enabled":true,"priority":99}
]}`)
	if l, _ := p.Acquire("claude", RoleOf("review")); l.Label() != "claude-3" {
		t.Fatalf("run review: %q", l.Label())
	}
	if l, _ := p.Acquire("claude", RoleOf("code")); l.Label() != "claude-4" {
		t.Fatalf("run code là implement, claude-3 chỉ review: %q", l.Label())
	}
	if l, _ := p.Acquire("claude", RoleOf("plan")); l != nil {
		t.Fatalf("claude-4 đủ run, claude-6 chưa đăng nhập: %q", l.Label())
	} else if _, err := p.Acquire("claude", RolePlan); !strings.Contains(err.Error(), "claude-6 chưa đăng nhập") {
		t.Fatalf("lý do phải nói chưa đăng nhập: %v", err)
	}
}

func TestRoleOf(t *testing.T) {
	for kind, want := range map[string]string{"plan": RolePlan, "review": RoleReview, "code": RoleImplement, "": RoleImplement, "leader": RoleImplement, "docassist": RoleImplement, "brief": RolePlan} {
		if got := RoleOf(kind); got != want {
			t.Fatalf("RoleOf(%q) = %q", kind, got)
		}
	}
}

func TestNoAccountsMeansDefaultLogin(t *testing.T) {
	if l, err := pool(t, "").Acquire("claude", RoleImplement); l != nil || err != nil {
		t.Fatalf("không có file: %v %v", l, err)
	}
	// Có file nhưng không có tài khoản Codex: Codex dùng đăng nhập mặc định.
	if l, err := pool(t, three).Acquire("codex", RoleImplement); l != nil || err != nil {
		t.Fatalf("CLI không có tài khoản: %v %v", l, err)
	}
	// Antigravity được chọn theo ngưỡng quota nhưng luôn chạy bằng đăng nhập mặc định: agy không có biến chọn thư mục.
	if l, err := pool(t, three).Acquire("antigravity", RoleImplement); l == nil || err != nil || l.Env() != nil {
		t.Fatalf("antigravity: %v %v", l, err)
	}
	// CLI worker không đọc được quota không bao giờ được chọn.
	if l, err := pool(t, `{"accounts":[{"id":"gemini-1","cli":"gemini","enabled":true}]}`).Acquire("gemini", RoleImplement); l != nil || err != nil {
		t.Fatalf("gemini: %v %v", l, err)
	}
	var none *Pool
	if l, err := none.Acquire("claude", RoleImplement); l != nil || err != nil {
		t.Fatalf("pool nil: %v %v", l, err)
	}
	if none := (*Lease)(nil); none.Env() != nil || none.Label() != "" || none.Timeout() != 0 {
		t.Fatal("lease nil phải không đặt biến nào")
	}
}

func TestDefaultsForOldFile(t *testing.T) {
	p := pool(t, three)
	list, _ := Load(p.path)
	a := list[1]
	if a.StopAtSession != 95 || a.StopAtWeek != 90 || a.TimeoutMinutes != 60 || a.CooldownMinutes != 60 || len(a.Roles) != 3 || a.MaxConcurrent != 2 {
		t.Fatalf("mặc định = %+v", a)
	}
	l, _ := p.Acquire("claude", RoleImplement)
	if l.Timeout() != time.Hour {
		t.Fatalf("timeout = %v", l.Timeout())
	}
}

func TestCapacity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	if n, _ := Capacity(path, 8); n != 1 {
		t.Fatalf("không có file: %d", n)
	}
	_ = os.WriteFile(path, []byte(three), 0o600)
	// claude-3 (1) + claude-4 (2) + antigravity-1 (1); claude-5 tắt.
	if n, _ := Capacity(path, 8); n != 4 {
		t.Fatalf("tổng chỗ: %d", n)
	}
	_ = os.WriteFile(path, []byte(`{"maxParallel":4,"accounts":[]}`), 0o600)
	if n, _ := Capacity(path, 8); n != 4 {
		t.Fatalf("maxParallel: %d", n)
	}
	_ = os.WriteFile(path, []byte(`{"maxParallel":40,"accounts":[]}`), 0o600)
	if n, _ := Capacity(path, 8); n != 8 {
		t.Fatalf("chặn trần: %d", n)
	}
}

// fakeClaude thay CLI thật: ghi lại thư mục cấu hình của mỗi lần đọc /usage (agy ghi "agy") và trả kết quả mẫu.
func fakeClaude(t *testing.T, output string) chan string {
	t.Helper()
	calls := make(chan string, 16)
	savedLook, savedRun := lookPath, runCLI
	lookPath = func(name string) (string, error) { return "/usr/local/bin/" + name, nil }
	runCLI = func(_ context.Context, name string, _ []string, env map[string]string) ([]byte, error) {
		if filepath.Base(name) == "agy" {
			calls <- "agy"
			return nil, nil
		}
		calls <- env["CLAUDE_CONFIG_DIR"]
		return []byte(output), nil
	}
	t.Cleanup(func() { lookPath, runCLI = savedLook, savedRun })
	return calls
}

func waitCall(t *testing.T, calls chan string) string {
	t.Helper()
	select {
	case dir := <-calls:
		return dir
	case <-time.After(5 * time.Second):
		t.Fatal("không đọc quota")
		return ""
	}
}

// Worker đọc quota mọi tài khoản bật khi chạy, rồi đọc lại tài khoản vừa xong run.
func TestWatchReadsUsageAtStartAndAfterRun(t *testing.T) {
	calls := fakeClaude(t, `{"type":"result","result":"Current session: 40% used · resets Oct 13 at 1:39pm (Asia/Saigon)\nCurrent week (all models): 12% used"}`)
	p := pool(t, three)
	fixed(p, t0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { p.Watch(ctx); close(done) }()
	got := map[string]bool{waitCall(t, calls): true, waitCall(t, calls): true, waitCall(t, calls): true}
	if !got[filepath.Join(p.home, ".xdev-hive", "accounts", "claude-3")] || !got[filepath.Join(p.home, ".xdev-hive", "accounts", "claude-4")] || !got["agy"] {
		t.Fatalf("đọc lúc chạy = %v (claude-5 tắt không đọc)", got)
	}
	l, _ := p.Acquire("claude", RoleImplement)
	l.Release()
	if dir := waitCall(t, calls); dir != filepath.Join(p.home, ".xdev-hive", "accounts", "claude-3") {
		t.Fatalf("sau run phải đọc lại claude-3: %q", dir)
	}
	cancel()
	<-done
	st, _ := LoadState(p.state)
	u := st.Usage["claude-3"]
	if u.Session == nil || u.Session.Percent != 40 || u.Week == nil || u.Week.Percent != 12 || u.CheckedAt == nil {
		t.Fatalf("usage = %+v", u)
	}
}

func TestLimitWatcherAcrossWrites(t *testing.T) {
	w := &LimitWatcher{}
	_, _ = w.Write([]byte("... Claude AI usage lim"))
	if w.Hit() {
		t.Fatal("chưa đủ câu")
	}
	_, _ = w.Write([]byte("it reached|1760342400\n"))
	if !w.Hit() {
		t.Fatal("câu bị cắt giữa hai lần ghi phải khớp")
	}
	other := &LimitWatcher{}
	_, _ = other.Write([]byte("all good\n"))
	if other.Hit() {
		t.Fatal("không có câu báo hết lượt")
	}
}
