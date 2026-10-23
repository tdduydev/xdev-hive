package secretstore

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"
)

func grantsPath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), "secret-grants.jsonl")
}

// fakeClock đặt đồng hồ của nhật ký, trả về hàm tua tới.
func fakeClock(t *testing.T, start time.Time) func(time.Duration) {
	t.Helper()
	cur := start
	now = func() time.Time { return cur }
	t.Cleanup(func() { now = time.Now })
	return func(d time.Duration) { cur = cur.Add(d) }
}

func TestGrantLogAppendReadMergesLeak(t *testing.T) {
	path := grantsPath(t)
	fakeClock(t, t0)
	cat := Catalog{Secrets: []Secret{{Name: "STRIPE_TEST_KEY"}}}
	id, err := Append(path, GrantRecord{
		Kind: KindRun, SessionID: "run_abc#1", Project: "3f9a1c0e7b2d4a55", ProjectName: "shop-api",
		Names: []string{"STRIPE_TEST_KEY", "OLD_KEY"}, Policy: "allow", Outcome: OutcomeGranted,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^g_[0-9A-HJKMNP-TV-Z]{26}$`).MatchString(id) {
		t.Fatalf("id %q không đúng dạng g_ + 26 ký tự Crockford", id)
	}
	if err := MarkLeaked(path, id, []string{"STRIPE_TEST_KEY"}); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(path)
		if st.Mode().Perm() != 0o600 {
			t.Fatalf("quyền %v, muốn 0600", st.Mode().Perm())
		}
	}

	entries, err := ReadLog(path, LogFilter{}, cat)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("dòng leak không được hiện thành lần cấp riêng: %d mục", len(entries))
	}
	e := entries[0]
	want := []LogName{{Name: "STRIPE_TEST_KEY", Leaked: true}, {Name: "OLD_KEY", Deleted: true}}
	if e.ID != id || !e.At.Equal(t0) || e.ProjectName != "shop-api" || fmt.Sprint(e.Names) != fmt.Sprint(want) {
		t.Fatalf("mục đọc ra: %+v", e)
	}
}

func TestGrantLogFilterOrderLimit(t *testing.T) {
	path := grantsPath(t)
	tick := fakeClock(t, t0)
	for i := 0; i < 5; i++ {
		tick(time.Second)
		project := "p1"
		if i%2 == 1 {
			project = "p2"
		}
		if _, err := Append(path, GrantRecord{Kind: KindRun, SessionID: fmt.Sprint(i), Project: project, Names: []string{"A_KEY"}}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := Append(path, GrantRecord{Kind: KindReveal, Names: []string{"B_KEY"}, Copy: true}); err != nil {
		t.Fatal(err)
	}

	all, _ := ReadLog(path, LogFilter{}, Catalog{})
	if len(all) != 6 || all[0].Kind != KindReveal || !all[0].Copy || all[1].SessionID != "4" {
		t.Fatalf("mới nhất phải đứng trước: %+v", all)
	}
	if got, _ := ReadLog(path, LogFilter{Project: "p2"}, Catalog{}); len(got) != 2 {
		t.Fatalf("lọc dự án: %d", len(got))
	}
	if got, _ := ReadLog(path, LogFilter{Name: "B_KEY"}, Catalog{}); len(got) != 1 {
		t.Fatalf("lọc tên: %d", len(got))
	}
	if got, _ := ReadLog(path, LogFilter{Limit: 2}, Catalog{}); len(got) != 2 || got[1].SessionID != "4" {
		t.Fatalf("giới hạn: %+v", got)
	}
}

func TestGrantLogPrunesOldAndOverCap(t *testing.T) {
	path := grantsPath(t)
	tick := fakeClock(t, t0)
	if _, err := Append(path, GrantRecord{Kind: KindRun, SessionID: "old", Names: []string{"A_KEY"}}); err != nil {
		t.Fatal(err)
	}
	tick(logKeep + time.Hour)
	if _, err := Append(path, GrantRecord{Kind: KindRun, SessionID: "new", Names: []string{"A_KEY"}}); err != nil {
		t.Fatal(err)
	}
	got, _ := ReadLog(path, LogFilter{}, Catalog{})
	if len(got) != 1 || got[0].SessionID != "new" {
		t.Fatalf("dòng quá 90 ngày phải bị cắt: %+v", got)
	}

	// Dựng sẵn file đúng trần rồi ghi thêm một dòng: không dựng qua Append để test nhanh.
	var buf bytes.Buffer
	at := now().UTC().Format(time.RFC3339)
	for i := 0; i < logMaxLines; i++ {
		fmt.Fprintf(&buf, `{"id":"g_%d","at":%q,"kind":"run","names":["A_KEY"]}`+"\n", i, at)
	}
	if err := os.WriteFile(path, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Append(path, GrantRecord{Kind: KindRun, SessionID: "last", Names: []string{"A_KEY"}}); err != nil {
		t.Fatal(err)
	}
	lines, _ := readLines(path)
	if len(lines) > logMaxLines || !strings.Contains(string(lines[len(lines)-1]), `"last"`) {
		t.Fatalf("sau khi chạm trần còn %d dòng", len(lines))
	}
	if strings.Contains(string(lines[0]), `"g_0"`) {
		t.Fatal("dòng cũ nhất phải bị cắt trước")
	}
}

func TestGrantLogSkipsBrokenLines(t *testing.T) {
	path := grantsPath(t)
	fakeClock(t, t0)
	if err := os.WriteFile(path, []byte(`{"id":"g_1","at":"2026-10-23T08:00:00Z","kind":"run","na`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Append(path, GrantRecord{Kind: KindRun, SessionID: "ok", Names: []string{"A_KEY"}}); err != nil {
		t.Fatal(err)
	}
	got, err := ReadLog(path, LogFilter{}, Catalog{})
	if err != nil || len(got) != 1 || got[0].SessionID != "ok" {
		t.Fatalf("dòng ghi dở không được làm hỏng dòng sau: %+v %v", got, err)
	}
}

func TestGrantLogClear(t *testing.T) {
	path := grantsPath(t)
	fakeClock(t, t0)
	id, _ := Append(path, GrantRecord{Kind: KindRun, Names: []string{"A_KEY"}})
	_ = MarkLeaked(path, id, []string{"A_KEY"})
	_, _ = Append(path, GrantRecord{Kind: KindTerminal, Names: []string{"A_KEY"}})
	n, err := ClearLog(path)
	if err != nil || n != 2 {
		t.Fatalf("ClearLog: %d %v", n, err)
	}
	if got, _ := ReadLog(path, LogFilter{}, Catalog{}); len(got) != 0 {
		t.Fatalf("còn %d mục sau khi xoá", len(got))
	}
	if n, err := ClearLog(filepath.Join(t.TempDir(), "none.jsonl")); err != nil || n != 0 {
		t.Fatalf("xoá nhật ký chưa có: %d %v", n, err)
	}
}

func TestGrantIDSortsByTime(t *testing.T) {
	a := newGrantID(t0)
	b := newGrantID(t0.Add(time.Millisecond))
	if a >= b {
		t.Fatalf("%s phải đứng trước %s", a, b)
	}
}
