package optimizeall

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
)

func TestPlanDefaultPolicy(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"optimizer.enable@claude-2", "optimizer.enable@codex-2", "context.sync@acme/web", "score.recompute@machine"}
	if got := stepIDs(plan.Steps); !reflect.DeepEqual(got, want) {
		t.Fatalf("các bước %v, muốn %v", got, want)
	}
	s := findStep(t, plan.Steps, StepOptimizerEnable, "claude-2")
	if s.Group != "cli" || !s.Selected || s.RequiresConfirm || !s.Undoable || s.Reason != "Mặc định" || s.Level != "balanced" {
		t.Fatalf("bước bật tối ưu sai: %+v", s)
	}
	if len(s.Changes) == 0 || s.Changes[0].File != f.settings || s.Changes[0].Before != nil || *s.Changes[0].After != "balanced" {
		t.Fatalf("thay đổi xem trước sai: %+v", s.Changes)
	}
	ctx := findStep(t, plan.Steps, StepContextSync, "acme/web")
	if ctx.Group != "context" || !ctx.Selected || !ctx.Undoable || ctx.Project != "acme/web" {
		t.Fatalf("bước ngữ cảnh sai: %+v", ctx)
	}
	score := plan.Steps[len(plan.Steps)-1]
	if score.ID != StepScoreRecompute || score.Group != "score" || !score.Selected || score.Undoable {
		t.Fatalf("bước tính điểm sai: %+v", score)
	}
	if plan.ScoreBefore == nil || *plan.ScoreBefore != 48 {
		t.Fatalf("điểm trước: %v", plan.ScoreBefore)
	}
	if len(plan.PolicySources) != 0 {
		t.Fatalf("không có chính sách thì không có nguồn: %v", plan.PolicySources)
	}
}

func TestPlanAggressivePolicyNeedsConfirm(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "aggressive", AutoCompactWindow: intPtr(150_000)}})
	if err != nil {
		t.Fatal(err)
	}
	var levels []string
	for _, s := range plan.Steps {
		if s.ID == StepOptimizerEnable && s.Target == "claude-2" {
			levels = append(levels, s.Level)
			if s.Reason != "Theo chính sách dự án Acme Web" {
				t.Fatalf("lý do: %q", s.Reason)
			}
			if s.AutoCompactWindow == nil || *s.AutoCompactWindow != 150_000 {
				t.Fatalf("trần nén không truyền vào bước: %+v", s)
			}
			if s.Level == "aggressive" && (s.Selected || !s.RequiresConfirm) {
				t.Fatalf("aggressive phải bỏ chọn sẵn và cần xác nhận: %+v", s)
			}
			if s.Level == "balanced" && (!s.Selected || s.RequiresConfirm) {
				t.Fatalf("balanced vẫn chọn sẵn: %+v", s)
			}
		}
	}
	if !reflect.DeepEqual(levels, []string{"balanced", "aggressive"}) {
		t.Fatalf("gói chưa bật cần balanced rồi aggressive, có %v", levels)
	}
	if !reflect.DeepEqual(plan.PolicySources, []string{"acme/web"}) {
		t.Fatalf("nguồn chính sách: %v", plan.PolicySources)
	}
}

func TestPlanSkipsProfilesAtTarget(t *testing.T) {
	f := newFixture(t)
	if _, err := f.enabler.Enable(f.machine.Profiles[0].Profile, EnableRequest{Level: "aggressive"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.enabler.Enable(f.machine.Profiles[1].Profile, EnableRequest{Level: "balanced"}); err != nil {
		t.Fatal(err)
	}
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "balanced"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Steps {
		if s.ID == StepOptimizerEnable {
			t.Fatalf("gói đã đạt mức đích (không hạ mức) thì không có bước bật: %+v", s)
		}
	}
	plan, err = f.runner.Plan(map[string]Policy{"acme/web": {Level: "off"}})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Steps {
		if s.Group == "cli" {
			t.Fatalf("chính sách off thì không bật gì: %+v", s)
		}
	}
}

func TestPlanDefaultProfileNeedsConfirm(t *testing.T) {
	f := newFixture(t)
	def := f.profile("claude", "claude")
	def.Default = true
	f.machine.Profiles = append(f.machine.Profiles, ProfileInfo{Profile: def, Label: "Claude mặc định"},
		ProfileInfo{Profile: optimizer.Profile{ID: "gemini", CLI: "gemini", Dir: f.home}, Label: "Gemini"})
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	s := findStep(t, plan.Steps, StepOptimizerEnable, "claude")
	if s.Selected || !s.RequiresConfirm {
		t.Fatalf("gói mặc định chỉ bật khi người dùng chọn riêng: %+v", s)
	}
	for _, s := range plan.Steps {
		if s.Target == "gemini" {
			t.Fatalf("CLI không hỗ trợ tối ưu thì không có bước: %+v", s)
		}
	}
}

func TestPlanFixesAndTools(t *testing.T) {
	f := newFixture(t)
	f.machine.RTKSupported = true
	f.machine.Fixes = []FixSuggestion{
		{ID: "codegraph.mcp", Profile: "codex-2"},
		{ID: "codegraph.init", Profile: "claude-2", Project: "acme/web"},
		{ID: "codegraph.init", Profile: "claude-2", Project: "other/repo"}, // chưa gắn: bỏ
		{ID: "optimizer.balanced", Profile: "claude-2"},                    // đã có optimizer.enable
		{ID: "tool.codegraph"},
		{ID: "open.memory"},  // giao diện tự xử lý
		{ID: "memory.trim"},  // không có trong FIXES
		{ID: "tool.unknown"}, // công cụ ngoài bảng
	}
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "balanced", RTK: true, Codegraph: true}})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"optimizer.enable@claude-2", "optimizer.enable@codex-2",
		"fix.optimizer.rtk@claude-2",
		"tool.codegraph@codegraph",
		"fix.codegraph.mcp@codex-2", "fix.codegraph.init@acme/web",
		"context.sync@acme/web", "score.recompute@machine",
	}
	if got := stepIDs(plan.Steps); !reflect.DeepEqual(got, want) {
		t.Fatalf("các bước %v\nmuốn %v", got, want)
	}
	rtk := findStep(t, plan.Steps, "fix.optimizer.rtk", "claude-2")
	if rtk.Group != "cli" || rtk.Profile != "claude-2" || !rtk.Undoable || rtk.Reason != "Theo chính sách dự án Acme Web" {
		t.Fatalf("bước RTK sai: %+v", rtk)
	}
	tool := findStep(t, plan.Steps, "tool.codegraph", "codegraph")
	if tool.Group != "tools" || tool.Undoable {
		t.Fatalf("công cụ đã cài không hoàn tác: %+v", tool)
	}
	initStep := findStep(t, plan.Steps, "fix.codegraph.init", "acme/web")
	if initStep.Group != "tools" || initStep.Project != "acme/web" || initStep.Profile != "claude-2" {
		t.Fatalf("bước codegraph.init sai: %+v", initStep)
	}

	// Không hỗ trợ RTK (Codex, hay máy chưa có RTK) thì không có bước RTK.
	f.machine.RTKSupported = false
	plan, err = f.runner.Plan(map[string]Policy{"acme/web": {Level: "balanced", RTK: true}})
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Steps {
		if s.ID == "fix.optimizer.rtk" {
			t.Fatalf("không hỗ trợ RTK mà vẫn có bước: %+v", s)
		}
	}
}

// Danh sách bước là đóng (FR-014): không có bước nào nén memory, gỡ MCP hay xoá skill.
func TestStepListIsClosed(t *testing.T) {
	want := []string{
		"optimizer.enable",
		"fix.optimizer.balanced", "fix.optimizer.rtk", "fix.optimizer.aggressive",
		"fix.codegraph.mcp", "fix.codegraph.init",
		"tool.rtk", "tool.codegraph",
		"context.sync",
		"score.recompute",
	}
	got := StepIDs()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("danh sách bước đổi: %v\nmuốn %v — thêm bước phải sửa test này có chủ ý", got, want)
	}
	banned := regexp.MustCompile(`(?i)compress|nén|trim|mcp\.(remove|disable)|skill|delete|xoa`)
	for _, id := range got {
		if banned.MatchString(id) {
			t.Fatalf("bước bị cấm: %s", id)
		}
		if !ValidStepID(id) {
			t.Fatalf("%s phải hợp lệ", id)
		}
	}
	for _, id := range []string{"memory.compress", "fix.memory.compress", "fix.mcp.remove", "tool.skill", "context.write", "fix.", ""} {
		if ValidStepID(id) {
			t.Fatalf("%q phải bị từ chối", id)
		}
	}
}

// Sửa nhanh chỉ được là id trong FIXES của Rust; test đọc thẳng token_score.rs để hai bên không lệch nhau.
func TestFixesMatchRust(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "..", "apps", "desktop", "src-tauri", "src", "token_score.rs"))
	if err != nil {
		t.Skipf("không có mã Rust cạnh worker: %v", err)
	}
	block := regexp.MustCompile(`(?s)const FIXES: \[\(&str, Fix\); \d+\] = \[(.*?)\];`).FindSubmatch(src)
	if block == nil {
		t.Fatal("không thấy FIXES trong token_score.rs")
	}
	var rust []string
	for _, m := range regexp.MustCompile(`\("([a-z.]+)",`).FindAllSubmatch(block[1], -1) {
		rust = append(rust, string(m[1]))
	}
	var ours []string
	for _, id := range StepIDs() {
		if strings.HasPrefix(id, "fix.") {
			ours = append(ours, strings.TrimPrefix(id, "fix."))
		}
	}
	sort.Strings(rust)
	sort.Strings(ours)
	if !reflect.DeepEqual(rust, ours) {
		t.Fatalf("FIXES của Rust %v khác sửa nhanh của optimizeall %v", rust, ours)
	}
}
