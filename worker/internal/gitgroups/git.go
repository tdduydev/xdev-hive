package gitgroups

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Git chạy git của máy cho một kết nối. Token chỉ đi qua askpass, không nằm trong URL, tham số hay cấu hình repo.
type Git struct {
	// Askpass là đường dẫn chính hive-worker; rỗng thì git không hỏi được mật khẩu (repo công khai, SSH).
	Askpass string
	Kind    string
	Token   string
}

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
		if !skip {
			out = append(out, kv)
		}
	}
	// Không có terminal nào để hỏi: thiếu quyền thì git báo lỗi ngay thay vì treo chờ nhập.
	// GIT_OPTIONAL_LOCKS=0: đọc trạng thái không giữ khoá index, khỏi tranh với IDE đang mở repo.
	out = append(out, "GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "LC_ALL=C", "GIT_OPTIONAL_LOCKS=0")
	if g.Askpass != "" && g.Token != "" && host != "" {
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
}

func (e *GitError) Error() string { return e.Msg }

// run chạy git trong dir (rỗng là thư mục hiện tại), trả stdout. Huỷ ctx thì git nhận Interrupt để tự dọn (clone dở
// tự xoá thư mục), quá 10 giây mới bị giết.
func (g Git) run(ctx context.Context, dir, host string, args ...string) (string, error) {
	// credential.helper rỗng: không đọc credential đã lưu của người dùng và không ghi token của app vào đó.
	full := append([]string{"-c", "credential.helper=", "-c", "core.askPass="}, args...)
	cmd := exec.CommandContext(ctx, "git", full...)
	cmd.Dir = dir
	cmd.Env = g.env(host)
	if runtime.GOOS != "windows" {
		cmd.Cancel = func() error { return cmd.Process.Signal(os.Interrupt) }
	}
	cmd.WaitDelay = 10 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return "", &GitError{Msg: "không chạy được git của máy: " + err.Error()}
		}
		return stdout.String(), &GitError{Msg: lastLine(g.redact(stderr.String()), "git "+args[0]+" lỗi")}
	}
	return stdout.String(), nil
}

func (g Git) redact(s string) string {
	if g.Token != "" {
		s = strings.ReplaceAll(s, g.Token, "***")
	}
	return s
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
