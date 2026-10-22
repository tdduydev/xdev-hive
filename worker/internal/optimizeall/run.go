package optimizeall

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/optimizer"
)

// keepRuns: giữ 30 lần gần nhất (data-model "Lần tối ưu"); chỉ lần mới nhất hoàn tác được nên lần cũ chỉ để xem lại.
const keepRuns = 30

// Mã lỗi trả cho app.
const (
	CodeLocked        = "OPTIMIZE_LOCKED"
	CodeInvalidPlan   = "INVALID_PLAN"
	CodeRunNotFound   = "RUN_NOT_FOUND"
	CodeNotLatest     = "RUN_NOT_LATEST"
	CodeAlreadyUndone = "RUN_ALREADY_UNDONE"
)

// Error là lỗi có mã để lệnh CLI in `{"error":{"code","message"}}`.
type Error struct {
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

// Undo là dữ liệu hoàn tác của một bước. Files: mã băm từng file ngay sau bước, để hoàn tác nhận ra file bị sửa tay
// ("" là file không còn). CLI, Dir giữ gói như lúc chạy, vì accounts.json có thể đã đổi khi hoàn tác.
type Undo struct {
	Kind        string            `json:"kind"`
	Profile     string            `json:"profile,omitempty"`
	CLI         string            `json:"cli,omitempty"`
	Dir         string            `json:"dir,omitempty"`
	Default     bool              `json:"default,omitempty"`
	Backup      string            `json:"backup,omitempty"`
	PrevEnabled *bool             `json:"prevEnabled,omitempty"`
	PrevLevel   string            `json:"prevLevel,omitempty"`
	PrevRTK     bool              `json:"prevRTK,omitempty"`
	Project     string            `json:"project,omitempty"`
	Record      json.RawMessage   `json:"record,omitempty"`
	Entry       string            `json:"entry,omitempty"`
	Files       map[string]string `json:"files,omitempty"`
}

// Kiểu dữ liệu hoàn tác.
const (
	UndoOptimizer = "optimizer"
	UndoScoreFix  = "scoreFix"
	UndoMemstore  = "memstore"
)

// RunStep là một bước trong nhật ký. Status, Error che hai trường cùng tên của Step để luôn có mặt trong JSON.
type RunStep struct {
	Step
	Status string  `json:"status"`
	Error  *string `json:"error"`
	Undo   *Undo   `json:"undo"`
}

// OptimizeRun là file optimizer/runs/<id>.json.
type OptimizeRun struct {
	ID            string     `json:"id"`
	StartedAt     time.Time  `json:"startedAt"`
	FinishedAt    *time.Time `json:"finishedAt"`
	ScoreBefore   *float64   `json:"scoreBefore"`
	ScoreAfter    *float64   `json:"scoreAfter"`
	PolicySources []string   `json:"policySources"`
	Steps         []RunStep  `json:"steps"`
	UndoneAt      *time.Time `json:"undoneAt"`
}

func (r *Runner) runsDir() string { return filepath.Join(r.Dir, "runs") }

// validatePlan từ chối cả kế hoạch nếu có bước ngoài danh sách đóng, trước khi ghi bất cứ gì: kế hoạch đi qua file tạm
// từ app nên không tin nó.
func validatePlan(plan OptimizePlan) error {
	for _, s := range plan.Steps {
		if !ValidStepID(s.ID) {
			return &Error{Code: CodeInvalidPlan, Message: fmt.Sprintf("Bước %q không có trong danh sách được phép", s.ID)}
		}
		if s.Group != "" && s.Group != groupOf(s.ID) {
			return &Error{Code: CodeInvalidPlan, Message: fmt.Sprintf("Bước %s không thuộc nhóm %q", s.ID, s.Group)}
		}
		if s.ID == StepOptimizerEnable && s.Level != LevelBalanced && s.Level != LevelAggressive {
			return &Error{Code: CodeInvalidPlan, Message: fmt.Sprintf("Bước bật tối ưu cho %s thiếu mức hợp lệ", s.Target)}
		}
	}
	return nil
}

// Apply chạy các bước đã chọn theo thứ tự. Nhật ký được ghi trước bước đầu và sau mỗi bước, để tiến trình chết giữa
// chừng vẫn hoàn tác được phần đã làm. Bước lỗi không dừng bước sau (FR-012).
func (r *Runner) Apply(plan OptimizePlan) (*OptimizeRun, error) {
	if err := validatePlan(plan); err != nil {
		return nil, err
	}
	unlock, err := Lock(r.Dir)
	if err != nil {
		return nil, err
	}
	defer unlock()

	start := r.now().UTC()
	run := &OptimizeRun{ID: newULID(start), StartedAt: start, PolicySources: plan.PolicySources, Steps: []RunStep{}}
	if run.PolicySources == nil {
		run.PolicySources = []string{}
	}
	// Điểm trước là điểm lúc xem trước: app đã cài công cụ (tool.*) giữa xem trước và áp dụng.
	run.ScoreBefore = plan.ScoreBefore
	if run.ScoreBefore == nil {
		run.ScoreBefore, _ = r.score()
	}
	for _, s := range plan.Steps {
		s.Group, s.Undoable = groupOf(s.ID), undoable(s.ID)
		if s.Changes == nil {
			s.Changes = []Change{}
		}
		rs := RunStep{Step: s, Status: StatusPlanned}
		switch {
		case s.ID == StepScoreRecompute:
			// Luôn chạy: điểm sau là thứ người dùng xem để biết lần tối ưu có tác dụng.
			rs.Selected = true
		case !s.Selected:
			rs.Status = StatusSkipped
		case strings.HasPrefix(s.ID, toolPrefix):
			rs.Status, rs.Error = s.Status, s.Error
			if rs.Status != StatusOK && rs.Status != StatusFailed {
				rs.Status, rs.Error = StatusSkipped, strPtr("App chưa chạy bước cài công cụ này")
			}
		}
		rs.Step.Status, rs.Step.Error = "", nil
		run.Steps = append(run.Steps, rs)
	}
	if err := r.writeRun(run); err != nil {
		return nil, err
	}

	m, merr := r.machine()
	for i := range run.Steps {
		s := &run.Steps[i]
		if s.Status != StatusPlanned {
			continue
		}
		var undo *Undo
		var err error
		switch {
		case merr != nil && s.Group == GroupCLI:
			err = merr
		case s.ID == StepOptimizerEnable:
			undo, err = r.applyEnable(m, s.Step)
		case strings.HasPrefix(s.ID, fixPrefix):
			undo, err = r.applyFix(s.Step)
		case s.ID == StepContextSync:
			undo, err = r.applyContext(s.Step)
		case s.ID == StepScoreRecompute:
			run.ScoreAfter, err = r.score()
		}
		s.Undo = undo
		if err != nil {
			s.Status, s.Error = StatusFailed, strPtr(err.Error())
		} else {
			s.Status = StatusOK
		}
		if err := r.writeRun(run); err != nil {
			return run, err
		}
	}
	end := r.now().UTC()
	run.FinishedAt = &end
	if err := r.writeRun(run); err != nil {
		return run, err
	}
	return run, r.prune()
}

func (r *Runner) applyEnable(m Machine, s Step) (*Undo, error) {
	if r.Enabler == nil || r.Optimizer == nil {
		return nil, errors.New("chưa có bộ bật tối ưu")
	}
	var info *ProfileInfo
	for i := range m.Profiles {
		if m.Profiles[i].ID == s.Target {
			info = &m.Profiles[i]
		}
	}
	if info == nil {
		return nil, fmt.Errorf("không thấy gói %s trên máy", s.Target)
	}
	levels, err := r.levels()
	if err != nil {
		return nil, err
	}
	prev := levels[info.ID]
	res, err := r.Enabler.Enable(info.Profile, EnableRequest{Level: s.Level, RTK: info.RTK,
		AutoCompactWindow: s.AutoCompactWindow, Explicit: true})
	if err != nil {
		return nil, err
	}
	u := &Undo{Kind: UndoOptimizer, Profile: info.ID, CLI: info.CLI, Dir: info.Dir, Default: info.Default,
		PrevEnabled: boolPtr(prev != ""), PrevLevel: prev, PrevRTK: info.RTK}
	if prev == "" {
		// Lần bật đầu: bản sao lưu này là file trước khi bật, cũng là bản optimizer coi là gốc.
		u.Backup = res.Backup
	}
	u.Files = hashFiles([]string{configPath(info.Profile)})
	return u, nil
}

func (r *Runner) applyFix(s Step) (*Undo, error) {
	if r.Fixer == nil {
		return nil, errors.New("chưa có bộ chạy sửa nhanh")
	}
	req := FixRequest{FixID: strings.TrimPrefix(s.ID, fixPrefix), Profile: s.Profile, Project: s.Project}
	out, err := r.Fixer.Apply(req)
	if err != nil {
		return nil, err
	}
	return &Undo{Kind: UndoScoreFix, Profile: s.Profile, Project: s.Project, Record: out.Record,
		Files: hashFiles(out.Files)}, nil
}

func (r *Runner) applyContext(s Step) (*Undo, error) {
	if r.Context == nil {
		return nil, errors.New("chưa có bộ đồng bộ ngữ cảnh")
	}
	key := firstNonEmpty(s.Project, s.Target)
	entry, err := r.Context.Sync(key)
	if err != nil {
		return nil, err
	}
	u := &Undo{Kind: UndoMemstore, Project: key, Entry: entry}
	if entry == "" {
		return u, nil
	}
	list, err := r.Store.Entries()
	if err != nil {
		return u, nil
	}
	for _, e := range list {
		if e.ID == entry {
			u.Files = hashFiles(e.Paths)
		}
	}
	return u, nil
}

// hashFiles băm nội dung hiện tại; file không có ghi "" để phân biệt với file rỗng.
func hashFiles(paths []string) map[string]string {
	if len(paths) == 0 {
		return nil
	}
	out := map[string]string{}
	for _, p := range paths {
		if p == "" {
			continue
		}
		out[filepath.Clean(p)] = hashFile(p)
	}
	return out
}

func hashFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

func (r *Runner) writeRun(run *OptimizeRun) error {
	dir := r.runsDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(run, "", "  ")
	if err != nil {
		return err
	}
	// Ghi file tạm rồi đổi tên: app đọc nhật ký giữa chừng không thấy JSON cụt.
	tmp, err := os.CreateTemp(dir, run.ID+".*.tmp")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, run.ID+".json")); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}

// runIDs liệt kê id lần chạy, cũ trước. ULID sắp theo chữ cũng là theo thời gian.
func (r *Runner) runIDs() ([]string, error) {
	entries, err := os.ReadDir(r.runsDir())
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var ids []string
	for _, e := range entries {
		name := e.Name()
		if id, ok := strings.CutSuffix(name, ".json"); ok && validRunID(id) {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

func (r *Runner) readRun(id string) (*OptimizeRun, error) {
	raw, err := os.ReadFile(filepath.Join(r.runsDir(), id+".json"))
	if err != nil {
		return nil, err
	}
	var run OptimizeRun
	if err := json.Unmarshal(raw, &run); err != nil {
		return nil, fmt.Errorf("nhật ký lần tối ưu %s hỏng: %w", id, err)
	}
	return &run, nil
}

// Last là lần chạy gần nhất (`optimize all --last`); nil khi chưa chạy lần nào.
func (r *Runner) Last() (*OptimizeRun, error) {
	ids, err := r.runIDs()
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return r.readRun(ids[len(ids)-1])
}

func (r *Runner) prune() error {
	ids, err := r.runIDs()
	if err != nil {
		return err
	}
	for len(ids) > keepRuns {
		if err := os.Remove(filepath.Join(r.runsDir(), ids[0]+".json")); err != nil && !os.IsNotExist(err) {
			return err
		}
		ids = ids[1:]
	}
	return nil
}

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func validRunID(id string) bool {
	if len(id) != 26 {
		return false
	}
	for _, c := range id {
		if !strings.ContainsRune(crockford, c) {
			return false
		}
	}
	return true
}

// newULID: 48 bit mili giây + 80 bit ngẫu nhiên, mã Crockford như ULID chuẩn (giống newEventKey của cmd); module worker
// không thêm thư viện cho việc này.
func newULID(now time.Time) string {
	var b [16]byte
	ms := uint64(now.UnixMilli())
	for i := 5; i >= 0; i-- {
		b[i] = byte(ms)
		ms >>= 8
	}
	_, _ = rand.Read(b[6:])
	out := make([]byte, 26)
	out[0] = crockford[b[0]>>5]
	acc, bits, j := uint32(b[0]&0x1f), 5, 1
	for i := 1; i < 16; i++ {
		acc = acc<<8 | uint32(b[i])
		bits += 8
		for bits >= 5 {
			bits -= 5
			out[j] = crockford[(acc>>bits)&0x1f]
			j++
		}
	}
	return string(out)
}

func boolPtr(v bool) *bool { return &v }

// profileOf dựng lại gói từ dữ liệu hoàn tác.
func (u *Undo) profileOf() optimizer.Profile {
	return optimizer.Profile{ID: u.Profile, CLI: u.CLI, Dir: u.Dir, Default: u.Default}
}
