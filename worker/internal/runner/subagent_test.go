package runner

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func newTestTracker(secret []string) (*subagentTracker, *[]SubagentEvent) {
	var got []SubagentEvent
	t := newSubagentTracker(secret, func(e SubagentEvent) error { got = append(got, e); return nil })
	now := time.Unix(1_800_000_000, 0)
	t.now = func() time.Time { return now }
	return t, &got
}

// Bản ghi thật của Claude Code 2.1.306: một sub-agent chạy nền (task_started, tool_result isAsync, task_notification).
func TestSubagentTrackerRealClaudeStream(t *testing.T) {
	data, err := os.ReadFile("testdata/claude-subagent-stream.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	tr, got := newTestTracker(nil)
	// Ghi từng mẩu 7 byte để dòng bị cắt ngang giữa các lần Write như pipe thật.
	for i := 0; i < len(data); i += 7 {
		if _, err := tr.Write(data[i:min(i+7, len(data))]); err != nil {
			t.Fatal(err)
		}
	}
	tr.finish()
	want := []SubagentEvent{
		{ID: "toolu_01RTV5nTrAKcEeSYMZqiNnPs", Phase: "start", Type: "general-purpose", Description: "count files", Status: "running", Depth: 1},
		{ID: "toolu_01RTV5nTrAKcEeSYMZqiNnPs", Phase: "end", Type: "general-purpose", Description: "count files", Status: "completed", Depth: 1, Tokens: ptr[int64](17974), ToolUses: ptr[int64](0), DurationMs: ptr[int64](1110)},
	}
	assertSubagentEvents(t, *got, want)
}

// Bản Claude cũ chạy sub-agent đồng bộ (tool Task, không có task_*): kết thúc là tool_result, sub-agent lồng nhau giữ
// đúng cha con, số liệu lấy từ tool_use_result hay cộng từ tin của sub-agent.
func TestSubagentTrackerSynchronousNested(t *testing.T) {
	lines := []string{
		`{"type":"system","subtype":"init","model":"claude-x"}`,
		`{"type":"assistant","parent_tool_use_id":null,"message":{"id":"m0","usage":{"input_tokens":1,"output_tokens":1},"content":[{"type":"tool_use","id":"toolu_A","name":"Task","input":{"subagent_type":"Explore","description":"đọc repo API_KEY=abcdef1234567890 ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa","prompt":"PROMPT-BI-MAT"}}]}}`,
		`{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":10},"content":[{"type":"tool_use","id":"toolu_B","name":"Task","input":{"subagent_type":"general-purpose","description":"con","prompt":"PROMPT-CON"}}]}}`,
		// Cùng message.id: không cộng hai lần.
		`{"type":"assistant","parent_tool_use_id":"toolu_A","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":10},"content":[{"type":"text","text":"x"}]}}`,
		`{"type":"assistant","parent_tool_use_id":"toolu_B","message":{"id":"m2","usage":{"input_tokens":50,"output_tokens":5},"content":[{"type":"tool_use","id":"toolu_C","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","parent_tool_use_id":"toolu_B","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_C","content":"a.txt"}]},"tool_use_result":"a.txt"}`,
		`{"type":"user","parent_tool_use_id":"toolu_A","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_B","content":[{"type":"text","text":"KET-QUA-CON"}]}]},"tool_use_result":{"status":"completed","content":[{"type":"text","text":"KET-QUA-CON"}],"totalTokens":999,"totalDurationMs":42,"totalToolUseCount":1}}`,
		`{"type":"user","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_A","is_error":true,"content":"Error: hỏng"}]},"tool_use_result":"Error: hỏng"}`,
		`{"type":"result","subtype":"success","result":"xong"}`,
	}
	tr, got := newTestTracker([]string{"secret-value-xyz"})
	if _, err := tr.Write([]byte(strings.Join(lines, "\n"))); err != nil {
		t.Fatal(err)
	}
	tr.finish()
	a := "toolu_A"
	want := []SubagentEvent{
		{ID: "toolu_A", Phase: "start", Type: "Explore", Description: "đọc repo API_KEY=[đã che] [đã che]", Status: "running", Depth: 1},
		{ID: "toolu_B", ParentID: &a, Phase: "start", Type: "general-purpose", Description: "con", Status: "running", Depth: 2},
		{ID: "toolu_B", ParentID: &a, Phase: "end", Type: "general-purpose", Description: "con", Status: "completed", Depth: 2, Tokens: ptr[int64](999), ToolUses: ptr[int64](1), DurationMs: ptr[int64](42)},
		// Không có số trong tool_use_result: token cộng theo message.id, tool đếm theo tool_use của sub-agent.
		{ID: "toolu_A", Phase: "end", Type: "Explore", Description: "đọc repo API_KEY=[đã che] [đã che]", Status: "failed", Depth: 1, Tokens: ptr[int64](110), ToolUses: ptr[int64](1), DurationMs: ptr[int64](0)},
	}
	assertSubagentEvents(t, *got, want)
	for _, e := range *got {
		b, _ := json.Marshal(e)
		for _, bad := range []string{"PROMPT", "KET-QUA", "abcdef1234567890", "ghp_", `"prompt"`, `"summary"`} {
			if strings.Contains(string(b), bad) {
				t.Fatalf("sự kiện lộ %q: %s", bad, b)
			}
		}
	}
}

// Run kết thúc mà sub-agent chưa có sự kiện kết thúc: đóng bằng "unknown" (FR-023); dòng cuối không có '\n' vẫn đọc.
func TestSubagentTrackerFinishMarksUnknown(t *testing.T) {
	tr, got := newTestTracker(nil)
	_, _ = tr.Write([]byte(`{"type":"system","subtype":"task_started","task_id":"t1","tool_use_id":"toolu_X","subagent_type":"Plan","description":"` + strings.Repeat("é", 200) + `","spawn_depth":3,"prompt":"p"}`))
	tr.finish()
	tr.finish()
	if len(*got) != 2 {
		t.Fatalf("sự kiện = %+v", *got)
	}
	start, end := (*got)[0], (*got)[1]
	if start.Phase != "start" || start.Depth != 3 || len([]rune(start.Description)) != subagentDescMax {
		t.Fatalf("start = %+v", start)
	}
	if end.Phase != "end" || end.Status != "unknown" || end.Tokens != nil {
		t.Fatalf("end = %+v", end)
	}
}

func TestSubagentTrackerKeepsStatusWithinContract(t *testing.T) {
	tr, got := newTestTracker(nil)
	_, _ = tr.Write([]byte(`{"type":"system","subtype":"task_notification","tool_use_id":"toolu_K","status":"stopped","summary":"tóm tắt"}` + "\n"))
	if len(*got) != 2 || (*got)[1].Status != "unknown" || (*got)[1].Phase != "end" {
		t.Fatalf("sự kiện = %+v", *got)
	}
	_, _ = tr.Write([]byte(`{"type":"system","subtype":"task_notification","tool_use_id":"toolu_L","status":"killed"}` + "\n"))
	if (*got)[3].Status != "killed" {
		t.Fatalf("sự kiện = %+v", *got)
	}
}

func TestClipUTF16(t *testing.T) {
	// Emoji là hai đơn vị UTF-16: zod đếm như vậy nên không được vượt.
	if got := clipUTF16("ab😀c", 3); got != "ab" {
		t.Fatalf("clip = %q", got)
	}
	if got := clipUTF16("abc", 3); got != "abc" {
		t.Fatalf("clip = %q", got)
	}
}

func TestStartSubagentsUnsupportedCLI(t *testing.T) {
	var events []Event
	sink := SinkFunc(func(e Event) error { events = append(events, e); return nil })
	if tr := startSubagents(Job{RunID: "r", Attempt: 1, CLI: "codex"}, sink); tr != nil {
		t.Fatal("codex không có tracker")
	}
	if len(events) != 1 || events[0].Type != "subagent" || events[0].Subagent.Phase != "unsupported" || events[0].Subagent.ID == "" {
		t.Fatalf("sự kiện = %+v", events)
	}
	events = nil
	tr := startSubagents(Job{RunID: "r", Attempt: 1, CLI: "claude"}, sink)
	if tr == nil || len(events) != 0 {
		t.Fatalf("claude: tracker %v, sự kiện %+v", tr, events)
	}
}

func assertSubagentEvents(t *testing.T, got, want []SubagentEvent) {
	t.Helper()
	g, _ := json.Marshal(got)
	w, _ := json.Marshal(want)
	if string(g) != string(w) {
		t.Fatalf("sự kiện\n got: %s\nwant: %s", g, w)
	}
}
