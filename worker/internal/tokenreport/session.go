// Package tokenreport đo token và memory của CLI agent trên máy từ transcript (chỉ đọc). Đây là bản Go của
// scripts/token-audit.ts: cùng cách chia nguồn, cùng công thức quy đổi, cùng tên trường JSON. Report chỉ có số tổng
// hợp: không có prompt, output tool hay đường dẫn dự án, để chép báo cáo vào issue không lộ dữ liệu người dùng.
// Sessions trả thêm thư mục làm việc của từng phiên cho người gọi trong sidecar (điểm tối ưu tìm dự án dùng nhiều).
package tokenreport

import (
	"regexp"
	"strings"
	"time"
	"unicode/utf16"
)

const (
	sourceWorker      = "worker"
	sourceHubTerminal = "hub-terminal"
	sourceHeadless    = "headless"
	sourceInteractive = "interactive"
	sourceTest        = "test"
)

var sources = []string{sourceWorker, sourceHubTerminal, sourceHeadless, sourceInteractive, sourceTest}

// toolStat gom output của một tool. Carried là ký tự output nhân số lượt gọi API sau nó trong cùng ngữ cảnh: phần bị
// đọc lại qua cache mỗi lượt.
type toolStat struct {
	Calls   int     `json:"calls"`
	Chars   float64 `json:"chars"`
	Carried float64 `json:"carried"`
}

// session là số liệu của một transcript. Các trường xuất ra để lưu vào cache theo (file, mtime, cỡ).
type session struct {
	CLI          string               `json:"cli"`
	Source       string               `json:"source"`
	Account      string               `json:"account"`
	Start        time.Time            `json:"start"`
	RTK          bool                 `json:"rtk"`
	Guard        bool                 `json:"guard"`
	Calls        int                  `json:"calls"`
	Input        int64                `json:"input"`
	Output       int64                `json:"output"`
	CacheRead    int64                `json:"cacheRead"`
	CacheWrite5m int64                `json:"cacheWrite5m"`
	CacheWrite1h int64                `json:"cacheWrite1h"`
	Tools        map[string]*toolStat `json:"tools"`
	Bash         map[string]*toolStat `json:"bash"`
	Reads        int                  `json:"reads"`
	Rereads      int                  `json:"rereads"`
	RereadChars  float64              `json:"rereadChars"`
	// Ký tự instruction nạp vào phiên theo loại (Project = CLAUDE.md/AGENTS.md, AutoMem = MEMORY.md, User...).
	Memory      map[string]int `json:"memory"`
	Compactions int            `json:"compactions"`
	Models      []string       `json:"models"`
	Versions    []string       `json:"versions"`
	PeakContext int64          `json:"peakContext"`
	// Ngữ cảnh ở lượt gọi đầu: system prompt, định nghĩa tool/MCP, CLAUDE.md, memory; phần trả mỗi lượt dù chưa làm gì.
	FirstContext int64 `json:"firstContext"`
	// Cwd chỉ nằm trong cache cục bộ và Sessions, không vào Report.
	Cwd string `json:"cwd,omitempty"`
	// Subagent gán theo đường dẫn file mỗi lần đọc, như Account, nên không lưu vào cache.
	Subagent bool `json:"-"`
	// Edit là usage trước lượt có lệnh sửa file đầu tiên, không tính lượt đó (như freezeExplore của worker); nil là
	// phiên chưa sửa file.
	Edit *usageMark `json:"edit,omitempty"`
}

// usageMark là usage luỹ kế của phiên tại một thời điểm.
type usageMark struct {
	Input        int64 `json:"input"`
	Output       int64 `json:"output"`
	CacheRead    int64 `json:"cacheRead"`
	CacheWrite5m int64 `json:"cacheWrite5m"`
	CacheWrite1h int64 `json:"cacheWrite1h"`
}

func (s *session) mark() usageMark {
	return usageMark{Input: s.Input, Output: s.Output, CacheRead: s.CacheRead, CacheWrite5m: s.CacheWrite5m, CacheWrite1h: s.CacheWrite1h}
}

// editTools là tool sửa file của Claude Code, cùng danh sách worker dùng để chốt phần khảo sát.
var editTools = map[string]bool{"Edit": true, "Write": true, "MultiEdit": true, "NotebookEdit": true}

func newSession(cli, account string) *session {
	return &session{
		CLI:     cli,
		Source:  sourceInteractive,
		Account: account,
		Tools:   map[string]*toolStat{},
		Bash:    map[string]*toolStat{},
		Memory:  map[string]int{},
	}
}

func bump(m map[string]*toolStat, key string, chars, carried float64) {
	s := m[key]
	if s == nil {
		s = &toolStat{}
		m[key] = s
	}
	s.Calls++
	s.Chars += chars
	s.Carried += carried
}

func addUnique(list []string, v string) []string {
	for _, x := range list {
		if x == v {
			return list
		}
	}
	return append(list, v)
}

var (
	workerCwd = regexp.MustCompile(`[/\\]\.xdev-hive[/\\](worktrees|runs)[/\\]`)
	testCwd   = regexp.MustCompile(`/T/|TestZZ|/tmp/.*probe|/tmp/.*-test`)
)

// classify chia phiên theo nguồn: "worker" (run do hub giao, cwd trong worktree của worker), "hub-terminal" (phiên
// tương tác trong worktree của worker: terminal Leader điều khiển từ xa), "headless" (`claude -p` ngoài worker: agent
// chạy song song, script), "interactive" (người gõ), "test" (test Go/Rust tạo repo tạm).
func classify(cwd string, headless bool) string {
	if workerCwd.MatchString(cwd) {
		if headless {
			return sourceWorker
		}
		return sourceHubTerminal
	}
	if testCwd.MatchString(cwd) {
		return sourceTest
	}
	if headless {
		return sourceHeadless
	}
	return sourceInteractive
}

var (
	bashSeparators = regexp.MustCompile(`&&|;|\|\|`)
	spaces         = regexp.MustCompile(`\s+`)
	envAssign      = regexp.MustCompile(`^[A-Z_][A-Z0-9_]*=`)
	subcommandCLIs = map[string]bool{
		"pnpm": true, "npm": true, "go": true, "git": true, "cargo": true, "npx": true, "rtk": true, "docker": true, "gh": true,
	}
)

// bashKey lấy lệnh chính, bỏ `cd x &&` và biến môi trường đứng đầu: đủ để biết loại lệnh nào sinh output lớn mà không
// lộ đối số.
func bashKey(cmd string) string {
	seg := ""
	for _, part := range bashSeparators.Split(cmd, -1) {
		part = strings.TrimSpace(part)
		if part != "" && !strings.HasPrefix(part, "cd ") {
			seg = part
			break
		}
	}
	var words []string
	for _, w := range spaces.Split(seg, -1) {
		if !envAssign.MatchString(w) {
			words = append(words, w)
		}
	}
	first := "?"
	if len(words) > 0 {
		first = baseName(words[0])
	}
	if subcommandCLIs[first] && len(words) > 1 && words[1] != "" {
		sub := words[1]
		if sub == "--filter" || sub == "-C" {
			sub = ""
			if len(words) > 3 {
				sub = words[3]
			}
		}
		return strings.TrimSpace(first + " " + sub)
	}
	return first
}

// baseName cắt theo cả '/' lẫn '\' vì lệnh trong transcript có thể ghi từ Windows.
func baseName(p string) string {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		return p[i+1:]
	}
	return p
}

// jsLen đếm đơn vị UTF-16 như String.length của bản TypeScript, để số khớp từng ký tự khi có chữ có dấu và emoji.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xFFFF {
			n += len(utf16.Encode([]rune{r}))
		} else {
			n++
		}
	}
	return n
}
