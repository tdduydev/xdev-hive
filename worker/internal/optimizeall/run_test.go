package optimizeall

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestApplyRunsSelectedStepsAndLogs(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	// Người dùng bỏ chọn gói Codex và cả bước tính điểm (bước này không bỏ được).
	for i := range plan.Steps {
		if plan.Steps[i].Target == "codex-2" || plan.Steps[i].ID == StepScoreRecompute {
			plan.Steps[i].Selected = false
		}
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	if run.ID == "" || len(run.ID) != 26 {
		t.Fatalf("id lần chạy phải là ULID: %q", run.ID)
	}
	if run.ScoreBefore == nil || *run.ScoreBefore != 48 || run.ScoreAfter == nil || *run.ScoreAfter != 81 {
		t.Fatalf("điểm trước/sau: %v → %v", run.ScoreBefore, run.ScoreAfter)
	}
	if s := runStep(t, run, StepOptimizerEnable, "claude-2"); s.Status != StatusOK || s.Undo == nil || s.Undo.Kind != "optimizer" ||
		s.Undo.Backup == "" || s.Undo.PrevEnabled == nil || *s.Undo.PrevEnabled {
		t.Fatalf("bước Claude: %+v undo %+v", s, s.Undo)
	}
	if s := runStep(t, run, StepOptimizerEnable, "codex-2"); s.Status != StatusSkipped {
		t.Fatalf("bước bỏ chọn phải skipped: %+v", s)
	}
	if s := runStep(t, run, StepContextSync, "acme/web"); s.Status != StatusOK || s.Undo == nil || s.Undo.Entry == "" {
		t.Fatalf("bước ngữ cảnh: %+v", s)
	}
	if s := runStep(t, run, StepScoreRecompute, "machine"); s.Status != StatusOK {
		t.Fatalf("tính điểm luôn chạy: %+v", s)
	}
	if readFile(t, f.codex) != userCodex {
		t.Fatal("bước bỏ chọn không được ghi file")
	}
	if readFile(t, f.settings) == userSettings {
		t.Fatal("bước đã chọn phải ghi settings.json")
	}
	saved := readRun(t, f.runner.Dir, run.ID)
	if saved.FinishedAt == nil || len(saved.Steps) != len(run.Steps) || saved.Steps[0].Status != StatusOK {
		t.Fatalf("nhật ký trên đĩa: %+v", saved)
	}
	last, err := f.runner.Last()
	if err != nil || last == nil || last.ID != run.ID {
		t.Fatalf("lần gần nhất: %+v %v", last, err)
	}
}

// Lỗi một bước không dừng bước sau; nhật ký được ghi sau mỗi bước, trước khi bước sau chạy.
func TestApplyFailingStepDoesNotStopLaterSteps(t *testing.T) {
	f := newFixture(t)
	f.machine.RTKSupported = true
	f.fixer.fail["optimizer.rtk"] = true
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "balanced", RTK: true}})
	if err != nil {
		t.Fatal(err)
	}
	var seen *OptimizeRun
	f.context.onSync = func(string) {
		entries, _ := os.ReadDir(filepath.Join(f.runner.Dir, "runs"))
		if len(entries) != 1 {
			t.Errorf("phải có đúng một nhật ký khi đang chạy, có %d", len(entries))
			return
		}
		id := entries[0].Name()[:26]
		r := readRun(t, f.runner.Dir, id)
		seen = &r
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	rtk := runStep(t, run, "fix.optimizer.rtk", "claude-2")
	if rtk.Status != StatusFailed || rtk.Error == nil || !contains(*rtk.Error, "sửa nhanh lỗi giả") {
		t.Fatalf("bước lỗi: %+v", rtk)
	}
	if s := runStep(t, run, StepContextSync, "acme/web"); s.Status != StatusOK {
		t.Fatalf("bước sau bước lỗi vẫn chạy: %+v", s)
	}
	if s := runStep(t, run, StepScoreRecompute, "machine"); s.Status != StatusOK {
		t.Fatalf("tính điểm vẫn chạy: %+v", s)
	}
	if seen == nil {
		t.Fatal("bước ngữ cảnh không chạy")
	}
	if s := runStep(t, seen, "fix.optimizer.rtk", "claude-2"); s.Status != StatusFailed {
		t.Fatalf("nhật ký chưa ghi kết quả bước trước khi bước sau chạy: %+v", s)
	}
	if s := runStep(t, seen, StepContextSync, "acme/web"); s.Status != StatusPlanned {
		t.Fatalf("bước chưa chạy phải là planned: %+v", s)
	}
	if seen.FinishedAt != nil {
		t.Fatal("đang chạy thì chưa có finishedAt")
	}
}

func TestApplyRecordsToolResultsFromApp(t *testing.T) {
	f := newFixture(t)
	f.machine.Fixes = []FixSuggestion{{ID: "tool.rtk"}, {ID: "tool.codegraph"}}
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	msg := "cài lỗi"
	for i := range plan.Steps {
		switch plan.Steps[i].ID {
		case "tool.rtk":
			plan.Steps[i].Status = StatusOK
		case "tool.codegraph":
			plan.Steps[i].Status, plan.Steps[i].Error = StatusFailed, &msg
		}
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	if s := runStep(t, run, "tool.rtk", "rtk"); s.Status != StatusOK || s.Undo != nil {
		t.Fatalf("công cụ app đã cài: %+v", s)
	}
	if s := runStep(t, run, "tool.codegraph", "codegraph"); s.Status != StatusFailed || s.Error == nil || *s.Error != msg {
		t.Fatalf("công cụ cài lỗi: %+v", s)
	}
}

func TestApplyRejectsUnknownStep(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	plan.Steps = append([]Step{{ID: "memory.compress", Group: "context", Target: "acme/web", Selected: true}}, plan.Steps...)
	_, err = f.runner.Apply(plan)
	var e *Error
	if !errors.As(err, &e) || e.Code != CodeInvalidPlan {
		t.Fatalf("bước ngoài danh sách phải bị từ chối: %v", err)
	}
	if readFile(t, f.settings) != userSettings {
		t.Fatal("kế hoạch sai thì không được ghi gì")
	}
	if _, err := os.Stat(filepath.Join(f.runner.Dir, "runs")); !os.IsNotExist(err) {
		t.Fatal("kế hoạch sai thì không có nhật ký")
	}
}

func TestRunsKeepThirty(t *testing.T) {
	f := newFixture(t)
	dir := filepath.Join(f.runner.Dir, "runs")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var ids []string
	for i := 0; i < 35; i++ {
		id := newULID(f.runner.now())
		ids = append(ids, id)
		writeFile(t, filepath.Join(dir, id+".json"), `{"id":"`+id+`","steps":[]}`)
	}
	if err := f.runner.prune(); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != keepRuns {
		t.Fatalf("giữ %d lần, muốn %d", len(entries), keepRuns)
	}
	if _, err := os.Stat(filepath.Join(dir, ids[4]+".json")); !os.IsNotExist(err) {
		t.Fatal("lần cũ nhất phải bị xoá")
	}
	if _, err := os.Stat(filepath.Join(dir, ids[5]+".json")); err != nil {
		t.Fatal("lần thứ 30 từ mới nhất phải còn")
	}
}
