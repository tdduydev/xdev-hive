package ctxsync

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"github.com/tdduydev/xdev-hive/worker/internal/gitexclude"
	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

// DefaultBudgetTokens là ngân sách token của mục "Từ hub" khi dự án không có chính sách (FR-022).
const (
	DefaultBudgetTokens = 2000
	defaultSyncMinutes  = 60
)

// Conflict là hai bản khi khối trong file bị sửa tay: phần "Tại máy" trong file và nguồn hiện tại.
type Conflict struct {
	File   string `json:"file"`
	Source string `json:"source"`
}

// Target là một file đích trong kết quả cho app (ContextTarget ở contracts/sidecar-cli.md).
type Target struct {
	ID       TargetID  `json:"id"`
	Path     string    `json:"path"`
	Status   string    `json:"status"`
	Reason   *string   `json:"reason"`
	Conflict *Conflict `json:"conflict,omitempty"`
}

type Omitted struct {
	Budget int `json:"budget"`
	Secret int `json:"secret"`
}

type HubView struct {
	SyncedAt  *string `json:"syncedAt"`
	Items     int     `json:"items"`
	Omitted   Omitted `json:"omitted"`
	LastError *string `json:"lastError"`
}

// Project là ContextProject: trạng thái ngữ cảnh dùng chung của một dự án.
type Project struct {
	Key          string   `json:"key"`
	ProjectID    *string  `json:"projectId"`
	Folder       string   `json:"folder"`
	Enabled      bool     `json:"enabled"`
	Source       string   `json:"source"`
	SourceTokens int      `json:"sourceTokens"`
	BlockTokens  int      `json:"blockTokens"`
	Targets      []Target `json:"targets"`
	Hub          *HubView `json:"hub"`
	AutoSync     AutoSync `json:"autoSync"`
	Locked       bool     `json:"locked,omitempty"`
}

// DisableResult: đường dẫn (tương đối với thư mục dự án) đã gỡ khối và đã cho vào thùng rác. Entry là mã khôi phục.
type DisableResult struct {
	Removed  []string `json:"removed"`
	Trashed  []string `json:"trashed"`
	Warnings []string `json:"warnings,omitempty"`
	Entry    string   `json:"entry,omitempty"`
}

func defaultAutoSync() AutoSync { return AutoSync{Minutes: defaultSyncMinutes, Source: "machine"} }

// Enable bật ngữ cảnh dùng chung cho thư mục (gắn dự án hub nếu có projectID) rồi ghi mọi file đích.
func (m Manager) Enable(folder, projectID string) (Project, error) {
	abs, err := filepath.Abs(folder)
	if err != nil {
		return Project{}, err
	}
	abs = filepath.Clean(abs)
	if st, err := os.Stat(abs); err != nil || !st.IsDir() {
		return Project{}, fmt.Errorf("không thấy thư mục dự án %s", abs)
	}
	key, err := KeyFor(projectID, abs)
	if err != nil {
		return Project{}, err
	}
	st, err := m.loadState(key)
	switch {
	case errors.Is(err, ErrNotFound):
		st = State{AutoSync: defaultAutoSync()}
	case err != nil:
		return Project{}, err
	}
	// Dự án hub chuyển sang thư mục khác: gỡ khối ở chỗ cũ, giữ nguồn.
	if st.Enabled && st.Folder != "" && !samePath(st.Folder, abs) {
		if _, err := m.removeTargets(&st); err != nil {
			return Project{}, err
		}
		// Created, Lead, ExcludeAdded thuộc thư mục cũ; giữ lại thì lúc tắt sẽ xoá file và dòng exclude của người dùng.
		st.Targets = nil
	}
	st.Enabled, st.Folder, st.ProjectID = true, abs, projectID
	if st.AutoSync.Minutes == 0 {
		st.AutoSync = defaultAutoSync()
	}
	for _, id := range Targets {
		st.target(id)
	}
	if _, err := os.Stat(m.sourcePath(key)); os.IsNotExist(err) {
		if err := writeFile(m.sourcePath(key), nil, 0o600); err != nil {
			return Project{}, err
		}
	}
	if err := m.saveState(key, st); err != nil {
		return Project{}, err
	}
	p, _, err := m.Sync(key, nil, nil)
	return p, err
}

// Sync ghi lại mọi file đích từ nguồn và bản hub. hub khác nil thì thay bản hub đã lưu (hub.Error khác rỗng thì giữ bản
// cũ, ghi lỗi); policy khác nil thì áp ngân sách và lịch tự đồng bộ của dự án. Trả mã bản sao lưu memstore của lần ghi (rỗng khi không đổi gì) để hoàn tác.
func (m Manager) Sync(key string, hub *HubSnapshot, policy *Policy) (Project, string, error) {
	st, err := m.loadState(key)
	if err != nil {
		return Project{}, "", err
	}
	if !st.Enabled {
		return Project{}, "", fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if hub != nil || policy != nil {
		if err := m.updateHub(key, st, hub, policy); err != nil {
			return Project{}, "", err
		}
	}
	if policy != nil {
		st.AutoSync = autoSyncFor(st.AutoSync, policy)
	}
	plans, entry, err := m.apply(key, &st, nil)
	if err != nil {
		return Project{}, "", err
	}
	if err := m.saveState(key, st); err != nil {
		return Project{}, entry, err
	}
	p, err := m.view(key, st, plans)
	return p, entry, err
}

// Resolve giải xung đột của một file đích: keep="source" ghi đè khối bằng nguồn; keep="file" lấy phần "Tại máy" trong
// file làm nguồn mới rồi ghi lại mọi file đích.
func (m Manager) Resolve(key string, id TargetID, keep string) (Project, error) {
	if !validTarget(id) {
		return Project{}, fmt.Errorf("file đích không hợp lệ: %q", id)
	}
	if keep != "file" && keep != "source" {
		return Project{}, fmt.Errorf("--keep phải là file hoặc source: %q", keep)
	}
	st, err := m.loadState(key)
	if err != nil {
		return Project{}, err
	}
	if !st.Enabled {
		return Project{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	local, err := m.Source(key)
	if err != nil {
		return Project{}, err
	}
	hub, err := m.hubItems(key)
	if err != nil {
		return Project{}, err
	}
	cur := m.plan(st, *st.target(id), local, hub, false)
	if cur.status != StatusConflict {
		return Project{}, fmt.Errorf("%s không có xung đột", targetPath(id))
	}
	if keep == "file" {
		if err := writeFile(m.sourcePath(key), []byte(cur.conflict.File), 0o600); err != nil {
			return Project{}, err
		}
	}
	plans, _, err := m.apply(key, &st, map[TargetID]bool{id: true})
	if err != nil {
		return Project{}, err
	}
	if err := m.saveState(key, st); err != nil {
		return Project{}, err
	}
	return m.view(key, st, plans)
}

// Disable gỡ khối khỏi mọi file đích, cho file app tạo vào thùng rác và gỡ dòng exclude app đã thêm. Nguồn được giữ để
// bật lại không mất chữ.
func (m Manager) Disable(key string) (DisableResult, error) {
	st, err := m.loadState(key)
	if err != nil {
		return DisableResult{}, err
	}
	res, err := m.removeTargets(&st)
	if err != nil {
		return res, err
	}
	st.Enabled, st.Targets = false, nil
	return res, m.saveState(key, st)
}

// Status là trạng thái hiện tại, không ghi gì. key rỗng là mọi dự án.
func (m Manager) Status(key string) ([]Project, error) {
	keys := []string{key}
	if key == "" {
		keys = nil
		entries, err := os.ReadDir(m.Root)
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		for _, e := range entries {
			if e.IsDir() && keyRe.MatchString(e.Name()) {
				keys = append(keys, e.Name())
			}
		}
		sort.Strings(keys)
	}
	out := []Project{}
	for _, k := range keys {
		st, err := m.loadState(k)
		if err != nil {
			if key == "" && errors.Is(err, ErrNotFound) {
				continue
			}
			return nil, err
		}
		var plans []planned
		if st.Enabled {
			local, err := m.Source(k)
			if err != nil {
				return nil, err
			}
			hub, err := m.hubItems(k)
			if err != nil {
				return nil, err
			}
			for _, id := range Targets {
				p := m.plan(st, *st.target(id), local, hub, false)
				if p.status == StatusOK && len(p.writes) > 0 {
					p.status = StatusStale
				}
				plans = append(plans, p)
			}
		}
		p, err := m.view(k, st, plans)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// plan tính một file đích, chưa ghi gì.
func (m Manager) plan(st State, ts TargetState, local string, hub []HubItem, force bool) planned {
	id := ts.ID
	if !Readable[id] {
		return skipped(id, targetNames[id]+" chưa hỗ trợ đọc file ngữ cảnh cục bộ")
	}
	if !m.installed(id) {
		return skipped(id, "Chưa cài "+targetNames[id]+" trên máy")
	}
	if info, err := os.Stat(st.Folder); err != nil || !info.IsDir() {
		return skipped(id, "Không thấy thư mục dự án "+st.Folder)
	}
	rel := targetPath(id)
	if id != Gemini && gitexclude.Tracked(st.Folder, rel) {
		return skipped(id, trackedReason(rel))
	}
	body := renderBody(local, hub, false)
	switch id {
	case Claude:
		cur, exists, reason := readTarget(st.Folder, rel)
		if reason != "" {
			return skipped(id, reason)
		}
		return planEmbedded(id, rel, cur, exists, renderBody(local, hub, claudeImportsAgents(st.Folder)), local, force)
	case Codex:
		return planCodex(st.Folder, body, local, force)
	case Gemini:
		return planGemini(st.Folder, ts, body, local, force)
	case Antigravity:
		return planAntigravity(st.Folder, body, local, force)
	}
	return skipped(id, "File đích không hợp lệ")
}

// apply tính rồi ghi mọi file đích trong một bản sao lưu memstore ("context.sync"), cập nhật st.Targets.
func (m Manager) apply(key string, st *State, force map[TargetID]bool) ([]planned, string, error) {
	local, err := m.Source(key)
	if err != nil {
		return nil, "", err
	}
	hub, err := m.hubItems(key)
	if err != nil {
		return nil, "", err
	}
	for _, id := range Targets {
		st.target(id)
	}
	var plans []planned
	var batch *memstore.Batch
	saved := 0
	for _, id := range Targets {
		ts := st.target(id)
		p := m.plan(*st, *ts, local, hub, force[id])
		if p.status == StatusOK && len(p.writes) > 0 {
			if batch == nil {
				if batch, err = m.Store.Begin("context.sync", false); err != nil {
					return nil, "", err
				}
			}
			// Đếm cả file đã sao lưu trước khi hỏng: file đó đã bị ghi đè, Abort sẽ mất bản sao lưu của nó.
			n, err := m.write(st.Folder, batch, &p)
			saved += n
			if err != nil {
				p.status, p.reason = StatusSkipped, err.Error()
			}
		}
		record(ts, p)
		plans = append(plans, p)
	}
	if batch == nil {
		return plans, "", nil
	}
	if saved == 0 {
		batch.Abort()
		return plans, "", nil
	}
	res, err := batch.Commit()
	if err != nil {
		return plans, "", err
	}
	return plans, res.Entry, nil
}

// write ghi các file của một file đích: thêm exclude trước để file mới không lộ ra git status dù chỉ một lúc. saved là
// số file đã sao lưu, kể cả khi hỏng giữa chừng.
func (m Manager) write(folder string, batch *memstore.Batch, p *planned) (saved int, err error) {
	for _, rel := range p.excludes {
		added, warn := gitexclude.Add(folder, rel)
		if warn != "" {
			p.reason = warn
		}
		if !added {
			continue
		}
		// Dòng exclude của settings Gemini ghi vào extra, các dòng khác vào file đích.
		line := gitexclude.Line(rel)
		if p.extra != nil && line == gitexclude.Line(geminiSettings) {
			p.extra.ExcludeAdded = strPtr(line)
		} else {
			p.excludeLine = strPtr(line)
		}
	}
	for _, w := range p.writes {
		path := filepath.Join(folder, w.rel)
		if err := batch.Save(path, false); err != nil {
			return saved, fmt.Errorf("không sao lưu được %s: %v", filepath.ToSlash(w.rel), err)
		}
		saved++
		if err := writeFile(path, []byte(w.content), fileMode(path)); err != nil {
			return saved, fmt.Errorf("không ghi được %s: %v", filepath.ToSlash(w.rel), err)
		}
	}
	return saved, nil
}

// record chép kết quả vào state.json.
func record(ts *TargetState, p planned) {
	// Ghi cả khi ghi file hỏng giữa chừng: dòng đã thêm vào exclude thì lúc tắt phải gỡ được.
	if p.excludeLine != nil && ts.ExcludeAdded == nil {
		ts.ExcludeAdded = p.excludeLine
	}
	ts.Status = p.status
	ts.Reason = nil
	if p.reason != "" {
		ts.Reason = strPtr(p.reason)
	}
	if p.status != StatusOK {
		return
	}
	ts.BlockSha = p.sha
	if p.created {
		ts.Created = true
	}
	if p.lead != nil {
		ts.Lead = *p.lead
	}
	if p.mirror != nil {
		ts.MirrorOf = p.mirror
	}
	if p.extra != nil {
		if ts.Extra != nil && ts.Extra.ExcludeAdded != nil && p.extra.ExcludeAdded == nil {
			p.extra.ExcludeAdded = ts.Extra.ExcludeAdded
		}
		ts.Extra = p.extra
	}
}

func (m Manager) view(key string, st State, plans []planned) (Project, error) {
	local, err := m.Source(key)
	if err != nil {
		return Project{}, err
	}
	hub, err := m.loadHub(key)
	if err != nil {
		return Project{}, err
	}
	var items []HubItem
	if hub != nil {
		items = hub.Items
	}
	p := Project{Key: key, Folder: st.Folder, Enabled: st.Enabled, AutoSync: st.AutoSync, Targets: []Target{},
		Source: local, SourceTokens: memstore.EstimateTokens(local), BlockTokens: memstore.EstimateTokens(renderBody(local, items, false))}
	if p.AutoSync.Source == "" {
		p.AutoSync = defaultAutoSync()
	}
	if st.ProjectID != "" {
		p.ProjectID = strPtr(st.ProjectID)
	}
	if hub != nil {
		p.Hub = &HubView{SyncedAt: hub.SyncedAt, Items: len(hub.Items), Omitted: hub.Omitted, LastError: hub.LastError}
	}
	for _, pl := range plans {
		t := Target{ID: pl.id, Path: filepath.ToSlash(targetPath(pl.id)), Status: pl.status, Conflict: pl.conflict}
		if pl.reason != "" {
			t.Reason = strPtr(pl.reason)
		}
		p.Targets = append(p.Targets, t)
	}
	return p, nil
}

// removeTargets gỡ khối khỏi mọi file đích trong một bản lưu thùng rác ("context.disable").
func (m Manager) removeTargets(st *State) (DisableResult, error) {
	res := DisableResult{Removed: []string{}, Trashed: []string{}}
	folder := st.Folder
	if info, err := os.Stat(folder); err != nil || !info.IsDir() {
		return res, nil
	}
	batch, err := m.Store.Begin("context.disable", true)
	if err != nil {
		return res, err
	}
	saved := 0
	warn := func(format string, args ...any) { res.Warnings = append(res.Warnings, fmt.Sprintf(format, args...)) }
	trash := func(rel string) {
		path := filepath.Join(folder, rel)
		if err := batch.Save(path, true); err != nil {
			warn("không sao lưu được %s: %v", filepath.ToSlash(rel), err)
			return
		}
		saved++
		if err := os.Remove(path); err != nil {
			warn("không xoá được %s: %v", filepath.ToSlash(rel), err)
			return
		}
		res.Trashed = append(res.Trashed, filepath.ToSlash(rel))
	}
	rewrite := func(rel, content string) {
		path := filepath.Join(folder, rel)
		if err := batch.Save(path, false); err != nil {
			warn("không sao lưu được %s: %v", filepath.ToSlash(rel), err)
			return
		}
		saved++
		if err := writeFile(path, []byte(content), fileMode(path)); err != nil {
			warn("không ghi được %s: %v", filepath.ToSlash(rel), err)
			return
		}
		res.Removed = append(res.Removed, filepath.ToSlash(rel))
	}
	for _, ts := range st.Targets {
		rel := targetPath(ts.ID)
		if rel == "" {
			continue
		}
		cur, exists, reason := readTarget(folder, rel)
		switch {
		case reason != "":
			if ts.Status != StatusSkipped {
				warn("%s", reason)
			}
		case exists && gitexclude.Tracked(folder, rel):
			warn("%s", trackedReason(rel))
		case exists:
			b, bad := singleBlock(rel, cur)
			switch {
			case bad != "":
				warn("%s", bad)
			case b == nil:
			case ts.ID == Codex || ts.ID == Antigravity:
				// Gương Codex và rule Antigravity cả file là của app.
				trash(rel)
				if ts.ID == Antigravity {
					removeEmptyDirs(folder, filepath.Join(".agents", "rules"), ".agents")
				}
			default:
				next := removeBlock(cur, *b, ts.Lead)
				if ts.Created && strings.TrimSpace(strings.TrimPrefix(next, bom)) == "" {
					trash(rel)
				} else {
					rewrite(rel, next)
				}
			}
		}
		if ts.ID == Gemini && ts.Extra != nil {
			m.revertGemini(folder, ts.Extra, trash, rewrite, warn)
		}
		if ts.ExcludeAdded != nil {
			if w := gitexclude.Remove(folder, *ts.ExcludeAdded); w != "" {
				warn("%s", w)
			}
		}
	}
	if saved == 0 {
		batch.Abort()
		return res, nil
	}
	out, err := batch.Commit()
	if err != nil {
		return res, err
	}
	res.Entry = out.Entry
	return res, nil
}

// revertGemini trả .gemini/settings.json về như trước khi bật: còn đúng bản app ghi thì ghi lại nguyên byte cũ, không thì
// chỉ gỡ tên GEMINI.local.md.
func (m Manager) revertGemini(folder string, extra *GeminiExtra, trash func(string), rewrite func(string, string), warn func(string, ...any)) {
	rel := filepath.FromSlash(extra.Settings)
	cur, exists, reason := readTarget(folder, rel)
	switch {
	case reason != "":
		warn("%s", reason)
	case !exists:
	case extra.WroteSha != "" && hashBody(cur) == extra.WroteSha:
		if extra.Created {
			trash(rel)
			removeEmptyDirs(folder, ".gemini")
		} else {
			rewrite(rel, extra.Before)
		}
	default:
		next, changed, empty, err := removeFileName([]byte(cur))
		switch {
		case err != nil:
			warn("%s: %v", extra.Settings, err)
		case !changed:
		case empty && extra.Created:
			trash(rel)
			removeEmptyDirs(folder, ".gemini")
		default:
			rewrite(rel, string(next))
		}
	}
	if extra.ExcludeAdded != nil {
		if w := gitexclude.Remove(folder, *extra.ExcludeAdded); w != "" {
			warn("%s", w)
		}
	}
}

// removeEmptyDirs dọn thư mục app tạo cho file đích nếu đã rỗng; còn gì khác thì Remove báo lỗi và để nguyên.
func removeEmptyDirs(folder string, rels ...string) {
	for _, rel := range rels {
		_ = os.Remove(filepath.Join(folder, rel))
	}
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}
