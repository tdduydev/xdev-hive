package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Guard là phần tiết kiệm token chạy bên trong run Claude Code bằng hook của chính hive-worker (`hive-worker hook
// pre-tool|post-tool`): đếm lệnh dò repo trước lần sửa đầu và chặn khi quá ngân sách, cắt output tool quá dài. Hook
// là file chạy của worker, không phải script shell, để chạy được cả trên Windows.
const (
	// GuardDirEnv là biến môi trường trỏ tới thư mục tạm của run (cấu hình, bộ đếm, output đầy đủ); hook đọc nó vì
	// Claude Code chạy hook với môi trường của CLI.
	GuardDirEnv = "HIVE_RUN_GUARD_DIR"

	defaultExploreBudget      = 4
	defaultToolOutputMaxChars = 12000
	// bigFileLines: cat file dài hơn bị từ chối (Read theo đoạn rẻ hơn); Read cả file dài hơn trước lần sửa đầu tính là
	// một lần dò repo.
	bigFileLines = 400
	// guardHookTimeout (giây) cho mỗi lần gọi hook; hook chỉ đọc vài file nhỏ.
	guardHookTimeout = 15
	// guardMarkLines: số dòng lỗi tối đa giữ lại từ phần giữa bị cắt.
	guardMarkLines = 40
)

// guardSettings áp mặc định của nhóm tiết kiệm token: pack bật, ngân sách 4, cắt ở 12000 ký tự. Nhóm tắt (máy hay dự
// án) thì tắt cả ba. 0 ở exploreBudget hay toolOutputMaxChars là tắt mục đó.
func guardSettings(cfg TokenSavingConfig, job Job) (pack bool, budget, maxChars int) {
	ts, ok := savingJob(cfg, job)
	if !ok {
		return false, 0, 0
	}
	pack, budget, maxChars = true, defaultExploreBudget, defaultToolOutputMaxChars
	if ts.ContextPack != nil {
		pack = *ts.ContextPack
	}
	if ts.ExploreBudget != nil {
		budget = max(0, *ts.ExploreBudget)
	}
	if ts.ToolOutputMaxChars != nil {
		maxChars = max(0, *ts.ToolOutputMaxChars)
	}
	return pack, budget, maxChars
}

// guardConfig là file config.json trong thư mục của run mà hook đọc.
type guardConfig struct {
	ExploreBudget int  `json:"exploreBudget"`
	MaxChars      int  `json:"maxChars"`
	CodeGraph     bool `json:"codegraph"`
	ContextPack   bool `json:"contextPack"`
}

// guardState là bộ đếm của run (state.json), hook ghi dưới khoá file vì Claude Code chạy hook của các tool gọi song song
// cùng lúc.
type guardState struct {
	Edited         bool  `json:"edited"`
	Explore        int   `json:"explore"`
	Blocked        int   `json:"blocked"`
	Truncated      int   `json:"truncated"`
	TruncatedChars int64 `json:"truncatedChars"`
}

// GuardUsage là số liệu đi kèm sự kiện cost: số file của context pack, số lệnh khảo sát bị chặn, số ký tự output đã
// cắt khỏi ngữ cảnh.
type GuardUsage struct {
	ContextPackFiles int   `json:"contextPackFiles"`
	ExploreBlocked   int   `json:"exploreBlocked"`
	TruncatedChars   int64 `json:"truncatedChars"`
}

// guardRun là thư mục tạm của một lần thử (ngoài worktree, để file output đầy đủ không bị commit).
type guardRun struct {
	dir      string
	packFile string
	hooks    []Hook
	exe      string
}

func (g *guardRun) cleanup() { _ = os.RemoveAll(g.dir) }

// usage đọc bộ đếm hook đã ghi.
func (g *guardRun) usage(packFiles int) *GuardUsage {
	u := &GuardUsage{ContextPackFiles: packFiles}
	var st guardState
	if b, err := os.ReadFile(filepath.Join(g.dir, "state.json")); err == nil && json.Unmarshal(b, &st) == nil {
		u.ExploreBlocked, u.TruncatedChars = st.Blocked, st.TruncatedChars
	}
	return u
}

// hookEntries là hook của run dạng exec (command + args, không qua shell; đã thử trên claude 2.1.296): đường dẫn có
// dấu cách hay ký tự lạ, và Windows, không cần bọc.
func (g *guardRun) hookEntries() map[string][]any {
	out := map[string][]any{}
	for _, h := range g.hooks {
		entry := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": g.exe, "args": []string{"hook", h.Command}, "timeout": guardHookTimeout}}}
		if h.Matcher != "" {
			entry["matcher"] = h.Matcher
		}
		out[h.Event] = append(out[h.Event], entry)
	}
	return out
}

// prepareGuard tạo thư mục tạm của run, ghi pack và cấu hình hook. Hook chỉ gắn cho run code của Claude Code trên máy
// (run chỉ đọc không có lần sửa nào, ngân sách trước lần sửa đầu sẽ chặn cả run plan); pack đi cùng cho mọi CLI qua
// prompt. nil khi không có gì để làm.
func (r Runner) prepareGuard(job Job, pack string, budget, maxChars int, codegraph bool) (*guardRun, error) {
	hooks := job.CLI == "claude" && r.Sandbox == nil && !readOnlyKind(job.Kind) && !r.overridden(job.CLI) &&
		claudeSupports(job.claudeVersion, "hook-args")
	var list []Hook
	if hooks && budget > 0 {
		list = append(list, Hook{Event: "PreToolUse", Command: "pre-tool", Matcher: "Bash|Read|Edit|Write|MultiEdit|NotebookEdit"})
	}
	if hooks && maxChars > 0 && claudeSupports(job.claudeVersion, "updatedToolOutput") {
		// Read không cắt: số dòng Claude hiện theo nội dung sẽ lệch sau khi cắt; Read lớn đã do ngân sách và
		// CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS lo.
		list = append(list, Hook{Event: "PostToolUse", Command: "post-tool", Matcher: "Bash|Grep|mcp__.*"})
	}
	if len(list) == 0 && pack == "" {
		return nil, nil
	}
	exe := r.HookExe
	if exe == "" && len(list) > 0 {
		var err error
		if exe, err = os.Executable(); err != nil {
			return nil, err
		}
	}
	dir := filepath.Join(r.DataDir, "guard", safeName(job.RunID)+"-"+fmt.Sprint(job.Attempt))
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(filepath.Join(dir, "out"), 0o700); err != nil {
		return nil, err
	}
	g := &guardRun{dir: dir, hooks: list, exe: exe}
	cfg, _ := json.Marshal(guardConfig{ExploreBudget: budget, MaxChars: maxChars, CodeGraph: codegraph, ContextPack: pack != ""})
	if err := os.WriteFile(filepath.Join(dir, "config.json"), cfg, 0o600); err != nil {
		g.cleanup()
		return nil, err
	}
	if pack != "" {
		g.packFile = filepath.Join(dir, "context-pack.md")
		if err := os.WriteFile(g.packFile, []byte(pack), 0o600); err != nil {
			g.cleanup()
			return nil, err
		}
	}
	return g, nil
}

// --- Hook --------------------------------------------------------------------------------------------------------------

type hookInput struct {
	Event        string          `json:"hook_event_name"`
	Tool         string          `json:"tool_name"`
	ToolInput    json.RawMessage `json:"tool_input"`
	ToolResponse json.RawMessage `json:"tool_response"`
	ToolUseID    string          `json:"tool_use_id"`
	Cwd          string          `json:"cwd"`
}

// HookMain là `hive-worker hook pre-tool|post-tool [--local]`. Mọi lỗi đều cho tool chạy như thường (thoát 0, không in
// gì): hook hỏng không được chặn việc của agent.
func HookMain(args []string, stdin io.Reader, stdout io.Writer) int {
	dir := os.Getenv(GuardDirEnv)
	if len(args) == 2 && args[1] == "--local" {
		// Run của worker dùng settings.json của gói đã bật tối ưu thì hook cục bộ cũng được gọi; guard của run đã lo
		// phần đó, chạy thêm sẽ đếm và cắt hai lần.
		if dir != "" {
			return 0
		}
		return localHookMain(args[0], stdin, stdout)
	}
	if len(args) != 1 || dir == "" {
		return 0
	}
	var in hookInput
	if err := json.NewDecoder(io.LimitReader(stdin, 64<<20)).Decode(&in); err != nil {
		return 0
	}
	var cfg guardConfig
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil || json.Unmarshal(b, &cfg) != nil {
		return 0
	}
	var reply any
	switch args[0] {
	case "pre-tool":
		reply = preTool(dir, cfg, in)
	case "post-tool":
		reply = postTool(dir, cfg, in)
	}
	if reply != nil {
		_ = json.NewEncoder(stdout).Encode(reply)
	}
	return 0
}

// withState đọc, sửa và ghi state.json dưới khoá file.
func withState(dir string, fn func(*guardState)) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f, err := lockFile(ctx, filepath.Join(dir, "state.lock"))
	if err != nil {
		return
	}
	defer func() { _ = unlockFile(f); _ = f.Close() }()
	p := filepath.Join(dir, "state.json")
	var st guardState
	if b, err := os.ReadFile(p); err == nil {
		_ = json.Unmarshal(b, &st)
	}
	fn(&st)
	if b, err := json.Marshal(st); err == nil {
		tmp := p + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, p)
		}
	}
}

func deny(reason string) map[string]any {
	return map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":            "PreToolUse",
		"permissionDecision":       "deny",
		"permissionDecisionReason": reason,
	}}
}

// preTool đếm lệnh dò repo trước lần sửa đầu; quá ngân sách thì từ chối kèm hướng dẫn. cat file lớn bị từ chối mọi lúc.
func preTool(dir string, cfg guardConfig, in hookInput) any {
	var reply any
	switch in.Tool {
	case "Edit", "Write", "MultiEdit", "NotebookEdit":
		withState(dir, func(st *guardState) { st.Edited = true })
		return nil
	case "Bash":
		var ti struct {
			Command string `json:"command"`
		}
		if json.Unmarshal(in.ToolInput, &ti) != nil {
			return nil
		}
		if big := bigCat(ti.Command, in.Cwd); big != "" {
			withState(dir, func(st *guardState) { st.Blocked++ })
			return deny(fmt.Sprintf("%s dài hơn %d dòng: đọc bằng Read với offset/limit (hoặc rg -n trong file đó) thay vì cat cả file.", big, bigFileLines))
		}
		if !exploreCommand(ti.Command) {
			return nil
		}
	case "Read":
		var ti struct {
			FilePath string `json:"file_path"`
			Offset   *int   `json:"offset"`
			Limit    *int   `json:"limit"`
		}
		if json.Unmarshal(in.ToolInput, &ti) != nil || ti.Offset != nil || ti.Limit != nil || countLines(resolvePath(ti.FilePath, in.Cwd), bigFileLines+1) <= bigFileLines {
			return nil
		}
	default:
		return nil
	}
	withState(dir, func(st *guardState) {
		if st.Edited {
			return
		}
		st.Explore++
		if st.Explore > cfg.ExploreBudget {
			st.Blocked++
			reply = deny(exploreReason(cfg, in.Tool))
		}
	})
	return reply
}

func exploreReason(cfg guardConfig, tool string) string {
	var where []string
	if cfg.ContextPack {
		where = append(where, "context pack trong prompt hệ thống")
	}
	where = append(where, "brief của dự án")
	if cfg.CodeGraph {
		where = append(where, "tool MCP codegraph_explore")
	}
	msg := fmt.Sprintf("Đã hết ngân sách khảo sát (%d lệnh dò repo trước lần sửa đầu). Dùng %s; tìm bằng Grep/rg với thư mục cụ thể, đọc file bằng Read có offset/limit.", cfg.ExploreBudget, strings.Join(where, ", "))
	if tool == "Read" {
		msg += " File này dài: đọc theo đoạn."
	}
	return msg
}

var (
	shellSplitRe = regexp.MustCompile(`\|\||&&|;|\n`)
	// rgValueFlags là cờ của rg/grep nhận giá trị ở đối số sau, để không nhầm giá trị là đường dẫn.
	rgValueFlags = map[string]bool{"-e": true, "--regexp": true, "-g": true, "--glob": true, "-t": true, "--type": true,
		"-T": true, "--type-not": true, "-A": true, "-B": true, "-C": true, "-m": true, "--max-count": true, "-f": true,
		"--file": true, "-M": true, "--max-columns": true, "-j": true, "--threads": true, "--include": true, "--exclude": true,
		"--max-depth": true, "-d": true}
)

// commandWords tách một đoạn lệnh thành từ, bỏ gán biến đầu dòng và tiền tố không đổi nghĩa (rtk, sudo, time...).
func commandWords(seg string) []string {
	words := strings.Fields(seg)
	for len(words) > 0 {
		w := words[0]
		if strings.Contains(w, "=") && !strings.HasPrefix(w, "-") || w == "rtk" || w == "sudo" || w == "time" || w == "command" || w == "nice" {
			words = words[1:]
			continue
		}
		break
	}
	for i := range words {
		words[i] = strings.Trim(words[i], `"'`)
	}
	return words
}

// exploreCommand nhận lệnh dò repo: ls -R, find, tree, fd, grep -r, rg/ag không đường dẫn cụ thể, git grep không
// pathspec, git ls-files cả repo.
func exploreCommand(cmd string) bool {
	for _, seg := range shellSplitRe.Split(cmd, -1) {
		// Chỉ đoạn đầu của pipe đọc repo; rg, grep sau `|` lọc output của lệnh trước.
		seg = firstStage(seg)
		w := commandWords(seg)
		if len(w) == 0 {
			continue
		}
		args := w[1:]
		switch filepath.Base(w[0]) {
		case "find", "tree", "fd", "fdfind", "du":
			return true
		case "ls":
			for _, a := range args {
				if a == "--recursive" || strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.Contains(a, "R") {
					return true
				}
			}
		case "grep", "egrep", "fgrep":
			for _, a := range args {
				if a == "--recursive" || a == "--dereference-recursive" || strings.HasPrefix(a, "-") && !strings.HasPrefix(a, "--") && strings.ContainsAny(a, "rR") {
					return broadSearch(args)
				}
			}
		case "rg", "ag", "ack":
			return broadSearch(args)
		case "git":
			if len(args) > 0 && args[0] == "grep" {
				return !containsString(args, "--")
			}
			if len(args) == 1 && args[0] == "ls-files" {
				return true
			}
		}
	}
	return false
}

// firstStage cắt lệnh ở dấu | đầu tiên nằm ngoài nháy (mẫu `rg "a|b"` không phải pipe).
func firstStage(seg string) string {
	var quote rune
	for i, c := range seg {
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '"' || c == '\'':
			quote = c
		case c == '|':
			return seg[:i]
		}
	}
	return seg
}

// broadSearch: lệnh tìm chỉ có mẫu, hoặc đường dẫn là gốc repo, là dò cả repo.
func broadSearch(args []string) bool {
	var pos []string
	pattern := false
	for i := 0; i < len(args); i++ {
		a := args[i]
		if strings.HasPrefix(a, "-") {
			if a == "-e" || a == "--regexp" || a == "-f" || a == "--file" {
				pattern = true
			}
			if rgValueFlags[a] {
				i++
			}
			continue
		}
		pos = append(pos, a)
	}
	if !pattern && len(pos) > 0 {
		pos = pos[1:]
	}
	if len(pos) == 0 {
		return true
	}
	for _, p := range pos {
		switch strings.TrimRight(p, "/") {
		case "", ".", "~", "$HOME", "*":
			return true
		}
	}
	return false
}

// bigCat trả đường dẫn file dài khi lệnh là cat file đưa thẳng ra output (không qua pipe hay chuyển hướng).
func bigCat(cmd, cwd string) string {
	if strings.ContainsAny(cmd, "|><") {
		return ""
	}
	for _, seg := range shellSplitRe.Split(cmd, -1) {
		w := commandWords(seg)
		if len(w) < 2 || filepath.Base(w[0]) != "cat" {
			continue
		}
		for _, a := range w[1:] {
			if strings.HasPrefix(a, "-") {
				continue
			}
			if countLines(resolvePath(a, cwd), bigFileLines+1) > bigFileLines {
				return a
			}
		}
	}
	return ""
}

func resolvePath(p, cwd string) string {
	if p == "" || filepath.IsAbs(p) || cwd == "" {
		return p
	}
	return filepath.Join(cwd, p)
}

// countLines đếm tới limit dòng (file không đọc được là 0).
func countLines(p string, limit int) int {
	f, err := os.Open(p)
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	n := 0
	for n < limit && sc.Scan() {
		n++
	}
	return n
}

// --- Cắt output -------------------------------------------------------------------------------------------------------

var errorLineRe = regexp.MustCompile(`(?i)\b(error|errors|fail|failed|failure|failing|warn|warning|panic|fatal|exception)\b|FAIL|✗|✘`)

// postTool cắt output quá maxChars: giữ đầu, cuối và dòng báo lỗi ở giữa, ghi bản đầy đủ ra file của run. Output là
// object theo từng tool (Bash: stdout, stderr...); chỉ thay chuỗi bên trong để giữ đúng hình dạng, vì Claude Code bỏ
// qua updatedToolOutput sai hình dạng của tool có sẵn.
func postTool(dir string, cfg guardConfig, in hookInput) any {
	if cfg.MaxChars <= 0 || len(in.ToolResponse) <= cfg.MaxChars {
		return nil
	}
	var resp any
	if json.Unmarshal(in.ToolResponse, &resp) != nil {
		return nil
	}
	var total int
	walkStrings(resp, func(s string) string { total += len(s); return s })
	if total <= cfg.MaxChars {
		return nil
	}
	name := safeName(in.ToolUseID)
	if name == "" {
		name = fmt.Sprint(time.Now().UnixNano())
	}
	full := filepath.Join(dir, "out", name+".txt")
	var dump bytes.Buffer
	walkStrings(resp, func(s string) string {
		if len(s) > 0 {
			dump.WriteString(s)
			if !strings.HasSuffix(s, "\n") {
				dump.WriteString("\n")
			}
		}
		return s
	})
	if os.WriteFile(full, dump.Bytes(), 0o600) != nil {
		return nil
	}
	var cut int64
	resp = walkStrings(resp, func(s string) string {
		// Mỗi chuỗi được phần ngân sách theo tỉ lệ độ dài; chuỗi ngắn giữ nguyên.
		allow := max(1000, cfg.MaxChars*len(s)/total)
		if len(s) <= allow {
			return s
		}
		t := truncateKeep(s, allow, full)
		cut += int64(len(s) - len(t))
		return t
	})
	if cut <= 0 {
		return nil
	}
	withState(dir, func(st *guardState) {
		st.Truncated++
		st.TruncatedChars += cut
	})
	return map[string]any{"hookSpecificOutput": map[string]any{
		"hookEventName":     "PostToolUse",
		"updatedToolOutput": resp,
	}}
}

// walkStrings thay mọi chuỗi trong JSON đã decode bằng fn (khoá giữ nguyên).
func walkStrings(v any, fn func(string) string) any {
	switch x := v.(type) {
	case string:
		return fn(x)
	case map[string]any:
		for _, k := range jsonKeys(x) {
			x[k] = walkStrings(x[k], fn)
		}
		return x
	case []any:
		for i := range x {
			x[i] = walkStrings(x[i], fn)
		}
		return x
	}
	return v
}

func jsonKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Thứ tự cố định để file đầy đủ giống nhau giữa các lần (stdout trước stderr theo bảng chữ cái).
	sort.Strings(keys)
	return keys
}

// truncateKeep giữ ~45% đầu và ~45% cuối của allow, cộng tối đa guardMarkLines dòng lỗi ở phần giữa.
func truncateKeep(s string, allow int, full string) string {
	headN, tailN := allow*45/100, allow*45/100
	head, mid, tail := s[:headN], s[headN:len(s)-tailN], s[len(s)-tailN:]
	// Cắt ở ranh giới dòng để không để lại nửa dòng (và nửa ký tự UTF-8).
	if i := strings.LastIndexByte(head, '\n'); i > 0 {
		mid, head = head[i+1:]+mid, head[:i+1]
	}
	if i := strings.IndexByte(tail, '\n'); i >= 0 && i < len(tail)-1 {
		mid, tail = mid+tail[:i+1], tail[i+1:]
	}
	var marks []string
	budget := allow / 10
	for _, line := range strings.Split(mid, "\n") {
		if len(marks) >= guardMarkLines || budget <= 0 {
			break
		}
		if errorLineRe.MatchString(line) {
			if len(line) > 300 {
				line = strings.ToValidUTF8(line[:300], "") + "…"
			}
			marks = append(marks, line)
			budget -= len(line)
		}
	}
	var b strings.Builder
	b.WriteString(head)
	fmt.Fprintf(&b, "\n[xdev-hive] Đã cắt %d ký tự ở giữa output; bản đầy đủ: %s (đọc bằng Read với offset/limit hoặc rg -n trên file đó).\n", len(mid), full)
	if len(marks) > 0 {
		b.WriteString("[xdev-hive] Dòng lỗi/cảnh báo trong phần đã cắt:\n")
		b.WriteString(strings.Join(marks, "\n"))
		b.WriteString("\n[xdev-hive] Hết phần trích.\n")
	}
	b.WriteString(tail)
	return b.String()
}

// packInSystemPrompt: Claude Code trên máy nhận pack qua --append-system-prompt-file; CLI khác, Claude trong sandbox
// (không thấy thư mục của run) hay bản Claude chưa kiểm cờ đó thì nhận ở đầu prompt.
func (r Runner) packInSystemPrompt(job Job) bool {
	return job.CLI == "claude" && r.Sandbox == nil && !r.overridden(job.CLI) && claudeSupports(job.claudeVersion, "--append-system-prompt-file")
}

// contextPack dựng pack trong contextPackTimeout và ghi vào log của run; lỗi hay hết giờ thì chạy không có pack.
func (r Runner) contextPack(ctx context.Context, job Job, work string, log io.Writer) (string, int) {
	ctx, cancel := context.WithTimeout(ctx, contextPackTimeout)
	defer cancel()
	start := time.Now()
	var commands []string
	if job.BriefSHA == "" {
		commands = buildCommands(work)
	}
	pack, err := buildContextPack(ctx, work, packQuery(job), job.codegraph, commands)
	if err != nil || ctx.Err() != nil {
		_, _ = fmt.Fprintf(log, "[xdev-hive] Chạy run không có context pack: %v\n", errors.Join(err, ctx.Err()))
		return "", 0
	}
	if pack.Text == "" {
		_, _ = fmt.Fprintln(log, "[xdev-hive] Context pack: không tìm được file liên quan từ mô tả task.")
		return "", 0
	}
	_, _ = fmt.Fprintf(log, "[xdev-hive] Context pack: %d file (~%d token, %.1f giây).\n%s\n", len(pack.Files), len(pack.Text)*2/7, time.Since(start).Seconds(), pack.Text)
	return pack.Text, len(pack.Files)
}
