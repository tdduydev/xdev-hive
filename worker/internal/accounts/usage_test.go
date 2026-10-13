package accounts

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// claudeUsageOutput là kết quả `claude -p /usage --output-format json` (Claude Code 2.x), phần chữ đúng định dạng thật
// đã thấy ngày 13/10/2026.
const claudeUsageOutput = `{"type":"result","subtype":"success","is_error":false,"duration_ms":412,"num_turns":0,"result":"Current session: 40% used · resets Oct 13 at 1:39pm (Asia/Saigon)\nCurrent week (all models): 47% used · resets Oct 17 at 9am (Asia/Saigon)\nCurrent week (Sonnet only): 12% used · resets Oct 17 at 9am (Asia/Saigon)","session_id":"8c1f","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0}}`

// 10:00 sáng 13/10/2026 giờ Việt Nam.
var vnMorning = time.Date(2026, 10, 13, 3, 0, 0, 0, time.UTC)

func utc(y int, m time.Month, d, h, min int) time.Time {
	return time.Date(y, m, d, h, min, 0, 0, time.UTC)
}

func TestParseClaudeUsageRealOutput(t *testing.T) {
	u := parseClaudeUsage(claudeText([]byte(claudeUsageOutput)), vnMorning)
	if u == nil || u.Session == nil || u.Week == nil {
		t.Fatalf("usage = %+v", u)
	}
	if u.Session.Percent != 40 || !u.Session.ResetsAt.Equal(utc(2026, 10, 13, 6, 39)) {
		t.Fatalf("phiên = %v %v", u.Session.Percent, u.Session.ResetsAt)
	}
	// Tuần của mọi model, không phải tuần riêng Sonnet.
	if u.Week.Percent != 47 || !u.Week.ResetsAt.Equal(utc(2026, 10, 17, 2, 0)) {
		t.Fatalf("tuần = %v %v", u.Week.Percent, u.Week.ResetsAt)
	}
	if !u.CheckedAt.Equal(vnMorning) {
		t.Fatalf("checkedAt = %v", u.CheckedAt)
	}
	// Dòng phiên không có "· resets" (phiên chưa bắt đầu), số thập phân, CLI in thẳng chữ thay vì JSON.
	u = parseClaudeUsage(claudeText([]byte("  Current session: 0% used\n  Current week (all models): 12.5% used · resets 9am (Asia/Saigon)\n")), vnMorning)
	if u == nil || u.Session.Percent != 0 || u.Session.ResetsAt != nil || u.Week.Percent != 12.5 || !u.Week.ResetsAt.Equal(utc(2026, 10, 14, 2, 0)) {
		t.Fatalf("usage = %+v / %+v", u.Session, u.Week)
	}
	// Khoá API, CLI cũ: không có thanh nào.
	if u := parseClaudeUsage(claudeText([]byte(`{"type":"result","result":"/usage is only available for subscription plans"}`)), vnMorning); u != nil {
		t.Fatalf("không có thanh nào phải nil: %+v", u)
	}
}

func TestParseResetAt(t *testing.T) {
	cases := []struct {
		text string
		now  time.Time
		want *time.Time
	}{
		{"Oct 13 at 1:39pm (Asia/Saigon)", vnMorning, ptr(utc(2026, 10, 13, 6, 39))},
		{"Oct 8, 6pm (Asia/Ho_Chi_Minh)", utc(2026, 10, 7, 0, 0), ptr(utc(2026, 10, 8, 11, 0))},
		{"Sept 30 at 12am (UTC)", utc(2026, 9, 29, 12, 0), ptr(utc(2026, 9, 30, 0, 0))},
		{"Oct 13 at 12pm (America/Los_Angeles)", vnMorning, ptr(utc(2026, 10, 13, 19, 0))},
		// Không có ngày: hôm nay nếu còn tới, không thì mai.
		{"1:39pm (Asia/Saigon)", vnMorning, ptr(utc(2026, 10, 13, 6, 39))},
		{"9am (Asia/Saigon)", vnMorning, ptr(utc(2026, 10, 14, 2, 0))},
		// CLI bỏ năm: "Jan 2" đọc cuối tháng 12 là năm sau.
		{"Jan 2 at 9am (Asia/Saigon)", utc(2026, 12, 30, 3, 0), ptr(utc(2027, 1, 2, 2, 0))},
		// /usage vừa đọc vài phút trước giờ reset: vẫn là năm nay.
		{"Oct 13 at 9:58am (Asia/Saigon)", vnMorning, ptr(utc(2026, 10, 13, 2, 58))},
		{"Feb 30 at 1pm (Asia/Saigon)", vnMorning, nil},
		{"Oct 13 at 13pm (Asia/Saigon)", vnMorning, nil},
		{"Oct 13 at 1:39pm (Sao/Hoa)", vnMorning, nil},
		{"Oct 13 at 1:39pm", vnMorning, nil},
		{"sắp tới", vnMorning, nil},
		{"", vnMorning, nil},
	}
	for _, c := range cases {
		got := parseResetAt(c.text, c.now)
		if (got == nil) != (c.want == nil) || (got != nil && !got.Equal(*c.want)) {
			t.Fatalf("%q: %v, muốn %v", c.text, got, c.want)
		}
	}
}

// Claude: chạy /usage với thư mục cấu hình của tài khoản, đúng tham số; không đăng nhập thì không chạy CLI.
func TestReadUsageClaude(t *testing.T) {
	home := t.TempDir()
	signIn(t, home, "~/.xdev-hive/accounts/claude-2", "claude")
	signIn(t, home, "", "claude")
	var gotArgs [][]string
	var gotEnv []map[string]string
	output := claudeUsageOutput
	savedLook, savedRun := lookPath, runCLI
	t.Cleanup(func() { lookPath, runCLI = savedLook, savedRun })
	lookPath = func(name string) (string, error) { return "/opt/bin/" + name, nil }
	runCLI = func(_ context.Context, name string, args []string, env map[string]string) ([]byte, error) {
		if name != "/opt/bin/claude" {
			t.Fatalf("CLI = %q", name)
		}
		gotArgs, gotEnv = append(gotArgs, args), append(gotEnv, env)
		return []byte(output), nil
	}
	u := ReadUsage(context.Background(), Account{ID: "claude-2", CLI: "claude", ConfigDir: "~/.xdev-hive/accounts/claude-2"}.withDefaults(), home, vnMorning)
	if u.Session == nil || u.Session.Percent != 40 || u.Reason != nil {
		t.Fatalf("usage = %+v", u)
	}
	want := []string{"-p", "/usage", "--output-format", "json", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", `{"mcpServers":{}}`}
	if !reflect.DeepEqual(gotArgs[0], want) {
		t.Fatalf("args = %q", gotArgs[0])
	}
	if gotEnv[0]["CLAUDE_CONFIG_DIR"] != filepath.Join(home, ".xdev-hive", "accounts", "claude-2") {
		t.Fatalf("env = %v", gotEnv[0])
	}
	// Đăng nhập mặc định: không đặt CLAUDE_CONFIG_DIR.
	_ = ReadUsage(context.Background(), Account{ID: "claude-1", CLI: "claude"}.withDefaults(), home, vnMorning)
	if len(gotEnv) != 2 || gotEnv[1] != nil {
		t.Fatalf("env mặc định = %v", gotEnv)
	}
	if u := ReadUsage(context.Background(), Account{ID: "claude-9", CLI: "claude", ConfigDir: "~/chua-dang-nhap"}.withDefaults(), home, vnMorning); *u.Reason != reasonSignedOut || len(gotArgs) != 2 {
		t.Fatalf("chưa đăng nhập không được chạy CLI: %+v, %d lần", u, len(gotArgs))
	}
	output = "Error: something went wrong"
	if u := ReadUsage(context.Background(), Account{ID: "claude-1", CLI: "claude"}.withDefaults(), home, vnMorning); *u.Reason != reasonSilent || u.Session != nil {
		t.Fatalf("CLI không báo: %+v", u)
	}
	noCLIs(t, "claude")
	if u := ReadUsage(context.Background(), Account{ID: "claude-1", CLI: "claude"}.withDefaults(), home, vnMorning); *u.Reason != reasonNoCLI {
		t.Fatalf("không có CLI: %+v", u)
	}
	if u := ReadUsage(context.Background(), Account{ID: "agy", CLI: "antigravity"}, home, vnMorning); *u.Reason != reasonUnsupported {
		t.Fatalf("antigravity: %+v", u)
	}
}

// codexHome dựng CODEX_HOME có file phiên ở các ngày; file đi sau trong danh sách có giờ sửa cũ hơn.
func codexHome(t *testing.T, files map[string]string, order []string) string {
	t.Helper()
	home := t.TempDir()
	for i, name := range order {
		path := filepath.Join(home, "sessions", filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(files[name]), 0o600); err != nil {
			t.Fatal(err)
		}
		at := vnMorning.Add(-time.Duration(i) * time.Hour)
		if err := os.Chtimes(path, at, at); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

func TestReadCodexUsageFromRollout(t *testing.T) {
	sample, err := os.ReadFile(filepath.Join("testdata", "codex-rollout.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	older := `{"timestamp":"2026-10-12T08:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":90,"resets_at":1791788400},"secondary":{"used_percent":20,"resets_at":1792134000}}}}` + "\n"
	files := map[string]string{
		// Phiên mới nhất chưa có lượt nào: đọc sang file kế.
		"2026/10/13/rollout-2026-10-13T09-59-00-new.jsonl":      `{"timestamp":"2026-10-13T02:59:00Z","type":"session_meta","payload":{"id":"x"}}` + "\n",
		"2026/10/13/rollout-2026-10-13T09-58-01-0199d7a2.jsonl": string(sample),
		"2026/10/12/rollout-2026-10-12T15-00-00-old.jsonl":      older,
	}
	home := codexHome(t, files, []string{"2026/10/13/rollout-2026-10-13T09-59-00-new.jsonl", "2026/10/13/rollout-2026-10-13T09-58-01-0199d7a2.jsonl", "2026/10/12/rollout-2026-10-12T15-00-00-old.jsonl"})
	// Thư mục không phải số và file không phải rollout bị bỏ qua.
	_ = os.MkdirAll(filepath.Join(home, "sessions", "archive"), 0o700)
	_ = os.WriteFile(filepath.Join(home, "sessions", "2026", "10", "13", "notes.txt"), []byte(`"rate_limits" "token_count"`), 0o600)
	u := readCodexUsage(home, vnMorning)
	if u == nil || u.Session == nil || u.Week == nil {
		t.Fatalf("usage = %+v", u)
	}
	// Lượt cuối của plan codex; dòng premium (thanh rỗng) và tin nhắn nhắc chữ rate_limits bị bỏ qua.
	if u.Session.Percent != 12.5 || !u.Session.ResetsAt.Equal(utc(2026, 10, 13, 7, 0)) {
		t.Fatalf("phiên = %v %v", u.Session.Percent, u.Session.ResetsAt)
	}
	if u.Week.Percent != 40 || !u.Week.ResetsAt.Equal(utc(2026, 10, 17, 7, 0)) {
		t.Fatalf("tuần = %v %v", u.Week.Percent, u.Week.ResetsAt)
	}
	if !u.CheckedAt.Equal(utc(2026, 10, 13, 3, 0)) {
		t.Fatalf("checkedAt là giờ của lượt cuối: %v", u.CheckedAt)
	}
	// Qua giờ reset phiên: thanh phiên về 0, tuần giữ số.
	later := readCodexUsage(home, utc(2026, 10, 13, 8, 0))
	if later.Session.Percent != 0 || later.Session.ResetsAt != nil || later.Week.Percent != 40 {
		t.Fatalf("sau reset = %+v %+v", later.Session, later.Week)
	}
	if readCodexUsage(t.TempDir(), vnMorning) != nil {
		t.Fatal("không có phiên nào phải nil")
	}
}

// Codex cũ ghi resets_in_seconds thay vì resets_at; event quota nằm xa cuối một file phiên dài vẫn đọc được.
func TestReadCodexUsageOldFormatInLongFile(t *testing.T) {
	line := `{"timestamp":"2026-10-13T02:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":8,"resets_in_seconds":7200},"secondary":{"used_percent":38,"resets_in_seconds":86400}}}}`
	filler := strings.Repeat(`{"timestamp":"2026-10-13T02:30:00Z","type":"response_item","payload":{"type":"message","content":"`+strings.Repeat("x", 200)+`"}}`+"\n", 2000)
	name := "2026/10/13/rollout-long.jsonl"
	home := codexHome(t, map[string]string{name: "{\"partial\n" + line + "\n" + filler}, []string{name})
	u := readCodexUsage(home, vnMorning)
	if u == nil || u.Session.Percent != 8 || !u.Session.ResetsAt.Equal(utc(2026, 10, 13, 4, 0)) {
		t.Fatalf("usage = %+v", u)
	}
	if !u.Week.ResetsAt.Equal(utc(2026, 10, 14, 2, 0)) || u.Week.Percent != 38 {
		t.Fatalf("tuần = %+v", u.Week)
	}
}

func TestReadUsageCodexUsesConfigDir(t *testing.T) {
	sample, _ := os.ReadFile(filepath.Join("testdata", "codex-rollout.jsonl"))
	name := "2026/10/13/rollout-a.jsonl"
	dir := codexHome(t, map[string]string{name: string(sample)}, []string{name})
	signIn(t, dir, dir, "codex")
	signIn(t, dir, filepath.Join(dir, "empty"), "codex")
	savedRun := runCLI
	t.Cleanup(func() { runCLI = savedRun })
	runCLI = func(context.Context, string, []string, map[string]string) ([]byte, error) {
		t.Fatal("Codex không chạy CLI để đọc quota")
		return nil, nil
	}
	if u := ReadUsage(context.Background(), Account{ID: "codex-2", CLI: "codex", ConfigDir: dir}.withDefaults(), t.TempDir(), vnMorning); u.Week == nil || u.Week.Percent != 40 {
		t.Fatalf("usage = %+v", u)
	}
	if u := ReadUsage(context.Background(), Account{ID: "codex-3", CLI: "codex", ConfigDir: filepath.Join(dir, "empty")}.withDefaults(), t.TempDir(), vnMorning); *u.Reason != reasonNoSession {
		t.Fatalf("chưa có phiên: %+v", u)
	}
}
