package memstore

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/procattr"
)

// Dùng chung memory (spec 015 US4). Kết quả thử trên claude 2.1.299 (research.md mục 9):
//   - liên kết `projects/<khoá>/memory` -> thư mục chung: CLI đọc được và không thay liên kết, nhưng ghi qua liên kết bị
//     coi là ghi ngoài thư mục memory nên hỏi quyền mỗi lần, nên không dùng liên kết;
//   - `autoMemoryDirectory` trong `<dự án>/.claude/settings.local.json`: CLI đọc và ghi thẳng, không hỏi quyền.
//
// Vì vậy share đặt thư mục chung bằng cài đặt đó, không bằng liên kết hay đồng bộ theo mtime.
const (
	autoMemorySetting = "autoMemoryDirectory"
	// AutoMemoryMinVersion là phiên bản Claude Code duy nhất đã thử có cài đặt này; bản thấp hơn chưa kiểm nên không bật.
	AutoMemoryMinVersion = "2.1.299"
	localSettingsName    = "settings.local.json"
	sharedStateName      = "memory-shared.json"
)

// SharedProfile là gói đã góp memory vào thư mục chung; unshare trả bản sao về MemoryDir.
type SharedProfile struct {
	Profile   string `json:"profile"`
	ConfigDir string `json:"configDir"`
	MemoryDir string `json:"memoryDir"`
}

// SharedRecord là một dự án đang dùng chung.
type SharedRecord struct {
	Key         string          `json:"key"`
	ProjectPath string          `json:"projectPath"`
	SharedDir   string          `json:"sharedDir"`
	Settings    string          `json:"settings"`
	SharedAt    time.Time       `json:"sharedAt"`
	Profiles    []SharedProfile `json:"profiles"`
	// SettingsCreated, ExcludeAdded: Hive tạo file settings.local.json hay thêm dòng vào .git/info/exclude, nên unshare dọn.
	SettingsCreated bool   `json:"settingsCreated,omitempty"`
	ExcludeAdded    string `json:"excludeAdded,omitempty"`
}

type sharedState struct {
	Projects []SharedRecord `json:"projects"`
}

// Candidate là một bản của file trùng tên ở một gói.
type Candidate struct {
	Profile    string    `json:"profile"`
	Path       string    `json:"path"`
	Tokens     int       `json:"tokens"`
	ModifiedAt time.Time `json:"modifiedAt"`
}

// Conflict là file có cùng tên nhưng khác nội dung ở nhiều gói; người dùng chọn một bản qua ShareOptions.Picks.
type Conflict struct {
	Name       string      `json:"name"`
	Candidates []Candidate `json:"candidates"`
}

type ShareOptions struct {
	Key         string
	ProjectPath string
	// Roots là thư mục cấu hình của các gói Claude; gói không có memory của dự án thì bỏ qua.
	Roots []Root
	// SharedRoot là ~/.xdev-hive/memory/claude. Thư mục chung đặt theo bố cục của một thư mục cấu hình Claude
	// (projects/<khoá>/memory) để Scan quét nó như một gói tên "shared".
	SharedRoot    string
	ClaudeVersion string
	// Picks: đường dẫn tương đối trong thư mục memory -> id gói có bản được giữ.
	Picks map[string]string
}

type ShareResult struct {
	Applied   bool          `json:"applied"`
	Conflicts []Conflict    `json:"conflicts"`
	Shared    *SharedRecord `json:"shared,omitempty"`
	Result
}

// SharedMemoryDir là thư mục memory chung của một dự án dưới sharedRoot.
func SharedMemoryDir(sharedRoot, key string) string {
	return filepath.Join(sharedRoot, "projects", key, "memory")
}

// Shared liệt kê các dự án đang dùng chung.
func (s Store) Shared() ([]SharedRecord, error) {
	st, err := s.loadShared()
	return st.Projects, err
}

func (s Store) sharedStatePath() string { return filepath.Join(s.Dir, sharedStateName) }

func (s Store) loadShared() (sharedState, error) {
	raw, err := os.ReadFile(s.sharedStatePath())
	st := sharedState{Projects: []SharedRecord{}}
	if os.IsNotExist(err) {
		return st, nil
	}
	if err != nil {
		return st, err
	}
	if err := json.Unmarshal(raw, &st); err != nil {
		return sharedState{Projects: []SharedRecord{}}, fmt.Errorf("%s hỏng: %w", s.sharedStatePath(), err)
	}
	if st.Projects == nil {
		st.Projects = []SharedRecord{}
	}
	return st, nil
}

func (s Store) saveShared(st sharedState) error {
	raw, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(s.sharedStatePath(), append(raw, '\n'), 0o600)
}

// memFile là một file trong thư mục memory của một gói, theo đường dẫn tương đối.
type memFile struct {
	rel     string
	path    string
	profile string
	data    []byte
	mod     time.Time
}

func readMemoryDir(dir, profile string) ([]memFile, error) {
	var out []memFile
	root, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return nil, err
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !d.Type().IsRegular() {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, memFile{rel: filepath.ToSlash(rel), path: filepath.Join(dir, rel), profile: profile, data: data, mod: info.ModTime()})
		return nil
	})
	return out, err
}

// Share gộp memory của dự án ở các gói Claude vào một thư mục chung và đặt CLI dùng thư mục đó. File trùng tên mà khác
// nội dung phải được chọn bản (Picks); chưa chọn thì trả Conflicts và không đổi gì. Bản gốc của từng gói được sao lưu.
func (s Store) Share(opts ShareOptions) (ShareResult, error) {
	res := ShareResult{Conflicts: []Conflict{}, Result: Result{Changed: []string{}, Warnings: []string{}}}
	if opts.Key == "" || strings.ContainsAny(opts.Key, `/\`) || opts.Key == "." || opts.Key == ".." {
		return res, fmt.Errorf("khoá dự án không hợp lệ: %q", opts.Key)
	}
	if opts.SharedRoot == "" || !filepath.IsAbs(opts.SharedRoot) {
		return res, errors.New("thiếu thư mục memory chung")
	}
	if st, err := os.Stat(opts.ProjectPath); err != nil || !st.IsDir() || !filepath.IsAbs(opts.ProjectPath) {
		return res, fmt.Errorf("chưa biết thư mục của dự án %s trên máy: gắn repo của dự án trong app trước", opts.Key)
	}
	if !versionAtLeast(opts.ClaudeVersion, AutoMemoryMinVersion) {
		return res, fmt.Errorf("Claude Code %s chưa hỗ trợ thư mục memory riêng (cần từ %s): cập nhật Claude Code rồi thử lại",
			orUnknown(opts.ClaudeVersion), AutoMemoryMinVersion)
	}
	state, err := s.loadShared()
	if err != nil {
		return res, err
	}
	for _, r := range state.Projects {
		if r.Key == opts.Key {
			return res, fmt.Errorf("dự án %s đã dùng chung memory", opts.Key)
		}
	}
	shared := SharedMemoryDir(opts.SharedRoot, opts.Key)
	if _, err := os.Stat(shared); err == nil {
		return res, fmt.Errorf("thư mục memory chung %s đã tồn tại: xoá hoặc đổi tên rồi thử lại", shared)
	}
	settings := filepath.Join(opts.ProjectPath, ".claude", localSettingsName)
	items, existed, err := readLocalSettings(settings)
	if err != nil {
		return res, err
	}
	if v, ok := getKV(items, autoMemorySetting); ok {
		return res, fmt.Errorf("%s đã đặt %s = %s: giữ nguyên cài đặt của người dùng, bỏ đặt rồi thử lại", settings, autoMemorySetting, v)
	}

	var profiles []SharedProfile
	byRel := map[string][]memFile{}
	var order []string
	for _, root := range opts.Roots {
		if root.CLI != "claude" || root.Path == "" {
			continue
		}
		dir := filepath.Join(absolute(root.Path), "projects", opts.Key, "memory")
		if st, err := os.Stat(dir); err != nil || !st.IsDir() {
			continue
		}
		files, err := readMemoryDir(dir, root.Profile)
		if err != nil {
			return res, fmt.Errorf("không đọc được memory của gói %s: %w", root.Profile, err)
		}
		profiles = append(profiles, SharedProfile{Profile: root.Profile, ConfigDir: absolute(root.Path), MemoryDir: dir})
		for _, f := range files {
			if _, ok := byRel[f.rel]; !ok {
				order = append(order, f.rel)
			}
			byRel[f.rel] = append(byRel[f.rel], f)
		}
	}
	if len(profiles) == 0 {
		return res, fmt.Errorf("không gói Claude nào có memory của dự án %s", opts.Key)
	}

	merged := map[string][]byte{}
	for _, rel := range order {
		cands := byRel[rel]
		if rel == "MEMORY.md" {
			merged[rel] = mergeIndexes(cands)
			continue
		}
		pick, ok := pickCandidate(cands, opts.Picks[rel])
		if !ok {
			c := Conflict{Name: rel}
			for _, f := range cands {
				c.Candidates = append(c.Candidates, Candidate{Profile: f.profile, Path: f.path, Tokens: EstimateTokens(string(f.data)), ModifiedAt: f.mod})
			}
			res.Conflicts = append(res.Conflicts, c)
			continue
		}
		merged[rel] = pick.data
	}
	if len(res.Conflicts) > 0 {
		return res, nil
	}

	b, err := s.begin("share", true)
	if err != nil {
		return res, err
	}
	rec := SharedRecord{Key: opts.Key, ProjectPath: absolute(opts.ProjectPath), SharedDir: shared, Settings: settings,
		SharedAt: s.now().UTC(), Profiles: profiles, SettingsCreated: !existed}
	fail := func(err error) (ShareResult, error) {
		_, err = b.fail(err)
		return res, err
	}
	// Bản gốc của mọi gói vào thùng rác trước khi đụng tới thư mục nào.
	for _, rel := range order {
		for _, f := range byRel[rel] {
			if err := b.save(f.path, true); err != nil {
				return fail(err)
			}
		}
	}
	if err := b.save(settings, false); err != nil {
		return fail(err)
	}
	for _, rel := range order {
		if data, ok := merged[rel]; ok {
			if err := writeFile(filepath.Join(shared, filepath.FromSlash(rel)), data, 0o644); err != nil {
				return fail(err)
			}
		}
	}
	// Đặt thư mục chung trước khi xoá thư mục của gói, để lỗi giữa chừng không để lại CLI không có memory nào.
	rawShared, err := json.Marshal(shared)
	if err != nil {
		return fail(err)
	}
	items = setKV(items, autoMemorySetting, string(rawShared))
	if err := writeFile(settings, renderLocalSettings(items), 0o644); err != nil {
		return fail(err)
	}
	if line, warn := gitExclude(rec.ProjectPath, filepath.Join(".claude", localSettingsName)); warn != "" {
		res.Warnings = append(res.Warnings, warn)
	} else {
		rec.ExcludeAdded = line
	}
	for _, p := range profiles {
		if err := os.RemoveAll(p.MemoryDir); err != nil {
			return fail(err)
		}
	}
	state.Projects = append(state.Projects, rec)
	if err := s.saveShared(state); err != nil {
		return fail(err)
	}
	out, err := b.commit()
	if err != nil {
		return res, err
	}
	out.Warnings = append(res.Warnings, out.Warnings...)
	res.Result, res.Applied, res.Shared = out, true, &rec
	return res, nil
}

// Unshare trả mỗi gói một bản sao memory chung, bỏ cài đặt và cho thư mục chung vào thùng rác.
func (s Store) Unshare(key string) (ShareResult, error) {
	res := ShareResult{Conflicts: []Conflict{}, Result: Result{Changed: []string{}, Warnings: []string{}}}
	state, err := s.loadShared()
	if err != nil {
		return res, err
	}
	idx := -1
	for i, r := range state.Projects {
		if r.Key == key {
			idx = i
		}
	}
	if idx < 0 {
		return res, fmt.Errorf("dự án %s chưa dùng chung memory", key)
	}
	rec := state.Projects[idx]
	files, err := readMemoryDir(rec.SharedDir, "shared")
	if err != nil {
		return res, fmt.Errorf("không đọc được thư mục memory chung %s: %w", rec.SharedDir, err)
	}
	b, err := s.begin("unshare", true)
	if err != nil {
		return res, err
	}
	fail := func(err error) (ShareResult, error) {
		_, err = b.fail(err)
		return res, err
	}
	for _, p := range rec.Profiles {
		for _, f := range files {
			dest := filepath.Join(p.MemoryDir, filepath.FromSlash(f.rel))
			if old, err := os.ReadFile(dest); err == nil && bytes.Equal(old, f.data) {
				continue
			}
			if err := b.save(dest, false); err != nil {
				return fail(err)
			}
			if err := writeFile(dest, f.data, 0o644); err != nil {
				return fail(err)
			}
		}
	}
	items, existed, err := readLocalSettings(rec.Settings)
	switch {
	case err != nil:
		res.Warnings = append(res.Warnings, "không đọc được "+rec.Settings+", cài đặt thư mục memory chưa gỡ: "+err.Error())
	case !existed:
	default:
		cur, ok := getKV(items, autoMemorySetting)
		// So giá trị đã giải mã: người dùng có thể đã định dạng lại file.
		var curDir string
		_ = json.Unmarshal([]byte(cur), &curDir)
		switch {
		case !ok:
		case curDir != rec.SharedDir:
			res.Warnings = append(res.Warnings, fmt.Sprintf("%s đã được sửa sau khi dùng chung, giữ nguyên %s", rec.Settings, autoMemorySetting))
		default:
			items = delKV(items, autoMemorySetting)
			if err := b.save(rec.Settings, false); err != nil {
				return fail(err)
			}
			if len(items) == 0 && rec.SettingsCreated {
				err = os.Remove(rec.Settings)
				// .claude/ do Hive tạo thì dọn nếu rỗng; còn gì khác thì Remove báo lỗi và để nguyên.
				_ = os.Remove(filepath.Dir(rec.Settings))
			} else {
				err = writeFile(rec.Settings, renderLocalSettings(items), fileMode(rec.Settings))
			}
			if err != nil {
				return fail(err)
			}
		}
	}
	if rec.ExcludeAdded != "" {
		if warn := removeGitExclude(rec.ProjectPath, rec.ExcludeAdded); warn != "" {
			res.Warnings = append(res.Warnings, warn)
		}
	}
	for _, f := range files {
		if err := b.save(f.path, true); err != nil {
			return fail(err)
		}
	}
	if err := os.RemoveAll(rec.SharedDir); err != nil {
		return fail(err)
	}
	// projects/<khoá> rỗng thì dọn luôn; còn gì khác thì để nguyên.
	_ = os.Remove(filepath.Dir(rec.SharedDir))
	_ = os.Remove(filepath.Dir(filepath.Dir(rec.SharedDir)))
	state.Projects = append(state.Projects[:idx], state.Projects[idx+1:]...)
	if err := s.saveShared(state); err != nil {
		return fail(err)
	}
	out, err := b.commit()
	if err != nil {
		return res, err
	}
	out.Warnings = append(res.Warnings, out.Warnings...)
	res.Result, res.Applied = out, true
	return res, nil
}

// pickCandidate chọn bản giữ lại: các bản giống hệt nhau thì không cần chọn; khác nhau thì phải có lựa chọn hợp lệ.
func pickCandidate(cands []memFile, profile string) (memFile, bool) {
	same := true
	for _, c := range cands[1:] {
		if !bytes.Equal(c.data, cands[0].data) {
			same = false
		}
	}
	if same {
		return cands[0], true
	}
	for _, c := range cands {
		if profile != "" && c.profile == profile {
			return c, true
		}
	}
	return memFile{}, false
}

// mergeIndexes hợp các MEMORY.md: giữ bản đầu nguyên vẹn rồi thêm dòng danh sách của các bản sau mà chưa có file đó.
func mergeIndexes(cands []memFile) []byte {
	out := strings.TrimRight(string(cands[0].data), "\n")
	seen := map[string]bool{}
	note := func(line string) {
		for _, m := range inlineLink.FindAllStringSubmatch(line, -1) {
			if p, ok := linkFile(m[1], "."); ok {
				seen[p] = true
			}
		}
	}
	for _, line := range strings.Split(out, "\n") {
		note(line)
	}
	for _, c := range cands[1:] {
		for _, line := range strings.Split(string(c.data), "\n") {
			if !listLine.MatchString(line) {
				continue
			}
			dup := false
			for _, m := range inlineLink.FindAllStringSubmatch(line, -1) {
				if p, ok := linkFile(m[1], "."); ok && seen[p] {
					dup = true
				}
			}
			if dup || strings.Contains(out, line) {
				continue
			}
			note(line)
			if out != "" {
				out += "\n"
			}
			out += line
		}
	}
	return []byte(out + "\n")
}

// --- settings.local.json giữ thứ tự khoá ---

type kv struct {
	key string
	val json.RawMessage
}

func readLocalSettings(path string) (items []kv, existed bool, err error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if len(bytes.TrimSpace(raw)) == 0 {
		return nil, true, nil
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, true, fmt.Errorf("%s không phải JSON object, không sửa", path)
	}
	for dec.More() {
		keyTok, err := dec.Token()
		if err != nil {
			return nil, true, fmt.Errorf("%s không phải JSON hợp lệ, không sửa: %w", path, err)
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, true, fmt.Errorf("%s không phải JSON hợp lệ, không sửa: %w", path, err)
		}
		items = append(items, kv{key: keyTok.(string), val: val})
	}
	if _, err := dec.Token(); err != nil {
		return nil, true, fmt.Errorf("%s không phải JSON hợp lệ, không sửa: %w", path, err)
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, true, fmt.Errorf("%s còn dữ liệu sau JSON object, không sửa", path)
	}
	return items, true, nil
}

func renderLocalSettings(items []kv) []byte {
	if len(items) == 0 {
		return []byte("{}\n")
	}
	var buf bytes.Buffer
	buf.WriteString("{\n")
	for i, it := range items {
		key, _ := json.Marshal(it.key)
		var val bytes.Buffer
		if err := json.Indent(&val, it.val, "  ", "  "); err != nil {
			val.Reset()
			val.Write(it.val)
		}
		buf.WriteString("  " + string(key) + ": " + val.String())
		if i < len(items)-1 {
			buf.WriteString(",")
		}
		buf.WriteString("\n")
	}
	buf.WriteString("}\n")
	return buf.Bytes()
}

func getKV(items []kv, key string) (string, bool) {
	for _, it := range items {
		if it.key == key {
			return string(it.val), true
		}
	}
	return "", false
}

func setKV(items []kv, key, val string) []kv {
	for i := range items {
		if items[i].key == key {
			items[i].val = json.RawMessage(val)
			return items
		}
	}
	return append(items, kv{key: key, val: json.RawMessage(val)})
}

func delKV(items []kv, key string) []kv {
	out := items[:0:0]
	for _, it := range items {
		if it.key != key {
			out = append(out, it)
		}
	}
	return out
}

// --- .git/info/exclude ---

// gitExclude thêm file cài đặt cục bộ vào .git/info/exclude nếu git chưa bỏ qua nó, để đường dẫn riêng của máy không lọt
// vào commit. Trả dòng đã thêm; warn không rỗng khi không làm được (không phải repo git thì không cảnh báo).
func gitExclude(project, rel string) (added, warn string) {
	git := func(args ...string) ([]byte, error) {
		return procattr.Command("git", append([]string{"-C", project}, args...)...).Output()
	}
	if out, err := git("rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(string(out)) != "true" {
		return "", ""
	}
	if _, err := git("check-ignore", "-q", filepath.ToSlash(rel)); err == nil {
		return "", ""
	}
	out, err := git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude")
	if err != nil {
		return "", "không tìm được .git/info/exclude; thêm " + filepath.ToSlash(rel) + " vào .gitignore để khỏi commit nhầm"
	}
	path := strings.TrimSpace(string(out))
	line := "/" + filepath.ToSlash(rel)
	cur, _ := os.ReadFile(path)
	text := string(cur)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if err := writeFile(path, []byte(text+line+"\n"), 0o644); err != nil {
		return "", "không ghi được " + path + "; thêm " + filepath.ToSlash(rel) + " vào .gitignore để khỏi commit nhầm"
	}
	return line, ""
}

func removeGitExclude(project, line string) string {
	out, err := procattr.Command("git", "-C", project, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").Output()
	if err != nil {
		return ""
	}
	path := strings.TrimSpace(string(out))
	cur, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var kept []string
	for _, l := range strings.Split(string(cur), "\n") {
		if l != line {
			kept = append(kept, l)
		}
	}
	if err := writeFile(path, []byte(strings.Join(kept, "\n")), 0o644); err != nil {
		return "không gỡ được dòng " + line + " khỏi " + path
	}
	return ""
}

// --- phiên bản ---

func versionAtLeast(v, min string) bool {
	if v == "" {
		return false
	}
	as, bs := strings.Split(v, "."), strings.Split(min, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			return x > y
		}
	}
	return true
}

func orUnknown(v string) string {
	if v == "" {
		return "(không rõ phiên bản)"
	}
	return v
}
