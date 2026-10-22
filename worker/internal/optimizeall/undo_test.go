package optimizeall

import (
	"errors"
	"strings"
	"testing"
)

// SC-004: hoàn tác trả settings.json, config.toml và file có khối ngữ cảnh về đúng từng byte.
func TestUndoRestoresFilesByteForByte(t *testing.T) {
	f := newFixture(t)
	f.machine.RTKSupported = true
	f.machine.Fixes = []FixSuggestion{{ID: "codegraph.mcp", Profile: "codex-2"}}
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "balanced", RTK: true, AutoCompactWindow: intPtr(150_000)}})
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range run.Steps {
		if s.Status != StatusOK {
			t.Fatalf("bước %s@%s: %s %v", s.ID, s.Target, s.Status, s.Error)
		}
	}
	if readFile(t, f.settings) == userSettings || readFile(t, f.codex) == userCodex || readFile(t, f.claudeMd) == userClaudeMd {
		t.Fatal("áp dụng phải đổi cả ba file")
	}
	undone, err := f.runner.Undo(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	if undone.UndoneAt == nil {
		t.Fatal("thiếu undoneAt")
	}
	if got := readFile(t, f.settings); got != userSettings {
		t.Fatalf("settings.json khác bản gốc:\n%s", got)
	}
	if got := readFile(t, f.codex); got != userCodex {
		t.Fatalf("config.toml khác bản gốc:\n%s", got)
	}
	if got := readFile(t, f.claudeMd); got != userClaudeMd {
		t.Fatalf("CLAUDE.md khác bản gốc:\n%s", got)
	}
	if st, _ := f.opt.Status(); len(st) != 0 {
		t.Fatalf("hoàn tác xong thì gói coi như chưa bật: %+v", st)
	}
	for _, s := range undone.Steps {
		want := StatusUndone
		if !s.Undoable {
			want = StatusOK
		}
		if s.Status != want {
			t.Fatalf("bước %s@%s sau hoàn tác: %s (lỗi %v)", s.ID, s.Target, s.Status, s.Error)
		}
	}
	// Sửa nhanh hoàn tác theo thứ tự ngược với lúc áp dụng.
	if len(f.fixer.undone) != 2 || f.fixer.undone[0].FixID != "codegraph.mcp" || f.fixer.undone[1].FixID != "optimizer.rtk" {
		t.Fatalf("thứ tự hoàn tác sửa nhanh: %+v", f.fixer.undone)
	}
	if saved := readRun(t, f.runner.Dir, run.ID); saved.UndoneAt == nil {
		t.Fatal("nhật ký trên đĩa chưa ghi undoneAt")
	}
}

func TestUndoReEnablesPreviousLevel(t *testing.T) {
	f := newFixture(t)
	claude := f.machine.Profiles[0].Profile
	if _, err := f.enabler.Enable(claude, EnableRequest{Level: "balanced"}); err != nil {
		t.Fatal(err)
	}
	balanced := readFile(t, f.settings)
	plan, err := f.runner.Plan(map[string]Policy{"acme/web": {Level: "aggressive"}})
	if err != nil {
		t.Fatal(err)
	}
	for i := range plan.Steps {
		plan.Steps[i].Selected = plan.Steps[i].Target == "claude-2"
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	s := runStep(t, run, StepOptimizerEnable, "claude-2")
	if s.Status != StatusOK || s.Undo == nil || s.Undo.PrevEnabled == nil || !*s.Undo.PrevEnabled || s.Undo.PrevLevel != "balanced" {
		t.Fatalf("bước đổi mức phải ghi mức trước: %+v %+v", s, s.Undo)
	}
	if _, err := f.runner.Undo(run.ID); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.settings); got != balanced {
		t.Fatalf("hoàn tác phải về mức balanced như trước:\n%s", got)
	}
	st, _ := f.opt.Status()
	if len(st) != 1 || st[0].Level != "balanced" {
		t.Fatalf("trạng thái sau hoàn tác: %+v", st)
	}
}

func TestUndoOnlyLatestRun(t *testing.T) {
	f := newFixture(t)
	f.runner.Scorer = &testScorer{values: []float64{50}}
	apply := func() *OptimizeRun {
		plan, err := f.runner.Plan(nil)
		if err != nil {
			t.Fatal(err)
		}
		run, err := f.runner.Apply(plan)
		if err != nil {
			t.Fatal(err)
		}
		return run
	}
	first, second := apply(), apply()
	codeOf := func(err error) string {
		var e *Error
		if errors.As(err, &e) {
			return e.Code
		}
		return ""
	}
	if _, err := f.runner.Undo(first.ID); codeOf(err) != CodeNotLatest {
		t.Fatalf("lần không phải gần nhất: %v", err)
	}
	if _, err := f.runner.Undo("01JB0000000000000000000000"); codeOf(err) != CodeRunNotFound {
		t.Fatalf("lần không có: %v", err)
	}
	if _, err := f.runner.Undo("../state"); codeOf(err) != CodeRunNotFound {
		t.Fatalf("id lạ: %v", err)
	}
	if _, err := f.runner.Undo(second.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.runner.Undo(second.ID); codeOf(err) != CodeAlreadyUndone {
		t.Fatalf("hoàn tác hai lần: %v", err)
	}
	// Như ngăn xếp: lần sau đã hoàn tác thì lần trước thành lần gần nhất chưa hoàn tác.
	if _, err := f.runner.Undo(first.ID); err != nil {
		t.Fatal(err)
	}
	if got := readFile(t, f.settings); got != userSettings {
		t.Fatalf("hoàn tác hai lần liên tiếp phải về bản gốc:\n%s", got)
	}
}

// Sửa tay sau lần tối ưu thì báo và bỏ bước đụng file đó; các bước khác vẫn hoàn tác.
func TestUndoStopsStepWhenFileEditedByHand(t *testing.T) {
	f := newFixture(t)
	plan, err := f.runner.Plan(nil)
	if err != nil {
		t.Fatal(err)
	}
	run, err := f.runner.Apply(plan)
	if err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(readFile(t, f.settings), `"dark"`, `"light"`, 1)
	writeFile(t, f.settings, edited)
	undone, err := f.runner.Undo(run.ID)
	if err != nil {
		t.Fatal(err)
	}
	s := runStep(t, undone, StepOptimizerEnable, "claude-2")
	if s.Status != StatusOK || s.Error == nil || !contains(*s.Error, "sửa") {
		t.Fatalf("bước có file bị sửa tay phải giữ nguyên và báo: %+v", s)
	}
	if readFile(t, f.settings) != edited {
		t.Fatal("không được ghi đè file người dùng đã sửa")
	}
	if s := runStep(t, undone, StepOptimizerEnable, "codex-2"); s.Status != StatusUndone {
		t.Fatalf("gói khác vẫn hoàn tác: %+v", s)
	}
	if s := runStep(t, undone, StepContextSync, "acme/web"); s.Status != StatusUndone {
		t.Fatalf("khối ngữ cảnh vẫn hoàn tác: %+v", s)
	}
	if readFile(t, f.codex) != userCodex || readFile(t, f.claudeMd) != userClaudeMd {
		t.Fatal("file không bị sửa tay phải về bản gốc")
	}
}
