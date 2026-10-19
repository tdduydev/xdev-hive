package score

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

// HistoryKeep là thời gian giữ lịch sử điểm (FR-014).
const HistoryKeep = 90 * 24 * time.Hour

// HistoryEntry là một dòng của score-history.jsonl: chỉ số, id tiêu chí và CLI, không có id gói hay đường dẫn
// (FR-014, FR-015).
type HistoryEntry struct {
	At           time.Time          `json:"ts"`
	ScoreVersion int                `json:"scoreVersion"`
	Machine      *float64           `json:"machine"`
	Coverage     float64            `json:"coverage"`
	Groups       map[string]float64 `json:"groups"`
	Profiles     []HistoryProfile   `json:"profiles"`
	Criteria     map[string]float64 `json:"criteria"`
	Fix          string             `json:"fix,omitempty"`
}

type HistoryProfile struct {
	CLI   string   `json:"cli"`
	Score *float64 `json:"score"`
	Share float64  `json:"share"`
}

// entryOf gộp điểm tiêu chí và nhóm của các gói tính vào điểm máy, theo cùng trọng số với điểm máy.
func entryOf(r *Result, fix string, now time.Time) HistoryEntry {
	e := HistoryEntry{At: now.UTC(), ScoreVersion: r.ScoreVersion, Machine: r.Machine.Score, Coverage: r.Machine.Coverage,
		Groups: map[string]float64{}, Profiles: []HistoryProfile{}, Criteria: map[string]float64{}, Fix: fix}
	var counted []ProfileScore
	shared := false
	for _, p := range r.Profiles {
		e.Profiles = append(e.Profiles, HistoryProfile{CLI: p.CLI, Score: p.Score, Share: p.Share})
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

// Record ghi một dòng lịch sử khi đây là lần tính đầu trong ngày (UTC) hoặc ngay sau một sửa nhanh, dọn dòng quá 90
// ngày, và trả lần tính trước đó để màn hình hiện chênh lệch.
func Record(dir string, r *Result, fix string, now time.Time) (*Previous, error) {
	path := filepath.Join(dir, "score-history.jsonl")
	var kept []HistoryEntry
	if b, err := os.ReadFile(path); err == nil {
		sc := bufio.NewScanner(bytes.NewReader(b))
		sc.Buffer(make([]byte, 1<<16), 1<<22)
		for sc.Scan() {
			var e HistoryEntry
			if json.Unmarshal(sc.Bytes(), &e) != nil || now.Sub(e.At) > HistoryKeep {
				continue
			}
			kept = append(kept, e)
		}
	}
	var prev *Previous
	if n := len(kept); n > 0 {
		last := kept[n-1]
		prev = &Previous{Score: last.Machine, At: last.At.Format(time.RFC3339)}
	}
	sameDay := len(kept) > 0 && kept[len(kept)-1].At.UTC().Format(time.DateOnly) == now.UTC().Format(time.DateOnly)
	if fix == "" && sameDay {
		return prev, nil
	}
	kept = append(kept, entryOf(r, fix, now))
	var buf bytes.Buffer
	for _, e := range kept {
		b, err := json.Marshal(e)
		if err != nil {
			return prev, err
		}
		buf.Write(b)
		buf.WriteByte('\n')
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return prev, err
	}
	return prev, writeAtomic(path, buf.Bytes())
}
