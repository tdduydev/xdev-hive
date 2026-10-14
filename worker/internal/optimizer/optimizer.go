// Package optimizer cài và gỡ cấu hình tiết kiệm token vào thư mục cấu hình của từng gói CLI (settings.json của Claude
// Code, config.toml của Codex), để phiên người dùng tự mở cũng được tối ưu như run của worker. Preset do người gọi
// truyền vào (runner.InteractivePreset), gói này không import runner.
package optimizer

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

var (
	ErrUnsupported    = errors.New("chưa hỗ trợ tối ưu cho CLI này")
	ErrDefaultProfile = errors.New("gói mặc định chỉ bật khi được chọn riêng")
	ErrNotEnabled     = errors.New("gói chưa bật tối ưu")
	ErrNoBackup       = errors.New("không có bản sao lưu")
	ErrInvalidConfig  = errors.New("file cấu hình hỏng, Hive không ghi gì; mở file để sửa rồi thử lại")
	ErrInvalidLevel   = errors.New("mức tối ưu phải là balanced hoặc aggressive")
)

// Levels là các mức bật được; "off" là Disable.
var Levels = []string{"balanced", "aggressive"}

// Preset là phần cấu hình của một mức tối ưu. Env và Hooks cho Claude Code, Codex cho config.toml (giá trị là chữ TOML,
// "8000").
type Preset struct {
	Env   map[string]string
	Codex map[string]string
	Hooks []Hook
	// ShellHooks: CLI chưa chạy được hook dạng exec (command + args) thì bọc bằng sh. Windows không có sh nên bỏ hook.
	ShellHooks bool
	Skipped    []Skip
}

// Hook là một hook Claude Code. Command rỗng là lệnh hive-worker ở đường dẫn ổn định (LinkPath), Args là đối số của nó.
type Hook struct {
	Event   string
	Matcher string
	Command string
	Args    []string
	Timeout int
}

// defaultHookTimeout giống hook của run: hook treo không giữ phiên quá 15 giây.
const defaultHookTimeout = 15

// Profile là một gói: CLI và thư mục cấu hình.
type Profile struct {
	ID  string
	CLI string
	Dir string
	// Default: thư mục mặc định của CLI (~/.claude, ~/.codex), dùng cho mọi phiên không đặt CLAUDE_CONFIG_DIR.
	Default bool
}

// Options của Enable. Explicit: người dùng chọn đúng gói này, không phải "bật tất cả gói".
type Options struct {
	Explicit bool
}

// Warning là điều người dùng cần biết sau khi bật hay tắt. Kind: user_set (khoá người dùng đặt sẵn, giữ nguyên),
// user_changed (người dùng sửa khoá Hive sau khi bật, giữ nguyên), user_removed, skipped.
type Warning struct {
	Key     string `json:"key"`
	Kind    string `json:"kind"`
	Message string `json:"message"`
}

// Result của một lần bật, tắt hay khôi phục.
type Result struct {
	Profile  string    `json:"profile"`
	Changed  bool      `json:"changed"`
	Backup   string    `json:"backup,omitempty"`
	Added    []string  `json:"added,omitempty"`
	Removed  []string  `json:"removed,omitempty"`
	Warnings []Warning `json:"warnings,omitempty"`
}

// Optimizer làm việc trên một HOME; test truyền HOME giả.
type Optimizer struct {
	Home string
	Now  func() time.Time
}

func New(home string) *Optimizer { return &Optimizer{Home: home} }

func (o *Optimizer) now() time.Time {
	if o.Now != nil {
		return o.Now()
	}
	return time.Now()
}

func checkID(id string) error {
	if id == "" || id == "." || id == ".." || strings.ContainsAny(id, `/\:`) {
		return fmt.Errorf("tên gói không hợp lệ: %q", id)
	}
	return nil
}

func (o *Optimizer) defaultDir(cli string) string {
	switch cli {
	case "claude":
		return filepath.Join(o.Home, ".claude")
	case "codex":
		return filepath.Join(o.Home, ".codex")
	}
	return ""
}

// Profile dựng gói từ id, CLI và thư mục cấu hình như accounts.json ghi. dir rỗng là thư mục mặc định; "~/" mở theo
// Home. cli rỗng thì đoán theo tên (claude-3, codex-2).
func (o *Optimizer) Profile(id, cli, dir string) (Profile, error) {
	if err := checkID(id); err != nil {
		return Profile{}, err
	}
	if cli == "" {
		for _, c := range []string{"claude", "codex", "gemini", "antigravity"} {
			if id == c || strings.HasPrefix(id, c+"-") {
				cli = c
			}
		}
	}
	if strings.HasPrefix(dir, "~/") || dir == "~" {
		dir = filepath.Join(o.Home, filepath.FromSlash(strings.TrimPrefix(strings.TrimPrefix(dir, "~"), "/")))
	}
	def := o.defaultDir(cli)
	if dir == "" {
		dir = def
	}
	return Profile{ID: id, CLI: cli, Dir: dir, Default: def != "" && samePath(dir, def)}, nil
}

// samePath so sau khi mở symlink (macOS có /var → /private/var).
func samePath(a, b string) bool {
	clean := func(p string) string {
		p = filepath.Clean(p)
		if r, err := filepath.EvalSymlinks(p); err == nil {
			return r
		}
		return p
	}
	return clean(a) == clean(b)
}

func configFile(cli string) (name, ext string, err error) {
	switch cli {
	case "claude":
		return "settings.json", ".json", nil
	case "codex":
		return "config.toml", ".toml", nil
	}
	return "", "", fmt.Errorf("%w: %s", ErrUnsupported, cli)
}

func digest(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Enable bật hoặc đổi mức tối ưu cho gói. Bật lại khi đã bật thì gỡ phần cũ trong bộ nhớ rồi áp preset mới, một lần
// ghi; bản sao lưu gốc và thời điểm bật đầu được giữ để tắt vẫn trả về file trước lần bật đầu.
func (o *Optimizer) Enable(p Profile, level string, preset Preset, opt Options) (*Result, error) {
	if !validLevel(level) {
		return nil, ErrInvalidLevel
	}
	name, ext, err := configFile(p.CLI)
	if err != nil {
		return nil, err
	}
	if err := checkID(p.ID); err != nil {
		return nil, err
	}
	if p.Default && !opt.Explicit {
		return nil, ErrDefaultProfile
	}
	if _, err := os.Stat(p.Dir); err != nil {
		return nil, fmt.Errorf("không thấy thư mục cấu hình của gói %s: %w", p.ID, err)
	}
	st, err := o.loadState()
	if err != nil {
		return nil, err
	}
	prev := st.Profiles[p.ID]
	path := filepath.Join(p.Dir, name)
	res := &Result{Profile: p.ID}
	var entry *Entry
	var out []byte

	old, e, err := update(path, func(old snapshot) (edit, error) {
		entry = &Entry{CLI: p.CLI, ConfigDir: p.Dir, Default: p.Default, Level: level, File: name, Existed: old.exists,
			Skipped: preset.Skipped}
		pristine := true
		if prev != nil {
			entry.Existed, entry.Backup, entry.EnabledAt = prev.Existed, prev.Backup, prev.EnabledAt
			pristine = prev.Pristine && prev.Written == digest(old.data)
		}
		var to []byte
		var added []string
		var warnings []Warning
		var err error
		switch p.CLI {
		case "claude":
			to, added, warnings, err = o.enableClaude(old, prev, entry, preset)
		case "codex":
			to, added, warnings, err = enableCodex(old, prev, entry, preset)
		}
		if err != nil {
			return edit{}, err
		}
		entry.Pristine = pristine
		res.Added, res.Warnings = added, warnings
		out = to
		if old.exists && string(to) == string(old.data) {
			return edit{unchanged: true}, nil
		}
		return edit{to: to}, nil
	}, func(old snapshot, _ edit) error {
		if !old.exists {
			return nil
		}
		ts, err := o.backup(p.ID, ext, old.data)
		res.Backup = ts
		return err
	})
	if err != nil {
		return nil, err
	}
	now := o.now().UTC()
	if prev == nil {
		entry.EnabledAt = now
		entry.Backup = res.Backup
	}
	entry.UpdatedAt = now
	if e.unchanged {
		entry.Written = digest(old.data)
	} else {
		entry.Written = digest(out)
		res.Changed = true
	}
	for _, s := range preset.Skipped {
		res.Warnings = append(res.Warnings, Warning{Key: s.Key, Kind: "skipped", Message: s.Reason})
	}
	st.Profiles[p.ID] = entry
	return res, o.saveState(st)
}

func validLevel(level string) bool {
	for _, l := range Levels {
		if l == level {
			return true
		}
	}
	return false
}

// Disable gỡ phần Hive đã thêm. File còn y như lúc Hive ghi thì chép lại bản gốc; người dùng đã sửa thì gỡ từng khoá,
// khoá người dùng đổi được giữ và báo lại. Gói không có trong manifest vẫn gỡ được hook và khối Codex của Hive (nhận
// ra bằng dấu), để file không còn sót gì khi manifest mất.
func (o *Optimizer) Disable(p Profile) (*Result, error) {
	name, ext, err := configFile(p.CLI)
	if err != nil {
		return nil, err
	}
	if err := checkID(p.ID); err != nil {
		return nil, err
	}
	st, err := o.loadState()
	if err != nil {
		return nil, err
	}
	entry := st.Profiles[p.ID]
	res := &Result{Profile: p.ID}
	if _, err := os.Stat(p.Dir); errors.Is(err, fs.ErrNotExist) {
		if entry == nil {
			return res, nil
		}
		delete(st.Profiles, p.ID)
		return res, o.saveState(st)
	}
	path := filepath.Join(p.Dir, name)
	_, e, err := update(path, func(old snapshot) (edit, error) {
		if entry != nil && entry.Pristine && entry.Written == digest(old.data) {
			res.Removed = entry.keys()
			if !entry.Existed {
				return edit{remove: true}, nil
			}
			if entry.Backup != "" {
				if orig, err := os.ReadFile(filepath.Join(o.backupDir(p.ID), entry.Backup+ext)); err == nil {
					return edit{to: orig}, nil
				}
			}
			// Không có bản gốc (bật mà không đổi gì, hoặc bản sao lưu bị xoá): gỡ từng khoá như khi người dùng đã sửa.
		}
		var to []byte
		var remove bool
		var err error
		switch p.CLI {
		case "claude":
			to, remove, res.Removed, res.Warnings, err = disableClaude(old, entry)
		case "codex":
			to, remove, res.Removed, res.Warnings, err = disableCodex(old, entry)
		}
		if err != nil {
			return edit{}, err
		}
		if remove {
			return edit{remove: true}, nil
		}
		if !old.exists || string(to) == string(old.data) {
			return edit{unchanged: true}, nil
		}
		return edit{to: to}, nil
	}, func(old snapshot, _ edit) error {
		if !old.exists {
			return nil
		}
		ts, err := o.backup(p.ID, ext, old.data)
		res.Backup = ts
		return err
	})
	if err != nil {
		return nil, err
	}
	res.Changed = !e.unchanged
	if entry == nil {
		return res, nil
	}
	delete(st.Profiles, p.ID)
	return res, o.saveState(st)
}

// keys là danh sách khoá Hive đã thêm, dạng env.X, hooks.PostToolUse, codex.X.
func (e *Entry) keys() []string {
	var out []string
	for _, kv := range e.Env {
		out = append(out, "env."+kv.Key)
	}
	for _, h := range e.Hooks {
		out = append(out, "hooks."+h.Event)
	}
	for _, kv := range e.Codex {
		out = append(out, "codex."+kv.Key)
	}
	return out
}

// ProfileStatus là một gói trong manifest. Modified: file đã đổi từ lần Hive ghi cuối (người dùng hay CLI sửa).
type ProfileStatus struct {
	ID string `json:"id"`
	Entry
	Modified bool `json:"modified"`
}

// Status đọc manifest. Gói mà thư mục cấu hình đã bị xoá được bỏ khỏi manifest ngay lần đọc này.
func (o *Optimizer) Status() ([]ProfileStatus, error) {
	st, err := o.loadState()
	if err != nil {
		return nil, err
	}
	pruned := false
	var out []ProfileStatus
	for id, e := range st.Profiles {
		if _, err := os.Stat(e.ConfigDir); errors.Is(err, fs.ErrNotExist) {
			delete(st.Profiles, id)
			pruned = true
			continue
		}
		b, _ := os.ReadFile(filepath.Join(e.ConfigDir, e.File))
		out = append(out, ProfileStatus{ID: id, Entry: *e, Modified: digest(b) != e.Written})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	if pruned {
		if err := o.saveState(st); err != nil {
			return out, err
		}
	}
	return out, nil
}

// Restore chép một bản sao lưu đè lên file cấu hình (sau khi sao lưu file hiện tại). backup rỗng là bản trước lần bật
// đầu nếu gói đang bật, không thì bản mới nhất. Khôi phục bản trước lần bật thì gói coi như đã tắt.
func (o *Optimizer) Restore(p Profile, backup string) (*Result, error) {
	name, ext, err := configFile(p.CLI)
	if err != nil {
		return nil, err
	}
	if err := checkID(p.ID); err != nil {
		return nil, err
	}
	st, err := o.loadState()
	if err != nil {
		return nil, err
	}
	entry := st.Profiles[p.ID]
	if backup == "" {
		if entry != nil && entry.Backup != "" {
			backup = entry.Backup
		} else {
			list, err := o.Backups(p.ID)
			if err != nil {
				return nil, err
			}
			if len(list) == 0 {
				return nil, ErrNoBackup
			}
			backup = list[len(list)-1]
		}
	}
	if err := checkID(backup); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(filepath.Join(o.backupDir(p.ID), backup+ext))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, fmt.Errorf("%w: %s", ErrNoBackup, backup)
	}
	if err != nil {
		return nil, err
	}
	res := &Result{Profile: p.ID}
	_, e, err := update(filepath.Join(p.Dir, name), func(old snapshot) (edit, error) {
		if old.exists && string(old.data) == string(data) {
			return edit{unchanged: true}, nil
		}
		return edit{to: data}, nil
	}, func(old snapshot, _ edit) error {
		if !old.exists {
			return nil
		}
		ts, err := o.backup(p.ID, ext, old.data)
		res.Backup = ts
		return err
	})
	if err != nil {
		return nil, err
	}
	res.Changed = !e.unchanged
	if entry == nil {
		return res, nil
	}
	if backup == entry.Backup {
		delete(st.Profiles, p.ID)
	} else {
		// File giờ không còn là file Hive ghi: tắt phải gỡ từng khoá thay vì chép bản gốc.
		entry.Pristine = false
		entry.Written = digest(data)
	}
	return res, o.saveState(st)
}

// LinkPath là đường dẫn ổn định của hive-worker mà hook trong settings.json gọi; app cập nhật nó mỗi lần khởi động,
// nên đổi chỗ cài app không làm hỏng hook.
func (o *Optimizer) LinkPath() string {
	name := "hive-worker"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return filepath.Join(o.Home, ".xdev-hive", "bin", name)
}
