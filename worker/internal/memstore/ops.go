package memstore

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
)

// TrashRetention là thời gian giữ bản đã xoá và bản sao lưu trước khi dọn (spec 015 US3).
const TrashRetention = 30 * 24 * time.Hour

// Store là thư mục dữ liệu của bộ tối ưu (~/.xdev-hive/optimizer): thùng rác và bản sao lưu nằm dưới đó. Bên gọi truyền
// thư mục để test không đụng vào dữ liệu thật của người dùng.
type Store struct {
	Dir string
	Now func() time.Time
}

func (s Store) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s Store) trashDir() string   { return filepath.Join(s.Dir, "trash") }
func (s Store) backupsDir() string { return filepath.Join(s.Dir, "backups", "memory") }

// StoredFile là một file mà thao tác đã đụng tới. Stored rỗng nghĩa là file chưa có trước thao tác (khôi phục thì xoá).
type StoredFile struct {
	Path    string `json:"path"`
	Stored  string `json:"stored,omitempty"`
	Deleted bool   `json:"deleted,omitempty"`
}

// IndexChange ghi các dòng chỉ mục đã bỏ hoặc thêm để khôi phục theo dòng, không ghi đè cả MEMORY.md (người dùng có thể
// đã sửa nó sau thao tác).
type IndexChange struct {
	Path    string   `json:"path"`
	Removed []string `json:"removed,omitempty"`
	Added   []string `json:"added,omitempty"`
}

// Entry là một lần thao tác đã sao lưu. Trash=true khi thao tác có xoá file, thì bản lưu nằm trong trash/.
type Entry struct {
	ID        string        `json:"id"`
	Op        string        `json:"op"`
	CreatedAt time.Time     `json:"createdAt"`
	Trash     bool          `json:"trash"`
	Files     []StoredFile  `json:"files"`
	Index     []IndexChange `json:"index,omitempty"`
}

// Result là kết quả của một thao tác ghi. Entry là id để `restore`; rỗng khi thao tác không đổi gì.
type Result struct {
	Entry    string   `json:"entry,omitempty"`
	Changed  []string `json:"changed"`
	Warnings []string `json:"warnings"`
}

// EntrySummary cho app liệt kê thùng rác và bản sao lưu để khôi phục.
type EntrySummary struct {
	ID        string    `json:"id"`
	Op        string    `json:"op"`
	CreatedAt time.Time `json:"createdAt"`
	Trash     bool      `json:"trash"`
	Paths     []string  `json:"paths"`
}

var errIndexName = errors.New("không thao tác trực tiếp lên chỉ mục MEMORY.md bằng lệnh này")

// Batch gom các thay đổi của một thao tác: file nào cũng được lưu một lần trước khi bị ghi hay xoá. Gói khác (ctxsync)
// dùng nó để mọi lần ghi file ngữ cảnh có bản sao lưu và khôi phục được bằng Restore.
type Batch struct {
	store Store
	entry Entry
	dir   string
	saved map[string]bool
}

// Begin mở một thao tác op; trash=true khi thao tác xoá file, để bản lưu nằm trong thùng rác.
func (s Store) Begin(op string, trash bool) (*Batch, error) {
	if s.Dir == "" {
		return nil, errors.New("thiếu thư mục dữ liệu của bộ tối ưu")
	}
	s.purge()
	var raw [3]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return nil, err
	}
	now := s.now().UTC()
	id := now.Format("20060102T150405Z") + "-" + op + "-" + hex.EncodeToString(raw[:])
	root := s.backupsDir()
	if trash {
		root = s.trashDir()
	}
	b := &Batch{store: s, dir: filepath.Join(root, id), saved: map[string]bool{},
		entry: Entry{ID: id, Op: op, CreatedAt: now, Trash: trash, Files: []StoredFile{}}}
	if err := os.MkdirAll(filepath.Join(b.dir, "files"), 0o700); err != nil {
		return nil, err
	}
	return b, nil
}

// Save lưu nội dung hiện tại của path vào bản sao lưu (nếu có), trước khi sửa hoặc xoá.
func (b *Batch) Save(path string, deleted bool) error {
	path = filepath.Clean(path)
	if b.saved[path] {
		if deleted {
			for i := range b.entry.Files {
				if b.entry.Files[i].Path == path {
					b.entry.Files[i].Deleted = true
				}
			}
		}
		return nil
	}
	b.saved[path] = true
	file := StoredFile{Path: path, Deleted: deleted}
	data, err := os.ReadFile(path)
	switch {
	case err == nil:
		file.Stored = fmt.Sprintf("files/%d", len(b.entry.Files))
		if err := writeFile(filepath.Join(b.dir, file.Stored), data, 0o600); err != nil {
			return err
		}
	case os.IsNotExist(err):
	default:
		return err
	}
	b.entry.Files = append(b.entry.Files, file)
	return nil
}

// Commit ghi meta.json của bản lưu; trả id để Restore.
func (b *Batch) Commit() (Result, error) {
	raw, err := json.MarshalIndent(b.entry, "", "  ")
	if err != nil {
		return Result{}, err
	}
	if err := writeFile(filepath.Join(b.dir, "meta.json"), raw, 0o600); err != nil {
		return Result{}, err
	}
	res := Result{Entry: b.entry.ID, Changed: []string{}, Warnings: []string{}}
	for _, f := range b.entry.Files {
		res.Changed = append(res.Changed, f.Path)
	}
	for _, c := range b.entry.Index {
		if !containsPath(res.Changed, c.Path) {
			res.Changed = append(res.Changed, c.Path)
		}
	}
	return res, nil
}

// Fail kết thúc thao tác lỗi giữa chừng. Đã đổi gì thì giữ bản lưu để người dùng khôi phục, chưa đổi gì thì bỏ.
func (b *Batch) Fail(err error) (Result, error) {
	if len(b.entry.Files) == 0 && len(b.entry.Index) == 0 {
		b.Abort()
		return Result{}, err
	}
	if _, cerr := b.Commit(); cerr != nil {
		return Result{}, fmt.Errorf("%w (và không ghi được bản lưu: %v)", err, cerr)
	}
	return Result{}, fmt.Errorf("%w (đã lưu bản khôi phục %s)", err, b.entry.ID)
}

// Abort bỏ bản lưu khi thao tác thất bại trước khi ghi gì; sau khi đã ghi thì giữ để người dùng khôi phục.
func (b *Batch) Abort() { _ = os.RemoveAll(b.dir) }

// checkMemoryFile chặn đường dẫn ngoài ý muốn: chỉ file .md thường, không phải chỉ mục.
func checkMemoryFile(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("đường dẫn phải là đường dẫn tuyệt đối: %s", path)
	}
	path = filepath.Clean(path)
	if !strings.EqualFold(filepath.Ext(path), ".md") {
		return "", fmt.Errorf("chỉ thao tác được trên file .md: %s", path)
	}
	real, err := resolveFile(path)
	if err != nil {
		return "", fmt.Errorf("không đọc được file %s: %w", path, err)
	}
	return real, nil
}

// resolveFile theo liên kết để ghi vào file thật; ghi bằng rename lên chính đường liên kết sẽ thay liên kết bằng file.
func resolveFile(path string) (string, error) {
	st, err := os.Lstat(path)
	if err != nil {
		return "", err
	}
	if st.Mode()&os.ModeSymlink != 0 {
		real, err := filepath.EvalSymlinks(path)
		if err != nil {
			return "", err
		}
		path = real
		if st, err = os.Stat(path); err != nil {
			return "", err
		}
	}
	if !st.Mode().IsRegular() {
		return "", fmt.Errorf("không phải file thường: %s", path)
	}
	return path, nil
}

// Edit ghi nội dung mới vào một file memory hay instruction; bản cũ được lưu trước.
func (s Store) Edit(path, content string) (Result, error) {
	real, err := checkMemoryFile(path)
	if err != nil {
		return Result{}, err
	}
	b, err := s.Begin("edit", false)
	if err != nil {
		return Result{}, err
	}
	if err := b.Save(real, false); err != nil {
		b.Abort()
		return Result{}, err
	}
	if err := writeFile(real, []byte(content), fileMode(real)); err != nil {
		b.Abort()
		return Result{}, err
	}
	return b.Commit()
}

// Delete chuyển file vào thùng rác và bỏ dòng chỉ mục trỏ tới nó.
func (s Store) Delete(path string) (Result, error) {
	real, err := checkMemoryFile(path)
	if err != nil {
		return Result{}, err
	}
	if filepath.Base(real) == "MEMORY.md" {
		return Result{}, errIndexName
	}
	b, err := s.Begin("delete", true)
	if err != nil {
		return Result{}, err
	}
	if err := b.Save(real, true); err != nil {
		b.Abort()
		return Result{}, err
	}
	if _, err := b.removeIndexLines(filepath.Dir(real), []string{real}); err != nil {
		return b.Fail(err)
	}
	if err := os.Remove(real); err != nil {
		return b.Fail(err)
	}
	return b.Commit()
}

// Merge ghi bản gộp vào target (tạo nếu chưa có), chuyển các file nguồn vào thùng rác, bỏ dòng chỉ mục của nguồn và đổi
// link trỏ tới nguồn sang target. Nguồn trùng với target thì bỏ qua, vì đó là file đích.
func (s Store) Merge(sources []string, target, content string) (Result, error) {
	if !filepath.IsAbs(target) || !strings.EqualFold(filepath.Ext(target), ".md") {
		return Result{}, fmt.Errorf("file đích phải là đường dẫn tuyệt đối tới file .md: %s", target)
	}
	target = filepath.Clean(target)
	if filepath.Base(target) == "MEMORY.md" {
		return Result{}, errIndexName
	}
	if real, err := resolveFile(target); err == nil {
		target = real
	} else if !os.IsNotExist(err) {
		return Result{}, err
	}
	var srcs []string
	for _, src := range sources {
		real, err := checkMemoryFile(src)
		if err != nil {
			return Result{}, err
		}
		if filepath.Base(real) == "MEMORY.md" {
			return Result{}, errIndexName
		}
		if !samePath(real, target) && !containsPath(srcs, real) {
			srcs = append(srcs, real)
		}
	}
	if len(srcs) == 0 {
		return Result{}, errors.New("chưa chọn file nguồn nào để gộp")
	}
	b, err := s.Begin("merge", true)
	if err != nil {
		return Result{}, err
	}
	fail := b.Fail
	// Thư mục bị ảnh hưởng: nơi đặt đích và nơi chứa từng nguồn.
	dirs := []string{filepath.Dir(target)}
	for _, src := range srcs {
		if d := filepath.Dir(src); !containsPath(dirs, d) {
			dirs = append(dirs, d)
		}
	}
	// Dòng chỉ mục của nguồn đầu tiên nằm cùng thư mục đích được dùng lại cho đích, để giữ phần mô tả.
	var reuse string
	for _, dir := range dirs {
		removed, err := b.removeIndexLines(dir, srcs)
		if err != nil {
			return fail(err)
		}
		if samePath(dir, filepath.Dir(target)) && len(removed) > 0 {
			reuse = removed[0]
		}
	}
	if err := b.Save(target, false); err != nil {
		return fail(err)
	}
	for _, src := range srcs {
		if err := b.Save(src, true); err != nil {
			return fail(err)
		}
	}
	// Đổi link trước khi ghi đích: file đích chưa có thì không bị đổi nhầm.
	for _, dir := range dirs {
		if err := b.rewriteLinks(dir, srcs, target); err != nil {
			return fail(err)
		}
	}
	if err := writeFile(target, []byte(content), fileMode(target)); err != nil {
		return fail(err)
	}
	if err := b.ensureIndexed(target, reuse); err != nil {
		return fail(err)
	}
	for _, src := range srcs {
		if err := os.Remove(src); err != nil {
			return fail(err)
		}
	}
	return b.Commit()
}

// Restore trả file về từ thùng rác hay bản sao lưu. Trạng thái hiện tại của file bị ghi đè được lưu thành một bản mới, nên
// khôi phục cũng hoàn tác được.
func (s Store) Restore(id string) (Result, error) {
	if id == "" || id != filepath.Base(id) || strings.ContainsAny(id, `/\`) {
		return Result{}, fmt.Errorf("mã khôi phục không hợp lệ: %q", id)
	}
	var entry Entry
	var dir string
	for _, root := range []string{s.trashDir(), s.backupsDir()} {
		raw, err := os.ReadFile(filepath.Join(root, id, "meta.json"))
		if err != nil {
			continue
		}
		if err := json.Unmarshal(raw, &entry); err != nil {
			return Result{}, fmt.Errorf("bản lưu %s hỏng: %w", id, err)
		}
		dir = filepath.Join(root, id)
		break
	}
	if dir == "" {
		return Result{}, fmt.Errorf("không tìm thấy bản lưu %s (có thể đã quá %d ngày)", id, int(TrashRetention.Hours()/24))
	}
	b, err := s.Begin("restore", false)
	if err != nil {
		return Result{}, err
	}
	paths := make([]string, 0, len(entry.Files)+len(entry.Index))
	for _, f := range entry.Files {
		paths = append(paths, f.Path)
	}
	for _, c := range entry.Index {
		paths = append(paths, c.Path)
	}
	for _, p := range paths {
		if err := b.Save(p, false); err != nil {
			b.Abort()
			return Result{}, err
		}
	}
	for _, f := range entry.Files {
		if f.Stored == "" {
			// File do thao tác tạo ra thì khôi phục là xoá nó.
			if err := os.Remove(f.Path); err != nil && !os.IsNotExist(err) {
				return b.Fail(err)
			}
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(f.Stored)))
		if err != nil {
			return b.Fail(fmt.Errorf("bản lưu %s thiếu dữ liệu của %s: %w", id, f.Path, err))
		}
		if err := writeFile(f.Path, data, fileMode(f.Path)); err != nil {
			return b.Fail(err)
		}
	}
	for _, change := range entry.Index {
		if err := restoreIndex(change); err != nil {
			return b.Fail(err)
		}
	}
	return b.Commit()
}

// Entries liệt kê thùng rác và bản sao lưu, mới nhất trước.
func (s Store) Entries() ([]EntrySummary, error) {
	s.purge()
	out := []EntrySummary{}
	for _, root := range []string{s.trashDir(), s.backupsDir()} {
		dirs, err := os.ReadDir(root)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, d := range dirs {
			e, ok := readEntry(filepath.Join(root, d.Name()))
			if !ok {
				continue
			}
			sum := EntrySummary{ID: e.ID, Op: e.Op, CreatedAt: e.CreatedAt, Trash: e.Trash, Paths: []string{}}
			for _, f := range e.Files {
				sum.Paths = append(sum.Paths, f.Path)
			}
			out = append(out, sum)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	return out, nil
}

func readEntry(dir string) (Entry, bool) {
	raw, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return Entry{}, false
	}
	var e Entry
	if json.Unmarshal(raw, &e) != nil || e.ID == "" {
		return Entry{}, false
	}
	return e, true
}

// purge dọn bản lưu quá hạn. Lỗi bị bỏ qua: dọn không được làm hỏng thao tác của người dùng.
func (s Store) purge() {
	cutoff := s.now().Add(-TrashRetention)
	for _, root := range []string{s.trashDir(), s.backupsDir()} {
		dirs, _ := os.ReadDir(root)
		for _, d := range dirs {
			dir := filepath.Join(root, d.Name())
			if e, ok := readEntry(dir); ok && e.CreatedAt.Before(cutoff) {
				_ = os.RemoveAll(dir)
			}
		}
	}
}

// --- chỉ mục MEMORY.md ---

var listLine = regexp.MustCompile(`^\s*(?:[-*+]|\d+[.)])\s+`)

// linksTo cho biết dòng có link tới một trong các file (link tương đối so với thư mục của MEMORY.md).
func linksTo(line, dir string, files []string) bool {
	for _, m := range inlineLink.FindAllStringSubmatch(line, -1) {
		if p, ok := linkFile(m[1], dir); ok && containsPath(files, p) {
			return true
		}
	}
	for _, m := range wikiLink.FindAllStringSubmatch(line, -1) {
		slug := strings.TrimSpace(strings.SplitN(m[1], "|", 2)[0])
		for _, f := range files {
			if filepath.Dir(f) == dir && (slug == filepath.Base(f) || slug == strings.TrimSuffix(filepath.Base(f), filepath.Ext(f))) {
				return true
			}
		}
	}
	return false
}

// linkFile đổi đích link markdown sang đường dẫn file trong máy; ok=false với URL, neo trong trang và link rỗng.
func linkFile(raw, dir string) (string, bool) {
	raw = strings.TrimSpace(strings.Trim(raw, "<>"))
	if i := strings.IndexAny(raw, "#?"); i >= 0 {
		raw = raw[:i]
	}
	if raw == "" || strings.Contains(raw, "://") || strings.HasPrefix(raw, "mailto:") {
		return "", false
	}
	if un, err := url.PathUnescape(raw); err == nil {
		raw = un
	}
	p := filepath.FromSlash(raw)
	if !filepath.IsAbs(p) {
		p = filepath.Join(dir, p)
	}
	return filepath.Clean(p), true
}

// removeIndexLines bỏ các dòng danh sách trong MEMORY.md của dir mà trỏ tới files, trả các dòng đã bỏ. Chỉ ghi các dòng
// đã bỏ vào bản lưu, không lưu cả file: khôi phục theo dòng không đè lên chỗ người dùng sửa sau đó.
func (b *Batch) removeIndexLines(dir string, files []string) ([]string, error) {
	index := filepath.Join(dir, "MEMORY.md")
	raw, err := os.ReadFile(index)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var kept, removed []string
	for _, line := range strings.Split(string(raw), "\n") {
		if listLine.MatchString(line) && linksTo(line, dir, files) {
			removed = append(removed, line)
			continue
		}
		kept = append(kept, line)
	}
	if len(removed) == 0 {
		return nil, nil
	}
	if err := writeFile(index, []byte(strings.Join(kept, "\n")), fileMode(index)); err != nil {
		return nil, err
	}
	b.entry.Index = append(b.entry.Index, IndexChange{Path: index, Removed: removed})
	return removed, nil
}

// ensureIndexed thêm dòng chỉ mục cho file memory chưa có trong MEMORY.md cùng thư mục. Thư mục không có MEMORY.md và
// không tên là "memory" thì không phải thư mục memory của CLI, nên không tạo chỉ mục.
func (b *Batch) ensureIndexed(file, reuse string) error {
	dir := filepath.Dir(file)
	index := filepath.Join(dir, "MEMORY.md")
	raw, err := os.ReadFile(index)
	if os.IsNotExist(err) {
		if filepath.Base(dir) != "memory" {
			return nil
		}
		raw, err = nil, nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if listLine.MatchString(line) && linksTo(line, dir, []string{file}) {
			return nil
		}
	}
	line := "- [" + strings.TrimSuffix(filepath.Base(file), filepath.Ext(file)) + "](" + url.PathEscape(filepath.Base(file)) + ")"
	if reuse != "" {
		line = retarget(reuse, dir, file)
	}
	if err := b.Save(index, false); err != nil {
		return err
	}
	text := string(raw)
	if text != "" && !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	if err := writeFile(index, []byte(text+line+"\n"), fileMode(index)); err != nil {
		return err
	}
	b.entry.Index = append(b.entry.Index, IndexChange{Path: index, Added: []string{line}})
	return nil
}

func restoreIndex(c IndexChange) error {
	raw, err := os.ReadFile(c.Path)
	if os.IsNotExist(err) && len(c.Removed) == 0 {
		return nil
	}
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(raw) == 0 {
		lines = nil
	}
	var out []string
	for _, line := range lines {
		if !containsString(c.Added, line) {
			out = append(out, line)
		}
	}
	for _, line := range c.Removed {
		if !containsString(out, line) {
			out = append(out, line)
		}
	}
	return writeFile(c.Path, []byte(strings.Join(out, "\n")+"\n"), fileMode(c.Path))
}

// retarget đổi link trong dòng chỉ mục cũ sang file mới, giữ phần mô tả.
func retarget(line, dir, file string) string {
	first := true
	return rewriteLine(line, func(string) (string, bool) {
		if !first {
			return "", false
		}
		first = false
		return linkPath(dir, file), true
	}, strings.TrimSuffix(filepath.Base(file), filepath.Ext(file)))
}

// rewriteLinks đổi mọi link trong các file .md của dir trỏ tới sources sang target.
func (b *Batch) rewriteLinks(dir string, sources []string, target string) error {
	entries, err := os.ReadDir(dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		path := filepath.Join(dir, e.Name())
		if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".md") || containsPath(sources, path) || samePath(path, target) {
			continue
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		changed := false
		lines := strings.Split(string(raw), "\n")
		for i, line := range lines {
			if !linksTo(line, dir, sources) {
				continue
			}
			lines[i] = rewriteLine(line, func(old string) (string, bool) {
				if p, ok := linkFile(old, dir); ok && containsPath(sources, p) {
					return linkPath(dir, target), true
				}
				return "", false
			}, strings.TrimSuffix(filepath.Base(target), filepath.Ext(target)))
			changed = changed || lines[i] != line
		}
		if !changed {
			continue
		}
		if err := b.Save(path, false); err != nil {
			return err
		}
		if err := writeFile(path, []byte(strings.Join(lines, "\n")), fileMode(path)); err != nil {
			return err
		}
	}
	return nil
}

// rewriteLine thay đích của link markdown (replace quyết định) và link [[slug]] trỏ cùng file (wikiSlug thay slug).
func rewriteLine(line string, replace func(old string) (string, bool), wikiSlug string) string {
	var out strings.Builder
	last := 0
	for _, m := range inlineLink.FindAllStringSubmatchIndex(line, -1) {
		start, end := m[2], m[3]
		if neu, ok := replace(line[start:end]); ok {
			out.WriteString(line[last:start])
			out.WriteString(neu)
			last = end
		}
	}
	out.WriteString(line[last:])
	line = out.String()
	// Link wiki không có thư mục, nên chỉ đúng khi file đích cùng thư mục; khác thư mục thì để scan báo link chết.
	return wikiLink.ReplaceAllStringFunc(line, func(m string) string {
		slug := strings.TrimSpace(strings.SplitN(m[2:len(m)-2], "|", 2)[0])
		if _, ok := replace(slug + ".md"); ok {
			return "[[" + wikiSlug + "]]"
		}
		return m
	})
}

// linkPath là đích link từ file trong from tới file to, luôn dùng dấu / và %20 cho khoảng trắng.
func linkPath(from, to string) string {
	rel, err := filepath.Rel(from, to)
	if err != nil {
		rel = to
	}
	return strings.ReplaceAll(filepath.ToSlash(rel), " ", "%20")
}

// --- tiện ích file ---

func fileMode(path string) os.FileMode {
	if st, err := os.Stat(path); err == nil {
		return st.Mode().Perm()
	}
	return 0o644
}

// writeFile ghi nguyên tử (file tạm cùng thư mục rồi rename) để CLI đang đọc không thấy file ghi dở.
func writeFile(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, werr := tmp.Write(data)
	if werr == nil {
		werr = tmp.Sync()
	}
	if cerr := tmp.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil && runtime.GOOS != "windows" {
		werr = os.Chmod(name, perm)
	}
	if werr == nil {
		werr = os.Rename(name, path)
	}
	if werr != nil {
		_ = os.Remove(name)
	}
	return werr
}

func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func containsPath(list []string, p string) bool {
	for _, x := range list {
		if samePath(x, p) {
			return true
		}
	}
	return false
}

func containsString(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
