package runner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/projects"
)

// InteractiveSpec là phần của term_open mà runner cần để chuẩn bị phiên `claude` tương tác (terminal Leader, specs/010
// lát đầu). Không phụ thuộc gói giao thức để kênh và test cùng dựng được.
type InteractiveSpec struct {
	SessionID  string
	ProjectID  string
	ProjectKey string
	RepoURL    string
	BaseBranch string
	HubURL     string
	Model      string
	// Effort là low|medium|high; giá trị khác bị bỏ như run.
	Effort  string
	Advisor string
	// RunPermissions và FullAllowed áp qua projects.Effective như run (ADR 0020).
	RunPermissions string
	FullAllowed    bool
	MCPToken       string
	SystemPrompt   string
	TokenSaving    *TokenSavingJob
	// Projects là projects.json của máy; dự án đã gắn thì worktree tạo từ repo đó.
	Projects []projects.Project
}

// Interactive là phiên đã chuẩn bị: Cmd chưa chạy (người gọi chạy trong PTY), Secrets là chuỗi phải che khỏi output,
// Cleanup gỡ worktree và file MCP (gọi sau khi CLI đã dừng; gọi nhiều lần cũng được).
type Interactive struct {
	Dir         string
	Cmd         *exec.Cmd
	Secrets     []string
	Permissions string
	Cleanup     func()
}

// terminalsDir là nơi để worktree tạm của phiên tương tác, tách khỏi runs/ để ReapOrphans của run không đụng vào.
func terminalsDir(dataDir string) string { return filepath.Join(dataDir, "terminals") }

// secretEnvName: biến môi trường của worker không được lọt vào phiên người dùng gõ được (machine token, token hub, khoá
// API của máy).
func secretEnvName(name string) bool {
	upper := strings.ToUpper(name)
	if strings.HasPrefix(upper, "HIVE_") {
		return true
	}
	for _, s := range []string{"TOKEN", "SECRET", "PASSWORD", "API_KEY"} {
		if strings.Contains(upper, s) {
			return true
		}
	}
	return false
}

// claudeLoginEnv là biến đăng nhập của chính Claude Code. Máy không dùng accounts pool đăng nhập mặc định bằng các biến
// này nên phải giữ cho phiên; giá trị vẫn bị che khỏi output như token gói.
var claudeLoginEnv = []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}

// interactiveBaseEnv là os.Environ() bỏ biến bí mật: phiên tương tác là shell người mở điều khiển được, khác run.
// keepLogin giữ biến đăng nhập của Claude (máy không có gói riêng cho phiên).
func interactiveBaseEnv(keepLogin bool) []string {
	var out []string
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		if !secretEnvName(name) || keepLogin && slices.Contains(claudeLoginEnv, name) {
			out = append(out, kv)
		}
	}
	return out
}

func validBranch(b string) bool {
	return b != "" && !strings.HasPrefix(b, "-") && !strings.Contains(b, "..") && !strings.ContainsAny(b, ": \t\n\\")
}

// PrepareInteractive tạo worktree tạm tách HEAD ở origin/<baseBranch> (không tạo nhánh, không đẩy) và dựng lệnh
// `claude` tương tác. Dùng DataDir, CLICommands, Account, TokenSaving, ClaudeVersion của Runner.
func (r Runner) PrepareInteractive(ctx context.Context, spec InteractiveSpec) (_ *Interactive, retErr error) {
	if spec.SessionID == "" || spec.RepoURL == "" || spec.HubURL == "" || spec.MCPToken == "" {
		return nil, errors.New("phiên terminal thiếu trường bắt buộc")
	}
	if !validBranch(spec.BaseBranch) {
		return nil, fmt.Errorf("nhánh %q không hợp lệ", spec.BaseBranch)
	}
	if r.DataDir == "" {
		d, err := os.UserCacheDir()
		if err != nil {
			return nil, err
		}
		r.DataDir = filepath.Join(d, "xdev-hive", "worker")
	}
	root := terminalsDir(r.DataDir)
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	work := filepath.Join(root, safeName(spec.SessionID))
	_ = os.RemoveAll(work)
	p := projects.Find(spec.Projects, strings.ToLower(spec.ProjectID))
	src := bareSource(r.DataDir, spec.RepoURL)
	if p != nil {
		src = localSource(p.Folder)
	}
	var mcpFile string
	cleanup := func() {
		if mcpFile != "" {
			_ = os.Remove(mcpFile)
		}
		gitDir := linkedGitDir(work)
		if src.local {
			// Không `worktree prune` repo người dùng: prune xoá cả worktree của họ nằm trên ổ chưa gắn.
			_ = os.RemoveAll(work)
			removeLocalWorktree(r.DataDir, work, gitDir)
		} else {
			_ = os.RemoveAll(work)
			if src.lock != "" {
				_ = gitWrite(context.Background(), src.lock, src.dir, "worktree", "prune")
			}
		}
	}
	defer func() {
		if retErr != nil {
			cleanup()
		}
	}()
	if src.local {
		if err := src.openLocal(ctx, r.DataDir, spec.RepoURL); err != nil {
			return nil, err
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(src.dir), 0700); err != nil {
			return nil, err
		}
		if err := cloneOnce(ctx, r.DataDir, spec.RepoURL, src.dir); err != nil {
			return nil, fmt.Errorf("không clone được repo của dự án: %w", err)
		}
	}
	if err := gitWrite(ctx, src.lock, src.dir, "fetch", "origin", spec.BaseBranch+":refs/remotes/origin/"+spec.BaseBranch); err != nil {
		return nil, fmt.Errorf("không lấy được nhánh %s: %w", spec.BaseBranch, err)
	}
	// Như run plan/leader: tách HEAD để không tạo hay đặt lại nhánh nào, lỡ agent commit cũng không có gì trỏ tới.
	if err := addWorktreeAt(ctx, src.lock, src.dir, work, "--detach", work, "origin/"+spec.BaseBranch); err != nil {
		return nil, fmt.Errorf("không tạo được worktree tạm: %w", err)
	}

	perm := projects.Effective(p, spec.RunPermissions, spec.FullAllowed)
	if perm != "full" {
		perm = "workspace"
	}
	// Job chỉ để dùng lại các hàm của run (tiết kiệm token, định tuyến, advisor); không chạy như run.
	job := Job{CLI: "claude", Effort: spec.Effort, Advisor: spec.Advisor, TokenSaving: spec.TokenSaving, Env: map[string]string{}}
	job.claudeVersion = r.claudeVersion(ctx, job)
	savingCfg, _ := r.tokenSavingConfig()
	job.savingEnv = savingEnv(savingCfg, job)

	env := map[string]string{}
	for k, v := range job.savingEnv {
		env[k] = v
	}
	for k, v := range routingEnv(job) {
		env[k] = v
	}
	env["TERM"] = "xterm-256color"
	env["COLORTERM"] = "truecolor"
	env["HIVE_PROJECT"] = spec.ProjectKey
	env["HIVE_HUB_URL"] = spec.HubURL
	// Đặt sau cùng để spec của hub không đổi được thư mục đăng nhập của máy.
	accountEnv := r.Account.Env()
	for k, v := range accountEnv {
		env[k] = v
	}
	secrets := []string{spec.MCPToken}
	for k, v := range accountEnv {
		if secretEnvName(k) && v != "" {
			secrets = append(secrets, v)
		}
	}
	keepLogin := r.Account == nil
	if keepLogin {
		for _, name := range claudeLoginEnv {
			if v := os.Getenv(name); v != "" {
				secrets = append(secrets, v)
			}
		}
	}

	var cmd *exec.Cmd
	configured, ok := r.CLICommands["claude"]
	if !ok {
		fromEnv, err := CommandsFromEnv()
		if err != nil {
			return nil, err
		}
		configured, ok = fromEnv["claude"]
	}
	if ok {
		args := make([]string, len(configured.Args))
		for i, a := range configured.Args {
			args[i] = strings.ReplaceAll(a, "{{prompt}}", "")
		}
		cmd = exec.Command(configured.Path, args...)
	} else {
		var err error
		mcpFile, err = claudeMCPConfigAt("", map[string]string{"HIVE_HUB_URL": spec.HubURL, "HIVE_RUN_TOKEN": spec.MCPToken}, nil)
		if err != nil {
			return nil, err
		}
		cmd = exec.Command("claude", interactiveArgs(job, savingCfg, mcpFile, spec, perm)...)
	}
	cmd.Dir = work
	cmd.Env = mergeEnv(r.Account.Base(interactiveBaseEnv(keepLogin)), env)
	return &Interactive{Dir: work, Cmd: cmd, Secrets: secrets, Permissions: perm, Cleanup: cleanup}, nil
}

// interactiveArgs là cờ của `claude` tương tác. Không có -p, --tools, --max-turns hay --max-budget-usd của run: người mở
// điều khiển phiên, Claude hỏi duyệt ngay trong terminal khi cần.
func interactiveArgs(job Job, savingCfg TokenSavingConfig, mcpFile string, spec InteractiveSpec, perm string) []string {
	args := []string{"--setting-sources", "project", "--strict-mcp-config", "--mcp-config", mcpFile}
	if spec.SystemPrompt != "" {
		args = append(args, "--append-system-prompt", spec.SystemPrompt)
	}
	if spec.Model != "" {
		args = append(args, "--model", spec.Model)
	}
	var flags [][]string
	if spec.Advisor != "" && !advisorBlocked(job) {
		flags = append(flags, []string{"--advisor", spec.Advisor})
	}
	if _, ok := savingJob(savingCfg, job); ok {
		// Như run: phần cố định của prompt hệ thống giống nhau giữa các máy nên cache prompt dùng lại được.
		flags = append(flags, []string{"--exclude-dynamic-system-prompt-sections"})
	}
	args = append(args, claudeFlags(job.claudeVersion, flags)...)
	if perm == "full" {
		args = append(args, "--permission-mode", "bypassPermissions")
	} else {
		args = append(args, "--permission-mode", "acceptEdits")
	}
	return args
}

// ReapTerminals dọn mọi worktree tạm của phiên tương tác còn lại: phiên không sống qua lần worker khởi động, nên lúc
// khởi động mọi thư mục trong terminals/ đều là rác của lần trước.
func ReapTerminals(dataDir string) error {
	root := terminalsDir(dataDir)
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	for _, entry := range entries {
		work := filepath.Join(root, entry.Name())
		reapLocal(dataDir, work)
		if err := os.RemoveAll(work); err != nil {
			return err
		}
	}
	for _, repoDir := range mustReadDir(filepath.Join(dataDir, "repos")) {
		if repoDir.IsDir() && strings.HasSuffix(repoDir.Name(), ".git") {
			repo := filepath.Join(dataDir, "repos", repoDir.Name())
			_ = gitWrite(context.Background(), repo, repo, "worktree", "prune")
		}
	}
	return nil
}
