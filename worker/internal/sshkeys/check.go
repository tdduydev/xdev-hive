package sshkeys

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// CheckResult là kết quả đăng nhập thử bằng khoá. Status là một trong: ok, auth, hostkey_changed, hostkey_unknown,
// passphrase, key_perms, unreachable, no_ssh, error.
type CheckResult struct {
	Status string `json:"status"`
	// Detail: đoạn cuối stderr của ssh để người dùng hay người hỗ trợ xem.
	Detail string `json:"detail,omitempty"`
}

const checkTimeout = 15 * time.Second

// Classify đọc mã thoát và stderr của `ssh -o BatchMode=yes`. Quyền file sai đứng trước "Permission denied" vì khi khoá
// bị bỏ qua, ssh in cả hai.
func Classify(exit int, stderr string) string {
	has := func(subs ...string) bool {
		for _, s := range subs {
			if strings.Contains(stderr, s) {
				return true
			}
		}
		return false
	}
	switch {
	case exit == 0:
		return "ok"
	case has("UNPROTECTED PRIVATE KEY FILE", "Bad owner or permissions", "Bad permissions", "bad permissions"):
		return "key_perms"
	case has("REMOTE HOST IDENTIFICATION HAS CHANGED"):
		return "hostkey_changed"
	case has("Host key verification failed", "host key is known"):
		return "hostkey_unknown"
	case has("Permission denied", "Too many authentication failures"):
		return "auth"
	case has("timed out", "Connection refused", "Could not resolve hostname", "No route to host",
		"Network is unreachable"):
		return "unreachable"
	}
	return "error"
}

// SSHPath: trên Windows ưu tiên OpenSSH của hệ điều hành, là bản người dùng gọi trong PowerShell và cmd; ssh của Git
// Bash cùng đọc ~/.ssh nên kết quả như nhau.
func SSHPath() (string, error) {
	if runtime.GOOS == "windows" {
		if root := os.Getenv("SystemRoot"); root != "" {
			p := filepath.Join(root, "System32", "OpenSSH", "ssh.exe")
			if fileExists(p) {
				return p, nil
			}
		}
	}
	return exec.LookPath("ssh")
}

func tail(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) > n {
		s = s[len(s)-n:]
	}
	return s
}

// Check đăng nhập thử bằng ssh của máy, không mật khẩu, không hỏi gì. Khoá có passphrase mà ssh-agent chưa nạp thì
// ssh cũng chỉ báo "Permission denied", nên trạng thái passphrase dựa vào cờ Encrypted và ssh-add -L (FR-036).
func Check(ctx context.Context, sshPath, alias string, key KeyInfo) CheckResult {
	if sshPath == "" {
		return CheckResult{Status: "no_ssh"}
	}
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	cmd := procattr.CommandContext(ctx, sshPath,
		"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=yes",
		"-o", "PasswordAuthentication=no", "-o", "KbdInteractiveAuthentication=no",
		"--", alias, "exit")
	var stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = io.Discard, &stderr
	err := cmd.Run()
	code := 0
	var exit *exec.ExitError
	switch {
	case err == nil:
	case ctx.Err() != nil:
		return CheckResult{Status: "unreachable", Detail: "Hết 15 giây chờ máy chủ."}
	case errors.As(err, &exit):
		code = exit.ExitCode()
	default:
		return CheckResult{Status: "no_ssh", Detail: err.Error()}
	}
	status := Classify(code, stderr.String())
	if status == "auth" && key.Encrypted && !agentHasKey(ctx, sshPath, key) {
		status = "passphrase"
	}
	return CheckResult{Status: status, Detail: tail(stderr.String(), 300)}
}

func agentHasKey(ctx context.Context, sshPath string, key KeyInfo) bool {
	fields := strings.Fields(key.PublicKey)
	if len(fields) < 2 {
		return false
	}
	add := filepath.Join(filepath.Dir(sshPath), "ssh-add"+filepath.Ext(sshPath))
	out, err := procattr.CommandContext(ctx, add, "-L").Output()
	return err == nil && bytes.Contains(out, []byte(fields[1]))
}

// Resolved là cấu hình ssh dùng cho một alias, đọc từ `ssh -G`.
type Resolved struct {
	HostName       string
	User           string
	Port           int
	IdentityFiles  []string
	IdentitiesOnly bool
	Pubkey         bool
	Proxy          bool
}

func yes(v string) bool { return v == "yes" || v == "true" }

// ParseResolved đọc output của `ssh -G`. OpenSSH 10 in true/false, bản cũ in yes/no.
func ParseResolved(out string) Resolved {
	r := Resolved{Pubkey: true}
	for _, line := range strings.Split(out, "\n") {
		key, value, _ := strings.Cut(strings.TrimSpace(line), " ")
		value = strings.TrimSpace(value)
		switch key {
		case "hostname":
			r.HostName = value
		case "user":
			r.User = value
		case "port":
			r.Port, _ = strconv.Atoi(value)
		case "identityfile":
			r.IdentityFiles = append(r.IdentityFiles, value)
		case "identitiesonly":
			r.IdentitiesOnly = yes(value)
		case "pubkeyauthentication":
			r.Pubkey = yes(value)
		case "proxyjump", "proxycommand":
			if value != "" && value != "none" {
				r.Proxy = true
			}
		}
	}
	return r
}

// Uses: ssh có đưa khoá ở keyPath khi nối alias không. Khoá chỉ được đọc từ file khi nằm trong danh sách IdentityFile
// (ssh -G đã thêm khoá mặc định khi config không ghi IdentityFile).
func (r Resolved) Uses(keyPath, home string) bool {
	if !r.Pubkey {
		return false
	}
	want := filepath.Clean(keyPath)
	for _, f := range r.IdentityFiles {
		if strings.HasPrefix(f, "~") {
			f = home + f[1:]
		}
		f = filepath.Clean(filepath.FromSlash(f))
		if f == want || (runtime.GOOS == "windows" && strings.EqualFold(f, want)) {
			return true
		}
	}
	return false
}

// Resolve chạy `ssh -G` để biết host, cổng, user thật của alias (kể cả từ Include, Match, Host *).
func Resolve(ctx context.Context, sshPath, alias string) (Resolved, error) {
	ctx, cancel := context.WithTimeout(ctx, checkTimeout)
	defer cancel()
	out, err := procattr.CommandContext(ctx, sshPath, "-G", "--", alias).Output()
	if err != nil {
		return Resolved{}, err
	}
	return ParseResolved(string(out)), nil
}
