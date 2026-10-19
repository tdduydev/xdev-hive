package tokenreport

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
	"time"
)

// forEachLine đọc JSONL theo luồng, không giới hạn độ dài dòng (output tool có thể rất lớn).
func forEachLine(path string, fn func([]byte)) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if line = bytes.TrimSpace(line); len(line) > 0 {
			fn(line)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

// decodeLine bỏ dòng ghi dở khi CLI đang chạy (lỗi cú pháp). Lệch kiểu một trường thì vẫn dùng các trường còn lại,
// như bản TypeScript đọc `?.` lỏng.
func decodeLine(line []byte, v any) bool {
	err := json.Unmarshal(line, v)
	if err == nil {
		return true
	}
	var typeErr *json.UnmarshalTypeError
	return errors.As(err, &typeErr)
}

func parseTime(s string) time.Time {
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}

type claudeUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheCreation            *struct {
		Ephemeral1h *int64 `json:"ephemeral_1h_input_tokens"`
		Ephemeral5m *int64 `json:"ephemeral_5m_input_tokens"`
	} `json:"cache_creation"`
}

type claudeBlock struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	ToolUseID string          `json:"tool_use_id"`
	Input     json.RawMessage `json:"input"`
	Content   json.RawMessage `json:"content"`
}

type claudeLine struct {
	Type       string `json:"type"`
	Subtype    string `json:"subtype"`
	Cwd        string `json:"cwd"`
	Entrypoint string `json:"entrypoint"`
	Version    string `json:"version"`
	Timestamp  string `json:"timestamp"`
	RequestID  string `json:"requestId"`
	UUID       string `json:"uuid"`
	Attachment *struct {
		Type    string `json:"type"`
		Command string `json:"command"`
		Files   []struct {
			Type    string `json:"type"`
			Content string `json:"content"`
		} `json:"files"`
	} `json:"attachment"`
	Message *struct {
		ID      string          `json:"id"`
		Model   string          `json:"model"`
		Usage   *claudeUsage    `json:"usage"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type toolInput struct {
	Command  string          `json:"command"`
	FilePath *string         `json:"file_path"`
	Offset   json.RawMessage `json:"offset"`
	Limit    json.RawMessage `json:"limit"`
}

// scalarText in số/chuỗi JSON như `${x ?? ""}` của JS, để khoá đọc lại file giống bản TypeScript.
func scalarText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var v any
	if json.Unmarshal(raw, &v) != nil || v == nil {
		return ""
	}
	return fmt.Sprint(v)
}

// textLength đếm ký tự của nội dung tool_result. Ảnh tính theo cỡ base64 / 4 cho có bậc độ lớn; không cố đoán token ảnh.
func textLength(raw json.RawMessage) float64 {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 {
		return 0
	}
	switch raw[0] {
	case '"':
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return float64(jsLen(s))
		}
	case '[':
		var blocks []struct {
			Type   string  `json:"type"`
			Text   *string `json:"text"`
			Source *struct {
				Data string `json:"data"`
			} `json:"source"`
		}
		_ = json.Unmarshal(raw, &blocks)
		n := 0.0
		for _, b := range blocks {
			if b.Text != nil {
				n += float64(jsLen(*b.Text))
			} else if b.Type == "image" && b.Source != nil {
				n += float64(jsLen(b.Source.Data)) / 4
			}
		}
		return n
	}
	return 0
}

type pendingTool struct {
	name  string
	key   string
	chars float64
	at    int
}

type toolRef struct {
	name   string
	key    string
	reread bool
	at     int
}

// editState nhớ usage trước message vừa tính, vì khối tool_use sửa file có thể tới ở dòng sau của cùng message.id,
// khi usage của message đó đã được cộng.
type editState struct {
	lastID string
	before usageMark
}

func readClaude(path, account string) (*session, error) {
	s := newSession("claude", account)
	seen := map[string]bool{}
	toolName := map[string]toolRef{}
	readCount := map[string]int{}
	var edits editState
	// Lượt gọi API (đã gộp theo message.id) của từng output tool, để tính phần bị đọc lại tới lần nén kế tiếp.
	var pending []pendingTool
	var cwd, entrypoint string
	settle := func(until int) {
		for _, p := range pending {
			carried := p.chars * float64(max(0, until-p.at))
			bump(s.Tools, p.name, p.chars, carried)
			if p.name == "Bash" {
				bump(s.Bash, p.key, p.chars, carried)
			}
		}
		pending = nil
	}
	err := forEachLine(path, func(line []byte) {
		var o claudeLine
		if !decodeLine(line, &o) {
			return
		}
		if s.Start.IsZero() && o.Timestamp != "" {
			s.Start = parseTime(o.Timestamp)
		}
		if o.Cwd != "" && cwd == "" {
			cwd = o.Cwd
		}
		if o.Entrypoint != "" && entrypoint == "" {
			entrypoint = o.Entrypoint
		}
		if o.Version != "" {
			s.Versions = addUnique(s.Versions, o.Version)
		}
		switch o.Type {
		case "system":
			if o.Subtype == "compact_boundary" {
				s.Compactions++
				settle(s.Calls)
			}
		case "attachment":
			a := o.Attachment
			if a == nil {
				return
			}
			if a.Type == "instructions" {
				for _, f := range a.Files {
					k := f.Type
					if k == "" {
						k = "?"
					}
					s.Memory[k] += jsLen(f.Content)
				}
			}
			if a.Type == "hook_success" || a.Type == "hook_non_blocking_error" {
				if rtkHook.MatchString(a.Command) {
					s.RTK = true
				}
				if guardHook.MatchString(a.Command) {
					s.Guard = true
				}
			}
		case "assistant":
			if o.Message == nil {
				return
			}
			claudeAssistant(s, &o, seen, toolName, readCount, &edits)
		case "user":
			if o.Message == nil {
				return
			}
			c := bytes.TrimSpace(o.Message.Content)
			var blocks []claudeBlock
			if len(c) == 0 || c[0] != '[' || json.Unmarshal(c, &blocks) != nil {
				return
			}
			for _, b := range blocks {
				if b.Type != "tool_result" {
					continue
				}
				t, ok := toolName[b.ToolUseID]
				chars := textLength(b.Content)
				name, key, at := "?", "?", s.Calls
				if ok {
					name, key, at = t.name, t.key, t.at
				}
				pending = append(pending, pendingTool{name: name, key: key, chars: chars, at: at})
				if ok && t.reread {
					s.RereadChars += chars
				}
			}
		}
	})
	if err != nil {
		return nil, err
	}
	settle(s.Calls)
	s.Source = classify(cwd, entrypoint == "sdk-cli")
	s.Cwd = cwd
	return s, nil
}

func claudeAssistant(s *session, o *claudeLine, seen map[string]bool, toolName map[string]toolRef, readCount map[string]int, edits *editState) {
	m := o.Message
	id := m.ID
	if id == "" {
		id = o.RequestID
	}
	if id == "" {
		id = o.UUID
	}
	var content []claudeBlock
	if c := bytes.TrimSpace(m.Content); len(c) > 0 && c[0] == '[' {
		_ = json.Unmarshal(c, &content)
	}
	for _, b := range content {
		if b.Type != "tool_use" {
			continue
		}
		name := b.Name
		if name == "" {
			name = "?"
		}
		var in toolInput
		_ = json.Unmarshal(b.Input, &in)
		key := name
		if name == "Bash" {
			key = bashKey(in.Command)
		}
		reread := false
		if name == "Read" && in.FilePath != nil {
			s.Reads++
			rk := *in.FilePath + ":" + scalarText(in.Offset) + ":" + scalarText(in.Limit)
			readCount[rk]++
			reread = readCount[rk] > 1
			if reread {
				s.Rereads++
			}
		}
		toolName[b.ID] = toolRef{name: name, key: key, reread: reread, at: s.Calls + 1}
		if editTools[name] && s.Edit == nil {
			// Message chưa tính usage: số hiện tại đã không gồm nó. Message đã tính: lấy số trước khi cộng nó.
			mark := s.mark()
			if seen[id] && id == edits.lastID {
				mark = edits.before
			}
			s.Edit = &mark
		}
	}
	if seen[id] {
		return
	}
	seen[id] = true
	u := m.Usage
	if u == nil {
		return
	}
	edits.lastID, edits.before = id, s.mark()
	s.Calls++
	if m.Model != "" && m.Model != "<synthetic>" {
		s.Models = addUnique(s.Models, m.Model)
	}
	var w1h, w5m int64
	if cc := u.CacheCreation; cc != nil && cc.Ephemeral1h != nil {
		w1h = *cc.Ephemeral1h
	}
	if cc := u.CacheCreation; cc != nil && cc.Ephemeral5m != nil {
		w5m = *cc.Ephemeral5m
	} else {
		w5m = u.CacheCreationInputTokens - w1h
	}
	s.Input += u.InputTokens
	s.Output += u.OutputTokens
	s.CacheRead += u.CacheReadInputTokens
	s.CacheWrite5m += w5m
	s.CacheWrite1h += w1h
	context := u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens
	s.PeakContext = max(s.PeakContext, context)
	if s.FirstContext == 0 {
		s.FirstContext = context
	}
}

type codexUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
}

type codexPayload struct {
	Type       string          `json:"type"`
	Cwd        string          `json:"cwd"`
	Originator string          `json:"originator"`
	CLIVersion string          `json:"cli_version"`
	Model      string          `json:"model"`
	CallID     string          `json:"call_id"`
	Name       string          `json:"name"`
	Output     json.RawMessage `json:"output"`
	Info       *struct {
		Total *codexUsage `json:"total_token_usage"`
		Last  *codexUsage `json:"last_token_usage"`
	} `json:"info"`
}

func readCodex(path, account string) (*session, error) {
	s := newSession("codex", account)
	var last *codexUsage
	callName := map[string]string{}
	var cwd, originator string
	var pending []pendingTool
	err := forEachLine(path, func(line []byte) {
		var o struct {
			Type      string       `json:"type"`
			Timestamp string       `json:"timestamp"`
			Payload   codexPayload `json:"payload"`
		}
		if !decodeLine(line, &o) {
			return
		}
		p := o.Payload
		if s.Start.IsZero() && o.Timestamp != "" {
			s.Start = parseTime(o.Timestamp)
		}
		if o.Type == "session_meta" {
			cwd, originator = p.Cwd, p.Originator
			if p.CLIVersion != "" {
				s.Versions = addUnique(s.Versions, p.CLIVersion)
			}
		}
		if o.Type == "turn_context" && p.Model != "" {
			s.Models = addUnique(s.Models, p.Model)
		}
		if p.Type == "token_count" && p.Info != nil && p.Info.Total != nil {
			s.Calls++
			last = p.Info.Total
			if l := p.Info.Last; l != nil {
				s.PeakContext = max(s.PeakContext, l.InputTokens)
				if s.FirstContext == 0 {
					s.FirstContext = l.InputTokens
				}
			}
		}
		switch p.Type {
		case "function_call", "custom_tool_call", "local_shell_call":
			name := p.Name
			if name == "" {
				name = p.Type
			}
			callName[p.CallID] = name
		case "function_call_output", "custom_tool_call_output":
			name := callName[p.CallID]
			if name == "" {
				name = "?"
			}
			pending = append(pending, pendingTool{name: name, chars: codexOutputLength(p.Output), at: s.Calls})
		}
	})
	if err != nil {
		return nil, err
	}
	for _, t := range pending {
		bump(s.Tools, t.name, t.chars, t.chars*float64(max(0, s.Calls-t.at)))
	}
	if last != nil {
		// Codex tính input gồm cả phần cache; tách ra cho cùng nghĩa với Claude.
		s.CacheRead = last.CachedInputTokens
		s.Input = last.InputTokens - s.CacheRead
		s.CacheWrite5m = last.CacheWriteInputTokens
		s.Output = last.OutputTokens + last.ReasoningOutputTokens
	}
	s.Source = classify(cwd, originator == "codex_exec")
	s.Cwd = cwd
	return s, nil
}

// codexOutputLength: output dạng chuỗi đếm thẳng, dạng khác đếm theo JSON gọn như JSON.stringify(out ?? "").
func codexOutputLength(raw json.RawMessage) float64 {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return 2
	}
	if raw[0] == '"' {
		var s string
		if json.Unmarshal(raw, &s) == nil {
			return float64(jsLen(s))
		}
	}
	var buf bytes.Buffer
	if json.Compact(&buf, raw) != nil {
		return 0
	}
	return float64(jsLen(strings.TrimSpace(buf.String())))
}

var (
	rtkHook   = regexp.MustCompile(`\brtk\b.*hook`)
	guardHook = regexp.MustCompile(`hive-worker.*hook|hook (pre|post)-tool`)
)
