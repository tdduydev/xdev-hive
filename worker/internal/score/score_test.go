package score

import (
	"context"
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

var now = time.Date(2026, 10, 19, 9, 0, 0, 0, time.UTC)

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 0.01 }

func criterion(t *testing.T, p ProfileScore, id string) Criterion {
	t.Helper()
	for _, c := range p.Criteria {
		if c.ID == id {
			return c
		}
	}
	t.Fatalf("gói %s không có tiêu chí %s", p.ID, id)
	return Criterion{}
}

func session(account string, peak, first int64, weighted float64) tokenreport.SessionSummary {
	return tokenreport.SessionSummary{CLI: "claude", Source: "interactive", Account: account, Calls: 10, Input: 100,
		CacheRead: 900, Weighted: weighted, PeakContext: peak, FirstContext: first, ToolCalls: 10, ToolChars: 2400,
		InstructionChars: 4000}
}

func fiveSessions(account string, peak, first int64) []tokenreport.SessionSummary {
	var out []tokenreport.SessionSummary
	for range 5 {
		out = append(out, session(account, peak, first, 100_000))
	}
	return out
}

func TestLinear(t *testing.T) {
	cases := []struct{ x, good, bad, want float64 }{
		{100, 200, 600, 1}, {200, 200, 600, 1}, {400, 200, 600, 0.5}, {600, 200, 600, 0}, {900, 200, 600, 0},
		{0.95, 0.90, 0.60, 1}, {0.75, 0.90, 0.60, 0.5}, {0.5, 0.90, 0.60, 0},
	}
	for _, c := range cases {
		if got := linear(c.x, c.good, c.bad); !near(got, c.want) {
			t.Errorf("linear(%v, %v, %v) = %v, muốn %v", c.x, c.good, c.bad, got, c.want)
		}
	}
}

// contextFixture là output thật của `claude -p /context` mà app desktop dùng làm fixture (usage.rs).
const contextFixture = "## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 12.7k / 1m (1%)\n\n" +
	"### Estimated usage by category\n\n| Category | Tokens | Percentage |\n|----------|--------|------------|\n" +
	"| System prompt | 2.3k | 0.2% |\n| System tools | 6.1k | 0.6% |\n| System tools (deferred) | 13.3k | 1.3% |\n" +
	"| Skills | 4.3k | 0.4% |\n| Messages | 10 | 0.0% |\n| Free space | 954.3k | 95.4% |\n" +
	"| Autocompact buffer | 33k | 3.3% |\n\n### Skills\n\n| Skill | Source | Tokens |\n|-------|--------|--------|\n" +
	"| dataviz | Built-in | ~480 |\n"

func TestParseContext(t *testing.T) {
	r := ParseContext(contextFixture)
	if r == nil || r.Window != 1_000_000 || r.Used != 12_700 || r.Model != "claude-opus-5-5" {
		t.Fatalf("đọc sai: %+v", r)
	}
	if r.Category("skills") != 4300 || r.Category("Autocompact buffer") != 33_000 || len(r.Categories) != 7 {
		t.Errorf("nhóm sai: %+v", r.Categories)
	}
	if ParseContext("Error: not logged in") != nil {
		t.Error("output lỗi phải trả nil")
	}
}

func claudeProfile(home, id string) Profile {
	return Profile{ID: id, CLI: "claude", Dir: filepath.Join(home, ".xdev-hive", "accounts", id), Version: "2.1.300"}
}

func compute(t *testing.T, in Inputs) *Result {
	t.Helper()
	in.Now, in.Days = now, 7
	if in.GOOS == "" {
		in.GOOS = "linux"
	}
	return Compute(in)
}

const balancedSettings = `{
  "effortLevel": "medium",
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "80",
    "BASH_MAX_OUTPUT_LENGTH": "15000",
    "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": "15000",
    "MAX_MCP_OUTPUT_TOKENS": "15000",
    "CLAUDE_CODE_SUBAGENT_MODEL": "sonnet"
  },
  "hooks": {
    "PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "/h/.xdev-hive/bin/hive-worker", "args": ["hook", "post-tool", "--local"]}]}],
    "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "rtk", "args": ["hook", "claude"]}]}]
  }
}`

func TestClaudeConfigOptimized(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	p.Level = "aggressive"
	p.HiveKeys = []string{"env.BASH_MAX_OUTPUT_LENGTH", "env.CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS", "env.MAX_MCP_OUTPUT_TOKENS"}
	write(t, filepath.Join(p.Dir, "settings.json"), balancedSettings)
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, HasTool: func(string) bool { return true }})
	ps := res.Profiles[0]
	for _, id := range []string{"A1", "A2", "A6", "A7", "A8"} {
		c := criterion(t, ps, id)
		if c.Status != StatusOK || len(c.Fixes) > 0 {
			t.Errorf("%s: %+v", id, c)
		}
	}
	if a1 := criterion(t, ps, "A1"); *a1.Value != 160_000 || a1.Source != "settings" {
		t.Errorf("A1 phải là 200k × 80%%: %+v", a1)
	}
	if criterion(t, ps, "A2").UserSet {
		t.Error("khoá do Hive đặt không phải người dùng đặt")
	}
}

func TestClaudeConfigDefaults(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	write(t, filepath.Join(p.Dir, "settings.json"), `{"env":{"BASH_MAX_OUTPUT_LENGTH":"20000"}}`)
	sessions := fiveSessions("claude-2", 500_000, 30_000)
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Sessions: sessions})
	ps := res.Profiles[0]

	a1 := criterion(t, ps, "A1")
	if *a1.Value != window1M || a1.Earned != 0 || a1.Fixes[0] != FixBalanced {
		t.Errorf("phiên vượt 200k nên coi là model 1M, nén ở 967k: %+v", a1)
	}
	// Bash 20000: 1 − 0,5 × 5000/15000; Read, MCP mặc định 0,5; không có hook 0.
	a2 := criterion(t, ps, "A2")
	want := 8 * ((1 - 0.5*5000.0/15000) + 0.5 + 0.5 + 0) / 4
	if !near(a2.Earned, want) || !a2.UserSet {
		t.Errorf("A2 = %v (userSet %v), muốn %v và người dùng đặt", a2.Earned, a2.UserSet, want)
	}
	a6 := criterion(t, ps, "A6")
	if a6.Earned != 0 || len(a6.Fixes) != 1 || a6.Fixes[0] != FixToolRTK {
		t.Errorf("không có rtk thì gợi ý cài rtk: %+v", a6)
	}
	a8 := criterion(t, ps, "A8")
	if !near(a8.Earned, 2) || a8.Fixes[0] != FixAggressive {
		t.Errorf("A8: %+v", a8)
	}
}

func TestA1FromContextBuffer(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Context: map[string]*ContextReport{p.ID: ParseContext(contextFixture)}})
	a1 := criterion(t, res.Profiles[0], "A1")
	if *a1.Value != 967_000 || a1.Source != "context" || a1.Earned != 0 {
		t.Errorf("A1 phải lấy cửa sổ trừ Autocompact buffer: %+v", a1)
	}
}

func TestA4UsesContextAndPenalties(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	ctx := ParseContext(contextFixture)
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Context: map[string]*ContextReport{p.ID: ctx}})
	if a4 := criterion(t, res.Profiles[0], "A4"); *a4.Value != 4300 || !near(a4.Earned, 7*(20000-4300)/16000.0) {
		t.Errorf("chỉ tính Skills, bỏ nhóm deferred: %+v", a4)
	}
	write(t, filepath.Join(p.Dir, "settings.json"), `{"env":{"ENABLE_TOOL_SEARCH":"false"}}`)
	res = compute(t, Inputs{Home: home, Profiles: []Profile{p}, Context: map[string]*ContextReport{p.ID: ctx}})
	a4 := criterion(t, res.Profiles[0], "A4")
	if !near(a4.Earned, 0.5*7*(20000-4300)/16000.0) || a4.Warnings[0].Code != "tool_search_off" {
		t.Errorf("tắt tool search phải trừ nửa điểm: %+v", a4)
	}
	res = compute(t, Inputs{Home: home, Profiles: []Profile{p}})
	if a4 := criterion(t, res.Profiles[0], "A4"); a4.Status != StatusUnknown || a4.Reason != "context_not_measured" ||
		len(a4.Fixes) != 1 || a4.Fixes[0] != FixMeasureContext {
		t.Errorf("chưa đo /context thì có nút đo: %+v", a4)
	}
}

func TestA3TruncatedMemory(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	write(t, filepath.Join(p.Dir, "projects", "-w-app", "memory", "MEMORY.md"), strings.Repeat("- dòng\n", 201))
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}})
	a3 := criterion(t, res.Profiles[0], "A3")
	if a3.Items[1].ID != "truncated" || *a3.Items[1].Score != 0 || !strings.HasPrefix(a3.Items[1].File, "~/") {
		t.Errorf("MEMORY.md quá 200 dòng bị cắt: %+v", a3.Items)
	}
	if a3.Fixes[0] != FixOpenMemory {
		t.Errorf("A3 thấp phải có nút mở màn Memory: %+v", a3.Fixes)
	}
}

func TestUsageNeedsFiveMainSessions(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	sessions := fiveSessions("claude-2", 100_000, 10_000)
	sessions[4].Subagent = true
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Sessions: sessions})
	for _, c := range res.Profiles[0].Criteria {
		if c.Group == "B" && (c.Status != StatusUnknown || c.Reason != "not_enough_sessions") {
			t.Errorf("4 phiên chính chưa đủ: %+v", c)
		}
	}
}

func TestUsageCriteria(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	sessions := fiveSessions("claude-2", 210_000, 35_000)
	sessions[0].PeakContext = 500_000
	sessions[0].Edited, sessions[0].PreEditWeighted = true, 50_000
	// Phiên của run hub và của gói khác không được tính.
	other := session("claude-2", 900_000, 90_000, 1e9)
	other.Source = "worker"
	sessions = append(sessions, other, session("claude-3", 900_000, 90_000, 1e9))
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Sessions: sessions})
	ps := res.Profiles[0]
	checks := map[string]float64{
		"B1": 12 * (300_000 - 210_000) / 180_000.0,
		"B2": 10 * (0.5 - 0.2) / 0.4,
		"B3": 8 * (50_000 - 35_000) / 30_000.0,
		"B4": 6,
		"B5": 8, // 500k ÷ 50 lượt = 10k, dưới mức đủ điểm
		"B6": 5,
		"B7": 6 * (0.7 - 0.5) / 0.4, // phiên có sửa: 50k trước lần sửa ÷ 100k
	}
	for id, want := range checks {
		if c := criterion(t, ps, id); !near(c.Earned, want) {
			t.Errorf("%s = %v, muốn %v (%+v)", id, c.Earned, want, c)
		}
	}
	if ps.Sessions != 5 || ps.Weighted != 500_000 {
		t.Errorf("gói: %d phiên, %v token", ps.Sessions, ps.Weighted)
	}
}

func TestMachineWeightsByTokens(t *testing.T) {
	s50, s75 := 50.0, 75.0
	m := machine([]ProfileScore{
		{ID: "claude-2", Counted: true, Score: &s50, Coverage: 100, Weighted: 800},
		{ID: "codex-1", Counted: true, Score: &s75, Coverage: 60, Weighted: 200},
		{ID: "antigravity", Counted: false, Score: &s75, Weighted: 0},
	})
	if *m.Score != 55 || *m.Level != "low" || !near(m.Coverage, 92) || m.Provisional {
		t.Errorf("điểm máy: %+v", m)
	}
	// Không gói nào có token: trung bình điểm nhóm A.
	m = machine([]ProfileScore{
		{Counted: true, Score: &s50, Groups: map[string]Earned{"A": {Earned: 36, Max: 45}}},
		{Counted: true, Score: &s50, Groups: map[string]Earned{"A": {Earned: 18, Max: 45}}},
	})
	if *m.Score != 60 || *m.Level != "fair" || m.Coverage != 45 || !m.Provisional {
		t.Errorf("điểm máy chưa có phiên: %+v", m)
	}
	if m := machine(nil); m.Score != nil || m.Level != nil {
		t.Errorf("máy không có gói phải là null: %+v", m)
	}
}

func TestCodexConfig(t *testing.T) {
	home := t.TempDir()
	p := Profile{ID: "codex-1", CLI: "codex", Dir: filepath.Join(home, "codex-1")}
	write(t, filepath.Join(p.Dir, "config.toml"), `model_reasoning_effort = "xhigh" # nặng
model_auto_compact_token_limit = 150_000
tool_output_token_limit = 8000

[mcp_servers.codegraph]
command = "codegraph"

[mcp_servers.codegraph.env]
X = "1"

[mcp_servers.old]
command = "x"
enabled = false
`)
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}})
	ps := res.Profiles[0]
	if c := criterion(t, ps, "A1"); c.Status != StatusOK {
		t.Errorf("A1: %+v", c)
	}
	if c := criterion(t, ps, "A2"); c.Status != StatusOK || !c.UserSet {
		t.Errorf("A2: %+v", c)
	}
	if c := criterion(t, ps, "A4"); *c.Value != 1 || c.Status != StatusOK {
		t.Errorf("chỉ một server bật: %+v", c)
	}
	if c := criterion(t, ps, "A8"); !near(c.Earned, 2) {
		t.Errorf("effort xhigh mất nửa điểm: %+v", c)
	}
	for _, id := range []string{"A6", "A7"} {
		if c := criterion(t, ps, id); c.Status != StatusUnsupported {
			t.Errorf("%s phải unsupported với Codex: %+v", id, c)
		}
	}
	if c := criterion(t, ps, "B7"); c.Reason != "not_enough_sessions" {
		t.Errorf("B7: %+v", c)
	}
}

func TestAntigravityNotCounted(t *testing.T) {
	home := t.TempDir()
	write(t, filepath.Join(home, ".gemini", "config", "rules", "big.md"), strings.Repeat("x", 25_000))
	res := compute(t, Inputs{Home: home, Profiles: []Profile{{ID: "agy", CLI: "antigravity"}}})
	ps := res.Profiles[0]
	if ps.Counted || ps.Reason != "no_token_logs" || res.Machine.Score != nil {
		t.Errorf("Antigravity không tính vào điểm máy: %+v / %+v", ps, res.Machine)
	}
	if c := criterion(t, ps, "A3"); *c.Items[1].Score != 0 || !strings.HasSuffix(c.Items[1].File, "big.md") {
		t.Errorf("rule quá 24.000 byte bị cắt: %+v", c)
	}
	if c := criterion(t, ps, "B1"); c.Status != StatusUnsupported {
		t.Errorf("B1: %+v", c)
	}
}

func TestProjectsAndCodegraph(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	app, lib := filepath.Join(home, "code", "app"), filepath.Join(home, "code", "lib")
	write(t, filepath.Join(app, ".codegraph", "codegraph.db"), "")
	write(t, filepath.Join(lib, "README.md"), "")
	sessions := fiveSessions("claude-2", 100_000, 10_000)
	for i := range sessions {
		sessions[i].Cwd = app
	}
	sessions[4].Cwd = lib
	sessions = append(sessions, func() tokenreport.SessionSummary {
		s := session("claude-2", 1, 1, 1)
		s.Cwd = filepath.Join(home, "gone")
		return s
	}())
	has := map[string]bool{"codegraph": true}
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}, Sessions: sessions, HasTool: func(n string) bool { return has[n] }})
	ps := res.Profiles[0]
	if len(ps.Projects) != 2 || ps.Projects[0].Path != "~/code/app" || !ps.Projects[0].Codegraph || ps.Projects[0].Key != ProjectKey(app) || ps.Projects[1].Key == ps.Projects[0].Key {
		t.Fatalf("dự án: %+v", ps.Projects)
	}
	a5 := criterion(t, ps, "A5")
	// tool 1, mcp 0, index 1/2.
	if !near(a5.Earned, 5*(1+0+0.5)/3) || strings.Join(a5.Fixes, ",") != FixGraphMCP+","+FixGraphInit {
		t.Errorf("A5: %+v", a5)
	}
}

func TestRTKOnWindowsIsUnsupported(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	for _, has := range []bool{true, false} {
		res := compute(t, Inputs{Home: home, GOOS: "windows", Profiles: []Profile{p}, HasTool: func(n string) bool { return has && n == "rtk" }})
		a6 := criterion(t, res.Profiles[0], "A6")
		if a6.Status != StatusUnsupported || a6.Reason != "windows_rtk_unsupported" || len(a6.Fixes) != 0 || a6.Earned != 0 {
			t.Errorf("Windows (rtk=%v): A6 phải unsupported, không gợi ý cài hay bật hook: %+v", has, a6)
		}
	}
}

func TestBrokenSettingsAreUnknown(t *testing.T) {
	home := t.TempDir()
	p := claudeProfile(home, "claude-2")
	write(t, filepath.Join(p.Dir, "settings.json"), "{hỏng")
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}})
	if c := criterion(t, res.Profiles[0], "A1"); c.Status != StatusUnknown || c.Reason != "config_unreadable" {
		t.Errorf("A1: %+v", c)
	}
}

func TestHistory(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "optimizer")
	p := claudeProfile(home, "claude-secret-id")
	res := compute(t, Inputs{Home: home, Profiles: []Profile{p}})
	prev, err := Record(dir, res, "", now)
	if err != nil || prev != nil {
		t.Fatalf("lần đầu: %v, %v", prev, err)
	}
	if prev, _ = Record(dir, res, "", now.Add(time.Hour)); prev == nil || prev.At != now.Format(time.RFC3339) {
		t.Errorf("lần sau trả lần trước: %+v", prev)
	}
	_, _ = Record(dir, res, FixBalanced, now.Add(2*time.Hour))
	_, _ = Record(dir, res, "", now.Add(24*time.Hour))
	b, err := os.ReadFile(filepath.Join(dir, "score-history.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(lines) != 3 {
		t.Fatalf("muốn 3 dòng (ngày 1, sau sửa nhanh, ngày 2), có %d", len(lines))
	}
	if strings.Contains(string(b), "claude-secret-id") || strings.Contains(string(b), home) {
		t.Error("lịch sử có id gói hoặc đường dẫn")
	}
	var e HistoryEntry
	if err := json.Unmarshal([]byte(lines[1]), &e); err != nil || e.Fix != FixBalanced {
		t.Errorf("dòng sửa nhanh: %+v %v", e, err)
	}
	// Dòng quá 90 ngày bị dọn.
	_, _ = Record(dir, res, FixRTK, now.Add(100*24*time.Hour))
	b, _ = os.ReadFile(filepath.Join(dir, "score-history.jsonl"))
	if n := len(strings.Split(strings.TrimSpace(string(b)), "\n")); n != 1 {
		t.Errorf("còn %d dòng, muốn 1", n)
	}
}

func TestLoadContextsCaches(t *testing.T) {
	dir := t.TempDir()
	var ran []string
	run := func(_ context.Context, p Profile) ([]byte, error) {
		ran = append(ran, p.ID)
		return []byte(contextFixture), nil
	}
	profiles := []Profile{{ID: "claude-2", CLI: "claude"}, {ID: "claude-3", CLI: "claude"}, {ID: "codex-1", CLI: "codex"}}
	// /context gọi model nên không tự chạy khi chưa bấm đo.
	if got := LoadContexts(context.Background(), dir, profiles, run, now, nil); len(got) != 0 || len(ran) != 0 {
		t.Fatalf("chưa đo: %v, đã chạy %v", got, ran)
	}
	// Bấm đo một gói thì chỉ tốn token cho gói đó.
	got := LoadContexts(context.Background(), dir, profiles, run, now, []string{"claude-2"})
	if got["claude-2"] == nil || len(got) != 1 || strings.Join(ran, ",") != "claude-2" {
		t.Fatalf("đo: %v, đã chạy %v", got, ran)
	}
	if got := LoadContexts(context.Background(), dir, profiles, run, now.Add(6*24*time.Hour), nil); got["claude-2"] == nil || len(ran) != 1 {
		t.Errorf("trong 7 ngày dùng kết quả đã lưu: %v, đã chạy %v", got, ran)
	}
	if got := LoadContexts(context.Background(), dir, profiles, run, now.Add(8*24*time.Hour), nil); len(got) != 0 || len(ran) != 1 {
		t.Errorf("quá 7 ngày thì bỏ, không tự chạy lại: %v, đã chạy %v", got, ran)
	}
}

func TestResultJSONShape(t *testing.T) {
	home := t.TempDir()
	res := compute(t, Inputs{Home: home, Profiles: []Profile{claudeProfile(home, "claude-2")}})
	b, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	_ = json.Unmarshal(b, &raw)
	for _, k := range []string{"scoreVersion", "generatedAt", "days", "machine", "profiles"} {
		if _, ok := raw[k]; !ok {
			t.Errorf("thiếu %s", k)
		}
	}
	p := raw["profiles"].([]any)[0].(map[string]any)
	for _, k := range []string{"id", "cli", "counted", "weighted", "sessions", "share", "score", "coverage", "groups", "criteria", "projects"} {
		if _, ok := p[k]; !ok {
			t.Errorf("gói thiếu %s", k)
		}
	}
}
