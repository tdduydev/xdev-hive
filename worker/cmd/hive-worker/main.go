// hive-worker chạy trên máy dev (và ở chế độ host trên runner server), gọi ra hub để nhận run.
// M0 mới có lệnh version và check; vòng nhận job thêm ở M3.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/channel"
	"github.com/tdduydev/xdev-hive/worker/internal/hubclient"
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
	case "run":
		os.Exit(run(os.Args[2:]))
	default:
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "Cách dùng: hive-worker <version|check --hub URL|run --hub URL --machine ID>")
}

func run(args []string) int {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	hub := fs.String("hub", envOr("HIVE_HUB_URL", "http://localhost:3000"), "địa chỉ hub")
	machine := fs.String("machine", envOr("HIVE_MACHINE_ID", ""), "ID máy đã đăng ký")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *machine == "" {
		fmt.Fprintln(os.Stderr, "Cần --machine hoặc HIVE_MACHINE_ID")
		return 2
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	err := (channel.Config{HubURL: *hub, Machine: *machine, Version: version.Version, Logger: slog.Default()}).Run(ctx)
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
