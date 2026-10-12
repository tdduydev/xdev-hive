// Package runner chạy một job trong worktree tạm và phát sự kiện cho transport.
package runner

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

// KindReview là run review chéo: đọc nhánh của run cha, không sửa, không push.
const KindReview = "review"

// KindPlan là run lập kế hoạch của plan mode: đọc nhánh chính, CLI chạy ở chế độ chỉ đọc, không push.
const KindPlan = "plan"

// KindLeader là run hội thoại; CLI được giới hạn chỉ đọc như KindPlan.
const KindLeader = "leader"

// readOnlyKind là nơi duy nhất quyết định run nào chỉ đọc: CLI không nhận cờ ghi (kể cả khi dự án bật quyền full),
// lệnh override phải tự khai chỉ đọc, và worker không push. Thêm kind mới thì quyết định ở đây trước.
func readOnlyKind(kind string) bool {
	return kind == KindReview || kind == KindPlan || kind == KindLeader
}

type Job struct {
	Execution                                       string
	SandboxPolicy                                   *SandboxJobConfig
	RunID                                           string
	Kind                                            string // "code" (mặc định), KindReview, KindPlan hoặc KindLeader
	Budget                                          Budget
	RunPermissions                                  string
	gitRoots                                        []string
	Attempt                                         int
	RepoURL, BaseBranch, Branch, CLI, Model, Prompt string
	Env                                             map[string]string
	SetupEnv                                        map[string]string
	Timeout                                         time.Duration
	SetupScript                                     string
	// Steers nhận chỉ dẫn của hub cho run này; nil là không có. Kết quả đi ra thành sự kiện "steer_result".
	Steers           <-chan Steer
	EnvironmentImage string
	// MCPServers là MCP server ngoài hub cho phép (MCP-06); xem externalMCPServers.
	MCPServers []MCPServer
	workspace  string
	repoCache  string
}

type Event struct {
	Type    string  `json:"type"`
	RunID   string  `json:"runId"`
	Attempt int     `json:"attempt"`
	Phase   string  `json:"phase,omitempty"`
	Stream  string  `json:"stream,omitempty"`
	Offset  int64   `json:"offset,omitempty"`
	Data    []byte  `json:"data,omitempty"`
	Result  *Result `json:"result,omitempty"`
	// Cost có ở sự kiện "cost": usage luỹ kế của lần chạy CLI.
	Cost *Usage `json:"cost,omitempty"`
	// Steer có ở sự kiện "steer_result".
	Steer *SteerResult `json:"steer,omitempty"`
}

type Sink interface{ Emit(Event) error }
type SinkFunc func(Event) error

func (f SinkFunc) Emit(e Event) error { return f(e) }

type Result struct {
	Status       string     `json:"status"`
	HeadSHA      string     `json:"headSha,omitempty"`
	CommitCount  int        `json:"commitCount"`
	ChangedFiles []string   `json:"changedFiles"`
	DiffStats    *DiffStats `json:"-"`
	Error        string     `json:"error,omitempty"`
}

// Command là lệnh chạy một CLI; "{{prompt}}" trong Args được thay bằng prompt của job. Input là InputStreamJSON khi
// CLI đọc prompt và chỉ dẫn giữa chừng từ stdin; để trống thì stdin không nối gì.
type Command struct {
	Path  string   `json:"path"`
	Args  []string `json:"args"`
	Input string   `json:"input,omitempty"`
	// ReadOnly: người cấu hình cam kết lệnh này không sửa file hay chạy lệnh ghi. Run chỉ đọc (review, plan, leader)
	// chỉ dùng override có khai ReadOnly; worker không tự thêm cờ chỉ đọc vào lệnh do người dùng viết.
	ReadOnly bool `json:"readOnly,omitempty"`
}

// CLIOverridesEnv thay lệnh của từng CLI mà không phải build lại worker, để scripts/e2e-smoke.ts trỏ "claude" tới
// một CLI giả. Giá trị là JSON: {"claude": {"path": "/usr/bin/node", "args": ["fake.ts", "{{prompt}}"]}}; thêm
// "input": "stream-json" nếu CLI giả đọc prompt từ stdin như Claude, và "readOnly": true nếu lệnh được dùng cho run
// review, plan, leader (worker từ chối override chưa khai).
const CLIOverridesEnv = "HIVE_WORKER_CLI_OVERRIDES"

// CommandsFromEnv đọc HIVE_WORKER_CLI_OVERRIDES; biến trống thì trả map rỗng.
func CommandsFromEnv() (map[string]Command, error) {
	raw := strings.TrimSpace(os.Getenv(CLIOverridesEnv))
	if raw == "" {
		return map[string]Command{}, nil
	}
	var m map[string]Command
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		return nil, fmt.Errorf("%s không phải JSON hợp lệ: %w", CLIOverridesEnv, err)
	}
	for name, c := range m {
		if c.Path == "" {
			return nil, fmt.Errorf("%s: CLI %q thiếu path", CLIOverridesEnv, name)
		}
	}
	return m, nil
}

type Runner struct {
	DataDir     string
	CLICommands map[string]Command
	Sandbox     *SandboxConfig
	KillGrace   time.Duration
	// Grace, nếu có, thay KillGrace và được đọc lúc phải dừng CLI chứ không phải lúc bắt đầu, để lệnh huỷ của hub
	// đặt được thời gian chờ riêng (cancel.graceSec) cho run đang chạy. Trả 0 là dừng ngay.
	Grace func() time.Duration
}

func (r Runner) grace() time.Duration {
	if r.Grace != nil {
		return r.Grace()
	}
	return r.KillGrace
}

func Run(ctx context.Context, job Job, sink Sink) error { return (Runner{}).Run(ctx, job, sink) }

func (r Runner) Run(ctx context.Context, job Job, sink Sink) (retErr error) {
	if job.Execution == "sandbox" && (job.SandboxPolicy == nil || r.Sandbox == nil) {
		return fmt.Errorf("job sandbox thiếu policy hoặc runner host")
	}
	if job.SandboxPolicy != nil && job.Execution != "sandbox" || job.Execution == "worker" && r.Sandbox != nil {
		return fmt.Errorf("loại thực thi job không khớp runner")
	}
	if err := validate(job); err != nil {
		return err
	}
	if sink == nil {
		return errors.New("runner: sink is nil")
	}
	if r.DataDir == "" {
		d, err := os.UserCacheDir()
		if err != nil {
			return err
		}
		r.DataDir = filepath.Join(d, "xdev-hive", "worker")
	}
	if r.KillGrace <= 0 {
		r.KillGrace = 10 * time.Second
	}
	if err := os.MkdirAll(r.DataDir, 0700); err != nil {
		return err
	}
	if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "prepare"}); err != nil {
		return err
	}
	root := filepath.Join(r.DataDir, "runs")
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	work := filepath.Join(root, safeName(job.RunID)+"-"+fmt.Sprint(job.Attempt))
	_ = os.RemoveAll(work)
	digest := sha256.Sum256([]byte(job.RepoURL))
	cache := filepath.Join(r.DataDir, "repos", fmt.Sprintf("%x.git", digest[:12]))
	job.repoCache = cache
	// Kết quả gửi sau khi dọn worktree: hub coi run_result là hết việc của máy và bỏ mọi sự kiện đến sau nó.
	var result *Result
	defer func() {
		// Git may refuse to remove a locked worktree; force is needed during cancellation too.
		_ = gitWrite(context.Background(), cache, cache, "worktree", "remove", "--force", work)
		_ = os.RemoveAll(work)
		_ = gitWrite(context.Background(), cache, cache, "worktree", "prune")
		_ = emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "cleanup"})
		if result == nil && retErr != nil {
			status := "failed"
			if errors.Is(ctx.Err(), context.Canceled) {
				status = "cancelled"
			} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status = "timeout"
			}
			result = &Result{Status: status, Error: retErr.Error()}
		}
		if result != nil {
			if e := emit(sink, Event{Type: "result", RunID: job.RunID, Attempt: job.Attempt, Result: result}); e != nil {
				retErr = errors.Join(retErr, e)
			}
		}
	}()
	if err := os.MkdirAll(filepath.Dir(cache), 0700); err != nil {
		return err
	}
	if err := cloneOnce(ctx, r.DataDir, job.RepoURL, cache); err != nil {
		return err
	}
	if err := gitWrite(ctx, cache, cache, "fetch", "origin", job.BaseBranch+":refs/remotes/origin/"+job.BaseBranch); err != nil {
		return err
	}
	if job.Kind == KindReview {
		// Run review đọc đúng nhánh run cha đã push. Tách HEAD thay vì tạo nhánh local để lỡ agent commit cũng không
		// có gì trỏ tới nhánh của cha.
		if err := gitWrite(ctx, cache, cache, "fetch", "origin", job.Branch+":refs/remotes/origin/"+job.Branch); err != nil {
			return err
		}
		if err := gitWrite(ctx, cache, cache, "worktree", "add", "--detach", work, "origin/"+job.Branch); err != nil {
			return err
		}
		if err := writeReviewDiff(ctx, work, job.BaseBranch); err != nil {
			return err
		}
	} else if job.Kind == KindPlan || job.Kind == KindLeader {
		// Kế hoạch lập trên nhánh chính, nơi run code sẽ bắt đầu. Tách HEAD để không tạo hay đặt lại nhánh ai/<task>
		// của run code.
		if err := gitWrite(ctx, cache, cache, "worktree", "add", "--detach", work, "origin/"+job.BaseBranch); err != nil {
			return err
		}
	} else if err := gitWrite(ctx, cache, cache, "worktree", "add", "-B", job.Branch, work, "origin/"+job.BaseBranch); err != nil {
		return err
	}
	job.workspace = work
	if job.SandboxPolicy != nil {
		config, cleanup, err := r.prepareSandboxPolicy(ctx, job.SandboxPolicy)
		if err != nil {
			return err
		}
		defer cleanup()
		r.Sandbox = &config
		defer r.removeSandbox(context.Background(), job.RunID)
		job.EnvironmentImage = job.SandboxPolicy.Image.BaseImage
		job.SetupScript, err = verifySandboxSetup(work, job.SandboxPolicy.Image.SetupScriptHash)
		if err != nil {
			return err
		}
	}
	if job.SetupScript != "" {
		var err error
		if r.Sandbox != nil {
			err = r.runSandboxSetup(ctx, job, work)
		} else {
			err = runSetup(ctx, work, job.SetupScript, mergeMap(job.Env, job.SetupEnv))
		}
		if err != nil {
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
	}
	if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "running"}); err != nil {
		return err
	}
	runCtx := ctx
	var cancel context.CancelFunc
	if job.Timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, job.Timeout)
		defer cancel()
	}
	// Git ghi index trong gitdir riêng và objects/refs trong bare cache ngoài worktree.
	gitDir, err := gitOutput(ctx, work, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return err
	}
	cacheRoot, err := filepath.Abs(cache)
	if err != nil {
		return err
	}
	job.gitRoots = []string{cacheRoot, strings.TrimSpace(gitDir), filepath.Join(cacheRoot, "objects"), filepath.Join(cacheRoot, "refs"), filepath.Join(cacheRoot, "logs")}
	if r.Sandbox != nil {
		job.gitRoots = []string{"/workspace", cacheRoot, strings.TrimSpace(gitDir)}
	}
	// Vượt trần chi phí thì dừng CLI theo đường huỷ (SIGINT, chờ grace rồi kill).
	runCtx, stopForBudget := context.WithCancel(runCtx)
	defer stopForBudget()
	cmd, err := r.cliCommand(job)
	if err != nil {
		return err
	}
	if cmd.cleanup != nil {
		defer cmd.cleanup()
	}
	process := cmd.Cmd
	process.Dir = work
	process.Env = mergeEnv(os.Environ(), job.Env)
	if r.Sandbox != nil {
		process, err = r.sandboxCommand(job, work, cmd.Cmd.Args)
		if err != nil {
			return err
		}
		defer r.removeSandbox(context.Background(), job.RunID)
	}
	// Không dùng StdoutPipe: Wait đóng đầu đọc ngay khi process thoát, goroutine đọc log còn dở sẽ gặp
	// "file already closed" (hay gặp trên macOS). Để exec tự chép log: Wait chờ chép xong rồi mới trả về.
	usage, stopMeter := startMeter(job, sink, stopForBudget)
	meterStopped := false
	defer func() {
		if !meterStopped {
			_ = stopMeter()
		}
	}()
	process.Stdout = io.MultiWriter(&logWriter{sink: sink, job: job, name: "stdout"}, usage)
	process.Stderr = &logWriter{sink: sink, job: job, name: "stderr"}
	steer := newSteering(job.CLI, func(res SteerResult) {
		if res.SteerID != "" {
			_ = emit(sink, Event{Type: "steer_result", RunID: job.RunID, Attempt: job.Attempt, Steer: &res})
		}
	})
	// Chạy trước khi defer gửi run_result: chỉ dẫn tới lúc verifying vẫn được báo là chưa áp dụng, sau đó thì thôi.
	defer steer.shutdown()
	var stdin io.WriteCloser
	if cmd.input == InputStreamJSON {
		if stdin, err = process.StdinPipe(); err != nil {
			return err
		}
		process.Stdout = io.MultiWriter(process.Stdout, steer)
	}
	// Process con của CLI chạy nền có thể giữ pipe mãi; chỉ chờ log thêm chừng này sau khi CLI thoát.
	process.WaitDelay = r.grace()
	if err := startProcess(process); err != nil {
		return err
	}
	if stdin != nil {
		steer.attach(stdin, job.Prompt)
	}
	steer.listen(job.Steers)
	waitErr := waitProcess(runCtx, process, r.grace)
	steer.finish()
	if errors.Is(waitErr, exec.ErrWaitDelay) {
		// CLI đã thoát thành công, chỉ là process con còn giữ pipe: không coi là lỗi của run.
		waitErr = nil
	}
	// Usage cuối gửi trước run_result: hub bỏ mọi gói của run đến sau run_result.
	meterStopped = true
	if err := stopMeter(); err != nil {
		return err
	}
	// Người huỷ cùng lúc thì báo huỷ, không báo vượt ngân sách.
	if reason := usage.exceeded(); reason != "" && ctx.Err() == nil {
		result = &Result{Status: "failed", Error: "Vượt ngân sách: " + reason}
		return errors.New(result.Error)
	}
	// CLI bắt SIGINT rồi thoát 0 khi hết giờ hay bị huỷ vẫn là run dở dang.
	if waitErr != nil || runCtx.Err() != nil {
		e := errors.Join(waitErr, runCtx.Err())
		status := "failed"
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			status = "timeout"
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			status = "cancelled"
		}
		result = &Result{Status: status, Error: e.Error()}
		return e
	}
	if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "verifying"}); err != nil {
		return err
	}
	if readOnlyKind(job.Kind) {
		// Run review và run plan không nộp code: hub chấm theo việc agent đã gọi review_submit hay plan_submit, nên không
		// đếm commit, không push.
		sha, err := gitOutput(ctx, work, "rev-parse", "HEAD")
		if err != nil {
			return err
		}
		result = &Result{Status: "succeeded", HeadSHA: strings.TrimSpace(sha), ChangedFiles: []string{}}
		return nil
	}
	countText, err := gitOutput(ctx, work, "rev-list", "--count", "origin/"+job.BaseBranch+"..HEAD")
	if err != nil {
		return err
	}
	count := 0
	_, _ = fmt.Sscanf(strings.TrimSpace(countText), "%d", &count)
	stats, err := collectDiffStats(ctx, work, "origin/"+job.BaseBranch)
	if err != nil {
		return err
	}
	sha, err := gitOutput(ctx, work, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	done := Result{Status: "succeeded", HeadSHA: strings.TrimSpace(sha), CommitCount: count, ChangedFiles: stats.ChangedFiles, DiffStats: stats}
	if count == 0 {
		done.Status = "no_changes"
	} else {
		if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "publishing"}); err != nil {
			return err
		}
		// Đường trên đã trả về trước với run chỉ đọc; kiểm lại ngay trước lệnh push để lỗi ở đó không thành push thật.
		if readOnlyKind(job.Kind) {
			err := fmt.Errorf("run %s chỉ đọc: không push", job.Kind)
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
		// push -u ghi upstream vào config chung của repo cache nên cũng phải giữ khoá.
		if err := gitWrite(ctx, cache, work, "push", "-u", "origin", "HEAD:refs/heads/"+job.Branch); err != nil {
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
	}
	result = &done
	return nil
}

func mergeMap(base, extra map[string]string) map[string]string {
	merged := make(map[string]string, len(base)+len(extra))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range extra {
		merged[key] = value
	}
	return merged
}

// ReapOrphans dọn worktree của những run không còn được worker giữ lease.
func ReapOrphans(dataDir string, liveRunIDs []string) error {
	root := filepath.Join(dataDir, "runs")
	if _, err := os.Stat(root); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	live := map[string]bool{}
	for _, id := range liveRunIDs {
		live[safeName(id)+"-"] = true
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		name := entry.Name()
		keep := false
		for prefix := range live {
			if strings.HasPrefix(name, prefix) {
				keep = true
				break
			}
		}
		if keep {
			continue
		}
		for _, repoDir := range mustReadDir(filepath.Join(dataDir, "repos")) {
			if !repoDir.IsDir() {
				continue
			}
			repo := filepath.Join(dataDir, "repos", repoDir.Name())
			_ = gitWrite(context.Background(), repo, repo, "worktree", "remove", "--force", filepath.Join(root, name))
			_ = gitWrite(context.Background(), repo, repo, "worktree", "prune")
		}
		if err := os.RemoveAll(filepath.Join(root, name)); err != nil {
			return err
		}
	}
	return nil
}
func mustReadDir(p string) []os.DirEntry { v, _ := os.ReadDir(p); return v }

// cloneOnce kiểm cache có chưa ngay trong khoá: hai run đầu tiên của một repo cùng thấy cache chưa có và cùng clone
// vào một thư mục.
func cloneOnce(ctx context.Context, dataDir, repoURL, cache string) error {
	unlock, err := lockRepo(ctx, cache)
	if err != nil {
		return err
	}
	defer unlock()
	if _, err := os.Stat(cache); !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return gitRetryLocked(ctx, dataDir, "clone", "--bare", repoURL, cache)
}

type cliExecCmd struct {
	*exec.Cmd
	cleanup func()
	// input là Command.Input: InputStreamJSON thì runner gửi prompt và chỉ dẫn qua stdin.
	input string
}

func (r Runner) cliCommand(j Job) (*cliExecCmd, error) {
	configured, ok := r.CLICommands[j.CLI]
	if !ok {
		// Runner.CLICommands do code đặt thắng biến môi trường; biến môi trường thắng lệnh mặc định.
		fromEnv, err := CommandsFromEnv()
		if err != nil {
			return nil, err
		}
		configured, ok = fromEnv[j.CLI]
	}
	if ok && readOnlyKind(j.Kind) && !configured.ReadOnly {
		return nil, fmt.Errorf("run %s chỉ đọc nhưng lệnh %s cấu hình riêng chưa khai \"readOnly\": true", j.Kind, j.CLI)
	}
	if !ok {
		if j.RunPermissions != "" && j.RunPermissions != "workspace" && j.RunPermissions != "full" {
			return nil, fmt.Errorf("chế độ quyền run không hợp lệ: %s", j.RunPermissions)
		}
		switch j.CLI {
		case "claude":
			mcpFile, err := claudeMCPConfigAt("", j.Env, claudeMCPEntries(j))
			if r.Sandbox != nil {
				mcpFile, err = claudeMCPConfigAt(j.workspace, j.Env, claudeMCPEntries(j))
				mcpFile = "/workspace/" + filepath.Base(mcpFile)
			}
			if err != nil {
				return nil, err
			}
			// Prompt đi qua stdin (stream-json) để còn gửi thêm chỉ dẫn khi agent đang chạy; xem steering.
			args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", mcpFile}
			if j.Budget.MaxCostUSD != nil {
				args = append(args, "--max-budget-usd", strconv.FormatFloat(*j.Budget.MaxCostUSD, 'f', -1, 64))
			}
			if j.Model != "" {
				args = append(args, "--model", j.Model)
			}
			if readOnlyKind(j.Kind) {
				// Chế độ plan của Claude Code chặn sửa file và chạy lệnh (đã thử trên claude 2.1.296); tool MCP chỉ gọi được
				// khi có readOnlyHint, hub đánh dấu plan_submit như vậy.
				args = append(args, "--permission-mode", "plan")
			}
			switch {
			case readOnlyKind(j.Kind):
				// Giữ chế độ plan ở trên: thêm --permission-mode thứ hai sẽ ghi đè nó và mất tính chỉ đọc.
			case j.RunPermissions == "full":
				args = append(args, "--permission-mode", "bypassPermissions")
			default:
				// Bash cho phép lệnh test/build tuỳ dự án và commit, không yêu cầu duyệt trong -p.
				args = append(args, "--permission-mode", "acceptEdits", "--allowedTools", "Bash")
			}
			return &cliExecCmd{Cmd: exec.Command("claude", args...), cleanup: func() { _ = os.Remove(mcpFile) }, input: InputStreamJSON}, nil
		case "codex":
			url := mcpURL(j.Env)
			// CLI ghép bảng MCP với cấu hình cá nhân; tránh trùng server stdio tên xdev-hive.
			args := []string{"exec", "--json", "-c", "mcp_servers={}", "-c", fmt.Sprintf("mcp_servers.xdev-hive-run={url=%q,bearer_token_env_var=\"HIVE_RUN_TOKEN\"}", url)}
			args = append(args, codexMCPArgs(j)...)
			if readOnlyKind(j.Kind) {
				// Sandbox read-only chặn ghi file và lệnh ghi; tool MCP vẫn gọi được (đã thử trên codex-cli 0.162.1).
				args = append(args, "--sandbox", "read-only")
			}
			if j.Model != "" {
				args = append(args, "-m", j.Model)
			}
			// Run plan và leader giữ sandbox read-only ở trên, không nhận cờ quyền ghi.
			if readOnlyKind(j.Kind) {
				args = append(args, "-c", `approval_policy="never"`)
			} else if j.RunPermissions == "full" {
				args = append(args, "--dangerously-bypass-approvals-and-sandbox")
			} else {
				args = append(args, "-s", "workspace-write", "-c", `approval_policy="never"`)
				if len(j.gitRoots) > 0 {
					roots, err := json.Marshal(j.gitRoots)
					if err != nil {
						return nil, err
					}
					args = append(args, "-c", "sandbox_workspace_write.writable_roots="+string(roots))
				}
			}
			args = append(args, j.Prompt)
			return &cliExecCmd{Cmd: exec.Command("codex", args...)}, nil
		case "gemini":
			args := []string{"-p", j.Prompt}
			if readOnlyKind(j.Kind) {
				// "plan (read-only mode)" theo gemini --help bản 0.63.0.
				args = append(args, "--approval-mode", "plan")
			}
			if j.Model != "" {
				args = append(args, "-m", j.Model)
			}
			args = append(args, "--skip-trust")
			// Run plan và leader không nhận policy cho phép shell hay chế độ yolo, vì chúng ghi đè chế độ plan chỉ đọc.
			if readOnlyKind(j.Kind) {
				return &cliExecCmd{Cmd: exec.Command("gemini", args...)}, nil
			}
			if j.RunPermissions == "full" {
				args = append(args, "--approval-mode", "yolo")
				return &cliExecCmd{Cmd: exec.Command("gemini", args...)}, nil
			}
			policy, err := os.CreateTemp("", "xdev-hive-policy-*.toml")
			if r.Sandbox != nil {
				policy, err = os.CreateTemp(j.workspace, ".hive-worker-policy-*.toml")
			}
			if err != nil {
				return nil, err
			}
			_, writeErr := policy.WriteString("[[rule]]\ntoolName = \"run_shell_command\"\ndecision = \"allow\"\npriority = 100\n")
			closeErr := policy.Close()
			if err := errors.Join(writeErr, closeErr); err != nil {
				_ = os.Remove(policy.Name())
				return nil, err
			}
			args = append(args, "--approval-mode", "auto_edit", "--policy", policy.Name())
			if r.Sandbox != nil {
				args[len(args)-1] = "/workspace/" + filepath.Base(policy.Name())
			}
			return &cliExecCmd{Cmd: exec.Command("gemini", args...), cleanup: func() { _ = os.Remove(policy.Name()) }}, nil
		default:
			return nil, fmt.Errorf("runner: CLI không hợp lệ: %s", j.CLI)
		}
	} else {
		configured.Args = append([]string(nil), configured.Args...)
		for i := range configured.Args {
			configured.Args[i] = strings.ReplaceAll(configured.Args[i], "{{prompt}}", j.Prompt)
		}
	}
	return &cliExecCmd{Cmd: exec.Command(configured.Path, configured.Args...), input: configured.Input}, nil
}

func claudeMCPConfig(env map[string]string) (string, error) {
	return claudeMCPConfigAt("", env, nil)
}

// claudeMCPConfigAt ghi file --mcp-config: cổng MCP của hub cộng server ngoài được phép (external, có thể rỗng).
func claudeMCPConfigAt(dir string, env map[string]string, external map[string]any) (string, error) {
	file, err := os.CreateTemp(dir, ".hive-worker-mcp-*.json")
	if err != nil {
		return "", fmt.Errorf("tạo cấu hình MCP tạm: %w", err)
	}
	if err := file.Chmod(0600); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return "", err
	}
	servers := map[string]any{}
	for name, server := range external {
		servers[name] = server
	}
	// Ghi cổng của hub sau cùng để không server ngoài nào đè được, kể cả khi lọt qua kiểm tên.
	servers["xdev-hive"] = map[string]any{"type": "http", "url": mcpURL(env), "headers": map[string]string{"Authorization": "Bearer " + env["HIVE_RUN_TOKEN"]}}
	config := map[string]any{"mcpServers": servers}
	if err := json.NewEncoder(file).Encode(config); err != nil {
		_ = file.Close()
		_ = os.Remove(file.Name())
		return "", err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(file.Name())
		return "", err
	}
	return file.Name(), nil
}

func mcpURL(env map[string]string) string {
	return strings.TrimRight(env["HIVE_HUB_URL"], "/") + "/mcp"
}
func emit(s Sink, e Event) error { return s.Emit(e) }
func validate(j Job) error {
	if j.RunID == "" || j.RepoURL == "" || j.BaseBranch == "" || j.Branch == "" || j.CLI == "" {
		return errors.New("runner: thiếu trường bắt buộc")
	}
	if strings.Contains(j.Branch, "..") {
		return errors.New("runner: nhánh không hợp lệ")
	}
	return nil
}
func safeName(s string) string {
	var b strings.Builder
	for _, c := range s {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_' {
			b.WriteRune(c)
		} else {
			b.WriteByte('-')
		}
	}
	if b.Len() > 80 {
		return b.String()[:80]
	}
	return b.String()
}
func git(ctx context.Context, dir string, args ...string) error {
	c := exec.CommandContext(ctx, "git", args...)
	c.Dir = dir
	c.Stdout = io.Discard
	c.Stderr = os.Stderr
	return c.Run()
}
func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	c := exec.CommandContext(ctx, "git", args...)
	c.Dir = dir
	b, e := c.Output()
	return string(b), e
}
func mergeEnv(base []string, over map[string]string) []string {
	m := map[string]string{}
	for _, v := range base {
		p := strings.SplitN(v, "=", 2)
		if len(p) == 2 {
			m[p[0]] = p[1]
		}
	}
	for k, v := range over {
		m[k] = v
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	out := make([]string, 0, len(keys))
	for _, k := range keys {
		out = append(out, k+"="+m[k])
	}
	return out
}
func runSetup(ctx context.Context, dir, script string, env map[string]string) error {
	var c *exec.Cmd
	if runtime.GOOS == "windows" {
		c = exec.CommandContext(ctx, "cmd.exe", "/C", script)
	} else {
		c = exec.CommandContext(ctx, "sh", "-c", script)
	}
	c.Dir = dir
	c.Env = mergeEnv(os.Environ(), env)
	c.Stdout = os.Stdout
	c.Stderr = os.Stderr
	return c.Run()
}

// logWriter đẩy log của CLI lên sink, cắt theo khối 16 KiB như trước để một event không quá lớn.
type logWriter struct {
	sink   Sink
	job    Job
	name   string
	offset int64
}

func (w *logWriter) Write(p []byte) (int, error) {
	written := 0
	for len(p) > 0 {
		n := min(len(p), 16*1024)
		data := append([]byte(nil), p[:n]...)
		if err := w.sink.Emit(Event{Type: "log", RunID: w.job.RunID, Attempt: w.job.Attempt, Stream: w.name, Offset: w.offset, Data: data}); err != nil {
			return written, err
		}
		w.offset += int64(n)
		written += n
		p = p[n:]
	}
	return written, nil
}

// startMeter đọc usage từ stdout của CLI và gửi sự kiện cost theo chu kỳ. Hàm trả về dừng chu kỳ và gửi usage cuối.
func startMeter(job Job, sink Sink, stop context.CancelFunc) (*meter, func() error) {
	m := newMeter(job.CLI, job.Budget, func(u Usage) error {
		return emit(sink, Event{Type: "cost", RunID: job.RunID, Attempt: job.Attempt, Cost: &u})
	}, func(string) { stop() })
	done := make(chan struct{})
	go func() {
		t := time.NewTicker(m.interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				_ = m.flush(false)
			case <-done:
				return
			}
		}
	}()
	return m, func() error {
		close(done)
		return m.finish()
	}
}

// ReviewDiffFile là diff của run cha mà worker ghi sẵn vào worktree của run review: CLI chạy chỉ đọc (Claude ở chế độ
// plan không chạy được lệnh) nên người review đọc file này thay cho `git diff`.
const ReviewDiffFile = ".hive-review.diff"

// reviewDiffLimit giữ file vừa sức đọc của agent; diff lớn hơn bị cắt kèm dòng báo.
const reviewDiffLimit = 1 << 20

func writeReviewDiff(ctx context.Context, work, baseBranch string) error {
	diff, err := gitOutput(ctx, work, "diff", "origin/"+baseBranch+"...HEAD")
	if err != nil {
		return err
	}
	if len(diff) > reviewDiffLimit {
		diff = diff[:reviewDiffLimit] + "\n\n[hive] Diff dài quá 1 MB, phần sau bị cắt; mở từng file cần xem.\n"
	}
	// Không để file diff lọt vào trạng thái của git trong worktree review.
	if err := appendExclude(work, ReviewDiffFile); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(work, ReviewDiffFile), []byte(diff), 0o644)
}

func appendExclude(work, name string) error {
	dir, err := gitOutput(context.Background(), work, "rev-parse", "--git-path", "info/exclude")
	if err != nil {
		return err
	}
	path := strings.TrimSpace(dir)
	if !filepath.IsAbs(path) {
		path = filepath.Join(work, path)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("\n/" + name + "\n")
	return err
}
