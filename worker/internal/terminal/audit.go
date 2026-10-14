package terminal

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Audit ghi remote-audit.log tại máy (specs/010 T020, mối đe doạ T14): mỗi dòng một JSON. Sổ này độc lập với audit của
// hub, nên hub bị chiếm hay sửa DB vẫn không xoá được dấu vết bật, ghép, gỡ thiết bị trên máy. Không ghi khoá, mã hay
// đường dẫn ngoài thư mục chủ máy tự thêm.
type Audit struct {
	Path string
	// MaxBytes, Keep: xoay khi file quá MaxBytes, giữ Keep bản cũ (.1 mới nhất).
	MaxBytes int64
	Keep     int
	Now      func() time.Time

	mu sync.Mutex
}

const (
	defaultAuditBytes = 10 << 20
	defaultAuditKeep  = 5
)

// AuditEntry: By là "machine" (người ở máy, qua socket nội bộ) hoặc "hub:<userId>" (gói từ hub).
type AuditEntry struct {
	At     time.Time      `json:"at"`
	Action string         `json:"action"`
	By     string         `json:"by"`
	Data   map[string]any `json:"data,omitempty"`
}

const byMachine = "machine"

func byHub(userID string) string {
	if userID == "" {
		return "hub"
	}
	return "hub:" + clip(userID, 64)
}

// Write trả lỗi để người gọi ghi log; không ghi được sổ thì việc đã được phép vẫn làm (tắt, gỡ thiết bị không được
// hỏng vì đĩa đầy).
func (a *Audit) Write(action, by string, data map[string]any) error {
	if a == nil || a.Path == "" {
		return nil
	}
	now := time.Now
	if a.Now != nil {
		now = a.Now
	}
	line, err := json.Marshal(AuditEntry{At: now().UTC(), Action: action, By: by, Data: data})
	if err != nil {
		return err
	}
	line = append(line, '\n')
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(a.Path), 0o700); err != nil {
		return err
	}
	if st, err := os.Stat(a.Path); err == nil && st.Size()+int64(len(line)) > a.maxBytes() {
		a.rotate()
	}
	f, err := os.OpenFile(a.Path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = f.Write(line)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func (a *Audit) maxBytes() int64 {
	if a.MaxBytes > 0 {
		return a.MaxBytes
	}
	return defaultAuditBytes
}

func (a *Audit) rotate() {
	keep := a.Keep
	if keep <= 0 {
		keep = defaultAuditKeep
	}
	_ = os.Remove(fmt.Sprintf("%s.%d", a.Path, keep))
	for i := keep - 1; i >= 1; i-- {
		_ = os.Rename(fmt.Sprintf("%s.%d", a.Path, i), fmt.Sprintf("%s.%d", a.Path, i+1))
	}
	_ = os.Rename(a.Path, a.Path+".1")
}
