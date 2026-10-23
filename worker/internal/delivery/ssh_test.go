package delivery

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/pem"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type fakeSSH struct {
	addr     string
	hostKey  ssh.PublicKey
	userKey  []byte // PEM của khoá riêng client
	mu       sync.Mutex
	received []string
}

func newSigner(t *testing.T) (ssh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	blk, err := ssh.MarshalPrivateKey(priv, "")
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s, pem.EncodeToMemory(blk)
}

// startFakeSSH dựng máy chủ SSH trong tiến trình: nhận exec, đọc stdin tới hết, trả lại nội dung và thoát 3 nếu có "fail".
func startFakeSSH(t *testing.T) *fakeSSH {
	t.Helper()
	hostSigner, _ := newSigner(t)
	userSigner, userPEM := newSigner(t)
	f := &fakeSSH{hostKey: hostSigner.PublicKey(), userKey: userPEM}
	cfg := &ssh.ServerConfig{PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
		if bytes.Equal(k.Marshal(), userSigner.PublicKey().Marshal()) {
			return nil, nil
		}
		return nil, io.ErrUnexpectedEOF
	}}
	cfg.AddHostKey(hostSigner)
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	f.addr = ln.Addr().String()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go f.serve(c, cfg)
		}
	}()
	return f
}

func (f *fakeSSH) serve(c net.Conn, cfg *ssh.ServerConfig) {
	sc, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	defer sc.Close()
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		ch, creqs, err := nc.Accept()
		if err != nil {
			return
		}
		go func() {
			for r := range creqs {
				if r.Type != "exec" {
					_ = r.Reply(false, nil)
					continue
				}
				_ = r.Reply(true, nil)
				body, _ := io.ReadAll(ch)
				f.mu.Lock()
				f.received = append(f.received, string(body))
				f.mu.Unlock()
				_, _ = ch.Write([]byte("out:" + string(body)))
				code := uint32(0)
				if strings.Contains(string(body), "fail") {
					code = 3
				}
				st := make([]byte, 4)
				binary.BigEndian.PutUint32(st, code)
				_, _ = ch.SendRequest("exit-status", false, st)
				_ = ch.Close()
				return
			}
		}()
	}
}

func (f *fakeSSH) target(t *testing.T) SSHTarget {
	t.Helper()
	host, port, _ := net.SplitHostPort(f.addr)
	p := 0
	for _, c := range port {
		p = p*10 + int(c-'0')
	}
	return SSHTarget{Host: host, Port: p, User: "deploy", HostKeys: []SSHHostKey{{Algorithm: f.hostKey.Type(), Fingerprint: ssh.FingerprintSHA256(f.hostKey)}}}
}

func TestSSHRunsStepsThroughStdinAndStopsOnFailure(t *testing.T) {
	f := startFakeSSH(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := DialSSH(ctx, f.target(t), f.userKey, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	var out bytes.Buffer
	var states []string
	steps := []SSHStep{{Name: "build", Script: "echo one"}, {Name: "bad", Script: "echo fail"}, {Name: "never", Script: "echo three"}}
	res, err := RunSSHSteps(ctx, c, steps, map[string]string{"VERSION": "1.0'x"}, &out, func(n, s string, _ int) { states = append(states, n+":"+s) })
	if CodeOf(err) != CodeUnavailable || len(res) != 2 || res[1].ExitCode != 3 {
		t.Fatalf("res=%v err=%v", res, err)
	}
	if got := strings.Join(states, ","); got != "build:running,build:succeeded,bad:running,bad:failed" {
		t.Fatalf("states = %s", got)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.received) != 2 || !strings.Contains(f.received[0], `export VERSION='1.0'\''x'`) {
		t.Fatalf("received = %q", f.received)
	}
}

func TestSSHRejectsUnpinnedAndChangedHostKey(t *testing.T) {
	f := startFakeSSH(t)
	ctx := context.Background()
	none := f.target(t)
	none.HostKeys = nil
	if _, err := DialSSH(ctx, none, f.userKey, 0); CodeOf(err) != CodeHostKeyChanged {
		t.Fatalf("chưa ghim phải bị từ chối, got %v", err)
	}
	other, _ := newSigner(t)
	changed := f.target(t)
	changed.HostKeys = []SSHHostKey{{Algorithm: other.PublicKey().Type(), Fingerprint: ssh.FingerprintSHA256(other.PublicKey())}}
	if _, err := DialSSH(ctx, changed, f.userKey, 0); CodeOf(err) != CodeHostKeyChanged {
		t.Fatalf("host key đổi phải dừng, got %v", err)
	}
}

func TestSSHAuthFailureAndBadKey(t *testing.T) {
	f := startFakeSSH(t)
	_, wrong := newSigner(t)
	if _, err := DialSSH(context.Background(), f.target(t), wrong, 0); CodeOf(err) != CodeAuthFailed {
		t.Fatalf("got %v", err)
	}
	if _, err := DialSSH(context.Background(), f.target(t), []byte("not a key"), 0); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
}

func TestSSHEnvRejectsBadName(t *testing.T) {
	if _, err := envPrefix(map[string]string{"A B": "x"}); CodeOf(err) != CodeBadRequest {
		t.Fatalf("got %v", err)
	}
}
