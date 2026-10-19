package sshkeys

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strings"

	"golang.org/x/crypto/ssh"
)

var (
	ErrHostKeyMismatch = errors.New("khoá máy chủ khác dấu vân tay đã xác nhận; app dừng và không gửi mật khẩu")
	ErrHostKeyChanged  = errors.New("khoá máy chủ khác khoá trong known_hosts, có thể bị giả mạo; app dừng và không gửi mật khẩu")
	ErrAuthFailed      = errors.New("sai mật khẩu hoặc máy chủ không cho đăng nhập bằng mật khẩu")
	ErrExtraAuth       = errors.New("máy chủ hỏi thêm mã xác minh (OTP, 2FA); app chưa hỗ trợ, hãy cài khoá bằng tay")
	errAlreadySent     = errors.New("đã gửi mật khẩu một lần")
)

// InstallError: máy chủ chạy script cài khoá không thành công.
type InstallError struct{ Stderr string }

func (e *InstallError) Error() string {
	return "máy chủ báo lỗi khi cài khoá: " + e.Stderr
}

// InstallOptions: mật khẩu là []byte để người gọi xoá được sau khi dùng.
type InstallOptions struct {
	Host        string
	Port        int
	User        string
	Fingerprint string
	Password    []byte
	KnownHosts  string
}

var keyLineRe = regexp.MustCompile(`^[a-z][a-z0-9@.-]* [A-Za-z0-9+/]+={0,3}( [A-Za-z0-9@._ -]+)?$`)

// InstallScript là script sh cài dòng khoá vào ~/.ssh/authorized_keys. Script đi qua stdin của `exec sh -s`: máy chủ luôn
// chạy chuỗi lệnh bằng shell đăng nhập (có thể là fish, tcsh), nên chuỗi lệnh chỉ là `exec sh -s`, phần còn lại là sh.
// Dòng khoá đã kiểm chỉ gồm ký tự an toàn nên nằm được trong nháy đơn.
func InstallScript(keyLine string) (string, error) {
	if !keyLineRe.MatchString(keyLine) {
		return "", fmt.Errorf("dòng khoá công khai không hợp lệ")
	}
	blob := strings.Fields(keyLine)[1]
	return `set -e
umask 077
key='` + keyLine + `'
blob='` + blob + `'
d="$HOME/.ssh"
f="$d/authorized_keys"
mkdir -p "$d"
chmod 700 "$d"
touch "$f"
chmod 600 "$f"
if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf '\n' >> "$f"; fi
# Khoá đã có (kể cả có option phía trước hay comment khác) thì không thêm: so phần base64.
if ! awk -v k="$blob" '{ for (i = 1; i <= NF; i++) if ($i == k) found = 1 } END { exit !found }' "$f"; then
  printf '%s\n' "$key" >> "$f"
fi
if command -v restorecon >/dev/null 2>&1; then restorecon -R "$d" >/dev/null 2>&1 || true; fi
`, nil
}

// looksLikePassword: chỉ trả lời câu hỏi mật khẩu; câu hỏi khác (mã OTP) thì dừng, không gửi mật khẩu làm mã.
func looksLikePassword(q string) bool {
	q = strings.ToLower(q)
	return strings.Contains(q, "password") || strings.Contains(q, "mật khẩu")
}

// Install nối máy chủ có khoá khớp o.Fingerprint, xác thực bằng mật khẩu đúng một lần (password, không thì
// keyboard-interactive), rồi chạy InstallScript. Mỗi lần gọi gửi mật khẩu tối đa một lần để không làm khoá tài khoản ở
// máy chủ đếm lần sai (pam_faillock).
func Install(ctx context.Context, o InstallOptions, keyLine string) (ssh.PublicKey, error) {
	script, err := InstallScript(keyLine)
	if err != nil {
		return nil, err
	}
	var hostKey ssh.PublicKey
	var hostErr error
	sent, extra := false, false
	password := func() (string, error) {
		if sent {
			return "", errAlreadySent
		}
		sent = true
		return string(o.Password), nil
	}
	cfg := &ssh.ClientConfig{
		User:              o.User,
		HostKeyAlgorithms: hostKeyAlgorithms(KnownKeyTypes(o.KnownHosts, o.Host, o.Port)),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if ssh.FingerprintSHA256(key) != o.Fingerprint {
				hostErr = ErrHostKeyMismatch
				return hostErr
			}
			status, err := HostKeyStatus(o.KnownHosts, o.Host, o.Port, key)
			if err != nil {
				hostErr = err
				return err
			}
			if status == "changed" {
				hostErr = ErrHostKeyChanged
				return hostErr
			}
			hostKey = key
			return nil
		},
		Auth: []ssh.AuthMethod{
			ssh.PasswordCallback(password),
			ssh.KeyboardInteractive(func(_, _ string, questions []string, echos []bool) ([]string, error) {
				if len(questions) == 0 {
					return nil, nil
				}
				if len(questions) != 1 || echos[0] || !looksLikePassword(questions[0]) {
					extra = true
					return nil, ErrExtraAuth
				}
				p, err := password()
				if err != nil {
					return nil, err
				}
				return []string{p}, nil
			}),
		},
	}
	client, err := dial(ctx, o.Host, o.Port, cfg)
	switch {
	case hostErr != nil:
		return nil, hostErr
	case err != nil && extra:
		return nil, ErrExtraAuth
	case err != nil && (sent || strings.Contains(err.Error(), "unable to authenticate")):
		return nil, ErrAuthFailed
	case err != nil:
		return nil, err
	}
	defer client.Close()
	stop := context.AfterFunc(ctx, func() { client.Close() })
	defer stop()
	sess, err := client.NewSession()
	if err != nil {
		return nil, err
	}
	defer sess.Close()
	var stderr bytes.Buffer
	sess.Stdin = strings.NewReader(script)
	sess.Stderr = &stderr
	if err := sess.Run("exec sh -s"); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 300 {
			msg = msg[len(msg)-300:]
		}
		if msg == "" {
			msg = err.Error()
		}
		return nil, &InstallError{Stderr: msg}
	}
	return hostKey, nil
}
