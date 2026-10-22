package tokenreport

import (
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// ProjectFolder là một dự án đã gắn với thư mục repo trên máy (một mục của projects.json).
type ProjectFolder struct {
	ProjectID string
	Folder    string
}

var (
	driveRoot = regexp.MustCompile(`^[A-Za-z]:([/\\]|$)`)
	msysDrive = regexp.MustCompile(`^/([A-Za-z])(/|$)`)
)

// normalizePath đưa đường dẫn về dạng so sánh được mà không đụng đĩa: cwd trong transcript có thể là thư mục đã xoá
// hay của máy khác, nên không EvalSymlinks. Đường dẫn kiểu Windows (ổ đĩa, UNC) so không phân biệt hoa thường và coi
// `\` như `/`; trên Linux `\` là ký tự tên file nên giữ nguyên.
func normalizePath(p string) (norm string, ok bool) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", false
	}
	p = strings.TrimPrefix(p, `\\?\`)
	windows := runtime.GOOS == "windows" || driveRoot.MatchString(p) || strings.HasPrefix(p, `\\`)
	if windows {
		p = strings.ReplaceAll(p, `\`, "/")
		if runtime.GOOS == "windows" {
			if m := msysDrive.FindStringSubmatch(p); m != nil {
				p = m[1] + ":" + p[len(m[1])+1:]
			}
		}
		p = strings.ToLower(p)
	}
	unc := windows && strings.HasPrefix(p, "//")
	p = path.Clean(p)
	if unc {
		p = "/" + p
	}
	if !windows && !strings.HasPrefix(p, "/") {
		return "", false
	}
	return p, true
}

func within(dir, folder string) bool {
	if dir == folder {
		return true
	}
	if strings.HasSuffix(folder, "/") {
		return strings.HasPrefix(dir, folder)
	}
	return strings.HasPrefix(dir, folder+"/")
}

// AssignProject trả id dự án có thư mục chứa cwd. Dự án lồng nhau thì lấy thư mục sâu nhất. Mục không có id
// (repo chưa gắn dự án trên hub) không nhận phiên nào.
func AssignProject(cwd string, folders []ProjectFolder) (string, bool) {
	dir, ok := normalizePath(cwd)
	if !ok {
		return "", false
	}
	best, bestLen := "", -1
	for _, f := range folders {
		if f.ProjectID == "" {
			continue
		}
		fd, ok := normalizePath(f.Folder)
		if !ok || !within(dir, fd) {
			continue
		}
		if len(fd) > bestLen {
			best, bestLen = f.ProjectID, len(fd)
		}
	}
	return best, bestLen >= 0
}

// PolicyDriftItems là các mục chính sách dự án mà hub nhận (khớp enum `projectTokenUsagePolicyDrift`).
var PolicyDriftItems = []string{"level", "rtk", "codegraph", "autoCompactWindow", "contextBudgetTokens", "memoryAutoSync"}

// UsageWindowDays là kỳ của một báo cáo theo dự án.
const UsageWindowDays = 7

// CLITokens là token của một CLI trong kỳ. Chỉ số.
type CLITokens struct {
	Input     int64   `json:"input"`
	Output    int64   `json:"output"`
	CacheRead int64   `json:"cacheRead"`
	Weighted  float64 `json:"weighted"`
}

// ProjectUsagePayload là payload `project.token_usage` (packages/contracts/src/client-events.ts). Chỉ có số, enum, uuid
// và ngày: không đường dẫn, tên file hay nội dung phiên (SC-007).
type ProjectUsagePayload struct {
	ProjectID   string               `json:"projectId"`
	PeriodStart string               `json:"periodStart"`
	PeriodEnd   string               `json:"periodEnd"`
	Tokens      map[string]CLITokens `json:"tokens"`
	Sessions    int                  `json:"sessions"`
	Score       *int                 `json:"score"`
	PolicyDrift []string             `json:"policyDrift"`
}

// UsageInput là đầu vào dựng báo cáo theo dự án.
type UsageInput struct {
	Sessions []SessionSummary
	Folders  []ProjectFolder
	// Enabled là cờ theo dự án của máy; dự án không có trong đây hoặc false thì không dựng gì.
	Enabled map[string]bool
	Now     time.Time
	// Score là điểm máy 0–100, nil khi chưa chấm được.
	Score *float64
	// Drift là mục lệch chính sách theo dự án; mục ngoài PolicyDriftItems bị bỏ.
	Drift map[string][]string
}

func roundInt(x float64) *int {
	v := int(math.Round(math.Min(100, math.Max(0, x))))
	return &v
}

// BuildProjectUsage gom phiên 7 ngày gần nhất theo dự án đã bật. Dự án không có phiên nào trong kỳ thì bỏ qua.
func BuildProjectUsage(in UsageInput) []ProjectUsagePayload {
	end := in.Now.UTC()
	start := end.AddDate(0, 0, -UsageWindowDays)
	byProject := map[string]*ProjectUsagePayload{}
	for _, s := range in.Sessions {
		if s.Source == sourceTest || (s.CLI != "claude" && s.CLI != "codex") || (!s.Start.IsZero() && s.Start.Before(start)) {
			continue
		}
		id, ok := AssignProject(s.Cwd, in.Folders)
		if !ok || !in.Enabled[id] {
			continue
		}
		p := byProject[id]
		if p == nil {
			p = &ProjectUsagePayload{
				ProjectID: id, PeriodStart: start.Format(time.RFC3339), PeriodEnd: end.Format(time.RFC3339),
				Tokens: map[string]CLITokens{}, PolicyDrift: driftOf(in.Drift[id]),
			}
			if in.Score != nil {
				p.Score = roundInt(*in.Score)
			}
			byProject[id] = p
		}
		t := p.Tokens[s.CLI]
		t.Input += s.Input
		t.Output += s.Output
		t.CacheRead += s.CacheRead
		t.Weighted += s.Weighted
		p.Tokens[s.CLI] = t
		if !s.Subagent {
			p.Sessions++
		}
	}
	out := make([]ProjectUsagePayload, 0, len(byProject))
	for _, p := range byProject {
		for cli, t := range p.Tokens {
			t.Weighted = math.Round(t.Weighted*100) / 100
			p.Tokens[cli] = t
		}
		out = append(out, *p)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ProjectID < out[j].ProjectID })
	return out
}

func driftOf(in []string) []string {
	out := []string{}
	for _, name := range PolicyDriftItems {
		for _, v := range in {
			if v == name {
				out = append(out, name)
				break
			}
		}
	}
	return out
}

// ProjectFlag là cài đặt gửi số liệu của một dự án trên máy này.
type ProjectFlag struct {
	Enabled    bool       `json:"enabled"`
	LastSentAt *time.Time `json:"lastSentAt,omitempty"`
}

// UsageState là project-usage.json trong thư mục optimizer: cờ gửi theo dự án, mặc định tắt.
type UsageState struct {
	Projects map[string]ProjectFlag `json:"projects"`
}

// UsageStatePath là file cờ theo dự án.
func UsageStatePath(dir string) string { return filepath.Join(dir, "project-usage.json") }

// LoadUsageState đọc cờ; chưa có file hay file hỏng đều là tắt hết, vì gửi chỉ bật khi người dùng chọn.
func LoadUsageState(dir string) (UsageState, error) {
	st := UsageState{Projects: map[string]ProjectFlag{}}
	b, err := os.ReadFile(UsageStatePath(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if json.Unmarshal(b, &st) != nil || st.Projects == nil {
		return UsageState{Projects: map[string]ProjectFlag{}}, nil
	}
	return st, nil
}

// SaveUsageState ghi nguyên tử; CreateTemp tạo file quyền 0600.
func SaveUsageState(dir string, st UsageState) error {
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".project-usage-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(b)
	cerr := tmp.Close()
	if err := errors.Join(werr, cerr); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), UsageStatePath(dir)); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}
