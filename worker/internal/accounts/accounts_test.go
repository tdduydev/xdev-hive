package accounts

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func pool(t *testing.T, body string) *Pool {
	t.Helper()
	path := filepath.Join(t.TempDir(), "accounts.json")
	if body != "" {
		if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	p := NewPool(path)
	p.home = "/home/duy"
	return p
}

const three = `{"accounts":[
 {"id":"claude-3","label":"claude-3","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-3","enabled":true,"priority":30,"maxConcurrent":1,"cooldownMinutes":60},
 {"id":"claude-4","label":"vudd7","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-4","enabled":true,"priority":0,"maxConcurrent":2},
 {"id":"claude-5","cli":"claude","configDir":"/x","enabled":false,"priority":99,"maxConcurrent":1},
 {"id":"antigravity-1","cli":"antigravity","enabled":true,"priority":50}
]}`

func TestAcquirePriorityConcurrencyAndDisabled(t *testing.T) {
	p := pool(t, three)
	first, err := p.Acquire("claude")
	if err != nil || first.Label() != "claude-3" {
		t.Fatalf("ưu tiên cao nhất phải là claude-3: %v %v", first.Label(), err)
	}
	if got := first.Env()["CLAUDE_CONFIG_DIR"]; got != "/home/duy/.xdev-hive/accounts/claude-3" {
		t.Fatalf("CLAUDE_CONFIG_DIR = %q", got)
	}
	// claude-3 đủ một run; claude-5 tắt dù ưu tiên cao: hai run sau vào claude-4 (cho phép 2).
	second, _ := p.Acquire("claude")
	third, _ := p.Acquire("claude")
	if second.Label() != "vudd7" || third.Label() != "vudd7" {
		t.Fatalf("got %q, %q", second.Label(), third.Label())
	}
	if _, err := p.Acquire("claude"); !errors.Is(err, ErrBusy) {
		t.Fatalf("hết chỗ phải ErrBusy, got %v", err)
	}
	first.Release()
	first.Release() // trả hai lần cũng chỉ trả một chỗ
	again, _ := p.Acquire("claude")
	if again.Label() != "claude-3" {
		t.Fatalf("trả chỗ xong phải chọn lại claude-3, got %q", again.Label())
	}
	if _, err := p.Acquire("claude"); !errors.Is(err, ErrBusy) {
		t.Fatalf("Release hai lần không được tạo thêm chỗ: %v", err)
	}
}

func TestCooldownSkipsAccountUntilItEnds(t *testing.T) {
	p := pool(t, three)
	now := time.Date(2026, 10, 13, 9, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return now }
	l, _ := p.Acquire("claude")
	l.Cooldown()
	l.Release()
	next, _ := p.Acquire("claude")
	if next.Label() != "vudd7" {
		t.Fatalf("tài khoản đang nghỉ vẫn được chọn: %q", next.Label())
	}
	next.Release()
	now = now.Add(61 * time.Minute)
	back, _ := p.Acquire("claude")
	if back.Label() != "claude-3" {
		t.Fatalf("hết nghỉ phải chọn lại claude-3, got %q", back.Label())
	}
}

func TestNoAccountsMeansDefaultLogin(t *testing.T) {
	if l, err := pool(t, "").Acquire("claude"); l != nil || err != nil {
		t.Fatalf("không có file: %v %v", l, err)
	}
	// Có file nhưng không có tài khoản Codex: Codex dùng đăng nhập mặc định.
	if l, err := pool(t, three).Acquire("codex"); l != nil || err != nil {
		t.Fatalf("CLI không có tài khoản: %v %v", l, err)
	}
	// CLI worker không điều khiển (Antigravity) không bao giờ được chọn.
	if l, err := pool(t, three).Acquire("antigravity"); l != nil || err != nil {
		t.Fatalf("antigravity: %v %v", l, err)
	}
	var none *Pool
	if l, err := none.Acquire("claude"); l != nil || err != nil {
		t.Fatalf("pool nil: %v %v", l, err)
	}
	if none := (*Lease)(nil); none.Env() != nil || none.Label() != "" {
		t.Fatal("lease nil phải không đặt biến nào")
	}
}

func TestCapacity(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "accounts.json")
	if n, _ := Capacity(path, 8); n != 1 {
		t.Fatalf("không có file: %d", n)
	}
	_ = os.WriteFile(path, []byte(three), 0o600)
	// claude-3 (1) + claude-4 (2); claude-5 tắt, antigravity worker không chạy.
	if n, _ := Capacity(path, 8); n != 3 {
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
