// Package runner chạy một job trong worktree tạm và phát sự kiện cho transport.
package runner

import (
	"bufio"
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
	"strings"
	"time"
)

type Job struct {
	RunID                                    string
	Attempt                                  int
	RepoURL, BaseBranch, Branch, CLI, Prompt string
	Env                                      map[string]string
	Timeout                                  time.Duration
	SetupScript                              string
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
}

type Sink interface{ Emit(Event) error }
type SinkFunc func(Event) error

func (f SinkFunc) Emit(e Event) error { return f(e) }

type Result struct {
	Status       string   `json:"status"`
	HeadSHA      string   `json:"headSha,omitempty"`
	CommitCount  int      `json:"commitCount"`
	ChangedFiles []string `json:"changedFiles"`
	Error        string   `json:"error,omitempty"`
}

// Command là lệnh chạy một CLI; "{{prompt}}" trong Args được thay bằng prompt của job.
type Command struct {
	Path string   `json:"path"`
	Args []string `json:"args"`
}

// CLIOverridesEnv thay lệnh của từng CLI mà không phải build lại worker, để scripts/e2e-smoke.ts trỏ "claude" tới
// một CLI giả. Giá trị là JSON: {"claude": {"path": "/usr/bin/node", "args": ["fake.ts", "{{prompt}}"]}}.
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
	KillGrace   time.Duration
}

func Run(ctx context.Context, job Job, sink Sink) error { return (Runner{}).Run(ctx, job, sink) }

func (r Runner) Run(ctx context.Context, job Job, sink Sink) (retErr error) {
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
	resultSent := false
	defer func() {
		// Git may refuse to remove a locked worktree; force is needed during cancellation too.
		_ = git(context.Background(), cache, "worktree", "remove", "--force", work)
		_ = os.RemoveAll(work)
		_ = git(context.Background(), cache, "worktree", "prune")
		_ = emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "cleanup"})
		if !resultSent && retErr != nil {
			status := "failed"
			if errors.Is(ctx.Err(), context.Canceled) {
				status = "cancelled"
			} else if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				status = "timeout"
			}
			_ = emit(sink, Event{Type: "result", RunID: job.RunID, Attempt: job.Attempt, Result: &Result{Status: status, Error: retErr.Error()}})
		}
	}()
	if err := os.MkdirAll(filepath.Dir(cache), 0700); err != nil {
		return err
	}
	if _, err := os.Stat(cache); errors.Is(err, os.ErrNotExist) {
		if err := git(ctx, r.DataDir, "clone", "--bare", job.RepoURL, cache); err != nil {
			return err
		}
	}
	if err := git(ctx, cache, "fetch", "origin", job.BaseBranch+":refs/remotes/origin/"+job.BaseBranch); err != nil {
		return err
	}
	if err := git(ctx, cache, "worktree", "add", "-B", job.Branch, work, "origin/"+job.BaseBranch); err != nil {
		return err
	}
	if job.SetupScript != "" {
		if err := runSetup(ctx, work, job.SetupScript, job.Env); err != nil {
			resultSent = true
			return r.finish(sink, job, Result{Status: "failed", Error: err.Error()}, err)
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
	cmd, err := r.cliCommand(job)
	if err != nil {
		return err
	}
	cmd.Dir = work
	cmd.Env = mergeEnv(os.Environ(), job.Env)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := startProcess(cmd); err != nil {
		return err
	}
	logErr := make(chan error, 2)
	go func() { logErr <- stream(runCtx, stdout, sink, job, "stdout") }()
	go func() { logErr <- stream(runCtx, stderr, sink, job, "stderr") }()
	waitErr := waitProcess(runCtx, cmd, r.KillGrace)
	e1, e2 := <-logErr, <-logErr
	if waitErr != nil || e1 != nil || e2 != nil {
		e := errors.Join(waitErr, e1, e2)
		status := "failed"
		if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
			status = "timeout"
		}
		if errors.Is(ctx.Err(), context.Canceled) {
			status = "cancelled"
		}
		resultSent = true
		return r.finish(sink, job, Result{Status: status, Error: e.Error()}, e)
	}
	if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "verifying"}); err != nil {
		return err
	}
	countText, err := gitOutput(ctx, work, "rev-list", "--count", "origin/"+job.BaseBranch+"..HEAD")
	if err != nil {
		return err
	}
	count := 0
	_, _ = fmt.Sscanf(strings.TrimSpace(countText), "%d", &count)
	filesText, err := gitOutput(ctx, work, "diff", "--name-only", "origin/"+job.BaseBranch+"...HEAD")
	if err != nil {
		return err
	}
	files := []string{}
	for _, f := range strings.Split(strings.TrimSpace(filesText), "\n") {
		if f != "" {
			files = append(files, f)
		}
	}
	sha, err := gitOutput(ctx, work, "rev-parse", "HEAD")
	if err != nil {
		return err
	}
	result := Result{Status: "succeeded", HeadSHA: strings.TrimSpace(sha), CommitCount: count, ChangedFiles: files}
	if count == 0 {
		result.Status = "no_changes"
	} else {
		if err := emit(sink, Event{Type: "phase", RunID: job.RunID, Attempt: job.Attempt, Phase: "publishing"}); err != nil {
			return err
		}
		if err := git(ctx, work, "push", "-u", "origin", "HEAD:refs/heads/"+job.Branch); err != nil {
			resultSent = true
			return r.finish(sink, job, Result{Status: "failed", Error: err.Error()}, err)
		}
	}
	resultSent = true
	return r.finish(sink, job, result, nil)
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
			_ = git(context.Background(), repo, "worktree", "remove", "--force", filepath.Join(root, name))
			_ = git(context.Background(), repo, "worktree", "prune")
		}
		if err := os.RemoveAll(filepath.Join(root, name)); err != nil {
			return err
		}
	}
	return nil
}
func mustReadDir(p string) []os.DirEntry { v, _ := os.ReadDir(p); return v }

func (r Runner) cliCommand(j Job) (*exec.Cmd, error) {
	configured, ok := r.CLICommands[j.CLI]
	if !ok {
		// Runner.CLICommands do code đặt thắng biến môi trường; biến môi trường thắng lệnh mặc định.
		fromEnv, err := CommandsFromEnv()
		if err != nil {
			return nil, err
		}
		configured, ok = fromEnv[j.CLI]
	}
	if !ok {
		switch j.CLI {
		case "claude":
			configured = Command{Path: "claude", Args: []string{"-p", j.Prompt, "--output-format", "stream-json"}}
		case "codex":
			configured = Command{Path: "codex", Args: []string{"exec", j.Prompt}}
		case "gemini":
			configured = Command{Path: "gemini", Args: []string{"-p", j.Prompt}}
		default:
			return nil, fmt.Errorf("runner: CLI không hợp lệ: %s", j.CLI)
		}
	} else {
		configured.Args = append([]string(nil), configured.Args...)
		for i := range configured.Args {
			configured.Args[i] = strings.ReplaceAll(configured.Args[i], "{{prompt}}", j.Prompt)
		}
	}
	return exec.Command(configured.Path, configured.Args...), nil
}
func (r Runner) finish(s Sink, j Job, v Result, err error) error {
	if e := emit(s, Event{Type: "result", RunID: j.RunID, Attempt: j.Attempt, Result: &v}); e != nil {
		return errors.Join(err, e)
	}
	return err
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
func stream(ctx context.Context, r io.Reader, s Sink, j Job, name string) error {
	br := bufio.NewReader(r)
	var offset int64
	buf := make([]byte, 16*1024)
	for {
		n, e := br.Read(buf)
		if n > 0 {
			data := append([]byte(nil), buf[:n]...)
			if err := s.Emit(Event{Type: "log", RunID: j.RunID, Attempt: j.Attempt, Stream: name, Offset: offset, Data: data}); err != nil {
				return err
			}
			offset += int64(n)
		}
		if e != nil {
			if errors.Is(e, io.EOF) {
				return nil
			}
			return e
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
}
