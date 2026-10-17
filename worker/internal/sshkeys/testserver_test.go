package sshkeys

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"net"
	"os"
	"os/exec"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"

	"golang.org/x/crypto/ssh"
)

// testServer là máy chủ SSH trong tiến trình cho test. Lệnh exec chạy bằng `sh -c` của máy chạy test với HOME tạm,
// như shell đăng nhập của user trên máy chủ thật.
type testServer struct {
	host string
	port int
	// keys: khoá máy chủ theo loại ("ssh-ed25519", "ecdsa-sha2-nistp256").
	keys     map[string]ssh.Signer
	password string
	home     string
	// passwords: số lần máy chủ nhận được một mật khẩu (qua password hay keyboard-interactive).
	passwords atomic.Int32
	// auths: số lần client thử xác thực, kể cả "none".
	auths atomic.Int32

	mu       sync.Mutex
	commands []string
}

type serverOpts struct {
	password string
	// kbdOnly: chỉ cho keyboard-interactive, như máy chủ dùng PAM.
	kbdOnly bool
	// otp: sau mật khẩu hỏi thêm mã xác minh.
	otp bool
	// algos: loại khoá máy chủ có; mặc định ed25519 và ECDSA.
	algos []string
}

func newTestServer(t *testing.T, o serverOpts) *testServer {
	t.Helper()
	if len(o.algos) == 0 {
		o.algos = []string{ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256}
	}
	s := &testServer{keys: map[string]ssh.Signer{}, password: o.password, home: t.TempDir()}
	cfg := &ssh.ServerConfig{
		AuthLogCallback: func(ssh.ConnMetadata, string, error) { s.auths.Add(1) },
		KeyboardInteractiveCallback: func(_ ssh.ConnMetadata, client ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
			answers, err := client("", "", []string{"Password: "}, []bool{false})
			if err != nil || len(answers) != 1 {
				return nil, errors.New("không trả lời")
			}
			s.passwords.Add(1)
			if answers[0] != s.password {
				return nil, errors.New("sai mật khẩu")
			}
			if o.otp {
				if _, err := client("", "", []string{"Verification code: "}, []bool{false}); err != nil {
					return nil, err
				}
				return nil, errors.New("sai mã")
			}
			return nil, nil
		},
	}
	if !o.kbdOnly {
		cfg.PasswordCallback = func(_ ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			s.passwords.Add(1)
			if string(pw) != s.password {
				return nil, errors.New("sai mật khẩu")
			}
			return nil, nil
		}
	}
	for _, algo := range o.algos {
		var signer ssh.Signer
		var err error
		switch algo {
		case ssh.KeyAlgoED25519:
			_, priv, _ := ed25519.GenerateKey(rand.Reader)
			signer, err = ssh.NewSignerFromKey(priv)
		case ssh.KeyAlgoECDSA256:
			priv, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			signer, err = ssh.NewSignerFromKey(priv)
		}
		if err != nil {
			t.Fatal(err)
		}
		s.keys[algo] = signer
		cfg.AddHostKey(signer)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	addr := ln.Addr().(*net.TCPAddr)
	s.host, s.port = "127.0.0.1", addr.Port
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go s.serve(conn, cfg)
		}
	}()
	return s
}

func (s *testServer) addr() string { return net.JoinHostPort(s.host, strconv.Itoa(s.port)) }

func (s *testServer) execs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.commands...)
}

func (s *testServer) serve(conn net.Conn, cfg *ssh.ServerConfig) {
	defer conn.Close()
	_, chans, reqs, err := ssh.NewServerConn(conn, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		if nc.ChannelType() != "session" {
			_ = nc.Reject(ssh.UnknownChannelType, "")
			continue
		}
		ch, chReqs, err := nc.Accept()
		if err != nil {
			continue
		}
		go s.session(ch, chReqs)
	}
}

func (s *testServer) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	for req := range reqs {
		if req.Type != "exec" || len(req.Payload) < 4 {
			_ = req.Reply(false, nil)
			continue
		}
		n := binary.BigEndian.Uint32(req.Payload)
		command := string(req.Payload[4 : 4+n])
		s.mu.Lock()
		s.commands = append(s.commands, command)
		s.mu.Unlock()
		_ = req.Reply(true, nil)
		cmd := exec.Command("sh", "-c", command) // procattr:allow — máy chủ giả của test
		cmd.Env = append(os.Environ(), "HOME="+s.home)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = ch, ch, ch.Stderr()
		code := 0
		if err := cmd.Run(); err != nil {
			code = 1
			var exit *exec.ExitError
			if errors.As(err, &exit) {
				code = exit.ExitCode()
			}
		}
		status := make([]byte, 4)
		binary.BigEndian.PutUint32(status, uint32(code))
		_, _ = ch.SendRequest("exit-status", false, status)
		return
	}
}
