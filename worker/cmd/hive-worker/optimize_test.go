package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
)

const userClaudeSettings = `{
  "model": "opus",
  "env": {
    "MY_VAR": "1"
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit",
        "hooks": [{"type": "command", "command": "echo edited"}]
      }
    ]
  }
}
`

type optimizeEnv struct {
	home, config string
}

// fakeOptimizeEnv đặt thư mục nhà, giờ, phiên bản Claude Code và RTK của lệnh optimize vào thư mục tạm, để test không
// đụng cấu hình thật của máy. HOME và USERPROFILE cùng đặt vì Windows đọc USERPROFILE.
func fakeOptimizeEnv(t *testing.T, claudeVersion string) optimizeEnv {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	config := filepath.Join(t.TempDir(), "worker.json")
	oldHome, oldNow, oldVer, oldFind, oldRTK := optimizeHome, optimizeNow, optimizeClaudeVersion, optimizeFindRTK, optimizeReportRTK
	optimizeHome = func() (string, error) { return home, nil }
	optimizeNow = func() time.Time { return time.Date(2026, 10, 13, 3, 0, 0, 0, time.UTC) }
	optimizeClaudeVersion = func(context.Context) string { return claudeVersion }
	optimizeFindRTK = func() string { return "" }
	optimizeReportRTK = func(context.Context) ([]byte, error) { return nil, errors.New("không có rtk") }
	t.Cleanup(func() {
		optimizeHome, optimizeNow, optimizeClaudeVersion, optimizeFindRTK, optimizeReportRTK = oldHome, oldNow, oldVer, oldFind, oldRTK
	})
	return optimizeEnv{home: home, config: config}
}

func (e optimizeEnv) write(t *testing.T, rel, content string) string {
	t.Helper()
	p := filepath.Join(e.home, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// accounts ghi accounts.json cạnh file cấu hình worker, như app desktop.
func (e optimizeEnv) accounts(t *testing.T, list string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(e.config), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filepath.Dir(e.config), "accounts.json"), []byte(`{"accounts":[`+list+`]}`), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (e optimizeEnv) run(t *testing.T, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := optimizeCommand(append(args, "--config", e.config), &out, &errOut)
	return code, out.String(), errOut.String()
}

func (e optimizeEnv) ok(t *testing.T, args ...string) string {
	t.Helper()
	code, out, errOut := e.run(t, args...)
	if code != 0 {
		t.Fatalf("optimize %v thoát %d: %s", args, code, errOut)
	}
	return out
}

func decodeView(t *testing.T, out string) optimizeView {
	t.Helper()
	var v optimizeView
	if err := json.Unmarshal([]byte(out), &v); err != nil {
		t.Fatalf("không đọc được JSON: %v\n%s", err, out)
	}
	return v
}

func (v optimizeView) profile(t *testing.T, id string) optimizeProfile {
	t.Helper()
	for _, p := range v.Profiles {
		if p.ID == id {
			return p
		}
	}
	t.Fatalf("không thấy gói %s: %+v", id, v.Profiles)
	return optimizeProfile{}
}

func readFile(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// hookCommands trả lệnh của mọi hook trong một sự kiện của settings.json (dạng shell: command; dạng exec: command + args).
func hookCommands(t *testing.T, settings, event string) []string {
	t.Helper()
	var s struct {
		Hooks map[string][]struct {
			Hooks []struct {
				Command string   `json:"command"`
				Args    []string `json:"args"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(settings), &s); err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, g := range s.Hooks[event] {
		for _, h := range g.Hooks {
			out = append(out, strings.Join(append([]string{h.Command}, h.Args...), " "))
		}
	}
	return out
}

func TestOptimizeClaudeEndToEnd(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","label":"Việc","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	before := decodeView(t, e.ok(t, "status", "--json"))
	if p := before.profile(t, "claude-2"); p.Enabled || !p.Supported || p.Version != "2.1.296" {
		t.Fatalf("trước khi bật: %+v", p)
	}

	out := decodeView(t, e.ok(t, "enable", "--profile", "claude-2", "--level", "balanced", "--json"))
	if out.Result == nil || !out.Result.Changed || out.Result.Backup == "" {
		t.Fatalf("kết quả bật: %+v", out.Result)
	}
	got := readFile(t, settings)
	var parsed struct {
		Model string            `json:"model"`
		Env   map[string]string `json:"env"`
	}
	if err := json.Unmarshal([]byte(got), &parsed); err != nil {
		t.Fatalf("settings.json hỏng: %v\n%s", err, got)
	}
	if parsed.Model != "opus" || parsed.Env["MY_VAR"] != "1" {
		t.Fatalf("phải giữ phần của người dùng:\n%s", got)
	}
	if parsed.Env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] != "200000" || parsed.Env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "80" {
		t.Fatalf("thiếu biến của preset balanced:\n%s", got)
	}
	if post := hookCommands(t, got, "PostToolUse"); len(post) != 2 || post[0] != "echo edited" || !strings.Contains(post[1], "hook post-tool --local") {
		t.Fatalf("hook post-tool: %v", post)
	}
	if pre := hookCommands(t, got, "PreToolUse"); len(pre) != 1 || !strings.Contains(pre[0], "hook pre-tool --local") {
		t.Fatalf("hook pre-tool: %v", pre)
	}
	// Hook trỏ tới đường dẫn ổn định, nên liên kết phải có thật.
	if _, err := os.Stat(filepath.Join(e.home, ".xdev-hive", "bin")); err != nil {
		t.Fatalf("thiếu thư mục bin của liên kết: %v", err)
	}

	status := decodeView(t, e.ok(t, "status", "--json"))
	p := status.profile(t, "claude-2")
	if !p.Enabled || p.Level != "balanced" || p.Modified || p.EnabledAt == nil || !p.InAccounts {
		t.Fatalf("sau khi bật: %+v", p)
	}
	if len(p.Keys) == 0 || len(p.Backups) != 1 {
		t.Fatalf("manifest thiếu khoá hay sao lưu: %+v", p)
	}
	if _, err := os.Stat(status.StatePath); err != nil {
		t.Fatalf("manifest không có ở %s: %v", status.StatePath, err)
	}

	after := decodeView(t, e.ok(t, "disable", "--profile", "claude-2", "--json"))
	if after.Result == nil || !after.Result.Changed {
		t.Fatalf("kết quả tắt: %+v", after.Result)
	}
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatalf("tắt phải trả file về nguyên bản:\n%s", got)
	}
	if p := after.profile(t, "claude-2"); p.Enabled {
		t.Fatalf("vẫn báo đang bật: %+v", p)
	}
}

func TestOptimizeAggressiveAndLevelChange(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-2","label":"Việc","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	e.ok(t, "enable", "--profile", "claude-2", "--level", "aggressive")
	if got := readFile(t, settings); !strings.Contains(got, `"CLAUDE_CODE_SUBAGENT_MODEL"`) || !strings.Contains(got, `"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "70"`) {
		t.Fatalf("thiếu biến mức aggressive:\n%s", got)
	}
	e.ok(t, "enable", "--profile", "claude-2", "--level", "balanced")
	if got := readFile(t, settings); strings.Contains(got, "CLAUDE_CODE_SUBAGENT_MODEL") {
		t.Fatalf("đổi về balanced phải bỏ biến của aggressive:\n%s", got)
	}
	if got := decodeView(t, e.ok(t, "status", "--json")).profile(t, "claude-2").Level; got != "balanced" {
		t.Fatalf("mức: %s", got)
	}
}

func TestOptimizeOldClaudeSkipsGatedKeys(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.200")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	view := decodeView(t, e.ok(t, "enable", "--profile", "claude-2", "--level", "aggressive", "--json"))
	p := view.profile(t, "claude-2")
	skipped := map[string]string{}
	for _, s := range p.Skipped {
		skipped[s.Key] = s.Reason
	}
	for _, key := range []string{"post-tool", "hook-args"} {
		if !strings.Contains(skipped[key], "2.1.296") {
			t.Fatalf("thiếu lý do bỏ %s: %v", key, p.Skipped)
		}
	}
	if got := readFile(t, settings); strings.Contains(got, "post-tool") {
		t.Fatalf("CLI cũ không được cài hook post-tool:\n%s", got)
	}
}

func TestOptimizeCodex(t *testing.T) {
	e := fakeOptimizeEnv(t, "")
	config := e.write(t, ".xdev-hive/accounts/codex-1/config.toml", "model = \"gpt-5\"\n")
	e.accounts(t, `{"id":"codex-1","cli":"codex","configDir":"~/.xdev-hive/accounts/codex-1"}`)

	e.ok(t, "enable", "--profile", "codex-1")
	got := readFile(t, config)
	for _, want := range []string{"# >>> xdev-hive optimizer >>>", "tool_output_token_limit = 8000", "model_auto_compact_token_limit = 150000", "model = \"gpt-5\""} {
		if !strings.Contains(got, want) {
			t.Fatalf("thiếu %q:\n%s", want, got)
		}
	}
	e.ok(t, "disable", "--profile", "codex-1")
	if got := readFile(t, config); got != "model = \"gpt-5\"\n" {
		t.Fatalf("tắt phải xoá đúng khối của Hive:\n%s", got)
	}
}

func TestOptimizeDefaultDirectoryNeedsExplicitProfile(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".claude/settings.json", userClaudeSettings)
	e.accounts(t, "")

	// Thư mục mặc định gọi bằng tên CLI; chỉ bật khi người dùng chọn riêng, nên --profile claude là đủ.
	e.ok(t, "enable", "--profile", "claude")
	if !strings.Contains(readFile(t, settings), "CLAUDE_CODE_AUTO_COMPACT_WINDOW") {
		t.Fatal("chưa bật cho ~/.claude")
	}
	e.ok(t, "disable", "--profile", "claude")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatalf("tắt phải trả file về nguyên bản:\n%s", got)
	}
}

func TestOptimizeRestoreBackup(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	e.ok(t, "enable", "--profile", "claude-2")
	// Người dùng sửa file sau khi bật: khôi phục vẫn đưa về bản trước lần bật đầu.
	if err := os.WriteFile(settings, []byte(`{"model":"sonnet"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	view := decodeView(t, e.ok(t, "status", "--json"))
	if !view.profile(t, "claude-2").Modified {
		t.Fatal("phải báo file đã bị sửa")
	}
	e.ok(t, "restore", "--profile", "claude-2")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatalf("khôi phục:\n%s", got)
	}
	if decodeView(t, e.ok(t, "status", "--json")).profile(t, "claude-2").Enabled {
		t.Fatal("khôi phục bản trước lần bật thì gói coi như đã tắt")
	}
}

func TestOptimizeRTK(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	// Windows báo "chưa hỗ trợ" trước khi tìm rtk: cài rtk cũng không giúp được người dùng ở đó.
	wantErr := "không thấy rtk"
	if runtime.GOOS == "windows" {
		wantErr = "chưa hỗ trợ trên Windows"
	}
	if code, _, errOut := e.run(t, "enable", "--profile", "claude-2", "--rtk"); code != 1 || !strings.Contains(errOut, wantErr) {
		t.Fatalf("không có rtk phải báo lỗi rõ (%q): %d %q", wantErr, code, errOut)
	}
	if got := readFile(t, settings); got != "{}\n" {
		t.Fatalf("lỗi không được ghi gì:\n%s", got)
	}
	if runtime.GOOS == "windows" {
		t.Skip("script sh giả chỉ chạy trên Unix")
	}

	bin := t.TempDir()
	rtk := filepath.Join(bin, "rtk")
	script := "#!/bin/sh\ncat >/dev/null\nprintf '%s' '{\"hookSpecificOutput\":{\"updatedInput\":{\"command\":\"rtk git status\"}}}'\n"
	if err := os.WriteFile(rtk, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	optimizeFindRTK = func() string { return rtk }
	view := decodeView(t, e.ok(t, "enable", "--profile", "claude-2", "--rtk", "--json"))
	if !view.profile(t, "claude-2").RTK {
		t.Fatalf("status phải báo có RTK: %+v", view.profile(t, "claude-2"))
	}
	got := readFile(t, settings)
	if pre := hookCommands(t, got, "PreToolUse"); len(pre) != 2 || !strings.Contains(strings.Join(pre, "\n"), rtk+" hook claude") {
		t.Fatalf("hook RTK: %v", pre)
	}
	if !strings.Contains(got, "RTK_TELEMETRY_DISABLED") {
		t.Fatalf("phải tắt telemetry của RTK:\n%s", got)
	}

	// Bật lại không kèm --rtk thì gỡ hook RTK.
	e.ok(t, "enable", "--profile", "claude-2")
	if got := readFile(t, settings); strings.Contains(got, "rtk") {
		t.Fatalf("bật lại không có --rtk phải gỡ RTK:\n%s", got)
	}

	// Hook RTK viết lại sai thì không được bật: hook hỏng làm sai mọi lệnh Bash.
	if err := os.WriteFile(rtk, []byte("#!/bin/sh\ncat >/dev/null\nprintf '{}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := e.run(t, "enable", "--profile", "claude-2", "--rtk"); code != 1 || !strings.Contains(errOut, "không bật") {
		t.Fatalf("hook RTK sai phải bị từ chối: %d %q", code, errOut)
	}
}

func TestOptimizeErrorsAreVietnamese(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	e.write(t, ".gemini/settings.json", "{}")
	e.accounts(t, `{"id":"gemini-1","cli":"gemini","configDir":"~/.gemini"}`)

	view := decodeView(t, e.ok(t, "status", "--json"))
	if p := view.profile(t, "gemini-1"); p.Supported || p.Reason == "" {
		t.Fatalf("Gemini phải báo chưa hỗ trợ: %+v", p)
	}
	for _, tc := range []struct {
		args []string
		code int
		want string
	}{
		{[]string{"enable", "--profile", "gemini-1"}, 1, "chưa hỗ trợ"},
		{[]string{"enable", "--profile", "nope"}, 1, `không thấy gói "nope"`},
		{[]string{"enable"}, 2, "Cách dùng"},
		{[]string{"enable", "--profile", "claude", "--level", "max"}, 1, "balanced hoặc aggressive"},
		{[]string{"bogus"}, 2, "Cách dùng"},
	} {
		code, _, errOut := e.run(t, tc.args...)
		if code != tc.code || !strings.Contains(errOut, tc.want) {
			t.Errorf("optimize %v: thoát %d, stderr %q; muốn %d chứa %q", tc.args, code, errOut, tc.code, tc.want)
		}
	}
}

func TestOptimizeDisableWhenNotEnabledKeepsFile(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".claude/settings.json", userClaudeSettings)
	e.accounts(t, "")
	e.ok(t, "disable", "--profile", "claude")
	// Gói optimizer ghi lại file qua cây JSON khi manifest không có gói (để gỡ được dấu vết sau khi mất manifest), nên
	// chỉ so nội dung, không so từng byte.
	var want, got any
	if err := json.Unmarshal([]byte(userClaudeSettings), &want); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(readFile(t, settings)), &got); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("tắt gói chưa bật không được đổi nội dung: %v", got)
	}
}

func TestOptimizeBrokenConfigUntouched(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", `{"model": `)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	if code, _, errOut := e.run(t, "enable", "--profile", "claude-2"); code != 1 || !strings.Contains(errOut, "file cấu hình hỏng") {
		t.Fatalf("thoát %d: %q", code, errOut)
	}
	if got := readFile(t, settings); got != `{"model": ` {
		t.Fatalf("file hỏng không được đụng tới: %q", got)
	}
}

func TestOptimizeDisableOrphanedProfile(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	e.ok(t, "enable", "--profile", "claude-2")

	// Người dùng xoá gói khỏi accounts.json: manifest vẫn nhớ, để tắt được và trả cấu hình.
	e.accounts(t, "")
	p := decodeView(t, e.ok(t, "status", "--json")).profile(t, "claude-2")
	if p.InAccounts || !p.Enabled {
		t.Fatalf("gói mồ côi: %+v", p)
	}
	e.ok(t, "disable", "--profile", "claude-2")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatalf("tắt gói mồ côi:\n%s", got)
	}
}

func TestOptimizeLink(t *testing.T) {
	e := fakeOptimizeEnv(t, "")
	var out struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal([]byte(e.ok(t, "link", "--json")), &out); err != nil {
		t.Fatal(err)
	}
	if want := filepath.Join(e.home, ".xdev-hive", "bin"); filepath.Dir(out.Path) != want {
		t.Fatalf("liên kết ở %s, muốn trong %s", out.Path, want)
	}
	if _, err := os.Stat(out.Path); err != nil {
		t.Fatalf("liên kết không dùng được: %v", err)
	}
}

func TestOptimizeLinkBundle(t *testing.T) {
	for _, action := range []string{"link", "enable"} {
		for _, withHive := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/hive=%t", action, withHive), func(t *testing.T) {
				e := fakeOptimizeEnv(t, "2.1.296")
				name := "hive"
				if runtime.GOOS == "windows" {
					name += ".exe"
				}
				worker := e.write(t, "bundle/hive-worker", "worker")
				if withHive {
					e.write(t, filepath.Join("bundle", name), "hive")
				}
				old := optimizeExecutable
				optimizeExecutable = func() (string, error) { return worker, nil }
				t.Cleanup(func() { optimizeExecutable = old })
				args := []string{action, "--json"}
				if action == "enable" {
					e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{}")
					e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
					args = append(args, "--profile", "claude-2")
				}
				for range 2 {
					e.ok(t, args...)
				}
				o := optimizer.New(e.home)
				if got := readFile(t, o.LinkPath()); got != "worker" {
					t.Fatalf("worker: %q", got)
				}
				dest := filepath.Join(filepath.Dir(o.LinkPath()), name)
				if withHive {
					if got := readFile(t, dest); got != "hive" {
						t.Fatalf("hive: %q", got)
					}
				} else if _, err := os.Lstat(dest); !os.IsNotExist(err) {
					t.Fatalf("bundle không có hive: %v", err)
				}
			})
		}
	}
}

func TestOptimizeLinkFromSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink cần quyền riêng trên Windows")
	}
	e := fakeOptimizeEnv(t, "")
	worker := e.write(t, "bundle/hive-worker", "worker")
	e.write(t, "bundle/hive", "hive")
	o := optimizer.New(e.home)
	if _, err := o.Link(worker, ""); err != nil {
		t.Fatal(err)
	}
	old := optimizeExecutable
	optimizeExecutable = func() (string, error) { return o.LinkPath(), nil }
	t.Cleanup(func() { optimizeExecutable = old })
	e.ok(t, "link", "--json")
	if got := readFile(t, filepath.Join(filepath.Dir(o.LinkPath()), "hive")); got != "hive" {
		t.Fatalf("không tìm được hive trong bundle thật: %q", got)
	}
}

func claudeTranscript(ts string) string {
	return `{"type":"user","timestamp":"` + ts + `","cwd":"/Users/u/proj","entrypoint":"cli","version":"2.1.296","message":{"role":"user","content":"xin chào"}}` + "\n" +
		`{"type":"assistant","timestamp":"` + ts + `","message":{"id":"m1","model":"claude-opus-5-5","usage":{"input_tokens":10,"output_tokens":20,"cache_read_input_tokens":3000,"cache_creation_input_tokens":0},"content":[{"type":"text","text":"chào"}]}}` + "\n"
}

func TestOptimizeReportSplitsAtEnableTime(t *testing.T) {
	e := fakeOptimizeEnv(t, "2.1.296")
	e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{}\n")
	e.write(t, ".xdev-hive/accounts/claude-2/projects/-p/old.jsonl", claudeTranscript("2026-10-12T08:00:00Z"))
	e.write(t, ".xdev-hive/accounts/claude-2/projects/-p/new.jsonl", claudeTranscript("2026-10-14T08:00:00Z"))
	e.write(t, ".xdev-hive/accounts/claude-3/projects/-p/other.jsonl", claudeTranscript("2026-10-14T09:00:00Z"))
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"},`+
		`{"id":"claude-3","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-3"}`)

	// Chưa bật thì không có mốc để chia.
	var rep struct {
		Sessions int `json:"sessions"`
		Split    *struct {
			Cutoff         string `json:"cutoff"`
			SessionsBefore int    `json:"sessionsBefore"`
			SessionsAfter  int    `json:"sessionsAfter"`
		} `json:"split"`
	}
	if err := json.Unmarshal([]byte(e.ok(t, "report", "--profile", "claude-2", "--json")), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Sessions != 2 || rep.Split != nil {
		t.Fatalf("chưa bật: %+v", rep)
	}

	e.ok(t, "enable", "--profile", "claude-2")
	rep.Split = nil
	if err := json.Unmarshal([]byte(e.ok(t, "report", "--profile", "claude-2", "--json")), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Sessions != 2 {
		t.Fatalf("--profile phải lọc theo gói, còn %d phiên", rep.Sessions)
	}
	if rep.Split == nil || rep.Split.SessionsBefore != 1 || rep.Split.SessionsAfter != 1 || rep.Split.Cutoff != "2026-10-13T03:00:00Z" {
		t.Fatalf("mốc lấy từ manifest: %+v", rep.Split)
	}

	// Không chọn gói thì tính mọi gói; mốc là lần bật đầu tiên của máy.
	if err := json.Unmarshal([]byte(e.ok(t, "report", "--json")), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Sessions != 3 {
		t.Fatalf("mọi gói: %d phiên", rep.Sessions)
	}

	// --days dùng mtime file; file test vừa ghi nên 1 ngày vẫn thấy đủ.
	if err := json.Unmarshal([]byte(e.ok(t, "report", "--profile", "claude-2", "--days", "1", "--json")), &rep); err != nil {
		t.Fatal(err)
	}
	if rep.Sessions != 2 {
		t.Fatalf("--days 1: %d phiên", rep.Sessions)
	}
	if text := e.ok(t, "report", "--profile", "claude-2"); !strings.Contains(text, "Báo cáo token: 2 phiên") {
		t.Fatalf("báo cáo dạng chữ:\n%s", text)
	}
	if code, _, errOut := e.run(t, "report", "--days", "-1"); code != 1 || !strings.Contains(errOut, "--days") {
		t.Fatalf("--days âm: %d %q", code, errOut)
	}
}
