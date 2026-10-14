package runner

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// localHome giả thư mục nhà cho hook cục bộ (cả HOME và USERPROFILE để os.UserHomeDir đúng trên Windows) và bỏ biến
// của run, để test không bao giờ ghi vào ~/.xdev-hive thật.
func localHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	t.Setenv(GuardDirEnv, "")
	t.Setenv("CLAUDE_CONFIG_DIR", "")
	return home
}

func localSession(home, sid string) string {
	return filepath.Join(home, ".xdev-hive", "optimizer", "sessions", sid)
}

// callLocal chạy `hook <sub> --local` với stdin thô, trả output đã in.
func callLocal(t *testing.T, sub string, stdin []byte) []byte {
	t.Helper()
	var out bytes.Buffer
	if code := HookMain([]string{sub, "--local"}, bytes.NewReader(stdin), &out); code != 0 {
		t.Fatalf("hook thoát %d", code)
	}
	return out.Bytes()
}

func callLocalJSON(t *testing.T, sub, sid string, input map[string]any) map[string]any {
	t.Helper()
	input["session_id"] = sid
	in, _ := json.Marshal(input)
	out := callLocal(t, sub, in)
	if len(out) == 0 {
		return nil
	}
	var reply map[string]any
	if err := json.Unmarshal(out, &reply); err != nil {
		t.Fatalf("hook in %q: %v", out, err)
	}
	return reply
}

func bigBash(cwd string, n int) map[string]any {
	return map[string]any{
		"hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_use_id": "toolu_01", "cwd": cwd,
		"tool_input":    map[string]any{"command": "go test ./..."},
		"tool_response": map[string]any{"stdout": strings.Repeat("ok  \tpkg/x\t0.1s\n", n/16+1)[:n], "stderr": "", "interrupted": false},
	}
}

func nudged(reply map[string]any) string {
	h, _ := reply["hookSpecificOutput"].(map[string]any)
	if h == nil || h["hookEventName"] != "PreToolUse" {
		return ""
	}
	if h["permissionDecision"] != nil {
		return "deny"
	}
	s, _ := h["additionalContext"].(string)
	return s
}

func readLedger(t *testing.T, dir string) []localLedgerEntry {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "ledger.jsonl"))
	if err != nil {
		return nil
	}
	var out []localLedgerEntry
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		var e localLedgerEntry
		if err := json.Unmarshal([]byte(line), &e); err != nil {
			t.Fatalf("dòng ledger %q: %v", line, err)
		}
		out = append(out, e)
	}
	return out
}

func TestLocalPostToolTruncatesIntoProject(t *testing.T) {
	home := localHome(t)
	proj := t.TempDir()
	git := false
	if _, err := exec.LookPath("git"); err == nil && exec.Command("git", "init", "-q", proj).Run() == nil {
		git = true
	}
	reply := callLocalJSON(t, "post-tool", "sess-a", bigBash(proj, 30000))
	h, _ := reply["hookSpecificOutput"].(map[string]any)
	resp, _ := h["updatedToolOutput"].(map[string]any)
	if h["hookEventName"] != "PostToolUse" || resp == nil {
		t.Fatalf("không cắt: %v", reply)
	}
	stdout, _ := resp["stdout"].(string)
	if len(stdout) > defaultToolOutputMaxChars || resp["interrupted"] != false {
		t.Fatalf("stdout %d ký tự, resp %v", len(stdout), resp)
	}
	full := filepath.Join(proj, ".claude", ".hive-out", "sess-a", "toolu_01.txt")
	if b, err := os.ReadFile(full); err != nil || len(b) < 30000 {
		t.Fatalf("file đầy đủ %s: %d byte, %v", full, len(b), err)
	}
	if !strings.Contains(stdout, full) {
		t.Fatalf("output không trỏ tới file đầy đủ:\n%s", stdout)
	}
	if b, _ := os.ReadFile(filepath.Join(proj, ".claude", ".hive-out", ".gitignore")); string(b) != "*\n" {
		t.Fatalf(".gitignore: %q", b)
	}
	if git {
		b, _ := os.ReadFile(filepath.Join(proj, ".git", "info", "exclude"))
		if !strings.Contains(string(b), "/.claude/.hive-out/") {
			t.Fatalf("exclude thiếu .hive-out: %q", b)
		}
		st, _ := exec.Command("git", "-C", proj, "status", "--porcelain", "--untracked-files=all").Output()
		if strings.Contains(string(st), ".hive-out") {
			t.Fatalf("git status thấy output: %s", st)
		}
	}
	led := readLedger(t, localSession(home, "sess-a"))
	if len(led) != 1 || led[0].Tool != "Bash" || led[0].Before != 30000 || led[0].After <= 0 || led[0].After >= led[0].Before || led[0].TS == "" {
		t.Fatalf("ledger: %+v", led)
	}
	if st := readState(t, localSession(home, "sess-a")); st.Truncated != 1 || st.TruncatedChars != int64(led[0].Before-led[0].After) {
		t.Fatalf("state: %+v", st)
	}
	// Không có nội dung lệnh hay output trong ledger.
	if b, _ := os.ReadFile(filepath.Join(localSession(home, "sess-a"), "ledger.jsonl")); strings.Contains(string(b), "pkg/x") {
		t.Fatalf("ledger chứa nội dung: %s", b)
	}
}

func TestLocalPostToolFallsBackToSessionDir(t *testing.T) {
	home := localHome(t)
	// cwd không tồn tại thay cho thư mục không ghi được: chạy được cả trên Windows, không dựa vào quyền file.
	cwd := filepath.Join(t.TempDir(), "gone")
	reply := callLocalJSON(t, "post-tool", "sess-b", bigBash(cwd, 20000))
	if reply == nil {
		t.Fatal("không cắt")
	}
	full := filepath.Join(localSession(home, "sess-b"), "out", "toolu_01.txt")
	if _, err := os.Stat(full); err != nil {
		t.Fatalf("không có file đầy đủ trong thư mục phiên: %v", err)
	}
	// Thư mục nhà không phải dự án: không ghi vào ~/.claude.
	callLocalJSON(t, "post-tool", "sess-b", bigBash(home, 20000))
	if _, err := os.Stat(filepath.Join(home, ".claude", ".hive-out")); !os.IsNotExist(err) {
		t.Fatalf("đã ghi vào ~/.claude: %v", err)
	}
}

func TestLocalPostToolLeavesShortOutput(t *testing.T) {
	home := localHome(t)
	if reply := callLocalJSON(t, "post-tool", "s", bigBash(t.TempDir(), 2000)); reply != nil {
		t.Fatalf("output ngắn bị sửa: %v", reply)
	}
	if led := readLedger(t, localSession(home, "s")); led != nil {
		t.Fatalf("ledger có dòng: %+v", led)
	}
}

func TestLocalPreToolOnlyNudges(t *testing.T) {
	home := localHome(t)
	cwd := t.TempDir()
	big := filepath.Join(cwd, "big.txt")
	if err := os.WriteFile(big, []byte(strings.Repeat("x\n", bigFileLines+10)), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := func(c string) map[string]any { b := bash(c); b["cwd"] = cwd; return b }
	var msgs []string
	for i := 0; i < defaultExploreBudget+3; i++ {
		r := callLocalJSON(t, "pre-tool", "s1", cmd("rg TODO"))
		if m := nudged(r); m == "deny" {
			t.Fatalf("hook cục bộ đã chặn: %v", r)
		} else if m != "" {
			msgs = append(msgs, m)
		}
	}
	if len(msgs) != 1 || !strings.Contains(msgs[0], "Read có offset/limit") {
		t.Fatalf("muốn nhắc đúng một lần: %q", msgs)
	}
	if m := nudged(callLocalJSON(t, "pre-tool", "s1", cmd("cat big.txt"))); m == "deny" || !strings.Contains(m, "big.txt") {
		t.Fatalf("cat file lớn: %q", m)
	}
	if st := readState(t, localSession(home, "s1")); st.Explore != defaultExploreBudget+3 || st.Blocked != 2 {
		t.Fatalf("state: %+v", st)
	}
}

func TestLocalSessionsHaveSeparateState(t *testing.T) {
	home := localHome(t)
	for i := 0; i < 3; i++ {
		callLocalJSON(t, "pre-tool", "one", bash("find . -name x"))
	}
	callLocalJSON(t, "pre-tool", "two", map[string]any{"tool_name": "Edit", "tool_input": map[string]any{}})
	callLocalJSON(t, "pre-tool", "two", bash("find . -name x"))
	if st := readState(t, localSession(home, "one")); st.Explore != 3 || st.Edited {
		t.Fatalf("one: %+v", st)
	}
	if st := readState(t, localSession(home, "two")); st.Explore != 0 || !st.Edited {
		t.Fatalf("two: %+v", st)
	}
}

func TestLocalHookFailsOpen(t *testing.T) {
	home := localHome(t)
	for _, in := range []string{"{not json", "", `{"tool_name":"Bash"}`, `{"session_id":"../.."}`, `{"session_id":"///"}`} {
		for _, sub := range []string{"pre-tool", "post-tool", "unknown"} {
			if out := callLocal(t, sub, []byte(in)); len(out) != 0 {
				t.Fatalf("%s %q in %q", sub, in, out)
			}
		}
	}
	if entries, _ := os.ReadDir(filepath.Join(home, ".xdev-hive", "optimizer", "sessions")); len(entries) != 0 {
		t.Fatalf("tạo thư mục phiên từ id rác: %v", entries)
	}
	// Thư mục dữ liệu là file: không tạo được thư mục phiên, vẫn thoát 0.
	if err := os.WriteFile(filepath.Join(home, ".xdev-hive"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if out := callLocal(t, "post-tool", mustJSON(map[string]any{"session_id": "x", "tool_name": "Bash", "tool_response": map[string]any{"stdout": strings.Repeat("a", 30000)}})); len(out) != 0 {
		t.Fatalf("in %q", out)
	}
}

func TestLocalHookSkipsInsideRun(t *testing.T) {
	localHome(t)
	t.Setenv(GuardDirEnv, t.TempDir())
	if out := callLocal(t, "post-tool", mustJSON(bigBash(t.TempDir(), 30000))); len(out) != 0 {
		t.Fatalf("hook cục bộ chạy trong run: %q", out)
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

func writeManifest(t *testing.T, home, body string) {
	t.Helper()
	p := filepath.Join(home, ".xdev-hive", "optimizer", "state.json")
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestLocalConfigFromManifestByProfile(t *testing.T) {
	home := localHome(t)
	writeManifest(t, home, `{"version":1,"profiles":{
		"claude-2":{"cli":"claude","level":"aggressive","toolOutputMaxChars":5000,"extra":{"x":1}},
		"claude-3":{"level":"balanced","toolOutputMaxChars":0}}}`)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".xdev-hive", "accounts", "claude-2"))
	reply := callLocalJSON(t, "post-tool", "p2", bigBash(t.TempDir(), 8000))
	if reply == nil {
		t.Fatal("gói claude-2 đặt cắt ở 5000 mà output 8000 không bị cắt")
	}
	var cfg localConfig
	b, _ := os.ReadFile(filepath.Join(localSession(home, "p2"), "config.json"))
	if json.Unmarshal(b, &cfg) != nil || cfg.Level != "aggressive" || cfg.MaxChars != 5000 || cfg.ExploreBudget != defaultExploreBudget {
		t.Fatalf("config phiên: %s", b)
	}
	// Đổi manifest giữa phiên không đổi cấu hình phiên đang chạy.
	writeManifest(t, home, `{"profiles":{"claude-2":{"toolOutputMaxChars":0}}}`)
	if callLocalJSON(t, "post-tool", "p2", bigBash(t.TempDir(), 8000)) == nil {
		t.Fatal("phiên đọc lại manifest")
	}

	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(home, ".xdev-hive", "accounts", "claude-3"))
	writeManifest(t, home, `{"profiles":{"claude-3":{"toolOutputMaxChars":0}}}`)
	if r := callLocalJSON(t, "post-tool", "p3", bigBash(t.TempDir(), 30000)); r != nil {
		t.Fatalf("gói tắt cắt output vẫn cắt: %v", r)
	}
}

func TestLocalConfigManifestShapes(t *testing.T) {
	home := localHome(t)
	acc := filepath.Join(home, ".xdev-hive", "accounts", "claude-4")
	writeManifest(t, home, `{"profiles":[{"id":"claude-1","toolOutputMaxChars":1},{"profile":"x","configDir":"`+filepath.ToSlash(acc)+`","level":"aggressive","exploreBudget":9}]}`)
	cases := []struct {
		name, configDir string
		ok              bool
		budget          int
	}{
		{"configDir khớp", acc, true, 9},
		{"id theo tên thư mục", filepath.Join(home, "elsewhere", "claude-1"), true, defaultExploreBudget},
		{"không có gói", filepath.Join(home, "nope"), false, 0},
	}
	for _, c := range cases {
		p, ok := manifestProfile(filepath.Join(home, ".xdev-hive", "optimizer", "state.json"), c.configDir, home)
		if ok != c.ok {
			t.Fatalf("%s: ok=%v", c.name, ok)
		}
		if ok && c.budget != defaultExploreBudget && (p.ExploreBudget == nil || *p.ExploreBudget != c.budget) {
			t.Fatalf("%s: %+v", c.name, p)
		}
	}
	// Không có manifest, hay manifest hỏng: mặc định balanced.
	for _, body := range []string{"", "{oops", `{"profiles":"x"}`} {
		if body != "" {
			writeManifest(t, home, body)
		} else {
			_ = os.Remove(filepath.Join(home, ".xdev-hive", "optimizer", "state.json"))
		}
		dir := t.TempDir()
		cfg := loadLocalConfig(filepath.Join(home, ".xdev-hive", "optimizer"), dir, home)
		if cfg.Level != "balanced" || cfg.MaxChars != defaultToolOutputMaxChars || cfg.ExploreBudget != defaultExploreBudget {
			t.Fatalf("manifest %q: %+v", body, cfg)
		}
	}
}

func TestLocalCleanupRemovesOldSessions(t *testing.T) {
	home := localHome(t)
	proj := t.TempDir()
	callLocalJSON(t, "post-tool", "old", bigBash(proj, 30000))
	callLocalJSON(t, "pre-tool", "recent", bash("ls"))
	oldOut := filepath.Join(proj, ".claude", ".hive-out", "old")
	if _, err := os.Stat(oldOut); err != nil {
		t.Fatal(err)
	}
	sessions := filepath.Join(home, ".xdev-hive", "optimizer", "sessions")
	past := time.Now().Add(-8 * 24 * time.Hour)
	for _, p := range []string{filepath.Join(sessions, "old", "ledger.jsonl"), filepath.Join(sessions, "old"), filepath.Join(sessions, ".cleanup")} {
		if err := os.Chtimes(p, past, past); err != nil {
			t.Fatal(err)
		}
	}
	callLocalJSON(t, "pre-tool", "new", bash("ls"))
	if _, err := os.Stat(filepath.Join(sessions, "old")); !os.IsNotExist(err) {
		t.Fatalf("phiên cũ còn: %v", err)
	}
	if _, err := os.Stat(oldOut); !os.IsNotExist(err) {
		t.Fatalf("output của phiên cũ còn: %v", err)
	}
	if _, err := os.Stat(filepath.Join(sessions, "recent")); err != nil {
		t.Fatalf("phiên mới bị xoá: %v", err)
	}
	// Đã dọn hôm nay: phiên vừa quá hạn chưa bị xoá tới lần dọn sau.
	if err := os.Chtimes(filepath.Join(sessions, "recent"), past, past); err != nil {
		t.Fatal(err)
	}
	callLocalJSON(t, "pre-tool", "new", bash("ls"))
	if _, err := os.Stat(filepath.Join(sessions, "recent")); err != nil {
		t.Fatalf("dọn hai lần trong ngày: %v", err)
	}
}

func TestLocalCleanupSkipsWhenLocked(t *testing.T) {
	sessions := t.TempDir()
	old := filepath.Join(sessions, "old")
	if err := os.MkdirAll(old, 0o700); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-8 * 24 * time.Hour)
	_ = os.Chtimes(old, past, past)
	f, err := os.OpenFile(filepath.Join(sessions, ".cleanup.lock"), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := tryLockFile(f); !ok || err != nil {
		t.Fatalf("khoá: %v %v", ok, err)
	}
	cleanupLocalSessions(sessions, "cur", time.Now())
	if _, err := os.Stat(old); err != nil {
		t.Fatalf("dọn khi phiên khác giữ khoá: %v", err)
	}
	_ = unlockFile(f)
	_ = f.Close()
	cleanupLocalSessions(sessions, "cur", time.Now())
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("không dọn sau khi nhả khoá: %v", err)
	}
}

// Hook chạy ở mỗi lượt tool của người dùng nên phải nhanh: phần trong tiến trình dưới 50 ms cho output 30k.
func TestLocalPostToolIsFast(t *testing.T) {
	if testing.Short() {
		t.Skip("đo thời gian")
	}
	localHome(t)
	proj := t.TempDir()
	in := bigBash(proj, 30000)
	in["session_id"] = "fast"
	stdin := mustJSON(in)
	callLocal(t, "post-tool", stdin)
	const n = 10
	start := time.Now()
	for i := 0; i < n; i++ {
		callLocal(t, "post-tool", stdin)
	}
	if avg := time.Since(start) / n; avg > 50*time.Millisecond {
		t.Fatalf("post-tool trung bình %v", avg)
	}
}

func BenchmarkLocalPostTool(b *testing.B) {
	home := b.TempDir()
	b.Setenv("HOME", home)
	b.Setenv("USERPROFILE", home)
	b.Setenv(GuardDirEnv, "")
	in := bigBash(b.TempDir(), 30000)
	in["session_id"] = "bench"
	stdin := mustJSON(in)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		HookMain([]string{"post-tool", "--local"}, bytes.NewReader(stdin), &bytes.Buffer{})
	}
}
