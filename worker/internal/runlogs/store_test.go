package runlogs

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestStorePagingAndRetention(t *testing.T) {
	s := Store{Dir: filepath.Join(t.TempDir(), "logs")}
	now := time.Now()
	for attempt, days := range []int{30, 90} {
		f, err := s.Open(Entry{RunID: "run-1", Attempt: attempt + 1, RetentionDays: days})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.WriteString(strings.Repeat("a", MaxRead+7)); err != nil {
			t.Fatal(err)
		}
		if err := f.Close(); err != nil {
			t.Fatal(err)
		}
		old := now.AddDate(0, 0, -40)
		if err := os.Chtimes(f.Name(), old, old); err != nil {
			t.Fatal(err)
		}
		if runtime.GOOS != "windows" {
			info, _ := os.Stat(f.Name())
			if info.Mode().Perm() != 0600 {
				t.Fatalf("quyền: %v", info.Mode())
			}
		}
	}
	p, err := s.Read("run-1", 0, 0, 1000000)
	if err != nil || p.Attempt != 2 || len(p.Bytes) != MaxRead {
		t.Fatalf("trang đầu: %+v, %v", p, err)
	}
	p, err = s.Read("run-1", 2, p.NextOffset, 100)
	if err != nil || string(p.Bytes) != "aaaaaaa" || p.NextOffset != p.Size {
		t.Fatalf("trang sau: %+v, %v", p, err)
	}
	if err := s.Cleanup(now); err != nil {
		t.Fatal(err)
	}
	list, err := s.List()
	if err != nil || len(list) != 1 || list[0].Attempt != 2 {
		t.Fatalf("giữ theo từng lần thử: %+v %v", list, err)
	}
	if _, err := (Store{Dir: s.Dir}).Read("run-1", 2, 0, 10); err != nil {
		t.Fatal("không còn sau mở lại:", err)
	}
}

func TestRejectUnsafePathsAndReadBounds(t *testing.T) {
	s := Store{Dir: t.TempDir()}
	for _, id := range []string{"../run", "..", "a/b", `a\b`, "C:run", ""} {
		if _, err := s.Open(Entry{RunID: id, Attempt: 1}); err == nil {
			t.Fatal("nhận mã không hợp lệ", id)
		}
		if _, err := s.Read(id, 1, 0, 1); err == nil {
			t.Fatal("đọc mã không hợp lệ", id)
		}
	}
	if _, err := s.Read("run", 1, -1, 1); err == nil {
		t.Fatal("nhận offset âm")
	}
	if _, err := s.Read("run", 1, 0, -1); err == nil {
		t.Fatal("nhận limit âm")
	}
}
