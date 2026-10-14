package optimizer

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// fakeHome dựng HOME giả; đặt cả USERPROFILE để Windows không chạm vào thư mục thật của người chạy test.
func fakeHome(t *testing.T) (*Optimizer, string) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	o := New(home)
	tick := time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)
	o.Now = func() time.Time { tick = tick.Add(time.Second); return tick }
	return o, home
}

func profile(t *testing.T, o *Optimizer, id string) Profile {
	t.Helper()
	p, err := o.Profile(id, "", "~/.xdev-hive/accounts/"+id)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	return p
}

func preset(pct string) Preset {
	return Preset{
		Env: map[string]string{
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW": "200000",
			"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": pct,
			"BASH_MAX_OUTPUT_LENGTH":          "15000",
		},
		Codex: map[string]string{"tool_output_token_limit": "8000", "model_auto_compact_token_limit": "150000"},
		Hooks: []Hook{
			{Event: "PostToolUse", Matcher: "Bash|Grep|mcp__.*", Args: []string{"hook", "post-tool", "--local"}},
			{Event: "PreToolUse", Matcher: "Bash|Read", Args: []string{"hook", "pre-tool", "--local"}},
		},
	}
}

const userSettings = `{
  "theme": "dark",
  "permissions": {
    "allow": [
      "Bash(git status:*)"
    ]
  },
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "prettier --write <file>&"
          }
        ]
      }
    ]
  },
  "model": "opus"
}
`

func write(t *testing.T, path, s string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readString(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func settingsOf(t *testing.T, path string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(readString(t, path)), &m); err != nil {
		t.Fatalf("settings.json sau khi ghi không phải JSON: %v", err)
	}
	return m
}

// hookCommands là mọi hook của một sự kiện, dạng "command args…".
func hookCommands(m map[string]any, event string) []string {
	hooks, _ := m["hooks"].(map[string]any)
	list, _ := hooks[event].([]any)
	var out []string
	for _, g := range list {
		inner, _ := g.(map[string]any)["hooks"].([]any)
		for _, h := range inner {
			hm := h.(map[string]any)
			s := hm["command"].(string)
			if args, ok := hm["args"].([]any); ok {
				for _, a := range args {
					s += " " + a.(string)
				}
			}
			out = append(out, s)
		}
	}
	return out
}

func TestClaudeEnableThenDisableIsByteExact(t *testing.T) {
	cases := map[string]string{
		"two spaces":         userSettings,
		"tabs, no newline":   "{\n\t\"theme\": \"light\",\n\t\"env\": {\n\t\t\"FOO\": \"1\"\n\t}\n}",
		"compact":            `{"theme":"dark","hooks":{}}`,
		"empty object":       "{}\n",
		"unicode and number": "{\n    \"statusLine\": \"<b>Tiếng Việt</b>\",\n    \"cleanupPeriodDays\": 1.50\n}\n",
	}
	for name, original := range cases {
		t.Run(name, func(t *testing.T) {
			o, _ := fakeHome(t)
			p := profile(t, o, "claude-2")
			path := filepath.Join(p.Dir, "settings.json")
			write(t, path, original)

			res, err := o.Enable(p, "balanced", preset("80"), Options{})
			if err != nil {
				t.Fatal(err)
			}
			if !res.Changed || res.Backup == "" {
				t.Fatalf("bật phải ghi và sao lưu: %+v", res)
			}
			if got := readString(t, filepath.Join(o.backupDir(p.ID), res.Backup+".json")); got != original {
				t.Fatalf("bản sao lưu khác file gốc:\n%s", got)
			}
			m := settingsOf(t, path)
			env := m["env"].(map[string]any)
			if env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] != "200000" || env["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "80" {
				t.Fatalf("thiếu env: %v", env)
			}
			post := hookCommands(m, "PostToolUse")
			if !strings.Contains(strings.Join(post, "\n"), o.LinkPath()+" hook post-tool --local") {
				t.Fatalf("thiếu hook post-tool: %v", post)
			}

			res, err = o.Disable(p)
			if err != nil {
				t.Fatal(err)
			}
			if got := readString(t, path); got != original {
				t.Fatalf("tắt không trả về đúng file gốc:\n%q\nmong đợi\n%q", got, original)
			}
			if len(res.Warnings) != 0 {
				t.Fatalf("không có gì để cảnh báo: %v", res.Warnings)
			}
			st, _ := o.Status()
			if len(st) != 0 {
				t.Fatalf("manifest còn gói: %+v", st)
			}
		})
	}
}

func TestClaudeKeepsKeyOrderAndUserHooks(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	got := readString(t, path)
	order := []string{`"theme"`, `"permissions"`, `"hooks"`, `"model"`, `"env"`}
	last := -1
	for _, k := range order {
		i := strings.Index(got, k)
		if i < last {
			t.Fatalf("thứ tự khoá đổi, %s đứng sai chỗ:\n%s", k, got)
		}
		last = i
	}
	if !strings.Contains(got, `"prettier --write <file>&"`) {
		t.Fatalf("hook của người dùng bị đổi (hoặc bị thoát ký tự HTML):\n%s", got)
	}
	post := hookCommands(settingsOf(t, path), "PostToolUse")
	if len(post) != 2 || post[0] != "prettier --write <file>&" {
		t.Fatalf("hook của người dùng phải còn nguyên và đứng trước: %v", post)
	}
}

func TestClaudeFileCreatedThenRemoved(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-4")
	path := filepath.Join(p.Dir, "settings.json")
	res, err := o.Enable(p, "balanced", preset("80"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if res.Backup != "" {
		t.Fatalf("file chưa có thì không có gì để sao lưu: %q", res.Backup)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("tắt phải xoá settings.json mà Hive tạo: %v", err)
	}
}

func TestClaudeUserChangeKeptWithWarning(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	// Giữa chừng người dùng đổi một khoá Hive đặt và một khoá của mình.
	edited := strings.Replace(readString(t, path), `"BASH_MAX_OUTPUT_LENGTH": "15000"`, `"BASH_MAX_OUTPUT_LENGTH": "30000"`, 1)
	edited = strings.Replace(edited, `"theme": "dark"`, `"theme": "light"`, 1)
	write(t, path, edited)

	res, err := o.Disable(p)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Key != "env.BASH_MAX_OUTPUT_LENGTH" || res.Warnings[0].Kind != "user_changed" {
		t.Fatalf("phải cảnh báo đúng khoá người dùng đổi: %+v", res.Warnings)
	}
	want := strings.Replace(userSettings, `"theme": "dark"`, `"theme": "light"`, 1)
	want = strings.Replace(want, "\"model\": \"opus\"\n", "\"model\": \"opus\",\n  \"env\": {\n    \"BASH_MAX_OUTPUT_LENGTH\": \"30000\"\n  }\n", 1)
	if got := readString(t, path); got != want {
		t.Fatalf("chỉ được gỡ phần của Hive:\n%s\nmong đợi\n%s", got, want)
	}
}

func TestClaudeUserSetEnvNotOverwritten(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	original := "{\n  \"env\": {\n    \"BASH_MAX_OUTPUT_LENGTH\": \"50000\"\n  }\n}\n"
	write(t, path, original)
	res, err := o.Enable(p, "balanced", preset("80"), Options{})
	if err != nil {
		t.Fatal(err)
	}
	if env := settingsOf(t, path)["env"].(map[string]any); env["BASH_MAX_OUTPUT_LENGTH"] != "50000" {
		t.Fatalf("giá trị người dùng bị ghi đè: %v", env)
	}
	if len(res.Warnings) != 1 || res.Warnings[0].Kind != "user_set" {
		t.Fatalf("phải báo khoá người dùng đặt: %+v", res.Warnings)
	}
	st, _ := o.Status()
	if len(st) != 1 || len(st[0].UserSet) != 1 || st[0].UserSet[0] != "BASH_MAX_OUTPUT_LENGTH" {
		t.Fatalf("manifest phải ghi khoá người dùng đặt: %+v", st)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != original {
		t.Fatalf("tắt phải giữ khoá người dùng:\n%s", got)
	}
}

func TestClaudeInvalidJSONNotWritten(t *testing.T) {
	o, home := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	broken := "{\n  \"theme\": \"dark\",\n"
	write(t, path, broken)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("JSON hỏng phải báo lỗi: %v", err)
	}
	if got := readString(t, path); got != broken {
		t.Fatal("JSON hỏng thì không được ghi")
	}
	if _, err := os.Stat(filepath.Join(home, ".xdev-hive", "optimizer", "state.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("lỗi thì không được ghi manifest")
	}
	write(t, path, `{"env": "x"}`)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatalf("env không phải object phải báo lỗi: %v", err)
	}
}

func TestDefaultProfileNeedsExplicit(t *testing.T) {
	o, home := fakeHome(t)
	p, err := o.Profile("claude", "claude", "")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Default || p.Dir != filepath.Join(home, ".claude") {
		t.Fatalf("gói mặc định: %+v", p)
	}
	if err := os.MkdirAll(p.Dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); !errors.Is(err, ErrDefaultProfile) {
		t.Fatalf("bật tất cả không được bật gói mặc định: %v", err)
	}
	if _, err := os.Stat(filepath.Join(p.Dir, "settings.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("không được ghi vào gói mặc định")
	}
	if _, err := o.Enable(p, "balanced", preset("80"), Options{Explicit: true}); err != nil {
		t.Fatal(err)
	}
	// Thư mục ghi rõ "~/.claude" cũng là gói mặc định.
	if q, _ := o.Profile("claude-main", "claude", "~/.claude"); !q.Default {
		t.Fatal("~/.claude phải là gói mặc định")
	}
}

func TestUnsupportedCLIWritesNothing(t *testing.T) {
	o, home := fakeHome(t)
	for _, id := range []string{"gemini", "antigravity"} {
		p, _ := o.Profile(id, "", filepath.Join(home, "."+id))
		if err := os.MkdirAll(p.Dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := o.Enable(p, "balanced", preset("80"), Options{Explicit: true}); !errors.Is(err, ErrUnsupported) {
			t.Fatalf("%s: %v", id, err)
		}
		if entries, _ := os.ReadDir(p.Dir); len(entries) != 0 {
			t.Fatalf("%s: không được ghi file", id)
		}
	}
	if _, err := o.Enable(profile(t, o, "claude-1"), "max", preset("80"), Options{}); !errors.Is(err, ErrInvalidLevel) {
		t.Fatalf("mức lạ: %v", err)
	}
}

func TestLevelChangeThenDisable(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	first, _ := o.Status()
	if _, err := o.Enable(p, "aggressive", preset("70"), Options{}); err != nil {
		t.Fatal(err)
	}
	m := settingsOf(t, path)
	if m["env"].(map[string]any)["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE"] != "70" {
		t.Fatalf("đổi mức không đổi env: %v", m["env"])
	}
	if post := hookCommands(m, "PostToolUse"); len(post) != 2 {
		t.Fatalf("đổi mức không được nhân đôi hook: %v", post)
	}
	st, _ := o.Status()
	if st[0].Level != "aggressive" || !st[0].EnabledAt.Equal(first[0].EnabledAt) || st[0].Backup != first[0].Backup {
		t.Fatalf("đổi mức phải giữ mốc bật và bản sao lưu gốc: %+v", st[0])
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != userSettings {
		t.Fatalf("tắt sau khi đổi mức không trả về file gốc:\n%s", got)
	}
}

func TestConcurrentWriteRetried(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)

	calls := 0
	beforeCheck = func(path string) {
		calls++
		if calls == 1 {
			// CLI đổi model đúng lúc Hive đang ghi.
			write(t, path, strings.Replace(userSettings, `"opus"`, `"sonnet"`, 1))
		}
	}
	t.Cleanup(func() { beforeCheck = nil })
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	m := settingsOf(t, path)
	if m["model"] != "sonnet" || m["env"] == nil {
		t.Fatalf("phải đọc lại và giữ thay đổi của CLI: %v", m)
	}
	if calls != 2 {
		t.Fatalf("phải thử lại đúng một lần, đã chạy %d", calls)
	}

	// File đổi liên tục: bỏ cuộc sau 3 lần, không ghi gì của Hive.
	n := 0
	beforeCheck = func(path string) {
		n++
		write(t, path, strings.Replace(userSettings, `"opus"`, `"m`+strings.Repeat("x", n)+`"`, 1))
	}
	q := profile(t, o, "claude-3")
	qpath := filepath.Join(q.Dir, "settings.json")
	write(t, qpath, userSettings)
	if _, err := o.Enable(q, "balanced", preset("80"), Options{}); !errors.Is(err, ErrBusy) {
		t.Fatalf("phải báo bận: %v", err)
	}
	if n != attempts || strings.Contains(readString(t, qpath), "CLAUDE_CODE_AUTO_COMPACT_WINDOW") {
		t.Fatalf("thử %d lần, file: %s", n, readString(t, qpath))
	}
	if entries, _ := os.ReadDir(q.Dir); len(entries) != 1 {
		t.Fatalf("còn file tạm: %v", entries)
	}
}

func TestStatusDropsDeletedProfile(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	st, err := o.Status()
	if err != nil || len(st) != 1 || st[0].Modified || st[0].ConfigDir != p.Dir || st[0].Level != "balanced" {
		t.Fatalf("status: %+v %v", st, err)
	}
	write(t, filepath.Join(p.Dir, "settings.json"), "{}")
	if st, _ := o.Status(); !st[0].Modified {
		t.Fatal("file bị sửa phải hiện Modified")
	}
	if err := os.RemoveAll(p.Dir); err != nil {
		t.Fatal(err)
	}
	if st, _ := o.Status(); len(st) != 0 {
		t.Fatalf("gói bị xoá phải ra khỏi manifest: %+v", st)
	}
	state, _ := o.loadState()
	if len(state.Profiles) != 0 {
		t.Fatal("manifest chưa được ghi lại")
	}
}

func TestRestoreOriginal(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	// Người dùng sửa thêm, rồi muốn quay lại file trước khi bật.
	write(t, path, strings.Replace(readString(t, path), `"dark"`, `"light"`, 1))
	res, err := o.Restore(p, "")
	if err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != userSettings {
		t.Fatalf("khôi phục sai:\n%s", got)
	}
	if res.Backup == "" {
		t.Fatal("khôi phục phải sao lưu file đang có")
	}
	if st, _ := o.Status(); len(st) != 0 {
		t.Fatal("khôi phục bản trước khi bật thì gói coi như đã tắt")
	}
	list, _ := o.Backups(p.ID)
	if len(list) != 2 {
		t.Fatalf("bản sao lưu: %v", list)
	}
	if _, err := o.Restore(p, "20990101T000000Z"); !errors.Is(err, ErrNoBackup) {
		t.Fatalf("bản sao lưu không có: %v", err)
	}
	if _, err := o.Restore(p, "../../x"); err == nil {
		t.Fatal("tên bản sao lưu không được trỏ ra ngoài thư mục")
	}
}

func TestDisableWithoutManifestRemovesHiveHooks(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	if _, err := o.Enable(p, "balanced", preset("80"), Options{}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(o.StatePath()); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	m := settingsOf(t, path)
	if post := hookCommands(m, "PostToolUse"); len(post) != 1 || post[0] != "prettier --write <file>&" {
		t.Fatalf("phải gỡ hook Hive, giữ hook người dùng: %v", post)
	}
	if pre := hookCommands(m, "PreToolUse"); len(pre) != 0 {
		t.Fatalf("còn hook pre-tool: %v", pre)
	}
}

func TestShellHooks(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	pr := preset("80")
	pr.ShellHooks = true
	res, err := o.Enable(p, "balanced", pr, Options{})
	if err != nil {
		t.Fatal(err)
	}
	post := hookCommands(settingsOf(t, path), "PostToolUse")
	if runtime.GOOS == "windows" {
		if len(post) != 1 || len(res.Warnings) != 2 {
			t.Fatalf("Windows bỏ hook dạng shell và báo lại: %v %+v", post, res.Warnings)
		}
	} else {
		want := "[ -x " + shellQuote(o.LinkPath()) + " ] && exec " + shellQuote(o.LinkPath()) + " hook post-tool --local || exit 0"
		if len(post) != 2 || post[1] != want {
			t.Fatalf("hook dạng shell: %v", post)
		}
	}
	if err := os.Remove(o.StatePath()); err != nil {
		t.Fatal(err)
	}
	if _, err := o.Disable(p); err != nil {
		t.Fatal(err)
	}
	if post := hookCommands(settingsOf(t, path), "PostToolUse"); len(post) != 1 {
		t.Fatalf("hook dạng shell phải nhận ra được để gỡ: %v", post)
	}
}

func TestManifestForLocalHook(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	if _, err := o.Enable(p, "aggressive", preset("70"), Options{}); err != nil {
		t.Fatal(err)
	}
	var raw struct {
		Profiles map[string]struct {
			ConfigDir string `json:"configDir"`
			Level     string `json:"level"`
		} `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(readString(t, o.StatePath())), &raw); err != nil {
		t.Fatal(err)
	}
	if e := raw.Profiles["claude-2"]; e.ConfigDir != p.Dir || e.Level != "aggressive" {
		t.Fatalf("hook cục bộ cần configDir và level: %+v", raw)
	}
}

func TestProfileRejectsBadID(t *testing.T) {
	o, _ := fakeHome(t)
	for _, id := range []string{"", "..", "a/b", `a\b`} {
		if _, err := o.Profile(id, "claude", ""); err == nil {
			t.Fatalf("%q phải bị từ chối", id)
		}
	}
}

func TestRecordedHookWithoutLocalFlagRemoved(t *testing.T) {
	o, _ := fakeHome(t)
	p := profile(t, o, "claude-2")
	path := filepath.Join(p.Dir, "settings.json")
	write(t, path, userSettings)
	pr := Preset{Hooks: []Hook{{Event: "PreToolUse", Matcher: "Bash", Command: "rtk", Args: []string{"hook", "claude"}}}}
	if _, err := o.Enable(p, "balanced", pr, Options{}); err != nil {
		t.Fatal(err)
	}
	if pre := hookCommands(settingsOf(t, path), "PreToolUse"); len(pre) != 1 || pre[0] != "rtk hook claude" {
		t.Fatalf("hook RTK: %v", pre)
	}
	// Người dùng sửa file nên tắt phải gỡ theo manifest, không chép lại bản gốc.
	write(t, path, strings.Replace(readString(t, path), `"opus"`, `"sonnet"`, 1))
	res, err := o.Disable(p)
	if err != nil {
		t.Fatal(err)
	}
	if got := readString(t, path); got != strings.Replace(userSettings, `"opus"`, `"sonnet"`, 1) {
		t.Fatalf("hook RTK phải được gỡ theo manifest:\n%s\n%+v", got, res)
	}
}
