// hive-worker chạy trên máy dev (và ở chế độ host trên runner server), gọi ra hub để nhận run.
// Lệnh: version, check, register (đổi mã đăng ký lấy machine token), run (nối WSS tới hub), config (xem cấu hình),
// update (tải bản phát hành mới, kiểm chữ ký rồi thay binary).
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

	"github.com/tdduydev/xdev-hive/worker/internal/accounts"
	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/projects"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
	"github.com/tdduydev/xdev-hive/worker/internal/service"
	"github.com/tdduydev/xdev-hive/worker/internal/update"
	"github.com/tdduydev/xdev-hive/worker/internal/version"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "hook":
		// Ẩn khỏi trợ giúp: Claude Code gọi lệnh này làm hook của run (runner/guard.go), người dùng không gọi tay.
		os.Exit(runner.HookMain(os.Args[2:], os.Stdin, os.Stdout))
	case "egress-proxy":
		os.Exit(egressProxy(os.Args[2:], os.Stderr))
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
	case "accounts":
		os.Exit(accountsCommand(os.Args[2:], os.Stdout, os.Stderr))
	case "optimize":
		os.Exit(optimizeCommand(os.Args[2:], os.Stdout, os.Stderr))
	case "projects":
		os.Exit(projectsCommand(os.Args[2:], os.Stdout, os.Stderr))
	case "memory":
		os.Exit(memoryCommand(os.Args[2:], os.Stdout, os.Stderr))
	case "service":
		os.Exit(serviceCommand(os.Args[2:], os.Stdout, os.Stderr))
	case "update":
		os.Exit(updateCommand(os.Args[2:], os.Stdout, os.Stderr))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Cách dùng: hive-worker <version | check --hub URL | register --hub URL --token MÃ [--machine TÊN] [--json] | run [--status-json] [--stdin-control] | host [--allow-runc] [--image IMAGE] | config [--json] | accounts [import-legacy | set | add | update | remove | usage | resume] [--json] | projects [bind | unbind | set | import-legacy] [--json] | memory [scan | edit | delete | restore | merge | share | unshare] [--json] | optimize [status | enable | disable | restore | link | report] [--json] | service install|uninstall|status|restart | update [--check] [--version X.Y.Z] [--json] | egress-proxy --allowlist FILE [--listen HOST:PORT] [--unix-socket PATH]>")
}

func serviceCommand(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "Cách dùng: hive-worker service install|uninstall|status|restart")
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
	case "restart":
		restarted, err := manager.Restart(plan)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		if restarted {
			fmt.Fprintln(stdout, "Đã khởi động lại dịch vụ worker.")
		} else {
			fmt.Fprintln(stdout, "Dịch vụ worker chưa chạy; không cần khởi động lại.")
		}
	default:
		fmt.Fprintln(stderr, "Cách dùng: hive-worker service install|uninstall|status|restart")
		return 2
	}
	return 0
}

// knownCLIs là các agent CLI hub biết giao việc (khớp enum cli trong packages/contracts). Hub cũ chỉ biết một phần;
// worker lọc theo hub trước khi khai (hubclient.SupportedCLIs).
var knownCLIs = []string{"claude", "codex", "gemini", "antigravity"}

func detectCLIs() []string {
	// CLI ghi đè qua HIVE_WORKER_CLI_OVERRIDES (CLI giả của scripts/e2e-smoke.ts) tính là có khi lệnh của nó chạy được,
	// để hub giao việc cho máy dù máy không cài CLI thật.
	overrides, err := runner.CommandsFromEnv()
	if err != nil {
		slog.Warn("Bỏ qua CLI ghi đè", "error", err)
	}
	found := []string{}
	for _, name := range knownCLIs {
		path := runner.Binary(name)
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
	client := hubclient.New(*hub)
	clis, dropped := client.SupportedCLIs(ctx, detectCLIs())
	if len(dropped) > 0 {
		fmt.Fprintf(stderr, "Hub chưa nhận CLI %s; cập nhật hub để giao run cho chúng.\n", strings.Join(dropped, ", "))
	}
	reg, err := client.Register(ctx, hubclient.RegisterRequest{
		RegistrationToken: *token,
		MachineID:         *machine,
		OS:                runtime.GOOS,
		Version:           version.Version,
		CLIs:              clis,
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
	// Nhiều tài khoản CLI trên máy (accounts.json cạnh file cấu hình): không đặt --capacity thì nhận cùng lúc theo
	// maxParallel của file, hoặc tổng số run các tài khoản bật cho phép; tối đa maxAutoCapacity.
	pool := accounts.NewPool(accounts.DefaultPath(path))
	go pool.Watch(ctx)
	// Phiên `hive chat` dùng chung pool với run để bộ chọn gói đếm cả hai (specs/010 D2).
	stopLocal := startLocalIPC(pool)
	defer stopLocal()
	slots := *capacity
	if !flagSet(fs, "capacity") {
		if slots, err = accounts.Capacity(accounts.DefaultPath(path), maxAutoCapacity); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 1
		}
	}
	// --stdin-control là app desktop chạy worker làm sidecar: app tự cập nhật cả gói, worker không tự thay mình.
	return startWorker(ctx, cfg, slots, dataDir, "", nil, pool, projects.DefaultPath(path), *statusJSON, selfUpdates(*stdinControl), cfg.HubURL)
}

// selfUpdates: worker tự cài bản mới khi hub bảo, trừ khi chạy làm sidecar của app desktop (--stdin-control): binary
// nằm trong gói app đã ký và app cập nhật cả gói, worker tự thay mình sẽ làm hỏng chữ ký và lệch phiên bản.
func selfUpdates(stdinControl bool) bool { return !stdinControl }

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
	return startWorker(ctx, cfg, *capacity, dataDir, "host", sandbox, nil, "", false, true, cfg.HubURL)
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
		// Đóng im lặng thì CLI chỉ thấy "socket hang up"; ghi lý do để log của run cho biết vì sao mất mạng.
		fmt.Fprintf(os.Stderr, "sandbox-init: không nối được egress proxy qua %s: %v\n", socket, err)
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
	runsc, dockerRunsc := runtimes["runsc"]
	_, runscBinary := exec.LookPath("runsc")
	if dockerRunsc && runscBinary == nil {
		if !runscAllowsHostUDS(runsc) {
			return errors.New("runtime runsc của Docker chưa cho container nối unix socket của egress proxy; chạy: " +
				"sudo runsc install -- --host-uds=open && sudo systemctl reload docker")
		}
		return nil
	}
	if allowRunc {
		return nil
	}
	return errors.New("không tìm thấy runtime gVisor runsc trong Docker và PATH; cài runsc hoặc dùng --allow-runc chỉ cho phát triển")
}

// runscAllowsHostUDS: gVisor mặc định chặn container nối unix socket của máy chủ (host-uds=none), mà đường ra mạng
// duy nhất của run là socket egress proxy được bind mount vào container.
func runscAllowsHostUDS(raw json.RawMessage) bool {
	var rt struct {
		RuntimeArgs []string `json:"runtimeArgs"`
	}
	if err := json.Unmarshal(raw, &rt); err != nil {
		return false
	}
	for _, arg := range rt.RuntimeArgs {
		switch strings.TrimLeft(arg, "-") {
		case "host-uds=open", "host-uds=all":
			return true
		}
	}
	return false
}

// maxAutoCapacity chặn số run cùng lúc tính từ accounts.json, để danh sách dài không làm máy quá tải.
const maxAutoCapacity = 8

// flagSet cho biết người gọi có đặt cờ này không (khác giá trị mặc định).
func flagSet(fs *flag.FlagSet, name string) bool {
	set := false
	fs.Visit(func(f *flag.Flag) { set = set || f.Name == name })
	return set
}

// projectsFile là projects.json (ADR 0020); runner host truyền rỗng vì run sandbox không dùng repo trên máy.
func startWorker(ctx context.Context, cfg config.Config, capacity int, dataDir, mode string, sandbox *runner.SandboxConfig, pool *accounts.Pool, projectsFile string, statusJSON, selfUpdate bool, hubURL string) int {
	clis := detectCLIs()
	if mode == "host" {
		clis = knownCLIs
	}
	cc := channel.Config{HubURL: hubURL, Machine: cfg.MachineID, Token: cfg.MachineToken, Version: version.Version, CLIs: clis, Capacity: capacity, RunnerMode: mode, Sandbox: sandbox, DataDir: filepath.Join(dataDir, "xdev-hive", "worker"), Logger: slog.Default(), SelfUpdate: selfUpdate, Accounts: pool, Projects: projectsFile}
	if statusJSON {
		cc.OnStatus = statusPrinter(os.Stdout)
	}
	err := cc.Run(ctx)
	var requested *channel.UpdateRequest
	var upgrade *channel.UpgradeError
	if errors.As(err, &requested) {
		return updateAndRestart(ctx, requested.Version)
	}
	if selfUpdate && errors.As(err, &upgrade) {
		// Hub không còn nói chuyện được với bản này: lên bản mới nhất thay vì để dịch vụ khởi động lại mãi với bản cũ.
		fmt.Fprintln(os.Stderr, err)
		return updateAndRestart(ctx, "")
	}
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

// Test thay nguồn bản phát hành và file bị ghi đè.
var (
	updateSource     = update.Default
	updateExecutable = update.Executable
)

func updateCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("update", flag.ContinueOnError)
	fs.SetOutput(stderr)
	check := fs.Bool("check", false, "chỉ xem có bản mới không, không cài")
	target := fs.String("version", "", "cài đúng phiên bản này, kể cả cũ hơn bản đang chạy (mặc định bản mới nhất)")
	asJSON := fs.Bool("json", false, "in kết quả dạng JSON")
	noRestart := fs.Bool("no-restart", false, "không khởi động lại dịch vụ worker sau khi cập nhật")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	*target = strings.TrimPrefix(*target, "v")
	if *target != "" && !update.ValidVersion(*target) {
		fmt.Fprintf(stderr, "Phiên bản không hợp lệ: %s\n", *target)
		return 2
	}
	src, err := updateSource()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	ctx, cancelTimeout := context.WithTimeout(ctx, 10*time.Minute)
	defer cancelTimeout()
	if *check {
		latest, err := src.Latest(ctx)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		outdated := update.Newer(latest, version.Version)
		if *asJSON {
			_ = json.NewEncoder(stdout).Encode(map[string]any{"current": version.Version, "latest": latest, "outdated": outdated})
			return 0
		}
		fmt.Fprintf(stdout, "Đang chạy %s; bản mới nhất %s.\n", version.Version, latest)
		if outdated {
			fmt.Fprintln(stdout, "Chạy `hive-worker update` để cập nhật.")
		}
		return 0
	}
	exe, err := updateExecutable()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	installed, err := applyUpdate(ctx, src, exe, version.Version, *target)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	restarted := false
	if installed != "" && !*noRestart {
		restarted, err = service.Manager{}.Restart(service.Plan{OS: runtime.GOOS})
		if err != nil {
			fmt.Fprintf(stderr, "Đã cài bản %s nhưng chưa khởi động lại được dịch vụ worker: %v\n", installed, err)
			return 1
		}
	}
	if *asJSON {
		_ = json.NewEncoder(stdout).Encode(map[string]any{"previous": version.Version, "installed": installed, "restarted": restarted})
		return 0
	}
	switch {
	case installed == "":
		fmt.Fprintf(stdout, "Đã là bản mới nhất (%s).\n", version.Version)
	case restarted:
		fmt.Fprintf(stdout, "Đã cập nhật hive-worker %s → %s và khởi động lại dịch vụ worker.\n", version.Version, installed)
	default:
		fmt.Fprintf(stdout, "Đã cập nhật hive-worker %s → %s. Worker đang chạy bằng tay thì khởi động lại để dùng bản mới.\n", version.Version, installed)
	}
	return 0
}

// applyUpdate cài bản target (rỗng là bản mới nhất, chỉ khi mới hơn current) và trả phiên bản đã cài, rỗng khi không
// cần cài. Target ghi rõ thì cài kể cả cũ hơn, để quay về bản trước khi bản mới lỗi.
func applyUpdate(ctx context.Context, src update.Source, exe, current, target string) (string, error) {
	if target == "" {
		latest, err := src.Latest(ctx)
		if err != nil {
			return "", err
		}
		if !update.Newer(latest, current) {
			return "", nil
		}
		target = latest
	} else if target == current {
		return "", nil
	}
	binary, err := src.Download(ctx, target)
	if err != nil {
		return "", err
	}
	if err := update.Install(exe, binary, target); err != nil {
		return "", err
	}
	return target, nil
}

// updateAndRestart chạy khi hub yêu cầu cập nhật và worker đã chờ run đang chạy xong: cài bản mới rồi chạy lại đúng lệnh
// này bằng binary mới. Cập nhật lỗi thì vẫn chạy lại bản cũ, để máy không rời hub chỉ vì lỗi mạng lúc tải.
func updateAndRestart(ctx context.Context, target string) int {
	exe, err := update.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	src, err := update.Default()
	if err == nil {
		var installed string
		installed, err = applyUpdate(ctx, src, exe, version.Version, target)
		if installed != "" {
			slog.Info("Đã cập nhật worker, khởi động lại bằng bản mới", "from", version.Version, "to", installed)
		}
	}
	if err != nil {
		slog.Error("Cập nhật worker không thành công, chạy tiếp bản hiện tại", "error", err)
	}
	if ctx.Err() != nil {
		return 0
	}
	if err := restartSelf(exe); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
