package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/score"
	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

// scoreDays là khoảng ngày mặc định của nhóm B (spec 025).
const scoreDays = 7

// scoreProfiles đổi danh sách gói của `optimize status` sang đầu vào của điểm. Thư mục mặc định ~/.claude, ~/.codex
// được thêm khi chưa gói nào trỏ tới nó, vì phần lớn phiên làm tay chạy bằng đăng nhập mặc định.
func scoreProfiles(o *optimizer.Optimizer, view *optimizeView) []score.Profile {
	var out []score.Profile
	seen := map[string]bool{}
	dirKey := func(cli, dir string) string { return cli + "|" + strings.ToLower(filepath.Clean(dir)) }
	version := ""
	for _, row := range view.Profiles {
		p := score.Profile{ID: row.ID, Label: row.Label, CLI: row.CLI, Dir: row.ConfigDir, Default: row.Default,
			Version: row.Version}
		if row.Enabled {
			p.Level, p.HiveKeys = row.Level, row.Keys
		}
		if row.CLI == "claude" && row.Version != "" {
			version = row.Version
		}
		if row.CLI == "claude" || row.CLI == "codex" {
			if seen[dirKey(row.CLI, row.ConfigDir)] {
				continue
			}
			seen[dirKey(row.CLI, row.ConfigDir)] = true
		}
		out = append(out, p)
	}
	for _, cli := range []string{"claude", "codex"} {
		p, err := o.Profile(cli, cli, "")
		if err != nil || p.Dir == "" || seen[dirKey(cli, p.Dir)] {
			continue
		}
		if info, err := os.Stat(p.Dir); err != nil || !info.IsDir() {
			continue
		}
		sp := score.Profile{ID: cli, CLI: cli, Dir: p.Dir, Default: true}
		if cli == "claude" {
			if version == "" {
				version = optimizeClaudeVersion(context.Background())
			}
			sp.Version = version
		}
		out = append(out, sp)
	}
	return out
}

// optimizeScore chấm điểm tối ưu token của máy (spec 025) và ghi lịch sử điểm.
func optimizeScore(o *optimizer.Optimizer, file string, days int, fresh bool, measureProfile string, asJSON bool, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if days < 0 {
		return fail(errors.New("--days phải từ 0 trở lên"))
	}
	if days == 0 {
		days = scoreDays
	}
	view, err := optimizeStatus(o, file)
	if err != nil {
		return fail(err)
	}
	profiles := scoreProfiles(o, view)
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
		opts := tokenreport.Options{Home: o.Home, Days: days, Now: optimizeNow, Roots: roots, NoRTK: true}
		if sessions, err = tokenreport.Sessions(ctx, opts); err != nil {
			return fail(err)
		}
	}
	dir := filepath.Dir(o.StatePath())
	// --fresh chạy /context (gọi model): chỉ cho gói được bấm đo (--profile); không chọn gói thì mọi gói Claude.
	var measured []string
	if fresh {
		for _, p := range profiles {
			if p.CLI == "claude" && (measureProfile == "" || p.ID == measureProfile) {
				measured = append(measured, p.ID)
			}
		}
	}
	res := score.Compute(score.Inputs{
		Home: o.Home, GOOS: runtime.GOOS, Now: now, Days: days, Profiles: profiles, Sessions: sessions,
		Context: score.LoadContexts(ctx, dir, profiles, optimizeContext, now, measured), HasTool: optimizeHasTool,
	})
	prev, err := score.Record(dir, res, takePendingFix(dir), now)
	if err != nil {
		// Lịch sử chỉ để so lần trước; ghi lỗi không làm hỏng điểm.
		fmt.Fprintln(stderr, "không ghi được lịch sử điểm:", err)
	}
	res.Previous = prev
	if asJSON {
		return printJSON(stdout, stderr, res)
	}
	printScore(stdout, res)
	return 0
}

func printScore(w io.Writer, r *score.Result) {
	if r.Machine.Score == nil {
		fmt.Fprintln(w, "Chưa chấm được điểm tối ưu token của máy.")
	} else {
		fmt.Fprintf(w, "Điểm tối ưu token: %.1f/100 (đo được %.0f/100 điểm)\n", *r.Machine.Score, r.Machine.Coverage)
	}
	for _, p := range r.Profiles {
		switch {
		case p.Score == nil:
			fmt.Fprintf(w, "  %s (%s): chưa chấm được\n", p.ID, p.CLI)
		case !p.Counted:
			fmt.Fprintf(w, "  %s (%s): %.1f, không tính vào điểm máy\n", p.ID, p.CLI, *p.Score)
		default:
			fmt.Fprintf(w, "  %s (%s): %.1f, %d phiên, %.0f%% token\n", p.ID, p.CLI, *p.Score, p.Sessions, p.Share*100)
		}
	}
}

// fixRecord nhớ trạng thái gói trước một lần sửa nhanh, để hoàn tác bằng cách bật lại mức cũ hoặc tắt, thay vì chép
// bản sao lưu (chép bản sao lưu để manifest ghi sai mức). Mỗi gói giữ một chồng bản ghi, cũ trước mới sau; hoàn tác đi
// từ lần cuối nên hoàn tác hết thì gói về đúng trạng thái trước lần sửa đầu. Recorded: lịch sử điểm đã có dòng cho nó.
type fixRecord struct {
	FixID       string    `json:"fixId"`
	PrevEnabled bool      `json:"prevEnabled"`
	PrevLevel   string    `json:"prevLevel,omitempty"`
	PrevRTK     bool      `json:"prevRtk,omitempty"`
	At          time.Time `json:"at"`
	Recorded    bool      `json:"recorded,omitempty"`
}

func fixesPath(dir string) string { return filepath.Join(dir, "score-fixes.json") }

func loadFixes(dir string) map[string][]fixRecord {
	m := map[string][]fixRecord{}
	if b, err := os.ReadFile(fixesPath(dir)); err == nil && json.Unmarshal(b, &m) != nil {
		m = map[string][]fixRecord{}
	}
	return m
}

func saveFixes(dir string, m map[string][]fixRecord) error {
	for id, stack := range m {
		if len(stack) == 0 {
			delete(m, id)
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return os.WriteFile(fixesPath(dir), b, 0o600)
}

// takePendingFix trả mã sửa nhanh mới nhất chưa có dòng lịch sử và đánh dấu mọi lần sửa là đã ghi.
func takePendingFix(dir string) string {
	m := loadFixes(dir)
	latest, at := "", time.Time{}
	changed := false
	for _, stack := range m {
		for i := range stack {
			if stack[i].Recorded {
				continue
			}
			if stack[i].At.After(at) {
				latest, at = stack[i].FixID, stack[i].At
			}
			stack[i].Recorded = true
			changed = true
		}
	}
	if changed {
		_ = saveFixes(dir, m)
	}
	return latest
}

type fixChange struct {
	File   string  `json:"file"`
	Key    string  `json:"key"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}

type fixPreview struct {
	FixID    string      `json:"fixId"`
	Profile  string      `json:"profile"`
	Changes  []fixChange `json:"changes"`
	Warnings []string    `json:"warnings"`
}

type fixResult struct {
	FixID   string `json:"fixId"`
	Profile string `json:"profile"`
	Backup  string `json:"backup,omitempty"`
	Changed bool   `json:"changed"`
	Undone  bool   `json:"undone,omitempty"`
}

// fixTarget đổi mã sửa nhanh thành mức và RTK cần bật. Chỉ các mã ghi cấu hình CLI chạy trong sidecar; cài công cụ
// và lệnh codegraph do app desktop chạy.
func fixTarget(fixID string, p optimizer.Profile, row optimizeProfile) (string, bool, error) {
	switch fixID {
	case score.FixBalanced:
		if p.CLI != "claude" && p.CLI != "codex" {
			break
		}
		return runner.PresetBalanced, row.RTK, nil
	case score.FixRTK:
		if p.CLI != "claude" {
			break
		}
		level := runner.PresetBalanced
		if row.Enabled {
			level = row.Level
		}
		return level, true, nil
	case score.FixAggressive:
		if p.CLI != "claude" {
			break
		}
		return runner.PresetAggressive, row.RTK, nil
	default:
		return "", false, fmt.Errorf("không có sửa nhanh %q", fixID)
	}
	return "", false, fmt.Errorf("sửa nhanh %q không dùng được cho gói %s (%s)", fixID, p.ID, p.CLI)
}

func optimizeFix(o *optimizer.Optimizer, file, fixID, profile string, preview, undo bool, stdout, stderr io.Writer) int {
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	p, err := optimizeResolve(o, file, profile)
	if err != nil {
		return fail(err)
	}
	view, err := optimizeStatus(o, file)
	if err != nil {
		return fail(err)
	}
	var row optimizeProfile
	for _, r := range view.Profiles {
		if r.ID == p.ID {
			row = r
		}
	}
	level, withRTK, err := fixTarget(fixID, p, row)
	if err != nil {
		return fail(err)
	}
	dir := filepath.Dir(o.StatePath())
	fixes := loadFixes(dir)
	switch {
	case undo:
		stack := fixes[p.ID]
		if len(stack) == 0 {
			return fail(errors.New("gói này không có lần sửa nhanh nào để hoàn tác"))
		}
		rec := stack[len(stack)-1]
		if rec.FixID != fixID {
			return fail(fmt.Errorf("hãy hoàn tác lần sửa nhanh sau cùng của gói (%s) trước", rec.FixID))
		}
		var res *optimizer.Result
		if rec.PrevEnabled {
			res, err = optimizeEnable(o, p, rec.PrevLevel, rec.PrevRTK)
		} else {
			res, err = o.Disable(p)
		}
		if err != nil {
			return fail(err)
		}
		fixes[p.ID] = stack[:len(stack)-1]
		if err := saveFixes(dir, fixes); err != nil {
			return fail(err)
		}
		return printJSON(stdout, stderr, fixResult{FixID: fixID, Profile: p.ID, Changed: res.Changed, Undone: true})
	case preview:
		out, err := optimizeFixPreview(o, p, row, fixID, level, withRTK)
		if err != nil {
			return fail(err)
		}
		return printJSON(stdout, stderr, out)
	}
	// Ghi bản ghi trước khi đổi cấu hình: tiến trình chết giữa chừng vẫn còn đường hoàn tác.
	stack := fixes[p.ID]
	fixes[p.ID] = append(stack, fixRecord{FixID: fixID, PrevEnabled: row.Enabled, PrevLevel: row.Level, PrevRTK: row.RTK,
		At: optimizeNow().UTC()})
	if err := saveFixes(dir, fixes); err != nil {
		return fail(err)
	}
	res, err := optimizeEnable(o, p, level, withRTK)
	if err != nil {
		fixes[p.ID] = stack
		_ = saveFixes(dir, fixes)
		return fail(err)
	}
	return printJSON(stdout, stderr, fixResult{FixID: fixID, Profile: p.ID, Backup: res.Backup, Changed: res.Changed})
}

// optimizeFixPreview liệt kê khoá sẽ thêm, đổi hay gỡ mà không ghi gì. Khoá người dùng tự đặt được giữ nguyên khi bật,
// nên không có trong danh sách.
func optimizeFixPreview(o *optimizer.Optimizer, p optimizer.Profile, row optimizeProfile, fixID, level string, withRTK bool) (*fixPreview, error) {
	preset, err := optimizeBuildPreset(o, p, level, withRTK)
	if err != nil {
		return nil, err
	}
	out := &fixPreview{FixID: fixID, Profile: p.ID, Changes: []fixChange{}, Warnings: []string{}}
	hive := map[string]bool{}
	if row.Enabled {
		for _, k := range row.Keys {
			hive[k] = true
		}
	}
	text := func(s string) *string { return &s }
	diff := func(file, prefix string, cur, next map[string]string) {
		for _, k := range sortedKeys(next) {
			before, had := cur[k]
			after := strings.Trim(next[k], `"`)
			if had && (before == after || !hive[prefix+k]) {
				continue
			}
			ch := fixChange{File: file, Key: prefix + k, After: text(after)}
			if had {
				ch.Before = text(before)
			}
			out.Changes = append(out.Changes, ch)
		}
		for _, k := range sortedKeys(hiveMap(hive, prefix)) {
			if _, keep := next[k]; keep {
				continue
			}
			ch := fixChange{File: file, Key: prefix + k}
			if before, had := cur[k]; had {
				ch.Before = text(before)
			}
			out.Changes = append(out.Changes, ch)
		}
	}
	switch p.CLI {
	case "claude":
		st := score.ReadClaudeSettings(p.Dir)
		if !st.OK {
			return nil, fmt.Errorf("settings.json của gói %s bị hỏng; sửa file rồi thử lại", p.ID)
		}
		file := score.ShortPath(o.Home, st.Path)
		diff(file, "env.", st.EnvMap(), preset.Env)
		for _, h := range preset.Hooks {
			isRTK := strings.Contains(filepath.Base(h.Command), "rtk")
			if (isRTK && row.RTK) || (!isRTK && hive["hooks."+h.Event]) {
				continue
			}
			cmd := "hive-worker"
			if h.Command != "" {
				cmd = filepath.Base(h.Command)
			}
			out.Changes = append(out.Changes, fixChange{File: file, Key: "hooks." + h.Event,
				After: text(strings.Join(append([]string{cmd}, h.Args...), " "))})
		}
	case "codex":
		path := filepath.Join(p.Dir, "config.toml")
		cfg := score.ReadCodexConfig(path)
		if !cfg.OK {
			return nil, fmt.Errorf("config.toml của gói %s bị hỏng; sửa file rồi thử lại", p.ID)
		}
		diff(score.ShortPath(o.Home, path), "codex.", cfg.Top(), preset.Codex)
	}
	if level == runner.PresetAggressive {
		out.Warnings = append(out.Warnings, "quality_may_change")
	}
	return out, nil
}

// hiveMap lấy các khoá Hive đã đặt có tiền tố prefix, bỏ tiền tố.
func hiveMap(hive map[string]bool, prefix string) map[string]string {
	out := map[string]string{}
	for k := range hive {
		if rest, ok := strings.CutPrefix(k, prefix); ok {
			out[rest] = ""
		}
	}
	return out
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
