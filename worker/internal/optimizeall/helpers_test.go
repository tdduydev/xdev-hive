package optimizeall

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
)

const userSettings = `{
  "theme": "dark",
  "permissions": {
    "allow": [
      "Bash(git status:*)"
    ]
  },
  "model": "opus"
}
`

const userCodex = `model = "gpt-5"
# ghi chú của người dùng
approval_policy = "on-request"
`

const userClaudeMd = "# Dự án acme\n\nGhi chú của người dùng.\n"

// testEnabler dựng preset cố định thay cho preset thật của cmd (phụ thuộc phiên bản CLI và RTK trên máy).
type testEnabler struct {
	o     *optimizer.Optimizer
	calls []EnableRequest
}

func (e *testEnabler) Enable(p optimizer.Profile, req EnableRequest) (*optimizer.Result, error) {
	e.calls = append(e.calls, req)
	pct := "80"
	if req.Level == "aggressive" {
		pct = "60"
	}
	window := "200000"
	if req.AutoCompactWindow != nil {
		window = strconv.Itoa(*req.AutoCompactWindow)
	}
	preset := optimizer.Preset{
		Env: map[string]string{
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW": window,
			"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": pct,
		},
		Codex: map[string]string{"tool_output_token_limit": "8000", "model_auto_compact_token_limit": window},
		Hooks: []optimizer.Hook{{Event: "PostToolUse", Matcher: "Bash|Grep", Args: []string{"hook", "post-tool", "--local"}}},
	}
	if req.RTK {
		preset.Hooks = append(preset.Hooks, optimizer.Hook{Event: "PreToolUse", Matcher: "Bash", Command: "rtk", Args: []string{"hook"}})
	}
	return e.o.Enable(p, req.Level, preset, optimizer.Options{Explicit: req.Explicit})
}

// testFixer giả bản ghi score-fixes của cmd; fail làm một sửa nhanh lỗi để kiểm bước sau vẫn chạy.
type testFixer struct {
	fail    map[string]bool
	applied []FixRequest
	undone  []FixRequest
}

func (f *testFixer) Apply(req FixRequest) (FixOutcome, error) {
	if f.fail[req.FixID] {
		return FixOutcome{}, errors.New("sửa nhanh lỗi giả")
	}
	f.applied = append(f.applied, req)
	rec, _ := json.Marshal(map[string]any{"fixId": req.FixID, "prevEnabled": false})
	return FixOutcome{Record: rec}, nil
}

func (f *testFixer) Undo(req FixRequest, record json.RawMessage) error {
	var rec map[string]any
	if err := json.Unmarshal(record, &rec); err != nil || rec["fixId"] != req.FixID {
		return errors.New("bản ghi sửa nhanh sai")
	}
	f.undone = append(f.undone, req)
	return nil
}

// testContext ghi khối như ctxsync (qua memstore.Batch) để hoàn tác bằng memstore.Restore như thật.
type testContext struct {
	t       *testing.T
	store   memstore.Store
	files   map[string]string
	onSync  func(key string)
	synced  []string
	enabled []ContextProject
}

func (c *testContext) Enabled() ([]ContextProject, error) { return c.enabled, nil }

func (c *testContext) Sync(key string) (string, error) {
	if c.onSync != nil {
		c.onSync(key)
	}
	c.synced = append(c.synced, key)
	path := c.files[key]
	b, err := c.store.Begin("context-sync", false)
	if err != nil {
		return "", err
	}
	if err := b.Save(path, false); err != nil {
		b.Abort()
		return "", err
	}
	old, _ := os.ReadFile(path)
	block := "\n<!-- xdev-hive:context:begin sha=abc -->\nNgữ cảnh dùng chung\n<!-- xdev-hive:context:end -->\n"
	if err := os.WriteFile(path, append(old, block...), 0o600); err != nil {
		_, err = b.Fail(err)
		return "", err
	}
	res, err := b.Commit()
	return res.Entry, err
}

type testScorer struct {
	mu     sync.Mutex
	values []float64
}

func (s *testScorer) Score() (*float64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.values) == 0 {
		return nil, nil
	}
	v := s.values[0]
	if len(s.values) > 1 {
		s.values = s.values[1:]
	}
	return &v, nil
}

type fixture struct {
	t        *testing.T
	home     string
	runner   *Runner
	opt      *optimizer.Optimizer
	enabler  *testEnabler
	fixer    *testFixer
	context  *testContext
	machine  Machine
	settings string
	codex    string
	claudeMd string
}

// newFixture dựng HOME giả với một gói Claude (settings.json có sẵn), một gói Codex (config.toml có sẵn) và một dự án
// đã bật ngữ cảnh dùng chung (CLAUDE.md có sẵn).
func newFixture(t *testing.T) *fixture {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	tick := time.Date(2026, 10, 22, 9, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	now := func() time.Time {
		mu.Lock()
		defer mu.Unlock()
		tick = tick.Add(time.Second)
		return tick
	}
	o := optimizer.New(home)
	o.Now = now
	dir := filepath.Join(home, ".xdev-hive", "optimizer")
	store := memstore.Store{Dir: dir, Now: now}
	f := &fixture{t: t, home: home, opt: o}
	f.enabler = &testEnabler{o: o}
	f.fixer = &testFixer{fail: map[string]bool{}}

	claude := f.profile("claude-2", "claude")
	codex := f.profile("codex-2", "codex")
	f.settings = filepath.Join(claude.Dir, "settings.json")
	f.codex = filepath.Join(codex.Dir, "config.toml")
	writeFile(t, f.settings, userSettings)
	writeFile(t, f.codex, userCodex)

	repo := filepath.Join(home, "src", "acme-web")
	if err := os.MkdirAll(repo, 0o700); err != nil {
		t.Fatal(err)
	}
	f.claudeMd = filepath.Join(repo, "CLAUDE.md")
	writeFile(t, f.claudeMd, userClaudeMd)
	f.context = &testContext{t: t, store: store, files: map[string]string{"acme/web": f.claudeMd},
		enabled: []ContextProject{{Key: "acme/web", Name: "Acme Web", Files: []string{f.claudeMd}}}}

	f.machine = Machine{
		Profiles: []ProfileInfo{{Profile: claude, Label: "Claude 2"}, {Profile: codex, Label: "Codex 2"}},
		Projects: []Project{{ID: "acme/web", Name: "Acme Web", Folder: repo}},
	}
	f.runner = &Runner{
		Dir:       dir,
		Optimizer: o,
		Store:     store,
		Machine:   func() (Machine, error) { return f.machine, nil },
		Enabler:   f.enabler,
		Fixer:     f.fixer,
		Context:   f.context,
		Scorer:    &testScorer{values: []float64{48, 81}},
		Now:       now,
	}
	return f
}

func (f *fixture) profile(id, cli string) optimizer.Profile {
	f.t.Helper()
	p, err := f.opt.Profile(id, cli, "~/.xdev-hive/accounts/"+id)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	return p
}

func writeFile(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func stepIDs(steps []Step) []string {
	out := make([]string, 0, len(steps))
	for _, s := range steps {
		out = append(out, s.ID+"@"+s.Target)
	}
	return out
}

func findStep(t *testing.T, steps []Step, id, target string) Step {
	t.Helper()
	for _, s := range steps {
		if s.ID == id && s.Target == target {
			return s
		}
	}
	t.Fatalf("không thấy bước %s@%s trong %v", id, target, stepIDs(steps))
	return Step{}
}

func runStep(t *testing.T, run *OptimizeRun, id, target string) RunStep {
	t.Helper()
	for _, s := range run.Steps {
		if s.ID == id && s.Target == target {
			return s
		}
	}
	t.Fatalf("lần chạy không có bước %s@%s", id, target)
	return RunStep{}
}

func readRun(t *testing.T, dir, id string) OptimizeRun {
	t.Helper()
	var run OptimizeRun
	if err := json.Unmarshal([]byte(readFile(t, filepath.Join(dir, "runs", id+".json"))), &run); err != nil {
		t.Fatal(err)
	}
	return run
}

func intPtr(v int) *int { return &v }

func contains(s, sub string) bool { return strings.Contains(s, sub) }
