package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	if hist := readFile(t, filepath.Join(e.home, ".xdev-hive", "optimizer", "score-history.jsonl")); !strings.Contains(hist, `"fix":"optimizer.balanced"`) {
		t.Errorf("lịch sử thiếu dòng sửa nhanh:\n%s", hist)
	}

	e.ok(t, "fix", "optimizer.balanced", "--profile", "claude-2", "--undo", "--json")
	if got := readFile(t, settings); got != userClaudeSettings {
		t.Errorf("hoàn tác phải trả file về đúng từng byte:\n%s", got)
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
