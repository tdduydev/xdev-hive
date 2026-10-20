// Package gitexec chạy git của máy cho gitgroups và branches: môi trường không hỏi mật khẩu, token chỉ đi qua askpass,
// lỗi đã che token.
package gitexec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// Loại máy chủ Git; quyết định tên đăng nhập đi với token.
const (
	KindGitLab = "gitlab"
	KindGitHub = "github"
)

// Git chạy git của máy cho một kết nối. Token chỉ đi qua askpass, không nằm trong URL, tham số hay cấu hình repo.
type Git struct {
	// Askpass là đường dẫn chính hive-worker; rỗng thì git không hỏi được mật khẩu (repo công khai, SSH).
	Askpass           string
	Kind              string
	Token             string
	UseGitCredentials bool
	// MachineCredentials: git dùng credential helper, khoá SSH của máy như người dùng tự gõ (quản lý nhánh, spec 026).
	// Khác UseGitCredentials ở chỗ lệnh tại máy vẫn trả dòng lỗi của git, vì chỉ lệnh mạng mới gọi tới helper.
	MachineCredentials bool
	// Timeout > 0: quá hạn thì dừng git như khi huỷ và trả GitError có Timeout.
	Timeout time.Duration
}

// machine: không đặt credential.helper rỗng và không đưa askpass của người dùng cho git.
func (g Git) machine() bool { return g.UseGitCredentials || g.MachineCredentials }

// networkCommands là lệnh git gọi tới máy chủ, tức có thể chạy credential helper.
var networkCommands = map[string]bool{"fetch": true, "ls-remote": true, "pull": true, "push": true, "clone": true}

// secretEnv là biến môi trường không được lọt sang git và các tiến trình con của nó.
var secretEnv = []string{TokensEnv, TokenEnv, AskpassEnv, askpassUserEnv, askpassTokenEnv, askpassHostEnv}

// env cho một lệnh git. host là máy chủ của URL HTTPS sẽ gọi; askpass chỉ trả token cho đúng máy chủ đó.
func (g Git) env(host string) []string {
	out := make([]string, 0, len(os.Environ())+8)
	for _, kv := range os.Environ() {
		name, _, _ := strings.Cut(kv, "=")
		skip := false
		for _, s := range secretEnv {
			if strings.EqualFold(name, s) {
				skip = true
			}
		}
		if g.machine() && (strings.EqualFold(name, "GIT_ASKPASS") || strings.EqualFold(name, "SSH_ASKPASS")) {
			skip = true
		}
		if !skip {
			out = append(out, kv)
		}
	}
	// Không có terminal nào để hỏi: thiếu quyền thì git báo lỗi ngay thay vì treo chờ nhập.
	// GIT_OPTIONAL_LOCKS=0: đọc trạng thái không giữ khoá index, khỏi tranh với IDE đang mở repo.
	out = append(out, "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0")
	if !g.machine() && g.Askpass != "" && g.Token != "" && host != "" {
		out = append(out,
			"GIT_ASKPASS="+g.Askpass,
			AskpassEnv+"=1",
			askpassUserEnv+"="+tokenUser(g.Kind),
			askpassTokenEnv+"="+g.Token,
			askpassHostEnv+"="+host,
		)
	}
	return out
}

// GitError là lỗi của một lệnh git, kèm dòng cuối stderr đã bỏ token.
type GitError struct {
	Msg string
	// Auth: máy chủ từ chối đăng nhập. Lần thử sai liên tiếp làm GitLab khoá IP cho Git qua HTTPS (mặc định 10 lần
	// trong một phút, khoá một giờ), nên thao tác hàng loạt dừng gọi máy chủ khi gặp lỗi này.
	Auth bool
	// Timeout: git chạy quá Git.Timeout nên đã bị dừng.
	Timeout bool
}

// authFailures là dấu hiệu trong stderr của git khi máy chủ không nhận đăng nhập hoặc git không có gì để gửi.
var authFailures = []string{
	"authentication failed",
	"http basic: access denied",
	"could not read username",
	"could not read password",
	"invalid username or password",
}

func authFailed(stderr string) bool {
	s := strings.ToLower(stderr)
	for _, m := range authFailures {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

func (e *GitError) Error() string { return e.Msg }

// Run chạy git trong dir (rỗng là thư mục hiện tại), trả stdout. Huỷ ctx thì git nhận Interrupt để tự dọn (clone dở
// tự xoá thư mục), quá 10 giây mới bị giết. Hết Timeout cũng dừng git theo cách đó.
func (g Git) Run(ctx context.Context, dir, host string, args ...string) (string, error) {
	// credential.helper rỗng: không đọc credential đã lưu của người dùng và không ghi token của app vào đó.
	full := append([]string{"-c", "credential.helper=", "-c", "core.askPass="}, args...)
	if g.machine() {
		full = append([]string{"-c", "core.askPass="}, args...)
	}
	runCtx := ctx
	if g.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, g.Timeout)
		defer cancel()
	}
	cmd := procattr.CommandContext(runCtx, "git", full...)
	cmd.Dir = dir
	cmd.Env = g.env(host)
	interruptGroup(cmd)
	cmd.WaitDelay = 10 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		if runCtx.Err() != nil {
			return "", &GitError{Timeout: true, Msg: fmt.Sprintf("git %s chạy quá %g giây nên đã dừng.", args[0], g.Timeout.Seconds())}
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return "", &GitError{Msg: "không chạy được git của máy: " + err.Error()}
		}
		auth := authFailed(stderr.String())
		// Helper có thể tự ghi secret vào stderr; không chuyển đầu ra đó tới UI hay log.
		if g.UseGitCredentials {
			if auth {
				return "", &GitError{Auth: true, Msg: "Máy chủ từ chối đăng nhập Git của máy; kiểm tra credential helper, hạn và quyền đọc repo của token."}
			}
			return "", &GitError{Msg: "Git của máy không hoàn tất thao tác; kiểm tra đăng nhập Git và quyền truy cập repo."}
		}
		if g.MachineCredentials && networkCommands[args[0]] {
			if auth {
				return "", &GitError{Auth: true, Msg: "Máy chủ từ chối đăng nhập Git của máy; kiểm tra credential helper, khoá SSH và quyền truy cập repo."}
			}
			return "", &GitError{Msg: "git " + args[0] + " không hoàn tất; kiểm tra mạng, đăng nhập Git của máy và quyền truy cập repo."}
		}
		return stdout.String(), &GitError{Auth: auth, Msg: lastLine(g.redact(stderr.String()), "git "+args[0]+" lỗi")}
	}
	return stdout.String(), nil
}

// urlUserinfo là phần "user:mật-khẩu@" của URL trong câu lỗi; remote của người dùng hay chứa token kiểu
// https://ghp_…@github.com/….
var urlUserinfo = regexp.MustCompile(`([A-Za-z][A-Za-z0-9+.-]*://)([^/\s@'"]+)@`)

func (g Git) redact(s string) string {
	if g.Token != "" {
		s = strings.ReplaceAll(s, g.Token, "***")
	}
	return urlUserinfo.ReplaceAllStringFunc(s, func(m string) string {
		p := urlUserinfo.FindStringSubmatch(m)
		// ssh://git@host chỉ có tên người dùng, không phải secret; giữ để lỗi còn đọc được như projects.Redact.
		if strings.EqualFold(p[1], "ssh://") && !strings.Contains(p[2], ":") {
			return m
		}
		return p[1] + "***@"
	})
}

// lastLine lấy dòng có nghĩa cuối cùng của stderr: git in tiến độ trước, lỗi thật ở cuối.
func lastLine(s, fallback string) string {
	lines := strings.Split(strings.ReplaceAll(strings.TrimSpace(s), "\r", "\n"), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			if len(l) > 300 {
				l = l[:300] + "…"
			}
			return l
		}
	}
	return fallback
}
