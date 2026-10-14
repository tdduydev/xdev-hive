package tokenreport

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

// fixtureHome chép testdata/home sang thư mục tạm để test đổi mtime và ghi cache mà không đụng fixture. HOME và
// USERPROFILE cùng trỏ vào đó để không có đường nào lọt ra thư mục thật của người chạy test (kể cả trên Windows).
func fixtureHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	src := filepath.Join("testdata", "home")
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		dst := filepath.Join(home, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		in, err := os.Open(p)
		if err != nil {
			return err
		}
		defer in.Close()
		out, err := os.Create(dst)
		if err != nil {
			return err
		}
		defer out.Close()
		_, err = io.Copy(out, in)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return home
}

func run(t *testing.T, opts Options) *Report {
	t.Helper()
	opts.NoRTK = opts.NoRTK || opts.RTK == nil
	rep, err := Run(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	return rep
}

func asMap(t *testing.T, v any) map[string]any {
	t.Helper()
	body, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// canon sắp lại các bảng xếp hạng theo (số bị đọc lại giảm dần, tên): bản TypeScript giữ thứ tự chèn khi hoà, bản Go
// xếp theo tên cho kết quả ổn định, nên chỉ thứ tự trong nhóm hoà khác nhau.
func canon(v any) any {
	switch x := v.(type) {
	case map[string]any:
		for k, e := range x {
			x[k] = canon(e)
		}
	case []any:
		for i, e := range x {
			x[i] = canon(e)
		}
		sort.SliceStable(x, func(i, j int) bool {
			a, aok := x[i].(map[string]any)
			b, bok := x[j].(map[string]any)
			if !aok || !bok || a["name"] == nil || b["name"] == nil {
				return false
			}
			ac, _ := a["carriedTokens"].(float64)
			bc, _ := b["carriedTokens"].(float64)
			if ac != bc {
				return ac > bc
			}
			return fmt.Sprint(a["name"]) < fmt.Sprint(b["name"])
		})
	}
	return v
}

func equalJSON(a, b any, path string) error {
	switch x := a.(type) {
	case map[string]any:
		y, ok := b.(map[string]any)
		if !ok {
			return fmt.Errorf("%s: kiểu khác nhau (%T và %T)", path, a, b)
		}
		for k := range x {
			if _, ok := y[k]; !ok {
				return fmt.Errorf("%s.%s: thiếu ở bản Go", path, k)
			}
		}
		for k := range y {
			if _, ok := x[k]; !ok {
				return fmt.Errorf("%s.%s: thừa ở bản Go", path, k)
			}
		}
		for k, e := range x {
			if err := equalJSON(e, y[k], path+"."+k); err != nil {
				return err
			}
		}
		return nil
	case []any:
		y, ok := b.([]any)
		if !ok || len(x) != len(y) {
			return fmt.Errorf("%s: độ dài khác nhau (%v và %v)", path, a, b)
		}
		for i := range x {
			if err := equalJSON(x[i], y[i], fmt.Sprintf("%s[%d]", path, i)); err != nil {
				return err
			}
		}
		return nil
	case float64:
		y, ok := b.(float64)
		if !ok || math.Abs(x-y) > 1e-9*math.Max(1, math.Abs(x)) {
			return fmt.Errorf("%s: %v ≠ %v", path, a, b)
		}
		return nil
	}
	if !reflect.DeepEqual(a, b) {
		return fmt.Errorf("%s: %v ≠ %v", path, a, b)
	}
	return nil
}

// Bảng mong đợi testdata/expected.json do scripts/token-audit.ts tính trên đúng fixture này (xem testdata/gen.py), nên
// test này giữ bản Go khớp bản TypeScript từng con số.
func TestMatchesTokenAudit(t *testing.T) {
	home := fixtureHome(t)
	rep := run(t, Options{Home: home, NoCache: true})
	got := asMap(t, rep)

	body, err := os.ReadFile(filepath.Join("testdata", "expected.json"))
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]any
	if err := json.Unmarshal(body, &want); err != nil {
		t.Fatal(err)
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok {
			t.Errorf("thiếu trường %q", k)
			continue
		}
		if err := equalJSON(canon(w), canon(g), k); err != nil {
			t.Error(err)
		}
	}
	if rep.Sessions != 9 {
		t.Errorf("sessions = %d, muốn 9 (memory/, tool-results/ và file không phải rollout phải bị bỏ qua)", rep.Sessions)
	}
}

func TestBeforeAfterSplit(t *testing.T) {
	home := fixtureHome(t)
	cutoff := time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)
	rep := run(t, Options{Home: home, NoCache: true, Cutoff: cutoff})
	sp := rep.Split
	if sp == nil {
		t.Fatal("thiếu split")
	}
	if sp.SessionsBefore != 5 || sp.SessionsAfter != 4 {
		t.Fatalf("trước/sau = %d/%d, muốn 5/4", sp.SessionsBefore, sp.SessionsAfter)
	}
	if got := sp.Before.BySource["claude/worker"].Sessions; got != 2 {
		t.Errorf("worker trước mốc = %d, muốn 2", got)
	}
	if _, ok := sp.After.BySource["claude/worker"]; ok {
		t.Error("phiên worker (1/10) không được nằm ở cột sau")
	}
	if got := sp.After.BySource["claude/interactive"].Sessions; got != 2 {
		t.Errorf("interactive sau mốc = %d, muốn 2 (gói claude-2 và mặc định)", got)
	}
	if got := sp.After.BySource["codex/headless"].Sessions; got != 1 {
		t.Errorf("codex exec 11/10 phải ở cột sau, có %d", got)
	}
	if got := sp.Before.BySource["codex/interactive"].Sessions; got != 1 {
		t.Errorf("codex 1/10 phải ở cột trước, có %d", got)
	}
	var calls int
	for _, s := range sp.Before.BySource {
		calls += s.Calls
	}
	for _, s := range sp.After.BySource {
		calls += s.Calls
	}
	var all int
	for _, s := range rep.BySource {
		all += s.Calls
	}
	if calls != all {
		t.Errorf("tổng lượt hai cột = %d, toàn bộ = %d", calls, all)
	}
	// Mốc nằm đúng thời điểm bắt đầu của một phiên thì phiên đó thuộc cột sau.
	exact := run(t, Options{Home: home, NoCache: true, Cutoff: time.Date(2026, 10, 13, 10, 0, 0, 0, time.UTC)})
	if exact.Split.After.BySource["claude/interactive"].Sessions != 1 {
		t.Errorf("phiên bắt đầu đúng mốc phải ở cột sau: %+v", exact.Split.After.BySource)
	}
}

func TestAccountFilter(t *testing.T) {
	home := fixtureHome(t)
	rep := run(t, Options{Home: home, NoCache: true, Accounts: []string{"claude-1"}})
	if rep.Sessions != 2 {
		t.Errorf("claude-1: %d phiên, muốn 2 (phiên worker và subagent)", rep.Sessions)
	}
	if rep.MemoryInventory.Dirs != 1 || rep.MemoryInventory.Duplicated != 0 {
		t.Errorf("memory của một gói không thể trùng với gói khác: %+v", rep.MemoryInventory)
	}
	if len(rep.OtherMemory.Codex) != 0 {
		t.Errorf("lọc gói Claude thì không có gói Codex: %+v", rep.OtherMemory.Codex)
	}

	rep = run(t, Options{Home: home, NoCache: true, Accounts: []string{DefaultAccount}})
	if rep.Sessions != 4 {
		t.Errorf("mặc định: %d phiên, muốn 4 (3 Claude + 1 Codex)", rep.Sessions)
	}
	if _, ok := rep.InteractiveHome["plan"]; ok {
		t.Error("lọc gói mặc định thì không có phiên của gói app")
	}

	rep = run(t, Options{Home: home, NoCache: true, Accounts: []string{"không-có"}})
	if rep.Sessions != 0 {
		t.Errorf("gói không tồn tại phải ra 0 phiên, có %d", rep.Sessions)
	}
}

func TestDaysFilter(t *testing.T) {
	home := fixtureHome(t)
	now := time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC)
	old := now.Add(-60 * 24 * time.Hour)
	_ = filepath.WalkDir(home, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			_ = os.Chtimes(p, old, old)
		}
		return nil
	})
	fresh := filepath.Join(home, ".claude", "projects", "-p3", "int-1.jsonl")
	if err := os.Chtimes(fresh, now, now); err != nil {
		t.Fatal(err)
	}
	rep := run(t, Options{Home: home, NoCache: true, Days: 7, Now: func() time.Time { return now }})
	if rep.Sessions != 1 || rep.Days != 7 {
		t.Errorf("sessions=%d days=%v, muốn 1 và 7", rep.Sessions, rep.Days)
	}
	if rep.MemoryInventory.Stale != 5 {
		t.Errorf("stale = %d, muốn 5 (mọi file memory đã 60 ngày tuổi)", rep.MemoryInventory.Stale)
	}
}

func TestCacheByFileMtimeSize(t *testing.T) {
	home := fixtureHome(t)
	first := run(t, Options{Home: home})
	cachePath := filepath.Join(home, ".xdev-hive", "optimizer", "report-cache.json")
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("chưa ghi cache: %v", err)
	}

	file := filepath.Join(home, ".claude", "projects", "-p3", "int-1.jsonl")
	info, _ := os.Stat(file)
	body, _ := os.ReadFile(file)
	edited := strings.Replace(string(body), `"input_tokens":10,"output_tokens":10,"cache_read_input_tokens":160000`, `"input_tokens":99,"output_tokens":99,"cache_read_input_tokens":160000`, 1)
	if len(edited) != len(body) || edited == string(body) {
		t.Fatal("fixture không có đoạn cần sửa")
	}
	if err := os.WriteFile(file, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
		t.Fatal(err)
	}
	cached := run(t, Options{Home: home})
	if cached.BySource["claude/interactive"].Input != first.BySource["claude/interactive"].Input {
		t.Error("file không đổi (mtime, cỡ) thì phải lấy từ cache")
	}

	later := info.ModTime().Add(time.Minute)
	if err := os.Chtimes(file, later, later); err != nil {
		t.Fatal(err)
	}
	fresh := run(t, Options{Home: home})
	if fresh.BySource["claude/interactive"].Input != first.BySource["claude/interactive"].Input+89 {
		t.Errorf("mtime đổi thì phải đọc lại file: input %d", fresh.BySource["claude/interactive"].Input)
	}

	if err := os.Remove(file); err != nil {
		t.Fatal(err)
	}
	run(t, Options{Home: home})
	raw, _ := os.ReadFile(cachePath)
	if strings.Contains(string(raw), "int-1.jsonl") {
		t.Error("mục cache của file đã xoá phải bị dọn")
	}

	if err := os.WriteFile(cachePath, []byte("{hỏng"), 0o644); err != nil {
		t.Fatal(err)
	}
	if rep := run(t, Options{Home: home}); rep.Sessions != 8 {
		t.Errorf("cache hỏng phải được bỏ qua, sessions = %d", rep.Sessions)
	}
}

func TestLedger(t *testing.T) {
	home := fixtureHome(t)
	rep := run(t, Options{Home: home, NoCache: true})
	tr := rep.Trimmed
	if tr == nil || tr.Entries != 5 || tr.CharsBefore != 164000 || tr.CharsAfter != 29000 || tr.CharsCut != 135000 {
		t.Fatalf("ledger = %+v", tr)
	}
	if tr.ByTool["Bash"].Entries != 4 || tr.ByTool["Read"].CharsCut != 12000 {
		t.Errorf("theo tool: %+v", tr.ByTool)
	}

	rep = run(t, Options{Home: home, NoCache: true, Cutoff: time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)})
	tr = rep.Trimmed
	if tr == nil || tr.Entries != 2 || tr.CharsCut != 18000 {
		t.Fatalf("ledger sau mốc = %+v (RFC 3339, giây và mili giây Unix đều phải đọc được, dòng hỏng bị bỏ)", tr)
	}

	empty := run(t, Options{Home: t.TempDir(), NoCache: true})
	if empty.Trimmed != nil {
		t.Error("không có ledger thì không có mục trimmed")
	}
}

func TestRTKGain(t *testing.T) {
	home := fixtureHome(t)
	rep := run(t, Options{Home: home, NoCache: true, RTK: func(context.Context) ([]byte, error) {
		return []byte(`{"total_saved": 123}`), nil
	}})
	if string(rep.RTKGain) != `{"total_saved": 123}` {
		t.Errorf("rtkGain = %s", rep.RTKGain)
	}
	if asMap(t, rep)["rtkGain"] == nil {
		t.Error("rtkGain phải có trong JSON")
	}
	for name, fn := range map[string]RTKFunc{
		"không có rtk":      func(context.Context) ([]byte, error) { return nil, errors.New("not found") },
		"output không JSON": func(context.Context) ([]byte, error) { return []byte("lỗi"), nil },
	} {
		rep := run(t, Options{Home: home, NoCache: true, RTK: fn})
		if rep.RTKGain != nil {
			t.Errorf("%s: rtkGain phải trống, có %s", name, rep.RTKGain)
		}
		if _, ok := asMap(t, rep)["rtkGain"]; ok {
			t.Errorf("%s: JSON không được có rtkGain", name)
		}
	}
}

// Báo cáo chép vào issue nên không được mang nội dung transcript, lệnh đầy đủ hay đường dẫn dự án.
func TestReportHasNoTranscriptContent(t *testing.T) {
	home := fixtureHome(t)
	rep := run(t, Options{Home: home, NoCache: true, Cutoff: time.Date(2026, 10, 10, 0, 0, 0, 0, time.UTC)})
	body, err := json.Marshal(rep)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"Tiếng Việt", "xin chào", "orphan result", "/Users/u", "/work/", "x.ts", "task-1", "GOFLAGS", "-la", "@xdev-hive/hub", "feedback-a", home} {
		if strings.Contains(string(body), leak) {
			t.Errorf("báo cáo chứa %q", leak)
		}
	}
}

func TestEmptyHomeEncodesToJSON(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)
	rep, err := Run(context.Background(), Options{NoRTK: true, NoCache: true})
	if err != nil {
		t.Fatal(err)
	}
	// Chia cho 0 ở nhóm rỗng sinh NaN, mà NaN không mã hoá được thành JSON.
	if _, err := json.Marshal(rep); err != nil {
		t.Fatal(err)
	}
	if rep.Sessions != 0 || rep.Days != "all" {
		t.Errorf("%+v", rep)
	}
}

func TestCancel(t *testing.T) {
	home := fixtureHome(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Run(ctx, Options{Home: home, NoCache: true, NoRTK: true}); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v", err)
	}
}

func TestBashKey(t *testing.T) {
	for cmd, want := range map[string]string{
		"cd /w && GOFLAGS=-v go test ./...": "go test",
		"pnpm --filter @xdev-hive/hub test": "pnpm test",
		"pnpm install":                      "pnpm install",
		"git -C /repo status":               "git status",
		"FOO=1 BAR=2 cargo test -p x":       "cargo test",
		"/usr/bin/ls -la":                   "ls",
		`C:\tools\rtk.exe gain`:             "rtk.exe",
		"cd a && cd b":                      "",
		"":                                  "",
		"echo 1; rm -rf x":                  "echo",
		"false || true":                     "false",
		"go":                                "go",
		"docker --filter a b c":             "docker b",
	} {
		if got := bashKey(cmd); got != want {
			t.Errorf("bashKey(%q) = %q, muốn %q", cmd, got, want)
		}
	}
}

func TestClassify(t *testing.T) {
	for _, tc := range []struct {
		cwd      string
		headless bool
		want     string
	}{
		{"/Users/u/.xdev-hive/worktrees/t1", true, "worker"},
		{`C:\Users\u\.xdev-hive\runs\r1`, true, "worker"},
		{"/Users/u/.xdev-hive/runs/r1", false, "hub-terminal"},
		{"/var/folders/ab/T/TestZZ1", false, "test"},
		{"/tmp/x-test", true, "test"},
		{"/work/repo", true, "headless"},
		{"/work/repo", false, "interactive"},
	} {
		if got := classify(tc.cwd, tc.headless); got != tc.want {
			t.Errorf("classify(%q, %v) = %q, muốn %q", tc.cwd, tc.headless, got, tc.want)
		}
	}
}

func TestJSLen(t *testing.T) {
	for s, want := range map[string]int{"": 0, "abc": 3, "Tiếng": 5, "😀": 2, "a😀b": 4} {
		if got := jsLen(s); got != want {
			t.Errorf("jsLen(%q) = %d, muốn %d", s, got, want)
		}
	}
}
