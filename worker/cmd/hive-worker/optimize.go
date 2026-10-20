package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

const optimizeUsage = "Cách dùng: hive-worker optimize [status | enable --profile ID [--level balanced|aggressive] [--rtk] | disable --profile ID | restore --profile ID [--backup THỜI_ĐIỂM] | link | report [--profile ID] [--days N] | score [--days N] [--fresh] | score history [--days N | --last] | score mark --fix MÃ --action apply|undo | fix MÃ --profile ID [--preview | --undo]] [--config FILE] [--json]"

// Test thay thư mục nhà, giờ, phiên bản CLI, RTK, /context và công cụ trên PATH để không đụng máy thật.
var (
	optimizeHome          = os.UserHomeDir
	optimizeExecutable    = os.Executable
	optimizeNow           = time.Now
	optimizeClaudeVersion = runner.DetectClaudeVersion
	optimizeFindRTK       = func() string { p, _ := exec.LookPath("rtk"); return p }
	// optimizeReportRTK nil là chạy `rtk gain` thật.
	optimizeReportRTK tokenreport.RTKFunc
	optimizeContext   score.ContextRunner = func(ctx context.Context, p score.Profile) ([]byte, error) {
		dir := p.Dir
		if p.Default {
			dir = ""
		}
		return accounts.ClaudePrint(ctx, "", dir, []string{"-p", "/context", "--no-session-persistence"})
	}
	optimizeHasTool = func(name string) bool { _, err := exec.LookPath(name); return err == nil }
	// optimizeGOOS cho test giả Windows ở các nhánh chỉ kiểm hệ điều hành, không chạy lệnh.
	optimizeGOOS = func() string { return runtime.GOOS }
)

// optimizeProfile là một gói trong kết quả `optimize status --json`. Gói nào cũng có mặt, bật hay chưa, để màn Token
// vẽ một bảng duy nhất.
type optimizeProfile struct {
	ID        string `json:"id"`
	Label     string `json:"label,omitempty"`
	CLI       string `json:"cli"`
	ConfigDir string `json:"configDir"`
	Default   bool   `json:"default,omitempty"`
	// Supported false: CLI chưa có preset (Gemini, Antigravity); Reason nói vì sao.
	Supported bool   `json:"supported"`
	Reason    string `json:"reason,omitempty"`
	// Version là phiên bản Claude Code phát hiện được; rỗng với CLI khác hoặc khi không đọc được.
	Version string `json:"version,omitempty"`
	Enabled bool   `json:"enabled"`
	Level   string `json:"level,omitempty"`
	// InAccounts false: gói còn trong manifest nhưng accounts.json không còn nó.
	InAccounts bool       `json:"inAccounts"`
	EnabledAt  *time.Time `json:"enabledAt,omitempty"`
	UpdatedAt  *time.Time `json:"updatedAt,omitempty"`
	// Modified: file cấu hình đã đổi từ lần Hive ghi cuối (người dùng hay CLI sửa).
	Modified bool `json:"modified,omitempty"`
	// Keys là các khoá Hive đã thêm (env.X, hooks.PostToolUse, codex.X).
	Keys    []string         `json:"keys,omitempty"`
	RTK     bool             `json:"rtk,omitempty"`
	Skipped []optimizer.Skip `json:"skipped,omitempty"`
	Backups []string         `json:"backups,omitempty"`
}

type optimizeView struct {
	StatePath string `json:"statePath"`
	LinkPath  string `json:"linkPath"`
	// Result có sau enable, disable, restore.
	Result   *optimizer.Result `json:"result,omitempty"`
	Profiles []optimizeProfile `json:"profiles"`
}

func optimizeCommand(args []string, stdout, stderr io.Writer) int {
	action := "status"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	// `fix MÃ --profile …`: flag dừng ở đối số không phải cờ đầu tiên, nên lấy mã sửa nhanh ra trước.
	fixID := ""
	if action == "fix" && len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		fixID, args = args[0], args[1:]
	}
	// `score history` và `score mark` là lệnh con của score.
	scoreAction := ""
	if action == "score" && len(args) > 0 && (args[0] == "history" || args[0] == "mark") {
		scoreAction, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("optimize "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình worker (accounts.json nằm cạnh)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	profile := fs.String("profile", "", "id gói (trong accounts.json, hoặc claude/codex cho thư mục mặc định)")
	level := fs.String("level", runner.PresetBalanced, "mức tối ưu: balanced hoặc aggressive")
	withRTK := fs.Bool("rtk", false, "enable: thêm hook RTK nén output lệnh Bash (cần rtk trên máy)")
	backup := fs.String("backup", "", "restore: thời điểm bản sao lưu (mặc định bản trước lần bật đầu)")
	days := fs.Int("days", 0, "report: chỉ đọc phiên N ngày gần nhất (0 là tất cả); score: mặc định 7")
	fresh := fs.Bool("fresh", false, "score: đo lại /context của mọi gói Claude (gọi model, tốn token)")
	preview := fs.Bool("preview", false, "fix: chỉ liệt kê thay đổi, không ghi gì")
	undo := fs.Bool("undo", false, "fix: hoàn tác lần sửa nhanh gần nhất của gói")
	last := fs.Bool("last", false, "score history: chỉ dòng lịch sử sau cùng")
	markFix := fs.String("fix", "", "score mark: mã sửa nhanh app desktop đã chạy")
	markAction := fs.String("action", "", "score mark: apply hoặc undo")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	home, err := optimizeHome()
	if err != nil {
		return fail(err)
	}
	cfg, err := pathOr(*configPath)
	if err != nil {
		return fail(err)
	}
	o := optimizer.New(home)
	o.Now = optimizeNow
	file := accounts.DefaultPath(cfg)
	needProfile := func() bool {
		if *profile == "" {
			fmt.Fprintln(stderr, optimizeUsage)
			return false
		}
		return true
	}

	var result *optimizer.Result
	switch action {
	case "status":
	case "enable":
		if !needProfile() {
			return 2
		}
		p, err := optimizeResolve(o, file, *profile)
		if err != nil {
			return fail(err)
		}
		if result, err = optimizeEnable(o, p, *level, *withRTK); err != nil {
			return fail(err)
		}
	case "disable":
		if !needProfile() {
			return 2
		}
		p, err := optimizeResolve(o, file, *profile)
		if err != nil {
			return fail(err)
		}
		if result, err = o.Disable(p); err != nil {
			return fail(err)
		}
	case "restore":
		if !needProfile() {
			return 2
		}
		p, err := optimizeResolve(o, file, *profile)
		if err != nil {
			return fail(err)
		}
		if result, err = o.Restore(p, *backup); err != nil {
			return fail(err)
		}
		if err := restoreMarks(filepath.Dir(o.StatePath()), p.ID); err != nil {
			fmt.Fprintln(stderr, "không ghi được mốc hoàn tác sửa nhanh:", err)
		}
	case "link":
		path, err := optimizeLink(o)
		if err != nil {
			return fail(fmt.Errorf("không đặt được liên kết hive-worker: %w", err))
		}
		if *asJSON {
			return printJSON(stdout, stderr, map[string]string{"path": path})
		}
		fmt.Fprintf(stdout, "Đã đặt liên kết hive-worker tại %s\n", path)
		return 0
	case "report":
		return optimizeReport(o, file, *profile, *days, *asJSON, stdout, stderr)
	case "score":
		switch scoreAction {
		case "history":
			return optimizeScoreHistory(o, *days, *last, stdout, stderr)
		case "mark":
			return optimizeScoreMark(o, *markFix, *markAction, stdout, stderr)
		}
		return optimizeScore(o, file, *days, *fresh, *profile, *asJSON, stdout, stderr)
	case "fix":
		if fixID == "" {
			fmt.Fprintln(stderr, optimizeUsage)
			return 2
		}
		if !needProfile() {
			return 2
		}
		return optimizeFix(o, file, fixID, *profile, *preview, *undo, stdout, stderr)
	default:
		fmt.Fprintln(stderr, optimizeUsage)
		return 2
	}

	view, err := optimizeStatus(o, file)
	if err != nil {
		return fail(err)
	}
	view.Result = result
	if *asJSON {
		return printJSON(stdout, stderr, view)
	}
	printOptimize(stdout, view)
	return 0
}

// optimizeEnable dựng preset theo phiên bản CLI và mức, thêm RTK nếu chọn, rồi ghi cấu hình gói. Dùng chung cho
// `enable` và sửa nhanh của điểm tối ưu.
func optimizeEnable(o *optimizer.Optimizer, p optimizer.Profile, level string, withRTK bool) (*optimizer.Result, error) {
	preset, err := optimizeBuildPreset(o, p, level, withRTK)
	if err != nil {
		return nil, err
	}
	if len(preset.Hooks) > 0 {
		// Hook gọi hive-worker qua đường dẫn ổn định, nên liên kết phải có trước khi cấu hình trỏ tới nó.
		if _, err := optimizeLink(o); err != nil {
			return nil, fmt.Errorf("không đặt được liên kết hive-worker: %w", err)
		}
	}
	// --profile là lựa chọn riêng của người dùng, nên thư mục mặc định cũng được bật.
	return o.Enable(p, level, preset, optimizer.Options{Explicit: true})
}

func optimizeBuildPreset(o *optimizer.Optimizer, p optimizer.Profile, level string, withRTK bool) (optimizer.Preset, error) {
	if level != runner.PresetBalanced && level != runner.PresetAggressive {
		return optimizer.Preset{}, optimizer.ErrInvalidLevel
	}
	version := ""
	if p.CLI == "claude" {
		version = optimizeClaudeVersion(context.Background())
	}
	preset := optimizePreset(o, runner.InteractivePreset(p.CLI, version, level))
	if withRTK {
		if p.CLI != "claude" {
			return optimizer.Preset{}, errors.New("RTK chỉ dùng được với Claude Code")
		}
		if err := optimizeAddRTK(&preset); err != nil {
			return optimizer.Preset{}, err
		}
	}
	return preset, nil
}

func optimizeLink(o *optimizer.Optimizer) (string, error) {
	src, err := optimizeExecutable()
	if err != nil {
		return "", err
	}
	// Khi gọi qua liên kết ổn định, hive vẫn phải lấy từ bundle thật cạnh worker.
	if real, err := filepath.EvalSymlinks(src); err == nil {
		src = real
	}
	name := "hive"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return o.Link(src, filepath.Join(filepath.Dir(src), name))
}

func printJSON(stdout, stderr io.Writer, v any) int {
	enc := json.NewEncoder(stdout)
	if err := enc.Encode(v); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// optimizeResolve tìm gói theo id: accounts.json trước, rồi tên CLI trần (thư mục mặc định), rồi manifest (gói đã xoá
// khỏi accounts.json mà cấu hình vẫn còn dấu vết của Hive, để người dùng tắt được).
func optimizeResolve(o *optimizer.Optimizer, file, id string) (optimizer.Profile, error) {
	list, err := accounts.Load(file)
	if err != nil {
		return optimizer.Profile{}, err
	}
	for _, a := range list {
		if a.ID == id && !a.Pending {
			return o.Profile(a.ID, a.CLI, a.ConfigDir)
		}
	}
	if id == "claude" || id == "codex" {
		return o.Profile(id, id, "")
	}
	st, err := o.Status()
	if err != nil {
		return optimizer.Profile{}, err
	}
	for _, s := range st {
		if s.ID == id {
			return o.Profile(id, s.CLI, s.ConfigDir)
		}
	}
	return optimizer.Profile{}, fmt.Errorf("không thấy gói %q trong accounts.json", id)
}

// optimizePreset đổi preset của runner sang dạng gói optimizer nhận (gói đó không import runner).
func optimizePreset(o *optimizer.Optimizer, rp runner.Preset) optimizer.Preset {
	p := optimizer.Preset{Env: rp.Env, Codex: rp.Codex, ShellHooks: !rp.HookExec}
	for _, name := range rp.Hooks {
		h, ok := runner.InteractiveHook(name)
		if !ok {
			continue
		}
		p.Hooks = append(p.Hooks, optimizer.Hook{Event: h.Event, Matcher: h.Matcher, Args: []string{"hook", h.Command, "--local"}})
	}
	for _, s := range rp.Skipped {
		reason := "cần Claude Code " + s.MinVersion + " trở lên"
		if s.MinVersion == "" {
			reason = "bị bỏ theo phiên bản CLI"
		}
		p.Skipped = append(p.Skipped, optimizer.Skip{Key: s.Key, Reason: reason})
	}
	return p
}

// rtkProbeInput là lệnh PreToolUse mẫu mà hook RTK phải viết lại. Hook hỏng chặn hoặc làm sai mọi lệnh Bash của người
// dùng, nên phải kiểm trước khi ghi vào cấu hình (cùng phép thử với runner/tools.go).
const rtkProbeInput = `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git status"}}`

func optimizeAddRTK(p *optimizer.Preset) error {
	// Windows: chưa kiểm Claude Code chạy lệnh hook qua shell nào, như run của worker.
	if runtime.GOOS == "windows" {
		return errors.New("RTK chưa hỗ trợ trên Windows")
	}
	path := optimizeFindRTK()
	if path == "" {
		return errors.New("không thấy rtk trên máy; cài rtk rồi thử lại")
	}
	if err := optimizeProbeRTK(path); err != nil {
		return err
	}
	if p.Env == nil {
		p.Env = map[string]string{}
	}
	// Tắt telemetry, và tắt câu nhắc "No hook installed" mà rtk chèn vào output khi không thấy hook của nó ở ~/.claude.
	p.Env["RTK_TELEMETRY_DISABLED"] = "1"
	p.Env["RTK_SUPPRESS_HOOK_WARNING"] = "1"
	p.Hooks = append(p.Hooks, optimizer.Hook{Event: "PreToolUse", Matcher: "Bash", Command: path, Args: []string{"hook", "claude"}})
	return nil
}

func optimizeProbeRTK(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := procattr.CommandContext(ctx, path, "hook", "claude")
	cmd.Stdin = strings.NewReader(rtkProbeInput)
	cmd.Env = append(os.Environ(), "RTK_TELEMETRY_DISABLED=1", "RTK_SUPPRESS_HOOK_WARNING=1")
	out, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("hook RTK lỗi, không bật: %w", err)
	}
	var reply struct {
		HookSpecificOutput struct {
			UpdatedInput struct {
				Command string `json:"command"`
			} `json:"updatedInput"`
		} `json:"hookSpecificOutput"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(out), &reply); err != nil {
		return fmt.Errorf("hook RTK trả dữ liệu lạ, không bật: %w", err)
	}
	if got := reply.HookSpecificOutput.UpdatedInput.Command; !strings.HasPrefix(got, "rtk ") || !strings.Contains(got, "git status") {
		return fmt.Errorf("hook RTK viết lại `git status` thành %q, không bật", got)
	}
	return nil
}

// optimizeStatus ghép accounts.json (gói nào có trên máy) với manifest (gói nào đã bật).
func optimizeStatus(o *optimizer.Optimizer, file string) (*optimizeView, error) {
	list, err := accounts.Load(file)
	if err != nil {
		return nil, err
	}
	st, err := o.Status()
	if err != nil {
		return nil, err
	}
	enabled := map[string]optimizer.ProfileStatus{}
	for _, s := range st {
		enabled[s.ID] = s
	}
	view := &optimizeView{StatePath: o.StatePath(), LinkPath: o.LinkPath(), Profiles: []optimizeProfile{}}
	version, detected := "", false
	claudeVersion := func() string {
		if !detected {
			version, detected = optimizeClaudeVersion(context.Background()), true
		}
		return version
	}
	seen := map[string]bool{}
	for _, a := range list {
		if a.Pending {
			continue
		}
		seen[a.ID] = true
		row := optimizeProfile{ID: a.ID, Label: a.Label, CLI: a.CLI, InAccounts: true, Supported: a.CLI == "claude" || a.CLI == "codex"}
		if p, err := o.Profile(a.ID, a.CLI, a.ConfigDir); err == nil {
			row.ConfigDir, row.Default = p.Dir, p.Default
		}
		if !row.Supported {
			row.Reason = "Chưa hỗ trợ tối ưu cho CLI này"
		}
		optimizeFill(o, &row, enabled[a.ID], claudeVersion)
		view.Profiles = append(view.Profiles, row)
	}
	for _, s := range st {
		if seen[s.ID] {
			continue
		}
		row := optimizeProfile{ID: s.ID, CLI: s.CLI, ConfigDir: s.ConfigDir, Default: s.Default, Supported: true}
		optimizeFill(o, &row, s, claudeVersion)
		view.Profiles = append(view.Profiles, row)
	}
	sort.SliceStable(view.Profiles, func(i, j int) bool { return view.Profiles[i].ID < view.Profiles[j].ID })
	return view, nil
}

func optimizeFill(o *optimizer.Optimizer, row *optimizeProfile, s optimizer.ProfileStatus, claudeVersion func() string) {
	if row.CLI == "claude" && row.Supported {
		row.Version = claudeVersion()
	}
	row.Backups, _ = o.Backups(row.ID)
	if s.ID == "" {
		return
	}
	row.Enabled, row.Level = true, s.Level
	enabledAt, updatedAt := s.EnabledAt, s.UpdatedAt
	row.EnabledAt, row.UpdatedAt = &enabledAt, &updatedAt
	row.Modified = s.Modified
	for _, kv := range s.Env {
		row.Keys = append(row.Keys, "env."+kv.Key)
	}
	for _, h := range s.Hooks {
		row.Keys = append(row.Keys, "hooks."+h.Event)
		if strings.Contains(h.Hook, "rtk") {
			row.RTK = true
		}
	}
	for _, kv := range s.Codex {
		row.Keys = append(row.Keys, "codex."+kv.Key)
	}
	row.Skipped = s.Skipped
}

func printOptimize(w io.Writer, v *optimizeView) {
	if r := v.Result; r != nil {
		switch {
		case !r.Changed:
			fmt.Fprintf(w, "Gói %s: không có gì thay đổi.\n", r.Profile)
		default:
			fmt.Fprintf(w, "Gói %s: đã cập nhật cấu hình.\n", r.Profile)
		}
		if r.Backup != "" {
			fmt.Fprintf(w, "  Sao lưu: %s\n", r.Backup)
		}
		for _, warn := range r.Warnings {
			fmt.Fprintf(w, "  Lưu ý: %s\n", warn.Message)
		}
	}
	if len(v.Profiles) == 0 {
		fmt.Fprintln(w, "Chưa có gói nào.")
		return
	}
	for _, p := range v.Profiles {
		state := "chưa bật"
		switch {
		case !p.Supported:
			state = p.Reason
		case p.Enabled:
			state = "đang bật, mức " + p.Level
			if p.Modified {
				state += " (file đã bị sửa sau lần Hive ghi)"
			}
		}
		fmt.Fprintf(w, "%s (%s): %s\n", p.ID, p.CLI, state)
		for _, s := range p.Skipped {
			fmt.Fprintf(w, "  bỏ %s: %s\n", s.Key, s.Reason)
		}
	}
}

// optimizeReport: số đo token của một gói hay mọi gói, chia trước/sau lần bật. Mốc lấy từ manifest: với một gói là
// lúc bật gói đó; không chọn gói thì lấy lần bật đầu tiên của máy.
func optimizeReport(o *optimizer.Optimizer, file, profile string, days int, asJSON bool, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if days < 0 {
		return fail(errors.New("--days phải từ 0 trở lên"))
	}
	st, err := o.Status()
	if err != nil {
		return fail(err)
	}
	opts := tokenreport.Options{Home: o.Home, Days: days, Now: optimizeNow, RTK: optimizeReportRTK}
	if profile != "" {
		p, err := optimizeResolve(o, file, profile)
		if err != nil {
			return fail(err)
		}
		opts.Accounts = []string{optimizeAccountName(o, p)}
		for _, s := range st {
			if s.ID == profile {
				opts.Cutoff = s.EnabledAt
			}
		}
	} else {
		for _, s := range st {
			if opts.Cutoff.IsZero() || s.EnabledAt.Before(opts.Cutoff) {
				opts.Cutoff = s.EnabledAt
			}
		}
	}
	rep, err := tokenreport.Run(context.Background(), opts)
	if err != nil {
		return fail(err)
	}
	if asJSON {
		return printJSON(stdout, stderr, rep)
	}
	printReport(stdout, rep)
	return 0
}

// optimizeAccountName là tên mà tokenreport dùng cho gói: thư mục con của ~/.xdev-hive/accounts, hay "default".
func optimizeAccountName(o *optimizer.Optimizer, p optimizer.Profile) string {
	dir := accounts.AccountsDir(o.Home)
	if rel, err := filepath.Rel(dir, p.Dir); err == nil && rel != "." && !strings.HasPrefix(rel, "..") && !strings.ContainsRune(rel, filepath.Separator) {
		return rel
	}
	return tokenreport.DefaultAccount
}

func printReport(w io.Writer, r *tokenreport.Report) {
	fmt.Fprintf(w, "Báo cáo token: %d phiên\n", r.Sessions)
	sources := make([]string, 0, len(r.BySource))
	for name := range r.BySource {
		sources = append(sources, name)
	}
	sort.Strings(sources)
	for _, name := range sources {
		s := r.BySource[name]
		fmt.Fprintf(w, "  %s: %d phiên, %d lượt, token quy đổi %.0f, cache hit %.0f%%, phiên >400k: %d, nén: %d\n",
			name, s.Sessions, s.Calls, s.Weighted, s.CacheHit*100, s.PeakOver400k, s.Compactions)
	}
	if r.Split != nil {
		fmt.Fprintf(w, "Mốc bật tối ưu %s: %d phiên trước, %d phiên sau\n", r.Split.Cutoff, r.Split.SessionsBefore, r.Split.SessionsAfter)
	}
	if r.Trimmed != nil {
		fmt.Fprintf(w, "Hook đã cắt %d ký tự trong %d lần\n", r.Trimmed.CharsCut, r.Trimmed.Entries)
	}
}
