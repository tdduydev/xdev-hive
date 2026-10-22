package tokenreport

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"runtime"
	"testing"
	"time"
)

const (
	projA = "11111111-1111-4111-8111-111111111111"
	projB = "22222222-2222-4222-8222-222222222222"
)

func TestAssignProjectByCwd(t *testing.T) {
	folders := []ProjectFolder{
		{ProjectID: projA, Folder: "/work/app"},
		{ProjectID: projB, Folder: "/work/app/packages/ui"},
		{ProjectID: "", Folder: "/work/unbound"},
	}
	cases := []struct {
		cwd, want string
	}{
		{"/work/app", projA},
		{"/work/app/", projA},
		{"/work/app/src/deep", projA},
		{"/work/app/../app/src", projA},
		{"/work/app/packages/ui/button", projB}, // dự án lồng nhau: thư mục sâu nhất thắng
		{"/work/application", ""},               // trùng tiền tố chuỗi nhưng không phải thư mục con
		{"/work", ""},
		{"/work/unbound/x", ""}, // mục chưa gắn dự án không nhận phiên
		{"relative/path", ""},
		{"", ""},
	}
	for _, c := range cases {
		got, ok := AssignProject(c.cwd, folders)
		if got != c.want || ok != (c.want != "") {
			t.Errorf("cwd %q: got (%q,%v), want %q", c.cwd, got, ok, c.want)
		}
	}
}

func TestAssignProjectWindowsPaths(t *testing.T) {
	folders := []ProjectFolder{
		{ProjectID: projA, Folder: `C:\Code\App`},
		{ProjectID: projB, Folder: `D:/work/app`},
	}
	cases := []struct {
		cwd, want string
	}{
		{`C:\Code\App`, projA},
		{`c:\code\app\src`, projA},      // hoa thường
		{`C:/Code/App/src`, projA},      // dấu `/`
		{`\\?\C:\Code\App\src`, projA},  // tiền tố đường dẫn dài
		{`C:\Code\Application`, ""},     // không phải thư mục con
		{`D:\Code\App`, ""},             // khác ổ đĩa, cùng đường dẫn
		{`E:\work\app`, ""},             // ổ đĩa không có dự án nào
		{`D:\WORK\app\src\x`, projB},    // thư mục gắn viết `/`
		{`C:\Code\App\..\Other`, ""},    // thoát khỏi thư mục dự án
		{`\\server\share\Code\App`, ""}, // UNC không trùng ổ C:
	}
	for _, c := range cases {
		got, ok := AssignProject(c.cwd, folders)
		if got != c.want || ok != (c.want != "") {
			t.Errorf("cwd %q: got (%q,%v), want %q", c.cwd, got, ok, c.want)
		}
	}
	// `//server/share` chỉ là UNC trên Windows; Linux, macOS coi đó là đường dẫn thường.
	if runtime.GOOS == "windows" {
		unc := []ProjectFolder{{ProjectID: projA, Folder: `\\Server\Share\Repo`}}
		if got, _ := AssignProject(`//server/share/repo/src`, unc); got != projA {
			t.Errorf("UNC: got %q", got)
		}
	}
}

func TestAssignProjectLinuxIsCaseSensitive(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows so đường dẫn không phân biệt hoa thường")
	}
	got, ok := AssignProject("/Work/App/src", []ProjectFolder{{ProjectID: projA, Folder: "/work/app"}})
	if ok || got != "" {
		t.Errorf("Linux phân biệt hoa thường, nhưng gán %q", got)
	}
}

func usageSession(cli, cwd string, start time.Time, weighted float64) SessionSummary {
	return SessionSummary{
		CLI: cli, Source: "interactive", Account: "claude-secret-account", Start: start, Cwd: cwd,
		Input: 100, Output: 50, CacheRead: 1000, CacheWrite: 7, Weighted: weighted,
		Models: []string{"claude-opus-5-5"}, ModelWeighted: map[string]float64{"opus": weighted},
	}
}

func usageInput(now time.Time, sessions ...SessionSummary) UsageInput {
	return UsageInput{
		Sessions: sessions,
		Folders:  []ProjectFolder{{ProjectID: projA, Folder: filepath.Join(string(filepath.Separator), "secret", "path", "app")}},
		Enabled:  map[string]bool{projA: true},
		Now:      now,
	}
}

var (
	uuidRE  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	dateRE  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$`)
	driftRE = regexp.MustCompile(`^(level|rtk|codegraph|autoCompactWindow|contextBudgetTokens|memoryAutoSync)$`)
)

// checkNoText đi qua JSON và chỉ cho phép: số, null, mảng, object, và chuỗi là uuid, ngày hoặc enum mục chính sách.
func checkNoText(t *testing.T, path string, v any) {
	t.Helper()
	switch x := v.(type) {
	case nil, float64:
	case string:
		ok := false
		switch path {
		case "projectId":
			ok = uuidRE.MatchString(x)
		case "periodStart", "periodEnd":
			ok = dateRE.MatchString(x)
		case "policyDrift[]":
			ok = driftRE.MatchString(x)
		}
		if !ok {
			t.Errorf("chuỗi không được phép ở %s: %q", path, x)
		}
	case []any:
		for _, e := range x {
			checkNoText(t, path+"[]", e)
		}
	case map[string]any:
		for k, e := range x {
			if path == "tokens" && k != "claude" && k != "codex" {
				t.Errorf("khoá CLI lạ: %q", k)
			}
			if path == "tokens" || path == "tokens.claude" || path == "tokens.codex" {
				// khoá của map tokens và các số của từng CLI
				checkNoText(t, path+"."+k, e)
				continue
			}
			checkNoText(t, joinPath(path, k), e)
		}
	default:
		t.Errorf("kiểu lạ ở %s: %T", path, v)
	}
}

func joinPath(path, k string) string {
	if path == "" {
		return k
	}
	return path + "." + k
}

func TestProjectUsagePayloadHasNoText(t *testing.T) {
	now := time.Date(2026, 10, 22, 3, 0, 0, 0, time.UTC)
	cwd := filepath.Join(string(filepath.Separator), "secret", "path", "app", "src")
	in := usageInput(now,
		usageSession("claude", cwd, now.Add(-time.Hour), 10.123),
		usageSession("codex", cwd, now.Add(-2*time.Hour), 5),
	)
	score := 71.6
	in.Score = &score
	in.Drift = map[string][]string{projA: {"rtk", "level", "ten tu do ../../etc/passwd", "rtk"}}
	out := BuildProjectUsage(in)
	if len(out) != 1 {
		t.Fatalf("cần 1 payload, có %d", len(out))
	}
	b, err := json.Marshal(out[0])
	if err != nil {
		t.Fatal(err)
	}
	var generic map[string]any
	if err := json.Unmarshal(b, &generic); err != nil {
		t.Fatal(err)
	}
	for k := range generic {
		switch k {
		case "projectId", "periodStart", "periodEnd", "tokens", "sessions", "score", "policyDrift":
		default:
			t.Errorf("trường ngoài schema: %s", k)
		}
	}
	checkNoText(t, "", generic)
	for _, secret := range []string{"secret", "claude-secret-account", "opus", "interactive", "passwd"} {
		if regexp.MustCompile(secret).Match(b) {
			t.Errorf("payload lộ %q: %s", secret, b)
		}
	}
	p := out[0]
	if p.Sessions != 2 || *p.Score != 72 || len(p.Tokens) != 2 || p.Tokens["claude"].Weighted != 10.12 ||
		p.Tokens["claude"].Input != 100 || p.Tokens["claude"].CacheRead != 1000 {
		t.Errorf("số liệu: %+v", p)
	}
	if len(p.PolicyDrift) != 2 || p.PolicyDrift[0] != "level" || p.PolicyDrift[1] != "rtk" {
		t.Errorf("policyDrift: %v", p.PolicyDrift)
	}
	if p.PeriodEnd != "2026-10-22T03:00:00Z" || p.PeriodStart != "2026-10-15T03:00:00Z" {
		t.Errorf("kỳ: %s → %s", p.PeriodStart, p.PeriodEnd)
	}
}

func TestProjectUsageSelection(t *testing.T) {
	now := time.Date(2026, 10, 22, 3, 0, 0, 0, time.UTC)
	inside := filepath.Join(string(filepath.Separator), "secret", "path", "app")
	outside := filepath.Join(string(filepath.Separator), "elsewhere")
	sub := usageSession("claude", inside, now.Add(-time.Hour), 1)
	sub.Subagent = true
	test := usageSession("claude", inside, now.Add(-time.Hour), 1)
	test.Source = "test"
	in := usageInput(now,
		usageSession("claude", inside, now.Add(-time.Hour), 1),
		sub, test,
		usageSession("claude", inside, now.AddDate(0, 0, -8), 1),    // quá kỳ 7 ngày
		usageSession("claude", outside, now.Add(-time.Hour), 1),     // ngoài thư mục đã gắn
		usageSession("antigravity", inside, now.Add(-time.Hour), 1), // CLI hub không nhận
	)
	out := BuildProjectUsage(in)
	if len(out) != 1 || out[0].Sessions != 1 || len(out[0].Tokens) != 1 || out[0].Tokens["claude"].Input != 200 {
		t.Fatalf("chọn phiên: %+v", out)
	}
	if out[0].Score != nil || out[0].PolicyDrift == nil || len(out[0].PolicyDrift) != 0 {
		t.Errorf("không có điểm thì null, không lệch thì mảng rỗng: %+v", out[0])
	}
	if b, _ := json.Marshal(out[0]); !regexp.MustCompile(`"score":null,"policyDrift":\[\]`).Match(b) {
		t.Errorf("JSON: %s", b)
	}

	// Cờ tắt hoặc thiếu: không dựng gì.
	for _, enabled := range []map[string]bool{nil, {}, {projA: false}, {projB: true}} {
		in.Enabled = enabled
		if got := BuildProjectUsage(in); len(got) != 0 {
			t.Errorf("cờ %v vẫn dựng %d payload", enabled, len(got))
		}
	}
}

func TestUsageStateDefaultsOffAndRoundTrips(t *testing.T) {
	dir := t.TempDir()
	st, err := LoadUsageState(dir)
	if err != nil || len(st.Projects) != 0 || st.Projects[projA].Enabled {
		t.Fatalf("mặc định tắt: %+v %v", st, err)
	}
	sent := time.Date(2026, 10, 22, 3, 0, 0, 0, time.UTC)
	st.Projects[projA] = ProjectFlag{Enabled: true, LastSentAt: &sent}
	if err := SaveUsageState(dir, st); err != nil {
		t.Fatal(err)
	}
	got, err := LoadUsageState(dir)
	if err != nil || !got.Projects[projA].Enabled || !got.Projects[projA].LastSentAt.Equal(sent) {
		t.Fatalf("đọc lại: %+v %v", got, err)
	}
}
