package optimizeall

import (
	"errors"
	"sync"
	"sync/atomic"
	"testing"
)

func TestLockExcludesSecondHolder(t *testing.T) {
	dir := t.TempDir()
	unlock, err := Lock(dir)
	if err != nil {
		t.Fatal(err)
	}
	_, err = Lock(dir)
	var e *Error
	if !errors.Is(err, ErrLocked) || !errors.As(err, &e) || e.Code != "OPTIMIZE_LOCKED" || e.Message != "Đang tối ưu ở cửa sổ khác" {
		t.Fatalf("khoá bận phải trả OPTIMIZE_LOCKED: %v", err)
	}
	unlock()
	again, err := Lock(dir)
	if err != nil {
		t.Fatalf("mở khoá rồi phải khoá lại được: %v", err)
	}
	again()
}

func TestLockParallel(t *testing.T) {
	dir := t.TempDir()
	const n = 8
	var won, busy atomic.Int32
	var start, tried sync.WaitGroup
	start.Add(1)
	tried.Add(n)
	release := make(chan struct{})
	var done sync.WaitGroup
	done.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer done.Done()
			start.Wait()
			unlock, err := Lock(dir)
			tried.Done()
			switch {
			case err == nil:
				won.Add(1)
				<-release
				unlock()
			case errors.Is(err, ErrLocked):
				busy.Add(1)
			default:
				t.Errorf("lỗi lạ: %v", err)
			}
		}()
	}
	start.Done()
	tried.Wait()
	close(release)
	done.Wait()
	if won.Load() != 1 || busy.Load() != n-1 {
		t.Fatalf("giữ khoá %d, bị từ chối %d", won.Load(), busy.Load())
	}
}

func TestApplyAndUndoHonorLock(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	unlock, err := Lock(f.runner.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Apply(plan); !errors.Is(err, ErrLocked) {
		t.Fatalf("Apply khi khoá bận: %v", err)
	}
	if _, err := f.runner.Plan(nil); !errors.Is(err, ErrLocked) {
		t.Fatalf("Plan khi khoá bận: %v", err)
	}
	if _, err := f.runner.Undo("01JB0000000000000000000000"); !errors.Is(err, ErrLocked) {
		t.Fatalf("Undo khi khoá bận: %v", err)
	}
	if readFile(t, f.settings) != userSettings {
		t.Fatal("khoá bận thì không ghi gì")
	}
	unlock()
	if _, err := f.runner.Apply(plan); err != nil {
		t.Fatal(err)
	}
}
