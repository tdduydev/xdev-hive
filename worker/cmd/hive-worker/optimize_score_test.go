package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/tdduydev/xdev-hive/worker/internal/score"
)

// fakeScoreEnv thêm vào môi trường giả của optimize: /context giả và không có công cụ nào trên PATH.
func fakeScoreEnv(t *testing.T) optimizeEnv {
	t.Helper()
	e := fakeOptimizeEnv(t, "2.1.296")
	oldCtx, oldTool := optimizeContext, optimizeHasTool
	optimizeContext = func(context.Context, score.Profile) ([]byte, error) {
		return []byte("**Tokens:** 12.7k / 1m (1%)\n\n### Estimated usage by category\n\n| Category | Tokens | Percentage |\n" +
			"|---|---|---|\n| Skills | 4.3k | 0.4% |\n| Autocompact buffer | 33k | 3.3% |\n"), nil
	}
	optimizeHasTool = func(string) bool { return false }
	t.Cleanup(func() { optimizeContext, optimizeHasTool = oldCtx, oldTool })
	return e
}

func decodeScore(t *testing.T, out string) score.Result {
	t.Helper()
	var r score.Result
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("không đọc được JSON: %v\n%s", err, out)
	}
	return r
}

func TestOptimizeScore(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/claude-secret/settings.json", "{}\n")
	for _, name := range []string{"a", "b", "c", "d", "e"} {
		e.write(t, ".xdev-hive/accounts/claude-secret/projects/-p/"+name+".jsonl", claudeTranscript("2026-10-12T08:00:00Z"))
	}
	// Gói có thư mục ngoài ~/.xdev-hive/accounts vẫn được chấm riêng.
	e.write(t, "elsewhere/codex-x/config.toml", "tool_output_token_limit = 8000\n")
	e.write(t, ".claude/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-secret","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-secret"},`+
		`{"id":"codex-x","cli":"codex","configDir":"~/elsewhere/codex-x"},{"id":"agy","cli":"antigravity"}`)

	r := decodeScore(t, e.ok(t, "score", "--json", "--fresh"))
	if r.ScoreVersion != score.Version || r.Days != 7 || r.Machine.Score == nil || r.Previous != nil {
		t.Fatalf("kết quả: %+v", r)
	}
	ids := map[string]score.ProfileScore{}
	for _, p := range r.Profiles {
		ids[p.ID] = p
	}
	for _, id := range []string{"claude-secret", "codex-x", "agy", "claude"} {
		if _, ok := ids[id]; !ok {
			t.Errorf("thiếu gói %s: %v", id, ids)
		}
	}
	if p := ids["claude-secret"]; p.Sessions != 5 || p.Share != 1 || p.Context == nil {
		t.Errorf("gói claude-secret: %d phiên, tỉ trọng %v, context %v", p.Sessions, p.Share, p.Context)
	}
	if p := ids["agy"]; p.Counted {
		t.Error("Antigravity không tính vào điểm máy")
	}
	hist := readFile(t, filepath.Join(e.home, ".xdev-hive", "optimizer", "score-history.jsonl"))
	if strings.Contains(hist, "claude-secret") || strings.Contains(hist, e.home) {
		t.Errorf("lịch sử có id gói hoặc đường dẫn:\n%s", hist)
	}
	// Lần tính sau trả lần trước để hiện chênh lệch, và dùng /context đã đo thay vì chạy lại.
	optimizeContext = func(context.Context, score.Profile) ([]byte, error) {
		t.Error("không có --fresh thì không được chạy /context")
		return nil, nil
	}
	r = decodeScore(t, e.ok(t, "score", "--json"))
	if r.Previous == nil {
		t.Error("lần sau phải có previous")
	}
	for _, p := range r.Profiles {
		if p.ID == "claude-secret" && p.Context == nil {
			t.Error("phải dùng /context đã đo")
		}
	}
}

func TestOptimizeFixPreviewApplyUndo(t *testing.T) {
	e := fakeScoreEnv(t)
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)

	var preview fixPreview
	if err := json.Unmarshal([]byte(e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--preview", "--json")), &preview); err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, c := range preview.Changes {
		keys[c.Key] = true
		if c.File != "~/.xdev-hive/accounts/claude-2/settings.json" || c.Before != nil {
			t.Errorf("thay đổi: %+v", c)
		}
	}
	if !keys["env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"] || keys["env.MY_VAR"] || len(preview.Warnings) != 0 {
		t.Errorf("xem trước: %+v", preview)
	}
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatal("xem trước không được ghi file")
	}

	var res fixResult
	if err := json.Unmarshal([]byte(e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--json")), &res); err != nil {
		t.Fatal(err)
	}
	if !res.Changed || res.Backup == "" || readFile(t, settings) == userClaudeSettings {
		t.Fatalf("áp dụng: %+v", res)
	}
	// Lần chấm sau ghi một dòng lịch sử có mã sửa nhanh.
	e.ok(t, "score", "--json")
	if hist := readFile(t, filepath.Join(e.home, ".xdev-hive", "optimizer", "score-history.jsonl")); !strings.Contains(hist, `"fixes":[{"id":"optimizer.balanced","action":"apply"}]`) {
		t.Errorf("lịch sử thiếu dòng sửa nhanh:\n%s", hist)
	}

	e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--undo", "--json")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Errorf("hoàn tác phải trả file về đúng từng byte:\n%s", got)
	}
	// Hoàn tác cũng có mốc trên lịch sử.
	e.ok(t, "score", "--json")
	if last := scoreHistory(t, e, "--last").Entries; len(last) != 1 || fmt.Sprint(last[0].Fixes) != "[{optimizer.balanced undo}]" {
		t.Errorf("dòng sau hoàn tác: %+v", last)
	}
	if code, _, errOut := e.run(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--undo"); code == 0 || !strings.Contains(errOut, "hoàn tác") {
		t.Errorf("hoàn tác lần hai phải báo lỗi: %d %s", code, errOut)
	}
}

func TestOptimizeFixUndoReturnsToPreviousLevel(t *testing.T) {
	e := fakeScoreEnv(t)
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	e.ok(t, "enable", "--profile", "claude-2", "--level", "balanced")
	balanced := readFile(t, settings)

	var preview fixPreview
	_ = json.Unmarshal([]byte(e.ok(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--preview", "--json")), &preview)
	if len(preview.Warnings) != 1 || preview.Warnings[0] != "quality_may_change" {
		t.Errorf("mức aggressive phải cảnh báo chất lượng: %+v", preview)
	}
	e.ok(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--json")
	if v := decodeView(t, e.ok(t, "status", "--json")).profile(t, "claude-2"); v.Level != "aggressive" {
		t.Fatalf("mức sau sửa: %+v", v)
	}
	e.ok(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--undo", "--json")
	if got := readFile(t, settings); got != balanced {
		t.Errorf("hoàn tác phải về mức balanced:\n%s", got)
	}
	if v := decodeView(t, e.ok(t, "status", "--json")).profile(t, "claude-2"); v.Level != "balanced" {
		t.Errorf("manifest sau hoàn tác: %+v", v)
	}
}

func TestOptimizeFixRejectsUnknownAndWrongCLI(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/codex-1/config.toml", "")
	e.accounts(t, `{"id":"codex-1","cli":"codex","configDir":"~/.xdev-hive/accounts/codex-1"}`)
	for _, fix := range []string{"rm -rf", "codegraph.init", "optimizer.rtk", "optimizer.aggressive"} {
		if code, _, errOut := e.run(t, "fix", fix, "--profile", "codex-1", "--json"); code == 0 || errOut == "" {
			t.Errorf("%q phải bị từ chối: %d", fix, code)
		}
	}
	if code, _, _ := e.run(t, "fix", "--profile", "codex-1"); code != 2 {
		t.Errorf("thiếu mã sửa nhanh phải thoát 2, có %d", code)
	}
	if _, err := os.Stat(filepath.Join(e.home, ".xdev-hive", "optimizer", "score-fixes.json")); err == nil {
		t.Error("sửa nhanh bị từ chối không được ghi gì")
	}
}

func TestOptimizeScoreMeasuresOnlyChosenProfile(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/claude-a/settings.json", "{}\n")
	e.write(t, ".xdev-hive/accounts/claude-b/settings.json", "{}\n")
	e.accounts(t, `{"id":"claude-a","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-a"},`+
		`{"id":"claude-b","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-b"}`)
	measure := optimizeContext
	var ran []string
	optimizeContext = func(ctx context.Context, p score.Profile) ([]byte, error) {
		ran = append(ran, p.ID)
		return measure(ctx, p)
	}
	e.ok(t, "score", "--json")
	if len(ran) != 0 {
		t.Fatalf("không có --fresh mà đã chạy /context cho %v", ran)
	}
	e.ok(t, "score", "--json", "--fresh", "--profile", "claude-b")
	if strings.Join(ran, ",") != "claude-b" {
		t.Errorf("chỉ đo gói được bấm, đã chạy %v", ran)
	}
}

// Hoàn tác đi ngược từng lần sửa; hoàn tác hết thì file về đúng từng byte bản gốc (FR-010, SC-003).
func TestOptimizeFixUndoStack(t *testing.T) {
	cases := []struct {
		name, cli, rel, content string
		fixes                   []string
	}{
		{"claude", "claude", ".xdev-hive/accounts/p-1/settings.json", userClaudeSettings,
			[]string{"optimizer.balanced", "optimizer.aggressive"}},
		{"codex", "codex", ".xdev-hive/accounts/p-1/config.toml", "model = \"gpt-5.6\"\n\n[mcp_servers.x]\ncommand = \"x\"\n",
			[]string{"optimizer.balanced", "optimizer.balanced"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			e := fakeScoreEnv(t)
			file := e.write(t, c.rel, c.content)
			e.accounts(t, `{"id":"p-1","cli":"`+c.cli+`","configDir":"~/.xdev-hive/accounts/p-1"}`)
			var after []string
			for _, fix := range c.fixes {
				e.ok(t, "fix", fix, "--profile", "p-1", "--json")
				after = append(after, readFile(t, file))
			}
			// Chỉ hoàn tác được lần sửa sau cùng.
			if c.fixes[0] != c.fixes[1] {
				if code, _, errOut := e.run(t, "fix", c.fixes[0], "--profile", "p-1", "--undo"); code == 0 || !strings.Contains(errOut, c.fixes[1]) {
					t.Errorf("hoàn tác lần sửa đầu khi chưa hoàn tác lần sau: %d %s", code, errOut)
				}
			}
			e.ok(t, "fix", c.fixes[1], "--profile", "p-1", "--undo", "--json")
			if got := readFile(t, file); got != after[0] {
				t.Errorf("hoàn tác lần hai phải về trạng thái sau lần một:\n%s", got)
			}
			e.ok(t, "fix", c.fixes[0], "--profile", "p-1", "--undo", "--json")
			if got := readFile(t, file); got != c.content {
				t.Errorf("hoàn tác hết phải về đúng bản gốc:\n%s", got)
			}
			if v := decodeView(t, e.ok(t, "status", "--json")).profile(t, "p-1"); v.Enabled {
				t.Errorf("hoàn tác hết thì gói không còn bật: %+v", v)
			}
		})
	}
}

func TestOptimizeFixRecordsBeforeChanging(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/claude-2/settings.json", "{hỏng")
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	if code, _, _ := e.run(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--json"); code == 0 {
		t.Fatal("settings.json hỏng thì sửa nhanh phải lỗi")
	}
	// Bật lỗi thì bỏ bản ghi vừa ghi trước, để không còn lần sửa "ma" để hoàn tác.
	if code, _, errOut := e.run(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--undo"); code == 0 || !strings.Contains(errOut, "không có lần sửa nhanh") {
		t.Errorf("không được còn bản ghi sau khi bật lỗi: %d %s", code, errOut)
	}
}

type historyOut struct {
	Entries []score.HistoryEntry `json:"entries"`
}

func scoreHistory(t *testing.T, e optimizeEnv, args ...string) historyOut {
	t.Helper()
	out := e.ok(t, append([]string{"score", "history", "--json"}, args...)...)
	var h historyOut
	if err := json.Unmarshal([]byte(out), &h); err != nil || h.Entries == nil {
		t.Fatalf("không đọc được lịch sử: %v\n%s", err, out)
	}
	return h
}

func pendingMarks(t *testing.T, e optimizeEnv) []score.FixMark {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(e.home, ".xdev-hive", "optimizer", "score-fixes.json"))
	if err != nil {
		return nil
	}
	var st fixState
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	return st.Pending
}

func TestOptimizeScoreHistoryAndMark(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".claude/settings.json", "{}\n")
	if out := e.ok(t, "score", "history", "--json"); strings.TrimSpace(out) != `{"entries":[]}` {
		t.Errorf("chưa có lịch sử: %s", out)
	}
	if out := e.ok(t, "score", "history", "--json", "--last"); strings.TrimSpace(out) != `{"entries":[]}` {
		t.Errorf("chưa có lịch sử, --last: %s", out)
	}
	e.ok(t, "score", "--json")
	for _, bad := range [][]string{
		{"--fix", "rm -rf", "--action", "apply"},
		{"--fix", "open.mcp", "--action", "apply"},
		{"--fix", "codegraph.init", "--action", "redo"},
		{"--action", "apply"},
	} {
		if code, _, errOut := e.run(t, append([]string{"score", "mark"}, bad...)...); code != 2 || errOut == "" {
			t.Errorf("mark %v phải thoát 2, có %d", bad, code)
		}
	}
	if len(pendingMarks(t, e)) != 0 {
		t.Fatal("mốc bị từ chối không được vào hàng chờ")
	}
	e.ok(t, "score", "mark", "--fix", "codegraph.mcp", "--action", "apply")
	e.ok(t, "score", "mark", "--fix", "codegraph.init", "--action", "apply")
	h := scoreHistory(t, e)
	if len(h.Entries) != 1 || len(h.Entries[0].Fixes) != 0 {
		t.Fatalf("history không tính điểm, không ghi dòng: %+v", h.Entries)
	}
	// Cùng ngày nhưng có mốc: thêm một dòng mang cả hai mốc, rồi hàng chờ rỗng.
	e.ok(t, "score", "--json")
	h = scoreHistory(t, e, "--days", "30")
	if len(h.Entries) != 2 || fmt.Sprint(h.Entries[1].Fixes) != "[{codegraph.mcp apply} {codegraph.init apply}]" {
		t.Fatalf("lịch sử: %+v", h.Entries)
	}
	if h.Entries[0].At.After(h.Entries[1].At) {
		t.Error("lịch sử phải theo thời gian tăng dần")
	}
	if p := pendingMarks(t, e); len(p) != 0 {
		t.Errorf("mốc đã lên lịch sử vẫn còn trong hàng chờ: %+v", p)
	}
	last := scoreHistory(t, e, "--last").Entries
	if len(last) != 1 || last[0].Day != "2026-10-13" || len(last[0].Fixes) != 2 {
		t.Errorf("--last: %+v", last)
	}
	// Ba lệnh score cùng ngày không mốc: không thêm dòng.
	e.ok(t, "score", "--json")
	if n := len(scoreHistory(t, e).Entries); n != 2 {
		t.Errorf("có %d dòng, muốn 2", n)
	}
}

// Mốc chỉ rời hàng chờ khi dòng lịch sử đã ghi được; ghi lỗi thì lần score sau ghi lại.
func TestOptimizeScoreKeepsMarksWhenHistoryFails(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".claude/settings.json", "{}\n")
	e.ok(t, "score", "mark", "--fix", "tool.rtk", "--action", "apply")
	hist := filepath.Join(e.home, ".xdev-hive", "optimizer", "score-history.jsonl")
	if err := os.MkdirAll(hist, 0o755); err != nil {
		t.Fatal(err)
	}
	if code, _, errOut := e.run(t, "score", "--json"); code != 0 || !strings.Contains(errOut, "lịch sử điểm") {
		t.Fatalf("ghi lịch sử lỗi vẫn trả điểm và báo lỗi: %d %s", code, errOut)
	}
	if p := pendingMarks(t, e); len(p) != 1 {
		t.Fatalf("mốc phải còn trong hàng chờ: %+v", p)
	}
	if err := os.Remove(hist); err != nil {
		t.Fatal(err)
	}
	e.ok(t, "score", "--json")
	if h := scoreHistory(t, e).Entries; len(h) != 1 || fmt.Sprint(h[0].Fixes) != "[{tool.rtk apply}]" {
		t.Errorf("lần sau phải ghi mốc còn chờ: %+v", h)
	}
}

// Nhiều lệnh mark và fix chạy cùng lúc (app desktop) không làm mất mốc nào.
func TestOptimizeScoreMarksConcurrent(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".claude/settings.json", "{}\n")
	const n = 8
	var wg sync.WaitGroup
	codes := make(chan int, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			action := score.MarkApply
			if i%2 == 1 {
				action = score.MarkUndo
			}
			code, _, _ := e.run(t, "score", "mark", "--fix", "tool.codegraph", "--action", action)
			codes <- code
		}()
	}
	wg.Wait()
	close(codes)
	for code := range codes {
		if code != 0 {
			t.Fatalf("mark thoát %d", code)
		}
	}
	if p := pendingMarks(t, e); len(p) != n {
		t.Fatalf("hàng chờ có %d mốc, muốn %d", len(p), n)
	}
	e.ok(t, "score", "--json")
	if h := scoreHistory(t, e).Entries; len(h) != 1 || len(h[0].Fixes) != n {
		t.Errorf("lịch sử: %+v", h)
	}
}

func TestOptimizeRestoreMarksUndo(t *testing.T) {
	e := fakeScoreEnv(t)
	settings := e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--json")
	e.ok(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--json")
	e.ok(t, "restore", "--profile", "claude-2", "--json")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Fatalf("restore phải về bản gốc:\n%s", got)
	}
	want := "[{optimizer.balanced apply} {optimizer.aggressive apply} {optimizer.aggressive undo} {optimizer.balanced undo}]"
	if got := fmt.Sprint(pendingMarks(t, e)); got != want {
		t.Errorf("hàng chờ sau restore %s, muốn %s", got, want)
	}
	// Chồng hoàn tác đã bỏ: bản sao lưu đã thay mọi lần sửa.
	if code, _, errOut := e.run(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--undo"); code == 0 || !strings.Contains(errOut, "không có lần sửa nhanh") {
		t.Errorf("sau restore không còn gì để hoàn tác: %d %s", code, errOut)
	}
}

// File score-fixes.json của bản trước: chồng giữ nguyên, bản ghi chưa lên lịch sử thành mốc chờ.
func TestOptimizeFixReadsLegacyState(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--json")
	e.write(t, ".xdev-hive/optimizer/score-fixes.json", `{"claude-2":[`+
		`{"fixId":"optimizer.balanced","prevEnabled":false,"at":"2026-10-12T01:00:00Z","recorded":true},`+
		`{"fixId":"optimizer.aggressive","prevEnabled":true,"prevLevel":"balanced","at":"2026-10-12T02:00:00Z"}]}`)
	if got := fmt.Sprint(loadFixes(filepath.Join(e.home, ".xdev-hive", "optimizer")).Pending); got != "[{optimizer.aggressive apply}]" {
		t.Errorf("mốc chờ từ file cũ: %s", got)
	}
	e.ok(t, "fix", "optimizer.aggressive", "--profile", "claude-2", "--undo", "--json")
	e.ok(t, "score", "--json")
	if h := scoreHistory(t, e).Entries; len(h) != 1 || fmt.Sprint(h[0].Fixes) != "[{optimizer.aggressive apply} {optimizer.aggressive undo}]" {
		t.Errorf("lịch sử: %+v", h)
	}
}

func TestOptimizeFixRTKOnWindows(t *testing.T) {
	e := fakeScoreEnv(t)
	e.write(t, ".xdev-hive/accounts/claude-2/settings.json", userClaudeSettings)
	e.accounts(t, `{"id":"claude-2","cli":"claude","configDir":"~/.xdev-hive/accounts/claude-2"}`)
	old := optimizeGOOS
	optimizeGOOS = func() string { return "windows" }
	t.Cleanup(func() { optimizeGOOS = old })
	for _, args := range [][]string{{"--json"}, {"--preview", "--json"}} {
		code, _, errOut := e.run(t, append([]string{"fix", "optimizer.rtk", "--profile", "claude-2"}, args...)...)
		if code == 0 || !strings.HasPrefix(errOut, "windows_rtk_unsupported") {
			t.Errorf("fix optimizer.rtk %v trên Windows: %d %s", args, code, errOut)
		}
	}
	if _, err := os.Stat(filepath.Join(e.home, ".xdev-hive", "optimizer", "score-fixes.json")); err == nil {
		t.Error("bị từ chối sớm thì không ghi bản ghi hoàn tác")
	}
}
