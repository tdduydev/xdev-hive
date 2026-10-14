package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// fakeTool cho binary test đóng vai rtk hoặc codegraph khi được chép thành file tên đó (installFakeCLI). Hành vi theo
// HIVE_FAKE_RTK, HIVE_FAKE_CODEGRAPH; lệnh đã chạy và biến môi trường nhận được ghi vào HIVE_FAKE_TOOL_LOG.
func fakeTool() {
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	mode := map[string]string{"rtk": os.Getenv("HIVE_FAKE_RTK"), "codegraph": os.Getenv("HIVE_FAKE_CODEGRAPH")}[name]
	if mode == "" {
		return
	}
	if p := os.Getenv("HIVE_FAKE_TOOL_LOG"); p != "" {
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err == nil {
			env := []string{}
			for _, k := range []string{"RTK_TELEMETRY_DISABLED", "RTK_SUPPRESS_HOOK_WARNING", "CODEGRAPH_TELEMETRY", "DO_NOT_TRACK", "CODEGRAPH_NO_DAEMON"} {
				env = append(env, k+"="+os.Getenv(k))
			}
			_, _ = fmt.Fprintf(f, "%s %s | %s\n", name, strings.Join(os.Args[1:], " "), strings.Join(env, " "))
			_ = f.Close()
		}
	}
	if mode == "fail" {
		os.Exit(4)
	}
	args := strings.Join(os.Args[1:], " ")
	switch {
	case name == "rtk" && args == "hook claude":
		if mode == "garbage" {
			fmt.Println("không phải JSON")
			os.Exit(0)
		}
		fmt.Println(`{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"rtk git status"}}}`)
	case name == "rtk" && args == "gain --format json":
		fmt.Println(`{"summary":{"total_commands":4,"total_input":5000,"total_output":1766,"total_saved":3234,"avg_savings_pct":64.7}}`)
	case name == "codegraph" && (os.Args[1] == "init" || os.Args[1] == "sync"):
		dir := filepath.Join(os.Args[len(os.Args)-1], codegraphDir)
		if os.MkdirAll(dir, 0o755) != nil {
			os.Exit(5)
		}
		f, err := os.OpenFile(filepath.Join(dir, "codegraph.db"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			os.Exit(5)
		}
		_, _ = fmt.Fprintln(f, os.Args[1])
		_ = f.Close()
		_ = os.WriteFile(filepath.Join(dir, ".gitignore"), []byte("*\n!.gitignore\n"), 0o600)
	default:
		os.Exit(3)
	}
	os.Exit(0)
}

// captureClaude ghi tham số, file --mcp-config và biến RTK mà claude giả nhận vào HIVE_CAPTURE_CLAUDE, và tạo file
// thống kê RTK như rtk thật làm khi agent chạy lệnh qua nó.
func captureClaude() {
	if p := os.Getenv("RTK_DB_PATH"); p != "" {
		_ = os.WriteFile(p, nil, 0o600)
	}
	p := os.Getenv("HIVE_CAPTURE_CLAUDE")
	if p == "" {
		return
	}
	mcp := ""
	if i := slices.Index(os.Args, "--mcp-config"); i > 0 && i+1 < len(os.Args) {
		b, _ := os.ReadFile(os.Args[i+1])
		mcp = string(b)
	}
	if dir := os.Getenv(GuardDirEnv); dir != "" {
		// Như hook của run đã chặn hai lệnh và cắt 500 ký tự.
		_ = os.WriteFile(filepath.Join(dir, "state.json"), []byte(`{"blocked":2,"truncatedChars":500}`), 0o600)
	}
	b, _ := json.Marshal(map[string]any{"args": os.Args[1:], "mcp": mcp, "path": os.Getenv("PATH"), "telemetry": os.Getenv("RTK_TELEMETRY_DISABLED"), "db": os.Getenv("RTK_DB_PATH"), "guard": os.Getenv(GuardDirEnv)})
	_ = os.WriteFile(p, b, 0o600)
}

// fakeToolDir chép binary test thành công cụ tên name trong một thư mục riêng và trả đường dẫn file.
func fakeToolDir(t *testing.T, name string) string {
	t.Helper()
	bin := installFakeCLI(t, name)
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(bin, name)
}

func TestToolConfigFromEnv(t *testing.T) {
	cases := []struct {
		raw     string
		want    ToolConfig
		wantErr bool
	}{
		{raw: ""},
		{raw: "off", want: ToolConfig{Off: true}},
		{raw: " False ", want: ToolConfig{Off: true}},
		{raw: "/opt/bin/rtk", want: ToolConfig{Path: "/opt/bin/rtk"}},
		{raw: `{"path":"/opt/bin/rtk","sha256":"ab"}`, want: ToolConfig{Path: "/opt/bin/rtk", SHA256: "ab"}},
		{raw: "{bậy", wantErr: true},
	}
	for _, c := range cases {
		t.Setenv(RTKEnv, c.raw)
		got, err := ToolConfigFromEnv(RTKEnv)
		if (err != nil) != c.wantErr || got != c.want {
			t.Fatalf("%q: %+v, %v", c.raw, got, err)
		}
	}
}

func TestResolveToolChecksSHA256(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rtk")
	if err := os.WriteFile(path, []byte("bản đã tin"), 0o700); err != nil {
		t.Fatal(err)
	}
	sum, err := fileSHA256(path)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := resolveTool(ToolConfig{Path: path, SHA256: strings.ToUpper(sum)}, "rtk"); err != nil || got != path {
		t.Fatalf("hash khớp: %q, %v", got, err)
	}
	if err := os.WriteFile(path, []byte("bản bị thay"), 0o700); err != nil {
		t.Fatal(err)
	}
	if got, err := resolveTool(ToolConfig{Path: path, SHA256: sum}, "rtk"); err == nil || got != "" {
		t.Fatalf("hash lệch phải bị bỏ: %q, %v", got, err)
	}
	t.Setenv("PATH", t.TempDir())
	if got, err := resolveTool(ToolConfig{}, "rtk"); err != nil || got != "" {
		t.Fatalf("không có trên PATH: %q, %v", got, err)
	}
	if got, err := resolveTool(ToolConfig{Off: true, Path: path}, "rtk"); err != nil || got != "" {
		t.Fatalf("máy tắt: %q, %v", got, err)
	}
}

func TestPrepareRTK(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("worker chưa bật RTK trên Windows")
	}
	t.Setenv(CLIOverridesEnv, "")
	rtk := fakeToolDir(t, "rtk")
	sum, err := fileSHA256(rtk)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HIVE_FAKE_RTK", "ok")
	off, on := false, true
	code := Job{RunID: "r1", Attempt: 2, CLI: "claude", Kind: "code"}
	cases := map[string]struct {
		cfg     ToolConfig
		job     Job
		mode    string
		enabled bool
		log     string
	}{
		"bật":                  {cfg: ToolConfig{Path: rtk}, job: code, enabled: true},
		"hash khớp":            {cfg: ToolConfig{Path: rtk, SHA256: sum}, job: code, enabled: true},
		"hub cũ không gửi rtk": {cfg: ToolConfig{Path: rtk}, job: withSaving(code, &TokenSavingJob{Enabled: true}), enabled: true},
		"dự án bật rõ":         {cfg: ToolConfig{Path: rtk}, job: withSaving(code, &TokenSavingJob{Enabled: true, RTK: &on}), enabled: true},
		"dự án tắt rtk":        {cfg: ToolConfig{Path: rtk}, job: withSaving(code, &TokenSavingJob{Enabled: true, RTK: &off})},
		"dự án tắt cả mục":     {cfg: ToolConfig{Path: rtk}, job: withSaving(code, &TokenSavingJob{Enabled: false, RTK: &on})},
		"máy tắt":              {cfg: ToolConfig{Off: true, Path: rtk}, job: code},
		"máy không có rtk":     {cfg: ToolConfig{Path: filepath.Join(t.TempDir(), "rtk")}, job: code, log: "không có file chạy"},
		"hash lệch":            {cfg: ToolConfig{Path: rtk, SHA256: strings.Repeat("0", 64)}, job: code, log: "sha256"},
		"hook lỗi":             {cfg: ToolConfig{Path: rtk}, job: code, mode: "fail", log: "hook RTK lỗi"},
		"hook in rác":          {cfg: ToolConfig{Path: rtk}, job: code, mode: "garbage", log: "hook RTK trả dữ liệu lạ"},
		"codex":                {cfg: ToolConfig{Path: rtk}, job: Job{RunID: "r1", CLI: "codex", Kind: "code"}},
		"run chỉ đọc":          {cfg: ToolConfig{Path: rtk}, job: Job{RunID: "r1", CLI: "claude", Kind: KindReview}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if c.mode != "" {
				t.Setenv("HIVE_FAKE_RTK", c.mode)
			}
			var log bytes.Buffer
			r := Runner{DataDir: t.TempDir(), RTK: &c.cfg}
			got := r.prepareRTK(context.Background(), c.job, &log)
			if (got != nil) != c.enabled {
				t.Fatalf("bật = %v, muốn %v; log %q", got != nil, c.enabled, log.String())
			}
			if c.log != "" && !strings.Contains(log.String(), c.log) {
				t.Fatalf("log = %q, muốn có %q", log.String(), c.log)
			}
			if got == nil {
				return
			}
			defer got.cleanup()
			if got.env["RTK_TELEMETRY_DISABLED"] != "1" || got.env["RTK_SUPPRESS_HOOK_WARNING"] != "1" {
				t.Fatalf("env = %v", got.env)
			}
			if !strings.HasPrefix(got.env["RTK_DB_PATH"], r.DataDir) || !strings.Contains(got.env["RTK_DB_PATH"], "r1-2") {
				t.Fatalf("RTK_DB_PATH = %q", got.env["RTK_DB_PATH"])
			}
			// Lệnh `rtk …` sau khi hook viết lại phải chạy đúng bản đã kiểm.
			first, _, _ := strings.Cut(got.env["PATH"], string(os.PathListSeparator))
			if target, err := filepath.EvalSymlinks(filepath.Join(first, "rtk")); err != nil || target != mustEval(t, rtk) {
				t.Fatalf("rtk đầu PATH trỏ tới %q, %v", target, err)
			}
			if got.hook != shellQuote(rtk)+" hook claude" {
				t.Fatalf("hook = %q", got.hook)
			}
		})
	}
}

func withSaving(j Job, ts *TokenSavingJob) Job {
	j.TokenSaving = ts
	return j
}

func mustEval(t *testing.T, p string) string {
	t.Helper()
	got, err := filepath.EvalSymlinks(p)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

// Hook RTK đi cùng file --settings với hook của tổ chức, codegraph vào --mcp-config và allowedTools.
func TestClaudeArgsWithTools(t *testing.T) {
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret"}
	policy := JobPolicy{Hooks: []Hook{{Event: "PreToolUse", Name: "chặn", Command: "check.sh", Matcher: "Edit"}}}
	j := Job{CLI: "claude", Kind: "code", Prompt: "p", Env: env, Policy: policy, workspace: "/w", codegraph: "/opt/bin/codegraph", rtk: &rtkRun{hook: "'/opt/bin/rtk' hook claude"}}
	cmd, err := (Runner{}).cliCommand(j)
	if err != nil {
		t.Fatal(err)
	}
	defer cmd.cleanup()
	var settings struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Command string `json:"command"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(cmd.Args[slices.Index(cmd.Args, "--settings")+1]), &settings); err != nil {
		t.Fatal(err)
	}
	pre := settings.Hooks["PreToolUse"]
	if len(pre) != 2 || pre[0].Hooks[0].Command != "check.sh" || pre[1].Matcher != "Bash" || pre[1].Hooks[0].Command != "'/opt/bin/rtk' hook claude" {
		t.Fatalf("PreToolUse = %+v", pre)
	}
	if i := slices.Index(cmd.Args, "--allowedTools"); i < 0 || cmd.Args[i+1] != "Bash,mcp__codegraph" {
		t.Fatalf("args = %q", cmd.Args)
	}
	servers := readMCPConfig(t, cmd.Args[slices.Index(cmd.Args, "--mcp-config")+1])
	cg := servers["codegraph"]
	if cg == nil || cg["command"] != "/opt/bin/codegraph" || cg["alwaysLoad"] != true || servers["xdev-hive"] == nil {
		t.Fatalf("mcpServers = %v", servers)
	}
	if args, _ := json.Marshal(cg["args"]); string(args) != `["serve","--mcp","--path","/w"]` {
		t.Fatalf("args = %s", args)
	}
	cgEnv, _ := cg["env"].(map[string]any)
	if cgEnv["CODEGRAPH_TELEMETRY"] != "0" || cgEnv["DO_NOT_TRACK"] != "1" || cgEnv["CODEGRAPH_NO_DAEMON"] != "1" || cgEnv["HIVE_RUN_TOKEN"] != "" {
		t.Fatalf("env = %v", cgEnv)
	}
	// Run chỉ đọc vẫn nhận codegraph (tool có readOnlyHint) dù không nhận server ngoài, và không có allowedTools.
	j.Kind, j.rtk = KindPlan, nil
	plan, err := (Runner{}).cliCommand(j)
	if err != nil {
		t.Fatal(err)
	}
	defer plan.cleanup()
	if servers := readMCPConfig(t, plan.Args[slices.Index(plan.Args, "--mcp-config")+1]); servers["codegraph"] == nil {
		t.Fatalf("run plan thiếu codegraph: %v", servers)
	}
	if slices.Contains(plan.Args, "--allowedTools") {
		t.Fatalf("run plan: %q", plan.Args)
	}
}

func TestOtherCLIsGetCodeGraph(t *testing.T) {
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret"}
	j := Job{CLI: "codex", Kind: "code", Prompt: "p", Env: env, workspace: "/w", codegraph: "/opt/bin/codegraph"}
	cmd, err := (Runner{}).cliCommand(j)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(cmd.Args, " ")
	if !strings.Contains(joined, `mcp_servers.codegraph={command="/opt/bin/codegraph",args=["serve","--mcp","--path","/w"],env={`) ||
		!strings.Contains(joined, `"CODEGRAPH_TELEMETRY"="0"`) || !strings.Contains(joined, `"HIVE_RUN_TOKEN"=""`) {
		t.Fatalf("codex args = %q", cmd.Args)
	}
	j.CLI = "gemini"
	if s := geminiMCPServers(j)["codegraph"]; s == nil || !slices.Contains(geminiMCPArgs(j), "--allowed-mcp-server-names=codegraph") {
		t.Fatalf("gemini: %v %q", s, geminiMCPArgs(j))
	}
	if s := antigravityMCPServers(j)["codegraph"]; s == nil {
		t.Fatal("antigravity thiếu codegraph")
	}
	j.codegraph = ""
	if codexMCPArgs(j) != nil || claudeMCPEntries(j) != nil || antigravityMCPServers(j)["codegraph"] != nil {
		t.Fatal("không có codegraph thì không thêm server")
	}
}

// gitWork tạo một repo git có một commit để làm worktree của run.
func gitWork(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	must(t, "git", "-C", dir, "init", "-q")
	if err := os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	must(t, "git", "-C", dir, "add", ".")
	must(t, "git", "-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init")
	return dir
}

func TestPrepareCodeGraphKeepsIndexPerRepo(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	cg := fakeToolDir(t, "codegraph")
	toolLog := filepath.Join(t.TempDir(), "tool.log")
	t.Setenv("HIVE_FAKE_CODEGRAPH", "ok")
	t.Setenv("HIVE_FAKE_TOOL_LOG", toolLog)
	r := Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: cg}}
	job := Job{RunID: "r", CLI: "claude", Kind: "code", RepoURL: "https://git.example/a.git"}
	var log bytes.Buffer
	first := gitWork(t)
	if got := r.prepareCodeGraph(context.Background(), job, first, &log); got != cg {
		t.Fatalf("lần đầu: %q; log %q", got, log.String())
	}
	second := gitWork(t)
	if got := r.prepareCodeGraph(context.Background(), job, second, &log); got != cg {
		t.Fatalf("lần hai: %q; log %q", got, log.String())
	}
	// Lần hai chép chỉ mục bền rồi chỉ cập nhật phần đổi.
	db, err := os.ReadFile(filepath.Join(second, codegraphDir, "codegraph.db"))
	if err != nil || string(db) != "init\nsync\n" {
		t.Fatalf("chỉ mục lần hai = %q, %v", db, err)
	}
	b, _ := os.ReadFile(toolLog)
	calls := strings.Split(strings.TrimSpace(string(b)), "\n")
	if len(calls) != 2 || !strings.HasPrefix(calls[0], "codegraph init --yes "+first) || !strings.HasPrefix(calls[1], "codegraph sync --quiet "+second) {
		t.Fatalf("lệnh = %q", calls)
	}
	for _, c := range calls {
		if !strings.Contains(c, "CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1 CODEGRAPH_NO_DAEMON=1") {
			t.Fatalf("telemetry chưa tắt: %q", c)
		}
	}
	if !strings.Contains(log.String(), "CodeGraph dựng") || !strings.Contains(log.String(), "CodeGraph cập nhật") {
		t.Fatalf("log = %q", log.String())
	}
	// .codegraph (kể cả .gitignore của nó) không lọt vào commit của run.
	for _, w := range []string{first, second} {
		if out, err := gitOutput(context.Background(), w, "status", "--porcelain", "--untracked-files=all"); err != nil || strings.TrimSpace(out) != "" {
			t.Fatalf("git status = %q, %v", out, err)
		}
	}
	// Repo khác có chỉ mục riêng.
	other := gitWork(t)
	if got := r.prepareCodeGraph(context.Background(), Job{RunID: "o", CLI: "codex", Kind: "code", RepoURL: "https://git.example/b.git"}, other, &log); got != cg {
		t.Fatal("repo khác không chạy")
	}
	if db, _ := os.ReadFile(filepath.Join(other, codegraphDir, "codegraph.db")); string(db) != "init\n" {
		t.Fatalf("repo khác = %q", db)
	}
}

func TestPrepareCodeGraphFailureDoesNotBlock(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	cg := fakeToolDir(t, "codegraph")
	t.Setenv("HIVE_FAKE_CODEGRAPH", "fail")
	work := gitWork(t)
	var log bytes.Buffer
	r := Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: cg}}
	if got := r.prepareCodeGraph(context.Background(), Job{RunID: "r", CLI: "claude", Kind: "code", RepoURL: "x"}, work, &log); got != "" {
		t.Fatalf("lỗi sync vẫn gắn codegraph: %q", got)
	}
	if !strings.Contains(log.String(), "Chạy run không có CodeGraph") {
		t.Fatalf("log = %q", log.String())
	}
	if _, err := os.Stat(filepath.Join(work, codegraphDir)); !os.IsNotExist(err) {
		t.Fatalf(".codegraph dở dang còn lại: %v", err)
	}
	off := false
	cases := map[string]struct {
		r   Runner
		job Job
	}{
		"không có codegraph": {Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: filepath.Join(t.TempDir(), "codegraph")}}, Job{CLI: "claude"}},
		"máy tắt":            {Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Off: true, Path: cg}}, Job{CLI: "claude"}},
		"dự án tắt":          {Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: cg}}, Job{CLI: "claude", TokenSaving: &TokenSavingJob{Enabled: true, CodeGraph: &off}}},
		"lệnh CLI riêng":     {Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: cg}, CLICommands: map[string]Command{"claude": {Path: "x"}}}, Job{CLI: "claude"}},
		"sandbox":            {Runner{DataDir: t.TempDir(), CodeGraph: &ToolConfig{Path: cg}, Sandbox: &SandboxConfig{}}, Job{CLI: "claude"}},
	}
	t.Setenv("HIVE_FAKE_CODEGRAPH", "ok")
	for name, c := range cases {
		if got := c.r.prepareCodeGraph(context.Background(), c.job, gitWork(t), &bytes.Buffer{}); got != "" {
			t.Fatalf("%s: %q", name, got)
		}
	}
}

// Cả run với claude, rtk và codegraph giả: CLI nhận hook, PATH, MCP; số RTK đi trong sự kiện cost cuối.
func TestRunWithRTKAndCodeGraph(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("worker chưa bật RTK trên Windows")
	}
	t.Setenv(CLIOverridesEnv, "")
	t.Setenv(TokenSavingEnv, "")
	bin := installFakeClaude(t)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	rtk, cg := fakeToolDir(t, "rtk"), fakeToolDir(t, "codegraph")
	t.Setenv("HIVE_FAKE_RTK", "ok")
	t.Setenv("HIVE_FAKE_CODEGRAPH", "ok")
	capture := filepath.Join(t.TempDir(), "claude.json")
	remote, base := makeRemote(t)
	var events []Event
	r := Runner{DataDir: t.TempDir(), RTK: &ToolConfig{Path: rtk}, CodeGraph: &ToolConfig{Path: cg}}
	_ = r.Run(context.Background(), Job{
		RunID: "tools", Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/tools", CLI: "claude", Prompt: "p", Timeout: 30 * time.Second,
		Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret", "HIVE_FAKE_MCP_MODE": "exit", "HIVE_CAPTURE_MCP": filepath.Join(t.TempDir(), "mcp"), "HIVE_CAPTURE_CLAUDE": capture},
	}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
	var got struct {
		Args      []string `json:"args"`
		MCP       string   `json:"mcp"`
		Path      string   `json:"path"`
		Telemetry string   `json:"telemetry"`
		DB        string   `json:"db"`
	}
	b, err := os.ReadFile(capture)
	if err != nil || json.Unmarshal(b, &got) != nil {
		t.Fatalf("claude giả không chạy: %s, %v; log %s", b, err, logText(events))
	}
	settings := got.Args[slices.Index(got.Args, "--settings")+1]
	if !strings.Contains(settings, shellQuote(rtk)+" hook claude") || got.Telemetry != "1" || !strings.HasPrefix(got.Path, r.DataDir) {
		t.Fatalf("claude nhận settings %q, telemetry %q, PATH %q", settings, got.Telemetry, got.Path)
	}
	if !strings.Contains(got.MCP, `"codegraph"`) || !strings.Contains(got.MCP, `"alwaysLoad":true`) {
		t.Fatalf("mcp = %s", got.MCP)
	}
	var last *Usage
	for _, e := range events {
		if e.Type == "cost" {
			last = e.Cost
		}
	}
	if last == nil || last.RTK == nil || last.RTK.Commands != 4 || last.RTK.SavedTokens != 3234 {
		t.Fatalf("cost cuối = %+v; log %s", last, logText(events))
	}
	// Thư mục riêng của RTK (db, lối tắt) bị dọn sau run.
	if _, err := os.Stat(filepath.Dir(got.DB)); !os.IsNotExist(err) {
		t.Fatalf("thư mục RTK còn lại: %v", err)
	}
	if !strings.Contains(logText(events), "RTK nén output") || !strings.Contains(logText(events), "CodeGraph dựng") {
		t.Fatalf("log = %s", logText(events))
	}
}
