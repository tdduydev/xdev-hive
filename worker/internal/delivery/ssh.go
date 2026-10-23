package delivery

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)

// SSHHostKey là host key đã ghim ở hub (thuật toán và dấu vân tay SHA256 đúng dạng `ssh-keygen -lf`).
type SSHHostKey struct {
	Algorithm   string
	Fingerprint string
}

// SSHTarget là máy chủ đích. Khoá riêng đến từ kho bí mật và chỉ ở trong bộ nhớ.
type SSHTarget struct {
	Host     string
	Port     int
	User     string
	HostKeys []SSHHostKey
}

// SSHStep là một bước script. Script đi qua stdin của `sh -s`, không nằm trên dòng lệnh nên không lộ trong `ps`.
type SSHStep struct {
	Name   string
	Script string
}

// SSHStepResult là kết quả một bước.
type SSHStepResult struct {
	Name     string
	ExitCode int
}

// hostKeyAlgorithms ép thương lượng đúng loại khoá đã ghim, để máy chủ đưa khoá loại khác bị coi là đổi.
func hostKeyAlgorithms(keys []SSHHostKey) []string {
	set := map[string]bool{}
	for _, k := range keys {
		switch k.Algorithm {
		case ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521:
			set[k.Algorithm] = true
		case ssh.KeyAlgoRSA:
			set[ssh.KeyAlgoRSASHA512], set[ssh.KeyAlgoRSASHA256], set[ssh.KeyAlgoRSA] = true, true, true
		}
	}
	out := make([]string, 0, len(set))
	for a := range set {
		out = append(out, a)
	}
	sort.Strings(out)
	return out
}

// DialSSH kết nối với host key ghim. Không có host key nào được ghim thì từ chối ngay, trước khi xác thực: không bao
// giờ "tin lần đầu" ở worker, vì việc xác nhận là của admin trên hub.
func DialSSH(ctx context.Context, t SSHTarget, privateKey []byte, timeout time.Duration) (*ssh.Client, error) {
	if len(t.HostKeys) == 0 {
		return nil, newError(CodeHostKeyChanged, 0, "Hub chưa xác nhận host key của máy chủ này.")
	}
	if t.Host == "" || t.User == "" {
		return nil, newError(CodeBadRequest, 0, "Thiếu địa chỉ hoặc tài khoản SSH.")
	}
	port := t.Port
	if port == 0 {
		port = 22
	}
	signer, err := ssh.ParsePrivateKey(privateKey)
	if err != nil {
		return nil, newError(CodeBadRequest, 0, "Khoá SSH trong kho bí mật không đọc được.")
	}
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	var denied bool
	cfg := &ssh.ClientConfig{
		User:              t.User,
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyAlgorithms: hostKeyAlgorithms(t.HostKeys),
		Timeout:           timeout,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			fp := ssh.FingerprintSHA256(key)
			for _, k := range t.HostKeys {
				if k.Fingerprint == fp {
					return nil
				}
			}
			denied = true
			return errors.New("host key mismatch")
		},
	}
	addr := net.JoinHostPort(t.Host, strconv.Itoa(port))
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctxErr(ctx)
		}
		return nil, newError(CodeUnavailable, 0, "Không kết nối được máy chủ SSH từ máy này.")
	}
	// Hết hạn handshake cũng theo ctx.
	stop := context.AfterFunc(ctx, func() { _ = conn.Close() })
	defer stop()
	sc, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		_ = conn.Close()
		switch {
		case denied:
			return nil, newError(CodeHostKeyChanged, 0, "Host key của máy chủ đã đổi. Máy này dừng, không chạy lệnh nào.")
		case ctx.Err() != nil:
			return nil, ctxErr(ctx)
		case strings.Contains(err.Error(), "unable to authenticate"):
			return nil, newError(CodeAuthFailed, 0, "Máy chủ không nhận khoá SSH của máy này.")
		default:
			return nil, newError(CodeUnavailable, 0, "Không bắt tay SSH được với máy chủ.")
		}
	}
	return ssh.NewClient(sc, chans, reqs), nil
}

// RunSSHSteps chạy lần lượt các bước, mỗi bước một phiên `sh -s`, ghi stdout và stderr vào out (JobLog đã che bí mật).
// Dừng ở bước đầu tiên thoát khác 0. Huỷ ctx thì gửi TERM rồi đóng phiên. env chỉ chứa biến không bí mật.
func RunSSHSteps(ctx context.Context, c *ssh.Client, steps []SSHStep, env map[string]string, out io.Writer, onStep func(name, state string, exit int)) ([]SSHStepResult, error) {
	var results []SSHStepResult
	prefix, err := envPrefix(env)
	if err != nil {
		return nil, err
	}
	for _, s := range steps {
		if s.Name == "" {
			return results, newError(CodeBadRequest, 0, "Bước không có tên.")
		}
		onStep(s.Name, "running", 0)
		code, err := runSSHStep(ctx, c, prefix+s.Script, out)
		if err != nil {
			onStep(s.Name, "failed", code)
			return results, err
		}
		results = append(results, SSHStepResult{Name: s.Name, ExitCode: code})
		if code != 0 {
			onStep(s.Name, "failed", code)
			return results, newError(CodeUnavailable, 0, "Bước %q thoát với mã %d.", s.Name, code)
		}
		onStep(s.Name, "succeeded", 0)
	}
	return results, nil
}

func envPrefix(env map[string]string) (string, error) {
	keys := make([]string, 0, len(env))
	for k := range env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b bytes.Buffer
	for _, k := range keys {
		if !envName.MatchString(k) {
			return "", newError(CodeBadRequest, 0, "Tên biến %q không hợp lệ.", k)
		}
		b.WriteString("export " + k + "=" + shellQuote(env[k]) + "\n")
	}
	return b.String(), nil
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

func runSSHStep(ctx context.Context, c *ssh.Client, script string, out io.Writer) (int, error) {
	sess, err := c.NewSession()
	if err != nil {
		return 0, newError(CodeUnavailable, 0, "Không mở được phiên SSH.")
	}
	defer sess.Close()
	sess.Stdin = strings.NewReader(script)
	sess.Stdout, sess.Stderr = out, out
	if err := sess.Start("sh -s"); err != nil {
		return 0, newError(CodeUnavailable, 0, "Không chạy được bước trên máy chủ.")
	}
	done := make(chan error, 1)
	go func() { done <- sess.Wait() }()
	select {
	case err := <-done:
		return exitCode(err)
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGTERM)
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
		return 0, ctxErr(ctx)
	}
}

func exitCode(err error) (int, error) {
	if err == nil {
		return 0, nil
	}
	var ee *ssh.ExitError
	if errors.As(err, &ee) {
		return ee.ExitStatus(), nil
	}
	var em *ssh.ExitMissingError
	if errors.As(err, &em) {
		return 0, newError(CodeUnavailable, 0, "Phiên SSH đóng mà không báo mã thoát.")
	}
	return 0, newError(CodeUnavailable, 0, "Đứt kết nối khi chạy bước.")
}
