package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/runner"
)

const contextPackUsage = "Cách dùng: hive-worker context-pack [--json] --cwd THƯ_MỤC --query CÂU [--budget SỐ_TOKEN]"

func contextPackCommand(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("context-pack", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	fs.Usage = func() { fmt.Fprintln(stderr, contextPackUsage) }
	asJSON := fs.Bool("json", false, "in dạng JSON")
	cwd := fs.String("cwd", "", "thư mục trong kho Git tại máy")
	query := fs.String("query", "", "mô tả việc cần tìm file liên quan")
	budget := fs.Int("budget", 4000, "ngân sách token ước tính, tối đa 4000")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		fmt.Fprintln(stderr, "Tham số không hợp lệ.")
		fs.Usage()
		return 2
	}
	if fs.NArg() != 0 || strings.TrimSpace(*cwd) == "" || strings.TrimSpace(*query) == "" || *budget <= 0 {
		fmt.Fprintln(stderr, "Cần --cwd, --query và --budget lớn hơn 0.")
		fs.Usage()
		return 2
	}
	dir, err := filepath.Abs(*cwd)
	if err != nil {
		fmt.Fprintln(stderr, "Không xác định được đường dẫn --cwd.")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pack, err := runner.BuildLocalContextPack(ctx, dir, *query, *budget)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	if *asJSON {
		err = json.NewEncoder(stdout).Encode(pack)
	} else {
		_, err = io.WriteString(stdout, pack.Markdown)
	}
	if err != nil {
		fmt.Fprintln(stderr, "Không ghi được context pack.")
		return 1
	}
	return 0
}
