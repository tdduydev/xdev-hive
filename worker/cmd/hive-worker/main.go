// hive-worker chạy trên máy dev (và ở chế độ host trên runner server), gọi ra hub để nhận run.
// Lệnh: version, check, register (đổi mã đăng ký lấy machine token), run (nối WSS tới hub), config (xem cấu hình).
// Cờ --json/--status-json cho app desktop đọc kết quả và trạng thái thay vì đọc chữ cho người.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"os/user"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/service"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println(version.Version)
	case "check":
		os.Exit(check(os.Args[2:]))
	case "register":
		os.Exit(register(os.Args[2:], os.Stdout, os.Stderr))
	case "run":
		os.Exit(run(os.Args[2:]))
	case "host":
		os.Exit(host(os.Args[2:]))
	case "sandbox-init":
		os.Exit(sandboxInit(os.Args[2:]))
	case "config":
		os.Exit(showConfig(os.Args[2:], os.Stdout, os.Stderr))
	case "service":
		os.Exit(serviceCommand(os.Args[2:], os.Stdout, os.Stderr))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Cách dùng: hive-worker <version | check --hub URL | register --hub URL --token MÃ [--machine TÊN] [--json] | run [--status-json] [--stdin-control] | host [--allow-runc] [--image IMAGE] | config [--json] | service install|uninstall|status>")
}

func serviceCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Cách dùng: hive-worker service install|uninstall|status")
		return 2
	}
	action := args[0]
	fs := flag.NewFlagSet("service "+action, flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	dryRun := fs.Bool("dry-run", false, "chỉ in nội dung và lệnh dự kiến")
	if err := fs.Parse(args[1:]); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if action == "install" {
		cfg, err := config.Load(path)
		if err != nil || cfg.MachineToken == "" {
			fmt.Fprintf(stderr, "Máy chưa đăng ký; chạy `hive-worker register --hub URL --token MÃ --config %s` trước.\n", path)
			return 1
		}
		if *capacity < 1 {
			fmt.Fprintln(stderr, "capacity phải lớn hơn 0")
			return 2
		}
	}
	exe, err := os.Executable()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	user, _ := user.Current()
	username := ""
	if user != nil {
		username = user.Username
	}
	plan, err := service.Build(runtime.GOOS, exe, home, os.Getenv("PATH"), func() string {
		if *configPath != "" {
			return path
		}
		return ""
	}(), *capacity)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	manager := service.Manager{}
	switch action {
	case "install":
		if err := manager.Install(plan, *dryRun, stdout); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if *dryRun {
			return 0
		}
		fmt.Fprintf(stdout, "Đã cài dịch vụ tại %s. Log: %s\n", plan.File, plan.Log)
		if runtime.GOOS == "linux" {
			fmt.Fprintf(stdout, "Để chạy khi chưa đăng nhập: loginctl enable-linger %s\n", username)
		}
	case "uninstall":
		if err := manager.Uninstall(plan); err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		fmt.Fprintln(stdout, "Đã gỡ dịch vụ worker.")
	case "status":
		if !manager.Status(plan, stdout) {
			return 1
		}
	default:
		fmt.Fprintln(stderr, "Cách dùng: hive-worker service install|uninstall|status")
		return 2
	}
	return 0
}

// knownCLIs là các agent CLI hub biết giao việc (khớp enum cli trong packages/contracts).
var knownCLIs = []string{"claude", "codex", "gemini"}

func detectCLIs() []string {
	// CLI ghi đè qua HIVE_WORKER_CLI_OVERRIDES (CLI giả của scripts/e2e-smoke.ts) tính là có khi lệnh của nó chạy được,
	// để hub giao việc cho máy dù máy không cài CLI thật.
	overrides, err := runner.CommandsFromEnv()
	if err != nil {
		slog.Warn("Bỏ qua CLI ghi đè", "error", err)
	}
	found := []string{}
	for _, name := range knownCLIs {
		path := name
		if c, ok := overrides[name]; ok {
			path = c.Path
		}
		if _, err := exec.LookPath(path); err == nil {
			found = append(found, name)
		}
	}
	return found
}

var invalidMachineChars = regexp.MustCompile(`[^a-z0-9-]+`)

// defaultMachineID dựng tên máy từ hostname theo dạng hub nhận (chữ thường, số, gạch ngang, tối đa 63 ký tự).
func defaultMachineID(hostname string) string {
	name := strings.ToLower(strings.TrimSuffix(hostname, ".local"))
	name = strings.Trim(invalidMachineChars.ReplaceAllString(name, "-"), "-")
	if len(name) > 63 {
		name = strings.TrimRight(name[:63], "-")
	}
	if name == "" {
		return "worker"
	}
	return name
}

func register(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	fs.SetOutput(stderr)
	hub := fs.String("hub", envOr("HIVE_HUB_URL", ""), "địa chỉ hub")
	// HIVE_REGISTRATION_TOKEN cho app desktop: tham số dòng lệnh hiện trong danh sách tiến trình, biến môi trường thì không.
	token := fs.String("token", envOr("HIVE_REGISTRATION_TOKEN", ""), "mã đăng ký admin đội tạo trên web (dùng một lần, hết hạn sau 1 giờ)")
	hostname, _ := os.Hostname()
	machine := fs.String("machine", defaultMachineID(hostname), "tên máy trên hub")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	configPath := fs.String("config", "", "file cấu hình (mặc định theo hệ điều hành)")
	asJSON := fs.Bool("json", false, "in kết quả dạng JSON (cho app desktop)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *hub == "" || *token == "" {
		fmt.Fprintln(stderr, "Cần --hub và --token")
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	reg, err := hubclient.New(*hub).Register(ctx, hubclient.RegisterRequest{
		RegistrationToken: *token,
		MachineID:         *machine,
		OS:                runtime.GOOS,
		Version:           version.Version,
		CLIs:              detectCLIs(),
		Capacity:          *capacity,
	})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if err := config.Save(path, config.Config{HubURL: *hub, MachineID: reg.MachineID, MachineToken: reg.MachineToken, TeamID: reg.TeamID}); err != nil {
		// Hub chỉ trả token một lần; không lưu được thì người dùng phải xin mã mới, nên báo rõ.
		fmt.Fprintf(stderr, "Đã đăng ký nhưng không lưu được token: %v\nXin admin đội tạo mã mới rồi chạy lại.\n", err)
		return 1
	}
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(configView{Registered: true, HubURL: *hub, MachineID: reg.MachineID, TeamID: reg.TeamID, ConfigPath: path})
		return 0
	}
	fmt.Fprintf(stdout, "Đã đăng ký máy %s. Cấu hình lưu ở %s.\nChạy `hive-worker run` để nhận việc.\n", reg.MachineID, path)
	return 0
}

// configView là cấu hình in ra cho người hay app đọc. Không bao giờ có machine token.
type configView struct {
	Registered bool   `json:"registered"`
	HubURL     string `json:"hubUrl,omitempty"`
	MachineID  string `json:"machineId,omitempty"`
	TeamID     string `json:"teamId,omitempty"`
	ConfigPath string `json:"configPath"`
}

func showConfig(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("config", flag.ContinueOnError)
	fs.SetOutput(stderr)
	configPath := fs.String("config", "", "file cấu hình (mặc định theo hệ điều hành)")
	asJSON := fs.Bool("json", false, "in dạng JSON (cho app desktop)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	view := configView{ConfigPath: path}
	cfg, err := config.Load(path)
	switch {
	case errors.Is(err, config.ErrNotRegistered):
	case err != nil:
		fmt.Fprintln(stderr, err)
		return 1
	default:
		view = configView{Registered: true, HubURL: cfg.HubURL, MachineID: cfg.MachineID, TeamID: cfg.TeamID, ConfigPath: path}
	}
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(view)
		return 0
	}
	if !view.Registered {
		fmt.Fprintf(stdout, "Máy chưa đăng ký (cấu hình sẽ lưu ở %s).\n", path)
		return 0
	}
	fmt.Fprintf(stdout, "Máy %s, hub %s. Cấu hình ở %s.\n", view.MachineID, view.HubURL, path)
	return 0
}

func pathOr(p string) (string, error) {
	if p != "" {
		return p, nil
	}
	return config.DefaultPath()
}

func run(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := fs.String("config", "", "file cấu hình (mặc định theo hệ điều hành)")
	hub := fs.String("hub", envOr("HIVE_HUB_URL", ""), "địa chỉ hub (mặc định lấy từ file cấu hình)")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	statusJSON := fs.Bool("status-json", false, "in trạng thái kết nối ra stdout, mỗi dòng một JSON (cho app desktop); log vẫn ra stderr")
	stdinControl := fs.Bool("stdin-control", false, `dừng khi đọc dòng "stop" hoặc hết stdin (app desktop chạy worker làm sidecar)`)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if *hub != "" {
		cfg.HubURL = *hub
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if *stdinControl {
		// App desktop giữ stdin của sidecar: dòng "stop" là lệnh dừng êm (Windows không có SIGTERM), EOF nghĩa là app đã
		// thoát hoặc chết, nên worker cũng dừng thay vì chạy mồ côi.
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
				if strings.TrimSpace(scanner.Text()) == "stop" {
					break
				}
			}
			cancel()
		}()
	}
	dataDir, err := os.UserCacheDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return startWorker(ctx, cfg, *capacity, dataDir, "", nil, *statusJSON, cfg.HubURL)
}

func host(args []string) int {
	fs := flag.NewFlagSet("host", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	configPath := fs.String("config", "", "file cấu hình")
	hub := fs.String("hub", envOr("HIVE_HUB_URL", ""), "địa chỉ hub")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	image := fs.String("image", envOr("HIVE_HOST_IMAGE", "xdev-hive-runner:latest"), "image môi trường mặc định")
	cpus := fs.String("cpus", envOr("HIVE_HOST_CPUS", "2"), "giới hạn CPU mỗi run")
	memory := fs.String("memory", envOr("HIVE_HOST_MEMORY", "4g"), "giới hạn RAM mỗi run")
	pids := fs.Int("pids-limit", 256, "giới hạn PID mỗi run")
	allowRunc := fs.Bool("allow-runc", false, "cho phép Docker runtime runc khi runsc chưa cài (chỉ phát triển)")
	egressSocket := fs.String("egress-socket", os.Getenv("HIVE_EGRESS_SOCKET"), "Unix socket của egress proxy")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if runtime.GOOS != "linux" {
		fmt.Fprintln(os.Stderr, "Chế độ host chỉ hỗ trợ Linux")
		return 1
	}
	if *capacity < 1 || *pids < 1 || *image == "" {
		fmt.Fprintln(os.Stderr, "capacity, pids-limit và image phải hợp lệ")
		return 2
	}
	if err := checkHostRuntime(*allowRunc); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	cfg, err := config.Load(path)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if *hub != "" {
		cfg.HubURL = *hub
	}
	dataDir, err := os.UserCacheDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if *egressSocket != "" {
		info, err := os.Stat(*egressSocket)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			fmt.Fprintln(os.Stderr, "egress-socket phải là Unix socket đang tồn tại")
			return 1
		}
	}
	sandbox := &runner.SandboxConfig{Image: *image, HostID: cfg.MachineID, AllowRunc: *allowRunc, CPUs: *cpus, Memory: *memory, PIDs: *pids, EgressSocket: *egressSocket, WorkerBinary: executable}
	return startWorker(ctx, cfg, *capacity, dataDir, "host", sandbox, false, cfg.HubURL)
}

func sandboxInit(args []string) int {
	fs := flag.NewFlagSet("sandbox-init", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	socket := fs.String("socket", "/run/hive/egress.sock", "Unix socket egress proxy")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	command := fs.Args()
	if len(command) == 0 {
		fmt.Fprintln(os.Stderr, "Thiếu lệnh CLI")
		return 2
	}
	listener, err := net.Listen("tcp", "127.0.0.1:3128")
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	go func() {
		<-ctx.Done()
		_ = listener.Close()
	}()
	go func() {
		for {
			client, err := listener.Accept()
			if err != nil {
				return
			}
			go proxyUnix(client, *socket)
		}
	}()
	cmd := exec.CommandContext(ctx, command[0], command[1:]...)
	cmd.Stdout, cmd.Stderr, cmd.Stdin = os.Stdout, os.Stderr, os.Stdin
	if err := cmd.Run(); err != nil {
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func proxyUnix(client net.Conn, socket string) {
	defer client.Close()
	upstream, err := net.Dial("unix", socket)
	if err != nil {
		return
	}
	defer upstream.Close()
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, client); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

func checkHostRuntime(allowRunc bool) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return fmt.Errorf("không tìm thấy Docker: %w", err)
	}
	cmd := exec.Command("docker", "info", "--format", "{{json .Runtimes}}")
	output, err := cmd.Output()
	if err != nil {
		return fmt.Errorf("Docker không sẵn sàng: %w", err)
	}
	var runtimes map[string]json.RawMessage
	if err := json.Unmarshal(output, &runtimes); err != nil {
		return fmt.Errorf("không đọc được runtime Docker: %w", err)
	}
	_, dockerRunsc := runtimes["runsc"]
	_, runscBinary := exec.LookPath("runsc")
	if dockerRunsc && runscBinary == nil {
		return nil
	}
	if allowRunc {
		return nil
	}
	return errors.New("không tìm thấy runtime gVisor runsc trong Docker và PATH; cài runsc hoặc dùng --allow-runc chỉ cho phát triển")
}

func startWorker(ctx context.Context, cfg config.Config, capacity int, dataDir, mode string, sandbox *runner.SandboxConfig, statusJSON bool, hubURL string) int {
	clis := detectCLIs()
	if mode == "host" {
		clis = knownCLIs
	}
	cc := channel.Config{HubURL: hubURL, Machine: cfg.MachineID, Token: cfg.MachineToken, Version: version.Version, CLIs: clis, Capacity: capacity, RunnerMode: mode, Sandbox: sandbox, DataDir: filepath.Join(dataDir, "xdev-hive", "worker"), Logger: slog.Default()}
	if statusJSON {
		cc.OnStatus = statusPrinter(os.Stdout)
	}
	err := cc.Run(ctx)
	// Mã thoát riêng khi hub từ chối máy, để trình quản lý dịch vụ không khởi động lại liên tục với token đã hỏng.
	var rejected *channel.RejectedError
	if errors.As(err, &rejected) {
		fmt.Fprintln(os.Stderr, err)
		// launchd KeepAlive với SuccessfulExit=false sẽ dừng hẳn sau khi hub thu hồi máy.
		if os.Getenv("HIVE_WORKER_LAUNCHD") == "1" {
			return 0
		}
		return 3
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// statusPrinter in mỗi trạng thái thành một dòng JSON. Encoder ghi cả dòng trong một lần Write nên không lẫn dòng.
func statusPrinter(w io.Writer) func(channel.Status) {
	enc := json.NewEncoder(w)
	return func(s channel.Status) { _ = enc.Encode(s) }
}

func check(args []string) int {
	fs := flag.NewFlagSet("check", flag.ContinueOnError)
	hub := fs.String("hub", envOr("HIVE_HUB_URL", "http://localhost:3000"), "địa chỉ hub")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	h, err := hubclient.New(*hub).Health(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("Hub %s đang chạy (worker %s)\n", h.Version, version.Version)
	return 0
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
