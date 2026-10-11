package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/egress"
)

func egressProxy(args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("egress-proxy", flag.ContinueOnError)
	fs.SetOutput(stderr)
	allowlistPath := fs.String("allowlist", "", "file allowlist, mỗi dòng một đích; file rỗng chặn mọi đích")
	listen := fs.String("listen", "", "địa chỉ nghe TCP, ví dụ 127.0.0.1:3128")
	socket := fs.String("unix-socket", "", "đường dẫn unix socket riêng cho run")
	connectTimeout := fs.Duration("connect-timeout", 10*time.Second, "thời gian chờ DNS, kết nối và ClientHello")
	idleTimeout := fs.Duration("idle-timeout", 60*time.Second, "thời gian chờ khi không có dữ liệu")
	allowIPv6 := fs.Bool("allow-ipv6", false, "cho phép đích IPv6 đã kiểm; mặc định tắt theo kiến trúc")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if fs.NArg() != 0 || *allowlistPath == "" || (*listen == "" && *socket == "") || *connectTimeout <= 0 || *idleTimeout <= 0 {
		fmt.Fprintln(stderr, "Cần --allowlist, ít nhất một trong --listen/--unix-socket và thời gian chờ lớn hơn 0.")
		return 2
	}
	file, err := os.Open(*allowlistPath)
	if err != nil {
		fmt.Fprintln(stderr, "Không đọc được file allowlist.")
		return 1
	}
	list, err := egress.Parse(file)
	_ = file.Close()
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	proxy, err := egress.New(egress.Config{Allowlist: list, Logger: logger, ConnectTimeout: *connectTimeout, IdleTimeout: *idleTimeout, AllowIPv6: *allowIPv6})
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	listeners, err := egress.Listen(*listen, *socket)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger.Info("egress proxy sẵn sàng", "tcp", *listen, "unix_socket", *socket, "allow_ipv6", *allowIPv6)
	if err := proxy.Serve(ctx, listeners...); err != nil {
		fmt.Fprintln(stderr, "Egress proxy dừng do lỗi.")
		return 1
	}
	return 0
}
