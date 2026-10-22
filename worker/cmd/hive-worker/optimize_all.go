package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/ctxsync"
	"github.com/tdduydev/xdev-hive/worker/internal/gitexclude"
	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizeall"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

const optimizeAllUsage = "Cách dùng: hive-worker optimize all <--preview [--policy-file FILE] | --apply --plan-file FILE | --undo --run ID | --last> [--config FILE] [--json]"

// Thời hạn như app desktop (token_score.rs): stdin đã đóng nên lệnh hỏi lại sẽ treo tới hết hạn thay vì mãi mãi.
const (
	optimizeAllMCPTimeout  = time.Minute
	optimizeAllInitTimeout = 10 * time.Minute
)

// optimizeAllExec chạy lệnh codegraph và `claude|codex mcp`; test thay bằng hàm giả để không cần CLI thật.
var optimizeAllExec = func(ctx context.Context, dir string, env, argv []string) error {
	cmd := procattr.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), env...)
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if len(msg) > 400 {
		msg = "…" + msg[len(msg)-400:]
	}
	if msg == "" {
		return fmt.Errorf("%s: %w", strings.Join(argv[:min(len(argv), 3)], " "), err)
	}
	return fmt.Errorf("%s: %w: %s", strings.Join(argv[:min(len(argv), 3)], " "), err, msg)
}

// Như codegraphEnv của runner: tắt telemetry và daemon nền cho cả lệnh init lẫn server MCP mà CLI chạy về sau.
var optimizeAllGraphEnv = []string{"CODEGRAPH_NO_DAEMON=1", "CODEGRAPH_TELEMETRY=0", "DO_NOT_TRACK=1"}

const (
	optimizeAllInvalid = "INVALID_INPUT"
	optimizeAllFailed  = "FAILED"
)

// optimizeAllCommand là nút "Tối ưu" của màn Token (spec 029 US2): xem trước, áp dụng, hoàn tác và xem lần gần nhất.
func optimizeAllCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("optimize all", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	configPath := fs.String("config", "", "file cấu hình worker (accounts.json, projects.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	preview := fs.Bool("preview", false, "dựng kế hoạch, không ghi gì")
	apply := fs.Bool("apply", false, "chạy các bước đã chọn trong --plan-file")
	undo := fs.Bool("undo", false, "hoàn tác lần tối ưu --run")
	last := fs.Bool("last", false, "in lần tối ưu gần nhất")
	policyFile := fs.String("policy-file", "", "preview: { [projectId]: DevOptimizerPolicy }")
	planFile := fs.String("plan-file", "", "apply: OptimizePlan đã chọn")
	runID := fs.String("run", "", "undo: id lần tối ưu")
	parseErr := fs.Parse(args)

	// Tham số hỏng vẫn phải báo bằng JSON khi app đã xin --json, nên dò cờ từ args thay vì từ kết quả parse.
	wantJSON := *asJSON
	for _, a := range args {
		if a == "--json" || a == "-json" {
			wantJSON = true
		}
	}
	fail := func(code string, exit int, err error) int {
		var oe *optimizeall.Error
		if errors.As(err, &oe) {
			code, exit = oe.Code, 1
		}
		if wantJSON {
			_ = json.NewEncoder(stdout).Encode(map[string]any{"error": map[string]string{"code": code, "message": err.Error()}})
		} else {
			fmt.Fprintln(stderr, err)
		}
		return exit
	}
	invalid := func(format string, a ...any) int {
		return fail(optimizeAllInvalid, 2, fmt.Errorf(format, a...))
	}
	if parseErr != nil {
		return invalid("Tham số không hợp lệ: %v. %s", parseErr, optimizeAllUsage)
	}
	if fs.NArg() > 0 {
		return invalid("Thừa tham số %q. %s", fs.Arg(0), optimizeAllUsage)
	}
	actions := 0
	for _, on := range []bool{*preview, *apply, *undo, *last} {
		if on {
			actions++
		}
	}
	if actions != 1 {
		return invalid("Chọn đúng một trong --preview, --apply, --undo, --last. %s", optimizeAllUsage)
	}
	switch {
	case *apply && *planFile == "":
		return invalid("Thiếu --plan-file. %s", optimizeAllUsage)
	case *undo && *runID == "":
		return invalid("Thiếu --run. %s", optimizeAllUsage)
	}

	home, err := optimizeHome()
	if err != nil {
		return fail(optimizeAllFailed, 1, err)
	}
	ctxHome, err := contextHome()
	if err != nil {
		return fail(optimizeAllFailed, 1, err)
	}
	cfg, err := pathOr(*configPath)
	if err != nil {
		return fail(optimizeAllFailed, 1, err)
	}
	o := optimizer.New(home)
	o.Now = optimizeNow
	env := &optimizeAllEnv{o: o, file: accounts.DefaultPath(cfg), projectsFile: projects.DefaultPath(cfg),
		dir: filepath.Dir(o.StatePath()), windows: map[string]*int{}, stderr: stderr}
	// Cùng memstore với `hive-worker context`: hoàn tác bước ngữ cảnh là khôi phục mục memstore mà ctxsync đã ghi.
	store := memstore.Store{Dir: filepath.Join(ctxHome, ".xdev-hive", "optimizer")}
	scorer := &optimizeAllScorer{env: env, record: !*preview}
	r := &optimizeall.Runner{
		Dir:       env.dir,
		Optimizer: o,
		Store:     store,
		Machine:   func() (optimizeall.Machine, error) { return env.machine(*preview) },
		Enabler:   optimizeAllEnabler{o},
		Fixer:     optimizeAllFixer{env},
		Context: optimizeAllContext{env: env, m: ctxsync.Manager{
			Root: filepath.Join(ctxHome, ".xdev-hive", "context"), Store: store, Installed: contextHasCLI,
		}},
		Scorer: scorer,
		Now:    optimizeNow,
	}

	var out any
	switch {
	case *preview:
		policies := map[string]optimizeall.Policy{}
		if *policyFile != "" {
			data, err := os.ReadFile(*policyFile)
			if err != nil {
				return fail(optimizeAllInvalid, 1, fmt.Errorf("Không đọc được file chính sách: %w", err))
			}
			if policies, err = optimizeall.ParsePolicies(data); err != nil {
				return fail(optimizeAllInvalid, 1, err)
			}
			// Mức sai là lỗi của file đầu vào, báo trước khi giữ khoá và đọc máy.
			if _, err := optimizeall.Merge(policies); err != nil {
				return fail(optimizeAllInvalid, 1, err)
			}
		}
		plan, err := r.Plan(policies)
		if err != nil {
			return fail(optimizeAllFailed, 1, err)
		}
		out = plan
	case *apply:
		data, err := os.ReadFile(*planFile)
		if err != nil {
			return fail(optimizeall.CodeInvalidPlan, 1, fmt.Errorf("Không đọc được file kế hoạch: %w", err))
		}
		var plan optimizeall.OptimizePlan
		if err := json.Unmarshal(data, &plan); err != nil {
			return fail(optimizeall.CodeInvalidPlan, 1, fmt.Errorf("File kế hoạch không đúng định dạng: %w", err))
		}
		// Trần nén theo chính sách đi cùng bước bật tối ưu; sửa nhanh bật lại gói sau bước đó phải giữ nó.
		for _, s := range plan.Steps {
			if s.ID == optimizeall.StepOptimizerEnable && s.Selected && s.AutoCompactWindow != nil {
				env.windows[s.Target] = s.AutoCompactWindow
			}
		}
		// Kế hoạch thiếu điểm trước thì Runner chấm trước khi chạy; điểm đó không ghi lịch sử, vì lịch sử giữ một dòng
		// mỗi ngày và dòng ấy phải là điểm sau.
		if plan.ScoreBefore == nil {
			scorer.skip = 1
		}
		run, err := r.Apply(plan)
		if err != nil {
			return fail(optimizeAllFailed, 1, err)
		}
		out = run
	case *undo:
		run, err := r.Undo(*runID)
		if err != nil {
			return fail(optimizeAllFailed, 1, err)
		}
		out = run
	case *last:
		run, err := r.Last()
		if err != nil {
			return fail(optimizeAllFailed, 1, err)
		}
		out = run
	}
	if *asJSON {
		return printJSON(stdout, stderr, out)
	}
	printOptimizeAll(stdout, out)
	return 0
}

func printOptimizeAll(w io.Writer, v any) {
	mark := map[bool]string{true: "[x]", false: "[ ]"}
	switch x := v.(type) {
	case optimizeall.OptimizePlan:
		for _, s := range x.Steps {
			fmt.Fprintf(w, "%s %s (%s)\n", mark[s.Selected], s.Title, s.Reason)
		}
	case *optimizeall.OptimizeRun:
		if x == nil {
			fmt.Fprintln(w, "Chưa có lần tối ưu nào.")
			return
		}
		fmt.Fprintf(w, "Lần tối ưu %s\n", x.ID)
		for _, s := range x.Steps {
			line := fmt.Sprintf("  %-8s %s", s.Status, s.Title)
			if s.Error != nil {
				line += ": " + *s.Error
			}
			fmt.Fprintln(w, line)
		}
	}
}

// optimizeAllEnv là phần máy mà Runner nhận qua giao diện: accounts.json, projects.json, điểm 025, ngăn xếp sửa nhanh.
type optimizeAllEnv struct {
	o            *optimizer.Optimizer
	file         string
	projectsFile string
	dir          string
	windows      map[string]*int
	stderr       io.Writer

	scored    bool
	result    *score.Result
	resultErr error
}

// compute chấm điểm như `optimize score` nhưng không gửi lên hub. Xem trước dùng một lần cho cả gợi ý lẫn điểm trước.
func (e *optimizeAllEnv) compute(fresh bool) (*score.Result, error) {
	if e.scored && !fresh {
		return e.result, e.resultErr
	}
	e.scored = true
	e.result, e.resultErr = func() (*score.Result, error) {
		view, err := optimizeStatus(e.o, e.file)
		if err != nil {
			return nil, err
		}
		profiles := scoreProfiles(e.o, view)
		var roots []tokenreport.Root
		for _, p := range profiles {
			if p.CLI == "claude" || p.CLI == "codex" {
				roots = append(roots, tokenreport.Root{Account: p.ID, CLI: p.CLI, Dir: p.Dir})
			}
		}
		ctx := context.Background()
		now := optimizeNow()
		var sessions []tokenreport.SessionSummary
		if len(roots) > 0 {
			opts := tokenreport.Options{Home: e.o.Home, Days: scoreDays, Now: optimizeNow, Roots: roots, NoRTK: true}
			if sessions, err = tokenreport.Sessions(ctx, opts); err != nil {
				return nil, err
			}
		}
		return score.Compute(score.Inputs{
			Home: e.o.Home, GOOS: optimizeGOOS(), Now: now, Days: scoreDays, Profiles: profiles, Sessions: sessions,
			Context: score.LoadContexts(ctx, e.dir, profiles, optimizeContext, now, nil), HasTool: optimizeHasTool,
		}), nil
	}()
	return e.result, e.resultErr
}

func (e *optimizeAllEnv) linked() ([]projects.Project, error) {
	list, err := projects.Load(e.projectsFile)
	if err != nil {
		return nil, err
	}
	out := list[:0]
	for _, p := range list {
		if p.ProjectID != "" && p.Folder != "" {
			out = append(out, p)
		}
	}
	return out, nil
}

// machine: gói Claude, Codex trên máy và dự án đã gắn. Gợi ý sửa nhanh chỉ cần lúc xem trước: áp dụng chạy đúng bước
// trong kế hoạch, nên không chấm điểm lại ở đó.
func (e *optimizeAllEnv) machine(withFixes bool) (optimizeall.Machine, error) {
	var m optimizeall.Machine
	view, err := optimizeStatus(e.o, e.file)
	if err != nil {
		return m, err
	}
	rows := map[string]optimizeProfile{}
	for _, r := range view.Profiles {
		rows[r.ID] = r
	}
	for _, sp := range scoreProfiles(e.o, view) {
		if sp.CLI != "claude" && sp.CLI != "codex" {
			continue
		}
		row, ok := rows[sp.ID]
		// Gói chỉ còn trong manifest (đã gỡ khỏi accounts.json) không được bật lại; thư mục mặc định thì vẫn có thật.
		if ok && !row.InAccounts && !row.Default {
			continue
		}
		p, err := e.o.Profile(sp.ID, sp.CLI, sp.Dir)
		if err != nil {
			continue
		}
		m.Profiles = append(m.Profiles, optimizeall.ProfileInfo{Profile: p, Label: firstOf(row.Label, sp.Label), RTK: row.RTK})
	}
	linked, err := e.linked()
	if err != nil {
		return m, err
	}
	for _, p := range linked {
		m.Projects = append(m.Projects, optimizeall.Project{ID: p.ProjectID, Name: p.Name, Folder: p.Folder})
	}
	m.RTKSupported = optimizeGOOS() != "windows" && optimizeFindRTK() != ""
	if !withFixes {
		return m, nil
	}
	// Không chấm được điểm thì vẫn xem trước được phần theo chính sách, chỉ thiếu gợi ý của điểm.
	if res, err := e.compute(false); err == nil && res != nil {
		m.Fixes = optimizeAllFixes(e.o.Home, res, linked)
	}
	return m, nil
}

// optimizeAllFixes đổi gợi ý của điểm sang FixSuggestion. tool.* và codegraph.init không theo gói: cài công cụ hay lập
// chỉ mục một lần cho cả máy, nên gộp gợi ý của mọi gói thành một bước.
func optimizeAllFixes(home string, res *score.Result, linked []projects.Project) []optimizeall.FixSuggestion {
	var out []optimizeall.FixSuggestion
	seen := map[string]bool{}
	add := func(s optimizeall.FixSuggestion) {
		key := s.ID + "@" + s.Profile + "@" + s.Project
		if !seen[key] {
			seen[key] = true
			out = append(out, s)
		}
	}
	for _, ps := range res.Profiles {
		for _, c := range ps.Criteria {
			for _, fix := range c.Fixes {
				switch {
				case strings.HasPrefix(fix, "tool."):
					add(optimizeall.FixSuggestion{ID: fix})
				case fix == score.FixGraphInit:
					for _, pr := range ps.Projects {
						if pr.Codegraph {
							continue
						}
						dir := filepath.FromSlash(pr.Path)
						if rest, ok := strings.CutPrefix(pr.Path, "~/"); ok {
							dir = filepath.Join(home, filepath.FromSlash(rest))
						}
						for _, p := range linked {
							if optimizeSamePath(dir, p.Folder) {
								add(optimizeall.FixSuggestion{ID: fix, Project: p.ProjectID})
							}
						}
					}
				default:
					add(optimizeall.FixSuggestion{ID: fix, Profile: ps.ID})
				}
			}
		}
	}
	return out
}

func optimizeSamePath(a, b string) bool {
	clean := func(p string) string {
		p = filepath.Clean(p)
		if r, err := filepath.EvalSymlinks(p); err == nil {
			p = r
		}
		return p
	}
	a, b = clean(a), clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}

func firstOf(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// optimizeAllConfigFile là file optimizer ghi cho gói, như configPath của optimizeall.
func optimizeAllConfigFile(p optimizer.Profile) string {
	if p.CLI == "codex" {
		return filepath.Join(p.Dir, "config.toml")
	}
	return filepath.Join(p.Dir, "settings.json")
}

type optimizeAllEnabler struct{ o *optimizer.Optimizer }

func (a optimizeAllEnabler) Enable(p optimizer.Profile, req optimizeall.EnableRequest) (*optimizer.Result, error) {
	return optimizeEnableWith(a.o, p, req.Level, req.RTK, req.AutoCompactWindow)
}

type optimizeAllScorer struct {
	env    *optimizeAllEnv
	record bool
	// skip là số lần chấm đầu không ghi lịch sử.
	skip int
}

// Score: điểm sau của lần áp dụng được ghi lịch sử như `optimize score`, để mốc sửa nhanh vừa chạy lên biểu đồ.
func (s *optimizeAllScorer) Score() (*float64, error) {
	res, err := s.env.compute(s.record)
	if err != nil || res == nil {
		return nil, err
	}
	if s.skip > 0 {
		s.skip--
	} else if s.record {
		if _, err := score.Record(s.env.dir, res, optimizeNow(), fixQueue{s.env.dir}); err != nil {
			fmt.Fprintln(s.env.stderr, "không ghi được lịch sử điểm:", err)
		}
	}
	return res.Machine.Score, nil
}

// optimizeAllFixRecord là bản ghi hoàn tác của một sửa nhanh trong chuỗi. Sửa nhanh optimizer.* dùng chung ngăn xếp
// score-fixes với `optimize fix`, nên lệnh lẻ và nút "Tối ưu" không đảo chồng lên nhau.
type optimizeAllFixRecord struct {
	FixID   string     `json:"fixId"`
	Profile string     `json:"profile,omitempty"`
	CLI     string     `json:"cli,omitempty"`
	Dir     string     `json:"dir,omitempty"`
	Default bool       `json:"default,omitempty"`
	Stack   *fixRecord `json:"stack,omitempty"`
	// Window là trần nén mà gói có trước sửa nhanh (bước bật tối ưu cùng chuỗi đã đặt), để hoàn tác bật lại đúng nó.
	Window       *int   `json:"autoCompactWindow,omitempty"`
	Project      string `json:"project,omitempty"`
	Folder       string `json:"folder,omitempty"`
	ExcludeAdded bool   `json:"excludeAdded,omitempty"`
}

func (r optimizeAllFixRecord) profile() optimizer.Profile {
	return optimizer.Profile{ID: r.Profile, CLI: r.CLI, Dir: r.Dir, Default: r.Default}
}

// optimizeAllFixer chạy sửa nhanh của điểm 025 trong sidecar: optimizer.* ghi cấu hình gói, codegraph.* chạy lệnh
// codegraph và `mcp add`. Hợp đồng chỉ để tool.* (cài công cụ) cho app.
type optimizeAllFixer struct{ env *optimizeAllEnv }

func (f optimizeAllFixer) Apply(req optimizeall.FixRequest) (optimizeall.FixOutcome, error) {
	e := f.env
	var rec optimizeAllFixRecord
	var files []string
	switch req.FixID {
	case score.FixBalanced, score.FixRTK, score.FixAggressive:
		p, row, err := e.profileRow(req.Profile)
		if err != nil {
			return optimizeall.FixOutcome{}, err
		}
		level, withRTK, err := fixTarget(req.FixID, p, row)
		if err != nil {
			return optimizeall.FixOutcome{}, err
		}
		stack := fixRecord{FixID: req.FixID, PrevEnabled: row.Enabled, PrevLevel: row.Level, PrevRTK: row.RTK,
			At: optimizeNow().UTC()}
		// Ghi bản ghi trước khi đổi cấu hình như `optimize fix`: tiến trình chết giữa chừng vẫn còn đường hoàn tác.
		if err := withFixes(e.dir, func(st *fixState) error {
			st.Stacks[p.ID] = append(st.Stacks[p.ID], stack)
			return nil
		}); err != nil {
			return optimizeall.FixOutcome{}, err
		}
		window := e.windows[p.ID]
		if _, err := optimizeEnableWith(e.o, p, level, withRTK, window); err != nil {
			_ = withFixes(e.dir, func(st *fixState) error {
				popFix(st, p.ID, stack)
				return nil
			})
			return optimizeall.FixOutcome{}, err
		}
		rec = optimizeAllFixRecord{FixID: req.FixID, Profile: p.ID, CLI: p.CLI, Dir: p.Dir, Default: p.Default,
			Stack: &stack, Window: window}
		files = []string{optimizeAllConfigFile(p)}
	case score.FixGraphMCP:
		p, _, err := e.profileRow(req.Profile)
		if err != nil {
			return optimizeall.FixOutcome{}, err
		}
		argv, err := optimizeAllMCPAdd(p.CLI)
		if err != nil {
			return optimizeall.FixOutcome{}, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), optimizeAllMCPTimeout)
		defer cancel()
		if err := optimizeAllExec(ctx, "", append(optimizeAllProfileEnv(p), optimizeAllGraphEnv...), argv); err != nil {
			return optimizeall.FixOutcome{}, err
		}
		rec = optimizeAllFixRecord{FixID: req.FixID, Profile: p.ID, CLI: p.CLI, Dir: p.Dir, Default: p.Default}
		// Codex ghi MCP vào config.toml, file bước bật tối ưu cũng ghi: thiếu nó thì hoàn tác tưởng file bị sửa tay.
		// .claude.json thì không theo dõi vì Claude ghi lại nó mỗi lần chạy, sẽ chặn hoàn tác mọi lúc.
		if p.CLI == "codex" {
			files = []string{optimizeAllConfigFile(p)}
		}
	case score.FixGraphInit:
		folder, err := e.projectFolder(req.Project)
		if err != nil {
			return optimizeall.FixOutcome{}, err
		}
		ctx, cancel := context.WithTimeout(context.Background(), optimizeAllInitTimeout)
		defer cancel()
		if err := optimizeAllExec(ctx, folder, optimizeAllGraphEnv, []string{"codegraph", "init", "-y", folder}); err != nil {
			return optimizeall.FixOutcome{}, err
		}
		// Chỉ mục là dữ liệu máy, không được lọt vào commit của dự án.
		added, _ := gitexclude.Add(folder, ".codegraph")
		rec = optimizeAllFixRecord{FixID: req.FixID, Project: req.Project, Folder: folder, ExcludeAdded: added}
	default:
		return optimizeall.FixOutcome{}, fmt.Errorf("sửa nhanh %q không chạy được trong chuỗi tối ưu", req.FixID)
	}
	if err := addMarks(e.dir, score.FixMark{ID: req.FixID, Action: score.MarkApply}); err != nil {
		fmt.Fprintln(e.stderr, "không ghi được mốc sửa nhanh:", err)
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return optimizeall.FixOutcome{}, err
	}
	return optimizeall.FixOutcome{Record: data, Files: files}, nil
}

func (f optimizeAllFixer) Undo(req optimizeall.FixRequest, record json.RawMessage) error {
	e := f.env
	var rec optimizeAllFixRecord
	if err := json.Unmarshal(record, &rec); err != nil {
		return fmt.Errorf("bản ghi hoàn tác hỏng: %w", err)
	}
	switch req.FixID {
	case score.FixBalanced, score.FixRTK, score.FixAggressive:
		if rec.Stack == nil {
			return errors.New("bản ghi hoàn tác thiếu ngăn xếp sửa nhanh")
		}
		p := rec.profile()
		err := withFixes(e.dir, func(st *fixState) error {
			stack := st.Stacks[p.ID]
			if len(stack) == 0 || !sameFixRecord(stack[len(stack)-1], *rec.Stack) {
				return fmt.Errorf("gói %s đã có sửa nhanh khác sau lần tối ưu này; hãy hoàn tác nó trước", p.ID)
			}
			return nil
		})
		if err != nil {
			return err
		}
		if rec.Stack.PrevEnabled {
			_, err = optimizeEnableWith(e.o, p, rec.Stack.PrevLevel, rec.Stack.PrevRTK, rec.Window)
		} else {
			_, err = e.o.Disable(p)
		}
		if err != nil {
			return err
		}
		if err := withFixes(e.dir, func(st *fixState) error {
			popFix(st, p.ID, *rec.Stack)
			return nil
		}); err != nil {
			return err
		}
	case score.FixGraphMCP:
		argv, err := optimizeAllMCPRemove(rec.CLI)
		if err != nil {
			return err
		}
		ctx, cancel := context.WithTimeout(context.Background(), optimizeAllMCPTimeout)
		defer cancel()
		if err := optimizeAllExec(ctx, "", optimizeAllProfileEnv(rec.profile()), argv); err != nil {
			return err
		}
	case score.FixGraphInit:
		if rec.Folder == "" {
			return errors.New("bản ghi hoàn tác thiếu thư mục dự án")
		}
		ctx, cancel := context.WithTimeout(context.Background(), optimizeAllInitTimeout)
		defer cancel()
		if err := optimizeAllExec(ctx, rec.Folder, optimizeAllGraphEnv, []string{"codegraph", "uninit", "-f", rec.Folder}); err != nil {
			return err
		}
		// Chỉ gỡ dòng exclude do lần này thêm; dòng người dùng tự thêm từ trước giữ nguyên.
		if rec.ExcludeAdded {
			if warn := gitexclude.Remove(rec.Folder, gitexclude.Line(".codegraph")); warn != "" {
				fmt.Fprintln(e.stderr, warn)
			}
		}
	default:
		return fmt.Errorf("không biết cách hoàn tác sửa nhanh %q", req.FixID)
	}
	if err := addMarks(e.dir, score.FixMark{ID: req.FixID, Action: score.MarkUndo}); err != nil {
		fmt.Fprintln(e.stderr, "không ghi được mốc hoàn tác sửa nhanh:", err)
	}
	return nil
}

func popFix(st *fixState, profile string, rec fixRecord) {
	if stack := st.Stacks[profile]; len(stack) > 0 && sameFixRecord(stack[len(stack)-1], rec) {
		st.Stacks[profile] = stack[:len(stack)-1]
	}
}

// sameFixRecord so At bằng Equal: bản ghi trong nhật ký và trong score-fixes.json đi qua JSON khác lần nhau.
func sameFixRecord(a, b fixRecord) bool {
	return a.FixID == b.FixID && a.PrevEnabled == b.PrevEnabled && a.PrevLevel == b.PrevLevel && a.PrevRTK == b.PrevRTK &&
		a.At.Equal(b.At)
}

func (e *optimizeAllEnv) profileRow(id string) (optimizer.Profile, optimizeProfile, error) {
	p, err := optimizeResolve(e.o, e.file, id)
	if err != nil {
		return p, optimizeProfile{}, err
	}
	view, err := optimizeStatus(e.o, e.file)
	if err != nil {
		return p, optimizeProfile{}, err
	}
	for _, r := range view.Profiles {
		if r.ID == p.ID {
			return p, r, nil
		}
	}
	return p, optimizeProfile{ID: p.ID, CLI: p.CLI, ConfigDir: p.Dir, Default: p.Default}, nil
}

func (e *optimizeAllEnv) projectFolder(projectID string) (string, error) {
	linked, err := e.linked()
	if err != nil {
		return "", err
	}
	if p := projects.Find(linked, projectID); p != nil {
		return p.Folder, nil
	}
	return "", fmt.Errorf("dự án %s chưa gắn với thư mục nào trên máy này", projectID)
}

// optimizeAllProfileEnv trỏ lệnh `mcp` của CLI vào đúng gói. Gói mặc định không đặt gì: CLI tự dùng thư mục của nó.
func optimizeAllProfileEnv(p optimizer.Profile) []string {
	if p.Default || p.Dir == "" {
		return nil
	}
	switch p.CLI {
	case "claude":
		return []string{"CLAUDE_CONFIG_DIR=" + p.Dir}
	case "codex":
		return []string{"CODEX_HOME=" + p.Dir}
	}
	return nil
}

// optimizeAllMCPAdd giống mcp_add của app desktop: server chạy về sau cũng tắt telemetry nhờ --env trong cấu hình.
func optimizeAllMCPAdd(cli string) ([]string, error) {
	var argv []string
	switch cli {
	case "claude":
		argv = []string{"claude", "mcp", "add", "--scope", "user", "codegraph"}
	case "codex":
		argv = []string{"codex", "mcp", "add", "codegraph"}
	default:
		return nil, fmt.Errorf("CLI %s chưa hỗ trợ thêm MCP", cli)
	}
	for _, kv := range []string{"CODEGRAPH_TELEMETRY=0", "DO_NOT_TRACK=1", "CODEGRAPH_NO_DAEMON=1"} {
		argv = append(argv, "--env", kv)
	}
	argv = append(argv, "--")
	// Windows cài codegraph qua npm thành codegraph.cmd, CLI không tự chạy được file .cmd nên đi qua cmd /c.
	if optimizeGOOS() == "windows" {
		return append(argv, "cmd", "/c", "codegraph.cmd", "serve", "--mcp"), nil
	}
	return append(argv, "codegraph", "serve", "--mcp"), nil
}

func optimizeAllMCPRemove(cli string) ([]string, error) {
	switch cli {
	case "claude":
		return []string{"claude", "mcp", "remove", "-s", "user", "codegraph"}, nil
	case "codex":
		return []string{"codex", "mcp", "remove", "codegraph"}, nil
	}
	return nil, fmt.Errorf("CLI %s chưa hỗ trợ gỡ MCP", cli)
}

// optimizeAllContext nối bước context.sync vào ctxsync. Runner đã giữ optimize.lock nên gọi thẳng Manager, không qua
// `context sync` (lệnh đó cũng lấy khoá này).
type optimizeAllContext struct {
	env *optimizeAllEnv
	m   ctxsync.Manager
}

func (c optimizeAllContext) Enabled() ([]optimizeall.ContextProject, error) {
	list, err := c.m.Status("")
	if err != nil {
		return nil, err
	}
	names := map[string]string{}
	if linked, err := c.env.linked(); err == nil {
		for _, p := range linked {
			names[p.ProjectID] = p.Name
		}
	}
	var out []optimizeall.ContextProject
	for _, p := range list {
		if !p.Enabled {
			continue
		}
		cp := optimizeall.ContextProject{Key: p.Key}
		if p.ProjectID != nil {
			cp.ProjectID = *p.ProjectID
		}
		cp.Name = firstOf(names[cp.ProjectID], filepath.Base(p.Folder))
		for _, t := range p.Targets {
			if t.Status == ctxsync.StatusStale {
				cp.Files = append(cp.Files, filepath.Join(p.Folder, filepath.FromSlash(t.Path)))
			}
		}
		out = append(out, cp)
	}
	return out, nil
}

// Sync dùng bản hub đã lưu từ lần `context sync` trước: kéo hub cần PAT của app desktop, sidecar không có.
func (c optimizeAllContext) Sync(key string) (string, error) {
	_, entry, err := c.m.Sync(key, nil, nil)
	return entry, err
}
