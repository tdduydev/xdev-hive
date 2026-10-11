// hive-worker chạy trên máy dev (và ở chế độ host trên runner server), gọi ra hub để nhận run.
// Lệnh: version, check, register (đổi mã đăng ký lấy machine token), run (nối WSS tới hub).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"regexp"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/config"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
	"github.com/tdduydev/xdev-hive/worker/internal/runner"
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
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Cách dùng: hive-worker <version | check --hub URL | register --hub URL --token MÃ [--machine TÊN] | run>")
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
	token := fs.String("token", "", "mã đăng ký admin đội tạo trên web (dùng một lần, hết hạn sau 1 giờ)")
	hostname, _ := os.Hostname()
	machine := fs.String("machine", defaultMachineID(hostname), "tên máy trên hub")
	capacity := fs.Int("capacity", 1, "số run chạy cùng lúc")
	configPath := fs.String("config", "", "file cấu hình (mặc định theo hệ điều hành)")
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
	fmt.Fprintf(stdout, "Đã đăng ký máy %s. Cấu hình lưu ở %s.\nChạy `hive-worker run` để nhận việc.\n", reg.MachineID, path)
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
	err = (channel.Config{HubURL: cfg.HubURL, Machine: cfg.MachineID, Token: cfg.MachineToken, Version: version.Version, CLIs: detectCLIs(), Capacity: *capacity, Logger: slog.Default()}).Run(ctx)
	// Mã thoát riêng khi hub từ chối máy, để trình quản lý dịch vụ không khởi động lại liên tục với token đã hỏng.
	var rejected *channel.RejectedError
	if errors.As(err, &rejected) {
		fmt.Fprintln(os.Stderr, err)
		return 3
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
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
