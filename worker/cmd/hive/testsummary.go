package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/tdduydev/xdev-hive/worker/internal/testreport"
)

func (a *app) testSummary(args []string) int {
	if len(args) == 0 {
		return a.errorf(exitUsage, "Cách dùng: hive test-summary <file> [--format playwright|junit] [--commit SHA] [--max-cases N]")
	}
	fs := flag.NewFlagSet("test-summary", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	format := fs.String("format", "", "Định dạng playwright hoặc junit")
	commit := fs.String("commit", "", "SHA commit đầy đủ")
	limit := fs.Int("max-cases", testreport.MaxCases, "Số TC tối đa")
	if fs.Parse(args[1:]) != nil || fs.NArg() > 0 {
		return a.errorf(exitUsage, "Tham số tóm tắt test không hợp lệ; dùng --format, --commit hoặc --max-cases.")
	}
	f, err := os.Open(args[0])
	if err != nil {
		return a.errorf(exitUsage, "Không mở được file báo cáo test.")
	}
	defer f.Close()
	summary, err := testreport.Parse(f, *format, *commit, *limit)
	if err != nil {
		return a.errorf(exitUsage, "%s", err)
	}
	if err := json.NewEncoder(a.stdout).Encode(summary); err != nil {
		fmt.Fprintln(a.stderr, "Không ghi được metadata kết quả test.")
		return exitFailed
	}
	return exitOK
}
