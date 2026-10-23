package secretstore

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"

	"github.com/zalando/go-keyring"
)

type darwinKeyring struct {
	once  sync.Once
	ready error
}

func init() {
	platformBackend = func() backend { return &darwinKeyring{} }
	classify = func(err error) *Error {
		var own *Error
		if errors.As(err, &own) {
			return &Error{Code: own.Code, Message: own.Message}
		}
		var exit *exec.ExitError
		if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &exit) && (exit.ExitCode() == 36 || exit.ExitCode() == 51 || exit.ExitCode() == 128)) {
			return locked()
		}
		return unavailable()
	}
}

func (k *darwinKeyring) checkSession() error {
	k.once.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
		defer cancel()
		// launchctl chỉ kiểm namespace GUI, không gọi API keychain khi worker không có phiên người dùng.
		if exec.CommandContext(ctx, "/bin/launchctl", "print", "gui/"+strconv.Itoa(os.Getuid())).Run() != nil {
			k.ready = locked()
		}
	})
	return k.ready
}

func (k *darwinKeyring) command(input string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), readTimeout)
	defer cancel()
	if err := k.checkSession(); err != nil {
		return "", err
	}
	if ctx.Err() != nil {
		return "", locked()
	}
	cmd := exec.CommandContext(ctx, "/usr/bin/security", args...)
	cmd.Stderr = io.Discard
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return "", locked()
	}
	if err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) && exit.ExitCode() == 44 {
			return "", keyring.ErrNotFound
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}

func (k *darwinKeyring) Get(s, u string) (string, error) {
	value, err := k.command("", "find-generic-password", "-s", s, "-wa", u)
	if err != nil {
		return "", err
	}
	// Giữ tương thích với mục đã ghi bằng go-keyring.
	if rest, ok := strings.CutPrefix(value, "go-keyring-base64:"); ok {
		b, err := base64.StdEncoding.DecodeString(rest)
		return string(b), err
	}
	if rest, ok := strings.CutPrefix(value, "go-keyring-encoded:"); ok {
		b, err := hex.DecodeString(rest)
		return string(b), err
	}
	return value, nil
}
func darwinQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }
func (k *darwinKeyring) Set(s, u, v string) error {
	encoded := "go-keyring-base64:" + base64.StdEncoding.EncodeToString([]byte(v))
	_, err := k.command("add-generic-password -U -s "+darwinQuote(s)+" -a "+darwinQuote(u)+" -w "+darwinQuote(encoded)+"\n", "-i")
	return err
}
func (k *darwinKeyring) Delete(s, u string) error {
	_, err := k.command("", "delete-generic-password", "-s", s, "-a", u)
	return err
}
