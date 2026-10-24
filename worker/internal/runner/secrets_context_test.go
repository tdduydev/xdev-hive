package runner

import (
	"os"
	"strings"
	"testing"
)

func TestSecretContextOutsideRepository(t *testing.T) {
	for _, cli := range []string{"claude", "codex"} {
		t.Run(cli, func(t *testing.T) {
			r := Runner{DataDir: t.TempDir()}
			repo := t.TempDir()
			job := Job{RunID: "context", Attempt: 1, CLI: cli, Prompt: "task", workspace: repo, claudeVersion: "2.1.296"}
			block := "## Bí mật tại máy\n- `DEMO_CREDENTIAL`\n"
			cleanup, err := r.attachSecretContext(&job, block)
			if err != nil {
				t.Fatal(err)
			}
			defer cleanup()
			if cli == "claude" {
				if job.guard == nil {
					t.Fatal("thiếu file system prompt")
				}
				data, err := os.ReadFile(job.guard.packFile)
				if err != nil || !strings.Contains(string(data), block) {
					t.Fatal("thiếu khối trong system prompt")
				}
			} else if !strings.HasPrefix(job.Prompt, block) {
				t.Fatal("thiếu khối trong prompt")
			}
			entries, _ := os.ReadDir(repo)
			if len(entries) != 0 {
				t.Fatal("đã ghi file vào repo")
			}
		})
	}
}
