package memstore

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// fakeClaude là script sh giả `claude -p`: ghi lại stdin, cờ, biến môi trường và thư mục làm việc rồi in reply.json.
func fakeClaude(t *testing.T, result string, isError bool, usage map[string]int) (command, dir string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("script sh giả chỉ chạy trên Unix")
	}
	dir = t.TempDir()
	reply, err := json.Marshal(map[string]any{"result": result, "is_error": isError, "usage": usage})
	if err != nil {
		t.Fatal(err)
	}
	writeFixture(t, filepath.Join(dir, "reply.json"), string(reply))
	script := "#!/bin/sh\ncat > '" + dir + "/stdin.txt'\nprintf '%s\\n' \"$@\" > '" + dir + "/args.txt'\n" +
		"echo \"$CLAUDE_CONFIG_DIR\" > '" + dir + "/env.txt'\npwd > '" + dir + "/cwd.txt'\ncat '" + dir + "/reply.json'\n"
	command = filepath.Join(dir, "claude")
	if err := os.WriteFile(command, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return command, dir
}

func compressFixture(t *testing.T) (a, b string) {
	t.Helper()
	root := t.TempDir()
	a = filepath.Join(root, "MEMORY.md")
	b = filepath.Join(root, "deploy.md")
	writeFixture(t, a, "# Memory\n\n- [Deploy](deploy.md) — cách deploy\n")
	writeFixture(t, b, "deploy bằng pnpm\ndeploy bằng pnpm\nchạy test trước khi merge\n")
	return a, b
}

func TestCompressProposesWithoutWritingAndMarksNewLines(t *testing.T) {
	a, b := compressFixture(t)
	answer := "```json\n" + `{"files":[{"path":"02-deploy.md","content":"deploy bằng pnpm\nchạy test trước khi merge\nluôn dùng Node 24\n"},` +
		`{"path":"/etc/passwd","content":"x"},{"path":"01-MEMORY.md","content":"  \n"},{"path":"01-MEMORY.md","content":"# Memory\n\n- [Deploy](deploy.md) — cách deploy\n"}]}` + "\n```"
	command, dir := fakeClaude(t, answer, false, map[string]int{"input_tokens": 100, "output_tokens": 20, "cache_creation_input_tokens": 5, "cache_read_input_tokens": 7})
	before := readText(t, b)

	got, err := Compress(context.Background(), CompressOptions{Command: command, Env: []string{"CLAUDE_CONFIG_DIR=/cfg/claude-2"}, Files: []string{a, b}})
	if err != nil {
		t.Fatal(err)
	}
	if got.TokensUsed != 132 {
		t.Fatalf("tokensUsed = %d", got.TokensUsed)
	}
	// File giữ nguyên nội dung thì không thành đề xuất; đề xuất rỗng và file lạ bị bỏ kèm cảnh báo.
	if len(got.Files) != 1 || got.Files[0].Path != b || len(got.Warnings) != 2 {
		t.Fatalf("result = %+v", got)
	}
	p := got.Files[0]
	if p.Before != before || len(p.NewLines) != 1 || p.NewLines[0] != 3 {
		t.Fatalf("proposal = %+v", p)
	}
	if p.TokensBefore != EstimateTokens(before) || p.TokensAfter == 0 {
		t.Fatalf("tokens = %d -> %d", p.TokensBefore, p.TokensAfter)
	}
	if readText(t, b) != before {
		t.Fatal("compress wrote to the real file")
	}

	args := readText(t, filepath.Join(dir, "args.txt"))
	for _, flag := range []string{"-p", "--restricted", "--strict-mcp-config", "Read,Glob,Grep", "--permission-prompts"} {
		if !strings.Contains(args, flag) {
			t.Errorf("missing %s in %q", flag, args)
		}
	}
	for _, tool := range []string{"Write", "Edit", "Bash"} {
		if strings.Contains(args, tool) {
			t.Errorf("unexpected tool %s", tool)
		}
	}
	if strings.TrimSpace(readText(t, filepath.Join(dir, "env.txt"))) != "/cfg/claude-2" {
		t.Fatal("profile config dir not passed")
	}
	cwd := strings.TrimSpace(readText(t, filepath.Join(dir, "cwd.txt")))
	if cwd == filepath.Dir(b) || !strings.Contains(readText(t, filepath.Join(dir, "stdin.txt")), "02-deploy.md") {
		t.Fatalf("cwd = %s", cwd)
	}
	if exists(cwd) {
		t.Fatal("workspace not removed")
	}
}

func TestCompressFailures(t *testing.T) {
	a, b := compressFixture(t)
	for name, tc := range map[string]struct {
		result  string
		isError bool
		want    string
	}{
		"not json":    {result: "xin lỗi, tôi không làm được", want: "JSON đề xuất"},
		"cli error":   {result: "quota hết", isError: true, want: "quota hết"},
		"empty reply": {result: `{"files":[]}`},
	} {
		t.Run(name, func(t *testing.T) {
			command, _ := fakeClaude(t, tc.result, tc.isError, nil)
			got, err := Compress(context.Background(), CompressOptions{Command: command, Files: []string{a, b}})
			switch {
			case tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)):
				t.Fatalf("err = %v", err)
			case tc.want == "" && (err != nil || len(got.Files) != 0):
				t.Fatalf("got = %+v, err = %v", got, err)
			}
		})
	}
	if _, err := Compress(context.Background(), CompressOptions{Command: "x"}); err == nil {
		t.Fatal("no files accepted")
	}
	big := filepath.Join(t.TempDir(), "big.md")
	writeFixture(t, big, strings.Repeat("a", maxCompressChars+1))
	if _, err := Compress(context.Background(), CompressOptions{Command: "x", Files: []string{big}}); err == nil || !strings.Contains(err.Error(), "dài quá") {
		t.Fatalf("big err = %v", err)
	}
}

func TestLineKeyIgnoresFormattingOnlyLines(t *testing.T) {
	for _, line := range []string{"", "   ", "---", "## ", "| - | - |", "```"} {
		if lineKey(line) != "" {
			t.Errorf("%q counted as content", line)
		}
	}
	if lineKey("  a   b ") != "a b" {
		t.Fatal("whitespace not normalised")
	}
}
