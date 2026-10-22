package ctxsync

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"time"

	"github.com/tdduydev/xdev-hive/worker/internal/memstore"
)

// Status của một file đích (data-model "Trạng thái").
const (
	StatusOK       = "ok"
	StatusStale    = "stale"
	StatusConflict = "conflict"
	StatusSkipped  = "skipped"
)

const stateVersion = 1

// Manager giữ nguồn ngữ cảnh của mọi dự án dưới Root (~/.xdev-hive/context) và ghi chúng vào file đích. Store là kho sao
// lưu của memstore: mọi lần ghi file trong repo đều khôi phục được.
type Manager struct {
	Root  string
	Store memstore.Store
	// Installed cho biết CLI có trên máy không; nil là coi như có cả bốn. CLI chưa cài thì không tạo file cho nó.
	Installed func(TargetID) bool
	Now       func() time.Time
}

func (m Manager) now() time.Time {
	if m.Now != nil {
		return m.Now()
	}
	return time.Now()
}

func (m Manager) installed(id TargetID) bool { return m.Installed == nil || m.Installed(id) }

// AutoSync là lịch tự kéo memory hub. Source "policy" khi chính sách dự án đặt, "machine" khi người dùng đặt trên máy.
type AutoSync struct {
	Enabled bool   `json:"enabled"`
	Minutes int    `json:"minutes"`
	Source  string `json:"source"`
}

// Mirror ghi bản AGENTS.md mà gương Codex đã chép, để biết khi nào gương cũ.
type Mirror struct {
	Path string `json:"path"`
	Sha  string `json:"sha"`
}

// GeminiExtra ghi thay đổi ở .gemini/settings.json để tắt thì trả lại đúng như cũ. Before là nội dung trước khi app sửa
// (rỗng khi Created); WroteSha là băm bản app ghi: file còn đúng bản đó thì ghi lại Before nguyên byte.
type GeminiExtra struct {
	Settings     string  `json:"settings"`
	Added        string  `json:"added"`
	Created      bool    `json:"created"`
	Before       string  `json:"before,omitempty"`
	WroteSha     string  `json:"wroteSha,omitempty"`
	ExcludeAdded *string `json:"excludeAdded"`
}

// TargetState là một file đích trong state.json.
type TargetState struct {
	ID   TargetID `json:"id"`
	Path string   `json:"path"`
	// Created: app tạo file này, nên tắt thì cho vào thùng rác khi file chỉ còn khối.
	Created bool `json:"created"`
	// Lead là phần app chèn trước khối khi thêm vào cuối file có sẵn; tắt thì gỡ cùng khối.
	Lead         string       `json:"lead,omitempty"`
	ExcludeAdded *string      `json:"excludeAdded"`
	BlockSha     string       `json:"blockSha,omitempty"`
	MirrorOf     *Mirror      `json:"mirrorOf"`
	Extra        *GeminiExtra `json:"extra"`
	Status       string       `json:"status"`
	Reason       *string      `json:"reason"`
}

// State là context/<khoá>/state.json.
type State struct {
	Version   int           `json:"version"`
	Enabled   bool          `json:"enabled"`
	ProjectID string        `json:"projectId,omitempty"`
	Folder    string        `json:"folder"`
	AutoSync  AutoSync      `json:"autoSync"`
	Targets   []TargetState `json:"targets"`
}

func (st *State) target(id TargetID) *TargetState {
	for i := range st.Targets {
		if st.Targets[i].ID == id {
			return &st.Targets[i]
		}
	}
	st.Targets = append(st.Targets, TargetState{ID: id, Path: targetPath(id), Status: StatusStale})
	return &st.Targets[len(st.Targets)-1]
}

var keyRe = regexp.MustCompile(`^[pf]_[A-Za-z0-9-]{1,200}$`)

// ErrNotFound: dự án chưa bật ngữ cảnh dùng chung trên máy.
var ErrNotFound = errors.New("dự án chưa bật ngữ cảnh dùng chung")

func checkKey(key string) error {
	if !keyRe.MatchString(key) {
		return fmt.Errorf("khoá dự án không hợp lệ: %q", key)
	}
	return nil
}

func (m Manager) dir(key string) string { return filepath.Join(m.Root, key) }

func (m Manager) loadState(key string) (State, error) {
	if err := checkKey(key); err != nil {
		return State{}, err
	}
	raw, err := os.ReadFile(filepath.Join(m.dir(key), "state.json"))
	if os.IsNotExist(err) {
		return State{}, fmt.Errorf("%w: %s", ErrNotFound, key)
	}
	if err != nil {
		return State{}, err
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		return State{}, fmt.Errorf("state.json của %s hỏng: %w", key, err)
	}
	if st.Version != stateVersion {
		return State{}, fmt.Errorf("state.json của %s có phiên bản %d, app chỉ đọc được bản %d", key, st.Version, stateVersion)
	}
	return st, nil
}

func (m Manager) saveState(key string, st State) error {
	st.Version = stateVersion
	if st.Targets == nil {
		st.Targets = []TargetState{}
	}
	return writeJSON(filepath.Join(m.dir(key), "state.json"), st)
}

func writeJSON(path string, v any) error {
	raw, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return writeFile(path, append(raw, '\n'), 0o600)
}

func strPtr(s string) *string { return &s }

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
