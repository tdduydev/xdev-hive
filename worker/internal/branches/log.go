package branches

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// Hành động trong nhật ký (hợp đồng mục 6). Lệnh đọc không ghi.
const (
	ActionClean    = "clean"
	ActionMerge    = "merge"
	ActionRebase   = "rebase"
	ActionContinue = "continue"
	ActionAbort    = "abort"
	ActionSwitch   = "switch"
	ActionCreate   = "create"
	ActionPull     = "pull"
)

// logKeep là số dòng nhật ký giữ lại (FR-032).
const logKeep = 1000

// LogEntry là một dòng của branches-log.jsonl. Chỉ có tên, mã và đường dẫn: không token, không nội dung file (FR-032).
type LogEntry struct {
	Time       string `json:"time"`
	Action     string `json:"action"`
	Folder     string `json:"folder"`
	Branch     string `json:"branch,omitempty"`
	Tip        string `json:"tip,omitempty"`
	Worktree   string `json:"worktree,omitempty"`
	HeadBefore string `json:"headBefore,omitempty"`
	Onto       string `json:"onto,omitempty"`
	OntoTip    string `json:"ontoTip,omitempty"`
	Result     string `json:"result"`
	Code       string `json:"code,omitempty"`
	Evidence   string `json:"evidence,omitempty"`
	// Restore là lệnh khôi phục nhánh đã xoá, để người dùng mở file nhật ký vẫn chép được khi app không chạy.
	Restore string `json:"restore,omitempty"`
}

// LogPath là branches-log.jsonl cạnh worker.json.
func LogPath(configDir string) string { return filepath.Join(configDir, "branches-log.jsonl") }

// logMu: clean ghi nhật ký từ hai repo song song trong cùng tiến trình.
var logMu sync.Mutex

// AppendLog thêm các dòng vào nhật ký rồi cắt còn logKeep dòng cuối. Ghi nối bằng O_APPEND để hai tiến trình (clean và
// merge chạy cùng lúc) không đè dòng của nhau; chỉ lúc cắt mới viết lại cả file.
func AppendLog(configDir string, entries ...LogEntry) error {
	if configDir == "" || len(entries) == 0 {
		return nil
	}
	var body []byte
	for _, e := range entries {
		b, err := json.Marshal(e)
		if err != nil {
			return err
		}
		body = append(append(body, b...), '\n')
	}
	logMu.Lock()
	defer logMu.Unlock()
	path := LogPath(configDir)
	if err := os.MkdirAll(configDir, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	all, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := bytes.SplitAfter(all, []byte("\n"))
	if n := len(lines); n > 0 && len(lines[n-1]) == 0 {
		lines = lines[:n-1]
	}
	if len(lines) <= logKeep {
		return nil
	}
	return writeAtomic(path, bytes.Join(lines[len(lines)-logKeep:], nil))
}
