package tokenreport

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeLines(t *testing.T, path string, lines ...string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
}

// assistantLine là một dòng assistant của transcript Claude Code; content là mảng khối JSON.
func assistantLine(id string, input, output int64, content string) string {
	return fmt.Sprintf(`{"type":"assistant","cwd":"/w/app","timestamp":"2026-10-18T01:00:00Z","message":{"id":%q,`+
		`"model":"claude-opus-5-5","usage":{"input_tokens":%d,"output_tokens":%d},"content":%s}}`, id, input, output, content)
}

const textBlock = `[{"type":"text","text":"ok"}]`
const editBlock = `[{"type":"tool_use","id":"tu1","name":"Edit","input":{"file_path":"a.go"}}]`

func sessionsOf(t *testing.T, opts Options) []SessionSummary {
	t.Helper()
	opts.NoCache, opts.NoRTK = true, true
	got, err := Sessions(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestSessionsUsesRootsAndMarksSubagent(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "elsewhere", "claude-x")
	writeLines(t, filepath.Join(dir, "projects", "p", "s1.jsonl"), assistantLine("m1", 10, 1, textBlock))
	writeLines(t, filepath.Join(dir, "projects", "p", "s1", "subagents", "a.jsonl"), assistantLine("m2", 20, 2, textBlock))
	// Gói ngoài Roots không được đọc dù nằm đúng chỗ quét cũ.
	writeLines(t, filepath.Join(home, ".claude", "projects", "p", "s2.jsonl"), assistantLine("m3", 5, 1, textBlock))

	got := sessionsOf(t, Options{Home: home, Roots: []Root{{Account: "claude-x", CLI: "claude", Dir: dir}}})
	if len(got) != 2 {
		t.Fatalf("có %d phiên, muốn 2", len(got))
	}
	subagents := 0
	for _, s := range got {
		if s.Account != "claude-x" || s.Cwd != "/w/app" || s.Source != sourceInteractive {
			t.Errorf("phiên sai: %+v", s)
		}
		if s.Subagent {
			subagents++
		}
	}
	if subagents != 1 {
		t.Errorf("có %d transcript subagent, muốn 1", subagents)
	}
}

func TestSessionsWithoutRootsScansLikeRun(t *testing.T) {
	home := t.TempDir()
	writeLines(t, filepath.Join(home, ".claude", "projects", "p", "s.jsonl"), assistantLine("m1", 10, 1, textBlock))
	got := sessionsOf(t, Options{Home: home})
	if len(got) != 1 || got[0].Account != DefaultAccount {
		t.Fatalf("phiên: %+v", got)
	}
	if got[0].Weighted != 15 {
		t.Errorf("token quy đổi %v, muốn 15", got[0].Weighted)
	}
}

func TestPreEditExcludesEditingMessage(t *testing.T) {
	cases := map[string][]string{
		// Khối tool_use sửa file tới ở dòng sau của message đã được tính usage.
		"dòng sau của cùng message": {
			assistantLine("m1", 100, 10, textBlock),
			assistantLine("m2", 50, 5, textBlock),
			assistantLine("m2", 50, 5, editBlock),
			assistantLine("m3", 20, 2, textBlock),
		},
		"dòng đầu của message": {
			assistantLine("m1", 100, 10, textBlock),
			assistantLine("m2", 50, 5, editBlock),
			assistantLine("m3", 20, 2, editBlock),
		},
	}
	for name, lines := range cases {
		t.Run(name, func(t *testing.T) {
			home := t.TempDir()
			writeLines(t, filepath.Join(home, ".claude", "projects", "p", "s.jsonl"), lines...)
			got := sessionsOf(t, Options{Home: home})
			if len(got) != 1 {
				t.Fatalf("có %d phiên", len(got))
			}
			s := got[0]
			// Chỉ m1: 100 input + 5 × 10 output.
			if !s.Edited || s.PreEditWeighted != 150 {
				t.Errorf("Edited %v, PreEditWeighted %v; muốn true, 150", s.Edited, s.PreEditWeighted)
			}
		})
	}
}

func TestSessionWithoutEditIsNotEdited(t *testing.T) {
	home := t.TempDir()
	writeLines(t, filepath.Join(home, ".claude", "projects", "p", "s.jsonl"), assistantLine("m1", 10, 1, textBlock))
	got := sessionsOf(t, Options{Home: home})
	if got[0].Edited || got[0].PreEditWeighted != 0 {
		t.Errorf("phiên chưa sửa file mà có số trước lần sửa: %+v", got[0])
	}
}

func TestModelFamily(t *testing.T) {
	cases := map[string]string{
		"claude-opus-5-5":             "opus",
		"claude-sonnet-5-5[1m]":       "sonnet",
		"us.anthropic.claude-haiku-5": "haiku",
		"Claude-Fable-5-1":            "fable",
		"gpt-5.5-codex":               "gpt",
		"GPT-5":                       "gpt",
		"codex-mini-latest":           "gpt",
		"o3":                          "gpt",
		"o4-mini":                     "gpt",
		"gemini-2.5-pro":              "other",
		"":                            "other",
	}
	for model, want := range cases {
		if got := ModelFamily(model); got != want {
			t.Errorf("ModelFamily(%q) = %q, muốn %q", model, got, want)
		}
	}
}

func TestSessionsModelWeightedClaude(t *testing.T) {
	home := t.TempDir()
	sonnet := strings.Replace(assistantLine("m2", 20, 2, textBlock), "claude-opus-5-5", "claude-sonnet-5-5", 1)
	writeLines(t, filepath.Join(home, ".claude", "projects", "p", "s.jsonl"),
		assistantLine("m1", 10, 1, textBlock),
		// Cùng message ghi hai dòng: chỉ tính một lần như usage.
		assistantLine("m1", 10, 1, textBlock),
		sonnet)
	got := sessionsOf(t, Options{Home: home})
	if len(got) != 1 {
		t.Fatalf("có %d phiên", len(got))
	}
	want := map[string]float64{"opus": 15, "sonnet": 30}
	if fmt.Sprint(got[0].ModelWeighted) != fmt.Sprint(want) {
		t.Errorf("ModelWeighted %v, muốn %v", got[0].ModelWeighted, want)
	}
}

func TestSessionsModelWeightedCodex(t *testing.T) {
	home := t.TempDir()
	count := func(input, cached, output int64) string {
		return fmt.Sprintf(`{"type":"event_msg","timestamp":"2026-10-18T01:00:00Z","payload":{"type":"token_count",`+
			`"info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":%d,"output_tokens":%d}}}}`, input, cached, output)
	}
	turn := func(model string) string {
		return fmt.Sprintf(`{"type":"turn_context","timestamp":"2026-10-18T01:00:00Z","payload":{"model":%q}}`, model)
	}
	writeLines(t, filepath.Join(home, ".codex", "sessions", "2026", "10", "18", "rollout-a.jsonl"),
		`{"type":"session_meta","timestamp":"2026-10-18T01:00:00Z","payload":{"cwd":"/w/app","originator":"codex_cli_rs"}}`,
		turn("gpt-5.5-codex"),
		count(100, 0, 10),
		// Đếm lặp cùng số luỹ kế không cộng thêm.
		count(100, 0, 10),
		turn("llama-3.3"),
		count(300, 100, 20),
		turn("other-model"))
	got := sessionsOf(t, Options{Home: home})
	if len(got) != 1 {
		t.Fatalf("có %d phiên", len(got))
	}
	// Lượt đầu 100 + 5×10 = 150; luỹ kế cuối 200 + 0.1×100 + 5×20 = 310, phần tăng 160 thuộc model của lượt sau.
	if want := map[string]float64{"gpt": 150, "other": 160}; fmt.Sprint(got[0].ModelWeighted) != fmt.Sprint(want) || got[0].Weighted != 310 {
		t.Errorf("ModelWeighted %v, Weighted %v; muốn %v, 310", got[0].ModelWeighted, got[0].Weighted, want)
	}
}
