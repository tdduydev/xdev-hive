package score

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/tokenreport"
)

// Điểm tối đa của từng tiêu chí (spec "Thang điểm"): nhóm A 45, nhóm B 55.
var maxPoints = map[string]float64{
	"A1": 10, "A2": 8, "A3": 5, "A4": 7, "A5": 5, "A6": 3, "A7": 3, "A8": 4,
	"B1": 12, "B2": 10, "B3": 8, "B4": 6, "B5": 8, "B6": 5, "B7": 6,
}

var criterionIDs = []string{"A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "B1", "B2", "B3", "B4", "B5", "B6", "B7"}

func criterionOrder(id string) int {
	for i, x := range criterionIDs {
		if x == id {
			return i
		}
	}
	return len(criterionIDs)
}

// Mã sửa nhanh (plan mục 6). Bảng cho phép ở Rust và lệnh `optimize fix` dùng đúng các mã này.
const (
	FixBalanced   = "optimizer.balanced"
	FixRTK        = "optimizer.rtk"
	FixAggressive = "optimizer.aggressive"
	FixToolRTK    = "tool.rtk"
	FixToolGraph  = "tool.codegraph"
	FixGraphMCP   = "codegraph.mcp"
	FixGraphInit  = "codegraph.init"
	FixOpenMemory = "open.memory"
	FixOpenMCP    = "open.mcp"
	// FixMeasureContext không ghi gì: giao diện chấm lại có chạy /context (gọi model) khi người dùng bấm.
	FixMeasureContext = "context.measure"
)

// MarkableFix: mã sửa nhanh có đổi cấu hình hay công cụ trên máy, nên được ghi mốc trên lịch sử điểm. Mở màn và đo
// /context không đổi gì nên không có mốc.
func MarkableFix(id string) bool {
	switch id {
	case FixBalanced, FixRTK, FixAggressive, FixToolRTK, FixToolGraph, FixGraphMCP, FixGraphInit:
		return true
	}
	return false
}

// linear: x ở mức good được 1, ở mức bad được 0, kẹp trong [0, 1]. good < bad là thấp tốt, good > bad là cao tốt.
func linear(x, good, bad float64) float64 {
	if good == bad {
		if x <= good {
			return 1
		}
		return 0
	}
	return math.Max(0, math.Min(1, (bad-x)/(bad-good)))
}

func statusOf(earned, max float64) Status {
	switch {
	case earned >= max-0.01:
		return StatusOK
	case earned >= max/2:
		return StatusPartial
	}
	return StatusLow
}

func group(id string) string { return id[:1] }

func valued(id string, x, good, bad float64, unit, source string) Criterion {
	m := maxPoints[id]
	earned := m * linear(x, good, bad)
	return Criterion{ID: id, Group: group(id), Status: statusOf(earned, m), Value: ptr(x), Unit: unit, Good: ptr(good),
		Bad: ptr(bad), Earned: earned, Max: m, Source: source}
}

// itemized: điểm = điểm tối đa × trung bình mục con đo được. Không mục nào đo được thì tiêu chí là unknown.
func itemized(id, source string, items []Item) Criterion {
	m := maxPoints[id]
	sum, n := 0.0, 0
	for _, it := range items {
		if it.Score != nil {
			sum += *it.Score
			n++
		}
	}
	c := Criterion{ID: id, Group: group(id), Max: m, Source: source, Items: items}
	if n == 0 {
		c.Status, c.Reason = StatusUnknown, firstReason(items)
		return c
	}
	c.Earned = m * sum / float64(n)
	c.Status = statusOf(c.Earned, m)
	return c
}

func firstReason(items []Item) string {
	for _, it := range items {
		if it.Reason != "" {
			return it.Reason
		}
	}
	return ""
}

func unknown(id, reason string) Criterion {
	return Criterion{ID: id, Group: group(id), Status: StatusUnknown, Max: maxPoints[id], Reason: reason}
}

func unsupported(id, reason string) Criterion {
	return Criterion{ID: id, Group: group(id), Status: StatusUnsupported, Max: maxPoints[id], Reason: reason}
}

func item(id string, score float64) Item {
	st := StatusOK
	if score < 1 {
		st = StatusPartial
	}
	if score <= 0 {
		st = StatusLow
	}
	return Item{ID: id, Status: st, Score: ptr(score)}
}

func boolItem(id string, ok bool) Item {
	if ok {
		return item(id, 1)
	}
	return item(id, 0)
}

func unknownItem(id, reason string) Item { return Item{ID: id, Status: StatusUnknown, Reason: reason} }

func (c *Criterion) addFix(fix string) {
	if c.Earned < c.Max-0.01 {
		c.Fixes = append(c.Fixes, fix)
	}
}

// profileData là số liệu chung của một gói cho các tiêu chí.
type profileData struct {
	in       Inputs
	p        Profile
	all      []tokenreport.SessionSummary // nguồn interactive và headless (Q11), gồm subagent
	main     []tokenreport.SessionSummary // phiên chính
	projects []Project
}

func scoreProfile(in Inputs, p Profile) ProfileScore {
	ps := ProfileScore{ID: p.ID, Label: p.Label, CLI: p.CLI, Default: p.Default, Level: p.Level, Projects: []Project{}}
	d := profileData{in: in, p: p}
	for _, s := range in.Sessions {
		if s.Account != p.ID || s.CLI != p.CLI || (s.Source != "interactive" && s.Source != "headless") {
			continue
		}
		d.all = append(d.all, s)
		if !s.Subagent {
			d.main = append(d.main, s)
		}
		ps.Weighted += s.Weighted
	}
	ps.Sessions = len(d.main)
	ps.ModelShare = modelShare(d.all)
	d.projects = topProjects(in.Home, d.all, 3)
	ps.Projects = d.projects
	if r := in.Context[p.ID]; r != nil {
		ps.Context = r.Categories
	}
	switch p.CLI {
	case "claude":
		ps.Counted = true
		ps.Criteria = append(claudeConfig(d), usage(d)...)
	case "codex":
		ps.Counted = true
		ps.Criteria = append(codexConfig(d), usage(d)...)
	case "antigravity":
		ps.Reason = "no_token_logs"
		ps.Criteria = agyConfig(d)
	default:
		ps.Reason = "unsupported_cli"
		for _, id := range criterionIDs {
			ps.Criteria = append(ps.Criteria, unsupported(id, "unsupported_cli"))
		}
	}
	total(&ps)
	return ps
}

// modelShare gộp token quy đổi theo họ model của các phiên, xếp họ dùng nhiều trước. Không có số theo model thì nil.
func modelShare(sessions []tokenreport.SessionSummary) []ModelShare {
	byFamily := map[string]float64{}
	sum := 0.0
	for _, s := range sessions {
		for f, w := range s.ModelWeighted {
			byFamily[f] += w
			sum += w
		}
	}
	if sum <= 0 {
		return nil
	}
	out := make([]ModelShare, 0, len(byFamily))
	for f, w := range byFamily {
		if w > 0 {
			out = append(out, ModelShare{Family: f, Share: math.Round(w/sum*10000) / 10000})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Share != out[j].Share {
			return out[i].Share > out[j].Share
		}
		return out[i].Family < out[j].Family
	})
	return out
}

// topProjects: n thư mục làm việc có token quy đổi lớn nhất và còn trên đĩa.
func topProjects(home string, sessions []tokenreport.SessionSummary, n int) []Project {
	byDir := map[string]float64{}
	sum := 0.0
	for _, s := range sessions {
		if s.Cwd == "" {
			continue
		}
		byDir[s.Cwd] += s.Weighted
		sum += s.Weighted
	}
	dirs := make([]string, 0, len(byDir))
	for d := range byDir {
		dirs = append(dirs, d)
	}
	sort.Slice(dirs, func(i, j int) bool {
		if byDir[dirs[i]] != byDir[dirs[j]] {
			return byDir[dirs[i]] > byDir[dirs[j]]
		}
		return dirs[i] < dirs[j]
	})
	out := []Project{}
	for _, d := range dirs {
		if len(out) == n {
			break
		}
		if info, err := os.Stat(d); err != nil || !info.IsDir() {
			continue
		}
		share := 0.0
		if sum > 0 {
			share = round2(byDir[d] / sum)
		}
		out = append(out, Project{Key: ProjectKey(d), Path: ShortPath(home, d), Share: share,
			Codegraph: isDir(filepath.Join(d, ".codegraph")), dir: d})
	}
	return out
}

// ProjectKey là khoá của một thư mục dự án trong JSON điểm: băm đường dẫn, nên vẫn trỏ đúng thư mục khi thứ hạng dự án
// đổi giữa lúc xem trước và lúc áp dụng sửa nhanh.
func ProjectKey(dir string) string {
	sum := sha256.Sum256([]byte(filepath.Clean(dir)))
	return "p" + hex.EncodeToString(sum[:6])
}

// ShortPath rút đường dẫn trong thư mục nhà về dạng "~/…" với dấu "/" để hiện trên màn hình.
func ShortPath(home, p string) string {
	if home != "" {
		if rel, err := filepath.Rel(home, p); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			if rel == "." {
				return "~"
			}
			return "~/" + filepath.ToSlash(rel)
		}
	}
	return filepath.ToSlash(p)
}

func isDir(p string) bool {
	info, err := os.Stat(p)
	return err == nil && info.IsDir()
}

// --- Nhóm B ---------------------------------------------------------------------------------------------------------

func usage(d profileData) []Criterion {
	ids := []string{"B1", "B2", "B3", "B4", "B5", "B6", "B7"}
	if len(d.main) < MinSessions {
		out := make([]Criterion, 0, len(ids))
		for _, id := range ids {
			out = append(out, unknown(id, "not_enough_sessions"))
		}
		return out
	}
	var peaks, firsts []float64
	for _, s := range d.main {
		peaks = append(peaks, float64(s.PeakContext))
		firsts = append(firsts, float64(s.FirstContext))
	}
	var w, wLong, calls, cacheRead, inputAll, toolChars float64
	toolCalls := 0
	for _, s := range d.all {
		w += s.Weighted
		if s.PeakContext > 400_000 {
			wLong += s.Weighted
		}
		calls += float64(s.Calls)
		cacheRead += float64(s.CacheRead)
		inputAll += float64(s.Input + s.CacheRead + s.CacheWrite)
		toolChars += s.ToolChars
		toolCalls += s.ToolCalls
	}
	out := []Criterion{
		valued("B1", median(peaks), 120_000, 300_000, "tokens", "sessions"),
		valued("B2", ratio(wLong, w), 0.10, 0.50, "ratio", "sessions"),
		valued("B3", median(firsts), 20_000, 50_000, "tokens", "sessions"),
	}
	if inputAll > 0 {
		out = append(out, valued("B4", cacheRead/inputAll, 0.90, 0.60, "ratio", "sessions"))
	} else {
		out = append(out, unknown("B4", "not_enough_sessions"))
	}
	if calls > 0 {
		out = append(out, valued("B5", w/calls, 20_000, 60_000, "tokens", "sessions"))
	} else {
		out = append(out, unknown("B5", "not_enough_sessions"))
	}
	if toolCalls > 0 {
		out = append(out, valued("B6", toolChars/4/float64(toolCalls), 600, 2500, "tokens", "sessions"))
	} else {
		out = append(out, unknown("B6", "not_enough_sessions"))
	}
	out = append(out, preEdit(d))
	return out
}

func preEdit(d profileData) Criterion {
	if d.p.CLI != "claude" {
		return unknown("B7", "codex_not_measured")
	}
	var pre, w float64
	for _, s := range d.main {
		if s.Edited {
			pre += s.PreEditWeighted
			w += s.Weighted
		}
	}
	if w == 0 {
		return unknown("B7", "no_edit_sessions")
	}
	return valued("B7", pre/w, 0.30, 0.70, "ratio", "sessions")
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	a := append([]float64(nil), xs...)
	sort.Float64s(a)
	if len(a)%2 == 1 {
		return a[len(a)/2]
	}
	return (a[len(a)/2-1] + a[len(a)/2]) / 2
}

func ratio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

// --- Nhóm A: Claude Code -------------------------------------------------------------------------------------------

// Mặc định của Claude Code theo tài liệu env-vars (research mục 3): Bash 30.000 ký tự, Read và MCP 25.000 token.
// Trần của mức balanced là 15.000 cho cả ba.
const (
	capBalanced    = 15_000
	defaultBash    = 30_000
	defaultRead    = 25_000
	defaultMCP     = 25_000
	window1M       = 967_000
	window200k     = 200_000
	codexOutputCap = 8_000
)

func claudeConfig(d profileData) []Criterion {
	st := ReadClaudeSettings(d.p.Dir)
	if !st.OK {
		var out []Criterion
		for _, id := range []string{"A1", "A2", "A3", "A6", "A7", "A8"} {
			out = append(out, unknown(id, "config_unreadable"))
		}
		return append(out, claudeA4(d, st), claudeA5(d))
	}
	return []Criterion{claudeA1(d, st), claudeA2(d, st), claudeA3(d, st), claudeA4(d, st), claudeA5(d), claudeA6(d, st),
		claudeA7(d, st), claudeA8(d, st)}
}

func (d profileData) hiveSet(key string) bool {
	for _, k := range d.p.HiveKeys {
		if k == key {
			return true
		}
	}
	return false
}

func claudeA1(d profileData, st ClaudeSettings) Criterion {
	win, hasWin := st.Number("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
	if !hasWin {
		win, hasWin = st.TopNumber("autoCompactWindow")
	}
	pct, hasPct := st.Number("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")
	x, source := 0.0, "settings"
	ctx := d.in.Context[d.p.ID]
	switch {
	case hasWin || hasPct:
		// Cấu hình đặt tay được ưu tiên: chưa rõ /context có phản ánh biến này hay không.
		if !hasWin {
			win = d.defaultWindow(ctx, st)
		}
		x = win
		if hasPct && pct > 0 && pct < 100 {
			x = win * pct / 100
		}
	case ctx != nil && ctx.Window > 0 && ctx.Category("autocompact buffer") > 0:
		x, source = float64(ctx.Window-ctx.Category("autocompact buffer")), "context"
	default:
		x = d.defaultWindow(nil, st)
	}
	c := valued("A1", x, 200_000, 600_000, "tokens", source)
	if v := st.Env("DISABLE_AUTO_COMPACT"); v == "1" || strings.EqualFold(v, "true") {
		c.Earned, c.Status = 0, StatusLow
		c.Warnings = append(c.Warnings, Warning{Code: "auto_compact_off"})
	}
	if d.p.Level == "" {
		c.addFix(FixBalanced)
	}
	return c
}

// defaultWindow đoán ngưỡng nén mặc định: model 1M nén ở khoảng 967k, model 200k nén ở 200k. Không đọc được model từ
// cấu hình nên coi là 1M khi /context báo cửa sổ 1m, khi model có hậu tố [1m], hoặc khi đã có phiên vượt 200k.
func (d profileData) defaultWindow(ctx *ContextReport, st ClaudeSettings) float64 {
	if ctx != nil && ctx.Window > 0 {
		if ctx.Window >= 1_000_000 {
			return window1M
		}
		return window200k
	}
	if strings.Contains(strings.ToLower(st.TopString("model")), "[1m]") {
		return window1M
	}
	for _, s := range d.all {
		if s.PeakContext > window200k {
			return window1M
		}
	}
	return window200k
}

// capItem: ≤ trần balanced được 1; không đặt được 0,5; từ trần tới mặc định giảm dần về 0,5; quá mặc định được 0.
func capItem(id string, v float64, set bool, capValue, def float64) Item {
	if !set {
		it := item(id, 0.5)
		it.Reason = "default"
		return it
	}
	score := 0.0
	switch {
	case v <= capValue:
		score = 1
	case v <= def:
		score = 1 - 0.5*(v-capValue)/(def-capValue)
	}
	it := item(id, score)
	it.Value = ptr(v)
	return it
}

func claudeA2(d profileData, st ClaudeSettings) Criterion {
	bash, bashSet := st.TopNumber("bashOutputMaxChars")
	bashKey := ""
	if !bashSet {
		bash, bashSet = st.Number("BASH_MAX_OUTPUT_LENGTH")
		bashKey = "BASH_MAX_OUTPUT_LENGTH"
	}
	read, readSet := st.Number("CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS")
	mcp, mcpSet := st.Number("MAX_MCP_OUTPUT_TOKENS")
	hook := strings.Contains(st.Hooks("PostToolUse"), "hive-worker") && strings.Contains(st.Hooks("PostToolUse"), "--local")
	c := itemized("A2", "settings", []Item{
		capItem("bash", bash, bashSet, capBalanced, defaultBash),
		capItem("read", read, readSet, capBalanced, defaultRead),
		capItem("mcp", mcp, mcpSet, capBalanced, defaultMCP),
		boolItem("hook", hook),
	})
	for key, set := range map[string]bool{bashKey: bashSet && bashKey != "", "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS": readSet,
		"MAX_MCP_OUTPUT_TOKENS": mcpSet} {
		if set && key != "" && !d.hiveSet("env."+key) {
			c.UserSet = true
		}
	}
	if c.UserSet {
		c.Warnings = append(c.Warnings, Warning{Code: "user_set", File: ShortPath(d.in.Home, st.Path)})
	}
	if d.p.Level == "" {
		c.addFix(FixBalanced)
	}
	return c
}

func claudeA3(d profileData, st ClaudeSettings) Criterion {
	tokens, source := 0.0, "sessions"
	if len(d.main) > 0 {
		var xs []float64
		for _, s := range d.main {
			xs = append(xs, float64(s.InstructionChars)/4)
		}
		tokens = median(xs)
	} else {
		source = "files"
		tokens = float64(runeCount(filepath.Join(d.p.Dir, "CLAUDE.md"))) / 4
	}
	tok := item("tokens", linear(tokens, 2000, 8000))
	tok.Value = ptr(tokens)
	trunc := boolItem("truncated", true)
	memories, _ := filepath.Glob(filepath.Join(d.p.Dir, "projects", "*", "memory", "MEMORY.md"))
	sort.Strings(memories)
	for _, m := range memories {
		if lines, size := fileStats(m); lines > 200 || size > 25*1024 {
			trunc = boolItem("truncated", false)
			trunc.File = ShortPath(d.in.Home, m)
			break
		}
	}
	c := itemized("A3", source, []Item{tok, trunc})
	candidates := []string{filepath.Join(d.p.Dir, "CLAUDE.md")}
	for _, pr := range d.projects {
		candidates = append(candidates, filepath.Join(pr.dir, "CLAUDE.md"), filepath.Join(pr.dir, ".claude", "CLAUDE.md"))
	}
	for _, f := range candidates {
		if lines, _ := fileStats(f); lines > 200 {
			c.Warnings = append(c.Warnings, Warning{Code: "claude_md_long", File: ShortPath(d.in.Home, f)})
		}
	}
	c.addFix(FixOpenMemory)
	return c
}

// skillCategories là nhóm của /context có thể bớt bằng cấu hình: skill, tool MCP nạp sẵn và lời dặn của server MCP,
// agent riêng. Nhóm "(deferred)" chỉ là tên chờ nạp nên không tính.
var skillCategories = map[string]bool{"skills": true, "mcp tools": true, "mcp server instructions": true, "custom agents": true}

func claudeA4(d profileData, st ClaudeSettings) Criterion {
	ctx := d.in.Context[d.p.ID]
	if ctx == nil {
		c := unknown("A4", "context_not_measured")
		c.Fixes = []string{FixMeasureContext}
		return c
	}
	x := 0.0
	for _, cat := range ctx.Categories {
		if skillCategories[strings.ToLower(strings.TrimSpace(cat.Name))] {
			x += float64(cat.Tokens)
		}
	}
	c := valued("A4", x, 4000, 20000, "tokens", "context")
	penalty := false
	if strings.EqualFold(st.Env("ENABLE_TOOL_SEARCH"), "false") {
		penalty = true
		c.Warnings = append(c.Warnings, Warning{Code: "tool_search_off", File: ShortPath(d.in.Home, st.Path)})
	}
	cj := ReadClaudeJSON(d.in.Home, d.p)
	if cj.AlwaysLoad(d.projectDirs()) {
		penalty = true
		c.Warnings = append(c.Warnings, Warning{Code: "always_load"})
	}
	if penalty {
		c.Earned *= 0.5
		c.Status = statusOf(c.Earned, c.Max)
	}
	c.addFix(FixOpenMCP)
	return c
}

func (d profileData) projectDirs() []string {
	out := make([]string, 0, len(d.projects))
	for _, p := range d.projects {
		out = append(out, p.dir)
	}
	return out
}

// graphItems là ba mục con của A5; mcp nil là CLI không có mục này (Antigravity).
func graphItems(d profileData, mcp *bool) ([]Item, []string) {
	tool := d.in.HasTool("codegraph") || d.in.HasTool("serena")
	items := []Item{boolItem("tool", tool)}
	var fixes []string
	if !tool {
		fixes = append(fixes, FixToolGraph)
	}
	if mcp != nil {
		items = append(items, boolItem("mcp", *mcp))
		if tool && !*mcp {
			fixes = append(fixes, FixGraphMCP)
		}
	}
	if len(d.projects) == 0 {
		items = append(items, unknownItem("index", "no_projects"))
	} else {
		indexed := 0
		for _, p := range d.projects {
			if p.Codegraph {
				indexed++
			}
		}
		items = append(items, item("index", float64(indexed)/float64(len(d.projects))))
		if tool && indexed < len(d.projects) {
			fixes = append(fixes, FixGraphInit)
		}
	}
	return items, fixes
}

func claudeA5(d profileData) Criterion {
	cj := ReadClaudeJSON(d.in.Home, d.p)
	dirs := d.projectDirs()
	if len(dirs) > 1 {
		dirs = dirs[:1]
	}
	mcp := cj.HasServer("codegraph", dirs)
	for _, dir := range dirs {
		if hasMCPJSONServer(filepath.Join(dir, ".mcp.json"), "codegraph") {
			mcp = true
		}
	}
	items, fixes := graphItems(d, &mcp)
	c := itemized("A5", "tools", items)
	if c.Earned < c.Max-0.01 {
		c.Fixes = fixes
	}
	return c
}

func claudeA6(d profileData, st ClaudeSettings) Criterion {
	// Worker chưa bật RTK trên Windows (tools.go), nên không trừ điểm và không gợi ý cài.
	if d.in.GOOS == "windows" {
		return unsupported("A6", "windows_rtk_unsupported")
	}
	rtk := d.in.HasTool("rtk")
	hookItem := boolItem("hook", strings.Contains(st.Hooks("PreToolUse"), "rtk"))
	c := itemized("A6", "tools", []Item{boolItem("rtk", rtk), hookItem})
	switch {
	case !rtk:
		c.addFix(FixToolRTK)
	case *hookItem.Score == 0:
		c.addFix(FixRTK)
	}
	return c
}

func claudeA7(d profileData, st ClaudeSettings) Criterion {
	cacheOff := ""
	for k, v := range st.EnvMap() {
		if strings.HasPrefix(k, "DISABLE_PROMPT_CACHING") && v != "" && v != "0" && !strings.EqualFold(v, "false") {
			cacheOff = k
		}
	}
	cache := boolItem("cache", cacheOff == "")
	if cacheOff != "" {
		cache.File = ShortPath(d.in.Home, st.Path)
		cache.Reason = cacheOff
	}
	version := unknownItem("version", "cli_version_unknown")
	if d.p.Version != "" {
		version = boolItem("version", runner.ClaudeSupports(d.p.Version, "hook-args") && runner.ClaudeSupports(d.p.Version, "updatedToolOutput"))
		version.Reason = d.p.Version
	}
	return itemized("A7", "settings", []Item{cache, version})
}

func heavyEffort(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "xhigh", "max", "ultra":
		return true
	}
	return false
}

func claudeA8(d profileData, st ClaudeSettings) Criterion {
	effort := st.TopString("effortLevel")
	if v := st.Env("CLAUDE_CODE_EFFORT_LEVEL"); v != "" {
		effort = v
	}
	sub := st.Env("CLAUDE_CODE_SUBAGENT_MODEL")
	subItem := boolItem("subagent", sub != "" && !strings.Contains(strings.ToLower(sub), "opus"))
	c := itemized("A8", "settings", []Item{boolItem("effort", !heavyEffort(effort)), subItem})
	if *subItem.Score == 0 && d.p.Level != "aggressive" {
		c.addFix(FixAggressive)
	}
	return c
}

// --- Nhóm A: Codex ------------------------------------------------------------------------------------------------

func codexConfig(d profileData) []Criterion {
	cfg := ReadCodexConfig(filepath.Join(d.p.Dir, "config.toml"))
	if !cfg.OK {
		var out []Criterion
		for _, id := range []string{"A1", "A2", "A4", "A8"} {
			out = append(out, unknown(id, "config_unreadable"))
		}
		return append(out, codexA3(d), codexA5(d, cfg), unsupported("A6", "unsupported_cli"), unsupported("A7", "unsupported_cli"))
	}
	a1 := unknown("A1", "")
	if v, ok := cfg.Number("model_auto_compact_token_limit"); ok {
		a1 = valued("A1", v, 150_000, 400_000, "tokens", "settings")
	} else {
		a1 = valued("A1", 400_000, 150_000, 400_000, "tokens", "settings")
		a1.Value, a1.Reason = nil, "default"
	}
	out, set := cfg.Number("tool_output_token_limit")
	limit := item("toolOutput", 0.5)
	if set {
		limit = item("toolOutput", linear(out, codexOutputCap, 24_000))
		limit.Value = ptr(out)
	} else {
		limit.Reason = "default"
	}
	a2 := itemized("A2", "settings", []Item{limit})
	if set && !d.hiveSet("codex.tool_output_token_limit") {
		a2.UserSet = true
	}
	a4 := valued("A4", float64(cfg.EnabledServers()), 2, 8, "count", "settings")
	a8 := itemized("A8", "settings", []Item{
		boolItem("effort", !heavyEffort(cfg.String("model_reasoning_effort"))),
		boolItem("verbosity", !strings.EqualFold(cfg.String("model_verbosity"), "high")),
	})
	if d.p.Level == "" {
		a1.addFix(FixBalanced)
		a2.addFix(FixBalanced)
	}
	return []Criterion{a1, a2, codexA3(d), a4, codexA5(d, cfg), unsupported("A6", "unsupported_cli"),
		unsupported("A7", "unsupported_cli"), a8}
}

func codexA3(d profileData) Criterion {
	files := []string{filepath.Join(d.p.Dir, "AGENTS.md")}
	if len(d.projects) > 0 {
		files = append(files, filepath.Join(d.projects[0].dir, "AGENTS.md"))
	}
	return instructionFiles("A3", d.in.Home, files, 32*1024, 0)
}

// instructionFiles chấm A3 theo file: token ước tính (ký tự ÷ 4) và file bị CLI cắt vì quá maxBytes. budget > 0 là
// trần token chung của các file (Antigravity).
func instructionFiles(id, home string, files []string, maxBytes int64, budget float64) Criterion {
	tokens := 0.0
	trunc := boolItem("truncated", true)
	for _, f := range files {
		_, size := fileStats(f)
		tokens += float64(runeCount(f)) / 4
		if size > maxBytes && *trunc.Score == 1 {
			trunc = boolItem("truncated", false)
			trunc.File = ShortPath(home, f)
		}
	}
	if budget > 0 && tokens > budget && *trunc.Score == 1 {
		trunc = boolItem("truncated", false)
	}
	tok := item("tokens", linear(tokens, 2000, 8000))
	tok.Value = ptr(tokens)
	return itemized(id, "files", []Item{tok, trunc})
}

// codexA5: mục MCP xét bảng [mcp_servers.codegraph] có trong config.toml (plan mục 3). Server có mà `enabled = false`
// là người dùng đã cài rồi tự tắt: vẫn được điểm, ghi lý do "disabled" để giao diện hiện "có nhưng tắt", và không gợi
// ý codegraph.mcp vì `codex mcp add` sẽ ghi đè lựa chọn đó. Phần token MCP đang nạp đã do A4 tính.
func codexA5(d profileData, cfg CodexConfig) Criterion {
	present, enabled := cfg.HasServer("codegraph")
	mcp := cfg.OK && present
	items, fixes := graphItems(d, &mcp)
	if mcp && !enabled {
		for i := range items {
			if items[i].ID == "mcp" {
				items[i].Reason = "disabled"
			}
		}
	}
	c := itemized("A5", "tools", items)
	if c.Earned < c.Max-0.01 {
		c.Fixes = fixes
	}
	return c
}

// --- Antigravity: chỉ cấu hình, không tính vào điểm máy (Q6) --------------------------------------------------------

func agyConfig(d profileData) []Criterion {
	g := filepath.Join(d.in.Home, ".gemini")
	files := []string{filepath.Join(g, "GEMINI.md"), filepath.Join(g, "AGENTS.md"), filepath.Join(g, "config", "GEMINI.md"),
		filepath.Join(g, "config", "AGENTS.md")}
	rules, _ := filepath.Glob(filepath.Join(g, "config", "rules", "*.md"))
	sort.Strings(rules)
	files = append(files, rules...)
	items, _ := graphItems(d, nil)
	out := []Criterion{instructionFiles("A3", d.in.Home, files, 24_000, 20_000), itemized("A5", "tools", items)}
	for _, id := range criterionIDs {
		switch {
		case id == "A3" || id == "A5":
		case id[0] == 'B':
			out = append(out, unsupported(id, "no_token_logs"))
		default:
			out = append(out, unsupported(id, "unsupported_cli"))
		}
	}
	return out
}
