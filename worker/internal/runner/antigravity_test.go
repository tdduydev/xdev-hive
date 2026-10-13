package runner

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"
)

// Tham số của agy theo kind, quyền, model và thời gian chờ. Run chỉ đọc luôn có --mode plan và --sandbox và không bao giờ
// có --dangerously-skip-permissions: cờ đó bỏ qua cả chế độ plan lẫn sandbox (đã thử trên agy 1.3.3).
func TestAntigravityArguments(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret"}
	for _, kind := range []string{"", "code", KindReview, KindPlan, KindLeader, KindDocCheck, KindDocAssist} {
		for _, mode := range []string{"", "workspace", "full"} {
			for _, model := range []string{"", "claude-opus-5-5-high"} {
				cmd, err := (Runner{}).cliCommand(Job{CLI: "antigravity", Kind: kind, RunPermissions: mode, Model: model, Prompt: "prompt", Env: env, Timeout: 90 * time.Second})
				if !readOnlyKind(kind) && mode != "full" {
					if err == nil {
						t.Fatalf("run code mode=%q phải bị từ chối", mode)
					}
					continue
				}
				if err != nil {
					t.Fatal(err)
				}
				if filepath.Base(cmd.Args[0]) != "agy" || cmd.input != "" {
					t.Fatalf("lệnh = %v, input %q", cmd.Args, cmd.input)
				}
				want := []string{"-p", "prompt", "--output-format", "stream-json", "--print-timeout", "2m"}
				if model != "" {
					want = append(want, "--model", model)
				}
				if readOnlyKind(kind) {
					want = append(want, "--mode", "plan", "--sandbox")
				} else {
					want = append(want, "--dangerously-skip-permissions")
				}
				if !slices.Equal(cmd.Args[1:], want) {
					t.Fatalf("kind=%q mode=%q model=%q: args = %q, cần %q", kind, mode, model, cmd.Args[1:], want)
				}
				if readOnlyKind(kind) != strings.Contains(cmd.notice, "không nộp được kết quả qua MCP") {
					t.Fatalf("kind=%q: notice = %q", kind, cmd.notice)
				}
			}
		}
	}
	for timeout, want := range map[time.Duration][]string{
		0:                            nil,
		30 * time.Second:             {"--print-timeout", "1m"},
		60 * time.Minute:             {"--print-timeout", "60m"},
		61 * time.Minute:             {"--print-timeout", "61m"},
		61*time.Minute + time.Second: {"--print-timeout", "62m"},
		119 * time.Minute:            {"--print-timeout", "119m"},
	} {
		cmd, err := (Runner{}).cliCommand(Job{CLI: "antigravity", RunPermissions: "full", Prompt: "p", Env: env, Timeout: timeout})
		if err != nil {
			t.Fatal(err)
		}
		i := slices.Index(cmd.Args, "--print-timeout")
		if want == nil && i >= 0 || want != nil && (i < 0 || !slices.Equal(cmd.Args[i:i+2], want)) {
			t.Fatalf("timeout %v: args = %q", timeout, cmd.Args)
		}
	}
}

// Cổng hub và server ngoài được phép vào .agents/mcp_config.json của worktree (loại khỏi git); run chỉ đọc chỉ có cổng
// hub. Repo đã có .agents/mcp_config.json thì không ghi đè mà ghi thành plugin riêng.
func TestAntigravityMCPConfigInWorkspace(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	env := map[string]string{"HIVE_HUB_URL": "https://hub.example/", "HIVE_RUN_TOKEN": "run-secret"}
	clean := func(t *testing.T, work string) {
		t.Helper()
		status, err := gitOutput(t.Context(), work, "status", "--porcelain", "--untracked-files=all")
		if err != nil {
			t.Fatal(err)
		}
		if strings.TrimSpace(status) != "" {
			t.Fatalf("cấu hình Antigravity lọt vào git: %q", status)
		}
	}
	newRepo := func(t *testing.T) string {
		t.Helper()
		work := t.TempDir()
		if err := git(t.Context(), work, "init", "-q"); err != nil {
			t.Fatal(err)
		}
		return work
	}

	work := newRepo(t)
	cmd, err := (Runner{}).cliCommand(Job{CLI: "antigravity", Kind: "code", RunPermissions: "full", Prompt: "p", Env: env, MCPServers: externalTestServers(), workspace: work})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(cmd.notice, ".agents/mcp_config.json") {
		t.Fatalf("notice = %q", cmd.notice)
	}
	path := filepath.Join(work, ".agents", "mcp_config.json")
	if info, err := os.Stat(path); err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("file cấu hình: %v, %v", info, err)
	}
	servers := readMCPConfig(t, path)
	if len(servers) != 3 {
		t.Fatalf("servers = %v", servers)
	}
	hub := servers["xdev-hive"]
	if hub["url"] != "https://hub.example/mcp" || hub["headers"].(map[string]any)["Authorization"] != "Bearer run-secret" {
		t.Fatalf("hub = %v", hub)
	}
	if servers["context7"]["url"] != "https://mcp.context7.com/mcp" || servers["github"]["command"] != "npx" {
		t.Fatalf("servers = %v", servers)
	}
	if v, ok := servers["github"]["env"].(map[string]any)["HIVE_RUN_TOKEN"]; !ok || v != "" {
		t.Fatalf("server stdio phải nhận token rỗng: %v", servers["github"]["env"])
	}
	clean(t, work)

	// Run chỉ đọc không nhận server ngoài.
	work = newRepo(t)
	if _, err := (Runner{}).cliCommand(Job{CLI: "antigravity", Kind: KindPlan, Prompt: "p", Env: env, MCPServers: externalTestServers(), workspace: work}); err != nil {
		t.Fatal(err)
	}
	if servers := readMCPConfig(t, filepath.Join(work, ".agents", "mcp_config.json")); len(servers) != 1 || servers["xdev-hive"] == nil {
		t.Fatalf("run chỉ đọc có server ngoài: %v", servers)
	}
	clean(t, work)

	// Repo tự có .agents/mcp_config.json (đã commit): giữ nguyên, cổng hub vào plugin riêng.
	work = newRepo(t)
	own := filepath.Join(work, ".agents", "mcp_config.json")
	if err := os.MkdirAll(filepath.Dir(own), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(own, []byte(`{"mcpServers":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"add", "."}, {"-c", "user.name=T", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "init"}} {
		if err := git(t.Context(), work, args...); err != nil {
			t.Fatal(err)
		}
	}
	cmd, err = (Runner{}).cliCommand(Job{CLI: "antigravity", Kind: "code", RunPermissions: "full", Prompt: "p", Env: env, workspace: work})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(own); string(b) != `{"mcpServers":{}}` {
		t.Fatalf("ghi đè cấu hình của repo: %s", b)
	}
	plugin := filepath.Join(work, ".agents", "plugins", "xdev-hive")
	if servers := readMCPConfig(t, filepath.Join(plugin, "mcp_config.json")); servers["xdev-hive"]["url"] != "https://hub.example/mcp" {
		t.Fatalf("plugin = %v", servers)
	}
	if b, err := os.ReadFile(filepath.Join(plugin, "plugin.json")); err != nil || !strings.Contains(string(b), `"xdev-hive"`) {
		t.Fatalf("plugin.json: %s, %v", b, err)
	}
	if !strings.Contains(cmd.notice, ".agents/plugins/xdev-hive/mcp_config.json") {
		t.Fatalf("notice = %q", cmd.notice)
	}
	clean(t, work)
}

// Usage đọc từ stream-json thật của agy 1.3.3 (13/10/2026, gemini-3.8-flash-high, ba bước agent_response).
func TestAntigravityUsageFromStreamJSON(t *testing.T) {
	changes := feed(t, NewUsageParser("antigravity"), "antigravity-stream.jsonl")
	if len(changes) == 0 {
		t.Fatal("không đọc được usage")
	}
	u := changes[len(changes)-1]
	if u.InputTokens != 14246+15279+15620 || u.OutputTokens != 800+108+101 || u.CacheReadTokens != 0 || u.CacheWriteTokens != 0 {
		t.Fatalf("usage = %+v", u)
	}
	if u.CostUSD != nil || u.Turns != nil || u.Model == nil || *u.Model != "gemini-3.8-flash-high" {
		t.Fatalf("usage = %+v", u)
	}
	for i := 1; i < len(changes); i++ {
		if changes[i].InputTokens < changes[i-1].InputTokens || changes[i].OutputTokens < changes[i-1].OutputTokens {
			t.Fatalf("usage giảm: %+v -> %+v", changes[i-1], changes[i])
		}
	}
	// input_tokens gồm phần đọc từ cache; phần đó tách sang CacheReadTokens.
	p := NewUsageParser("antigravity")
	p.Line([]byte(`{"event":"result","result":{"usage":{"input_tokens":100,"output_tokens":5,"cache_read_tokens":40}}}`))
	if u := p.Usage(); u.InputTokens != 60 || u.CacheReadTokens != 40 || u.OutputTokens != 5 {
		t.Fatalf("usage = %+v", u)
	}
}

// Chạy cả run với agy giả trong PATH: worktree có cấu hình MCP lúc agy chạy, log run có ghi chú của worker, usage gửi lên
// hub, và cấu hình không lọt vào commit hay danh sách file đổi.
func TestAntigravityRunWithFakeAgy(t *testing.T) {
	t.Setenv(CLIOverridesEnv, "")
	bin := installFakeCLI(t, "agy")
	stream, err := filepath.Abs(filepath.Join("testdata", "antigravity-stream.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	for _, kind := range []string{"code", KindPlan} {
		t.Run(kind, func(t *testing.T) {
			remote, base := makeRemote(t)
			capture := filepath.Join(t.TempDir(), "capture.json")
			var events []Event
			err := (Runner{DataDir: t.TempDir()}).Run(context.Background(), Job{
				RunID: "agy-" + kind, Kind: kind, Attempt: 1, RepoURL: fileURL(remote), BaseBranch: base, Branch: "ai/agy", CLI: "antigravity", RunPermissions: "full",
				Model: "gemini-3.8-flash-high", Prompt: "p", Timeout: 30 * time.Second,
				Env: map[string]string{"HIVE_HUB_URL": "https://hub.example", "HIVE_RUN_TOKEN": "run-secret", "HIVE_FAKE_AGY": capture, "HIVE_FAKE_AGY_STREAM": stream},
			}, SinkFunc(func(e Event) error { events = append(events, e); return nil }))
			if err != nil {
				t.Fatal(err)
			}
			result := lastResult(events)
			if result == nil || result.Status != map[string]string{"code": "no_changes", KindPlan: "succeeded"}[kind] || len(result.ChangedFiles) != 0 {
				t.Fatalf("result = %+v", result)
			}
			var got struct {
				Args   []string `json:"args"`
				Config string   `json:"config"`
			}
			b, err := os.ReadFile(capture)
			if err != nil || json.Unmarshal(b, &got) != nil {
				t.Fatalf("agy giả không chạy: %s, %v", b, err)
			}
			if !strings.Contains(got.Config, "Bearer run-secret") {
				t.Fatalf("agy không thấy cấu hình MCP: %q", got.Config)
			}
			if !slices.Contains(got.Args, "--print-timeout") || !slices.Contains(got.Args, "gemini-3.8-flash-high") || slices.Contains(got.Args, "--sandbox") != (kind == KindPlan) {
				t.Fatalf("args = %q", got.Args)
			}
			var logs strings.Builder
			var cost *Usage
			for _, e := range events {
				if e.Type == "log" {
					logs.Write(e.Data)
				}
				if e.Type == "cost" {
					cost = e.Cost
				}
			}
			if !strings.Contains(logs.String(), "[xdev-hive] antigravity nạp MCP của hub từ .agents/mcp_config.json") {
				t.Fatalf("log thiếu ghi chú MCP:\n%s", logs.String())
			}
			if strings.Contains(logs.String(), "không nộp được kết quả qua MCP") != (kind == KindPlan) {
				t.Fatalf("ghi chú run chỉ đọc:\n%s", logs.String())
			}
			if cost == nil || cost.InputTokens != 45145 || cost.OutputTokens != 1009 || cost.Model == nil {
				t.Fatalf("cost = %+v", cost)
			}
		})
	}
}

// installFakeCLI chép binary test thành lệnh name trong một thư mục riêng; TestMain chạy vai CLI đó (xem fakeAgy).
func installFakeCLI(t *testing.T, name string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	bin := t.TempDir()
	src, err := os.Open(os.Args[0])
	if err != nil {
		t.Fatal(err)
	}
	defer src.Close()
	dst, err := os.OpenFile(filepath.Join(bin, name), os.O_CREATE|os.O_WRONLY, 0o700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(dst, src); err != nil {
		_ = dst.Close()
		t.Fatal(err)
	}
	if err := dst.Close(); err != nil {
		t.Fatal(err)
	}
	return bin
}

// fakeAgy ghi tham số và cấu hình MCP nó thấy trong worktree vào HIVE_FAKE_AGY, rồi in lại stream-json thật đã ghi.
func fakeAgy(capture string) {
	config, _ := os.ReadFile(filepath.Join(".agents", "mcp_config.json"))
	b, _ := json.Marshal(map[string]any{"args": os.Args[1:], "config": string(config)})
	if os.WriteFile(capture, b, 0o600) != nil {
		os.Exit(9)
	}
	stream, err := os.ReadFile(os.Getenv("HIVE_FAKE_AGY_STREAM"))
	if err != nil {
		os.Exit(10)
	}
	_, _ = os.Stdout.Write(stream)
	os.Exit(0)
}
