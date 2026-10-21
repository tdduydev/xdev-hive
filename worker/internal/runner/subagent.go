package runner

import (
	"bytes"
	"encoding/json"
	"sync"
	"time"
	"unicode/utf16"
)

// SubagentEvent là dữ liệu của run_event "subagent" (specs/028 FR-020–FR-023), khớp subagentEventData của contracts.
// Chỉ có siêu dữ liệu: không có prompt, summary hay output của sub-agent (ranh giới dữ liệu specs/027).
type SubagentEvent struct {
	ID          string  `json:"id"`
	ParentID    *string `json:"parentId"`
	Phase       string  `json:"phase"`
	Type        string  `json:"type"`
	Description string  `json:"description"`
	Status      string  `json:"status"`
	Depth       int     `json:"depth"`
	Tokens      *int64  `json:"tokens,omitempty"`
	ToolUses    *int64  `json:"toolUses,omitempty"`
	DurationMs  *int64  `json:"durationMs,omitempty"`
}

// Giới hạn theo hợp đồng: zod đếm độ dài theo đơn vị UTF-16 nên cắt theo đơn vị đó, không theo byte.
const (
	subagentIDMax   = 64
	subagentTypeMax = 64
	subagentDescMax = 120
	subagentMaxDep  = 10
)

// subagentUnsupportedID là id của sự kiện "unsupported": hợp đồng đòi id khác rỗng dù không có sub-agent nào.
const subagentUnsupportedID = "unsupported"

// subagentTools là tên tool gọi sub-agent của Claude Code: "Agent" từ bản 2.1, "Task" ở bản cũ.
var subagentTools = map[string]bool{"Agent": true, "Task": true}

type subagent struct {
	id      string
	parent  *string
	typ     string
	desc    string
	depth   int
	started time.Time
	ended   bool
	// msgs giữ token theo message.id như claudeUsage: một lời gọi API có thể sinh nhiều tin cùng id.
	msgs  map[string]int64
	tools map[string]bool
}

// subagentTracker là io.Writer nhận stdout stream-json của Claude và gửi sự kiện sub-agent bắt đầu, kết thúc. Theo dòng
// như meter: một lần Write có thể chứa nửa dòng.
type subagentTracker struct {
	emit   func(SubagentEvent) error
	secret []string
	now    func() time.Time

	// mu giữ cả lúc emit để sự kiện ra đúng thứ tự dòng của stdout.
	mu       sync.Mutex
	partial  []byte
	skipping bool
	subs     map[string]*subagent
	order    []string
	done     bool
}

func newSubagentTracker(secret []string, emit func(SubagentEvent) error) *subagentTracker {
	return &subagentTracker{emit: emit, secret: secret, now: time.Now, subs: map[string]*subagent{}}
}

func (t *subagentTracker) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	rest := p
	for len(rest) > 0 {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			if !t.skipping {
				t.partial = append(t.partial, rest...)
				if len(t.partial) > maxLine {
					t.partial, t.skipping = nil, true
				}
			}
			break
		}
		if !t.skipping {
			t.line(bytes.TrimSpace(append(t.partial, rest[:i]...)))
		}
		t.partial, t.skipping = t.partial[:0], false
		rest = rest[i+1:]
	}
	// Lỗi gửi không làm hỏng stdout của CLI: sự kiện sub-agent chỉ để xem, không quyết định kết quả run.
	return len(p), nil
}

// finish đọc nốt dòng cuối rồi đóng mọi sub-agent chưa kết thúc bằng "unknown" (FR-023). Gọi nhiều lần, hay gọi trên
// nil (CLI không hỗ trợ), không sao.
func (t *subagentTracker) finish() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return
	}
	if len(t.partial) > 0 && !t.skipping {
		t.line(bytes.TrimSpace(t.partial))
	}
	t.partial = nil
	t.done = true
	for _, id := range t.order {
		if s := t.subs[id]; !s.ended {
			t.end(s, "unknown", nil, nil, nil)
		}
	}
}

type subagentContent struct {
	Type      string `json:"type"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ToolUseID string `json:"tool_use_id"`
	IsError   bool   `json:"is_error"`
	Input     *struct {
		SubagentType string `json:"subagent_type"`
		Description  string `json:"description"`
	} `json:"input"`
}

// subagentLine chỉ đọc các trường cần; prompt, summary, nội dung tool_result không được giải mã.
type subagentLine struct {
	Type            string  `json:"type"`
	Subtype         string  `json:"subtype"`
	ParentToolUseID *string `json:"parent_tool_use_id"`
	Message         *struct {
		ID      string          `json:"id"`
		Usage   *claudeAPIUsage `json:"usage"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
	// task_started, task_notification
	ToolUseID    string `json:"tool_use_id"`
	SubagentType string `json:"subagent_type"`
	Description  string `json:"description"`
	SpawnDepth   int    `json:"spawn_depth"`
	Status       string `json:"status"`
	Usage        *struct {
		TotalTokens *int64 `json:"total_tokens"`
		ToolUses    *int64 `json:"tool_uses"`
		DurationMs  *int64 `json:"duration_ms"`
	} `json:"usage"`
	// tool_use_result là object với Agent/Task nhưng là chuỗi hay mảng với tool khác: giữ thô, giải mã sau.
	ToolUseResult json.RawMessage `json:"tool_use_result"`
}

type subagentToolResult struct {
	IsAsync           bool   `json:"isAsync"`
	Status            string `json:"status"`
	TotalTokens       *int64 `json:"totalTokens"`
	TotalDurationMs   *int64 `json:"totalDurationMs"`
	TotalToolUseCount *int64 `json:"totalToolUseCount"`
}

func (t *subagentTracker) line(line []byte) {
	if t.done || len(line) == 0 {
		return
	}
	// Phần lớn dòng không liên quan: bỏ trước khi giải mã khi chưa có sub-agent nào.
	if len(t.subs) == 0 && !bytes.Contains(line, []byte(`"tool_use"`)) && !bytes.Contains(line, []byte(`"task_`)) {
		return
	}
	var l subagentLine
	if json.Unmarshal(line, &l) != nil {
		return
	}
	switch l.Type {
	case "assistant":
		t.assistant(l)
	case "user":
		t.user(l)
	case "system":
		switch l.Subtype {
		case "task_started":
			if l.ToolUseID != "" {
				t.start(l.ToolUseID, nil, l.SubagentType, l.Description, l.SpawnDepth)
			}
		case "task_notification":
			if l.ToolUseID == "" {
				return
			}
			s := t.start(l.ToolUseID, nil, l.SubagentType, l.Description, 0)
			if s.ended {
				return
			}
			var tokens, tools, dur *int64
			if l.Usage != nil {
				tokens, tools, dur = l.Usage.TotalTokens, l.Usage.ToolUses, l.Usage.DurationMs
			}
			t.end(s, subagentStatus(l.Status), tokens, tools, dur)
		}
	}
}

func (t *subagentTracker) contents(l subagentLine) []subagentContent {
	if l.Message == nil || len(l.Message.Content) == 0 {
		return nil
	}
	var c []subagentContent
	// content của tin user có thể là chuỗi: khi đó không có khối nào cần đọc.
	_ = json.Unmarshal(l.Message.Content, &c)
	return c
}

func (t *subagentTracker) assistant(l subagentLine) {
	content := t.contents(l)
	if l.ParentToolUseID != nil && l.Message != nil {
		if s := t.subs[*l.ParentToolUseID]; s != nil && !s.ended {
			if l.Message.ID != "" && l.Message.Usage != nil {
				u := l.Message.Usage
				s.msgs[l.Message.ID] = max(s.msgs[l.Message.ID], u.InputTokens+u.OutputTokens+u.CacheReadInputTokens+u.CacheCreationInputTokens)
			}
			for _, b := range content {
				if b.Type == "tool_use" && b.ID != "" {
					s.tools[b.ID] = true
				}
			}
		}
	}
	for _, b := range content {
		if b.Type != "tool_use" || !subagentTools[b.Name] || b.ID == "" {
			continue
		}
		var typ, desc string
		if b.Input != nil {
			typ, desc = b.Input.SubagentType, b.Input.Description
		}
		t.start(b.ID, l.ParentToolUseID, typ, desc, 0)
	}
}

func (t *subagentTracker) user(l subagentLine) {
	var res subagentToolResult
	if len(l.ToolUseResult) > 0 {
		_ = json.Unmarshal(l.ToolUseResult, &res)
	}
	for _, b := range t.contents(l) {
		if b.Type != "tool_result" {
			continue
		}
		s := t.subs[b.ToolUseID]
		if s == nil || s.ended {
			continue
		}
		// Sub-agent chạy nền: tool_result chỉ báo đã khởi chạy, kết thúc là task_notification.
		if res.IsAsync || res.Status == "async_launched" {
			continue
		}
		status := "completed"
		switch {
		case b.IsError:
			status = "failed"
		case res.Status != "":
			status = subagentStatus(res.Status)
		}
		t.end(s, status, res.TotalTokens, res.TotalToolUseCount, res.TotalDurationMs)
	}
}

// start ghi sub-agent và gửi sự kiện start nếu chưa có: tool_use và task_started cùng nói về một lần gọi.
func (t *subagentTracker) start(id string, parent *string, typ, desc string, spawnDepth int) *subagent {
	if s := t.subs[id]; s != nil {
		return s
	}
	var p *string
	depth := 1
	if parent != nil && *parent != "" {
		v := clipUTF16(*parent, subagentIDMax)
		p = &v
		depth = 2
		if ps := t.subs[*parent]; ps != nil {
			depth = ps.depth + 1
		}
	}
	if spawnDepth > 0 {
		depth = spawnDepth
	}
	depth = min(depth, subagentMaxDep)
	s := &subagent{
		id: id, parent: p, depth: depth, started: t.now(), msgs: map[string]int64{}, tools: map[string]bool{},
		typ:  clipUTF16(typ, subagentTypeMax),
		desc: clipUTF16(redactSecrets(desc, t.secret), subagentDescMax),
	}
	t.subs[id] = s
	t.order = append(t.order, id)
	_ = t.emit(SubagentEvent{ID: clipUTF16(id, subagentIDMax), ParentID: p, Phase: "start", Type: s.typ, Description: s.desc, Status: "running", Depth: depth})
	return s
}

// end gửi sự kiện end. Số nào CLI không báo thì tự tính từ tin của sub-agent, như claudeUsage cộng theo message.id.
func (t *subagentTracker) end(s *subagent, status string, tokens, tools, dur *int64) {
	s.ended = true
	if tokens == nil && len(s.msgs) > 0 {
		var sum int64
		for _, v := range s.msgs {
			sum += v
		}
		tokens = &sum
	}
	if tools == nil && len(s.tools) > 0 {
		n := int64(len(s.tools))
		tools = &n
	}
	if dur == nil {
		d := max(0, t.now().Sub(s.started).Milliseconds())
		dur = &d
	}
	// Lặp lại loại và mô tả (đã che) ở end: hub gộp theo seq, gói start có thể đã bị bỏ khi hub thiếu cờ lúc đó.
	_ = t.emit(SubagentEvent{
		ID:          clipUTF16(s.id, subagentIDMax),
		ParentID:    s.parent,
		Phase:       "end",
		Type:        s.typ,
		Description: s.desc,
		Status:      status,
		Depth:       s.depth,
		Tokens:      nonNegative(tokens),
		ToolUses:    nonNegative(tools),
		DurationMs:  nonNegative(dur),
	})
}

func nonNegative(v *int64) *int64 {
	if v == nil || *v < 0 {
		return nil
	}
	return v
}

// subagentStatus đổi trạng thái của Claude về tập trạng thái của hợp đồng; lạ thì "unknown" để hub không từ chối gói.
func subagentStatus(s string) string {
	switch s {
	case "completed", "failed", "killed":
		return s
	}
	return "unknown"
}

// clipUTF16 cắt chuỗi để độ dài UTF-16 (cách zod đếm) không quá n, không cắt giữa một ký tự.
func clipUTF16(s string, n int) string {
	units := 0
	for i, r := range s {
		w := len(utf16.Encode([]rune{r}))
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// unsupportedSubagents là sự kiện duy nhất cho CLI chưa đọc được sub-agent, để cây ghi "không theo dõi được" thay vì
// hiểu là run không gọi sub-agent nào.
func unsupportedSubagents(cli string) SubagentEvent {
	return SubagentEvent{ID: subagentUnsupportedID, Phase: "unsupported", Type: clipUTF16(cli, subagentTypeMax), Status: "unknown"}
}
