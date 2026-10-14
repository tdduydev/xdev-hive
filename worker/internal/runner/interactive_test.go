package runner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

const termSession = "0a0a0a0a-0000-4000-8000-0000000000a1"

func interactiveSpec(remote, base string) InteractiveSpec {
	return InteractiveSpec{SessionID: termSession, ProjectID: "p-1", ProjectKey: "WEB", RepoURL: fileURL(remote), BaseBranch: base, HubURL: "http://hub.test", Model: "sonnet", Effort: "high", Advisor: "opus", RunPermissions: "full", FullAllowed: true, MCPToken: "mcp-token-bi-mat", SystemPrompt: "Bạn là Leader."}
}

func envOf(cmdEnv []string) map[string]string {
	m := map[string]string{}
	for _, kv := range cmdEnv {
		k, v, _ := strings.Cut(kv, "=")
		m[k] = v
	}
	return m
}

// Phiên dùng repo cache bare: worktree tách HEAD ở origin/<base>, không tạo nhánh; env không có bí mật của worker; lệnh
// claude tương tác đúng cờ; Cleanup gỡ hết.
func TestPrepareInteractiveBare(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	t.Setenv("HIVE_MACHINE_TOKEN", "machine-secret")
	t.Setenv("MY_API_KEY", "k")
	t.Setenv("GITHUB_TOKEN", "gh")
	t.Setenv("DISABLE_TELEMETRY", "")
	t.Setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "")
	t.Setenv(CLIOverridesEnv, "")
	t.Setenv(TokenSavingEnv, "")
	r := Runner{DataDir: data, ClaudeVersion: "2.1.296"}
	it, err := r.PrepareInteractive(context.Background(), interactiveSpec(remote, base))
	if err != nil {
		t.Fatal(err)
	}
	if it.Dir != filepath.Join(data, "terminals", termSession) || it.Cmd.Dir != it.Dir {
		t.Fatalf("dir = %s, cmd.Dir = %s", it.Dir, it.Cmd.Dir)
	}
	if b := strings.TrimSpace(mustOut(t, "git", "-C", it.Dir, "branch", "--show-current")); b != "" {
		t.Fatalf("worktree phải tách HEAD, đang ở nhánh %q", b)
	}
	if head, want := mustOut(t, "git", "-C", it.Dir, "rev-parse", "HEAD"), mustOut(t, "git", "--git-dir", remote, "rev-parse", base); head != want {
		t.Fatalf("HEAD %s, origin/%s %s", head, base, want)
	}
	env := envOf(it.Cmd.Env)
	for _, k := range []string{"HIVE_MACHINE_TOKEN", "MY_API_KEY", "GITHUB_TOKEN"} {
		if _, ok := env[k]; ok {
			t.Errorf("env còn %s", k)
		}
	}
	for k, v := range map[string]string{"TERM": "xterm-256color", "COLORTERM": "truecolor", "HIVE_PROJECT": "WEB", "HIVE_HUB_URL": "http://hub.test", "CLAUDE_CODE_EFFORT_LEVEL": "high", "BASH_MAX_OUTPUT_LENGTH": "15000"} {
		if env[k] != v {
			t.Errorf("env %s = %q, muốn %q", k, env[k], v)
		}
	}
	args := it.Cmd.Args
	joined := strings.Join(args, " ")
	for _, want := range []string{"--setting-sources project", "--strict-mcp-config", "--append-system-prompt Bạn là Leader.", "--model sonnet", "--advisor opus", "--exclude-dynamic-system-prompt-sections", "--permission-mode bypassPermissions"} {
		if !strings.Contains(joined, want) {
			t.Errorf("thiếu %q trong %v", want, args)
		}
	}
	for _, bad := range []string{"-p", "--tools", "--max-turns", "--output-format"} {
		if slices.Contains(args, bad) {
			t.Errorf("phiên tương tác không được có %s: %v", bad, args)
		}
	}
	if it.Permissions != "full" || !slices.Contains(it.Secrets, "mcp-token-bi-mat") {
		t.Fatalf("permissions %s, secrets %v", it.Permissions, it.Secrets)
	}
	mcp := args[slices.Index(args, "--mcp-config")+1]
	st, err := os.Stat(mcp)
	if err != nil {
		t.Fatalf("file MCP %s: %v %v", mcp, st, err)
	}
	// Windows dùng ACL, không biểu diễn quyền truy cập bằng các bit mode Unix.
	if runtime.GOOS != "windows" && st.Mode().Perm() != 0o600 {
		t.Fatalf("quyền file MCP %s = %o, muốn 600", mcp, st.Mode().Perm())
	}
	var cfg struct {
		MCPServers map[string]struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"mcpServers"`
	}
	b, _ := os.ReadFile(mcp)
	if json.Unmarshal(b, &cfg) != nil || cfg.MCPServers["xdev-hive"].URL != "http://hub.test/mcp" || cfg.MCPServers["xdev-hive"].Headers["Authorization"] != "Bearer mcp-token-bi-mat" {
		t.Fatalf("cấu hình MCP = %s", b)
	}
	it.Cleanup()
	it.Cleanup()
	if _, err := os.Stat(it.Dir); !os.IsNotExist(err) {
		t.Fatal("Cleanup chưa xoá worktree")
	}
	if _, err := os.Stat(mcp); !os.IsNotExist(err) {
		t.Fatal("Cleanup chưa xoá file MCP")
	}
	cache := bareSource(data, fileURL(remote)).dir
	if out := mustOut(t, "git", "--git-dir", cache, "worktree", "list"); strings.Contains(out, "terminals") {
		t.Fatalf("worktree còn đăng ký: %s", out)
	}
}

// Dự án đã gắn: worktree từ repo người dùng, quyền theo công tắc máy (tắt → acceptEdits) và chính sách tổ chức;
// Cleanup gỡ siêu dữ liệu worktree trong repo người dùng. Override lệnh thay {{prompt}} bằng chuỗi rỗng.
func TestPrepareInteractiveBoundRepoAndOverride(t *testing.T) {
	remote, base := makeRemote(t)
	repo := userRepo(t, remote)
	data := t.TempDir()
	spec := interactiveSpec(remote, base)
	spec.ProjectID = "0A0A0A0A-0000-4000-8000-000000000003"
	spec.Projects = []projects.Project{{ProjectID: "0a0a0a0a-0000-4000-8000-000000000003", Folder: repo}}
	r := Runner{DataDir: data, CLICommands: map[string]Command{"claude": {Path: "claude-test", Args: []string{"--prompt", "[{{prompt}}]"}}}}
	it, err := r.PrepareInteractive(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	if it.Permissions != "workspace" {
		t.Fatalf("máy chưa bật toàn quyền mà permissions = %s", it.Permissions)
	}
	if got := it.Cmd.Args; !slices.Equal(got, []string{"claude-test", "--prompt", "[]"}) {
		t.Fatalf("args = %v", got)
	}
	if out := mustOut(t, "git", "-C", repo, "worktree", "list"); !strings.Contains(out, "terminals") {
		t.Fatalf("worktree không tạo từ repo đã gắn: %s", out)
	}
	if _, err := os.Stat(filepath.Join(data, "repos")); err == nil {
		if entries, _ := os.ReadDir(filepath.Join(data, "repos")); slices.ContainsFunc(entries, func(e os.DirEntry) bool { return strings.HasSuffix(e.Name(), ".git") }) {
			t.Fatal("dự án đã gắn mà vẫn clone bare")
		}
	}
	it.Cleanup()
	if out := mustOut(t, "git", "-C", repo, "worktree", "list"); strings.Contains(out, "terminals") {
		t.Fatalf("còn worktree trong repo người dùng: %s", out)
	}
	// Bật toàn quyền trên máy nhưng tổ chức không cho: vẫn workspace.
	spec.Projects[0].FullPermission = true
	spec.FullAllowed = false
	it, err = r.PrepareInteractive(context.Background(), spec)
	if err != nil {
		t.Fatal(err)
	}
	defer it.Cleanup()
	if it.Permissions != "workspace" {
		t.Fatalf("permissions = %s", it.Permissions)
	}
}

func TestInteractiveArgsWorkspaceAndOldClaude(t *testing.T) {
	t.Setenv("DISABLE_TELEMETRY", "")
	t.Setenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "")
	spec := InteractiveSpec{Model: "sonnet", Advisor: "opus"}
	mcp := filepath.Join(t.TempDir(), "m.json")
	// Không đọc được phiên bản: bỏ cờ cần kiểm phiên bản (--advisor, --exclude-dynamic-…), giữ cờ chung.
	args := interactiveArgs(Job{CLI: "claude", Advisor: "opus"}, TokenSavingConfig{}, mcp, spec, "workspace")
	joined := strings.Join(args, " ")
	if strings.Contains(joined, "--advisor") || strings.Contains(joined, "--exclude-dynamic") || strings.Contains(joined, "--append-system-prompt") {
		t.Fatalf("args = %v", args)
	}
	if !strings.HasSuffix(joined, "--permission-mode acceptEdits") {
		t.Fatalf("args = %v", args)
	}
	t.Setenv("DISABLE_TELEMETRY", "1")
	args = interactiveArgs(Job{CLI: "claude", Advisor: "opus", claudeVersion: "2.1.296"}, TokenSavingConfig{Off: true}, mcp, spec, "full")
	if joined := strings.Join(args, " "); strings.Contains(joined, "--advisor") || strings.Contains(joined, "--exclude-dynamic") {
		t.Fatalf("telemetry tắt hay tiết kiệm token tắt mà vẫn có cờ: %v", args)
	}
}

func TestSecretEnvName(t *testing.T) {
	for name, want := range map[string]bool{"HIVE_TOKEN": true, "hive_x": true, "GH_TOKEN": true, "AWS_SECRET_ACCESS_KEY": true, "DB_PASSWORD": true, "OPENAI_API_KEY": true, "PATH": false, "HOME": false, "CLAUDE_CONFIG_DIR": false} {
		if got := secretEnvName(name); got != want {
			t.Errorf("%s = %v", name, got)
		}
	}
}

// Lúc khởi động mọi thư mục trong terminals/ là rác: dọn cả worktree trong repo cache.
func TestReapTerminals(t *testing.T) {
	remote, base := makeRemote(t)
	data := t.TempDir()
	r := Runner{DataDir: data, CLICommands: map[string]Command{"claude": {Path: "claude-test"}}}
	if _, err := r.PrepareInteractive(context.Background(), interactiveSpec(remote, base)); err != nil {
		t.Fatal(err)
	}
	if err := ReapTerminals(data); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(filepath.Join(data, "terminals")); len(entries) != 0 {
		t.Fatalf("còn %d thư mục", len(entries))
	}
	cache := bareSource(data, fileURL(remote)).dir
	if out := mustOut(t, "git", "--git-dir", cache, "worktree", "list"); strings.Contains(out, "terminals") {
		t.Fatalf("worktree còn đăng ký: %s", out)
	}
	if err := ReapTerminals(t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

// Máy không có gói riêng đăng nhập Claude bằng biến môi trường: phiên vẫn chạy được, giá trị bị che khỏi output.
func TestInteractiveBaseEnvKeepsClaudeLogin(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-ant-machine")
	t.Setenv("HIVE_MACHINE_TOKEN", "machine-secret")
	t.Setenv("OPENAI_API_KEY", "openai")
	with := envOf(interactiveBaseEnv(true))
	if with["ANTHROPIC_API_KEY"] != "sk-ant-machine" || with["HIVE_MACHINE_TOKEN"] != "" || with["OPENAI_API_KEY"] != "" {
		t.Fatalf("giữ đăng nhập Claude nhưng không giữ bí mật khác: %v", with)
	}
	if without := envOf(interactiveBaseEnv(false)); without["ANTHROPIC_API_KEY"] != "" {
		t.Fatalf("có gói riêng thì không cần khoá API của máy: %v", without)
	}
}
