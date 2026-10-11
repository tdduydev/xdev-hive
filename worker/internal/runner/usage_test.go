package runner

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// feed đọc fixture JSONL thật (chạy CLI ngày 11/10/2026: claude 2.1.296, codex-cli 0.162.1) vào parser.
func feed(t *testing.T, p UsageParser, name string) []Usage {
	t.Helper()
	f, err := os.Open(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var changes []Usage
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	for sc.Scan() {
		if p.Line(sc.Bytes()) {
			changes = append(changes, p.Usage())
		}
	}
	if err := sc.Err(); err != nil {
		t.Fatal(err)
	}
	return changes
}

func TestClaudeUsageFromStream(t *testing.T) {
	p := NewUsageParser("claude")
	changes := feed(t, p, "claude-stream.jsonl")
	// Tin init (model), hai lời gọi API, rồi tin result.
	if len(changes) != 4 {
		t.Fatalf("số lần đổi = %d", len(changes))
	}
	first := changes[1]
	if first.InputTokens != 2 || first.OutputTokens != 16 || first.CacheReadTokens != 11054 || first.CacheWriteTokens != 7840 {
		t.Fatalf("sau tin assistant đầu = %+v", first)
	}
	if first.CostUSD != nil || first.Turns == nil || *first.Turns != 1 || first.Model == nil || *first.Model != "claude-opus-5-5" {
		t.Fatalf("sau tin assistant đầu: cost %v, turns %v, model %v", first.CostUSD, first.Turns, first.Model)
	}
	u := p.Usage()
	if u.InputTokens != 4 || u.OutputTokens != 78 || u.CacheReadTokens != 29948 || u.CacheWriteTokens != 9977 {
		t.Fatalf("usage cuối = %+v", u)
	}
	if u.CostUSD == nil || *u.CostUSD != 0.0873816 || u.Turns == nil || *u.Turns != 2 {
		t.Fatalf("cost %v, turns %v", u.CostUSD, u.Turns)
	}
}

func TestClaudeUsageWhenBudgetStopsCLI(t *testing.T) {
	// Claude dừng vì --max-budget-usd: result.usage toàn 0, số thật nằm ở modelUsage. Usage không được giảm.
	p := NewUsageParser("claude")
	feed(t, p, "claude-max-budget.jsonl")
	u := p.Usage()
	if u.InputTokens != 2 || u.OutputTokens != 74 || u.CacheReadTokens != 12679 || u.CacheWriteTokens != 6277 {
		t.Fatalf("usage = %+v", u)
	}
	if u.CostUSD == nil || *u.CostUSD != 0.0542398 || u.Turns == nil || *u.Turns != 1 {
		t.Fatalf("cost %v, turns %v", u.CostUSD, u.Turns)
	}
	max := 0.01
	if r := (Budget{MaxCostUSD: &max}).Exceeded(u); !strings.Contains(r, "chi phí $0.0542 > $0.0100") {
		t.Fatalf("lý do = %q", r)
	}
}

func TestCodexUsageFromExecJSON(t *testing.T) {
	p := NewUsageParser("codex")
	if changes := feed(t, p, "codex-exec.jsonl"); len(changes) != 1 {
		t.Fatalf("số lần đổi = %d", len(changes))
	}
	u := p.Usage()
	// input_tokens 37381 gồm 31616 token đọc từ cache.
	if u.InputTokens != 5765 || u.CacheReadTokens != 31616 || u.CacheWriteTokens != 0 || u.OutputTokens != 55 {
		t.Fatalf("usage = %+v", u)
	}
	if u.CostUSD != nil || u.Turns != nil || u.Model != nil {
		t.Fatalf("codex không báo USD, lượt, model: %+v", u)
	}
}

func TestUsageParserIgnoresNoise(t *testing.T) {
	if NewUsageParser("gemini") != nil {
		t.Fatal("gemini chưa đọc usage")
	}
	for _, cli := range []string{"claude", "codex"} {
		p := NewUsageParser(cli)
		for _, l := range []string{"", "không phải JSON", `{"type":"assistant"}`, `{"type":"turn.completed"}`, `[1,2]`} {
			if p.Line([]byte(l)) {
				t.Fatalf("%s: dòng %q làm đổi usage", cli, l)
			}
		}
	}
}

func TestBudgetExceeded(t *testing.T) {
	cost, turns := 2.0, 31
	u := Usage{InputTokens: 100, OutputTokens: 50, CacheReadTokens: 1_000_000, CacheWriteTokens: 10, CostUSD: &cost, Turns: &turns}
	maxCost, maxTok, maxTurns := 2.0, int64(160), 30
	if r := (Budget{MaxCostUSD: &maxCost, MaxTokens: &maxTok}).Exceeded(u); r != "" {
		t.Fatalf("chưa vượt mà báo %q (cache read không tính, bằng trần chưa là vượt)", r)
	}
	maxTok = 159
	if r := (Budget{MaxTokens: &maxTok, MaxTurns: &maxTurns}).Exceeded(u); r != "token 160 > 159, số lượt 31 > 30" {
		t.Fatalf("lý do = %q", r)
	}
	if r := (Budget{MaxCostUSD: &maxCost}).Exceeded(Usage{}); r != "" {
		t.Fatalf("CLI không báo USD thì không xét trần USD: %q", r)
	}
}

func TestMeterThrottlesAndSplitsLines(t *testing.T) {
	now := time.Date(2026, 10, 11, 12, 0, 0, 0, time.UTC)
	var mu sync.Mutex
	var sent []Usage
	m := newMeter("codex", Budget{}, func(u Usage) error { mu.Lock(); sent = append(sent, u); mu.Unlock(); return nil }, nil)
	m.now = func() time.Time { return now }
	line := `{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}` + "\n"
	// Dòng bị cắt giữa hai lần ghi vẫn được ghép lại.
	_, _ = m.Write([]byte(line[:20]))
	_, _ = m.Write([]byte(line[20:]))
	if len(sent) != 1 || sent[0].InputTokens != 10 {
		t.Fatalf("lần đầu = %+v", sent)
	}
	_, _ = m.Write([]byte(line))
	if len(sent) != 1 {
		t.Fatal("gửi lại trong vòng 5 giây")
	}
	now = now.Add(costInterval)
	if err := m.flush(false); err != nil || len(sent) != 2 || sent[1].InputTokens != 20 {
		t.Fatalf("sau 5 giây = %+v, %v", sent, err)
	}
	// Không đổi thì không gửi, kể cả lúc kết thúc; dòng cuối không có '\n' vẫn được đọc.
	_ = m.flush(true)
	_, _ = m.Write([]byte(strings.TrimSuffix(line, "\n")))
	if err := m.finish(); err != nil || len(sent) != 3 || sent[2].InputTokens != 30 {
		t.Fatalf("lúc kết thúc = %+v, %v", sent, err)
	}
}

func TestMeterStopsOnceWhenOverBudget(t *testing.T) {
	maxTok := int64(15)
	var reasons []string
	var sent []Usage
	m := newMeter("codex", Budget{MaxTokens: &maxTok}, func(u Usage) error { sent = append(sent, u); return nil }, func(r string) { reasons = append(reasons, r) })
	line := []byte(`{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":0}}` + "\n")
	_, _ = m.Write(line)
	_, _ = m.Write(line)
	_, _ = m.Write(line)
	if len(reasons) != 1 || reasons[0] != "token 20 > 15" || m.exceeded() != reasons[0] {
		t.Fatalf("lý do = %v", reasons)
	}
	// Lần vượt trần được gửi ngay dù chưa qua 5 giây.
	if len(sent) != 2 || sent[1].InputTokens != 20 {
		t.Fatalf("đã gửi = %+v", sent)
	}
}
