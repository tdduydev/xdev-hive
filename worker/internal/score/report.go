package score

import (
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"time"
)

// Report là điểm máy gửi lên hub (sự kiện `machine.token_score`, ADR 0036). Chỉ có số, enum và mã lý do: hub kiểm bằng
// schema strict nên mọi trường khác (id gói, nhãn, đường dẫn, dự án, mục con, cảnh báo) làm hub từ chối cả báo cáo.
// Struct riêng thay vì dùng lại Result để thêm trường vào Result không tự rò lên hub.
type Report struct {
	ScoreVersion int             `json:"scoreVersion"`
	GeneratedAt  string          `json:"generatedAt"`
	Days         int             `json:"days"`
	Machine      ReportMachine   `json:"machine"`
	Profiles     []ReportProfile `json:"profiles"`
}

type ReportMachine struct {
	Score       *float64 `json:"score"`
	Level       *string  `json:"level"`
	Coverage    float64  `json:"coverage"`
	Provisional bool     `json:"provisional"`
}

type ReportProfile struct {
	CLI      string            `json:"cli"`
	Score    *float64          `json:"score"`
	Coverage float64           `json:"coverage"`
	Share    float64           `json:"share"`
	Groups   map[string]Earned `json:"groups"`
	Criteria []ReportCriterion `json:"criteria"`
}

type ReportCriterion struct {
	ID     string   `json:"id"`
	Status Status   `json:"status"`
	Earned float64  `json:"earned"`
	Max    float64  `json:"max"`
	Value  *float64 `json:"value,omitempty"`
	Unit   string   `json:"unit,omitempty"`
	Reason string   `json:"reason,omitempty"`
}

// Giới hạn khớp tokenScoreReport trong packages/contracts/src/client-events.ts.
const (
	reportMaxProfiles = 20
	reportMaxCriteria = 40
)

var (
	reportCLI       = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)
	reportCriterion = regexp.MustCompile(`^[A-Z][0-9]{1,2}$`)
	reportGroup     = regexp.MustCompile(`^[A-Z]$`)
	reportUnit      = regexp.MustCompile(`^[a-z_%/]{1,20}$`)
	reportReason    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)
)

// BuildReport rút Result về những trường hub nhận. Giá trị lệch schema (đơn vị, mã lý do lạ, số ngoài khoảng) bị bỏ
// hoặc kẹp lại thay vì làm hỏng cả báo cáo: một tiêu chí mới ở worker không được chặn điểm của cả máy.
func BuildReport(r *Result) Report {
	rep := Report{
		ScoreVersion: r.ScoreVersion,
		GeneratedAt:  r.GeneratedAt,
		Days:         min(max(r.Days, 1), 90),
		Machine: ReportMachine{
			Score:       clampPtr(r.Machine.Score, 100),
			Coverage:    clamp(r.Machine.Coverage, 100),
			Provisional: r.Machine.Provisional,
		},
		Profiles: []ReportProfile{},
	}
	if l := r.Machine.Level; l != nil && (*l == "good" || *l == "fair" || *l == "low") {
		level := *l
		rep.Machine.Level = &level
	}
	for _, p := range r.Profiles {
		if len(rep.Profiles) == reportMaxProfiles {
			break
		}
		if !reportCLI.MatchString(p.CLI) {
			continue
		}
		rp := ReportProfile{
			CLI: p.CLI, Score: clampPtr(p.Score, 100), Coverage: clamp(p.Coverage, 100), Share: clamp(p.Share, 1),
			Groups: map[string]Earned{}, Criteria: []ReportCriterion{},
		}
		for k, g := range p.Groups {
			if reportGroup.MatchString(k) {
				rp.Groups[k] = Earned{Earned: clamp(g.Earned, 100), Max: clamp(g.Max, 100)}
			}
		}
		for _, c := range p.Criteria {
			if len(rp.Criteria) == reportMaxCriteria {
				break
			}
			if !reportCriterion.MatchString(c.ID) {
				continue
			}
			rc := ReportCriterion{ID: c.ID, Status: c.Status, Earned: clamp(c.Earned, 100), Max: clamp(c.Max, 100)}
			if c.Value != nil && !math.IsNaN(*c.Value) && !math.IsInf(*c.Value, 0) {
				v := *c.Value
				rc.Value = &v
			}
			if reportUnit.MatchString(c.Unit) {
				rc.Unit = c.Unit
			}
			if reportReason.MatchString(c.Reason) {
				rc.Reason = c.Reason
			}
			rp.Criteria = append(rp.Criteria, rc)
		}
		rep.Profiles = append(rep.Profiles, rp)
	}
	return rep
}

func clamp(x, hi float64) float64 {
	if math.IsNaN(x) || x < 0 {
		return 0
	}
	return math.Min(x, hi)
}

func clampPtr(x *float64, hi float64) *float64 {
	if x == nil || math.IsNaN(*x) {
		return nil
	}
	v := clamp(*x, hi)
	return &v
}

// PendingReport là báo cáo đã dựng mà hub chưa nhận. Body giữ nguyên byte để gửi lại cùng khoá thì hub nhận ra trùng.
type PendingReport struct {
	Key  string          `json:"key"`
	Body json.RawMessage `json:"body"`
}

// ReportState là score-report.json: người dùng có bật gửi điểm không, lần hub nhận gần nhất và báo cáo đang chờ.
type ReportState struct {
	Enabled    bool           `json:"enabled"`
	LastSentAt *time.Time     `json:"lastSentAt"`
	Pending    *PendingReport `json:"pending"`
}

func reportStatePath(dir string) string { return filepath.Join(dir, "score-report.json") }

// LoadReportState đọc trạng thái gửi điểm; chưa có file hay file hỏng đều là tắt, vì gửi điểm chỉ bật khi người dùng chọn.
func LoadReportState(dir string) (ReportState, error) {
	var st ReportState
	b, err := os.ReadFile(reportStatePath(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if json.Unmarshal(b, &st) != nil {
		return ReportState{}, nil
	}
	return st, nil
}

// UpdateReportState đọc, sửa và ghi trạng thái trong khoá lịch sử điểm, để bật/tắt từ app desktop và lần chấm điểm
// chạy cùng lúc không ghi đè nhau.
func UpdateReportState(dir string, fn func(st *ReportState) error) (ReportState, error) {
	unlock, err := LockHistory(dir)
	if err != nil {
		return ReportState{}, err
	}
	defer unlock()
	st, err := LoadReportState(dir)
	if err != nil {
		return st, err
	}
	if err := fn(&st); err != nil {
		return st, err
	}
	b, err := json.Marshal(st)
	if err != nil {
		return st, err
	}
	// WriteAtomic tạo file tạm bằng CreateTemp nên file mới có quyền 0600.
	return st, WriteAtomic(reportStatePath(dir), b)
}
