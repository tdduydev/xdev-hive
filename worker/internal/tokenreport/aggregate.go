package tokenreport

import (
	"math"
	"sort"
)

// weighted quy chi phí về "token input tương đương" theo tỉ lệ giá của Anthropic (cache đọc 0,1×, ghi 5 phút 1,25×, ghi
// 1 giờ 2×, output 5×). Codex khác giá nhưng tỉ lệ đọc cache/ghi tương tự; chỉ dùng để so phần trăm trong cùng CLI.
func weighted(s *session) float64 {
	return float64(s.Input) + 0.1*float64(s.CacheRead) + 1.25*float64(s.CacheWrite5m) + 2*float64(s.CacheWrite1h) + 5*float64(s.Output)
}

// round3 và jsRound giữ cách làm tròn của toFixed(3) và Math.round bên TypeScript.
func round3(x float64) float64  { return math.Round(x*1000) / 1000 }
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// ratio tránh NaN (không mã hoá được thành JSON) khi nhóm rỗng.
func ratio(a, b float64) float64 {
	if b == 0 {
		return 0
	}
	return a / b
}

func median(xs []float64) float64 {
	if len(xs) == 0 {
		return 0
	}
	a := append([]float64(nil), xs...)
	sort.Float64s(a)
	return a[len(a)/2]
}

type group struct {
	sessions         int
	calls            int
	input, output    int64
	cacheRead        int64
	cacheWrite5m     int64
	cacheWrite1h     int64
	weighted         float64
	peakOver150k     int
	peakOver400k     int
	weightedOver400k float64
	compactions      int
}

func groupOf(list []*session) group {
	g := group{sessions: len(list)}
	for _, s := range list {
		g.calls += s.Calls
		g.input += s.Input
		g.output += s.Output
		g.cacheRead += s.CacheRead
		g.cacheWrite5m += s.CacheWrite5m
		g.cacheWrite1h += s.CacheWrite1h
		w := weighted(s)
		g.weighted += w
		if s.PeakContext > 150_000 {
			g.peakOver150k++
		}
		// Vượt cửa sổ 200k: phiên đang chạy bằng ngữ cảnh 1M, mỗi lượt đọc lại cả phần đó qua cache.
		if s.PeakContext > 400_000 {
			g.peakOver400k++
			g.weightedOver400k += w
		}
		g.compactions += s.Compactions
	}
	return g
}

func (g group) hitRate() float64 {
	return ratio(float64(g.cacheRead), float64(g.input+g.cacheRead+g.cacheWrite5m+g.cacheWrite1h))
}

func pick(list []*session, ok func(*session) bool) []*session {
	var out []*session
	for _, s := range list {
		if ok(s) {
			out = append(out, s)
		}
	}
	return out
}

func count(list []*session, ok func(*session) bool) int { return len(pick(list, ok)) }

func floats(list []*session, f func(*session) float64) []float64 {
	out := make([]float64, 0, len(list))
	for _, s := range list {
		out = append(out, f(s))
	}
	return out
}

type namedStat struct {
	name string
	stat toolStat
}

// mergeTools cộng thống kê tool của nhiều phiên, xếp theo phần bị đọc lại giảm dần (hoà thì theo tên cho kết quả ổn định).
func mergeTools(list []*session, from func(*session) map[string]*toolStat) []namedStat {
	m := map[string]*toolStat{}
	for _, s := range list {
		for k, v := range from(s) {
			t := m[k]
			if t == nil {
				t = &toolStat{}
				m[k] = t
			}
			t.Calls += v.Calls
			t.Chars += v.Chars
			t.Carried += v.Carried
		}
	}
	out := make([]namedStat, 0, len(m))
	for k, v := range m {
		out = append(out, namedStat{k, *v})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].stat.Carried != out[j].stat.Carried {
			return out[i].stat.Carried > out[j].stat.Carried
		}
		return out[i].name < out[j].name
	})
	return out
}

func top(list []namedStat, n int) []namedStat {
	if len(list) > n {
		return list[:n]
	}
	return list
}

// Aggregate là phần số liệu theo phiên; Report chứa một bản cho toàn bộ và Split chứa hai bản trước/sau mốc.
type Aggregate struct {
	BySource               map[string]SourceStats `json:"bySource"`
	InteractiveHome        map[string]HomeStats   `json:"interactiveHome"`
	Tools                  []ToolRow              `json:"tools"`
	Bash                   []BashRow              `json:"bash"`
	CodexTools             []CodexToolRow         `json:"codexTools"`
	Rereads                RereadStats            `json:"rereads"`
	RTK                    map[string]RTKSplit    `json:"rtk"`
	InstructionsPerSession map[string]InstrStats  `json:"instructionsPerSession"`
}

type SourceStats struct {
	Sessions           int           `json:"sessions"`
	Calls              int           `json:"calls"`
	Input              int64         `json:"input"`
	Output             int64         `json:"output"`
	CacheRead          int64         `json:"cacheRead"`
	CacheWrite5m       int64         `json:"cacheWrite5m"`
	CacheWrite1h       int64         `json:"cacheWrite1h"`
	Weighted           float64       `json:"weighted"`
	PeakOver150k       int           `json:"peakOver150k"`
	PeakOver400k       int           `json:"peakOver400k"`
	WeightedOver400k   float64       `json:"weightedOver400k"`
	Compactions        int           `json:"compactions"`
	CacheHit           float64       `json:"cacheHit"`
	RTKSessions        int           `json:"rtkSessions"`
	GuardSessions      int           `json:"guardSessions"`
	MedianCalls        float64       `json:"medianCalls"`
	MedianFirstContext float64       `json:"medianFirstContext"`
	MedianPeakContext  float64       `json:"medianPeakContext"`
	WeightedShare      WeightedShare `json:"weightedShare"`
}

type WeightedShare struct {
	Input      float64 `json:"input"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
	Output     float64 `json:"output"`
}

type HomeStats struct {
	Sessions          int     `json:"sessions"`
	Calls             int     `json:"calls"`
	CacheRead         int64   `json:"cacheRead"`
	CacheWrite1h      int64   `json:"cacheWrite1h"`
	Weighted          float64 `json:"weighted"`
	PeakOver150k      int     `json:"peakOver150k"`
	RTKSessions       int     `json:"rtkSessions"`
	MedianPeakContext float64 `json:"medianPeakContext"`
}

type ToolRow struct {
	Name          string  `json:"name"`
	Calls         int     `json:"calls"`
	OutputTokens  float64 `json:"outputTokens"`
	AvgTokens     float64 `json:"avgTokens"`
	CarriedTokens float64 `json:"carriedTokens"`
	CarriedShare  float64 `json:"carriedShare"`
}

type BashRow struct {
	Name          string  `json:"name"`
	Calls         int     `json:"calls"`
	AvgTokens     float64 `json:"avgTokens"`
	CarriedTokens float64 `json:"carriedTokens"`
}

type CodexToolRow struct {
	Name      string  `json:"name"`
	Calls     int     `json:"calls"`
	AvgTokens float64 `json:"avgTokens"`
}

type RereadStats struct {
	Reads              int     `json:"reads"`
	Rereads            int     `json:"rereads"`
	Share              float64 `json:"share"`
	RereadTokens       float64 `json:"rereadTokens"`
	SessionsWithReread int     `json:"sessionsWithReread"`
}

type RTKSide struct {
	Sessions              int     `json:"sessions"`
	BashCalls             int     `json:"bashCalls"`
	AvgBashTokens         float64 `json:"avgBashTokens"`
	MedianSessionWeighted float64 `json:"medianSessionWeighted"`
}

type RTKSplit struct {
	WithRTK    RTKSide `json:"withRTK"`
	WithoutRTK RTKSide `json:"withoutRTK"`
}

type InstrStats struct {
	Sessions     int     `json:"sessions"`
	MedianTokens float64 `json:"medianTokens"`
	MaxTokens    float64 `json:"maxTokens"`
}

func aggregate(sessions []*session) Aggregate {
	a := Aggregate{
		BySource:        map[string]SourceStats{},
		InteractiveHome: map[string]HomeStats{},
		RTK:             map[string]RTKSplit{},
	}
	for _, cli := range []string{"claude", "codex"} {
		for _, src := range sources {
			list := pick(sessions, func(s *session) bool { return s.CLI == cli && s.Source == src })
			if len(list) == 0 {
				continue
			}
			g := groupOf(list)
			a.BySource[cli+"/"+src] = SourceStats{
				Sessions: g.sessions, Calls: g.calls, Input: g.input, Output: g.output, CacheRead: g.cacheRead,
				CacheWrite5m: g.cacheWrite5m, CacheWrite1h: g.cacheWrite1h, Weighted: g.weighted,
				PeakOver150k: g.peakOver150k, PeakOver400k: g.peakOver400k, WeightedOver400k: g.weightedOver400k,
				Compactions: g.compactions, CacheHit: round3(g.hitRate()),
				RTKSessions:        count(list, func(s *session) bool { return s.RTK }),
				GuardSessions:      count(list, func(s *session) bool { return s.Guard }),
				MedianCalls:        median(floats(list, func(s *session) float64 { return float64(s.Calls) })),
				MedianFirstContext: median(floats(pick(list, func(s *session) bool { return s.FirstContext > 0 }), func(s *session) float64 { return float64(s.FirstContext) })),
				MedianPeakContext:  median(floats(list, func(s *session) float64 { return float64(s.PeakContext) })),
				WeightedShare: WeightedShare{
					Input:      round3(ratio(float64(g.input), g.weighted)),
					CacheRead:  round3(ratio(0.1*float64(g.cacheRead), g.weighted)),
					CacheWrite: round3(ratio(1.25*float64(g.cacheWrite5m)+2*float64(g.cacheWrite1h), g.weighted)),
					Output:     round3(ratio(5*float64(g.output), g.weighted)),
				},
			}
		}
	}

	// Phiên tương tác bằng gói của app (~/.xdev-hive/accounts) là phiên app mở hoặc đặt CLAUDE_CONFIG_DIR tới gói; còn
	// lại là đăng nhập mặc định của CLI.
	for _, plan := range []bool{true, false} {
		list := pick(sessions, func(s *session) bool {
			return s.CLI == "claude" && s.Source == sourceInteractive && (s.Account != DefaultAccount) == plan
		})
		if len(list) == 0 {
			continue
		}
		g := groupOf(list)
		name := "default"
		if plan {
			name = "plan"
		}
		a.InteractiveHome[name] = HomeStats{
			Sessions: g.sessions, Calls: g.calls, CacheRead: g.cacheRead, CacheWrite1h: g.cacheWrite1h,
			Weighted: jsRound(g.weighted), PeakOver150k: g.peakOver150k,
			RTKSessions:       count(list, func(s *session) bool { return s.RTK }),
			MedianPeakContext: median(floats(list, func(s *session) float64 { return float64(s.PeakContext) })),
		}
	}

	claude := pick(sessions, func(s *session) bool { return s.CLI == "claude" && s.Source != sourceTest })
	tools := mergeTools(claude, func(s *session) map[string]*toolStat { return s.Tools })
	totalCarried := 0.0
	for _, t := range tools {
		totalCarried += t.stat.Carried
	}
	a.Tools = []ToolRow{}
	for _, t := range top(tools, 12) {
		a.Tools = append(a.Tools, ToolRow{
			Name: t.name, Calls: t.stat.Calls,
			OutputTokens:  jsRound(t.stat.Chars / 4),
			AvgTokens:     jsRound(t.stat.Chars / 4 / float64(t.stat.Calls)),
			CarriedTokens: jsRound(t.stat.Carried / 4),
			CarriedShare:  round3(ratio(t.stat.Carried, totalCarried)),
		})
	}
	a.Bash = []BashRow{}
	for _, t := range top(mergeTools(claude, func(s *session) map[string]*toolStat { return s.Bash }), 15) {
		a.Bash = append(a.Bash, BashRow{
			Name: t.name, Calls: t.stat.Calls,
			AvgTokens:     jsRound(t.stat.Chars / 4 / float64(t.stat.Calls)),
			CarriedTokens: jsRound(t.stat.Carried / 4),
		})
	}
	a.CodexTools = []CodexToolRow{}
	codex := pick(sessions, func(s *session) bool { return s.CLI == "codex" })
	for _, t := range top(mergeTools(codex, func(s *session) map[string]*toolStat { return s.Tools }), 8) {
		a.CodexTools = append(a.CodexTools, CodexToolRow{
			Name: t.name, Calls: t.stat.Calls, AvgTokens: jsRound(t.stat.Chars / 4 / float64(t.stat.Calls)),
		})
	}

	reads, rereads, rereadChars := 0, 0, 0.0
	for _, s := range claude {
		reads += s.Reads
		rereads += s.Rereads
		rereadChars += s.RereadChars
	}
	a.Rereads = RereadStats{
		Reads: reads, Rereads: rereads, Share: round3(float64(rereads) / float64(max(1, reads))),
		RereadTokens:       jsRound(rereadChars / 4),
		SessionsWithReread: count(claude, func(s *session) bool { return s.Rereads > 0 }),
	}

	// RTK: so output Bash trung bình mỗi lệnh của phiên có/không hook RTK, chỉ trong cùng nguồn để công bằng.
	for _, src := range []string{sourceWorker, sourceHeadless, sourceInteractive} {
		list := pick(claude, func(s *session) bool { return s.Source == src })
		side := func(xs []*session) RTKSide {
			calls, chars := 0, 0.0
			for _, s := range xs {
				if t := s.Tools["Bash"]; t != nil {
					calls += t.Calls
					chars += t.Chars
				}
			}
			return RTKSide{
				Sessions: len(xs), BashCalls: calls,
				AvgBashTokens:         jsRound(chars / 4 / float64(max(1, calls))),
				MedianSessionWeighted: jsRound(median(floats(xs, weighted))),
			}
		}
		a.RTK[src] = RTKSplit{
			WithRTK:    side(pick(list, func(s *session) bool { return s.RTK })),
			WithoutRTK: side(pick(list, func(s *session) bool { return !s.RTK })),
		}
	}

	a.InstructionsPerSession = map[string]InstrStats{}
	withMem := pick(claude, func(s *session) bool { return len(s.Memory) > 0 })
	kinds := map[string]bool{}
	for _, s := range withMem {
		for k := range s.Memory {
			kinds[k] = true
		}
	}
	for k := range kinds {
		var xs []float64
		for _, s := range withMem {
			if n := s.Memory[k]; n > 0 {
				xs = append(xs, float64(n))
			}
		}
		if len(xs) == 0 {
			// Loại instruction chỉ có nội dung rỗng: bản TypeScript ra max = -Infinity, ở đây bỏ hẳn.
			continue
		}
		mx := 0.0
		for _, x := range xs {
			mx = math.Max(mx, x)
		}
		a.InstructionsPerSession[k] = InstrStats{Sessions: len(xs), MedianTokens: jsRound(median(xs) / 4), MaxTokens: jsRound(mx / 4)}
	}
	return a
}
