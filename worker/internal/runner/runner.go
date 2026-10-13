// Package runner chạy một job trong worktree tạm và phát sự kiện cho transport.
package runner

import (
	"context"
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

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
)

// KindReview là run review chéo: đọc nhánh của run cha, không sửa, không push.
const KindReview = "review"

// KindPlan là run lập kế hoạch của plan mode: đọc nhánh chính, CLI chạy ở chế độ chỉ đọc, không push.
const KindPlan = "plan"

// KindLeader là run hội thoại; CLI được giới hạn chỉ đọc như KindPlan.
const KindLeader = "leader"

// KindDocCheck là run kiểm tài liệu của quy trình duyệt (gate AI): đọc nhánh chính, chỉ đọc, nộp kết quả qua MCP.
const KindDocCheck = "doccheck"

// KindDocAssist là run trợ lý của trình soạn tài liệu: đọc nhánh chính, chỉ đọc, ghi đề xuất và bình luận qua MCP.
const KindDocAssist = "docassist"

// KindBrief là run viết brief của dự án (ADR 0022): đọc nhánh chính, chỉ đọc, nộp brief qua MCP.
const KindBrief = "brief"

// Capabilities là việc ngoài run code mà worker khai với hub trong hello. Hub chỉ giao run doccheck, docassist, brief
// cho worker có nó, vì worker cũ không biết các kind này sẽ chạy như run code có quyền ghi.
var Capabilities = []string{KindDocCheck, KindDocAssist, KindBrief}

// NeedsFull: CLI chỉ chạy run code khi có toàn quyền (agy không giới hạn được trong thư mục làm việc); run chỉ đọc thì
// không cần.
func NeedsFull(cli, kind string) bool { return cli == "antigravity" && !readOnlyKind(kind) }

// readOnlyKind là nơi duy nhất quyết định run nào chỉ đọc: CLI không nhận cờ ghi (kể cả khi dự án bật quyền full),
// lệnh override phải tự khai chỉ đọc, và worker không push. Thêm kind mới thì quyết định ở đây trước.
func readOnlyKind(kind string) bool {
	return kind == KindReview || kind == KindPlan || kind == KindLeader || kind == KindDocCheck || kind == KindDocAssist || kind == KindBrief
}

// Binary là lệnh của CLI trên máy: Antigravity cài lệnh `agy`, các CLI khác trùng tên.
func Binary(cli string) string {
	if cli == "antigravity" {
		return "agy"
	}
	return cli
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
	// TokenSaving là cấu hình "Tiết kiệm token" của dự án trong spec job; nil là hub cũ (dùng mặc định).
	TokenSaving *TokenSavingJob
	Timeout     time.Duration
	SetupScript string
	// Steers nhận chỉ dẫn của hub cho run này; nil là không có. Kết quả đi ra thành sự kiện "steer_result".
	Steers           <-chan Steer
	EnvironmentImage string
	// MCPServers là MCP server ngoài hub cho phép (MCP-06); xem externalMCPServers.
	MCPServers []MCPServer
	// Policy là hook bắt buộc của tổ chức; rỗng là không có.
	Policy JobPolicy
	// ProjectID là id dự án trên hub. LocalRepo là thư mục repo máy đã gắn với dự án đó (projects.json, ADR 0020):
	// có thì worktree của run tạo từ repo này thay vì repo cache bare. Runner host bỏ qua.
	ProjectID string
	LocalRepo string
	// Checks là lệnh kiểm của quy trình review code (spec.checks.commands); chạy sau khi agent xong, trước khi đẩy.
	// Chỉ run code dùng; run chỉ đọc bỏ qua.
	Checks []CheckCommand
	// BriefSHA là commit nhánh chính mà brief hiện tại của dự án đã đọc (spec.brief.sha); rỗng là dự án chưa có brief.
	BriefSHA  string
	workspace string
	repoCache string
	// savingEnv và accountID do Run tính từ cấu hình máy và tài khoản đã giữ; nằm trên Job để đường sandbox và đường
	// host dùng chung.
	savingEnv map[string]string
	accountID string
	// rtk và codegraph là công cụ tiết kiệm token Run đã bật cho lần thử này (tools.go); nil, rỗng là không có.
	rtk       *rtkRun
	codegraph string
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
	// Commands đi vào report.commands của run_result; nil (không có lệnh kiểm) thì không xuất hiện, để hub phân biệt
	// với worker cũ chỉ khi spec có checks.commands.
	Commands []CommandResult `json:"commands,omitempty"`
	// Repo đi vào report.repo; luôn có với run do runner chạy (null từng trường khi không đo được).
	Repo *RepoReport `json:"repo,omitempty"`
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
	// Account là tài khoản CLI đã giữ cho run (spec 008 US13); nil là đăng nhập mặc định. Runner host (sandbox) bỏ qua.
	Account *accounts.Lease
	// TokenSaving, nếu có, thay HIVE_WORKER_TOKEN_SAVING (code đặt thắng biến môi trường, như CLICommands).
	TokenSaving *TokenSavingConfig
	// RTK và CodeGraph, nếu có, thay HIVE_WORKER_RTK và HIVE_WORKER_CODEGRAPH.
	RTK       *ToolConfig
	CodeGraph *ToolConfig
	KillGrace time.Duration
	// Grace, nếu có, thay KillGrace và được đọc lúc phải dừng CLI chứ không phải lúc bắt đầu, để lệnh huỷ của hub
	// đặt được thời gian chờ riêng (cancel.graceSec) cho run đang chạy. Trả 0 là dừng ngay.
	Grace func() time.Duration
	// RemoveDir, nếu có, nhận thư mục worktree cũ để xoá sau khi Run trả về (worker xoá nền để máy rảnh nhận run
	// mới ngay). Không có thì Run xoá trước khi trả về.
	RemoveDir func(dir string)
}

// trashPrefix là tên thư mục worktree đã gỡ còn chờ xoá trong runs/; ReapOrphans dọn chúng nếu worker chết giữa chừng.
const trashPrefix = ".trash-"

func (r Runner) removeDir(dir string) {
	if r.RemoveDir != nil {
		r.RemoveDir(dir)
		return
	}
	_ = os.RemoveAll(dir)
}

func (r Runner) grace() time.Duration {
	if r.Grace != nil {
		return r.Grace()
	}
	return r.KillGrace
}

// tokenSavingConfig lấy cấu hình máy; biến môi trường hỏng trả lỗi kèm cấu hình rỗng để run vẫn chạy với mặc định.
func (r Runner) tokenSavingConfig() (TokenSavingConfig, error) {
	if r.TokenSaving != nil {
		return *r.TokenSaving, nil
	}
	return TokenSavingFromEnv()
}

// overridden: CLI chạy bằng lệnh cấu hình riêng thì worker không biết cách gắn hook hay MCP vào lệnh đó.
func (r Runner) overridden(cli string) bool {
	if _, ok := r.CLICommands[cli]; ok {
		return true
	}
	fromEnv, err := CommandsFromEnv()
	_, ok := fromEnv[cli]
	return err == nil && ok
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
	src := bareSource(r.DataDir, job.RepoURL)
	if job.LocalRepo != "" && r.Sandbox == nil && job.SandboxPolicy == nil {
		src = localSource(job.LocalRepo)
	} else {
		job.repoCache = src.common
	}
	// Kết quả gửi sau khi dọn worktree: hub coi run_result là hết việc của máy và bỏ mọi sự kiện đến sau nó.
	var result *Result
	repo := &RepoReport{}
	// worktreeGit là gitdir riêng của worktree trong repo; pushed: nhánh của run đã lên origin.
	var worktreeGit string
	pushed := false
	defer func() {
		// Xoá file của worktree lớn mất cả giây: dời thư mục sang chỗ bỏ (tức thì) rồi chỉ prune trong khoá, xoá file
		// sau khi gửi kết quả. Không dời được (Windows còn process giữ file) thì gỡ như cũ.
		trash := filepath.Join(root, fmt.Sprintf("%s%s-%d", trashPrefix, filepath.Base(work), time.Now().UnixNano()))
		if os.Rename(work, trash) != nil {
			trash = ""
			// Git may refuse to remove a locked worktree; force is needed during cancellation too.
			if _, err := os.Stat(work); err == nil && src.lock != "" {
				_ = gitWrite(context.Background(), src.lock, src.dir, "worktree", "remove", "--force", work)
			}
			_ = os.RemoveAll(work)
		}
		if src.local {
			removeLocalWorktree(r.DataDir, work, worktreeGit)
			// Run không đẩy được gì thì nhánh trong repo của người dùng về như trước run.
			if pushed {
				_ = os.Remove(markPath(work))
			} else {
				restoreBranch(work)
			}
		} else {
			_ = gitWrite(context.Background(), src.lock, src.dir, "worktree", "prune")
		}
		if trash != "" {
			defer r.removeDir(trash)
		}
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
			result.Repo = repo
			if e := emit(sink, Event{Type: "result", RunID: job.RunID, Attempt: job.Attempt, Result: result}); e != nil {
				retErr = errors.Join(retErr, e)
			}
		}
	}()
	if src.local {
		if err := src.openLocal(ctx, r.DataDir, job.RepoURL); err != nil {
			return err
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(src.dir), 0700); err != nil {
			return err
		}
		if err := cloneOnce(ctx, r.DataDir, job.RepoURL, src.dir); err != nil {
			return err
		}
	}
	fetch := []string{"fetch", "origin", job.BaseBranch + ":refs/remotes/origin/" + job.BaseBranch}
	if job.Kind == KindReview {
		// Run review cần cả nhánh run cha; một lệnh fetch cho hai nhánh đỡ một lần nối và thương lượng với remote.
		fetch = append(fetch, job.Branch+":refs/remotes/origin/"+job.Branch)
	}
	if err := gitWrite(ctx, src.lock, src.dir, fetch...); err != nil {
		return err
	}
	if job.Kind == KindReview {
		// Run review đọc đúng nhánh run cha đã push. Tách HEAD thay vì tạo nhánh local để lỡ agent commit cũng không
		// có gì trỏ tới nhánh của cha.
		if err := addWorktreeAt(ctx, src.lock, src.dir, work, "--detach", work, "origin/"+job.Branch); err != nil {
			return err
		}
		if err := writeReviewDiff(ctx, work, job.BaseBranch); err != nil {
			return err
		}
	} else if job.Kind == KindPlan || job.Kind == KindLeader || job.Kind == KindDocCheck || job.Kind == KindDocAssist || job.Kind == KindBrief {
		// Kế hoạch lập trên nhánh chính, nơi run code sẽ bắt đầu. Tách HEAD để không tạo hay đặt lại nhánh ai/<task>
		// của run code.
		if err := addWorktreeAt(ctx, src.lock, src.dir, work, "--detach", work, "origin/"+job.BaseBranch); err != nil {
			return err
		}
	} else {
		if src.local {
			if err := src.prepareBranch(ctx, root, work, job.Branch); err != nil {
				return err
			}
		}
		if err := addWorktreeAt(ctx, src.lock, src.dir, work, "-B", job.Branch, work, "origin/"+job.BaseBranch); err != nil {
			return err
		}
	}
	job.workspace = work
	repo = repoReport(ctx, work, job)
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
	timeout := job.Timeout
	// Thời hạn run của tài khoản (như app v1) chỉ rút ngắn thời hạn hub đặt, không kéo dài.
	if t := r.Account.Timeout(); r.Sandbox == nil && t > 0 && (timeout <= 0 || t < timeout) {
		timeout = t
	}
	if timeout > 0 {
		runCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	// Git ghi index trong gitdir riêng và objects/refs trong bare cache (hoặc .git của repo đã gắn) ngoài worktree.
	gitDir, err := gitOutput(ctx, work, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return err
	}
	worktreeGit = filepath.Clean(filepath.FromSlash(strings.TrimSpace(gitDir)))
	cacheRoot, err := filepath.Abs(src.common)
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
	savingCfg, savingErr := r.tokenSavingConfig()
	job.savingEnv = savingEnv(savingCfg, job)
	if r.Sandbox == nil {
		job.accountID = r.Account.ID()
	}
	// Giữ hai writer để log của hook Stop nối tiếp offset của log CLI. Tạo trước CLI để bước chuẩn bị công cụ (dựng chỉ
	// mục CodeGraph lần đầu mất vài chục giây) hiện ngay trong log của run.
	stdoutLog := &logWriter{sink: sink, job: job, name: "stdout"}
	stderrLog := &logWriter{sink: sink, job: job, name: "stderr"}
	job.codegraph = r.prepareCodeGraph(runCtx, job, work, stderrLog)
	if job.rtk = r.prepareRTK(runCtx, job, stderrLog); job.rtk != nil {
		defer job.rtk.cleanup()
		job.savingEnv = mergeMap(job.savingEnv, job.rtk.env)
	}
	cmd, err := r.cliCommand(job)
	if err != nil {
		return err
	}
	if cmd.cleanup != nil {
		defer cmd.cleanup()
	}
	process := cmd.Cmd
	process.Dir = work
	// job.Env của dự án đặt sau nhóm tiết kiệm token: biến dự án đã đặt rõ thì không bị mặc định đè.
	process.Env = mergeEnv(os.Environ(), mergeMap(job.savingEnv, job.Env))
	if r.Sandbox == nil {
		// Đặt sau job.Env để spec của hub không đổi được thư mục đăng nhập của máy.
		process.Env = mergeEnv(process.Env, r.Account.Env())
	}
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
	process.Stdout = io.MultiWriter(stdoutLog, usage)
	process.Stderr = stderrLog
	if r.Account != nil && r.Sandbox == nil {
		_, _ = fmt.Fprintf(stderrLog, "[xdev-hive] %s chạy bằng tài khoản %s.\n", job.CLI, r.Account.Label())
		// Run không thành công vì tài khoản hết lượt dùng: cho tài khoản nghỉ để run sau sang tài khoản khác. Chỉ xét khi
		// run hỏng, vì agent đọc hay in đúng câu đó (vd. sửa chính file này) không có nghĩa là hết lượt.
		limit := &accounts.LimitWatcher{}
		process.Stdout = io.MultiWriter(process.Stdout, limit)
		process.Stderr = io.MultiWriter(stderrLog, limit)
		defer func() {
			if limit.Hit() && (result == nil || (result.Status != "succeeded" && result.Status != "no_changes")) {
				r.Account.Cooldown()
				_, _ = fmt.Fprintf(stderrLog, "[xdev-hive] Tài khoản %s hết lượt dùng, nghỉ trước khi nhận run mới.\n", r.Account.Label())
			}
		}()
	}
	if cmd.notice != "" {
		_, _ = fmt.Fprintln(stderrLog, cmd.notice)
	}
	if savingErr != nil {
		_, _ = fmt.Fprintf(stderrLog, "[xdev-hive] Bỏ qua cấu hình tiết kiệm token của máy: %v\n", savingErr)
	}
	if tool := hooksOf(job.Policy.Hooks, "PreToolUse", "PostToolUse"); len(tool) > 0 && (job.CLI != "claude" || cmd.input != InputStreamJSON) {
		// Chỉ Claude Code nhận hook theo tool qua --settings; báo vào log để người xem run biết hook nào không chạy.
		_, _ = fmt.Fprintf(stderrLog, "[xdev-hive] %s không chạy được %d hook PreToolUse/PostToolUse của tổ chức; hook Stop vẫn chạy.\n", job.CLI, len(tool))
	}
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
	if job.rtk != nil {
		// Đọc sau khi CLI thoát để đủ mọi lệnh của run; số đi trong usage cuối cùng ngay dưới.
		if saved, err := job.rtk.usage(ctx); err != nil {
			_, _ = fmt.Fprintf(stderrLog, "[xdev-hive] Không đọc được số tiết kiệm của RTK: %v\n", err)
		} else {
			usage.setRTK(saved)
		}
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
	if !readOnlyKind(job.Kind) {
		if err := r.runStopHooks(ctx, job, work, stdoutLog, stderrLog); err != nil {
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
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
		// Lệnh lỗi không chặn đẩy: hub đọc report.commands và quyết ở checkpoint, nên người xem vẫn thấy PR.
		commands, err := r.runChecks(ctx, job, work, stdoutLog)
		if err != nil {
			return err
		}
		done.Commands = commands
		if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "publishing"}); err != nil {
			return err
		}
		// Đường trên đã trả về trước với run chỉ đọc; kiểm lại ngay trước lệnh push để lỗi ở đó không thành push thật.
		if readOnlyKind(job.Kind) {
			err := fmt.Errorf("run %s chỉ đọc: không push", job.Kind)
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
		// Không -u: upstream không ai đọc, mà ghi nó vào config chung thì push (chờ mạng) phải giữ khoá repo cache và
		// config phình thêm một mục mỗi run. Push không ghi gì vào cache nên chạy ngoài khoá.
		if err := gitRetryLocked(ctx, work, "push", "origin", "HEAD:refs/heads/"+job.Branch); err != nil {
			result = &Result{Status: "failed", Error: err.Error()}
			return err
		}
		pushed = true
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
	isLive := func(name string) bool {
		for prefix := range live {
			if strings.HasPrefix(name, prefix) {
				return true
			}
		}
		return false
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
		if isLive(name) {
			continue
		}
		// Worktree của repo đã gắn: gỡ siêu dữ liệu trong repo người dùng và trả nhánh về như trước run.
		reapLocal(dataDir, filepath.Join(root, name))
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
	// File ghi nhánh còn lại khi worker chết sau lúc dời worktree mà trước lúc trả nhánh.
	for _, entry := range mustReadDir(root) {
		if base, ok := strings.CutSuffix(entry.Name(), ".branch.json"); ok && !entry.IsDir() && !isLive(base) {
			restoreBranch(filepath.Join(root, base))
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

// addWorktree chỉ giữ khoá repo cache lúc git đăng ký worktree (sửa config, ref chung). Checkout ghi index riêng của
// worktree và file trong thư mục run, nên làm ngoài khoá: repo lớn checkout mất vài giây, giữ khoá thì các run song
// song của cùng repo phải xếp hàng chờ nhau.
func addWorktree(ctx context.Context, cache, work string, args ...string) error {
	return addWorktreeAt(ctx, cache, cache, work, args...)
}

// addWorktreeAt như addWorktree, với khoá và thư mục chạy lệnh riêng (repo đã gắn khoá trong DataDir).
func addWorktreeAt(ctx context.Context, lock, dir, work string, args ...string) error {
	if err := gitWrite(ctx, lock, dir, append([]string{"worktree", "add", "--no-checkout"}, args...)...); err != nil {
		return err
	}
	return git(ctx, work, "reset", "--hard", "--quiet")
}

type cliExecCmd struct {
	*exec.Cmd
	cleanup func()
	// input là Command.Input: InputStreamJSON thì runner gửi prompt và chỉ dẫn qua stdin.
	input string
	// notice là dòng runner ghi vào stderr của run trước khi chạy CLI, để người xem run biết CLI bị giới hạn gì.
	notice string
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
			// Chỉ hook của tổ chức: không nạp .claude/settings.json của repo (hook, quyền, biến môi trường trong đó).
			sources := "project"
			if j.Policy.ManagedHooksOnly {
				sources = ""
			}
			args := []string{"-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--setting-sources", sources, "--strict-mcp-config", "--mcp-config", mcpFile}
			hooks := j.Policy.Hooks
			if j.rtk != nil {
				// Hook RTK đi cùng file --settings với hook của tổ chức: không ghi vào cấu hình của người dùng hay tài khoản.
				hooks = append(append([]Hook(nil), hooks...), Hook{Event: "PreToolUse", Name: "rtk", Command: j.rtk.hook, Matcher: "Bash"})
			}
			hookSettings, err := claudeHookSettings(hooks)
			if err != nil {
				return nil, err
			}
			if hookSettings != "" {
				args = append(args, "--settings", hookSettings)
			}
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
				allowed := "Bash"
				if j.codegraph != "" {
					allowed += ",mcp__" + codegraphServerName
				}
				args = append(args, "--permission-mode", "acceptEdits", "--allowedTools", allowed)
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
			if _, err := writeGeminiSettings(j); err != nil {
				return nil, fmt.Errorf("ghi cấu hình MCP cho Gemini: %w", err)
			}
			args = append(args, geminiMCPArgs(j)...)
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
		case "antigravity":
			config, err := writeAntigravityMCPConfig(j)
			if err != nil {
				return nil, fmt.Errorf("ghi cấu hình MCP cho Antigravity: %w", err)
			}
			args := []string{"-p", j.Prompt, "--output-format", "stream-json"}
			if j.Timeout > 0 {
				// Để agy tự dừng lượt trước khi runner phải ngắt nó; context của runner vẫn là chốt chặn sau cùng.
				args = append(args, "--print-timeout", fmt.Sprintf("%dm", int((j.Timeout+time.Minute-1)/time.Minute)))
			}
			if j.Model != "" {
				args = append(args, "--model", j.Model)
			}
			// agy 1.3.3 không có cờ nạp MCP: nó đọc cấu hình worker ghi trong .agents/ của worktree, cộng cả
			// ~/.gemini/config/mcp_config.json của máy mà worker không chặn được.
			notice := "[xdev-hive] antigravity nạp MCP của hub từ " + filepath.ToSlash(config) + " trong worktree; agy không có cờ nạp MCP nên cũng nạp server khai trong ~/.gemini/config/mcp_config.json của máy."
			if config == "" && j.workspace != "" {
				notice = "[xdev-hive] antigravity chạy không có MCP của hub: repo đã có .agents/mcp_config.json và .agents/plugins/" + antigravityPlugin + "."
			}
			if readOnlyKind(j.Kind) {
				// Chế độ plan và sandbox của agy chặn ghi file và lệnh ghi, nhưng chỉ khi không có
				// --dangerously-skip-permissions: cờ đó duyệt cả việc ghi, bỏ qua chế độ plan lẫn sandbox (đã thử trên agy
				// 1.3.3). Thiếu cờ đó agy -p tự từ chối mọi quyền nó không hỏi được, gồm lệnh shell và tool MCP.
				args = append(args, "--mode", "plan", "--sandbox")
				notice += fmt.Sprintf("\n[xdev-hive] antigravity chạy run %s ở chế độ plan và sandbox chỉ đọc; agy -p từ chối gọi tool MCP khi không có --dangerously-skip-permissions, nên run không nộp được kết quả qua MCP của hub.", j.Kind)
			} else {
				// agy -p không hỏi được quyền nên chỉ chạy không tương tác với --dangerously-skip-permissions, và sandbox của
				// agy 1.3.3 là sandbox chỉ đọc (chặn cả ghi file trong worktree lẫn git commit, đã thử trên macOS). Không có
				// cách giới hạn agy trong worktree, nên chỉ chạy khi dự án cho toàn quyền; hub cũng không giao trường hợp khác.
				if j.RunPermissions != "full" {
					return nil, fmt.Errorf("Antigravity chỉ chạy run code khi dự án cho toàn quyền (full): agy không giới hạn được trong thư mục làm việc")
				}
				args = append(args, "--dangerously-skip-permissions")
			}
			return &cliExecCmd{Cmd: exec.Command(Binary(j.CLI), args...), notice: notice}, nil
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
		u.AccountID = job.accountID
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
	// info/exclude nằm ở thư mục git chung: với repo người dùng đã gắn (ADR 0020), ghi mỗi run một dòng sẽ làm file
	// của họ dài mãi.
	if b, err := os.ReadFile(path); err == nil && strings.Contains("\n"+string(b)+"\n", "\n/"+name+"\n") {
		return nil
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
