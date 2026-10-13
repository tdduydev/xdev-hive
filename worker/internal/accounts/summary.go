package accounts

import (
	"math"
	"time"
	"unicode/utf8"
)

// maxSummaries là số tài khoản tối đa trong một heartbeat; hợp đồng (workerAccountSummary) chặn 32 và hub từ chối cả gói
// khi vượt.
const maxSummaries = 32

// Summary là phần của một tài khoản worker báo hub trong heartbeat (specs/011 FR-043). Cố ý không có email, token hay
// thư mục cấu hình: quản trị đội chỉ cần thấy gói nào còn dùng được. Trường nullable luôn có mặt (null), không omitempty,
// vì hợp đồng đòi đủ trường.
type Summary struct {
	ID    string   `json:"id"`
	CLI   string   `json:"cli"`
	Label string   `json:"label"`
	Roles []string `json:"roles"`
	// Enabled, LoggedIn: LoggedIn null khi worker không kiểm được đăng nhập của CLI này.
	Enabled    bool     `json:"enabled"`
	LoggedIn   *bool    `json:"loggedIn"`
	SessionPct *float64 `json:"sessionPct"`
	WeekPct    *float64 `json:"weekPct"`
	// ResetsAt là lúc quota phiên 5 giờ đặt lại, RFC3339 UTC có mili giây (z.iso.datetime() đòi chữ Z).
	ResetsAt      *string `json:"resetsAt"`
	StopAtSession int     `json:"stopAtSession"`
	StopAtWeek    int     `json:"stopAtWeek"`
	InUse         int     `json:"inUse"`
}

const summaryTime = "2006-01-02T15:04:05.000Z"

// Summaries đọc accounts.json và accounts-state.json thành tóm tắt cho heartbeat. Tài khoản đang đăng nhập dở (Pending)
// chưa phải của máy nên không báo.
func Summaries(path, home string, now time.Time) ([]Summary, error) {
	list, err := Load(path)
	if err != nil {
		return nil, err
	}
	st, err := LoadState(StatePath(path))
	if err != nil {
		return nil, err
	}
	ready := list[:0:0]
	for _, a := range list {
		if !a.Pending {
			ready = append(ready, a)
		}
	}
	out := make([]Summary, 0, len(ready))
	for _, v := range Views(ready, st, home, now) {
		if len(out) == maxSummaries {
			break
		}
		s := Summary{
			ID:            v.ID,
			CLI:           v.CLI,
			Label:         truncate(v.Label, 80),
			Roles:         append([]string{}, v.Roles...),
			Enabled:       v.Enabled,
			LoggedIn:      v.LoggedIn,
			StopAtSession: clampPercent(v.StopAtSession),
			StopAtWeek:    clampPercent(v.StopAtWeek),
			InUse:         max(0, min(v.Active, 64)),
		}
		if v.Usage.Session != nil {
			s.SessionPct = percentOf(v.Usage.Session)
			if at := v.Usage.Session.ResetsAt; at != nil {
				text := at.UTC().Format(summaryTime)
				s.ResetsAt = &text
			}
		}
		if v.Usage.Week != nil {
			s.WeekPct = percentOf(v.Usage.Week)
		}
		out = append(out, s)
	}
	return out, nil
}

func percentOf(l *Limit) *float64 {
	// NaN làm json.Marshal lỗi và mất cả heartbeat; coi như chưa biết.
	if math.IsNaN(l.Percent) {
		return nil
	}
	p := max(0, min(l.Percent, 100))
	return &p
}

func clampPercent(n int) int { return max(0, min(n, 100)) }

// truncate cắt theo ký tự (không cắt giữa một chữ có dấu) để nhãn không vượt giới hạn của hợp đồng.
func truncate(s string, n int) string {
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n])
}
