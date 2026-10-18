package sshkeys

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

// ScanResult là khoá máy chủ đọc được lúc bắt tay, chưa xác thực gì.
type ScanResult struct {
	Algorithm   string `json:"algorithm"`
	Fingerprint string `json:"fingerprint"`
	// Known: "known", "unknown" hoặc "changed" so với known_hosts.
	Known string `json:"known"`
	// AdminCommand: lệnh người quản trị chạy trên máy chủ để đọc dấu vân tay thật, đúng loại khoá nhận được.
	AdminCommand string `json:"adminCommand"`
}

const dialTimeout = 15 * time.Second

var errScanDone = errors.New("đã đọc khoá máy chủ")

// dial mở TCP theo ctx và bắt tay SSH; ctx huỷ thì đóng kết nối để bắt tay không treo.
func dial(ctx context.Context, host string, port int, cfg *ssh.ClientConfig) (*ssh.Client, error) {
	ctx, cancel := context.WithTimeout(ctx, dialTimeout)
	defer cancel()
	addr := hostPort(host, port)
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("không nối được %s: %w", addr, err)
	}
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	c, chans, reqs, err := ssh.NewClientConn(conn, addr, cfg)
	if err != nil {
		conn.Close()
		return nil, err
	}
	return ssh.NewClient(c, chans, reqs), nil
}

// Scan đọc khoá máy chủ rồi dừng ngay trong callback, trước bước xác thực, nên máy chủ không nhận tên hay mật khẩu nào.
func Scan(ctx context.Context, host string, port int, knownHosts string) (ScanResult, error) {
	var got ssh.PublicKey
	cfg := &ssh.ClientConfig{
		User:              "xdev-hive",
		HostKeyAlgorithms: hostKeyAlgorithms(KnownKeyTypes(knownHosts, host, port)),
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			got = key
			return errScanDone
		},
	}
	client, err := dial(ctx, host, port, cfg)
	if client != nil {
		client.Close()
	}
	if got == nil {
		if err == nil {
			err = errors.New("máy chủ không gửi khoá")
		}
		return ScanResult{}, fmt.Errorf("không đọc được khoá máy chủ: %w", err)
	}
	known, err := HostKeyStatus(knownHosts, host, port, got)
	if err != nil {
		return ScanResult{}, err
	}
	return ScanResult{
		Algorithm:    got.Type(),
		Fingerprint:  ssh.FingerprintSHA256(got),
		Known:        known,
		AdminCommand: adminCommand(got.Type()),
	}, nil
}

func adminCommand(keyType string) string {
	name := "*"
	switch {
	case keyType == ssh.KeyAlgoED25519:
		name = "ed25519"
	case strings.HasPrefix(keyType, "ecdsa-"):
		name = "ecdsa"
	case keyType == ssh.KeyAlgoRSA:
		name = "rsa"
	}
	if name == "*" {
		return `for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf "$f"; done`
	}
	return "ssh-keygen -lf /etc/ssh/ssh_host_" + name + "_key.pub"
}
