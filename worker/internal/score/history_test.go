package score

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// marksOf là hàng chờ trong bộ nhớ; Done ghi lại số mốc đã bỏ.
type marksOf struct {
	list []FixMark
	done int
}

func (m *marksOf) Pending() ([]FixMark, error) { return m.list, nil }
func (m *marksOf) Done(n int) error            { m.done += n; m.list = m.list[n:]; return nil }

func historyLines(t *testing.T, dir string) []HistoryEntry {
	t.Helper()
	b, err := os.ReadFile(historyPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	var out []HistoryEntry
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		e, ok := parseEntry([]byte(line))
		if !ok {
			t.Fatalf("dòng hỏng: %s", line)
		}
		out = append(out, e)
	}
	return out
}

// inZone đặt giờ máy cho một test; test của gói không chạy song song nên đổi time.Local được.
func inZone(t *testing.T, offsetHours int) {
	t.Helper()
	old := time.Local
	time.Local = time.FixedZone(fmt.Sprintf("UTC%+d", offsetHours), offsetHours*3600)
	t.Cleanup(func() { time.Local = old })
}

func simpleResult(score float64) *Result {
	return &Result{ScoreVersion: Version, Machine: Machine{Score: &score, Coverage: 100}}
}

func TestHistory(t *testing.T) {
	inZone(t, 0)
	home := t.TempDir()
	dir := filepath.Join(home, "optimizer")
	p := claudeProfile(home, "claude-secret-id")
	write(t, filepath.Join(p.Dir, "settings.json"), balancedSettings)
	sessions := fiveSessions("claude-secret-id", 210_000, 35_000)
	for i := range sessions {
		sessions[i].Cwd = filepath.Join(home, "code", "secret-project")
	}
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Sessions: sessions})
	prev, err := Record(dir, res, now, nil)
	if err != nil || prev != nil {
		t.Fatalf("lần đầu: %v, %v", prev, err)
	}
	if prev, _ = Record(dir, res, now.Add(time.Hour), nil); prev == nil || prev.At != now.Format(time.RFC3339) {
		t.Errorf("lần sau trả lần trước: %+v", prev)
	}
	marks := &marksOf{list: []FixMark{{ID: FixBalanced, Action: MarkApply}, {ID: FixRTK, Action: MarkUndo}}}
	if _, err := Record(dir, res, now.Add(2*time.Hour), marks); err != nil || marks.done != 2 {
		t.Fatalf("mốc phải rời hàng chờ sau khi ghi: done %d, %v", marks.done, err)
	}
	_, _ = Record(dir, res, now.Add(24*time.Hour), nil)
	lines := historyLines(t, dir)
	if len(lines) != 3 {
		t.Fatalf("muốn 3 dòng (ngày 1, sau sửa nhanh, ngày 2), có %d", len(lines))
	}
	b, _ := os.ReadFile(historyPath(dir))
	for _, secret := range []string{"claude-secret-id", "secret-project", home, filepath.ToSlash(home)} {
		if strings.Contains(string(b), secret) {
			t.Errorf("lịch sử có %q", secret)
		}
	}
	if got := fmt.Sprint(lines[1].Fixes); got != fmt.Sprint(marks2()) {
		t.Errorf("dòng sửa nhanh có mốc %s, muốn %s", got, fmt.Sprint(marks2()))
	}
	v := lines[0].Profiles[0].Values
	if v["A1"] != 160_000 || v["B1"] != 210_000 {
		t.Errorf("giá trị đo thô: %v", v)
	}
	if lines[0].Day != "2026-10-19" || lines[2].Day != "2026-10-20" {
		t.Errorf("ngày: %s, %s", lines[0].Day, lines[2].Day)
	}
	// Dòng quá 90 ngày bị dọn.
	_, _ = Record(dir, res, now.Add(100*24*time.Hour), &marksOf{list: []FixMark{{ID: FixRTK, Action: MarkApply}}})
	if n := len(historyLines(t, dir)); n != 1 {
		t.Errorf("còn %d dòng, muốn 1", n)
	}
}

func marks2() []FixMark {
	return []FixMark{{ID: FixBalanced, Action: MarkApply}, {ID: FixRTK, Action: MarkUndo}}
}

// UTC+7: 23:00 ngày 19 và 00:30 ngày 20 theo giờ máy cùng là ngày 19 theo UTC, nhưng là hai ngày với người dùng.
func TestHistoryUsesLocalDay(t *testing.T) {
	inZone(t, 7)
	dir := t.TempDir()
	late := time.Date(2026, 10, 19, 16, 0, 0, 0, time.UTC)
	_, _ = Record(dir, simpleResult(50), late, nil)
	_, _ = Record(dir, simpleResult(55), late.Add(time.Hour), nil)
	prev, _ := Record(dir, simpleResult(60), late.Add(90*time.Minute), nil)
	lines := historyLines(t, dir)
	if len(lines) != 2 || lines[0].Day != "2026-10-19" || lines[1].Day != "2026-10-20" {
		t.Fatalf("muốn một dòng tự động mỗi ngày giờ máy: %+v", lines)
	}
	b, _ := os.ReadFile(historyPath(dir))
	if !strings.Contains(string(b), `"ts":"2026-10-19T23:00:00+07:00"`) {
		t.Errorf("ts phải là RFC3339 có độ lệch giờ máy: %s", b)
	}
	// Hôm nay đã có dòng (55 lúc 00:00): lần trước vẫn là dòng của hôm qua.
	if prev == nil || *prev.Score != 50 || prev.At != "2026-10-19T23:00:00+07:00" {
		t.Errorf("lần trước phải là dòng cuối của ngày trước: %+v", prev)
	}
}

func TestPreviousOf(t *testing.T) {
	at := func(day string, score float64) HistoryEntry {
		ts, _ := time.Parse(time.DateOnly, day)
		return HistoryEntry{At: ts, Day: day, Machine: &score}
	}
	if previousOf(nil, "2026-10-20") != nil {
		t.Error("chưa có dòng nào thì null")
	}
	kept := []HistoryEntry{at("2026-10-18", 40), at("2026-10-19", 50), at("2026-10-20", 60), at("2026-10-20", 70)}
	if p := previousOf(kept, "2026-10-20"); *p.Score != 50 {
		t.Errorf("lấy dòng gần nhất của ngày trước hôm nay: %+v", p)
	}
	if p := previousOf(kept[2:], "2026-10-20"); *p.Score != 70 {
		t.Errorf("chưa có ngày trước thì lấy dòng gần nhất: %+v", p)
	}
}

func TestHistoryReadsLegacyLines(t *testing.T) {
	inZone(t, 7)
	dir := t.TempDir()
	write(t, historyPath(dir), `{"ts":"2026-10-18T09:00:00Z","scoreVersion":1,"machine":40,"coverage":80,"groups":{},"profiles":[{"cli":"claude","score":40,"share":1}],"criteria":{},"fix":"optimizer.balanced"}
không phải JSON
`)
	got, err := History(dir, now, 0)
	if err != nil || len(got) != 1 {
		t.Fatalf("lịch sử: %+v, %v", got, err)
	}
	e := got[0]
	if e.Day != "2026-10-18" || len(e.Fixes) != 1 || e.Fixes[0] != (FixMark{ID: FixBalanced, Action: MarkApply}) {
		t.Errorf("dòng cũ phải có day và fixes: %+v", e)
	}
	b, _ := json.Marshal(e)
	if strings.Contains(string(b), `"fix"`) {
		t.Errorf("không ghi lại trường fix cũ: %s", b)
	}
}

func TestHistoryDays(t *testing.T) {
	inZone(t, 0)
	dir := t.TempDir()
	for i := 40; i >= 0; i-- {
		_, _ = Record(dir, simpleResult(float64(i)), now.AddDate(0, 0, -i), nil)
	}
	all, _ := History(dir, now, 0)
	month, _ := History(dir, now, 30)
	if len(all) != 41 || len(month) != 30 || month[0].Day != "2026-09-20" || month[29].Day != "2026-10-19" {
		t.Errorf("tất cả %d dòng, 30 ngày %d dòng từ %s", len(all), len(month), month[0].Day)
	}
	if empty, err := History(t.TempDir(), now, 30); err != nil || empty == nil || len(empty) != 0 {
		t.Errorf("chưa có lịch sử: %#v, %v", empty, err)
	}
}

// Tiến trình con của TestHistoryConcurrentProcesses: ghi một lần như một lệnh `optimize score`.
func TestHistoryHelperProcess(t *testing.T) {
	dir := os.Getenv("HIVE_SCORE_HISTORY_DIR")
	if dir == "" {
		t.Skip("chỉ chạy làm tiến trình con")
	}
	var marks Marks
	if os.Getenv("HIVE_SCORE_HISTORY_MARK") != "" {
		marks = &marksOf{list: []FixMark{{ID: FixBalanced, Action: MarkApply}}}
	}
	if _, err := Record(dir, simpleResult(50), now, marks); err != nil {
		t.Fatal(err)
	}
}

func TestHistoryConcurrentProcesses(t *testing.T) {
	const n = 8
	run := func(dir string, mark bool) {
		var wg sync.WaitGroup
		errs := make(chan error, n)
		for range n {
			wg.Add(1)
			go func() {
				defer wg.Done()
				cmd := exec.Command(os.Args[0], "-test.run=^TestHistoryHelperProcess$")
				cmd.Env = append(os.Environ(), "HIVE_SCORE_HISTORY_DIR="+dir)
				if mark {
					cmd.Env = append(cmd.Env, "HIVE_SCORE_HISTORY_MARK=1")
				}
				if out, err := cmd.CombinedOutput(); err != nil {
					errs <- fmt.Errorf("%v: %s", err, out)
				}
			}()
		}
		wg.Wait()
		close(errs)
		for err := range errs {
			t.Fatal(err)
		}
	}
	dir := t.TempDir()
	run(dir, false)
	if lines := historyLines(t, dir); len(lines) != 1 {
		t.Errorf("%d lệnh score cùng ngày phải ghi đúng một dòng tự động, có %d", n, len(lines))
	}
	dir = t.TempDir()
	run(dir, true)
	if lines := historyLines(t, dir); len(lines) != n {
		t.Errorf("%d lệnh có mốc sửa nhanh phải ghi %d dòng, có %d", n, n, len(lines))
	}
}
