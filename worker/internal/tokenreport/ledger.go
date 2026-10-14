package tokenreport

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// TrimStats là số ký tự hook đã cắt, đọc từ ledger.jsonl của các phiên (chỉ có số, không có nội dung).
type TrimStats struct {
	Entries     int                 `json:"entries"`
	CharsBefore int64               `json:"charsBefore"`
	CharsAfter  int64               `json:"charsAfter"`
	CharsCut    int64               `json:"charsCut"`
	ByTool      map[string]TrimTool `json:"byTool"`
}

type TrimTool struct {
	Entries  int   `json:"entries"`
	CharsCut int64 `json:"charsCut"`
}

type ledgerEntry struct {
	TS     json.RawMessage `json:"ts"`
	Tool   string          `json:"tool"`
	Before int64           `json:"before"`
	After  int64           `json:"after"`
}

// ledgerTime nhận RFC 3339 hoặc số (giây hay mili giây Unix), vì định dạng do hook cục bộ quyết định.
func ledgerTime(raw json.RawMessage) time.Time {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		if t := parseTime(s); !t.IsZero() {
			return t
		}
		n, err := strconv.ParseFloat(strings.TrimSpace(s), 64)
		if err != nil {
			return time.Time{}
		}
		return unixTime(n)
	}
	var n float64
	if json.Unmarshal(raw, &n) == nil {
		return unixTime(n)
	}
	return time.Time{}
}

func unixTime(n float64) time.Time {
	if n > 1e11 {
		return time.UnixMilli(int64(n))
	}
	return time.Unix(int64(n), 0)
}

// readLedger cộng mọi `<optimizerDir>/sessions/*/ledger.jsonl`. Có mốc `from` thì chỉ tính dòng từ mốc trở đi: hook chỉ
// cắt sau khi bật, dòng cũ hơn là của lần bật trước đó.
func readLedger(optimizerDir string, from time.Time) *TrimStats {
	files, _ := filepath.Glob(filepath.Join(optimizerDir, "sessions", "*", "ledger.jsonl"))
	if len(files) == 0 {
		return nil
	}
	st := &TrimStats{ByTool: map[string]TrimTool{}}
	for _, f := range files {
		_ = forEachLine(f, func(line []byte) {
			var e ledgerEntry
			if !decodeLine(line, &e) {
				return
			}
			if !from.IsZero() {
				if ts := ledgerTime(e.TS); ts.IsZero() || ts.Before(from) {
					return
				}
			}
			cut := max(0, e.Before-e.After)
			st.Entries++
			st.CharsBefore += e.Before
			st.CharsAfter += e.After
			st.CharsCut += cut
			t := st.ByTool[e.Tool]
			t.Entries++
			t.CharsCut += cut
			st.ByTool[e.Tool] = t
		})
	}
	return st
}
