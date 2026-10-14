package optimizer

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// State là ~/.xdev-hive/optimizer/state.json. Hook cục bộ (`hive-worker hook … --local`) đọc mục của gói theo
// CLAUDE_CONFIG_DIR để biết mức đã bật, nên tên trường là hợp đồng với runner.
type State struct {
	Version  int               `json:"version"`
	Profiles map[string]*Entry `json:"profiles"`
}

const stateVersion = 1

// Entry là những gì Hive đã ghi vào cấu hình của một gói, đủ để gỡ đúng phần của Hive mà không đụng phần người dùng.
type Entry struct {
	CLI       string    `json:"cli"`
	ConfigDir string    `json:"configDir"`
	Default   bool      `json:"default,omitempty"`
	Level     string    `json:"level"`
	EnabledAt time.Time `json:"enabledAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// File là tên file cấu hình (settings.json, config.toml); Existed là file có trước khi bật.
	File    string `json:"file"`
	Existed bool   `json:"existed"`
	// Backup là bản sao lưu ngay trước lần bật đầu, rỗng khi file chưa có.
	Backup string `json:"backup,omitempty"`
	// Written là sha256 của file Hive ghi lần cuối. Pristine: file khi đó dựng từ bản gốc mà người dùng chưa sửa gì; cả
	// hai khớp thì tắt chép lại nguyên bản gốc, file trở về đúng từng byte.
	Written  string `json:"written,omitempty"`
	Pristine bool   `json:"pristine,omitempty"`

	Env          []KeyValue   `json:"env,omitempty"`
	Hooks        []HookRecord `json:"hooks,omitempty"`
	CreatedEnv   bool         `json:"createdEnv,omitempty"`
	CreatedHooks bool         `json:"createdHooks,omitempty"`
	// CreatedEvents là mảng hooks.<sự kiện> Hive tạo mới, tắt thì xoá nếu rỗng.
	CreatedEvents []string `json:"createdEvents,omitempty"`

	Codex []KeyValue `json:"codex,omitempty"`
	// CodexSeparator: Hive thêm một dòng trống sau khối để tách với nội dung cũ.
	CodexSeparator bool `json:"codexSeparator,omitempty"`

	// UserSet là khoá người dùng đã tự đặt trước khi bật; Hive không ghi đè và không gỡ.
	UserSet []string `json:"userSet,omitempty"`
	Skipped []Skip   `json:"skipped,omitempty"`
}

// KeyValue: khoá Hive đã thêm, giá trị Hive đặt và giá trị cũ (nil là "không có"). Previous luôn nil với khoá Hive
// thêm mới; khoá đã có thì vào UserSet thay vì bị ghi đè.
type KeyValue struct {
	Key      string  `json:"key"`
	Value    string  `json:"value"`
	Previous *string `json:"previous"`
}

// HookRecord là một hook Hive đã thêm, lưu JSON viết liền để nhận ra cả hook không mang dấu --local (hook RTK). Lưu
// dạng chuỗi chứ không phải json.RawMessage: MarshalIndent sẽ thụt lề và thoát ký tự HTML trong đó, so sẽ lệch.
type HookRecord struct {
	Event   string `json:"event"`
	Matcher string `json:"matcher,omitempty"`
	Hook    string `json:"hook"`
}

// Skip là phần preset không áp được và lý do, để màn hình ghi lại.
type Skip struct {
	Key    string `json:"key"`
	Reason string `json:"reason"`
}

func (o *Optimizer) dataDir() string { return filepath.Join(o.Home, ".xdev-hive", "optimizer") }

// StatePath là manifest; hook cục bộ đọc file này.
func (o *Optimizer) StatePath() string { return filepath.Join(o.dataDir(), "state.json") }

func (o *Optimizer) loadState() (*State, error) {
	st := &State{Version: stateVersion, Profiles: map[string]*Entry{}}
	b, err := os.ReadFile(o.StatePath())
	if errors.Is(err, fs.ErrNotExist) {
		return st, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, st); err != nil {
		return nil, fmt.Errorf("manifest %s hỏng: %v", o.StatePath(), err)
	}
	if st.Profiles == nil {
		st.Profiles = map[string]*Entry{}
	}
	return st, nil
}

func (o *Optimizer) saveState(st *State) error {
	st.Version = stateVersion
	b, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(o.StatePath(), append(b, '\n'))
}

func (o *Optimizer) backupDir(id string) string { return filepath.Join(o.dataDir(), "backups", id) }

// backupStamp: không có ":" để tên file dùng được trên Windows; xếp theo chữ cũng là xếp theo thời gian.
const backupStamp = "20060102T150405Z"

// backup chép nội dung cũ vào backups/<gói>/<ts>.<đuôi>, trả ts. Hai lần trong cùng giây thì thêm hậu tố.
func (o *Optimizer) backup(id, ext string, data []byte) (string, error) {
	dir := o.backupDir(id)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	base := o.now().UTC().Format(backupStamp)
	ts := base
	for i := 2; ; i++ {
		if _, err := os.Stat(filepath.Join(dir, ts+ext)); errors.Is(err, fs.ErrNotExist) {
			break
		}
		ts = fmt.Sprintf("%s-%d", base, i)
	}
	return ts, writeAtomic(filepath.Join(dir, ts+ext), data)
}

// Backups liệt kê bản sao lưu của gói, cũ trước.
func (o *Optimizer) Backups(id string) ([]string, error) {
	if err := checkID(id); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(o.backupDir(id))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		out = append(out, strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
	}
	sort.Strings(out)
	return out, nil
}
