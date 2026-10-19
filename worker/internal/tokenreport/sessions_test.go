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
