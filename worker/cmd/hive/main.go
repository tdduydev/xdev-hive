// Lệnh hive: chạy agent CLI (claude, codex, gemini) trong phiên do hive-worker giữ, qua socket nội bộ (specs/010).
// Worker giữ PTY nên phiên sống khi đóng terminal; hive chỉ là một client gắn vào phiên.
package main

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/localipc"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

// Mã thoát theo specs/010 plan.md "Lệnh hive".
const (
	exitOK     = 0
	exitFailed = 1 // lỗi của agent hay phiên
	exitUsage  = 2 // dùng sai, thiếu điều kiện (worker chưa chạy, chưa hỗ trợ)
	exitDenied = 3 // bị từ chối quyền
)

const msgNotRunning = "Chưa chạy hive-worker. Mở app xDev Hive hoặc chạy `hive-worker run`."

// app gom mọi thứ lệnh dùng từ môi trường để test thay được.
type app struct {
	stdin   io.Reader
	stdout  io.Writer
	stderr  io.Writer
	console console
	// signals trả kênh đổi cỡ terminal, kênh tín hiệu dừng (SIGTERM, SIGHUP) và hàm thôi nghe.
	signals func() (resize, quit <-chan os.Signal, stop func())
	getenv  func(string) string
	getwd   func() (string, error)
	socket  func() (string, error)
	// keyring, cliConfig, http, openURL dùng cho lệnh cần hub (login, --task, ls --all).
	keyring   secretStore
	cliConfig func() (string, error)
	http      *http.Client
	openURL   func(string) error
	loginWait time.Duration
}

func main() {
	a := &app{
		stdin:     os.Stdin,
		stdout:    os.Stdout,
		stderr:    os.Stderr,
		console:   stdConsole{},
		signals:   notifySignals,
		getenv:    os.Getenv,
		getwd:     os.Getwd,
		socket:    localipc.DefaultPath,
		keyring:   osKeyring{},
		cliConfig: defaultCLIConfigPath,
		openURL:   openBrowser,
	}
	os.Exit(a.run(os.Args[1:]))
}

const usageText = `Cách dùng: hive <lệnh> [cờ]

  login [--hub URL] [--with-token] [--no-browser]
                          đăng nhập hub (chỉ cần cho --task, --project, ls --all)
  logout                  xoá token trên máy
  whoami                  đang đăng nhập bằng ai, hub nào
  chat [--cli claude|codex|gemini] [--account ID] [--model M] [--task KEY | --project KEY] [--no-record] [--force]
       [-- đối số thêm cho CLI]
                          mở phiên agent tương tác trong thư mục hiện tại
  run "<lời nhắc>" [cờ như chat]
                          như chat, gửi lời nhắc làm câu đầu
  ls [--json] [--all]     liệt kê phiên trên máy (--all: phiên đang chạy trên mọi máy của bạn, cần đăng nhập)
  attach <id> [--view]    gắn lại vào phiên (--view: chỉ xem)
  kill <id>               ngắt phiên
  remote <lệnh>           điều khiển từ xa máy này: status, on, off, roots, devices, pair, set, watch
                          (hive remote help để xem đủ)
  version                 phiên bản hive và hive-worker

Trong phiên: Ctrl-] d để tách (phiên chạy tiếp), Ctrl-] t để giành quyền điều khiển, Ctrl-] Ctrl-] gửi Ctrl-].
`

func (a *app) usage() int {
	fmt.Fprint(a.stderr, usageText)
	return exitUsage
}

func (a *app) run(args []string) int {
	if len(args) == 0 {
		return a.usage()
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "chat":
		return a.chat(rest, false)
	case "run":
		return a.chat(rest, true)
	case "ls":
		return a.ls(rest)
	case "attach":
		return a.attachCmd(rest)
	case "kill":
		return a.kill(rest)
	case "version", "--version":
		return a.version(rest)
	case "help", "-h", "--help":
		fmt.Fprint(a.stdout, usageText)
		return exitOK
	case "login":
		return a.login(rest)
	case "logout":
		return a.logout(rest)
	case "whoami":
		return a.whoami(rest)
	case "remote":
		return a.remote(rest)
	case "__hook":
		// Cần hook của CLI (T072); chưa làm thì báo rõ thay vì im lặng.
		return a.errorf(exitUsage, "Lệnh hive %s chưa hỗ trợ trong bản này.", cmd)
	}
	fmt.Fprintf(a.stderr, "hive: không có lệnh %q.\n", cmd)
	return a.usage()
}

func (a *app) errorf(code int, format string, args ...any) int {
	fmt.Fprintf(a.stderr, "hive: "+format+"\n", args...)
	return code
}

// connect nối worker; lỗi đã được in, trả mã thoát.
func (a *app) connect() (*localipc.Conn, localipc.Hello, int) {
	path, err := a.socket()
	if err != nil {
		return nil, localipc.Hello{}, a.fail(err)
	}
	c, h, err := localipc.Dial(path, "hive/"+version.Version)
	if err != nil {
		return nil, h, a.fail(err)
	}
	return c, h, exitOK
}

// fail in lỗi và đổi ra mã thoát.
func (a *app) fail(err error) int {
	var ve *localipc.VersionError
	var re *localipc.RemoteError
	switch {
	case errors.Is(err, localipc.ErrNotRunning):
		return a.errorf(exitUsage, "%s", msgNotRunning)
	case errors.Is(err, localipc.ErrUnsupported):
		return a.errorf(exitUsage, "hive chưa hỗ trợ trên Windows: socket nội bộ tới hive-worker chưa làm.")
	case errors.Is(err, localipc.ErrDenied):
		return a.errorf(exitDenied, "hive-worker từ chối kết nối: chỉ người dùng đang chạy worker mới dùng được.")
	case errors.As(err, &ve):
		return a.errorf(exitUsage, "%s", ve.Error())
	case errors.As(err, &re):
		return a.errorf(remoteExit(re.Code), "%s", strings.TrimSpace(re.Message))
	}
	return a.errorf(exitFailed, "%v", err)
}

func remoteExit(code string) int {
	switch code {
	case localipc.CodeDenied:
		return exitDenied
	case localipc.CodeBadRequest, localipc.CodeUnsupported, localipc.CodeVersion:
		return exitUsage
	}
	return exitFailed
}

func (a *app) version(args []string) int {
	if len(args) > 0 {
		return a.usage()
	}
	fmt.Fprintf(a.stdout, "hive %s\n", version.Version)
	path, err := a.socket()
	if err != nil {
		return a.fail(err)
	}
	c, h, err := localipc.Dial(path, "hive/"+version.Version)
	var ve *localipc.VersionError
	if errors.As(err, &ve) && ve.Worker != "" {
		fmt.Fprintf(a.stdout, "hive-worker %s\n", ve.Worker)
	}
	if err != nil {
		return a.fail(err)
	}
	_ = c.Close()
	fmt.Fprintf(a.stdout, "hive-worker %s\n", h.Worker)
	return exitOK
}
