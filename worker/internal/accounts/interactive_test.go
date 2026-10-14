package accounts

import (
	"errors"
	"testing"
	"time"
)

// Phiên tương tác (specs/010 D10): không áp ngưỡng dừng, không chặn theo maxConcurrent, bỏ gói tắt/đang nghỉ, tính là
// đang dùng.
func TestAcquireInteractive(t *testing.T) {
	p := pool(t, three)
	fixed(p, t0)
	// claude-3 chạm ngưỡng phiên: run không nhận, phiên tương tác vẫn nhận.
	if err := UpdateState(p.state, t0, func(s *State) { s.Usage["claude-3"] = Usage{Session: &Limit{Percent: 99}} }); err != nil {
		t.Fatal(err)
	}
	if l, err := p.Acquire("claude", RoleImplement); err != nil || l.ID() != "claude-4" {
		t.Fatalf("run phải tránh claude-3 chạm ngưỡng: %v %v", l.ID(), err)
	}
	chosen, err := p.AcquireInteractive("claude", "claude-3")
	if err != nil || chosen.ID() != "claude-3" {
		t.Fatalf("chọn claude-3: %v %v", chosen.ID(), err)
	}
	// claude-3 đã đủ maxConcurrent 1: tự chọn sang gói còn chỗ; chọn đích danh thì vẫn nhận.
	auto, err := p.AcquireInteractive("claude", "")
	if err != nil || auto.ID() != "claude-4" {
		t.Fatalf("tự chọn = %v %v", auto.ID(), err)
	}
	again, err := p.AcquireInteractive("claude", "claude-3")
	if err != nil || again.ID() != "claude-3" {
		t.Fatalf("chọn lại claude-3: %v %v", again.ID(), err)
	}
	if p.active["claude-3"] != 2 {
		t.Fatalf("phiên phải tính là đang dùng: active = %d", p.active["claude-3"])
	}
	again.Release()
	chosen.Release()
	for _, id := range []string{"claude-5", "khong-co", "antigravity-1"} {
		if _, err := p.AcquireInteractive("claude", id); !errors.Is(err, ErrNoAccount) {
			t.Fatalf("%s: err = %v", id, err)
		}
	}
	if err := UpdateState(p.state, t0, func(s *State) { s.CoolUntil["claude-4"] = t0.Add(time.Hour) }); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireInteractive("claude", "claude-4"); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("gói đang nghỉ: err = %v", err)
	}
	if l, err := p.AcquireInteractive("claude", ""); err != nil || l.ID() != "claude-3" {
		t.Fatalf("tự chọn phải bỏ gói đang nghỉ: %v %v", l.ID(), err)
	}
	// CLI không có gói nào: đăng nhập mặc định.
	if l, err := p.AcquireInteractive("codex", ""); l != nil || err != nil {
		t.Fatalf("codex: %v %v", l, err)
	}
	var none *Pool
	if l, err := none.AcquireInteractive("claude", ""); l != nil || err != nil {
		t.Fatalf("pool nil: %v %v", l, err)
	}
	if _, err := none.AcquireInteractive("claude", "claude-3"); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("pool nil có id: %v", err)
	}
}

// `hive chat --force` (specs/010 D10): nhận gói đang nghỉ; tự chọn thì gói nghỉ chỉ khi không còn gói nào khác.
func TestAcquireInteractiveForce(t *testing.T) {
	p := pool(t, three)
	fixed(p, t0)
	if err := UpdateState(p.state, t0, func(s *State) { s.CoolUntil["claude-4"] = t0.Add(time.Hour) }); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireInteractiveForce("claude", "claude-4", false); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("không force: err = %v", err)
	}
	l, err := p.AcquireInteractiveForce("claude", "claude-4", true)
	if err != nil || l.ID() != "claude-4" {
		t.Fatalf("force claude-4: %v %v", l.ID(), err)
	}
	l.Release()
	if l, err := p.AcquireInteractiveForce("claude", "", true); err != nil || l.ID() != "claude-3" {
		t.Fatalf("tự chọn phải ưu tiên gói không nghỉ: %v %v", l.ID(), err)
	}
	if err := UpdateState(p.state, t0, func(s *State) { s.CoolUntil["claude-3"] = t0.Add(time.Hour) }); err != nil {
		t.Fatal(err)
	}
	if _, err := p.AcquireInteractiveForce("claude", "", false); !errors.Is(err, ErrBusy) {
		t.Fatalf("mọi gói nghỉ, không force: err = %v", err)
	}
	if l, err := p.AcquireInteractiveForce("claude", "", true); err != nil || l == nil {
		t.Fatalf("mọi gói nghỉ, force: %v %v", l, err)
	}
	// Gói tắt vẫn không nhận dù force.
	if _, err := p.AcquireInteractiveForce("claude", "claude-5", true); !errors.Is(err, ErrNoAccount) {
		t.Fatalf("gói tắt: err = %v", err)
	}
}
