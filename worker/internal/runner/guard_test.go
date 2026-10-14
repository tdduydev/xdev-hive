package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// guardDir tạo thư mục guard như prepareGuard và đặt biến môi trường cho HookMain.
func guardDir(t *testing.T, cfg guardConfig) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "out"), 0o700); err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(dir, "config.json"), b, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv(GuardDirEnv, dir)
	return dir
}

// callHook chạy HookMain như Claude Code gọi và trả JSON đã in (nil khi hook không in gì).
func callHook(t *testing.T, sub string, input map[string]any) map[string]any {
	t.Helper()
	in, _ := json.Marshal(input)
	var out bytes.Buffer
	if code := HookMain([]string{sub}, bytes.NewReader(in), &out); code != 0 {
		t.Fatalf("hook thoát %d", code)
	}
	if out.Len() == 0 {
		return nil
	}
	var reply map[string]any
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil {
		t.Fatalf("hook in %q: %v", out.String(), err)
	}
	return reply
}

func bash(cmd string) map[string]any {
	return map[string]any{"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": cmd}}
}

func denied(reply map[string]any) string {
	h, _ := reply["hookSpecificOutput"].(map[string]any)
	if h == nil || h["permissionDecision"] != "deny" || h["hookEventName"] != "PreToolUse" {
		return ""
	}
	s, _ := h["permissionDecisionReason"].(string)
	return s
}

func readState(t *testing.T, dir string) guardState {
	t.Helper()
	var st guardState
	b, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err == nil {
		_ = json.Unmarshal(b, &st)
	}
	return st
}

func TestExploreCommand(t *testing.T) {
	cases := map[string]bool{
		"ls -R":                          true,
		"ls -la apps/hub":                false,
		"find . -name '*.go'":            true,
		"tree -L 2":                      true,
		"grep -rn foo .":                 true,
		"grep -n foo apps/hub/a.ts":      false,
		"rg LoginHandler":                true,
		"rg -n LoginHandler .":           true,
		"rg -n LoginHandler apps/hub":    false,
		"rg -g '*.ts' -e foo":            true,
		"rg -t go foo worker/internal":   false,
		"cd apps && rg foo":              true,
		"git grep foo":                   true,
		"git grep foo -- worker":         false,
		"git ls-files":                   true,
		"git status":                     false,
		"FOO=1 rtk find . -type f":       true,
		"go test ./...":                  false,
		"pnpm --filter @x/hub test":      false,
		"cat package.json | rg version":  false,
		"find . -name x | head":          true,
		`rg -n "foo|bar" apps/hub`:       false,
		"echo find":                      false,
		"sed -n 1,40p worker/runner.go":  false,
		"git log --oneline -5 | head -3": false,
	}
	for cmd, want := range cases {
		if got := exploreCommand(cmd); got != want {
			t.Errorf("exploreCommand(%q) = %v, muốn %v", cmd, got, want)
		}
	}
}

func TestPreToolDeniesAfterBudgetUntilFirstEdit(t *testing.T) {
	dir := guardDir(t, guardConfig{ExploreBudget: 2, ContextPack: true, CodeGraph: true})
	for i := range 2 {
		if r := callHook(t, "pre-tool", bash("rg foo")); r != nil {
			t.Fatalf("lệnh dò thứ %d bị chặn: %v", i+1, r)
		}
	}
	// Lệnh thường không tính vào ngân sách.
	if r := callHook(t, "pre-tool", bash("go test ./...")); r != nil {
		t.Fatalf("go test bị chặn: %v", r)
	}
	reason := denied(callHook(t, "pre-tool", bash("find . -name x")))
	if !strings.Contains(reason, "ngân sách khảo sát") || !strings.Contains(reason, "context pack") || !strings.Contains(reason, "codegraph_explore") {
		t.Fatalf("lý do = %q", reason)
	}
	callHook(t, "pre-tool", map[string]any{"tool_name": "Edit", "tool_input": map[string]any{"file_path": "a.go"}})
	if r := callHook(t, "pre-tool", bash("find . -name x")); r != nil {
		t.Fatalf("sau lần sửa đầu vẫn chặn: %v", r)
	}
	if st := readState(t, dir); st.Explore != 3 || st.Blocked != 1 || !st.Edited {
		t.Fatalf("state = %+v", st)
	}
}

func TestPreToolCatOfBigFileSuggestsRead(t *testing.T) {
	guardDir(t, guardConfig{ExploreBudget: 4})
	work := t.TempDir()
	mustDir(t, work, "big.txt", strings.Repeat("dòng\n", bigFileLines+10))
	mustDir(t, work, "small.txt", "a\nb\n")
	in := bash("cat big.txt")
	in["cwd"] = work
	if reason := denied(callHook(t, "pre-tool", in)); !strings.Contains(reason, "big.txt") || !strings.Contains(reason, "offset/limit") {
		t.Fatalf("lý do = %q", reason)
	}
	for _, cmd := range []string{"cat small.txt", "cat big.txt | head -5", "cat big.txt > /dev/null"} {
		in := bash(cmd)
		in["cwd"] = work
		if r := callHook(t, "pre-tool", in); r != nil {
			t.Fatalf("%q bị chặn: %v", cmd, r)
		}
	}
}

// Read cả file dài trước lần sửa đầu tính vào ngân sách; Read có offset/limit hay file ngắn thì không.
func TestPreToolCountsFullReadOfBigFile(t *testing.T) {
	dir := guardDir(t, guardConfig{ExploreBudget: 1})
	work := t.TempDir()
	mustDir(t, work, "big.go", strings.Repeat("x\n", bigFileLines+1))
	mustDir(t, work, "small.go", "x\n")
	read := func(file string, limit bool) map[string]any {
		ti := map[string]any{"file_path": filepath.Join(work, file)}
		if limit {
			ti["offset"], ti["limit"] = 1, 50
		}
		return map[string]any{"tool_name": "Read", "tool_input": ti}
	}
	for _, in := range []map[string]any{read("small.go", false), read("big.go", true), read("big.go", false)} {
		if r := callHook(t, "pre-tool", in); r != nil {
			t.Fatalf("bị chặn: %v", r)
		}
	}
	if reason := denied(callHook(t, "pre-tool", read("big.go", false))); !strings.Contains(reason, "đọc theo đoạn") {
		t.Fatalf("lý do = %q", reason)
	}
	if st := readState(t, dir); st.Explore != 2 || st.Blocked != 1 {
		t.Fatalf("state = %+v", st)
	}
}

// Claude Code chạy hook của các tool gọi song song cùng lúc: bộ đếm không được mất lần nào.
func TestPreToolCountsUnderConcurrency(t *testing.T) {
	dir := guardDir(t, guardConfig{ExploreBudget: 5})
	in, _ := json.Marshal(bash("find ."))
	var wg sync.WaitGroup
	var mu sync.Mutex
	deniedN := 0
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var out bytes.Buffer
			HookMain([]string{"pre-tool"}, bytes.NewReader(in), &out)
			if out.Len() > 0 {
				mu.Lock()
				deniedN++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if st := readState(t, dir); deniedN != 15 || st.Explore != 20 || st.Blocked != 15 {
		t.Fatalf("chặn %d, state %+v", deniedN, st)
	}
}

// Hook hỏng (thiếu thư mục, cấu hình, input lạ) không được chặn tool.
func TestHookFailsOpen(t *testing.T) {
	t.Setenv(GuardDirEnv, "")
	if r := callHook(t, "pre-tool", bash("find .")); r != nil {
		t.Fatal(r)
	}
	t.Setenv(GuardDirEnv, t.TempDir())
	if r := callHook(t, "pre-tool", bash("find .")); r != nil {
		t.Fatal(r)
	}
	var out bytes.Buffer
	if HookMain([]string{"pre-tool"}, strings.NewReader("rác"), &out) != 0 || out.Len() != 0 {
		t.Fatal(out.String())
	}
}

func TestPostToolTruncatesKeepingErrorLines(t *testing.T) {
	dir := guardDir(t, guardConfig{MaxChars: 2000})
	var b strings.Builder
	for i := range 2000 {
		switch i {
		case 1000:
			b.WriteString("--- FAIL: TestLogin (0.01s)\n")
		case 1200:
			b.WriteString("panic: runtime error: index out of range\n")
		default:
			fmt.Fprintf(&b, "ok dòng %d\n", i)
		}
	}
	stdout := b.String()
	reply := callHook(t, "post-tool", map[string]any{
		"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "toolu_01",
		"tool_input":    map[string]any{"command": "go test ./..."},
		"tool_response": map[string]any{"stdout": stdout, "stderr": "", "interrupted": false, "isImage": false},
	})
	h, _ := reply["hookSpecificOutput"].(map[string]any)
	if h == nil || h["hookEventName"] != "PostToolUse" {
		t.Fatalf("reply = %v", reply)
	}
	out, _ := h["updatedToolOutput"].(map[string]any)
	got, _ := out["stdout"].(string)
	// Giữ đúng hình dạng output của Bash, nếu không Claude Code bỏ qua.
	if out["interrupted"] != false || out["isImage"] != false || out["stderr"] != "" {
		t.Fatalf("output = %v", out)
	}
	full := filepath.Join(dir, "out", "toolu_01.txt")
	for _, want := range []string{"ok dòng 0\n", "ok dòng 1999\n", "--- FAIL: TestLogin", "panic: runtime error", full} {
		if !strings.Contains(got, want) {
			t.Fatalf("thiếu %q trong:\n%s", want, got)
		}
	}
	if len(got) > 3000 {
		t.Fatalf("còn %d ký tự", len(got))
	}
	saved, err := os.ReadFile(full)
	if err != nil || string(saved) != stdout {
		t.Fatalf("bản đầy đủ sai: %v", err)
	}
	if st := readState(t, dir); st.Truncated != 1 || st.TruncatedChars != int64(len(stdout)-len(got)) {
		t.Fatalf("state = %+v", st)
	}
}

func TestPostToolLeavesShortOutput(t *testing.T) {
	guardDir(t, guardConfig{MaxChars: 2000})
	if r := callHook(t, "post-tool", map[string]any{"tool_name": "Bash", "tool_response": map[string]any{"stdout": "ngắn", "stderr": ""}}); r != nil {
		t.Fatal(r)
	}
	guardDir(t, guardConfig{MaxChars: 0})
	if r := callHook(t, "post-tool", map[string]any{"tool_name": "Bash", "tool_response": map[string]any{"stdout": strings.Repeat("x", 50000)}}); r != nil {
		t.Fatal("maxChars 0 là tắt")
	}
}

func TestGuardSettingsDefaultsAndOff(t *testing.T) {
	zero, off := 0, false
	cases := []struct {
		name               string
		cfg                TokenSavingConfig
		ts                 *TokenSavingJob
		pack               bool
		budget, outputSize int
	}{
		{"hub cũ", TokenSavingConfig{}, nil, true, 4, 12000},
		{"dự án tắt nhóm", TokenSavingConfig{}, &TokenSavingJob{Enabled: false}, false, 0, 0},
		{"máy tắt", TokenSavingConfig{Off: true}, nil, false, 0, 0},
		{"tắt từng mục", TokenSavingConfig{}, &TokenSavingJob{Enabled: true, ContextPack: &off, ExploreBudget: &zero, ToolOutputMaxChars: &zero}, false, 0, 0},
	}
	for _, c := range cases {
		pack, budget, size := guardSettings(c.cfg, Job{CLI: "claude", TokenSaving: c.ts})
		if pack != c.pack || budget != c.budget || size != c.outputSize {
			t.Errorf("%s: %v %d %d", c.name, pack, budget, size)
		}
	}
}

// Hook của run dạng exec (command + args): đường dẫn có dấu cách và đường dẫn Windows không cần bọc theo shell.
func TestClaudeCommandCarriesGuardHooksAndPack(t *testing.T) {
	exe := `C:\Program Files\xDev Hive\hive-worker.exe`
	r := Runner{DataDir: t.TempDir(), HookExe: exe}
	job := Job{RunID: "g1", Attempt: 1, CLI: "claude", Kind: "code", claudeVersion: "2.1.296", Env: map[string]string{}}
	g, err := r.prepareGuard(job, "# Context pack\n", 4, 12000, false)
	if err != nil || g == nil {
		t.Fatal(g, err)
	}
	defer g.cleanup()
	job.guard = g
	cmd, err := r.cliCommand(job)
	if err != nil {
		t.Fatal(err)
	}
	if cmd.cleanup != nil {
		defer cmd.cleanup()
	}
	args := cmd.Args
	settings := argAfter(args, "--settings")
	var parsed struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Type    string   `json:"type"`
				Command string   `json:"command"`
				Args    []string `json:"args"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(settings), &parsed); err != nil {
		t.Fatalf("--settings %q: %v", settings, err)
	}
	pre, post := parsed.Hooks["PreToolUse"], parsed.Hooks["PostToolUse"]
	if len(pre) != 1 || pre[0].Hooks[0].Command != exe || strings.Join(pre[0].Hooks[0].Args, " ") != "hook pre-tool" || !strings.Contains(pre[0].Matcher, "Bash") {
		t.Fatalf("PreToolUse = %+v", pre)
	}
	if len(post) != 1 || strings.Join(post[0].Hooks[0].Args, " ") != "hook post-tool" || strings.Contains(post[0].Matcher, "Read") {
		t.Fatalf("PostToolUse = %+v", post)
	}
	if argAfter(args, "--append-system-prompt-file") != g.packFile || argAfter(args, "--add-dir") != g.dir {
		t.Fatalf("args = %v", args)
	}
	if b, _ := os.ReadFile(g.packFile); string(b) != "# Context pack\n" {
		t.Fatalf("pack = %q", b)
	}
}

// Bản claude chưa kiểm thì không gắn hook và không dùng cờ mới; pack đi vào prompt (packInSystemPrompt false).
func TestGuardNeedsKnownClaudeVersion(t *testing.T) {
	r := Runner{DataDir: t.TempDir(), HookExe: "/x/hive-worker"}
	job := Job{RunID: "g2", Attempt: 1, CLI: "claude", Kind: "code", claudeVersion: "2.1.100"}
	g, err := r.prepareGuard(job, "pack", 4, 12000, false)
	if err != nil || g == nil || len(g.hooks) != 0 {
		t.Fatalf("%+v %v", g, err)
	}
	defer g.cleanup()
	if r.packInSystemPrompt(job) {
		t.Fatal("bản cũ không nhận --append-system-prompt-file")
	}
	// Run chỉ đọc không có hook: chưa có lần sửa nào nên ngân sách sẽ chặn cả run plan.
	plan := Job{RunID: "g3", Attempt: 1, CLI: "claude", Kind: KindPlan, claudeVersion: "2.1.296"}
	if g, _ := r.prepareGuard(plan, "", 4, 12000, false); g != nil {
		t.Fatalf("run plan có guard: %+v", g)
	}
}

func argAfter(args []string, flag string) string {
	for i, a := range args {
		if a == flag && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

// Run Claude Code trên máy (README và .gitkeep cùng commit đầu nên pack có cả hai): pack vào --append-system-prompt-file, hook của worker vào --settings, số guard đi trong
// sự kiện cost cuối, thư mục của run bị dọn.
func TestRunAttachesGuardToClaude(t *testing.T) {
	t.Setenv("PATH", installFakeClaude(t)+string(os.PathListSeparator)+os.Getenv("PATH"))
	capture := filepath.Join(t.TempDir(), "claude.json")
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), ClaudeVersion: "2.1.296", HookExe: "/opt/hive/hive-worker", TokenSaving: &TokenSavingConfig{}, RTK: &ToolConfig{Off: true}, CodeGraph: &ToolConfig{Off: true}}
	_ = r.Run(context.Background(), Job{
		RunID: "guard", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/guard", CLI: "claude", Prompt: "p", TaskText: "Sửa `README` cho rõ", Timeout: 30 * time.Second,
		Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret", "HIVE_FAKE_MCP_MODE": "exit", "HIVE_CAPTURE_MCP": filepath.Join(t.TempDir(), "mcp"), "HIVE_CAPTURE_CLAUDE": capture},
	}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	var got struct {
		Args  []string `json:"args"`
		Guard string   `json:"guard"`
	}
	b, err := os.ReadFile(capture)
	if err != nil || json.Unmarshal(b, &got) != nil {
		t.Fatalf("claude giả không chạy: %s, %v; log %s", b, err, logText(events))
	}
	if got.Guard == "" || argAfter(got.Args, "--append-system-prompt-file") != filepath.Join(got.Guard, "context-pack.md") {
		t.Fatalf("args = %v, guard = %q", got.Args, got.Guard)
	}
	if s := argAfter(got.Args, "--settings"); !strings.Contains(s, `"args":["hook","pre-tool"]`) || !strings.Contains(s, `"args":["hook","post-tool"]`) {
		t.Fatalf("--settings = %s", s)
	}
	var last *Usage
	for _, e := range events {
		if e.Type == "cost" {
			last = e.Cost
		}
	}
	if last == nil || last.Guard == nil || *last.Guard != (GuardUsage{ContextPackFiles: 2, ExploreBlocked: 2, TruncatedChars: 500}) {
		t.Fatalf("cost cuối = %+v; log %s", last, logText(events))
	}
	if log := logText(events); !strings.Contains(log, "Context pack: 2 file") || !strings.Contains(log, "`README`") {
		t.Fatalf("log = %s", log)
	}
	if _, err := os.Stat(got.Guard); !os.IsNotExist(err) {
		t.Fatalf("thư mục guard còn lại: %v", err)
	}
}

// Codex không có hook thay được output: chỉ nhận pack ở đầu prompt, không có --settings hay thư mục guard trong cờ.
func TestRunPrependsPackForCodex(t *testing.T) {
	t.Setenv("PATH", installFakeCLI(t, "codex")+string(os.PathListSeparator)+os.Getenv("PATH"))
	capture := filepath.Join(t.TempDir(), "codex.json")
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), TokenSaving: &TokenSavingConfig{}, RTK: &ToolConfig{Off: true}, CodeGraph: &ToolConfig{Off: true}}
	_ = r.Run(context.Background(), Job{
		RunID: "gcx", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/gcx", CLI: "codex", Prompt: "brief\n\n---\n\nSửa `README`", Timeout: 30 * time.Second,
		Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret", "HIVE_FAKE_MCP_MODE": "exit", "HIVE_CAPTURE_MCP": filepath.Join(t.TempDir(), "mcp"), "HIVE_CAPTURE_CLAUDE": capture},
	}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	var got struct {
		Args []string `json:"args"`
	}
	b, err := os.ReadFile(capture)
	if err != nil || json.Unmarshal(b, &got) != nil || len(got.Args) == 0 {
		t.Fatalf("codex giả không chạy: %s, %v; log %s", b, err, logText(events))
	}
	prompt := got.Args[len(got.Args)-1]
	if !strings.HasPrefix(prompt, "# Context pack của run") || !strings.HasSuffix(prompt, "---\n\nbrief\n\n---\n\nSửa `README`") {
		t.Fatalf("prompt = %q", prompt)
	}
	if strings.Contains(strings.Join(got.Args, " "), "hook") {
		t.Fatalf("codex nhận hook: %v", got.Args)
	}
}
