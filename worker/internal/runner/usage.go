package runner

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Usage là token và chi phí luỹ kế của một lần chạy CLI, gửi lên hub trong run_event "cost".
// CostUSD, Turns, Model là nil khi CLI không báo (Codex và Antigravity không báo USD, Gemini chưa đọc).
type Usage struct {
	InputTokens      int64    `json:"inputTokens"`
	OutputTokens     int64    `json:"outputTokens"`
	CacheReadTokens  int64    `json:"cacheReadTokens"`
	CacheWriteTokens int64    `json:"cacheWriteTokens"`
	CostUSD          *float64 `json:"costUsd"`
	Turns            *int     `json:"turns"`
	Model            *string  `json:"model"`
	// AccountID là id gói (tài khoản CLI) đã chạy run, để hub tính token theo gói; rỗng khi dùng đăng nhập mặc định.
	AccountID string `json:"accountId,omitempty"`
}

func (u Usage) equal(o Usage) bool {
	return u.InputTokens == o.InputTokens && u.OutputTokens == o.OutputTokens &&
		u.CacheReadTokens == o.CacheReadTokens && u.CacheWriteTokens == o.CacheWriteTokens &&
		eqPtr(u.CostUSD, o.CostUSD) && eqPtr(u.Turns, o.Turns) && eqPtr(u.Model, o.Model)
}

func eqPtr[T comparable](a, b *T) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

// UsageParser đọc từng dòng stdout của CLI và giữ usage luỹ kế. Line trả true khi usage đổi.
type UsageParser interface {
	Line(line []byte) bool
	Usage() Usage
}

// NewUsageParser trả parser theo CLI, nil khi chưa đọc được usage của CLI đó (gemini).
func NewUsageParser(cli string) UsageParser {
	switch cli {
	case "claude":
		return &claudeUsage{msgs: map[string]tokenCounts{}}
	case "codex":
		return &codexUsage{}
	case "antigravity":
		return &antigravityUsage{steps: map[int]tokenCounts{}}
	}
	return nil
}

type tokenCounts struct{ in, out, cacheRead, cacheWrite int64 }

func (t tokenCounts) max(o tokenCounts) tokenCounts {
	return tokenCounts{max(t.in, o.in), max(t.out, o.out), max(t.cacheRead, o.cacheRead), max(t.cacheWrite, o.cacheWrite)}
}

// ---- Claude: `-p --output-format stream-json --verbose` ----------------------------------------------------------

type claudeAPIUsage struct {
	InputTokens              int64 `json:"input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
}

func (u claudeAPIUsage) counts() tokenCounts {
	return tokenCounts{u.InputTokens, u.OutputTokens, u.CacheReadInputTokens, u.CacheCreationInputTokens}
}

type claudeLine struct {
	Type    string `json:"type"`
	Model   string `json:"model"`
	Message *struct {
		ID    string          `json:"id"`
		Model string          `json:"model"`
		Usage *claudeAPIUsage `json:"usage"`
	} `json:"message"`
	Usage        *claudeAPIUsage `json:"usage"`
	TotalCostUSD *float64        `json:"total_cost_usd"`
	NumTurns     *int            `json:"num_turns"`
	ModelUsage   map[string]struct {
		InputTokens              int64   `json:"inputTokens"`
		OutputTokens             int64   `json:"outputTokens"`
		CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
		CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
		CostUSD                  float64 `json:"costUSD"`
	} `json:"modelUsage"`
}

// claudeUsage cộng usage của từng lời gọi API (tin assistant) trong lúc chạy, rồi lấy số của tin result ở cuối.
// Một lời gọi API có thể sinh nhiều tin assistant cùng message.id (mỗi khối nội dung một tin), nên giữ theo id.
type claudeUsage struct {
	msgs   map[string]tokenCounts
	order  []string
	final  *tokenCounts
	cost   *float64
	turns  *int
	model  string
	cached Usage
}

func (c *claudeUsage) Line(line []byte) bool {
	var l claudeLine
	if json.Unmarshal(line, &l) != nil {
		return false
	}
	switch l.Type {
	case "system":
		if c.model == "" {
			c.model = l.Model
		}
	case "assistant":
		if l.Message == nil || l.Message.Usage == nil || l.Message.ID == "" {
			return false
		}
		if l.Message.Model != "" {
			c.model = l.Message.Model
		}
		prev, seen := c.msgs[l.Message.ID]
		if !seen {
			c.order = append(c.order, l.Message.ID)
		}
		c.msgs[l.Message.ID] = prev.max(l.Message.Usage.counts())
	case "result":
		// Khi Claude tự dừng vì --max-budget-usd, result.usage toàn số 0 còn modelUsage mới có số thật: lấy số lớn
		// nhất của từng trường để usage không bao giờ giảm.
		var f tokenCounts
		if l.Usage != nil {
			f = l.Usage.counts()
		}
		var sum tokenCounts
		var sumCost float64
		for _, m := range l.ModelUsage {
			sum.in += m.InputTokens
			sum.out += m.OutputTokens
			sum.cacheRead += m.CacheReadInputTokens
			sum.cacheWrite += m.CacheCreationInputTokens
			sumCost += m.CostUSD
		}
		f = f.max(sum)
		c.final = &f
		cost := sumCost
		if l.TotalCostUSD != nil {
			cost = max(cost, *l.TotalCostUSD)
		}
		if l.TotalCostUSD != nil || len(l.ModelUsage) > 0 {
			c.cost = &cost
		}
		if l.NumTurns != nil {
			t := *l.NumTurns
			c.turns = &t
		}
	default:
		return false
	}
	next := c.compute()
	changed := !next.equal(c.cached)
	c.cached = next
	return changed
}

func (c *claudeUsage) compute() Usage {
	var t tokenCounts
	for _, id := range c.order {
		m := c.msgs[id]
		t.in += m.in
		t.out += m.out
		t.cacheRead += m.cacheRead
		t.cacheWrite += m.cacheWrite
	}
	if c.final != nil {
		t = t.max(*c.final)
	}
	u := Usage{InputTokens: t.in, OutputTokens: t.out, CacheReadTokens: t.cacheRead, CacheWriteTokens: t.cacheWrite}
	if c.cost != nil {
		v := *c.cost
		u.CostUSD = &v
	}
	// Trước khi có result, mỗi lời gọi API là một lượt (khớp num_turns của result trong fixture).
	turns := len(c.order)
	if c.turns != nil {
		turns = max(turns, *c.turns)
	}
	if turns > 0 {
		u.Turns = &turns
	}
	if c.model != "" {
		m := c.model
		u.Model = &m
	}
	return u
}

func (c *claudeUsage) Usage() Usage { return c.cached }

// ---- Codex: `exec --json` ----------------------------------------------------------------------------------------

type codexLine struct {
	Type  string `json:"type"`
	Usage *struct {
		InputTokens           int64 `json:"input_tokens"`
		CachedInputTokens     int64 `json:"cached_input_tokens"`
		CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
		OutputTokens          int64 `json:"output_tokens"`
	} `json:"usage"`
}

// codexUsage cộng usage của mỗi sự kiện turn.completed. Codex chỉ báo usage khi xong lượt và không báo USD, nên
// CostUSD để nil; lượt của codex exec là lượt của người dùng (thường chỉ một) nên Turns cũng để nil.
type codexUsage struct{ u Usage }

func (c *codexUsage) Line(line []byte) bool {
	var l codexLine
	if json.Unmarshal(line, &l) != nil || l.Type != "turn.completed" || l.Usage == nil {
		return false
	}
	// input_tokens của OpenAI đã gồm phần đọc từ cache; tách ra để InputTokens cùng nghĩa với Claude (chưa cache).
	c.u.InputTokens += max(0, l.Usage.InputTokens-l.Usage.CachedInputTokens)
	c.u.CacheReadTokens += l.Usage.CachedInputTokens
	c.u.CacheWriteTokens += l.Usage.CacheWriteInputTokens
	c.u.OutputTokens += l.Usage.OutputTokens
	return l.Usage.InputTokens+l.Usage.CachedInputTokens+l.Usage.CacheWriteInputTokens+l.Usage.OutputTokens > 0
}

func (c *codexUsage) Usage() Usage { return c.u }

// ---- Antigravity: `agy -p --output-format stream-json` ------------------------------------------------------------

type antigravityAPIUsage struct {
	InputTokens     int64 `json:"input_tokens"`
	OutputTokens    int64 `json:"output_tokens"`
	CacheReadTokens int64 `json:"cache_read_tokens"`
}

// counts tách phần đọc từ cache khỏi input_tokens như Codex, theo usageMetadata của Gemini API (promptTokenCount gồm cả
// phần cache). output_tokens đã gồm thinking_tokens: mẫu ghi từ agy 1.3.3 có total_tokens = input_tokens + output_tokens.
func (u antigravityAPIUsage) counts() tokenCounts {
	return tokenCounts{in: max(0, u.InputTokens-u.CacheReadTokens), out: u.OutputTokens, cacheRead: u.CacheReadTokens}
}

type antigravityLine struct {
	Event string `json:"event"`
	Init  *struct {
		Model string `json:"model"`
	} `json:"init"`
	StepUpdate *struct {
		StepIndex int                  `json:"step_index"`
		Usage     *antigravityAPIUsage `json:"usage"`
	} `json:"step_update"`
	Result *struct {
		Usage *antigravityAPIUsage `json:"usage"`
	} `json:"result"`
}

// antigravityUsage cộng usage của từng bước agent_response (step_update có usage) theo step_index, rồi lấy số của sự
// kiện result ở cuối, là tổng các bước. num_turns của result là lượt của người dùng (một với agy -p) nên Turns để nil.
type antigravityUsage struct {
	steps  map[int]tokenCounts
	final  *tokenCounts
	model  string
	cached Usage
}

func (a *antigravityUsage) Line(line []byte) bool {
	var l antigravityLine
	if json.Unmarshal(line, &l) != nil {
		return false
	}
	switch {
	case l.Event == "init" && l.Init != nil:
		a.model = l.Init.Model
	case l.Event == "step_update" && l.StepUpdate != nil && l.StepUpdate.Usage != nil:
		a.steps[l.StepUpdate.StepIndex] = a.steps[l.StepUpdate.StepIndex].max(l.StepUpdate.Usage.counts())
	case l.Event == "result" && l.Result != nil && l.Result.Usage != nil:
		f := l.Result.Usage.counts()
		a.final = &f
	default:
		return false
	}
	var t tokenCounts
	for _, s := range a.steps {
		t.in += s.in
		t.out += s.out
		t.cacheRead += s.cacheRead
	}
	if a.final != nil {
		t = t.max(*a.final)
	}
	next := Usage{InputTokens: t.in, OutputTokens: t.out, CacheReadTokens: t.cacheRead}
	if a.model != "" {
		m := a.model
		next.Model = &m
	}
	changed := !next.equal(a.cached)
	a.cached = next
	return changed
}

func (a *antigravityUsage) Usage() Usage { return a.cached }

// ---- Trần chi phí ------------------------------------------------------------------------------------------------

// Budget là trần của một run do hub gửi trong spec; trường nil là không giới hạn.
type Budget struct {
	MaxCostUSD *float64 `json:"maxCostUsd,omitempty"`
	MaxTokens  *int64   `json:"maxTokens,omitempty"`
	MaxTurns   *int     `json:"maxTurns,omitempty"`
}

// BillableTokens là số token tính vào maxTokens. Không tính token đọc từ cache: chúng lặp lại mỗi lượt và rẻ hơn
// nhiều, tính vào thì trần token cạn sau vài chục lượt dù chi phí còn thấp.
func (u Usage) BillableTokens() int64 { return u.InputTokens + u.OutputTokens + u.CacheWriteTokens }

// Exceeded trả lý do (tiếng Việt) khi usage vượt trần, chuỗi rỗng khi chưa.
func (b Budget) Exceeded(u Usage) string {
	var parts []string
	if b.MaxCostUSD != nil && u.CostUSD != nil && *u.CostUSD > *b.MaxCostUSD {
		parts = append(parts, fmt.Sprintf("chi phí $%.4f > $%.4f", *u.CostUSD, *b.MaxCostUSD))
	}
	if b.MaxTokens != nil && u.BillableTokens() > *b.MaxTokens {
		parts = append(parts, fmt.Sprintf("token %d > %d", u.BillableTokens(), *b.MaxTokens))
	}
	if b.MaxTurns != nil && u.Turns != nil && *u.Turns > *b.MaxTurns {
		parts = append(parts, fmt.Sprintf("số lượt %d > %d", *u.Turns, *b.MaxTurns))
	}
	return strings.Join(parts, ", ")
}
