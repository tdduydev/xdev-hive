package score

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/repolock"
)

// HistoryKeep là thời gian giữ lịch sử điểm (FR-014).
const HistoryKeep = 90 * 24 * time.Hour

// historyLockWait: lần tính khác chỉ giữ khoá trong lúc đọc và ghi vài KB, chờ lâu hơn là có tiến trình treo.
const historyLockWait = 10 * time.Second

// Hành động của một mốc sửa nhanh trên lịch sử.
const (
	MarkApply = "apply"
	MarkUndo  = "undo"
)

// FixMark là một lần áp dụng hay hoàn tác sửa nhanh, để biểu đồ đánh dấu chỗ điểm đổi vì sửa nhanh.
type FixMark struct {
	ID     string `json:"id"`
	Action string `json:"action"`
}

// HistoryEntry là một dòng của score-history.jsonl: chỉ số, id tiêu chí và CLI, không có id gói hay đường dẫn
// (FR-014, FR-015). Day là ngày theo giờ máy lúc ghi, để "một dòng mỗi ngày" khớp ngày người dùng thấy.
type HistoryEntry struct {
	At           time.Time          `json:"ts"`
	Day          string             `json:"day"`
	ScoreVersion int                `json:"scoreVersion"`
	Machine      *float64           `json:"machine"`
	Coverage     float64            `json:"coverage"`
	Groups       map[string]float64 `json:"groups"`
	Profiles     []HistoryProfile   `json:"profiles"`
	Criteria     map[string]float64 `json:"criteria"`
	Fixes        []FixMark          `json:"fixes,omitempty"`
}

// HistoryProfile: Values là giá trị đo thô theo tiêu chí (B2 tỉ lệ 0–1, B5 token/lượt…), để so trước và sau sửa nhanh
// (SC-006) mà không phụ thuộc thang điểm.
type HistoryProfile struct {
	CLI    string             `json:"cli"`
	Score  *float64           `json:"score"`
	Share  float64            `json:"share"`
	Values map[string]float64 `json:"values,omitempty"`
}

// Marks là hàng chờ mốc sửa nhanh chưa có dòng lịch sử. Record gọi cả hai hàm trong lúc giữ khoá lịch sử; bên ghi hàng
// chờ cũng giữ khoá đó (LockHistory), nên không mốc nào chen vào giữa lúc đọc và lúc xoá.
type Marks interface {
	Pending() ([]FixMark, error)
	// Done bỏ n mốc đầu hàng chờ, gọi sau khi dòng chứa chúng đã ghi xong.
	Done(n int) error
}

// LockHistory khoá lịch sử điểm và hàng chờ sửa nhanh trong dir giữa các tiến trình (app desktop có thể chạy hai lệnh
// score cùng lúc). Dùng khoá file như thư mục phiên của bộ tối ưu (runner/guard_local.go), chạy được trên Windows.
func LockHistory(dir string) (func(), error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), historyLockWait)
	defer cancel()
	f, err := repolock.LockFile(ctx, filepath.Join(dir, "score.lock"))
	if err != nil {
		return nil, fmt.Errorf("không khoá được lịch sử điểm: %w", err)
	}
	return func() { _ = repolock.UnlockFile(f); _ = f.Close() }, nil
}

func historyPath(dir string) string { return filepath.Join(dir, "score-history.jsonl") }

// localDay là ngày theo giờ máy: người dùng ở UTC+7 tính lúc 6 giờ sáng là ngày mới, không phải ngày hôm qua theo UTC.
func localDay(t time.Time) string { return t.In(time.Local).Format(time.DateOnly) }

// entryOf gộp điểm tiêu chí và nhóm của các gói tính vào điểm máy, theo cùng trọng số với điểm máy.
func entryOf(r *Result, fixes []FixMark, now time.Time) HistoryEntry {
	at := now.In(time.Local).Truncate(time.Second)
	e := HistoryEntry{At: at, Day: at.Format(time.DateOnly), ScoreVersion: r.ScoreVersion, Machine: r.Machine.Score,
		Coverage: r.Machine.Coverage, Groups: map[string]float64{}, Profiles: []HistoryProfile{}, Criteria: map[string]float64{},
		Fixes: fixes}
	var counted []ProfileScore
	shared := false
	for _, p := range r.Profiles {
		hp := HistoryProfile{CLI: p.CLI, Score: p.Score, Share: p.Share}
		for _, c := range p.Criteria {
			if measured(c.Status) && c.Value != nil {
				if hp.Values == nil {
					hp.Values = map[string]float64{}
				}
				hp.Values[c.ID] = *c.Value
			}
		}
		e.Profiles = append(e.Profiles, hp)
		if p.Counted && p.Score != nil {
			counted = append(counted, p)
			shared = shared || p.Share > 0
		}
	}
	for _, p := range counted {
		w := 1 / float64(len(counted))
		if shared {
			w = p.Share
		}
		for g, v := range p.Groups {
			e.Groups[g] = round2(e.Groups[g] + w*v.Earned)
		}
		for _, c := range p.Criteria {
			if measured(c.Status) {
				e.Criteria[c.ID] = round2(e.Criteria[c.ID] + w*c.Earned)
			}
		}
	}
	return e
}

// parseEntry đọc một dòng, kể cả dòng của bản trước: `fix` (một mã, luôn là áp dụng) đổi sang `fixes`, thiếu `day`
// thì lấy ngày địa phương của ts.
func parseEntry(line []byte) (HistoryEntry, bool) {
	var raw struct {
		HistoryEntry
		Fix string `json:"fix"`
	}
	if json.Unmarshal(line, &raw) != nil || raw.At.IsZero() {
		return HistoryEntry{}, false
	}
	e := raw.HistoryEntry
	if raw.Fix != "" && len(e.Fixes) == 0 {
		e.Fixes = []FixMark{{ID: raw.Fix, Action: MarkApply}}
	}
	if e.Day == "" {
		e.Day = localDay(e.At)
	}
	return e, true
}

// readHistory đọc các dòng còn trong 90 ngày, xếp theo thời gian tăng dần. Dòng hỏng bị bỏ.
func readHistory(dir string, now time.Time) ([]HistoryEntry, error) {
	b, err := os.ReadFile(historyPath(dir))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var kept []HistoryEntry
	sc := bufio.NewScanner(bytes.NewReader(b))
	sc.Buffer(make([]byte, 1<<16), 1<<22)
	for sc.Scan() {
		if e, ok := parseEntry(sc.Bytes()); ok && now.Sub(e.At) <= HistoryKeep {
			kept = append(kept, e)
		}
	}
	sort.SliceStable(kept, func(i, j int) bool { return kept[i].At.Before(kept[j].At) })
	return kept, nil
}

// History trả lịch sử theo thời gian tăng dần cho `optimize score history`; days > 0 chỉ lấy days ngày địa phương gần
// nhất, kể cả hôm nay. Không tính điểm.
func History(dir string, now time.Time, days int) ([]HistoryEntry, error) {
	unlock, err := LockHistory(dir)
	if err != nil {
		return nil, err
	}
	defer unlock()
	all, err := readHistory(dir, now)
	if err != nil || days <= 0 {
		return all, err
	}
	from := now.In(time.Local).AddDate(0, 0, -(days - 1)).Format(time.DateOnly)
	out := []HistoryEntry{}
	for _, e := range all {
		if e.Day >= from {
			out = append(out, e)
		}
	}
	return out, nil
}

// previousOf: lần so là dòng gần nhất của một ngày trước hôm nay, để chênh lệch là "so với hôm qua" dù hôm nay đã
// tính nhiều lần; chưa có ngày nào trước thì lấy dòng gần nhất.
func previousOf(kept []HistoryEntry, today string) *Previous {
	for i := len(kept) - 1; i >= 0; i-- {
		if kept[i].Day < today {
			return &Previous{Score: kept[i].Machine, At: kept[i].At.Format(time.RFC3339)}
		}
	}
	if n := len(kept); n > 0 {
		return &Previous{Score: kept[n-1].Machine, At: kept[n-1].At.Format(time.RFC3339)}
	}
	return nil
}

// Record ghi một dòng lịch sử khi đây là lần tính đầu trong ngày (theo giờ máy) hoặc khi hàng chờ có mốc sửa nhanh,
// dọn dòng quá 90 ngày, và trả lần tính trước để màn hình hiện chênh lệch. Mốc chỉ rời hàng chờ sau khi dòng đã ghi,
// nên ghi lỗi thì lần tính sau ghi lại. marks nil là không có hàng chờ.
func Record(dir string, r *Result, now time.Time, marks Marks) (*Previous, error) {
	unlock, err := LockHistory(dir)
	if err != nil {
		return nil, err
	}
	defer unlock()
	kept, err := readHistory(dir, now)
	if err != nil {
		return nil, err
	}
	today := localDay(now)
	prev := previousOf(kept, today)
	var pending []FixMark
	if marks != nil {
		if pending, err = marks.Pending(); err != nil {
			return prev, err
		}
	}
	if len(pending) == 0 && len(kept) > 0 && kept[len(kept)-1].Day == today {
		return prev, nil
	}
	kept = append(kept, entryOf(r, pending, now))
	var buf bytes.Buffer
	for _, e := range kept {
		b, err := json.Marshal(e)
		if err != nil {
			return prev, err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := WriteAtomic(historyPath(dir), buf.Bytes()); err != nil {
		return prev, err
	}
	if len(pending) > 0 {
		return prev, marks.Done(len(pending))
	}
	return prev, nil
}
