package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/sshkeys"
)

const sshUsage = `Cách dùng: hive-worker ssh [lệnh] [--json]
  list (mặc định)  khoá của máy và các khối Host trong ~/.ssh/config
  check            --alias TÊN: đăng nhập thử bằng khoá, không mật khẩu
  scan             --host MÁY [--port CỔNG]: đọc khoá máy chủ, không xác thực
  setup            --host MÁY --port CỔNG --user USER --alias TÊN --fingerprint SHA256:…
                   mật khẩu là dòng đầu của stdin; cài khoá công khai, ghi known_hosts và ~/.ssh/config rồi kiểm tra
  remove           --alias TÊN: gỡ khối do app tạo khỏi ~/.ssh/config (không gỡ khoá trên máy chủ)`

// sshListView là kết quả của `ssh list` và `ssh remove`.
type sshListView struct {
	// SSH: đường dẫn ssh của máy; rỗng là máy chưa có OpenSSH client.
	SSH        string          `json:"ssh"`
	ConfigPath string          `json:"configPath"`
	Key        sshkeys.KeyInfo `json:"key"`
	Hosts      []sshkeys.Host  `json:"hosts"`
}

type sshSetupView struct {
	Key           sshkeys.KeyInfo     `json:"key"`
	KeyCreated    bool                `json:"keyCreated"`
	ConfigWritten bool                `json:"configWritten"`
	Check         sshkeys.CheckResult `json:"check"`
}

// Test thay thư mục nhà, ssh của máy và đồng hồ.
var (
	sshHome    = os.UserHomeDir
	sshFindSSH = sshkeys.SSHPath
	sshNow     = time.Now
)

// setupTimeout ngắn hơn hạn 60 giây app đặt cho lệnh, để worker tự dừng và báo lỗi rõ.
const setupTimeout = 55 * time.Second

var fingerprintRe = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)

type sshPaths struct{ home, config, known, key string }

func sshPathsFor(home string) sshPaths {
	dir := filepath.Join(home, ".ssh")
	return sshPaths{home: home, config: filepath.Join(dir, "config"), known: filepath.Join(dir, "known_hosts"),
		key: sshkeys.DefaultKeyPath(home)}
}

func sshCommand(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	action := "list"
	if len(args) > 0 && args[0] != "" && args[0][0] != '-' {
		action, args = args[0], args[1:]
	}
	fs := flag.NewFlagSet("ssh "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Bool("json", true, "in dạng JSON (cho app desktop)")
	host := fs.String("host", "", "địa chỉ máy chủ")
	port := fs.Int("port", 22, "cổng SSH")
	login := fs.String("user", "", "tên đăng nhập trên máy chủ")
	alias := fs.String("alias", "", "tên gợi nhớ trong ~/.ssh/config")
	fingerprint := fs.String("fingerprint", "", "dấu vân tay khoá máy chủ người dùng đã xác nhận")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	usage := func() int {
		fmt.Fprintln(stderr, sshUsage)
		return 2
	}
	fail := func(err error) int {
		fmt.Fprintln(stderr, err)
		return 1
	}
	home, err := sshHome()
	if err != nil {
		return fail(err)
	}
	p := sshPathsFor(home)
	ctx := context.Background()
	var view any
	switch action {
	case "list":
		if view, err = sshList(ctx, p); err != nil {
			return fail(err)
		}
	case "check":
		if *alias == "" {
			return usage()
		}
		if !sshkeys.ValidAlias(*alias) {
			return fail(fmt.Errorf("tên gợi nhớ %q không hợp lệ", *alias))
		}
		key, err := sshkeys.InspectKey(p.key)
		if err != nil {
			return fail(err)
		}
		sshPath, _ := sshFindSSH()
		view = sshkeys.Check(ctx, sshPath, *alias, key)
	case "scan":
		if *host == "" {
			return usage()
		}
		if err := checkHostPort(*host, *port); err != nil {
			return fail(err)
		}
		if view, err = sshkeys.Scan(ctx, *host, *port, p.known); err != nil {
			return fail(err)
		}
	case "setup":
		if *host == "" || *login == "" || *alias == "" || *fingerprint == "" {
			return usage()
		}
		if view, err = sshSetup(ctx, p, stdin, sshkeys.Host{Alias: *alias, HostName: *host, User: *login, Port: *port},
			*fingerprint); err != nil {
			return fail(err)
		}
	case "remove":
		if *alias == "" {
			return usage()
		}
		data, err := os.ReadFile(p.config)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return fail(err)
		}
		out, err := sshkeys.RemoveBlock(data, *alias)
		if err != nil {
			return fail(err)
		}
		if err := sshkeys.WriteFileSafe(p.config, out, true, sshNow()); err != nil {
			return fail(err)
		}
		if view, err = sshList(ctx, p); err != nil {
			return fail(err)
		}
	default:
		return usage()
	}
	_ = json.NewEncoder(stdout).Encode(view)
	return 0
}

func checkHostPort(host string, port int) error {
	if !sshkeys.ValidHost(host) {
		return fmt.Errorf("địa chỉ máy chủ %q không hợp lệ", host)
	}
	if port < 1 || port > 65535 {
		return fmt.Errorf("cổng %d không hợp lệ", port)
	}
	return nil
}

func sshList(ctx context.Context, p sshPaths) (sshListView, error) {
	key, err := sshkeys.InspectKey(p.key)
	if err != nil {
		return sshListView{}, err
	}
	data, err := os.ReadFile(p.config)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return sshListView{}, err
	}
	view := sshListView{ConfigPath: p.config, Key: key, Hosts: sshkeys.ParseConfig(data)}
	view.SSH, _ = sshFindSSH()
	for i := range view.Hosts {
		h := &view.Hosts[i]
		if view.SSH == "" {
			// Không có ssh để hỏi: khối không ghi IdentityFile thì ssh dùng khoá mặc định.
			h.KeyUsable = h.Managed || h.IdentityFile == ""
			continue
		}
		r, err := sshkeys.Resolve(ctx, view.SSH, h.Alias)
		if err != nil {
			continue
		}
		// ssh -G cho giá trị thật, kể cả phần đến từ Include, Match hay Host *.
		h.HostName, h.User, h.Port = r.HostName, r.User, r.Port
		h.Proxy = h.Proxy || r.Proxy
		h.KeyUsable = r.Uses(p.key, p.home)
	}
	return view, nil
}

// readPassword đọc dòng đầu của stdin. App gửi đúng một dòng rồi xoá bản của nó.
func readPassword(stdin io.Reader) ([]byte, error) {
	line, err := bufio.NewReader(stdin).ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	pw := bytes.TrimRight(line, "\r\n")
	if len(pw) == 0 {
		clear(line)
		return nil, errors.New("Nhập mật khẩu của máy chủ.")
	}
	return pw, nil
}

func localNames() (string, string) {
	name := "user"
	if u, err := user.Current(); err == nil {
		// Windows trả "MÁY\tên": chỉ giữ tên.
		name = u.Username[strings.LastIndexAny(u.Username, `\/`)+1:]
	}
	machine, _ := os.Hostname()
	return name, machine
}

// sshSetup làm các bước của FR-005. Mọi kiểm tra không cần mạng chạy trước khi đọc mật khẩu, để lỗi cấu hình không
// tốn một lần gửi mật khẩu.
func sshSetup(ctx context.Context, p sshPaths, stdin io.Reader, want sshkeys.Host, fingerprint string) (sshSetupView, error) {
	var view sshSetupView
	if err := checkHostPort(want.HostName, want.Port); err != nil {
		return view, err
	}
	switch {
	case !sshkeys.ValidUser(want.User):
		return view, fmt.Errorf("tên đăng nhập %q không hợp lệ", want.User)
	case !sshkeys.ValidAlias(want.Alias):
		return view, fmt.Errorf("tên gợi nhớ %q không hợp lệ", want.Alias)
	case !fingerprintRe.MatchString(fingerprint):
		return view, errors.New("dấu vân tay khoá máy chủ không hợp lệ")
	}
	ctx, cancel := context.WithTimeout(ctx, setupTimeout)
	defer cancel()
	config, err := os.ReadFile(p.config)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return view, err
	}
	sshPath, _ := sshFindSSH()
	writeConfig := true
	for _, h := range sshkeys.ParseConfig(config) {
		if !strings.EqualFold(h.Alias, want.Alias) {
			continue
		}
		writeConfig = false
		got := h
		if !h.Managed {
			if sshPath == "" {
				return view, errors.New("cần OpenSSH client để đọc khối viết tay trong ~/.ssh/config")
			}
			r, err := sshkeys.Resolve(ctx, sshPath, h.Alias)
			if err != nil {
				return view, fmt.Errorf("không đọc được cấu hình của %s: %w", h.Alias, err)
			}
			if r.Proxy {
				return view, errors.New("máy chủ đi qua máy trung gian (ProxyJump, ProxyCommand): app chưa cài khoá được")
			}
			got = sshkeys.Host{HostName: r.HostName, User: r.User, Port: r.Port}
		}
		if !strings.EqualFold(got.HostName, want.HostName) || got.User != want.User || got.Port != want.Port {
			return view, fmt.Errorf("tên gợi nhớ %s đã dùng cho %s@%s:%d trong ~/.ssh/config", h.Alias, got.User,
				got.HostName, got.Port)
		}
	}
	key, err := sshkeys.InspectKey(p.key)
	if err != nil {
		return view, err
	}
	if !key.Exists {
		name, machine := localNames()
		if key, err = sshkeys.GenerateKey(p.key, sshkeys.KeyComment(name, machine, sshNow())); err != nil {
			return view, fmt.Errorf("không tạo được khoá: %w", err)
		}
		view.KeyCreated = true
	}
	view.Key = key
	line, err := sshkeys.AuthorizedLine(key)
	if err != nil {
		return view, err
	}
	password, err := readPassword(stdin)
	if err != nil {
		return view, err
	}
	hostKey, err := sshkeys.Install(ctx, sshkeys.InstallOptions{
		Host: want.HostName, Port: want.Port, User: want.User, Fingerprint: fingerprint,
		Password: password, KnownHosts: p.known,
	}, line)
	clear(password)
	if err != nil {
		return view, err
	}
	if err := sshkeys.AppendKnownHost(p.known, want.HostName, want.Port, hostKey); err != nil {
		return view, fmt.Errorf("đã cài khoá nhưng không ghi được known_hosts: %w", err)
	}
	if writeConfig {
		out, err := sshkeys.AddBlock(config, want, "~/.ssh/id_ed25519")
		if err != nil {
			return view, err
		}
		if err := sshkeys.WriteFileSafe(p.config, out, true, sshNow()); err != nil {
			return view, fmt.Errorf("đã cài khoá nhưng không ghi được ~/.ssh/config: %w", err)
		}
		view.ConfigWritten = true
	}
	view.Check = sshkeys.Check(ctx, sshPath, want.Alias, key)
	return view, nil
}
