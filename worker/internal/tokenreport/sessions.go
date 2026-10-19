package tokenreport

import (
	"context"
	"path/filepath"
	"strings"
	"time"
)

// SessionSummary là số của một transcript cho người gọi tự gộp (điểm tối ưu token). Không có prompt hay output; Cwd chỉ
// dùng trong sidecar để tìm dự án, không được đưa vào báo cáo chép hay gửi đi.
type SessionSummary struct {
	CLI     string
	Source  string
	Account string
	Start   time.Time
	// Subagent: transcript nằm trong <phiên>/subagents/ của Claude Code.
	Subagent     bool
	Cwd          string
	Calls        int
	Input        int64
	Output       int64
	CacheRead    int64
	CacheWrite   int64
	Weighted     float64
	FirstContext int64
	PeakContext  int64
	ToolCalls    int
	ToolChars    float64
	// InstructionChars là ký tự CLAUDE.md, AGENTS.md, MEMORY.md… nạp vào phiên.
	InstructionChars int
	// Edited: phiên có lệnh sửa file; PreEditWeighted là token quy đổi trước lượt sửa đầu tiên.
	Edited          bool
	PreEditWeighted float64
	RTK             bool
	Guard           bool
	Models          []string
}

// Sessions đọc transcript như Run (cùng cache, cùng phạm vi) nhưng trả từng phiên thay vì số tổng hợp.
func Sessions(ctx context.Context, opts Options) ([]SessionSummary, error) {
	col, err := collect(ctx, opts)
	if err != nil {
		return nil, err
	}
	out := make([]SessionSummary, 0, len(col.sessions))
	for _, s := range col.sessions {
		out = append(out, summarize(s))
	}
	return out, nil
}

func summarize(s *session) SessionSummary {
	sum := SessionSummary{
		CLI: s.CLI, Source: s.Source, Account: s.Account, Start: s.Start, Subagent: s.Subagent, Cwd: s.Cwd,
		Calls: s.Calls, Input: s.Input, Output: s.Output, CacheRead: s.CacheRead, CacheWrite: s.CacheWrite5m + s.CacheWrite1h,
		Weighted: weighted(s), FirstContext: s.FirstContext, PeakContext: s.PeakContext, RTK: s.RTK, Guard: s.Guard,
		Models: append([]string(nil), s.Models...),
	}
	for _, t := range s.Tools {
		sum.ToolCalls += t.Calls
		sum.ToolChars += t.Chars
	}
	for _, n := range s.Memory {
		sum.InstructionChars += n
	}
	if s.Edit != nil {
		sum.Edited = true
		sum.PreEditWeighted = weighted(&session{Input: s.Edit.Input, Output: s.Edit.Output, CacheRead: s.Edit.CacheRead,
			CacheWrite5m: s.Edit.CacheWrite5m, CacheWrite1h: s.Edit.CacheWrite1h})
	}
	return sum
}

// isSubagent: Claude Code ghi transcript của subagent vào <phiên>/subagents/<id>.jsonl.
func isSubagent(file string) bool {
	return strings.EqualFold(filepath.Base(filepath.Dir(file)), "subagents")
}
