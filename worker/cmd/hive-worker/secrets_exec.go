package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/secretstore"
)

var secretsExecLaunch = launchSecretProcess

func runSecretsExec(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("secrets exec", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	project := fs.String("project", "", "localId")
	kind := fs.String("kind", "terminal", "loại phiên")
	cli := fs.String("cli", "shell", "CLI")
	configPath := fs.String("config", "", "cấu hình worker")
	if fs.Parse(args) != nil || fs.NArg() == 0 || *kind != "terminal" {
		fmt.Fprintln(stderr, "Cách dùng: hive-worker secrets exec --project LOCAL_ID --kind terminal [--cli claude|codex|gemini|shell] -- <lệnh…>")
		return 2
	}
	path, err := pathOr(*configPath)
	if err != nil {
		fmt.Fprintln(stderr, "Không xác định được cấu hình worker.")
		return 78
	}
	g, err := secretstore.Grant(context.Background(), secretstore.GrantRequest{
		WorkerConfig: path, LocalID: *project, Kind: secretstore.KindTerminal, Store: secretsStore(),
		Approve: func(ctx context.Context, req secretstore.ApprovalRequest) (bool, error) {
			fmt.Fprintf(stderr, "Đưa %d bí mật (%s) vào phiên này? [c/K] ", len(req.Names), strings.Join(req.Names, ", "))
			answer := make(chan string, 1)
			go func() { answer <- readTerminalLine(stdin) }()
			select {
			case line := <-answer:
				return strings.EqualFold(strings.TrimSpace(line), "c"), nil
			case <-ctx.Done():
				return false, secretstore.ErrApprovalTimeout
			}
		},
	})
	if err != nil {
		// Chỉ lỗi đã phân loại được phép ra terminal; lỗi backend thô có thể chứa giá trị.
		var message = "Không đọc được kho bí mật. Mở khoá máy, kiểm tra kho rồi thử lại."
		if e, ok := err.(*secretstore.Error); ok {
			message = e.Message
		}
		fmt.Fprintln(stderr, message)
		fmt.Fprintln(stderr, "Nhấn Enter để đóng phiên.")
		_ = readTerminalLine(stdin)
		return 78
	}
	argv := append([]string(nil), fs.Args()...)
	policy := secretstore.PolicyAllow
	if len(g.Items) > 0 && g.Outcome != secretstore.OutcomeGranted {
		policy = secretstore.PolicyDeny
	}
	if *cli == "claude" {
		if block := secretstore.ContextBlock(policy, g.Items); block != "" {
			argv = append(argv, "--append-system-prompt", block)
		}
	}
	return secretsExecLaunch(argv, secretstore.MergeEnv(os.Environ(), g.Env), stdin, stdout, stderr)
}

// Không đọc trước vào bộ đệm: CLI cần đúng stdin/console và phần nhập còn lại của người dùng.
func readTerminalLine(in io.Reader) string {
	var b strings.Builder
	var one [1]byte
	for b.Len() < 1024 {
		n, err := in.Read(one[:])
		if n > 0 {
			b.WriteByte(one[0])
			if one[0] == '\n' {
				break
			}
		}
		if err != nil {
			break
		}
	}
	return b.String()
}
