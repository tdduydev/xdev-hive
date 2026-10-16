package runner

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// CheckCommand là một lệnh kiểm của quy tắc `command` (spec 009, FR-017): hub gửi trong spec.checks.commands, worker
// chạy sau khi agent xong và trước khi đẩy.
type CheckCommand struct {
	Run        string `json:"run"`
	TimeoutSec int    `json:"timeoutSec"`
}

// CommandResult là kết quả một lệnh kiểm trong report.commands. Exit -1 là lệnh không chạy được hoặc bị dừng vì hết
// giờ (TimedOut cho biết trường hợp sau); hub chỉ coi 0 là đạt.
type CommandResult struct {
	Run        string `json:"run"`
	Exit       int    `json:"exit"`
	DurationMs int64  `json:"durationMs"`
	Tail       string `json:"tail"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

const (
	maxChecks            = 5
	defaultCheckTimeout  = 5 * time.Minute
	maxCheckTimeout      = time.Hour
	checkTailLines       = 200
	checkTailLineBytes   = 1000
	checkTailBufferBytes = 128 << 10
	maxCheckRunBytes     = 500
)

// checkEnvNames và checkEnvPrefixes là biến của máy được chuyển cho lệnh kiểm. Lệnh do quản trị đội viết nhưng chạy
// trên máy của người dùng, nên không thừa kế cả môi trường (khoá API của CLI, token đăng nhập, SSH agent); chỉ giữ
// những gì toolchain cần để chạy được.
var checkEnvNames = map[string]bool{
	"PATH": true, "HOME": true, "USER": true, "LOGNAME": true, "SHELL": true, "LANG": true, "TERM": true, "TZ": true,
	"TMPDIR": true, "TEMP": true, "TMP": true, "JAVA_HOME": true, "CI": true,
	// Go: không dùng tiền tố "GO" vì trùng GOOGLE_API_KEY và các khoá của Google.
	"GOPATH": true, "GOROOT": true, "GOFLAGS": true, "GOCACHE": true, "GOMODCACHE": true, "GOPROXY": true, "GONOSUMDB": true,
	"GONOSUMCHECK": true, "GOSUMDB": true, "GOTOOLCHAIN": true, "GOOS": true, "GOARCH": true, "GOEXPERIMENT": true,
	// Windows
	"SYSTEMROOT": true, "SYSTEMDRIVE": true, "WINDIR": true, "COMSPEC": true, "PATHEXT": true, "USERPROFILE": true,
	"APPDATA": true, "LOCALAPPDATA": true, "PROGRAMFILES": true, "PROGRAMFILES(X86)": true, "PROGRAMDATA": true,
	"HOMEDRIVE": true, "HOMEPATH": true, "USERNAME": true,
}

var checkEnvPrefixes = []string{"LC_", "CGO_", "NODE_", "NPM_CONFIG_", "PNPM_", "COREPACK_", "CARGO_", "RUSTUP_", "PYTHON", "VIRTUAL_ENV", "XDG_", "NVM_", "VOLTA_"}

func checkEnvAllowed(name string) bool {
	u := strings.ToUpper(name)
	if checkEnvNames[u] {
		return true
	}
	for _, p := range checkEnvPrefixes {
		if strings.HasPrefix(u, p) {
			return !secretName(u)
		}
	}
	return false
}

func secretName(upper string) bool {
	for _, w := range []string{"TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "AUTH", "API_KEY", "APIKEY", "PRIVATE"} {
		if strings.Contains(upper, w) {
			return true
		}
	}
	return false
}

// checkEnv dựng môi trường cho lệnh kiểm: biến máy trong allowlist, cộng env của run đã bỏ token (như hook Stop).
func checkEnv(host []string, jobEnv map[string]string) map[string]string {
	env := map[string]string{"CI": "true"}
	for _, kv := range host {
		name, value, ok := strings.Cut(kv, "=")
		if ok && checkEnvAllowed(name) {
			env[name] = value
		}
	}
	for k, v := range hookEnv(jobEnv) {
		env[k] = v
	}
	return env
}

// secretPatterns bắt chuỗi giống bí mật trong output lệnh: lệnh test hay in biến môi trường hay URL có token khi lỗi.
var secretPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`),
	regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|AKIA[0-9A-Z]{16})\b`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}`),
	regexp.MustCompile(`(?i)(://[^/\s:@]*:)[^/\s@]+@`),
	regexp.MustCompile(`(?i)\b([A-Z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)[A-Z0-9_.-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)`),
}

const redacted = "[đã che]"

// redactSecrets che chuỗi giống bí mật và giá trị chính xác của env nhạy cảm của run (token chạy run không mang
// dạng đặc trưng nào để regex bắt).
func redactSecrets(s string, exact []string) string {
	for _, v := range exact {
		if len(v) >= 6 {
			s = strings.ReplaceAll(s, v, redacted)
		}
	}
	for i, re := range secretPatterns {
		switch i {
		case 3:
			s = re.ReplaceAllString(s, "$1 "+redacted)
		case 4:
			s = re.ReplaceAllString(s, "${1}"+redacted+"@")
		case 5:
			s = re.ReplaceAllString(s, "${1}"+redacted)
		default:
			s = re.ReplaceAllString(s, redacted)
		}
	}
	return s
}

// secretValues là giá trị env của run mà tên cho thấy là bí mật.
func secretValues(env map[string]string) []string {
	var out []string
	for k, v := range env {
		if secretName(strings.ToUpper(k)) {
			out = append(out, v)
		}
	}
	return out
}

// tailBuffer giữ phần cuối của output để lệnh in hàng trăm MB không làm worker hết bộ nhớ.
type tailBuffer struct {
	buf     []byte
	dropped bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= checkTailBufferBytes {
		p = p[len(p)-checkTailBufferBytes:]
		t.buf = t.buf[:0]
		t.dropped = true
	}
	if over := len(t.buf) + len(p) - checkTailBufferBytes; over > 0 {
		t.buf = append(t.buf[:0], t.buf[over:]...)
		t.dropped = true
	}
	t.buf = append(t.buf, p...)
	return n, nil
}

// lines trả tối đa checkTailLines dòng cuối. Dòng đầu của bộ đệm bị cắt dở nên bỏ đi khi đã rơi bớt byte.
func (t *tailBuffer) lines() string {
	text := strings.ReplaceAll(string(t.buf), "\r\n", "\n")
	text = strings.TrimRight(text, "\n")
	if text == "" {
		return ""
	}
	all := strings.Split(text, "\n")
	if t.dropped && len(all) > 1 {
		all = all[1:]
	}
	if len(all) > checkTailLines {
		all = all[len(all)-checkTailLines:]
	}
	for i, l := range all {
		if len(l) > checkTailLineBytes {
			all[i] = strings.ToValidUTF8(l[:checkTailLineBytes], "") + "…"
		}
	}
	return strings.Join(all, "\n")
}

func clampCheckTimeout(sec int) time.Duration {
	d := time.Duration(sec) * time.Second
	if d <= 0 {
		return defaultCheckTimeout
	}
	return min(d, maxCheckTimeout)
}

// runChecks chạy tuần tự các lệnh kiểm trong worktree (hoặc container khi run sandbox). Lệnh lỗi không dừng chuỗi và
// không làm run lỗi: hub đánh giá report.commands. Chỉ lỗi từ ctx (huỷ run) mới trả về.
func (r Runner) runChecks(ctx context.Context, job Job, work string, log io.Writer) ([]CommandResult, error) {
	if len(job.Checks) == 0 {
		return nil, nil
	}
	checks := job.Checks
	if len(checks) > maxChecks {
		checks = checks[:maxChecks]
	}
	env := checkEnv(os.Environ(), job.Env)
	exact := secretValues(job.Env)
	results := make([]CommandResult, 0, len(checks))
	for i, c := range checks {
		if strings.TrimSpace(c.Run) == "" {
			continue
		}
		_, _ = fmt.Fprintf(log, "\n[xdev-hive] Lệnh kiểm %d/%d: %s\n", i+1, len(checks), redactSecrets(c.Run, exact))
		res := r.runCheck(ctx, job, work, fmt.Sprintf("%s-check-%d", job.RunID, i), c, env, exact)
		if err := ctx.Err(); err != nil {
			return results, err
		}
		_, _ = fmt.Fprintf(log, "[xdev-hive] Lệnh kiểm %d/%d xong: exit %d, %d ms\n", i+1, len(checks), res.Exit, res.DurationMs)
		results = append(results, res)
	}
	return results, nil
}

func (r Runner) runCheck(ctx context.Context, job Job, work, name string, c CheckCommand, env map[string]string, exact []string) CommandResult {
	cctx, cancel := context.WithTimeout(ctx, clampCheckTimeout(c.TimeoutSec))
	defer cancel()
	var cmd *exec.Cmd
	if r.Sandbox != nil {
		s := r.Sandbox.normalized()
		uid, gid, err := hostIdentity()
		if err != nil {
			return failedCheck(c, err, exact)
		}
		args := SandboxRunArgs(s, name, work, job.repoCache, job.EnvironmentImage, []string{"sh", "-lc", c.Run}, env, uid, gid)
		cmd = procattr.CommandContext(cctx, s.DockerPath, args...)
		cmd.Env = mergeEnv(os.Environ(), sandboxEnv(env, s))
		// Hết giờ chỉ giết client docker; container có thể còn chạy.
		defer r.removeSandbox(context.Background(), name)
	} else {
		if runtime.GOOS == "windows" {
			cmd = procattr.CommandContext(cctx, "cmd.exe", "/C", c.Run)
		} else {
			cmd = procattr.CommandContext(cctx, "sh", "-c", c.Run)
		}
		cmd.Dir = work
		// Không mergeEnv với os.Environ: đó là chỗ allowlist có tác dụng.
		cmd.Env = mergeEnv(nil, env)
	}
	tail := &tailBuffer{}
	cmd.Stdout, cmd.Stderr = tail, tail
	// Process con giữ pipe sau khi lệnh thoát không được làm kẹt worker.
	cmd.WaitDelay = r.grace()
	start := time.Now()
	res := CommandResult{Run: truncateRun(redactSecrets(c.Run, exact))}
	err := startProcess(cmd)
	if err == nil {
		err = waitProcess(cctx, cmd, r.grace)
	}
	res.DurationMs = time.Since(start).Milliseconds()
	timedOut := errors.Is(cctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil
	var exit *exec.ExitError
	switch {
	case err == nil || errors.Is(err, exec.ErrWaitDelay):
		res.Exit = 0
	case timedOut:
		res.Exit, res.TimedOut = -1, true
	case errors.As(err, &exit):
		res.Exit = exit.ExitCode()
	default:
		res.Exit = -1
		_, _ = fmt.Fprintf(tail, "\nKhông chạy được lệnh: %v\n", err)
	}
	if timedOut {
		_, _ = fmt.Fprintf(tail, "\nLệnh bị dừng vì quá %s.\n", clampCheckTimeout(c.TimeoutSec))
	}
	res.Tail = redactSecrets(tail.lines(), exact)
	return res
}

func failedCheck(c CheckCommand, err error, exact []string) CommandResult {
	return CommandResult{Run: truncateRun(redactSecrets(c.Run, exact)), Exit: -1, Tail: redactSecrets(err.Error(), exact)}
}

func truncateRun(s string) string {
	if len(s) > maxCheckRunBytes {
		return strings.ToValidUTF8(s[:maxCheckRunBytes], "") + "…"
	}
	return s
}
