package optimizeall

import (
	"encoding/json"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
)

// Id bước. Danh sách đóng (FR-014): bước ghi file ngữ cảnh chỉ đi qua ContextSyncer (ctxsync, chỉ ghi trong khối);
// không có bước nén memory, gỡ MCP hay xoá skill. Thêm id phải sửa StepIDs và test danh sách đóng.
const (
	StepOptimizerEnable = "optimizer.enable"
	StepContextSync     = "context.sync"
	StepScoreRecompute  = "score.recompute"

	fixPrefix  = "fix."
	toolPrefix = "tool."
)

// fixIDs là FIXES của Rust (apps/desktop/src-tauri/src/token_score.rs); test so hai bên.
var fixIDs = []string{"optimizer.balanced", "optimizer.rtk", "optimizer.aggressive", "codegraph.mcp", "codegraph.init"}

// toolIDs là công cụ app cài theo bảng doctor.rs trước khi gọi Apply.
var toolIDs = []string{"rtk", "codegraph"}

// plannedFixes là sửa nhanh Plan tự đưa vào. optimizer.balanced và optimizer.aggressive đã có bước optimizer.enable
// làm thay, để một gói không bị ghi hai lần cho cùng một việc.
var plannedFixes = map[string]bool{"optimizer.rtk": true, "codegraph.mcp": true, "codegraph.init": true}

// Nhóm bước như contracts/sidecar-cli.md.
const (
	GroupCLI     = "cli"
	GroupTools   = "tools"
	GroupContext = "context"
	GroupScore   = "score"
)

// Trạng thái bước trong nhật ký.
const (
	StatusPlanned = "planned"
	StatusSkipped = "skipped"
	StatusOK      = "ok"
	StatusFailed  = "failed"
	StatusUndone  = "undone"
)

// StepIDs là mọi id bước được phép, theo thứ tự cố định.
func StepIDs() []string {
	out := []string{StepOptimizerEnable}
	for _, id := range fixIDs {
		out = append(out, fixPrefix+id)
	}
	for _, id := range toolIDs {
		out = append(out, toolPrefix+id)
	}
	return append(out, StepContextSync, StepScoreRecompute)
}

// ValidStepID cho biết id có trong danh sách đóng không.
func ValidStepID(id string) bool {
	for _, s := range StepIDs() {
		if s == id {
			return true
		}
	}
	return false
}

// groupOf suy nhóm từ id để kế hoạch gửi về không tự gán nhóm khác (nhóm quyết định bước có hoàn tác được không).
func groupOf(id string) string {
	switch {
	case id == StepOptimizerEnable, strings.HasPrefix(id, fixPrefix+"optimizer."):
		return GroupCLI
	case strings.HasPrefix(id, toolPrefix), strings.HasPrefix(id, fixPrefix+"codegraph."):
		return GroupTools
	case id == StepContextSync:
		return GroupContext
	case id == StepScoreRecompute:
		return GroupScore
	}
	return ""
}

// undoable: công cụ đã cài không gỡ (FR-013); tính điểm không đổi file nào để đảo.
func undoable(id string) bool {
	return !strings.HasPrefix(id, toolPrefix) && id != StepScoreRecompute
}

// Change là một dòng xem trước: file hay mục, giá trị cũ → mới. nil là chưa có hay bị bỏ.
type Change struct {
	File   string  `json:"file"`
	Key    string  `json:"key"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}

// Step là PlanStep của contracts/sidecar-cli.md. Profile, Project, Level, RTK, AutoCompactWindow là dữ liệu để Apply
// chạy đúng bước người dùng đã xem; Status, Error chỉ có ở bước tool.* khi app đã chạy và ghi kết quả vào kế hoạch.
type Step struct {
	ID                string   `json:"id"`
	Group             string   `json:"group"`
	Target            string   `json:"target"`
	Title             string   `json:"title"`
	Changes           []Change `json:"changes"`
	Selected          bool     `json:"selected"`
	RequiresConfirm   bool     `json:"requiresConfirm"`
	Undoable          bool     `json:"undoable"`
	Reason            string   `json:"reason"`
	Profile           string   `json:"profile,omitempty"`
	Project           string   `json:"project,omitempty"`
	Level             string   `json:"level,omitempty"`
	RTK               bool     `json:"rtk,omitempty"`
	AutoCompactWindow *int     `json:"autoCompactWindow,omitempty"`
	Status            string   `json:"status,omitempty"`
	Error             *string  `json:"error,omitempty"`
}

// OptimizePlan là kết quả `optimize all --preview`.
type OptimizePlan struct {
	CreatedAt     time.Time `json:"createdAt"`
	ScoreBefore   *float64  `json:"scoreBefore"`
	PolicySources []string  `json:"policySources"`
	Steps         []Step    `json:"steps"`
}

// ProfileInfo là một gói CLI trên máy. RTK: hook RTK đang bật cho gói (cmd biết qua preset), để bật lại hay hoàn tác
// giữ nguyên RTK.
type ProfileInfo struct {
	optimizer.Profile
	Label string
	RTK   bool
}

// Project là dự án đã gắn trên máy.
type Project struct {
	ID     string
	Name   string
	Folder string
}

// FixSuggestion là sửa nhanh hay công cụ mà thang điểm 025 gợi ý (id như score.Fix*, tool.*).
type FixSuggestion struct {
	ID      string
	Profile string
	Project string
	Title   string
}

// Machine là ảnh chụp máy bên gọi dựng (accounts.json, dự án đã gắn, gợi ý của điểm). RTKSupported: máy có RTK để bật
// hook.
type Machine struct {
	Profiles     []ProfileInfo
	Projects     []Project
	Fixes        []FixSuggestion
	RTKSupported bool
}

// EnableRequest là một lần bật optimizer. Explicit: người dùng đã chọn đúng dòng của gói trong xem trước.
type EnableRequest struct {
	Level             string
	RTK               bool
	AutoCompactWindow *int
	Explicit          bool
}

// Enabler dựng preset theo CLI và phiên bản rồi gọi optimizer.Enable. Preset nằm ở cmd (dò phiên bản Claude, hook RTK)
// nên được truyền vào thay vì dựng ở đây.
type Enabler interface {
	Enable(p optimizer.Profile, req EnableRequest) (*optimizer.Result, error)
}

// FixRequest là một sửa nhanh của thang điểm 025.
type FixRequest struct {
	FixID   string
	Profile string
	Project string
}

// FixOutcome: Record là bản ghi ngăn xếp score-fixes của cmd, giữ nguyên để Undo trả lại; Files là file sửa nhanh đã
// ghi, để hoàn tác nhận ra file bị sửa tay sau đó.
type FixOutcome struct {
	Record json.RawMessage
	Files  []string
}

// Fixer chạy và đảo sửa nhanh. Ngăn xếp score-fixes.json nằm ở cmd/hive-worker nên đi qua giao diện này.
type Fixer interface {
	Apply(req FixRequest) (FixOutcome, error)
	Undo(req FixRequest, record json.RawMessage) error
}

// ContextProject là dự án đã bật ngữ cảnh dùng chung; Files là file có khối sẽ được ghi (xem trước).
type ContextProject struct {
	Key   string
	Name  string
	Files []string
}

// ContextSyncer là cửa duy nhất để ghi file ngữ cảnh (ctxsync.Manager.Sync, chỉ ghi trong khối). Sync trả id mục
// memstore để hoàn tác; rỗng là không đổi gì. Runner đã giữ optimize.lock khi gọi Sync, nên Sync không được khoá lại.
type ContextSyncer interface {
	Enabled() ([]ContextProject, error)
	Sync(key string) (entry string, err error)
}

// Scorer tính lại điểm máy (và ghi lịch sử điểm như `optimize score`). nil là chưa tính được.
type Scorer interface {
	Score() (*float64, error)
}

// Runner gom mọi thứ nút "Tối ưu" cần. Dir là ~/.xdev-hive/optimizer: nhật ký ở runs/, khoá optimize.lock.
type Runner struct {
	Dir       string
	Optimizer *optimizer.Optimizer
	Store     memstore.Store
	Machine   func() (Machine, error)
	Enabler   Enabler
	Fixer     Fixer
	Context   ContextSyncer
	Scorer    Scorer
	Now       func() time.Time
}

func (r *Runner) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Plan dựng kế hoạch `optimize all --preview`. Không ghi file cấu hình nào; vẫn giữ khoá để không xem trước giữa lúc cửa
// sổ khác đang ghi.
func (r *Runner) Plan(policies map[string]Policy) (OptimizePlan, error) {
	unlock, err := Lock(r.Dir)
	if err != nil {
		return OptimizePlan{}, err
	}
	defer unlock()
	target, err := Merge(policies)
	if err != nil {
		return OptimizePlan{}, err
	}
	m, err := r.machine()
	if err != nil {
		return OptimizePlan{}, err
	}
	levels, err := r.levels()
	if err != nil {
		return OptimizePlan{}, err
	}
	names := map[string]string{}
	linked := map[string]bool{}
	for _, p := range m.Projects {
		names[p.ID] = p.Name
		linked[p.ID] = true
	}
	reason := func(from []string) string {
		if len(from) == 0 {
			return "Mặc định"
		}
		out := make([]string, 0, len(from))
		for _, id := range from {
			if n := names[id]; n != "" {
				out = append(out, n)
			} else {
				out = append(out, id)
			}
		}
		return "Theo chính sách dự án " + strings.Join(out, ", ")
	}
	profiles := map[string]ProfileInfo{}
	var steps []Step

	for _, p := range m.Profiles {
		file := configPath(p.Profile)
		if file == "" {
			continue
		}
		profiles[p.ID] = p
		cur := levels[p.ID]
		curRank := 0
		if cur != "" {
			curRank = levelRank(cur)
		}
		want := levelRank(target.Level)
		// Đích aggressive mà gói chưa bật: balanced chọn sẵn, aggressive tách dòng riêng cần xác nhận (FR-015), để bỏ
		// dòng aggressive thì gói vẫn được tối ưu.
		var plan []string
		if want >= levelRank(LevelBalanced) && curRank < levelRank(LevelBalanced) {
			plan = append(plan, LevelBalanced)
		}
		if want == levelRank(LevelAggressive) && curRank < want {
			plan = append(plan, LevelAggressive)
		}
		before := cur
		for _, level := range plan {
			s := Step{ID: StepOptimizerEnable, Group: GroupCLI, Target: p.ID, Profile: p.ID, Level: level, RTK: p.RTK,
				AutoCompactWindow: target.AutoCompactWindow, Undoable: true, Reason: reason(target.LevelFrom),
				Selected: level != LevelAggressive && !p.Default, RequiresConfirm: level == LevelAggressive || p.Default}
			s.Title = enableTitle(label(p), before, level)
			s.Changes = []Change{{File: file, Key: "level", Before: strPtr(before), After: strPtr(level)}}
			if w := target.AutoCompactWindow; w != nil && before == cur {
				s.Changes = append(s.Changes, Change{File: file, Key: windowKey(p.CLI), After: strPtr(strconv.Itoa(*w))})
			}
			steps = append(steps, s)
			before = level
		}
	}

	if target.Level != LevelOff {
		for _, p := range m.Profiles {
			if p.CLI != "claude" || p.RTK || profiles[p.ID].ID == "" || !(m.RTKSupported || suggested(m, "tool.rtk", "")) {
				continue
			}
			if !target.RTK && !suggested(m, "optimizer.rtk", p.ID) {
				continue
			}
			steps = append(steps, Step{ID: fixPrefix + "optimizer.rtk", Group: GroupCLI, Target: p.ID, Profile: p.ID,
				Title: "Bật RTK cho " + label(p), Changes: []Change{}, Selected: !p.Default, RequiresConfirm: p.Default,
				Undoable: true, Reason: reason(target.RTKFrom)})
		}
	}

	seen := map[string]bool{}
	for _, tool := range toolIDs {
		if !suggested(m, toolPrefix+tool, "") {
			continue
		}
		from := target.CodegraphFrom
		if tool == "rtk" {
			from = target.RTKFrom
		}
		steps = append(steps, Step{ID: toolPrefix + tool, Group: GroupTools, Target: tool, Title: "Cài " + tool,
			Changes: []Change{}, Selected: true, Reason: reason(from)})
	}
	for _, s := range m.Fixes {
		if !plannedFixes[s.ID] || !strings.HasPrefix(s.ID, "codegraph.") {
			continue
		}
		p, ok := profiles[s.Profile]
		if s.ID == "codegraph.init" {
			// codegraph.init chạy trong thư mục dự án, nên chỉ cho dự án đã gắn trên máy này.
			if !linked[s.Project] {
				continue
			}
		} else if !ok {
			continue
		}
		key := s.ID + "@" + s.Profile + "@" + s.Project
		if seen[key] {
			continue
		}
		seen[key] = true
		st := Step{ID: fixPrefix + s.ID, Group: GroupTools, Target: s.Profile, Profile: s.Profile, Project: s.Project,
			Changes: []Change{}, Selected: true, Undoable: true, Reason: reason(target.CodegraphFrom)}
		if s.ID == "codegraph.init" {
			st.Target = s.Project
			st.Title = "Lập chỉ mục codegraph cho dự án " + nameOr(names, s.Project)
		} else {
			st.Title = "Thêm MCP codegraph cho " + label(p)
		}
		if s.Title != "" {
			st.Title = s.Title
		}
		steps = append(steps, st)
	}

	if r.Context != nil {
		projects, err := r.Context.Enabled()
		if err != nil {
			return OptimizePlan{}, err
		}
		for _, p := range projects {
			s := Step{ID: StepContextSync, Group: GroupContext, Target: p.Key, Project: p.Key, Selected: true, Undoable: true,
				Title: "Cập nhật khối ngữ cảnh của dự án " + firstNonEmpty(p.Name, names[p.Key], p.Key), Changes: []Change{},
				Reason: "Mặc định"}
			if _, ok := policies[p.Key]; ok {
				s.Reason = reason([]string{p.Key})
			}
			for _, f := range p.Files {
				s.Changes = append(s.Changes, Change{File: f, Key: "Khối xDev Hive"})
			}
			steps = append(steps, s)
		}
	}

	steps = append(steps, Step{ID: StepScoreRecompute, Group: GroupScore, Target: "machine", Title: "Tính lại điểm token",
		Changes: []Change{}, Selected: true, Reason: "Mặc định"})
	score, _ := r.score()
	sources := target.Sources
	if sources == nil {
		sources = []string{}
	}
	return OptimizePlan{CreatedAt: r.now().UTC(), ScoreBefore: score, PolicySources: sources, Steps: steps}, nil
}

func (r *Runner) machine() (Machine, error) {
	if r.Machine == nil {
		return Machine{}, nil
	}
	return r.Machine()
}

// levels đọc mức đang bật của từng gói từ manifest optimizer (state.json), không tin ảnh chụp của bên gọi.
func (r *Runner) levels() (map[string]string, error) {
	out := map[string]string{}
	if r.Optimizer == nil {
		return out, nil
	}
	st, err := r.Optimizer.Status()
	if err != nil {
		return nil, err
	}
	for _, s := range st {
		out[s.ID] = s.Level
	}
	return out, nil
}

func (r *Runner) score() (*float64, error) {
	if r.Scorer == nil {
		return nil, nil
	}
	return r.Scorer.Score()
}

func suggested(m Machine, id, profile string) bool {
	for _, f := range m.Fixes {
		if f.ID == id && (profile == "" || f.Profile == profile) {
			return true
		}
	}
	return false
}

// configPath là file optimizer ghi cho gói; rỗng là CLI chưa hỗ trợ tối ưu.
func configPath(p optimizer.Profile) string {
	switch p.CLI {
	case "claude":
		return filepath.Join(p.Dir, "settings.json")
	case "codex":
		return filepath.Join(p.Dir, "config.toml")
	}
	return ""
}

func windowKey(cli string) string {
	if cli == "codex" {
		return "codex.model_auto_compact_token_limit"
	}
	return "env.CLAUDE_CODE_AUTO_COMPACT_WINDOW"
}

func enableTitle(name, from, to string) string {
	if from == "" {
		return "Bật tối ưu " + to + " cho " + name
	}
	return "Đổi tối ưu của " + name + " từ " + from + " sang " + to
}

func label(p ProfileInfo) string { return firstNonEmpty(p.Label, p.ID) }

func nameOr(names map[string]string, id string) string { return firstNonEmpty(names[id], id) }

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
