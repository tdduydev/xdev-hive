package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Hook là hook bắt buộc của tổ chức (Chính sách agent trên hub, specs/002-agent-policies).
type Hook struct {
	Event   string `json:"event"` // "PreToolUse", "PostToolUse" hoặc "Stop"
	Name    string `json:"name"`
	Command string `json:"command"`
	// Matcher theo cú pháp của Claude Code; rỗng là mọi tool.
	Matcher string `json:"matcher,omitempty"`
}

// JobPolicy là phần chính sách hub gửi kèm job_offer.
type JobPolicy struct {
	Hooks []Hook `json:"hooks"`
	// ManagedHooksOnly: CLI không nạp hook và cấu hình trong repo, chỉ chạy hook của tổ chức.
	ManagedHooksOnly bool `json:"managedHooksOnly"`
}

const stopHookTimeout = 10 * time.Minute

func hooksOf(hooks []Hook, events ...string) []Hook {
	var out []Hook
	for _, h := range hooks {
		for _, e := range events {
			if h.Event == e {
				out = append(out, h)
			}
		}
	}
	return out
}

// claudeHookSettings dựng JSON cho cờ --settings của Claude Code từ hook PreToolUse/PostToolUse. Hook từ --settings vẫn
// chạy khi --setting-sources rỗng (đã thử trên claude 2.1.296), nên "chỉ hook của tổ chức" là bỏ nguồn project.
func claudeHookSettings(hooks []Hook) (string, error) { return claudeHookSettingsWith(hooks, nil) }

// claudeHookSettingsWith thêm các mục đã dựng sẵn (hook của worker, guard.go) sau hook của tổ chức.
func claudeHookSettingsWith(hooks []Hook, extra map[string][]any) (string, error) {
	byEvent := map[string][]any{}
	for _, h := range hooksOf(hooks, "PreToolUse", "PostToolUse") {
		entry := map[string]any{"hooks": []any{map[string]any{"type": "command", "command": h.Command}}}
		if h.Matcher != "" {
			entry["matcher"] = h.Matcher
		}
		byEvent[h.Event] = append(byEvent[h.Event], entry)
	}
	for _, event := range []string{"PreToolUse", "PostToolUse"} {
		byEvent[event] = append(byEvent[event], extra[event]...)
		if len(byEvent[event]) == 0 {
			delete(byEvent, event)
		}
	}
	if len(byEvent) == 0 {
		return "", nil
	}
	b, err := json.Marshal(map[string]any{"hooks": byEvent})
	return string(b), err
}

// hookEnv bỏ token và secret của run: lệnh hook do quản trị tổ chức đặt, không cần quyền gọi hub thay agent.
func hookEnv(env map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range env {
		u := strings.ToUpper(k)
		if strings.Contains(u, "TOKEN") || strings.Contains(u, "SECRET") || strings.Contains(u, "PASSWORD") {
			continue
		}
		out[k] = v
	}
	return out
}

// runStopHooks chạy hook Stop sau khi CLI xong, trước khi đếm commit và push, cho mọi CLI: Codex và Gemini không có
// hook Stop như Claude Code, và chạy ở worker cho kết quả rõ ràng (lỗi là run lỗi, không push). Log vào luồng của run.
func (r Runner) runStopHooks(ctx context.Context, job Job, work string, stdout, stderr io.Writer) error {
	for _, h := range hooksOf(job.Policy.Hooks, "Stop") {
		_, _ = fmt.Fprintf(stdout, "\n[xdev-hive] Hook Stop của tổ chức: %s\n", h.Name)
		hctx, cancel := context.WithTimeout(ctx, stopHookTimeout)
		var cmd *exec.Cmd
		env := hookEnv(job.Env)
		if r.Sandbox != nil {
			s := r.Sandbox.normalized()
			uid, gid, err := hostIdentity()
			if err != nil {
				cancel()
				return err
			}
			args := SandboxRunArgs(s, job.RunID+"-hook", work, job.repoCache, job.EnvironmentImage, []string{"sh", "-lc", h.Command}, env, uid, gid)
			cmd = exec.CommandContext(hctx, s.DockerPath, args...)
			cmd.Env = mergeEnv(os.Environ(), sandboxEnv(env, s))
		} else {
			if runtime.GOOS == "windows" {
				cmd = exec.CommandContext(hctx, "cmd.exe", "/C", h.Command)
			} else {
				cmd = exec.CommandContext(hctx, "sh", "-c", h.Command)
			}
			cmd.Dir = work
			cmd.Env = mergeEnv(os.Environ(), env)
		}
		cmd.Stdout, cmd.Stderr = stdout, stderr
		err := cmd.Run()
		timedOut := hctx.Err() == context.DeadlineExceeded
		cancel()
		if r.Sandbox != nil {
			// Hết giờ chỉ giết client docker; container có thể còn chạy.
			r.removeSandbox(context.Background(), job.RunID+"-hook")
		}
		if timedOut {
			return fmt.Errorf("hook Stop %q của tổ chức chạy quá %s", h.Name, stopHookTimeout)
		}
		if err != nil {
			return fmt.Errorf("hook Stop %q của tổ chức lỗi: %w", h.Name, err)
		}
	}
	return nil
}
