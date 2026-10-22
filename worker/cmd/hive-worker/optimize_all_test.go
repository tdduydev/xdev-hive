package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/ctxsync"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizeall"
)

const optimizeAllProjectID = "7f3c1b52-0a1e-4c0e-9d57-2f4c8f0b6a11"

// optimizeAllFixture là máy giả của quickstart mục 3: hai gói Claude, một gói Codex, một dự án đã gắn và bật ngữ cảnh
// dùng chung. Ngữ cảnh và optimizer chung một thư mục nhà như trên máy thật, để hai lệnh dùng chung optimize.lock.
type optimizeAllFixture struct {
	optimizeEnv
	repo, key string
}

func fakeOptimizeAll(t *testing.T) optimizeAllFixture {
	t.Helper()
	ctx := fakeContextEnv(t)
	e := fakeScoreEnv(t)
	contextHome = func() (string, error) { return e.home, nil }
	oldExec := optimizeAllExec
	optimizeAllExec = func(context.Context, string, []string, []string) error {
		return errors.New("test không được chạy lệnh thật")
	}
	t.Cleanup(func() { optimizeAllExec = oldExec })

	e.write(t, ".xdev-hive/accounts/claude-a/settings.json", "{\n  \"model\": \"opus\"\n}\n")
	e.write(t, ".xdev-hive/accounts/claude-b/settings.json", "{}\n")
	e.write(t, ".xdev-hive/accounts/codex-a/config.toml", "model = \"gpt-5\"\n")
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		e.write(t, ".xdev-hive/accounts/claude-a/projects/-p/"+name+".jsonl", claudeTranscript("2026-10-12T08:00:00Z"))
	}
	e.accounts(t, `{"id":"claude-a","label":"Claude A","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-a"},`+
		`{"id":"claude-b","label":"Claude B","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-b"},`+
		`{"id":"codex-a","label":"Codex A","cli":"codex","configDir":"~/.xdev-hive/accounts/codex-a"}`)
	list, _ := json.Marshal(map[string]any{"projects": []map[string]any{
		{"projectId": optimizeAllProjectID, "name": "acme/web", "folder": ctx.repo, "fullPermission": false},
	}})
	writeTestFile(t, filepath.Join(filepath.Dir(e.config), "projects.json"), string(list))

	p := contextProject(t, "enable", "--folder", ctx.repo, "--project-id", optimizeAllProjectID)
	// Nguồn đổi mà chưa đồng bộ: bước ngữ cảnh của "Tối ưu" có việc để làm.
	writeTestFile(t, filepath.Join(e.home, ".xdev-hive", "context", p.Key, "source.md"),
		"# Quy ước\n\nChạy pnpm check trước khi mở PR.\n")
	return optimizeAllFixture{optimizeEnv: e, repo: ctx.repo, key: p.Key}
}

func (f optimizeAllFixture) all(t *testing.T, args ...string) (int, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := optimizeCommand(append(append([]string{"all"}, args...), "--json", "--config", f.config), &out, &errOut)
	if errOut.Len() > 0 {
		t.Logf("stderr: %s", errOut.String())
	}
	return code, out.String()
}

func (f optimizeAllFixture) plan(t *testing.T, args ...string) optimizeall.OptimizePlan {
	t.Helper()
	code, out := f.all(t, append([]string{"--preview"}, args...)...)
	if code != 0 {
		t.Fatalf("preview: %d %s", code, out)
	}
	var plan optimizeall.OptimizePlan
	decodeStrict(t, out, &plan)
	return plan
}

func (f optimizeAllFixture) run(t *testing.T, args ...string) *optimizeall.OptimizeRun {
	t.Helper()
	code, out := f.all(t, args...)
	if code != 0 {
		t.Fatalf("optimize all %v: %d %s", args, code, out)
	}
	var run *optimizeall.OptimizeRun
	decodeStrict(t, out, &run)
	return run
}

func (f optimizeAllFixture) apply(t *testing.T, plan optimizeall.OptimizePlan) *optimizeall.OptimizeRun {
	t.Helper()
	data, err := json.Marshal(plan)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "plan.json")
	writeTestFile(t, file, string(data))
	return f.run(t, "--apply", "--plan-file", file)
}

func (f optimizeAllFixture) expectError(t *testing.T, wantCode string, wantExit int, args ...string) {
	t.Helper()
	code, out := f.all(t, args...)
	var e contextError
	decodeStrict(t, out, &e)
	if code != wantExit || e.Error.Code != wantCode || strings.TrimSpace(e.Error.Message) == "" {
		t.Fatalf("optimize all %v = %d %s, muốn exit %d mã %s", args, code, out, wantExit, wantCode)
	}
}

func (f optimizeAllFixture) profileFile(id string) string {
	name := "settings.json"
	if strings.HasPrefix(id, "codex") {
		name = "config.toml"
	}
	return filepath.Join(f.home, ".xdev-hive", "accounts", id, name)
}

// snapshot chép mọi file "Tối ưu" có thể ghi; nil là file chưa có.
func (f optimizeAllFixture) snapshot(t *testing.T) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, id := range []string{"claude-a", "claude-b", "codex-a"} {
		out[f.profileFile(id)] = nil
	}
	code, raw, _ := runContext(t, "status", "--project", f.key)
	var list struct {
		Projects []ctxsync.Project `json:"projects"`
	}
	decodeStrict(t, raw, &list)
	if code != 0 || len(list.Projects) != 1 || len(list.Projects[0].Targets) == 0 {
		t.Fatalf("status: %d %s", code, raw)
	}
	for _, tg := range list.Projects[0].Targets {
		out[filepath.Join(f.repo, filepath.FromSlash(tg.Path))] = nil
	}
	for path := range out {
		if b, err := os.ReadFile(path); err == nil {
			out[path] = b
		}
	}
	return out
}

func findStep[T any](steps []T, match func(T) bool) []T {
	var out []T
	for _, s := range steps {
		if match(s) {
			out = append(out, s)
		}
	}
	return out
}

// Quickstart mục 3 bước 1–4: xem trước có đủ nhóm, bỏ chọn một dòng rồi áp dụng, hoàn tác thì mọi file về y như trước.
func TestOptimizeAllPreviewApplyUndo(t *testing.T) {
	f := fakeOptimizeAll(t)
	before := f.snapshot(t)
	policy := filepath.Join(t.TempDir(), "policy.json")
	writeTestFile(t, policy, `{"`+optimizeAllProjectID+`":{"level":"aggressive","rtk":false,"codegraph":true,"autoCompactWindow":150000}}`)

	plan := f.plan(t, "--policy-file", policy)
	if !reflect.DeepEqual(f.snapshot(t), before) {
		t.Fatal("xem trước không được ghi file nào")
	}
	if plan.ScoreBefore == nil || !reflect.DeepEqual(plan.PolicySources, []string{optimizeAllProjectID}) {
		t.Fatalf("plan = %+v", plan)
	}
	groups := map[string]bool{}
	for _, s := range plan.Steps {
		groups[s.Group] = true
	}
	for _, g := range []string{optimizeall.GroupCLI, optimizeall.GroupTools, optimizeall.GroupContext, optimizeall.GroupScore} {
		if !groups[g] {
			t.Errorf("thiếu nhóm %s: %+v", g, plan.Steps)
		}
	}
	enables := findStep(plan.Steps, func(s optimizeall.Step) bool { return s.ID == optimizeall.StepOptimizerEnable })
	for _, s := range enables {
		if s.Level == optimizeall.LevelAggressive && (s.Selected || !s.RequiresConfirm) {
			t.Errorf("dòng aggressive phải chờ người dùng chọn: %+v", s)
		}
		if s.Level == optimizeall.LevelBalanced && !s.Selected {
			t.Errorf("dòng balanced phải chọn sẵn: %+v", s)
		}
		if s.Reason != "Theo chính sách dự án acme/web" {
			t.Errorf("lý do = %q", s.Reason)
		}
	}
	for _, id := range []string{"claude-a", "claude-b", "codex-a"} {
		if len(findStep(enables, func(s optimizeall.Step) bool { return s.Target == id && s.Level == optimizeall.LevelBalanced })) != 1 {
			t.Errorf("thiếu dòng balanced cho %s: %+v", id, enables)
		}
	}
	ctxSteps := findStep(plan.Steps, func(s optimizeall.Step) bool { return s.ID == optimizeall.StepContextSync })
	if len(ctxSteps) != 1 || ctxSteps[0].Target != f.key || len(ctxSteps[0].Changes) == 0 ||
		!strings.Contains(ctxSteps[0].Title, "acme/web") || ctxSteps[0].Reason != "Theo chính sách dự án acme/web" {
		t.Fatalf("bước ngữ cảnh = %+v", ctxSteps)
	}
	if want := filepath.Join(f.repo, "CLAUDE.local.md"); len(findStep(ctxSteps[0].Changes, func(c optimizeall.Change) bool { return c.File == want })) != 1 {
		t.Errorf("xem trước thiếu %s: %+v", want, ctxSteps[0].Changes)
	}

	// Bỏ chọn gói claude-b: không dòng nào của nó được chạy.
	for i := range plan.Steps {
		if plan.Steps[i].Target == "claude-b" {
			plan.Steps[i].Selected = false
		}
	}
	run := f.apply(t, plan)
	if run.ScoreAfter == nil || run.FinishedAt == nil {
		t.Fatalf("run = %+v", run)
	}
	for _, s := range run.Steps {
		want := optimizeall.StatusOK
		switch {
		case s.Target == "claude-b", s.Level == optimizeall.LevelAggressive:
			want = optimizeall.StatusSkipped
		case strings.HasPrefix(s.ID, "tool."):
			// App chưa cài công cụ nên bước tool.* không có kết quả.
			want = optimizeall.StatusSkipped
		}
		if s.Status != want {
			t.Errorf("bước %s %s = %s (%v), muốn %s", s.ID, s.Target, s.Status, s.Error, want)
		}
	}
	after := f.snapshot(t)
	if !bytes.Equal(after[f.profileFile("claude-b")], before[f.profileFile("claude-b")]) {
		t.Error("gói bỏ chọn bị ghi")
	}
	if got := string(after[f.profileFile("claude-a")]); !strings.Contains(got, `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "150000"`) {
		t.Errorf("claude-a thiếu trần nén theo chính sách:\n%s", got)
	}
	if got := string(after[f.profileFile("codex-a")]); !strings.Contains(got, "model_auto_compact_token_limit = 150000") {
		t.Errorf("codex-a thiếu trần nén theo chính sách:\n%s", got)
	}
	if got := string(after[filepath.Join(f.repo, "CLAUDE.local.md")]); !strings.Contains(got, "Chạy pnpm check trước khi mở PR.") {
		t.Errorf("khối ngữ cảnh chưa đồng bộ:\n%s", got)
	}

	if last := f.run(t, "--last"); last == nil || last.ID != run.ID || last.UndoneAt != nil {
		t.Fatalf("--last = %+v", last)
	}
	undone := f.run(t, "--undo", "--run", run.ID)
	if undone.UndoneAt == nil {
		t.Fatalf("undo = %+v", undone)
	}
	for _, s := range undone.Steps {
		if s.Status == optimizeall.StatusOK && s.Undoable {
			t.Errorf("bước %s %s chưa hoàn tác: %v", s.ID, s.Target, s.Error)
		}
	}
	got := f.snapshot(t)
	for path, want := range before {
		if !bytes.Equal(got[path], want) {
			t.Errorf("%s sau hoàn tác:\n%s\nmuốn:\n%s", path, got[path], want)
		}
	}
	if last := f.run(t, "--last"); last == nil || last.UndoneAt == nil {
		t.Fatalf("--last sau hoàn tác = %+v", last)
	}
	f.expectError(t, optimizeall.CodeAlreadyUndone, 1, "--undo", "--run", run.ID)
}

// Sửa nhanh optimizer.* sau bước bật tối ưu phải giữ trần nén theo chính sách, và hoàn tác trả file về bản gốc.
func TestOptimizeAllFixKeepsPolicyWindow(t *testing.T) {
	f := fakeOptimizeAll(t)
	before := f.snapshot(t)
	window := 120000
	run := f.apply(t, optimizeall.OptimizePlan{Steps: []optimizeall.Step{
		{ID: optimizeall.StepOptimizerEnable, Target: "claude-a", Profile: "claude-a", Level: optimizeall.LevelBalanced,
			AutoCompactWindow: &window, Selected: true},
		{ID: "fix.optimizer.aggressive", Target: "claude-a", Profile: "claude-a", Selected: true},
		{ID: optimizeall.StepScoreRecompute, Target: "machine", Selected: true},
	}})
	for _, s := range run.Steps {
		if s.Status != optimizeall.StatusOK {
			t.Fatalf("bước %s = %s %v", s.ID, s.Status, s.Error)
		}
	}
	settings := readFile(t, f.profileFile("claude-a"))
	if !strings.Contains(settings, `"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "120000"`) {
		t.Fatalf("sửa nhanh làm mất trần nén:\n%s", settings)
	}
	view := decodeView(t, f.ok(t, "status", "--json"))
	if p := view.profile(t, "claude-a"); p.Level != "aggressive" {
		t.Fatalf("claude-a = %+v", p)
	}

	f.run(t, "--undo", "--run", run.ID)
	if got := readFile(t, f.profileFile("claude-a")); got != string(before[f.profileFile("claude-a")]) {
		t.Fatalf("hoàn tác:\n%s", got)
	}
	// Ngăn xếp score-fixes đã rút bản ghi của chuỗi: `optimize fix --undo` không còn gì để đảo.
	var st fixState
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(f.home, ".xdev-hive", "optimizer", "score-fixes.json"))), &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Stacks["claude-a"]) != 0 {
		t.Fatalf("ngăn xếp còn: %+v", st.Stacks)
	}
}

func TestOptimizeAllCodegraphFixes(t *testing.T) {
	f := fakeOptimizeAll(t)
	oldGOOS := optimizeGOOS
	optimizeGOOS = func() string { return "linux" }
	t.Cleanup(func() { optimizeGOOS = oldGOOS })
	type call struct {
		Dir  string
		Env  []string
		Argv []string
	}
	var calls []call
	optimizeAllExec = func(_ context.Context, dir string, env, argv []string) error {
		calls = append(calls, call{dir, env, argv})
		return nil
	}
	exclude := filepath.Join(f.repo, ".git", "info", "exclude")
	excludeBefore, _ := os.ReadFile(exclude)

	run := f.apply(t, optimizeall.OptimizePlan{Steps: []optimizeall.Step{
		{ID: "fix.codegraph.mcp", Target: "claude-a", Profile: "claude-a", Selected: true},
		{ID: "fix.codegraph.init", Target: optimizeAllProjectID, Project: optimizeAllProjectID, Selected: true},
	}})
	for _, s := range run.Steps {
		if s.Status != optimizeall.StatusOK {
			t.Fatalf("bước %s = %s %v", s.ID, s.Status, s.Error)
		}
	}
	claudeDir := filepath.Join(f.home, ".xdev-hive", "accounts", "claude-a")
	graphEnv := []string{"CODEGRAPH_NO_DAEMON=1", "CODEGRAPH_TELEMETRY=0", "DO_NOT_TRACK=1"}
	want := []call{
		{"", append([]string{"CLAUDE_CONFIG_DIR=" + claudeDir}, graphEnv...), []string{"claude", "mcp", "add", "--scope", "user",
			"codegraph", "--env", "CODEGRAPH_TELEMETRY=0", "--env", "DO_NOT_TRACK=1", "--env", "CODEGRAPH_NO_DAEMON=1", "--",
			"codegraph", "serve", "--mcp"}},
		{f.repo, graphEnv, []string{"codegraph", "init", "-y", f.repo}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("lệnh = %+v\nmuốn %+v", calls, want)
	}
	if got := readFile(t, exclude); !strings.Contains(got, "/.codegraph") {
		t.Fatalf("exclude thiếu /.codegraph:\n%s", got)
	}

	calls = nil
	f.run(t, "--undo", "--run", run.ID)
	want = []call{
		{f.repo, graphEnv, []string{"codegraph", "uninit", "-f", f.repo}},
		{"", []string{"CLAUDE_CONFIG_DIR=" + claudeDir}, []string{"claude", "mcp", "remove", "-s", "user", "codegraph"}},
	}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("lệnh hoàn tác = %+v\nmuốn %+v", calls, want)
	}
	if got, _ := os.ReadFile(exclude); !bytes.Equal(got, excludeBefore) {
		t.Fatalf("exclude sau hoàn tác:\n%s\nmuốn:\n%s", got, excludeBefore)
	}

	// Windows: CLI không chạy thẳng được codegraph.cmd.
	optimizeGOOS = func() string { return "windows" }
	argv, err := optimizeAllMCPAdd("codex")
	if err != nil || strings.Join(argv[len(argv)-5:], " ") != "cmd /c codegraph.cmd serve --mcp" || argv[0] != "codex" {
		t.Fatalf("mcp add trên Windows = %v %v", argv, err)
	}
}

func TestOptimizeAllCodegraphFailureKeepsGoing(t *testing.T) {
	f := fakeOptimizeAll(t)
	optimizeAllExec = func(context.Context, string, []string, []string) error {
		return errors.New("codegraph: không tìm thấy lệnh")
	}
	run := f.apply(t, optimizeall.OptimizePlan{Steps: []optimizeall.Step{
		{ID: "fix.codegraph.init", Target: optimizeAllProjectID, Project: optimizeAllProjectID, Selected: true},
		{ID: optimizeall.StepContextSync, Target: f.key, Project: f.key, Selected: true},
	}})
	if s := run.Steps[0]; s.Status != optimizeall.StatusFailed || s.Error == nil || !strings.Contains(*s.Error, "không tìm thấy") {
		t.Fatalf("bước lỗi = %+v", s)
	}
	if s := run.Steps[1]; s.Status != optimizeall.StatusOK {
		t.Fatalf("bước sau bước lỗi vẫn phải chạy: %+v", s)
	}
}

// Quickstart mục 3 bước 5: cửa sổ thứ hai thấy khoá bận; đồng bộ ngữ cảnh định kỳ bỏ lượt thay vì ghi xen.
func TestOptimizeAllLocked(t *testing.T) {
	f := fakeOptimizeAll(t)
	before := f.snapshot(t)
	unlock, err := optimizeall.Lock(filepath.Join(f.home, ".xdev-hive", "optimizer"))
	if err != nil {
		t.Fatal(err)
	}
	f.expectError(t, optimizeall.CodeLocked, 1, "--preview")
	f.expectError(t, optimizeall.CodeLocked, 1, "--undo", "--run", "01JZZZZZZZZZZZZZZZZZZZZZZZ")

	p := contextProject(t, "sync", "--project", f.key)
	if !p.Locked || p.Key != f.key {
		t.Fatalf("sync khi khoá bận = %+v", p)
	}
	if !reflect.DeepEqual(f.snapshot(t), before) {
		t.Fatal("sync khi khoá bận không được ghi file")
	}
	unlock()

	p = contextProject(t, "sync", "--project", f.key)
	if p.Locked {
		t.Fatalf("sync sau khi nhả khoá = %+v", p)
	}
	if got := readFile(t, filepath.Join(f.repo, "CLAUDE.local.md")); !strings.Contains(got, "Chạy pnpm check") {
		t.Fatalf("sync sau khi nhả khoá chưa ghi:\n%s", got)
	}
}

func TestOptimizeAllInputErrors(t *testing.T) {
	f := fakeOptimizeAll(t)
	if code, out := f.all(t, "--last"); code != 0 || strings.TrimSpace(out) != "null" {
		t.Fatalf("--last khi chưa chạy lần nào = %d %q", code, out)
	}
	for _, args := range [][]string{
		{},
		{"--preview", "--apply"},
		{"--apply"},
		{"--undo"},
		{"--preview", "thừa"},
		{"--nope"},
	} {
		f.expectError(t, optimizeAllInvalid, 2, args...)
	}

	bad := filepath.Join(t.TempDir(), "bad.json")
	writeTestFile(t, bad, `{"steps":[{"id":"memory.compact","target":"x","selected":true}]}`)
	f.expectError(t, optimizeall.CodeInvalidPlan, 1, "--apply", "--plan-file", bad)
	writeTestFile(t, bad, `{"steps":`)
	f.expectError(t, optimizeall.CodeInvalidPlan, 1, "--apply", "--plan-file", bad)
	f.expectError(t, optimizeall.CodeRunNotFound, 1, "--undo", "--run", "01JZZZZZZZZZZZZZZZZZZZZZZZ")
	writeTestFile(t, bad, `{"x":{"level":"max"}}`)
	f.expectError(t, optimizeAllInvalid, 1, "--preview", "--policy-file", bad)
}
