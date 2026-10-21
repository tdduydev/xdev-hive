package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
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

// scoreHistoryDays là khoảng mặc định của biểu đồ lịch sử điểm.
const scoreHistoryDays = 30

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

// optimizeScore chấm điểm tối ưu token của máy (spec 025), ghi lịch sử điểm rồi gửi điểm lên hub nếu người dùng đã bật
// (ADR 0036). cfgPath là worker.json, nơi có địa chỉ hub và machine token.
func optimizeScore(o *optimizer.Optimizer, file, cfgPath string, days int, fresh bool, measureProfile string, asJSON bool, stdout, stderr io.Writer) int {
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
		Home: o.Home, GOOS: optimizeGOOS(), Now: now, Days: days, Profiles: profiles, Sessions: sessions,
		Context: score.LoadContexts(ctx, dir, profiles, optimizeContext, now, measured), HasTool: optimizeHasTool,
	})
	prev, err := score.Record(dir, res, now, fixQueue{dir})
	if err != nil {
		// Lịch sử chỉ để so lần trước; ghi lỗi không làm hỏng điểm.
		fmt.Fprintln(stderr, "không ghi được lịch sử điểm:", err)
	}
	res.Previous = prev
	code := 0
	if asJSON {
		code = printJSON(stdout, stderr, res)
	} else {
		printScore(stdout, res)
	}
	// Gửi sau khi in: hub chậm hay lỗi không làm mất điểm đã chấm, chỉ kéo dài lúc tiến trình thoát.
	sendScoreReport(dir, cfgPath, res, now, stderr)
	return code
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
// từ lần cuối nên hoàn tác hết thì gói về đúng trạng thái trước lần sửa đầu.
type fixRecord struct {
	FixID       string    `json:"fixId"`
	PrevEnabled bool      `json:"prevEnabled"`
	PrevLevel   string    `json:"prevLevel,omitempty"`
	PrevRTK     bool      `json:"prevRtk,omitempty"`
	At          time.Time `json:"at"`
}

// fixState là score-fixes.json: chồng hoàn tác theo gói và hàng chờ mốc cho lịch sử điểm. Mốc rời hàng chờ khi
// `optimize score` đã ghi dòng lịch sử chứa nó (score.Record).
type fixState struct {
	Stacks  map[string][]fixRecord `json:"stacks"`
	Pending []score.FixMark        `json:"pending"`
}

func fixesPath(dir string) string { return filepath.Join(dir, "score-fixes.json") }

// loadFixes đọc trạng thái sửa nhanh; gọi khi đã giữ score.LockHistory. File của bản trước là map gói → chồng, bản
// ghi có `recorded` false là mốc chưa lên lịch sử.
func loadFixes(dir string) fixState {
	st := fixState{Stacks: map[string][]fixRecord{}}
	b, err := os.ReadFile(fixesPath(dir))
	if err != nil {
		return st
	}
	var probe map[string]json.RawMessage
	if json.Unmarshal(b, &probe) != nil {
		return st
	}
	_, hasStacks := probe["stacks"]
	_, hasPending := probe["pending"]
	if hasStacks || hasPending {
		if json.Unmarshal(b, &st) != nil {
			return fixState{Stacks: map[string][]fixRecord{}}
		}
		if st.Stacks == nil {
			st.Stacks = map[string][]fixRecord{}
		}
		return st
	}
	var legacy map[string][]struct {
		fixRecord
		Recorded bool `json:"recorded"`
	}
	if json.Unmarshal(b, &legacy) != nil {
		return st
	}
	var waiting []fixRecord
	for id, stack := range legacy {
		for _, r := range stack {
			st.Stacks[id] = append(st.Stacks[id], r.fixRecord)
			if !r.Recorded {
				waiting = append(waiting, r.fixRecord)
			}
		}
	}
	sort.SliceStable(waiting, func(i, j int) bool { return waiting[i].At.Before(waiting[j].At) })
	for _, r := range waiting {
		st.Pending = append(st.Pending, score.FixMark{ID: r.FixID, Action: score.MarkApply})
	}
	return st
}

func saveFixes(dir string, st fixState) error {
	for id, stack := range st.Stacks {
		if len(stack) == 0 {
			delete(st.Stacks, id)
		}
	}
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return score.WriteAtomic(fixesPath(dir), b)
}

// withFixes đọc, sửa và ghi trạng thái sửa nhanh trong khoá lịch sử điểm, để hai lệnh fix hay fix và score chạy cùng
// lúc không làm mất bản ghi của nhau.
func withFixes(dir string, fn func(st *fixState) error) error {
	unlock, err := score.LockHistory(dir)
	if err != nil {
		return err
	}
	defer unlock()
	st := loadFixes(dir)
	if err := fn(&st); err != nil {
		return err
	}
	return saveFixes(dir, st)
}

// fixQueue là hàng chờ mốc cho score.Record, chạy trong khoá Record đã giữ nên không khoá lại.
type fixQueue struct{ dir string }

func (q fixQueue) Pending() ([]score.FixMark, error) { return loadFixes(q.dir).Pending, nil }

func (q fixQueue) Done(n int) error {
	st := loadFixes(q.dir)
	st.Pending = st.Pending[min(n, len(st.Pending)):]
	return saveFixes(q.dir, st)
}

// addMarks thêm mốc vào hàng chờ; lần `optimize score` sau ghi chúng lên lịch sử.
func addMarks(dir string, marks ...score.FixMark) error {
	return withFixes(dir, func(st *fixState) error {
		st.Pending = append(st.Pending, marks...)
		return nil
	})
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

// errWindowsRTK mở đầu bằng mã lý do của A6 để app desktop nhận ra mà không dò chữ.
var errWindowsRTK = errors.New("windows_rtk_unsupported: RTK chưa hỗ trợ trên Windows")

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
		// Báo ngay bằng mã lý do như A6, trước khi dựng preset hay ghi bản ghi hoàn tác (optimizeAddRTK cũng chặn).
		if optimizeGOOS() == "windows" {
			return "", false, errWindowsRTK
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
	switch {
	case undo:
		var rec fixRecord
		err := withFixes(dir, func(st *fixState) error {
			stack := st.Stacks[p.ID]
			if len(stack) == 0 {
				return errors.New("gói này không có lần sửa nhanh nào để hoàn tác")
			}
			if rec = stack[len(stack)-1]; rec.FixID != fixID {
				return fmt.Errorf("hãy hoàn tác lần sửa nhanh sau cùng của gói (%s) trước", rec.FixID)
			}
			return nil
		})
		if err != nil {
			return fail(err)
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
		err = withFixes(dir, func(st *fixState) error {
			if stack := st.Stacks[p.ID]; len(stack) > 0 && stack[len(stack)-1] == rec {
				st.Stacks[p.ID] = stack[:len(stack)-1]
			}
			st.Pending = append(st.Pending, score.FixMark{ID: fixID, Action: score.MarkUndo})
			return nil
		})
		if err != nil {
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
	rec := fixRecord{FixID: fixID, PrevEnabled: row.Enabled, PrevLevel: row.Level, PrevRTK: row.RTK, At: optimizeNow().UTC()}
	if err := withFixes(dir, func(st *fixState) error {
		st.Stacks[p.ID] = append(st.Stacks[p.ID], rec)
		return nil
	}); err != nil {
		return fail(err)
	}
	res, err := optimizeEnable(o, p, level, withRTK)
	if err != nil {
		_ = withFixes(dir, func(st *fixState) error {
			if stack := st.Stacks[p.ID]; len(stack) > 0 && stack[len(stack)-1] == rec {
				st.Stacks[p.ID] = stack[:len(stack)-1]
			}
			return nil
		})
		return fail(err)
	}
	// Mốc vào hàng chờ chỉ khi cấu hình đã đổi; ghi lỗi thì cấu hình vẫn đúng, chỉ thiếu mốc trên biểu đồ.
	if err := addMarks(dir, score.FixMark{ID: fixID, Action: score.MarkApply}); err != nil {
		fmt.Fprintln(stderr, "không ghi được mốc sửa nhanh:", err)
	}
	return printJSON(stdout, stderr, fixResult{FixID: fixID, Profile: p.ID, Backup: res.Backup, Changed: res.Changed})
}

// restoreMarks: chép bản sao lưu bỏ mọi lần sửa nhanh sau bản đó, nên chồng hoàn tác của gói không còn đúng. Ghi mốc
// hoàn tác cho từng lần, mới trước cũ sau, rồi xoá chồng.
func restoreMarks(dir, profileID string) error {
	return withFixes(dir, func(st *fixState) error {
		stack := st.Stacks[profileID]
		for i := len(stack) - 1; i >= 0; i-- {
			st.Pending = append(st.Pending, score.FixMark{ID: stack[i].FixID, Action: score.MarkUndo})
		}
		delete(st.Stacks, profileID)
		return nil
	})
}

// optimizeScoreHistory in lịch sử điểm cho biểu đồ của app desktop: không tính điểm, không gọi model.
func optimizeScoreHistory(o *optimizer.Optimizer, days int, last bool, stdout, stderr io.Writer) int {
	if days < 0 {
		fmt.Fprintln(stderr, "--days phải từ 0 trở lên")
		return 2
	}
	if days == 0 {
		days = scoreHistoryDays
	}
	if last {
		// --last là dòng cuối bất kể khoảng ngày, để thẻ điểm hiện lần trước cả khi lâu không mở.
		days = 0
	}
	entries, err := score.History(filepath.Dir(o.StatePath()), optimizeNow(), days)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if last && len(entries) > 0 {
		entries = entries[len(entries)-1:]
	}
	if entries == nil {
		entries = []score.HistoryEntry{}
	}
	return printJSON(stdout, stderr, map[string][]score.HistoryEntry{"entries": entries})
}

// optimizeScoreMark thêm mốc cho sửa nhanh do app desktop tự chạy (cài công cụ, `codegraph init`, thêm MCP).
func optimizeScoreMark(o *optimizer.Optimizer, fixID, action string, stdout, stderr io.Writer) int {
	if !score.MarkableFix(fixID) {
		fmt.Fprintf(stderr, "không có sửa nhanh %q để ghi mốc\n", fixID)
		return 2
	}
	if action != score.MarkApply && action != score.MarkUndo {
		fmt.Fprintln(stderr, "--action phải là apply hoặc undo")
		return 2
	}
	mark := score.FixMark{ID: fixID, Action: action}
	if err := addMarks(filepath.Dir(o.StatePath()), mark); err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return printJSON(stdout, stderr, mark)
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
