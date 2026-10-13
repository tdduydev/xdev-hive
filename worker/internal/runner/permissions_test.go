package runner

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRunPermissionArguments(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	for _, cli := range []string{"claude", "codex", "gemini", "antigravity"} {
		for _, mode := range []string{"", "workspace", "full"} {
			t.Run(cli+"/"+mode, func(t *testing.T) {
				roots := []string{filepath.Join(t.TempDir(), "cache.git"), filepath.Join(t.TempDir(), "gitdir")}
				c, err := (Runner{}).cliCommand(Job{CLI: cli, RunPermissions: mode, gitRoots: roots, Prompt: "p"})
				if err != nil {
					t.Fatal(err)
				}
				if c.cleanup != nil {
					defer c.cleanup()
				}
				args := strings.Join(c.Args[1:], "\x00")
				wants := []string{}
				switch cli {
				case "claude":
					if mode == "full" {
						wants = []string{"--permission-mode\x00bypassPermissions"}
					} else {
						wants = []string{"--permission-mode\x00acceptEdits", "--allowedTools\x00Bash"}
					}
				case "codex":
					if mode == "full" {
						wants = []string{"--dangerously-bypass-approvals-and-sandbox"}
					} else {
						encoded, _ := json.Marshal(roots)
						wants = []string{"-s\x00workspace-write", "approval_policy=\"never\"", "sandbox_workspace_write.writable_roots=" + string(encoded)}
					}
				case "gemini":
					wants = []string{"--skip-trust"}
					if mode == "full" {
						wants = append(wants, "--approval-mode\x00yolo")
					} else {
						wants = append(wants, "--approval-mode\x00auto_edit", "--policy")
						policy := c.Args[len(c.Args)-1]
						data, err := os.ReadFile(policy)
						if err != nil || !strings.Contains(string(data), `toolName = "run_shell_command"`) || !strings.Contains(string(data), `decision = "allow"`) {
							t.Fatalf("policy: %s, %v", data, err)
						}
						c.cleanup()
						if _, err := os.Stat(policy); !os.IsNotExist(err) {
							t.Fatalf("policy chưa dọn: %v", err)
						}
					}
				case "antigravity":
					// agy -p chỉ chạy không tương tác khi tự duyệt mọi quyền; --sandbox của agy chặn cả git commit nên
					// workspace cũng không có nó.
					wants = []string{"--dangerously-skip-permissions"}
					if strings.Contains(args, "--sandbox") {
						t.Fatalf("run code có --sandbox: %v", c.Args)
					}
				}
				for _, want := range wants {
					if !strings.Contains(args, want) {
						t.Fatalf("thiếu %q: %v", want, c.Args)
					}
				}
				if mode != "full" && (strings.Contains(args, "bypassPermissions") || strings.Contains(args, "dangerously-bypass") || strings.Contains(args, "yolo")) {
					t.Fatalf("workspace bỏ kiểm soát: %v", c.Args)
				}
				if mode == "full" && (strings.Contains(args, "workspace-write") || strings.Contains(args, "acceptEdits") || strings.Contains(args, "auto_edit")) {
					t.Fatalf("lẫn chế độ: %v", c.Args)
				}
			})
		}
	}
	if _, err := (Runner{}).cliCommand(Job{CLI: "codex", RunPermissions: "invalid"}); err == nil {
		t.Fatal("chấp nhận chế độ không hợp lệ")
	}
	override := Command{Path: "fake", Args: []string{"{{prompt}}"}}
	c, err := (Runner{CLICommands: map[string]Command{"codex": override}}).cliCommand(Job{CLI: "codex", RunPermissions: "full", Prompt: "p"})
	if err != nil || !reflect.DeepEqual(c.Args, []string{"fake", "p"}) {
		t.Fatalf("thay đổi override: %v, %v", c, err)
	}
}

// Chạy chủ động vì gọi API trả phí và cần CLI đã xác thực trên máy.
func TestRealCLIRunPermissions(t *testing.T) {
	cli := os.Getenv("HIVE_RUNNER_REAL_CLI")
	if cli == "" {
		t.Skip("đặt HIVE_RUNNER_REAL_CLI=claude|codex để thử CLI thật")
	}
	if cli != "claude" && cli != "codex" {
		t.Fatal("HIVE_RUNNER_REAL_CLI phải là claude hoặc codex")
	}
	t.Setenv(CLIOverridesEnv, "")
	for _, mode := range []string{"workspace", "full"} {
		t.Run(mode, func(t *testing.T) {
			remote, base := makeRemote(t)
			hub := httptest.NewServer(http.NotFoundHandler())
			defer hub.Close()
			var result *Result
			var logs strings.Builder
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			err := (Runner{DataDir: t.TempDir()}).Run(ctx, Job{
				RunID: "real-" + cli + "-" + mode, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/permissions", CLI: cli, RunPermissions: mode,
				Prompt: "Create a.txt containing 1, run ls, git add a.txt and git -c user.name=Probe -c user.email=probe@example.invalid commit -m probe. Use no other tools. Reply briefly.",
				Env:    map[string]string{"HIVE_HUB_URL": hub.URL, "HIVE_RUN_TOKEN": "test"}, Timeout: 90 * time.Second,
			}, SinkFunc(func(e Event) error {
				if e.Result != nil {
					result = e.Result
				}
				if e.Type == "log" {
					logs.Write(e.Data)
				}
				return nil
			}))
			if err != nil || result == nil || result.CommitCount != 1 || !reflect.DeepEqual(result.ChangedFiles, []string{"a.txt"}) {
				t.Fatalf("CLI %s/%s: %v, %+v\n%s", cli, mode, err, result, logs.String())
			}
			t.Logf("CLI %s/%s: commit=%d, files=%v", cli, mode, result.CommitCount, result.ChangedFiles)
		})
	}
}
