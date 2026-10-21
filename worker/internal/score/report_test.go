package score

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

func reportFixture() *Result {
	level := "fair"
	return &Result{
		ScoreVersion: Version, GeneratedAt: "2026-10-13T03:00:00Z", Days: 7,
		Machine:  Machine{Score: ptr(72.5), Level: &level, Coverage: 88, Provisional: false},
		Previous: &Previous{Score: ptr(60), At: "2026-10-12"},
		Profiles: []ProfileScore{
			{
				ID: "claude-secret", Label: "an@example.com", CLI: "claude", Default: true, Counted: true, Reason: "x",
				Level: "balanced", Weighted: 1234, Sessions: 9, Share: 0.75, Score: ptr(80), Coverage: 90,
				Groups: map[string]Earned{"A": {Earned: 40, Max: 50}, "B": {Earned: 32, Max: 40}, "ab": {Earned: 1, Max: 1}},
				Criteria: []Criterion{
					{ID: "A1", Group: "A", Status: StatusOK, Value: ptr(8000), Unit: "tokens", Good: ptr(1), Bad: ptr(2),
						Earned: 10, Max: 10, Source: "C:/Users/an/.claude/settings.json", UserSet: true,
						Items:    []Item{{ID: "i", Status: StatusOK, File: "/home/an/secret"}},
						Warnings: []Warning{{Code: "w", File: "/home/an/x"}}, Fixes: []string{"balanced"}},
					{ID: "B2", Group: "B", Status: StatusUnknown, Max: 5, Reason: "no_sessions", Unit: "Tokens/Phiên"},
					{ID: "B3", Group: "B", Status: StatusLow, Max: 5, Reason: "Lý do tiếng Việt", Value: ptr(math.Inf(1))},
					{ID: "custom", Group: "A", Status: StatusOK, Max: 1},
				},
				Projects:   []Project{{Key: "k", Path: "~/code/secret-project", Share: 1}},
				Context:    []Category{{}},
				ModelShare: []ModelShare{{Family: "opus", Share: 1}},
			},
			{ID: "agy", CLI: "antigravity", Score: nil, Groups: map[string]Earned{"A": {}, "B": {}}},
			{ID: "bad", CLI: "Bad CLI", Score: ptr(10)},
		},
	}
}

// keys gom mọi đường khoá trong JSON, mảng thành "[]", để so với danh sách khoá schema cho phép.
func keys(prefix string, v any, out map[string]bool) {
	switch x := v.(type) {
	case map[string]any:
		for k, child := range x {
			if prefix == "profiles[].groups" {
				k = "*"
			}
			p := k
			if prefix != "" {
				p = prefix + "." + k
			}
			out[p] = true
			keys(p, child, out)
		}
	case []any:
		for _, child := range x {
			keys(prefix+"[]", child, out)
		}
	}
}

func TestBuildReportOnlyAllowedFields(t *testing.T) {
	b, err := json.Marshal(BuildReport(reportFixture()))
	if err != nil {
		t.Fatal(err)
	}
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	keys("", v, got)
	allowed := map[string]bool{}
	for _, k := range []string{"scoreVersion", "generatedAt", "days", "machine", "machine.score", "machine.level",
		"machine.coverage", "machine.provisional", "profiles", "profiles[].cli", "profiles[].score", "profiles[].coverage",
		"profiles[].share", "profiles[].groups", "profiles[].groups.*", "profiles[].groups.*.earned",
		"profiles[].groups.*.max", "profiles[].criteria", "profiles[].criteria[].id", "profiles[].criteria[].status",
		"profiles[].criteria[].earned", "profiles[].criteria[].max", "profiles[].criteria[].value",
		"profiles[].criteria[].unit", "profiles[].criteria[].reason"} {
		allowed[k] = true
	}
	var extra []string
	for k := range got {
		if !allowed[k] {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		t.Fatalf("báo cáo có trường ngoài schema: %v\n%s", extra, b)
	}
	for _, leak := range []string{"claude-secret", "an@example.com", "secret-project", "/home/an", "C:/Users", "opus", "balanced"} {
		if strings.Contains(string(b), leak) {
			t.Errorf("báo cáo rò %q: %s", leak, b)
		}
	}
}

func TestBuildReportValues(t *testing.T) {
	rep := BuildReport(reportFixture())
	if rep.ScoreVersion != Version || rep.GeneratedAt != "2026-10-13T03:00:00Z" || rep.Days != 7 {
		t.Fatalf("đầu báo cáo: %+v", rep)
	}
	if m := rep.Machine; m.Score == nil || *m.Score != 72.5 || m.Level == nil || *m.Level != "fair" || m.Coverage != 88 || m.Provisional {
		t.Fatalf("điểm máy: %+v", m)
	}
	if len(rep.Profiles) != 2 {
		t.Fatalf("gói có CLI lạ phải bị bỏ, còn %d gói", len(rep.Profiles))
	}
	p := rep.Profiles[0]
	if p.CLI != "claude" || *p.Score != 80 || p.Coverage != 90 || p.Share != 0.75 {
		t.Fatalf("gói: %+v", p)
	}
	if len(p.Groups) != 2 || p.Groups["A"] != (Earned{Earned: 40, Max: 50}) || p.Groups["B"] != (Earned{Earned: 32, Max: 40}) {
		t.Errorf("nhóm: %+v", p.Groups)
	}
	if len(p.Criteria) != 3 {
		t.Fatalf("tiêu chí có id lạ phải bị bỏ: %+v", p.Criteria)
	}
	a1, b2, b3 := p.Criteria[0], p.Criteria[1], p.Criteria[2]
	if a1.ID != "A1" || a1.Status != StatusOK || a1.Earned != 10 || a1.Max != 10 || a1.Value == nil || *a1.Value != 8000 || a1.Unit != "tokens" {
		t.Errorf("A1: %+v", a1)
	}
	if b2.Reason != "no_sessions" || b2.Unit != "" || b2.Status != StatusUnknown {
		t.Errorf("B2 giữ mã lý do, bỏ đơn vị sai mẫu: %+v", b2)
	}
	if b3.Reason != "" || b3.Value != nil {
		t.Errorf("B3 bỏ lý do sai mẫu và số vô cực: %+v", b3)
	}
	if agy := rep.Profiles[1]; agy.Score != nil || agy.Criteria == nil {
		t.Errorf("gói chưa chấm được giữ điểm null và mảng tiêu chí rỗng: %+v", agy)
	}
}

func TestBuildReportClamps(t *testing.T) {
	r := &Result{ScoreVersion: Version, GeneratedAt: "2026-10-13T03:00:00Z", Days: 0,
		Machine: Machine{Score: ptr(120), Coverage: -1}}
	rep := BuildReport(r)
	if rep.Days != 1 || *rep.Machine.Score != 100 || rep.Machine.Coverage != 0 || rep.Machine.Level != nil || rep.Profiles == nil {
		t.Fatalf("kẹp giá trị: %+v", rep)
	}
}

func TestReportState(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "optimizer")
	st, err := LoadReportState(dir)
	if err != nil || st.Enabled || st.Pending != nil {
		t.Fatalf("chưa có file thì tắt: %+v %v", st, err)
	}
	now := time.Date(2026, 10, 13, 3, 0, 0, 0, time.UTC)
	if _, err := UpdateReportState(dir, func(st *ReportState) error {
		st.Enabled, st.LastSentAt = true, &now
		st.Pending = &PendingReport{Key: "01JABCDEFGHJKMNPQRSTVWXYZ0", Body: json.RawMessage(`{"a":1}`)}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	st, err = LoadReportState(dir)
	if err != nil || !st.Enabled || st.LastSentAt == nil || !st.LastSentAt.Equal(now) || st.Pending == nil || string(st.Pending.Body) != `{"a":1}` {
		t.Fatalf("đọc lại: %+v %v", st, err)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(filepath.Join(dir, "score-report.json"))
		if err != nil || info.Mode().Perm() != 0o600 {
			t.Errorf("quyền file: %v %v", info.Mode(), err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "score-report.json"), []byte("{hỏng"), 0o600); err != nil {
		t.Fatal(err)
	}
	if st, err := LoadReportState(dir); err != nil || st.Enabled {
		t.Errorf("file hỏng là tắt: %+v %v", st, err)
	}
}
