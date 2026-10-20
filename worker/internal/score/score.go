// Package score chấm điểm tối ưu token 0–100 cho từng gói CLI và cho cả máy (spec 025). Số đo lấy từ file cấu hình
// của gói, công cụ trên máy, /context và transcript. Bảng tiêu chí và ngưỡng nằm ở criteria.go; đổi thang thì tăng
// Version để lịch sử không nối hai thang khác nhau.
package score

import (
	"math"
	"sort"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

// Version là scoreVersion trong JSON. 2: A5 của Codex tính server codegraph có `enabled = false` là có.
const Version = 2

type Status string

const (
	StatusOK          Status = "ok"
	StatusPartial     Status = "partial"
	StatusLow         Status = "low"
	StatusUnknown     Status = "unknown"
	StatusUnsupported Status = "unsupported"
)

func measured(s Status) bool { return s != StatusUnknown && s != StatusUnsupported }

// Item là một mục con của tiêu chí; Score từ 0 đến 1, nil khi mục chưa đo được.
type Item struct {
	ID     string   `json:"id"`
	Status Status   `json:"status"`
	Value  *float64 `json:"value,omitempty"`
	Score  *float64 `json:"score,omitempty"`
	Reason string   `json:"reason,omitempty"`
	File   string   `json:"file,omitempty"`
}

type Warning struct {
	Code string `json:"code"`
	File string `json:"file,omitempty"`
}

type Criterion struct {
	ID       string    `json:"id"`
	Group    string    `json:"group"`
	Status   Status    `json:"status"`
	Value    *float64  `json:"value,omitempty"`
	Unit     string    `json:"unit,omitempty"`
	Good     *float64  `json:"good,omitempty"`
	Bad      *float64  `json:"bad,omitempty"`
	Earned   float64   `json:"earned"`
	Max      float64   `json:"max"`
	Source   string    `json:"source,omitempty"`
	Reason   string    `json:"reason,omitempty"`
	UserSet  bool      `json:"userSet,omitempty"`
	Items    []Item    `json:"items,omitempty"`
	Warnings []Warning `json:"warnings,omitempty"`
	Fixes    []string  `json:"fixes,omitempty"`
}

type Earned struct {
	Earned float64 `json:"earned"`
	Max    float64 `json:"max"`
}

// Project là một thư mục dự án dùng nhiều token của gói. Path rút gọn về "~/…", chỉ để hiện trên máy.
type Project struct {
	Key       string  `json:"key"`
	Path      string  `json:"path"`
	Share     float64 `json:"share"`
	Codegraph bool    `json:"codegraph"`
	dir       string
}

type ProfileScore struct {
	ID       string            `json:"id"`
	Label    string            `json:"label,omitempty"`
	CLI      string            `json:"cli"`
	Default  bool              `json:"default,omitempty"`
	Counted  bool              `json:"counted"`
	Reason   string            `json:"reason,omitempty"`
	Level    string            `json:"level,omitempty"`
	Weighted float64           `json:"weighted"`
	Sessions int               `json:"sessions"`
	Share    float64           `json:"share"`
	Score    *float64          `json:"score"`
	Coverage float64           `json:"coverage"`
	Groups   map[string]Earned `json:"groups"`
	Criteria []Criterion       `json:"criteria"`
	Projects []Project         `json:"projects"`
	Context  []Category        `json:"context,omitempty"`
	// ModelShare là tỉ trọng token quy đổi theo họ model (FR-007), chỉ để hiện cạnh A8, không vào điểm.
	ModelShare []ModelShare `json:"modelShare,omitempty"`
}

type ModelShare struct {
	Family string  `json:"family"`
	Share  float64 `json:"share"`
}

type Machine struct {
	Score       *float64 `json:"score"`
	Level       *string  `json:"level"`
	Coverage    float64  `json:"coverage"`
	Provisional bool     `json:"provisional"`
}

type Previous struct {
	Score *float64 `json:"score"`
	At    string   `json:"at"`
}

type Result struct {
	ScoreVersion int            `json:"scoreVersion"`
	GeneratedAt  string         `json:"generatedAt"`
	Days         int            `json:"days"`
	Machine      Machine        `json:"machine"`
	Previous     *Previous      `json:"previous,omitempty"`
	Profiles     []ProfileScore `json:"profiles"`
}

// Profile là một gói CLI trên máy, theo `optimize status`.
type Profile struct {
	ID    string
	Label string
	CLI   string
	// Dir là thư mục cấu hình đã mở "~".
	Dir     string
	Default bool
	// Level là mức bộ tối ưu đang bật; rỗng là chưa bật.
	Level string
	// HiveKeys là khoá Hive đã đặt theo manifest: "env.X", "codex.X", "hooks.PostToolUse".
	HiveKeys []string
	// Version là phiên bản Claude Code; rỗng khi không đọc được.
	Version string
}

type Inputs struct {
	Home     string
	GOOS     string
	Now      time.Time
	Days     int
	Profiles []Profile
	Sessions []tokenreport.SessionSummary
	// Context theo id gói; thiếu hoặc nil là không chạy được /context.
	Context map[string]*ContextReport
	// HasTool cho biết máy có lệnh (codegraph, serena, rtk) trong PATH.
	HasTool func(name string) bool
}

// MinSessions là số phiên chính tối thiểu để chấm nhóm B (FR-006).
const MinSessions = 5

// Compute chấm mọi gói rồi gộp thành điểm máy. Không ghi gì ra đĩa.
func Compute(in Inputs) *Result {
	if in.HasTool == nil {
		in.HasTool = func(string) bool { return false }
	}
	res := &Result{ScoreVersion: Version, GeneratedAt: in.Now.UTC().Format(time.RFC3339), Days: in.Days, Profiles: []ProfileScore{}}
	for _, p := range in.Profiles {
		res.Profiles = append(res.Profiles, scoreProfile(in, p))
	}
	res.Machine = machine(res.Profiles)
	for i := range res.Profiles {
		finish(&res.Profiles[i])
	}
	return res
}

// machine: trung bình điểm gói theo token quy đổi 7 ngày (Q1). Không gói nào có token thì lấy trung bình điểm nhóm A.
func machine(profiles []ProfileScore) Machine {
	total := 0.0
	for _, p := range profiles {
		if p.Counted && p.Score != nil && p.Weighted > 0 {
			total += p.Weighted
		}
	}
	var score, coverage float64
	n := 0
	for i := range profiles {
		p := &profiles[i]
		if !p.Counted || p.Score == nil {
			continue
		}
		if total > 0 {
			if p.Weighted <= 0 {
				continue
			}
			p.Share = p.Weighted / total
			score += p.Share * *p.Score
			coverage += p.Share * p.Coverage
			n++
			continue
		}
		a := p.Groups["A"]
		if a.Max == 0 {
			continue
		}
		score += 100 * a.Earned / a.Max
		coverage += a.Max
		n++
	}
	if n == 0 {
		return Machine{}
	}
	if total == 0 {
		score /= float64(n)
		coverage /= float64(n)
	}
	score = round2(score)
	level := levelOf(score)
	return Machine{Score: &score, Level: &level, Coverage: round2(coverage), Provisional: coverage < 50}
}

func levelOf(score float64) string {
	switch {
	case score >= 80:
		return "good"
	case score >= 60:
		return "fair"
	}
	return "low"
}

// total gộp điểm các tiêu chí đo được thành điểm gói và nhóm.
func total(p *ProfileScore) {
	p.Groups = map[string]Earned{"A": {}, "B": {}}
	earned, max := 0.0, 0.0
	for _, c := range p.Criteria {
		if !measured(c.Status) {
			continue
		}
		g := p.Groups[c.Group]
		g.Earned += c.Earned
		g.Max += c.Max
		p.Groups[c.Group] = g
		earned += c.Earned
		max += c.Max
	}
	p.Coverage = max
	if max > 0 {
		s := 100 * earned / max
		p.Score = &s
	}
}

// finish làm tròn số hiện ra (chỉ ở bước cuối, FR-004) và xếp tiêu chí theo id.
func finish(p *ProfileScore) {
	if p.Score != nil {
		s := round2(*p.Score)
		p.Score = &s
	}
	p.Coverage, p.Share, p.Weighted = round2(p.Coverage), round2(p.Share), math.Round(p.Weighted)
	for k, g := range p.Groups {
		p.Groups[k] = Earned{Earned: round2(g.Earned), Max: g.Max}
	}
	for i := range p.Criteria {
		c := &p.Criteria[i]
		c.Earned = round2(c.Earned)
		if c.Value != nil {
			v := math.Round(*c.Value*10000) / 10000
			c.Value = &v
		}
	}
	sort.SliceStable(p.Criteria, func(i, j int) bool { return criterionOrder(p.Criteria[i].ID) < criterionOrder(p.Criteria[j].ID) })
}

func round2(x float64) float64 { return math.Round(x*100) / 100 }

func ptr(x float64) *float64 { return &x }
